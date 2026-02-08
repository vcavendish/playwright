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

import { BrowserContext } from '../browserContext';
import { Page } from '../page';
import { BrowshPage } from './browshPage';

import type { BrowshBrowser } from './browshBrowser';
import type { InitScript } from '../page';
import type * as types from '../types';
import type * as channels from '@protocol/channels';

/**
 * BrowshBrowserContext — BrowserContext implementation for Browsh.
 *
 * Browsh is a single-context, single-tab browser. Each context corresponds
 * to one Browsh+Firefox process. Context isolation is achieved by spawning
 * separate processes (handled at the BrowshBrowser level).
 *
 * Architecture matches other browsers:
 *   CRBrowserContext → CRPage → Page
 *   BrowshBrowserContext → BrowshPage → Page
 */
export class BrowshBrowserContext extends BrowserContext {
  declare readonly _browser: BrowshBrowser;
  private _pages: BrowshPage[] = [];

  constructor(browser: BrowshBrowser, options: types.BrowserContextOptions) {
    super(browser, options, undefined);
  }

  override async _initialize() {
    await super._initialize();
    // In persistent context mode, create a default page immediately.
    // Chrome/Firefox get this from the browser process auto-creating a tab;
    // browsh already has a tab open, so we create the Playwright Page to
    // represent it. _loadDefaultContext() expects a page to exist.
    if (this._browser.options.persistent)
      await this.doCreateNewPage();
  }

  override possiblyUninitializedPages(): Page[] {
    return this._pages.map(bp => bp._page);
  }

  override async doCreateNewPage(): Promise<Page> {
    const browshPage = new BrowshPage(this._browser.connection, this);
    this._pages.push(browshPage);
    await browshPage.initialize();
    return browshPage._page;
  }

  async _closePage(browshPage: BrowshPage): Promise<void> {
    const index = this._pages.indexOf(browshPage);
    if (index !== -1)
      this._pages.splice(index, 1);
  }

  // --- Cookie stubs (browsh does not expose cookie management) ---

  override async addCookies(_cookies: channels.SetNetworkCookie[]): Promise<void> { }

  override async doGetCookies(_urls: string[]): Promise<channels.NetworkCookie[]> {
    return [];
  }

  override async doClearCookies(): Promise<void> { }

  // --- Permission stubs ---

  override async doGrantPermissions(_origin: string, _permissions: string[]): Promise<void> { }
  override async doClearPermissions(): Promise<void> { }

  // --- Geolocation / user agent ---

  override async setGeolocation(_geolocation?: types.Geolocation): Promise<void> { }
  override async setUserAgent(_userAgent: string | undefined): Promise<void> { }

  // --- Network stubs ---

  override async doSetHTTPCredentials(_httpCredentials?: types.Credentials): Promise<void> { }
  override async doUpdateExtraHTTPHeaders(): Promise<void> { }
  override async doUpdateOffline(): Promise<void> { }
  override async doUpdateRequestInterception(): Promise<void> { }

  // --- Init script stubs ---

  override async doAddInitScript(_initScript: InitScript): Promise<void> { }
  override async doRemoveInitScripts(_initScripts: InitScript[]): Promise<void> { }

  // --- Viewport / media ---

  override async doUpdateDefaultViewport(): Promise<void> { }
  override async doUpdateDefaultEmulatedMedia(): Promise<void> { }

  // --- Bindings ---

  override async doExposePlaywrightBinding(): Promise<void> { }

  // --- Close ---

  override async doClose(_reason: string | undefined): Promise<void> {
    for (const browshPage of this._pages)
      browshPage._page._didClose();
    this._pages = [];
  }

  override onClosePersistent(): void { }

  // --- Download / cache ---

  override async cancelDownload(_uuid: string): Promise<void> { }
  override async clearCache(): Promise<void> { }
}
