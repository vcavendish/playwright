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

import { EventEmitter } from 'events';
import net from 'net';
import fs from 'fs';
import path from 'path';
import WebSocket from 'ws';

import type { BrowserContextFactory, BrowserContextFactoryResult } from './browserContextFactory';
import type { FullConfig } from './config';
import type { ClientInfo } from '../sdk/server';

const DEFAULT_PORT = 3335;
const PORT_SCAN_RANGE: [number, number] = [3335, 3340];

/**
 * BrowshPage — Playwright Page interface over Browsh WebSocket Command API.
 *
 * Implements the Page API surface that the MCP Tab, Context, and tools require:
 * - Events: console, pageerror, request, response, requestfailed, close, filechooser, dialog, download
 * - Navigation: goto, waitForLoadState, goBack, goForward, reload
 * - Queries: url, title, evaluate, _snapshotForAI
 * - Locators: locator() → BrowshLocator with describe() and _resolveSelector()
 * - Internal: _wrapApiCall (for callOnPageNoTrace in tools/utils.ts)
 * - Input: keyboard, mouse (stubs — Browsh commands handle input directly)
 * - Media: screenshot, pdf, video (stubs)
 */
class BrowshPage extends EventEmitter {
  private _ws: WebSocket;
  private _currentUrl = 'about:blank';
  private _currentTitle = '';
  _refMap: Record<string, any> = {};
  private _navTimeout = 60000;
  private _actionTimeout = 5000;
  private _requestId = 0;
  private _pendingRequests = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private _closed = false;
  private _browserContext: BrowshBrowserContext | null = null;

  // Keyboard & mouse stubs (tools access page.keyboard.press, page.mouse.move, etc.)
  keyboard = {
    press: async (_key: string) => {},
    type: async (_text: string, _options?: any) => {},
    down: async (_key: string) => {},
    up: async (_key: string) => {},
  };
  mouse = {
    move: async (_x: number, _y: number) => {},
    down: async (_options?: any) => {},
    up: async (_options?: any) => {},
    click: async (_x: number, _y: number, _options?: any) => {},
    wheel: async (_deltaX: number, _deltaY: number) => {},
  };

  constructor(ws: WebSocket) {
    super();
    this._ws = ws;

    this._ws.on('message', (data: WebSocket.Data) => {
      const msg = JSON.parse(data.toString());
      const oldest = this._pendingRequests.entries().next().value;
      if (oldest) {
        const [id, { resolve, reject }] = oldest;
        this._pendingRequests.delete(id);
        if (msg.success) resolve(msg);
        else reject(new Error(msg.error || 'Command failed'));
      }
    });

    this._ws.on('close', () => {
      this._closed = true;
      this.emit('close');
    });
  }

  _setBrowserContext(ctx: BrowshBrowserContext) { this._browserContext = ctx; }

  private _send(command: string, args?: string): Promise<any> {
    return new Promise((resolve, reject) => {
      if (this._closed) return reject(new Error('Page is closed'));
      const id = ++this._requestId;
      this._pendingRequests.set(id, { resolve, reject });
      const msg: any = { command };
      if (args !== undefined) msg.args = args;
      this._ws.send(JSON.stringify(msg));
    });
  }

  // --- Internal API required by callOnPageNoTrace (tools/utils.ts) ---
  async _wrapApiCall<R>(func: () => Promise<R>, _options?: { internal?: boolean }): Promise<R> {
    return await func();
  }

  // --- Navigation ---
  url(): string { return this._currentUrl; }

  async title(): Promise<string> {
    const result = await this._send('get_state');
    this._currentTitle = result.data.title || '';
    this._currentUrl = result.data.url || this._currentUrl;
    return this._currentTitle;
  }

  async goto(url: string, _options?: any): Promise<null> {
    await this._send('navigate', url);
    await new Promise(r => setTimeout(r, 1000));
    const state = await this._send('get_state');
    this._currentUrl = state.data.url || url;
    this._currentTitle = state.data.title || '';
    return null;
  }

  async goBack(_options?: any): Promise<null> {
    await this._send('back');
    await new Promise(r => setTimeout(r, 500));
    const state = await this._send('get_state');
    this._currentUrl = state.data.url || this._currentUrl;
    return null;
  }

  async goForward(_options?: any): Promise<null> {
    await this._send('forward');
    await new Promise(r => setTimeout(r, 500));
    const state = await this._send('get_state');
    this._currentUrl = state.data.url || this._currentUrl;
    return null;
  }

  async reload(_options?: any): Promise<null> {
    await this._send('reload');
    await new Promise(r => setTimeout(r, 1000));
    const state = await this._send('get_state');
    this._currentUrl = state.data.url || this._currentUrl;
    return null;
  }

  async waitForLoadState(_state?: string, _options?: any): Promise<void> {
    await new Promise(r => setTimeout(r, 500));
  }

  // --- Evaluation ---
  async evaluate(pageFunction: string | Function, arg?: any): Promise<any> {
    let script: string;
    if (typeof pageFunction === 'function') {
      script = arg !== undefined
        ? `(${pageFunction.toString()})(${JSON.stringify(arg)})`
        : `(${pageFunction.toString()})()`;
    } else {
      script = String(pageFunction);
    }
    const result = await this._send('evaluate', script);
    return result.data;
  }

  // --- Snapshots & Locators ---
  async _snapshotForAI(_options?: any): Promise<{ full: string; incremental?: string }> {
    const result = await this._send('get_aria_snapshot');
    this._refMap = result.data.refMap || {};
    return { full: result.data.full };
  }

  locator(selector: string): BrowshLocator {
    return new BrowshLocator(this, selector);
  }

  // Additional query methods some tools use
  getByRole(role: string, options?: any): BrowshLocator {
    const name = options?.name ? `[name="${options.name}"]` : '';
    return new BrowshLocator(this, `role=${role}${name}`);
  }

  getByText(text: string, _options?: any): BrowshLocator {
    return new BrowshLocator(this, `text=${text}`);
  }

  // --- Timeouts ---
  setDefaultNavigationTimeout(ms: number): void { this._navTimeout = ms; }
  setDefaultTimeout(ms: number): void { this._actionTimeout = ms; }

  // --- Page lifecycle ---
  async bringToFront(): Promise<void> {}
  async close(): Promise<void> {
    this._closed = true;
    this.emit('close');
  }

  async setViewportSize(_size: { width: number; height: number }): Promise<void> {}

  // --- Context access (tools like cookies.ts call page.context()) ---
  context(): BrowshBrowserContext { return this._browserContext!; }

  // --- Console/Network/Errors (Tab._initialize reads these) ---
  async consoleMessages(): Promise<any[]> { return []; }
  async pageErrors(): Promise<any[]> { return []; }
  async requests(): Promise<any[]> { return []; }

  // --- Media (context.ts calls page.video()) ---
  video() {
    return {
      start: async (_params?: any) => {},
      stop: async () => {},
      allVideos: [],
    };
  }

  // --- Screenshot/PDF stubs ---
  async screenshot(_options?: any): Promise<Buffer> {
    // Browsh renders text, not pixels — return a 1x1 transparent PNG
    return Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  }

  async pdf(_options?: any): Promise<Buffer> { return Buffer.alloc(0); }

  // --- Frame access (some tools call page.mainFrame()) ---
  mainFrame() {
    const self = this;
    return {
      async waitForLoadState(state?: string, options?: any) { await self.waitForLoadState(state, options); },
      url() { return self._currentUrl; },
    };
  }
}

/**
 * BrowshLocator — Element resolution via ARIA snapshot refs.
 *
 * Implements the Locator methods that MCP tools invoke:
 * - click, dblclick, fill, type (pressSequentially), hover, dragTo
 * - check, uncheck, setChecked, selectOption
 * - describe, _resolveSelector
 * - count, waitFor, isChecked, inputValue, screenshot
 * - filter, getByText
 */
class BrowshLocator {
  private _page: BrowshPage;
  private _selector: string;
  private _ref: string | null;
  private _description = '';

  constructor(page: BrowshPage, selector: string) {
    this._page = page;
    this._selector = selector;
    const refMatch = selector.match(/aria-ref=(\w+)/);
    this._ref = refMatch ? refMatch[1] : null;
  }

  describe(element: string): this {
    this._description = element;
    return this;
  }

  async _resolveSelector(): Promise<{ resolvedSelector: string }> {
    if (!this._ref) throw new Error('No ref in selector: ' + this._selector);
    const refInfo = this._page._refMap[this._ref];
    if (!refInfo) throw new Error(`Ref ${this._ref} not found in snapshot`);
    const name = refInfo.name ? `, { name: '${refInfo.name.replace(/'/g, "\\'")}' }` : '';
    return { resolvedSelector: `getByRole('${refInfo.role}'${name})` };
  }

  async click(_options?: any): Promise<void> {
    if (!this._ref) throw new Error('Cannot click without ref');
    await (this._page as any)._send('click_ref', this._ref);
  }

  async dblclick(_options?: any): Promise<void> {
    if (!this._ref) throw new Error('Cannot dblclick without ref');
    await (this._page as any)._send('click_ref', this._ref);
    await (this._page as any)._send('click_ref', this._ref);
  }

  async fill(value: string, _options?: any): Promise<void> {
    if (!this._ref) throw new Error('Cannot fill without ref');
    await (this._page as any)._send('click_ref', this._ref);
    await new Promise(r => setTimeout(r, 100));
    await this._page.evaluate(`(() => {
      const el = document.activeElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
        (el as HTMLInputElement).value = '';
        el.dispatchEvent(new Event('input', {bubbles: true}));
      }
    })()`);
    await (this._page as any)._send('type', value);
  }

  async type(text: string, _options?: any): Promise<void> {
    if (!this._ref) throw new Error('Cannot type without ref');
    await (this._page as any)._send('click_ref', this._ref);
    await new Promise(r => setTimeout(r, 100));
    await (this._page as any)._send('type', text);
  }

  async pressSequentially(text: string, _options?: any): Promise<void> {
    return this.type(text, _options);
  }

  async hover(_options?: any): Promise<void> {
    if (!this._ref) throw new Error('Cannot hover without ref');
    // Move to element — Browsh doesn't support hover natively, click focuses it
    await (this._page as any)._send('click_ref', this._ref);
  }

  async dragTo(_target: BrowshLocator, _options?: any): Promise<void> {
    throw new Error('Drag and drop not supported in Browsh terminal mode');
  }

  async check(_options?: any): Promise<void> { await this.click(_options); }
  async uncheck(_options?: any): Promise<void> { await this.click(_options); }
  async setChecked(checked: boolean, _options?: any): Promise<void> { await this.click(_options); }

  async selectOption(values: string | string[], _options?: any): Promise<string[]> {
    if (!this._ref) throw new Error('Cannot selectOption without ref');
    const vals = Array.isArray(values) ? values : [values];
    await (this._page as any)._send('click_ref', this._ref);
    // Use evaluate to set select value
    await this._page.evaluate(`(() => {
      const el = document.activeElement;
      if (el && el.tagName === 'SELECT') {
        el.value = ${JSON.stringify(vals[0])};
        el.dispatchEvent(new Event('change', {bubbles: true}));
      }
    })()`);
    return vals;
  }

  async count(): Promise<number> { return this._ref ? 1 : 0; }
  async waitFor(_options?: any): Promise<void> {}
  async isChecked(): Promise<boolean> { return false; }
  async inputValue(): Promise<string> { return ''; }

  async screenshot(_options?: any): Promise<Buffer> {
    return this._page.screenshot(_options);
  }

  filter(_options: any): BrowshLocator { return this; }
  getByText(text: string, _options?: any): BrowshLocator {
    return new BrowshLocator(this._page, `text=${text}`);
  }
}

/**
 * BrowshBrowserContext — Wraps BrowshPage to match Playwright's BrowserContext API.
 *
 * Implements what context.ts needs:
 * - pages(), newPage(), close()
 * - on/off('page'), on('close')
 * - route(), unroute()
 * - addInitScript()
 * - tracing (stub)
 * - _setAllowedProtocols(), _setAllowedDirectories()
 */
class BrowshBrowserContext extends EventEmitter {
  private _pages: BrowshPage[];
  private _closed = false;

  // Tracing stub (context.ts accesses browserContext.tracing)
  tracing = {
    start: async (_options?: any) => {},
    stop: async (_options?: any) => {},
  };

  constructor(page: BrowshPage) {
    super();
    this._pages = [page];
    page._setBrowserContext(this);
  }

  pages() { return [...this._pages]; }
  async newPage() {
    const page = this._pages[0];
    this.emit('page', page);
    return page;
  }
  async close() {
    this._closed = true;
    for (const page of this._pages) await page.close().catch(() => {});
    this._pages = [];
    this.emit('close');
  }
  async addInitScript(_script: any) {}
  async route(_pattern: any, _handler: any) {}
  async unroute(_pattern: any, _handler?: any) {}
  _setAllowedProtocols(_protocols: string[]) {}
  _setAllowedDirectories(_dirs: string[]) {}

  // Storage stubs (cookies.ts, storage.ts access context)
  async cookies(_urls?: string[]) { return []; }
  async addCookies(_cookies: any[]) {}
  async clearCookies() {}
  async storageState(_options?: any) { return { cookies: [], origins: [] }; }

  // Permissions
  async grantPermissions(_permissions: string[], _options?: any) {}
  async clearPermissions() {}
}

/**
 * BrowshContextFactory — Creates BrowshBrowserContext connected to a running Browsh instance.
 *
 * Port resolution order:
 * 1. Explicit: config.browser.browshUrl or BROWSH_URL env var
 * 2. Port file: .browsh.port (written by start-browsh.ps1)
 * 3. Port scan: tries 3335-3340 for a running instance
 * 4. Default: ws://localhost:3335
 */
export class BrowshContextFactory implements BrowserContextFactory {
  private _explicitUrl?: string;

  constructor(private config: FullConfig) {
    this._explicitUrl = (config.browser as any)?.browshUrl || process.env.BROWSH_URL;
  }

  async createContext(_clientInfo: ClientInfo, _abortSignal: AbortSignal, _options: any): Promise<BrowserContextFactoryResult> {
    const wsUrl = await this._resolveUrl();
    const ws = await this._connect(wsUrl);
    const page = new BrowshPage(ws);
    const browserContext = new BrowshBrowserContext(page) as any;

    return {
      browserContext,
      close: async () => {
        ws.close();
        await browserContext.close();
      }
    };
  }

  private async _resolveUrl(): Promise<string> {
    if (this._explicitUrl) return this._explicitUrl;

    const portFromFile = this._readPortFile();
    if (portFromFile && await this._isPortOpen(portFromFile))
      return `ws://localhost:${portFromFile}`;

    for (let port = PORT_SCAN_RANGE[0]; port <= PORT_SCAN_RANGE[1]; port++) {
      if (await this._isPortOpen(port))
        return `ws://localhost:${port}`;
    }

    return `ws://localhost:${DEFAULT_PORT}`;
  }

  private _readPortFile(): number | null {
    const candidates = [
      path.resolve(process.cwd(), '.browsh.port'),
    ];
    for (const candidate of candidates) {
      try {
        const content = fs.readFileSync(candidate, 'utf8').trim();
        const port = parseInt(content, 10);
        if (port > 0 && port < 65536) return port;
      } catch {}
    }
    return null;
  }

  private _isPortOpen(port: number): Promise<boolean> {
    return new Promise(resolve => {
      const socket = new net.Socket();
      socket.setTimeout(500);
      socket.on('connect', () => { socket.destroy(); resolve(true); });
      socket.on('timeout', () => { socket.destroy(); resolve(false); });
      socket.on('error', () => { socket.destroy(); resolve(false); });
      socket.connect(port, 'localhost');
    });
  }

  private _connect(wsUrl: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error(
          `Could not connect to Browsh at ${wsUrl}. ` +
          `Make sure Browsh is running with --remote-control flag.`
        ));
      }, 5000);

      ws.on('open', () => { clearTimeout(timeout); resolve(ws); });
      ws.on('error', (err: Error) => {
        clearTimeout(timeout);
        reject(new Error(`Failed to connect to Browsh at ${wsUrl}: ${err.message}`));
      });
    });
  }
}
