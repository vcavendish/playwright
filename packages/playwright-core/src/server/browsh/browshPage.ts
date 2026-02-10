/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Page } from '../page';
import { FrameExecutionContext } from '../dom';
import { BrowshExecutionContext } from './browshExecutionContext';
import { createGuid } from '../utils/crypto';

import type { BrowshConnection } from './browshConnection';
import type { BrowshBrowserContext } from './browshBrowserContext';
import type * as dom from '../dom';
import type * as frames from '../frames';
import type * as input from '../input';
import type { InitScript, PageDelegate } from '../page';
import type { Progress } from '../progress';
import type * as types from '../types';
import type * as channels from '@protocol/channels';

const kBrowshMainFrameId = 'browsh-main-frame';

/**
 * BrowshPage — PageDelegate implementation for Browsh.
 *
 * Delegates navigation, input, screenshots, and evaluation to BrowshConnection.
 * The Page class handles all Playwright API surface; this delegate handles
 * the browser-specific I/O, same as CRPage does for Chrome.
 *
 * Iframe support: Browsh's remote control API currently executes scripts
 * via Marionette's WebDriver:ExecuteScript in the top-level document context.
 * It cannot cross into child frames. To support iframes, browsh would need
 * to use Marionette's WebDriver:SwitchToFrame and report child frames via
 * frameAttached events so Playwright can manage execution contexts per frame.
 */
export class BrowshPage implements PageDelegate {
  readonly rawKeyboard: RawKeyboardImpl;
  readonly rawMouse: RawMouseImpl;
  readonly rawTouchscreen: RawTouchscreenImpl;
  readonly _page: Page;
  readonly _connection: BrowshConnection;
  readonly _browserContext: BrowshBrowserContext;
  private readonly _mainFrameId = kBrowshMainFrameId;

  constructor(connection: BrowshConnection, browserContext: BrowshBrowserContext) {
    this._connection = connection;
    this._browserContext = browserContext;
    this.rawKeyboard = new RawKeyboardImpl(connection);
    this.rawMouse = new RawMouseImpl(connection);
    this.rawTouchscreen = new RawTouchscreenImpl(connection);
    this._page = new Page(this, browserContext);

    // Attach main frame. Uses frameAttached like Chrome/Firefox do when
    // they receive a frame event from the browser protocol.
    // Child frames (iframes) are not yet supported — browsh's remote control
    // API would need WebDriver:SwitchToFrame to enter child frame contexts
    // and report them here via additional frameAttached calls.
    this._page.frameManager.frameAttached(this._mainFrameId, null);
  }

  async initialize() {
    // Create execution contexts for the main frame so evaluate/title/etc work.
    // Browsh delegates JS evaluation to Marionette via its remote control API.
    // InjectedScript and UtilityScript are injected into the page via window
    // properties (see BrowshExecutionContext.rawEvaluateHandle).
    const mainFrame = this._page.mainFrame();
    const delegate = new BrowshExecutionContext(this._connection);
    const mainContext = new FrameExecutionContext(delegate, mainFrame, 'main');
    const utilityContext = new FrameExecutionContext(delegate, mainFrame, 'utility');
    mainFrame._contextCreated('main', mainContext);
    mainFrame._contextCreated('utility', utilityContext);

    // Override Frame methods that go through ElementHandle (which requires
    // persistent object references that Marionette can't provide).
    //
    // Upstream Playwright: querySelector → ElementHandle → action(coordinates)
    // Browsh: querySelector + action in ONE evaluate call via Marionette.
    //
    // The InjectedScript is already injected into the page (on window.__pw_handle_N).
    // We use it to resolve selectors, then act on the DOM element directly.
    // This is browsh brokering the interaction — Playwright never touches
    // browsh's Firefox directly.
    this._installFrameOverrides(mainFrame);

    // Fire initial lifecycle events so _loadDefaultContext can resolve.
    // Browsh's tab is already loaded when we connect (it opens brow.sh by default).
    this._page.frameManager.frameLifecycleEvent(this._mainFrameId, 'load');
    this._page.frameManager.frameLifecycleEvent(this._mainFrameId, 'domcontentloaded');
    // Signal that the page is ready for use.
    this._page.reportAsNew(undefined);
  }

  /**
   * Install Frame method overrides that resolve selectors and perform actions
   * in a single Marionette evaluate call. This avoids the ElementHandle pipeline
   * which requires persistent object references (objectId) that Marionette can't provide.
   */
  private _installFrameOverrides(frame: frames.Frame) {
    const browshPage = this;

    // Helper: resolve selector and run action JS on the element, all in one evaluate.
    // actionJs receives `el` (the DOM element) and `injected` (InjectedScript) and
    // should return a serializable value.
    const selectorAction = async (selector: string, actionJs: string, progress?: any): Promise<any> => {
      // Ensure InjectedScript is injected on the current page.
      // After navigation, the old window properties are gone and the new context
      // lazily re-injects when injectedScript() is called.
      const context = await frame._context('utility');
      await (context as any).injectedScript();

      const script = `(() => {
        const injKey = Object.keys(window).find(k => k.startsWith('__pw_handle_') && window[k]?.querySelectorAll);
        if (!injKey) throw new Error('InjectedScript not found');
        const injected = window[injKey];
        const parsed = injected.parseSelector(${JSON.stringify(selector)});
        const elements = injected.querySelectorAll(parsed, document);
        if (!elements.length) throw new Error('Element not found: ${selector.replace(/'/g, "\\'")}');
        const el = elements[0];
        ${actionJs}
      })()`;
      return await frame.evaluateExpression(script, { isFunction: false, returnByValue: true });
    };

    const originalClick = frame.click.bind(frame);
    frame.click = async function(progress, selector, options) {
      if (browshPage._isBrowshSelector(selector)) {
        progress.log(`browsh: click ${selector}`);
        await selectorAction(selector, 'el.click(); return true;', progress);
        return;
      }
      return originalClick(progress, selector, options);
    };

    const originalFill = frame.fill.bind(frame);
    frame.fill = async function(progress, selector, value, options) {
      if (browshPage._isBrowshSelector(selector)) {
        progress.log(`browsh: fill ${selector}`);
        const escaped = JSON.stringify(value);
        await selectorAction(selector, `
          el.focus();
          el.value = ${escaped};
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        `, progress);
        return;
      }
      return originalFill(progress, selector, value, options);
    };

    const originalHover = frame.hover.bind(frame);
    frame.hover = async function(progress, selector, options) {
      if (browshPage._isBrowshSelector(selector)) {
        progress.log(`browsh: hover ${selector}`);
        await selectorAction(selector, `
          el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
          el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
          return true;
        `, progress);
        return;
      }
      return originalHover(progress, selector, options);
    };

    const originalFocus = frame.focus.bind(frame);
    frame.focus = async function(progress, selector, options) {
      if (browshPage._isBrowshSelector(selector)) {
        progress.log(`browsh: focus ${selector}`);
        await selectorAction(selector, 'el.focus(); return true;', progress);
        return;
      }
      return originalFocus(progress, selector, options);
    };

    const originalType = frame.type.bind(frame);
    frame.type = async function(progress, selector, text, options) {
      if (browshPage._isBrowshSelector(selector)) {
        progress.log(`browsh: type into ${selector}`);
        const escaped = JSON.stringify(text);
        await selectorAction(selector, `
          el.focus();
          for (const ch of ${escaped}) {
            el.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
            el.dispatchEvent(new KeyboardEvent('keypress', { key: ch, bubbles: true }));
            if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') el.value += ch;
            el.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
          }
          el.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        `, progress);
        return;
      }
      return originalType(progress, selector, text, options);
    };

    const originalCheck = frame.check.bind(frame);
    frame.check = async function(progress, selector, options) {
      if (browshPage._isBrowshSelector(selector)) {
        progress.log(`browsh: check ${selector}`);
        await selectorAction(selector, `
          if (!el.checked) el.click();
          return true;
        `, progress);
        return;
      }
      return originalCheck(progress, selector, options);
    };

    const originalUncheck = frame.uncheck.bind(frame);
    frame.uncheck = async function(progress, selector, options) {
      if (browshPage._isBrowshSelector(selector)) {
        progress.log(`browsh: uncheck ${selector}`);
        await selectorAction(selector, `
          if (el.checked) el.click();
          return true;
        `, progress);
        return;
      }
      return originalUncheck(progress, selector, options);
    };

    const originalSelectOption = frame.selectOption.bind(frame);
    frame.selectOption = async function(progress, selector, elements, values, options) {
      if (browshPage._isBrowshSelector(selector)) {
        progress.log(`browsh: selectOption ${selector}`);
        const valuesJson = JSON.stringify(values);
        await selectorAction(selector, `
          const vals = ${valuesJson};
          for (const opt of el.options) {
            opt.selected = vals.some(v => v.value === opt.value || v.label === opt.text);
          }
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return Array.from(el.selectedOptions).map(o => o.value);
        `, progress);
        return [];
      }
      return originalSelectOption(progress, selector, elements, values, options);
    };

    const originalAriaSnapshot = frame.ariaSnapshot.bind(frame);
    frame.ariaSnapshot = async function(progress, selector) {
      if (browshPage._isBrowshSelector(selector)) {
        progress.log(`browsh: ariaSnapshot ${selector}`);
        return await selectorAction(selector, `
          return injected.ariaSnapshot(el, { mode: 'expect' });
        `, progress) as string;
      }
      return originalAriaSnapshot(progress, selector);
    };
  }

  /**
   * Check if a selector should use browsh's single-evaluate path.
   * All selectors go through browsh since ElementHandle doesn't work with Marionette.
   */
  private _isBrowshSelector(_selector: string): boolean {
    return true;
  }

  async navigateFrame(frame: frames.Frame, url: string, _referrer: string | undefined): Promise<frames.GotoResult> {
    const previousUrl = this._page.mainFrame().url();
    await this._connection.send('navigate', { url });

    // Wait for the page to actually load. Browsh's navigate is fire-and-forget
    // (sends to webextension, returns immediately). We poll get_state until
    // the URL changes to the target, then poll evaluate until MarionetteCommands
    // actor is ready for the new document.
    const targetOrigin = new URL(url).origin;
    const sameOrigin = previousUrl.startsWith(targetOrigin);
    const startTime = Date.now();
    const timeout = 30000;

    if (sameOrigin) {
      // Same-origin navigation: the URL may not change (e.g., navigating
      // from example.com to example.com). Wait a moment for the navigation
      // to start, then wait for evaluate to succeed on the new document.
      await new Promise(r => setTimeout(r, 1000));
      await this._waitForNavigationReady();
    } else {
      // Cross-origin: wait for URL to change to target origin.
      while (Date.now() - startTime < timeout) {
        try {
          const state = await this._connection.send('get_state');
          if (state?.url && state.url.startsWith(targetOrigin)) {
            // URL changed — now verify evaluate works (MarionetteCommands actor ready)
            try {
              await this._connection.send('evaluate', { expression: '1' });
              break;
            } catch {
              // Actor not ready yet
            }
          }
        } catch {
          // Still loading
        }
        await new Promise(r => setTimeout(r, 500));
      }
    }

    // Signal the frame that a new document navigation occurred.
    const documentId = createGuid();
    this._page.frameManager.frameCommittedNewDocumentNavigation(this._mainFrameId, url, '', documentId, false);
    this._recreateExecutionContexts();
    this._page.frameManager.frameLifecycleEvent(this._mainFrameId, 'load');
    this._page.frameManager.frameLifecycleEvent(this._mainFrameId, 'domcontentloaded');
    return { newDocumentId: documentId };
  }

  async reload(): Promise<void> {
    await this._connection.send('reload');
    await this._waitForNavigationReady();
    const url = this._page.mainFrame().url();
    const documentId = createGuid();
    this._page.frameManager.frameCommittedNewDocumentNavigation(this._mainFrameId, url, '', documentId, false);
    this._recreateExecutionContexts();
    this._page.frameManager.frameLifecycleEvent(this._mainFrameId, 'load');
    this._page.frameManager.frameLifecycleEvent(this._mainFrameId, 'domcontentloaded');
  }

  async goBack(): Promise<boolean> {
    try {
      const urlBefore = this._page.mainFrame().url();
      await this._connection.send('back');
      await this._waitForUrlChange(urlBefore);
      await this._waitForNavigationReady();
      const state = await this._connection.send('get_state');
      const url = state?.url || this._page.mainFrame().url();
      const documentId = createGuid();
      this._page.frameManager.frameCommittedNewDocumentNavigation(this._mainFrameId, url, '', documentId, false);
      this._recreateExecutionContexts();
      this._page.frameManager.frameLifecycleEvent(this._mainFrameId, 'load');
      this._page.frameManager.frameLifecycleEvent(this._mainFrameId, 'domcontentloaded');
      return true;
    } catch {
      return false;
    }
  }

  async goForward(): Promise<boolean> {
    try {
      const urlBefore = this._page.mainFrame().url();
      await this._connection.send('forward');
      await this._waitForUrlChange(urlBefore);
      await this._waitForNavigationReady();
      const state = await this._connection.send('get_state');
      const url = state?.url || this._page.mainFrame().url();
      const documentId = createGuid();
      this._page.frameManager.frameCommittedNewDocumentNavigation(this._mainFrameId, url, '', documentId, false);
      this._recreateExecutionContexts();
      this._page.frameManager.frameLifecycleEvent(this._mainFrameId, 'load');
      this._page.frameManager.frameLifecycleEvent(this._mainFrameId, 'domcontentloaded');
      return true;
    } catch {
      return false;
    }
  }

  /** Wait for the URL to change from the given value (browsh commands are fire-and-forget). */
  private async _waitForUrlChange(previousUrl: string) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      try {
        const state = await this._connection.send('get_state');
        if (state?.url && state.url !== previousUrl)
          return;
      } catch {
        // Still loading
      }
      await new Promise(r => setTimeout(r, 300));
    }
  }

  /** Wait for evaluate to succeed after navigation (MarionetteCommands actor ready). */
  private async _waitForNavigationReady() {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      try {
        await this._connection.send('evaluate', { expression: '1' });
        return;
      } catch {
        await new Promise(r => setTimeout(r, 500));
      }
    }
  }

  /** Recreate execution contexts after navigation invalidates the old document. */
  private _recreateExecutionContexts() {
    const frame = this._page.mainFrame();
    const delegate = new BrowshExecutionContext(this._connection);
    const mainContext = new FrameExecutionContext(delegate, frame, 'main');
    const utilityContext = new FrameExecutionContext(delegate, frame, 'utility');
    frame._contextCreated('main', mainContext);
    frame._contextCreated('utility', utilityContext);
  }

  async addInitScript(_initScript: InitScript): Promise<void> {
    // Browsh does not support injecting scripts before page load.
  }

  async removeInitScripts(_initScripts: InitScript[]): Promise<void> {
  }

  async closePage(_runBeforeUnload: boolean): Promise<void> {
    await this._browserContext._closePage(this);
  }

  async updateExtraHTTPHeaders(): Promise<void> { }
  async updateEmulatedViewportSize(_preserveWindowBoundaries?: boolean): Promise<void> { }
  async updateEmulateMedia(): Promise<void> { }
  async updateRequestInterception(): Promise<void> { }
  async updateFileChooserInterception(): Promise<void> { }

  async bringToFront(): Promise<void> {
    // Single-tab — already in front.
  }

  async setBackgroundColor(_color?: { r: number; g: number; b: number; a: number }): Promise<void> { }

  async takeScreenshot(progress: Progress, format: string, documentRect: types.Rect | undefined, viewportRect: types.Rect | undefined, quality: number | undefined, _fitsViewport: boolean, _scale: 'css' | 'device'): Promise<Buffer> {
    const data = await this._connection.send('screenshot');
    if (typeof data === 'string' && data.length > 0)
      return Buffer.from(data, 'base64');
    return Buffer.alloc(0);
  }

  async requestGC(): Promise<void> { }

  // Element handle methods — browsh does not support fine-grained DOM handles.
  // These throw clear errors so callers know to use locator/evaluate instead.

  async adoptElementHandle<T extends Node>(_handle: dom.ElementHandle<T>, _to: dom.FrameExecutionContext): Promise<dom.ElementHandle<T>> {
    throw new Error('Browsh does not support element handle adoption across contexts');
  }

  async getContentFrame(_handle: dom.ElementHandle): Promise<frames.Frame | null> {
    return null;
  }

  async getOwnerFrame(_handle: dom.ElementHandle): Promise<string | null> {
    return null;
  }

  async getContentQuads(_handle: dom.ElementHandle): Promise<types.Quad[] | null> {
    return null;
  }

  async setInputFilePaths(_handle: dom.ElementHandle<HTMLInputElement>, _files: string[]): Promise<void> {
    throw new Error('Browsh does not support file uploads via element handles');
  }

  async getBoundingBox(_handle: dom.ElementHandle): Promise<types.Rect | null> {
    return null;
  }

  async getFrameElement(_frame: frames.Frame): Promise<dom.ElementHandle> {
    throw new Error('Browsh does not support frame elements');
  }

  async scrollRectIntoViewIfNeeded(_handle: dom.ElementHandle, _rect?: types.Rect): Promise<'error:notvisible' | 'error:notconnected' | 'done'> {
    return 'done';
  }

  async startScreencast(_options: { width: number; height: number; quality: number }): Promise<void> { }
  async stopScreencast(): Promise<void> { }

  pdf?: ((options: channels.PagePdfParams) => Promise<Buffer>) | undefined = undefined;
  coverage?: (() => any) | undefined = undefined;

  rafCountForStablePosition(): number {
    return 1;
  }

  async inputActionEpilogue(): Promise<void> { }

  readonly cspErrorsAsynchronousForInlineScripts = false;

  async resetForReuse(_progress: Progress): Promise<void> { }

  shouldToggleStyleSheetToSyncAnimations(): boolean {
    return false;
  }
}

/**
 * Raw keyboard implementation — sends key events to browsh.
 */
class RawKeyboardImpl implements input.RawKeyboard {
  private _connection: BrowshConnection;

  constructor(connection: BrowshConnection) {
    this._connection = connection;
  }

  async keydown(_progress: Progress, _modifiers: Set<types.KeyboardModifier>, keyName: string, _description: input.KeyDescription, _autoRepeat: boolean): Promise<void> {
    await this._connection.send('press', { key: keyName });
  }

  async keyup(_progress: Progress, _modifiers: Set<types.KeyboardModifier>, _keyName: string, _description: input.KeyDescription): Promise<void> {
    // Browsh handles key press as atomic up+down; no separate keyup needed.
  }

  async sendText(_progress: Progress, text: string): Promise<void> {
    await this._connection.send('type', { text });
  }
}

/**
 * Raw mouse implementation — sends mouse events to browsh.
 */
class RawMouseImpl implements input.RawMouse {
  private _connection: BrowshConnection;

  constructor(connection: BrowshConnection) {
    this._connection = connection;
  }

  async move(_progress: Progress, x: number, y: number, _button: types.MouseButton | 'none', _buttons: Set<types.MouseButton>, _modifiers: Set<types.KeyboardModifier>, _forClick: boolean): Promise<void> {
    await this._connection.send('scroll', { x: 0, y: 0, toX: x, toY: y });
  }

  async down(_progress: Progress, x: number, y: number, _button: types.MouseButton, _buttons: Set<types.MouseButton>, _modifiers: Set<types.KeyboardModifier>, _clickCount: number): Promise<void> {
    await this._connection.send('click', { x, y });
  }

  async up(_progress: Progress, _x: number, _y: number, _button: types.MouseButton, _buttons: Set<types.MouseButton>, _modifiers: Set<types.KeyboardModifier>, _clickCount: number): Promise<void> {
    // Browsh handles click as atomic down+up.
  }

  async wheel(_progress: Progress, _x: number, _y: number, _buttons: Set<types.MouseButton>, _modifiers: Set<types.KeyboardModifier>, deltaX: number, deltaY: number): Promise<void> {
    await this._connection.send('scroll', { x: deltaX, y: deltaY });
  }
}

/**
 * Raw touchscreen implementation — browsh has no touch support.
 */
class RawTouchscreenImpl implements input.RawTouchscreen {
  private _connection: BrowshConnection;

  constructor(connection: BrowshConnection) {
    this._connection = connection;
  }

  async tap(_progress: Progress, x: number, y: number, _modifiers: Set<types.KeyboardModifier>): Promise<void> {
    // Fall back to click for touch.
    await this._connection.send('click', { x, y });
  }
}
