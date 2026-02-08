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

import net from 'net';

import { BrowshBrowser } from './browshBrowser';
import { BrowshConnection } from './browshConnection';
import { wrapInASCIIBox } from '../utils/ascii';
import { BrowserType } from '../browserType';
import { ManualPromise } from '../../utils/isomorphic/manualPromise';

import type { BrowserOptions } from '../browser';
import type { SdkObject } from '../instrumentation';
import type { ConnectionTransport } from '../transport';
import type * as types from '../types';
import type { RecentLogsCollector } from '../utils/debugLogger';

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

/**
 * Browsh BrowserType implementation.
 *
 * Browsh is treated as a first-class browser — same status as chromium,
 * firefox, webkit. We communicate only through Browsh's WebSocket API
 * and never touch its internal Firefox directly.
 *
 * Architecture boundary: Browsh speaks its own wire format ({command, args} /
 * {success, data, error}). BrowshTransport wraps the raw WebSocket on the
 * Playwright side and translates to/from Playwright's internal protocol.
 * This follows the same pattern as CRConnection (Chrome/CDP) and
 * FFConnection (Firefox/Juggler) — the adapter lives in Playwright, the
 * browser never needs to know about Playwright internals.
 *
 * Key differences from other browsers:
 * - Uses WebSocket JSON command protocol (not CDP or Juggler)
 * - Each launch() spawns a separate Browsh+Firefox process on its own port
 * - browser.newContext() spawns a new Browsh process (full isolation)
 * - No pipe transport — always connects via WebSocket
 */
export class Browsh extends BrowserType {
  constructor(parent: SdkObject) {
    super(parent, 'browsh');
  }

  override async connectToTransport(transport: ConnectionTransport, options: BrowserOptions, browserLogsCollector: RecentLogsCollector): Promise<BrowshBrowser> {
    // Create a BrowshConnection that wraps the raw WebSocketTransport.
    // Connection handles protocol translation (Playwright ↔ Browsh).
    // Transport handles raw I/O. Same separation as CRConnection/FFConnection.
    const connection = new BrowshConnection(transport, options.protocolLogger, browserLogsCollector);
    return BrowshBrowser.connect(this.attribution.playwright, connection, options);
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
    // Send browsh's native shutdown command directly over the raw transport.
    // The type cast is intentional — we're crossing the protocol boundary.
    // Browsh doesn't know about Playwright; it only understands {command, args}.
    transport.send({ command: 'shutdown' } as any);
  }

  override async defaultArgs(options: types.LaunchOptions, isPersistent: boolean, userDataDir: string): Promise<string[]> {
    const { args = [], headless } = options;
    const browshArgs = ['--remote-control'];

    // Auto-assign a free port for multi-instance support.
    // Each launch() gets its own port so multiple browsh instances coexist.
    let port = (options as any).__browshPort;
    if (port === undefined) {
      port = await findFreePort();
      (options as any).__browshPort = port;
    }
    browshArgs.push(`--remote-control-port=${port}`);

    // Headless for browsh means no terminal TUI — just the WebSocket API
    if (headless)
      browshArgs.push('--headless');

    browshArgs.push(...args);
    return browshArgs;
  }

  override supportsPipeTransport(): boolean {
    return false;
  }

  override waitForReadyState(options: types.LaunchOptions, browserLogsCollector: RecentLogsCollector): Promise<{ wsEndpoint?: string }> {
    const result = new ManualPromise<{ wsEndpoint?: string }>();

    browserLogsCollector.onMessage((message: string) => {
      // Browsh logs "Remote control listening on :PORT" or similar on ready
      if (message.includes('Remote control listening') || message.includes('WebSocket server started')) {
        // Try to extract port from log message
        const portMatch = message.match(/:(\d+)/);
        const port = portMatch ? parseInt(portMatch[1], 10) : ((options as any).__browshPort || 3335);
        result.resolve({ wsEndpoint: `ws://127.0.0.1:${port}` });
      }
    });

    // Fallback: if browsh doesn't print the expected ready message,
    // assume it's ready after a timeout using the configured port
    setTimeout(() => {
      if (!result.isDone()) {
        const port = (options as any).__browshPort || 3335;
        result.resolve({ wsEndpoint: `ws://127.0.0.1:${port}` });
      }
    }, 10000);

    return result;
  }
}
