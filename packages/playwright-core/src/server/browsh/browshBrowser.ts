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
import { BrowshBrowserContext } from './browshBrowserContext';

import type { BrowshConnection } from './browshConnection';
import type { BrowserOptions } from '../browser';
import type * as types from '../types';
import type { SdkObject } from '../instrumentation';

/**
 * BrowshBrowser represents a running Browsh instance.
 *
 * Each Browsh process is a single-context browser. Unlike Chrome/Firefox
 * which support multiple isolated BrowserContexts within one process,
 * Browsh uses one Firefox tab per process. Each newContext() creates a
 * BrowshBrowserContext that uses the single connection.
 *
 * For full isolation, callers should launch() separate instances.
 *
 * Architecture follows the same layering as other browsers:
 *   Transport (WebSocketTransport) → Connection (BrowshConnection) → Browser (BrowshBrowser)
 */
export class BrowshBrowser extends Browser {
  private _contexts = new Map<string, BrowshBrowserContext>();
  private _version: string = 'browsh-1.0';
  private _connected: boolean = true;
  readonly connection: BrowshConnection;

  constructor(parent: SdkObject, connection: BrowshConnection, options: BrowserOptions) {
    super(parent, options);
    this.connection = connection;

    // Monitor connection lifecycle
    this.connection.on('disconnected', () => {
      this._connected = false;
      this.emit(Browser.Events.Disconnected);
    });
  }

  static async connect(parent: SdkObject, connection: BrowshConnection, options: BrowserOptions): Promise<BrowshBrowser> {
    const browser = new BrowshBrowser(parent, connection, options);
    // Optionally query version from browsh
    try {
      const versionData = await connection.send('version');
      if (typeof versionData === 'string')
        browser._version = versionData;
      else if (versionData?.version)
        browser._version = versionData.version;
    } catch {
      // Browsh may not support version command yet — use default
    }

    // Persistent context mode: create a default context like Chrome/Firefox do.
    // launchPersistentContext() expects browser._defaultContext to exist so it
    // can call _loadDefaultContext() on it.
    if (options.persistent) {
      browser._defaultContext = new BrowshBrowserContext(browser, options.persistent);
      const contextId = browser._defaultContext._browserContextId || '__default__';
      browser._contexts.set(contextId, browser._defaultContext as BrowshBrowserContext);
      await (browser._defaultContext as BrowshBrowserContext)._initialize();
    }

    return browser;
  }

  override async doCreateNewContext(options: types.BrowserContextOptions): Promise<BrowshBrowserContext> {
    const context = new BrowshBrowserContext(this, options);
    this._contexts.set(context._browserContextId || '__default__', context);
    context.on('close', () => {
      this._contexts.delete(context._browserContextId || '__default__');
    });
    await context._initialize();
    return context;
  }

  override contexts(): BrowshBrowserContext[] {
    return Array.from(this._contexts.values());
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
