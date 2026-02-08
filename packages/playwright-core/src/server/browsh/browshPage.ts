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

const kDummyFrameId = '__browsh_main_frame__';

/**
 * BrowshPage — PageDelegate implementation for Browsh.
 *
 * Delegates navigation, input, screenshots, and evaluation to BrowshConnection.
 * The Page class handles all Playwright API surface; this delegate handles
 * the browser-specific I/O, same as CRPage does for Chrome.
 *
 * Browsh is a single-tab, single-frame browser from Playwright's perspective.
 * No iframes, no workers, no service workers. Methods related to those concepts
 * are no-ops or return appropriate defaults.
 */
export class BrowshPage implements PageDelegate {
  readonly rawKeyboard: RawKeyboardImpl;
  readonly rawMouse: RawMouseImpl;
  readonly rawTouchscreen: RawTouchscreenImpl;
  readonly _page: Page;
  readonly _connection: BrowshConnection;
  readonly _browserContext: BrowshBrowserContext;

  constructor(connection: BrowshConnection, browserContext: BrowshBrowserContext) {
    this._connection = connection;
    this._browserContext = browserContext;
    this.rawKeyboard = new RawKeyboardImpl(connection);
    this.rawMouse = new RawMouseImpl(connection);
    this.rawTouchscreen = new RawTouchscreenImpl(connection);
    this._page = new Page(this, browserContext);

    // Create a main frame — browsh is always single-frame.
    this._page.frameManager.createDummyMainFrameIfNeeded();
  }

  async initialize() {
    // Signal that the page is ready for use.
    this._page.reportAsNew(undefined);
  }

  async navigateFrame(frame: frames.Frame, url: string, _referrer: string | undefined): Promise<frames.GotoResult> {
    await this._connection.send('navigate', { url });
    // Signal the frame that a new document navigation occurred.
    const documentId = createGuid();
    this._page.frameManager.frameCommittedNewDocumentNavigation(kDummyFrameId, url, '', documentId, false);
    this._page.frameManager.frameLifecycleEvent(kDummyFrameId, 'load');
    this._page.frameManager.frameLifecycleEvent(kDummyFrameId, 'domcontentloaded');
    return { newDocumentId: documentId };
  }

  async reload(): Promise<void> {
    await this._connection.send('reload');
    const url = this._page.mainFrame().url();
    const documentId = createGuid();
    this._page.frameManager.frameCommittedNewDocumentNavigation(kDummyFrameId, url, '', documentId, false);
    this._page.frameManager.frameLifecycleEvent(kDummyFrameId, 'load');
    this._page.frameManager.frameLifecycleEvent(kDummyFrameId, 'domcontentloaded');
  }

  async goBack(): Promise<boolean> {
    try {
      await this._connection.send('back');
      return true;
    } catch {
      return false;
    }
  }

  async goForward(): Promise<boolean> {
    try {
      await this._connection.send('forward');
      return true;
    } catch {
      return false;
    }
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
    const result = await this._connection.send('screenshot');
    if (result?.data) {
      // Browsh returns base64-encoded screenshot data.
      return Buffer.from(result.data, 'base64');
    }
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
