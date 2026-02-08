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

import { Browser } from '../browser';
import { BrowserContext } from '../browserContext';

import type { BrowserOptions } from '../browser';
import type * as types from '../types';
import type { SdkObject } from '../instrumentation';
import type { ConnectionTransport } from '../transport';

/**
 * BrowshBrowser represents a running Browsh instance. Each launch() or
 * newContext() spawns a separate Browsh+Firefox process on its own port,
 * providing full isolation.
 *
 * Unlike Chrome/Firefox which support multiple BrowserContexts within one
 * process (isolated profiles), Browsh has no internal concept of isolated
 * profiles. browser.newContext() triggers the MCP layer to spawn a new
 * Browsh process — heavier but semantically correct isolation.
 *
 * The transport here is the WebSocket connection to browsh's remote control
 * API. It is used for lifecycle management (close/disconnect detection)
 * and for sending protocol-translated commands.
 */
export class BrowshBrowser extends Browser {
  private _contexts: BrowserContext[] = [];
  private _version: string = 'browsh-1.0';
  private _connected: boolean = true;
  private _transport: ConnectionTransport;

  constructor(parent: SdkObject, transport: ConnectionTransport, options: BrowserOptions) {
    super(parent, options);
    this._transport = transport;

    // Monitor transport lifecycle
    const onClose = () => {
      this._connected = false;
      this.emit(Browser.Events.Disconnected);
    };
    this._transport.onclose = onClose;
  }

  static async connect(parent: SdkObject, transport: ConnectionTransport, options: BrowserOptions): Promise<BrowshBrowser> {
    return new BrowshBrowser(parent, transport, options);
  }

  override async doCreateNewContext(options: types.BrowserContextOptions): Promise<BrowserContext> {
    // Browsh doesn't support multiple isolated contexts within one process.
    // The MCP layer handles newContext() by spawning a separate Browsh instance.
    throw new Error('Browsh does not support multiple contexts in a single browser instance. Use playwright.browsh.launch() for each isolated context.');
  }

  override contexts(): BrowserContext[] {
    return this._contexts;
  }

  override isConnected(): boolean {
    return this._connected;
  }

  override version(): string {
    return this._version;
  }

  override userAgent(): string {
    return 'Browsh';
  }

  wsEndpoint(): string {
    return this.options.wsEndpoint || '';
  }

  _setVersion(version: string): void {
    this._version = version;
  }
}
