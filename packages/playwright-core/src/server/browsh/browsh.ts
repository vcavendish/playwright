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
 * Browsh is a first-class browser type — same status as chromium, firefox,
 * webkit. We communicate only through Browsh's WebSocket API and never
 * touch its internal Firefox directly.
 *
 * Key difference from other browsers: Browsh is a TUI application that
 * renders to a terminal via tcell. It needs its own console window, not
 * piped stdio. We use the same extension points as other browsers
 * (defaultArgs, waitForReadyState, connectToTransport, etc.) but configure
 * the process launcher to give browsh a detached console and detect
 * readiness by polling the WebSocket port.
 */
export class Browsh extends BrowserType {
  constructor(parent: SdkObject) {
    super(parent, 'browsh');
  }

  override async connectToTransport(transport: ConnectionTransport, options: BrowserOptions, browserLogsCollector: RecentLogsCollector): Promise<BrowshBrowser> {
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
    transport.send({ command: 'shutdown' } as any);
  }

  override async defaultArgs(options: types.LaunchOptions, isPersistent: boolean, userDataDir: string): Promise<string[]> {
    const { args = [] } = options;
    const browshArgs = ['--remote-control'];

    let port = (options as any).__browshPort;
    if (port === undefined) {
      port = await findFreePort();
      (options as any).__browshPort = port;
    }
    browshArgs.push(`--remote-control-port=${port}`);
    // Auto-assign marionette port; websocket port controlled by XPI experiments API
    browshArgs.push('--marionette-port=0');
    // Pass --websocket-port=0 for multi-instance only if user didn't specify
    if (!args.some(a => a.startsWith('--websocket-port')))
      browshArgs.push('--websocket-port=3334');

    browshArgs.push(...args);
    return browshArgs;
  }

  override supportsPipeTransport(): boolean {
    // Browsh communicates via WebSocket, not pipe transport.
    // This tells _launchProcess to use WebSocketTransport.connect(wsEndpoint)
    // instead of PipeTransport on stdio fds 3/4.
    return false;
  }

  override launchProcessOptions(): {
    detached?: boolean,
    stdioOverride?: import('child_process').StdioOptions,
    wrapCommand?: (command: string, args: string[]) => { command: string, args: string[] },
    shell?: boolean,
  } {
    // Browsh is a TUI app — it needs a real console window for tcell rendering.
    // On Windows, `start` creates a new console window. shell: true runs
    // the command through cmd.exe so `start` is available as a built-in.
    // On Unix, detached: true creates a new process group.
    if (process.platform === 'win32') {
      return {
        shell: true,
        stdioOverride: ['ignore', 'ignore', 'ignore'],
        wrapCommand: (command, args) => ({
          command: 'start',
          args: ['"Browsh"', '/wait', command.replace(/\\/g, '/'), ...args],
        }),
      };
    }
    return {
      detached: true,
      stdioOverride: ['ignore', 'ignore', 'ignore'],
    };
  }

  override waitForReadyState(options: types.LaunchOptions, browserLogsCollector: RecentLogsCollector): Promise<{ wsEndpoint?: string }> {
    const port = (options as any).__browshPort || 3335;
    const wsEndpoint = `ws://127.0.0.1:${port}`;
    const result = new ManualPromise<{ wsEndpoint?: string }>();

    // Primary: detect ready signal from browsh's stderr log output.
    browserLogsCollector.onMessage((message: string) => {
      if (message.includes('Remote control listening') || message.includes('WebSocket server started')) {
        const portMatch = message.match(/:(\d+)/);
        const detectedPort = portMatch ? parseInt(portMatch[1], 10) : port;
        result.resolve({ wsEndpoint: `ws://127.0.0.1:${detectedPort}` });
      }
    });

    // Fallback: poll the WebSocket port directly.
    // Browsh is a TUI app that may launch in its own console window
    // (detached: true). If stdio is not piped, log messages won't reach
    // browserLogsCollector. Port polling detects readiness regardless.
    const pollPort = () => {
      if (result.isDone())
        return;
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => {
        socket.destroy();
        if (!result.isDone())
          result.resolve({ wsEndpoint });
      });
      socket.once('error', () => {
        socket.destroy();
        if (!result.isDone())
          setTimeout(pollPort, 500);
      });
    };
    setTimeout(pollPort, 1000);

    return result;
  }
}
