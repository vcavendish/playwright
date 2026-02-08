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

import { BrowshBrowser } from './browshBrowser';
import { wrapInASCIIBox } from '../utils/ascii';
import { BrowserType } from '../browserType';
import { ManualPromise } from '../../utils/isomorphic/manualPromise';

import type { BrowserOptions } from '../browser';
import type { SdkObject } from '../instrumentation';
import type { ConnectionTransport } from '../transport';
import type * as types from '../types';
import type { RecentLogsCollector } from '../utils/debugLogger';

/**
 * Browsh BrowserType implementation.
 *
 * Browsh is treated as a first-class browser — same status as chromium,
 * firefox, webkit. We communicate only through Browsh's WebSocket API
 * and never touch its internal Firefox directly.
 *
 * Key differences from other browsers:
 * - Uses WebSocket JSON command protocol (not CDP or Juggler)
 * - Each launch() spawns a separate Browsh+Firefox process
 * - browser.newContext() is handled by the MCP layer spawning new instances
 * - No pipe transport — always connects via WebSocket
 */
export class Browsh extends BrowserType {
  constructor(parent: SdkObject) {
    super(parent, 'browsh');
  }

  override async connectToTransport(transport: ConnectionTransport, options: BrowserOptions, browserLogsCollector: RecentLogsCollector): Promise<BrowshBrowser> {
    const wsEndpoint = options.wsEndpoint || '';
    return BrowshBrowser.connect(this.attribution.playwright, options, wsEndpoint);
  }

  override doRewriteStartupLog(logs: string): string {
    if (logs.includes('address already in use'))
      return '\n' + wrapInASCIIBox('Browsh failed to start: port already in use.\nAnother Browsh instance may be running. Use a different --remote-control-port or stop the existing instance.', 1);
    if (logs.includes('Firefox not found') || logs.includes('firefox: not found'))
      return '\n' + wrapInASCIIBox('Browsh requires Firefox to be installed.\nInstall Firefox and ensure it is available on your PATH.', 1);
    return logs;
  }

  override amendEnvironment(env: NodeJS.ProcessEnv, userDataDir: string, isPersistent: boolean, options: types.LaunchOptions): NodeJS.ProcessEnv {
    return { ...env };
  }

  override attemptToGracefullyCloseBrowser(transport: ConnectionTransport): void {
    transport.send({ method: 'Browser.close', params: {}, id: -1 });
  }

  override async defaultArgs(options: types.LaunchOptions, isPersistent: boolean, userDataDir: string): Promise<string[]> {
    const { args = [], headless } = options;
    const browshArgs = ['--remote-control'];

    // Headless for browsh means no terminal TUI — just the WebSocket API
    if (headless)
      browshArgs.push('--headless');

    browshArgs.push(...args);
    return browshArgs;
  }

  override supportsPipeTransport(): boolean {
    // Browsh uses WebSocket, not pipe
    return false;
  }

  override waitForReadyState(options: types.LaunchOptions, browserLogsCollector: RecentLogsCollector): Promise<{ wsEndpoint?: string }> {
    // Wait for browsh to signal it's ready by looking for the ready message
    // in its stdout. The port is extracted from the log message.
    const result = new ManualPromise<{ wsEndpoint?: string }>();
    const port = (options as any).__browshPort || 3335;

    browserLogsCollector.onMessage((message: string) => {
      // Look for browsh startup ready message
      if (message.includes('Remote control listening') || message.includes('WebSocket server started'))
        result.resolve({ wsEndpoint: `ws://127.0.0.1:${port}` });
    });

    // Also set a timeout fallback — if browsh doesn't print the expected
    // message, assume it's ready after a reasonable delay
    setTimeout(() => {
      if (!result.isDone())
        result.resolve({ wsEndpoint: `ws://127.0.0.1:${port}` });
    }, 10000);

    return result;
  }
}
