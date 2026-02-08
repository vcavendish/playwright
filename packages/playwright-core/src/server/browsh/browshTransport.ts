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

import { WebSocket } from 'ws';

import type { ConnectionTransport, ProtocolRequest, ProtocolResponse } from '../transport';

/**
 * Bridges Playwright's ConnectionTransport interface with Browsh's WebSocket
 * JSON command protocol.
 *
 * Playwright expects:   { id, method, params, sessionId }
 * Browsh expects:       { command, args }
 * Browsh responds:      { success, command, data, error }
 *
 * This transport translates between the two formats and manages the WebSocket
 * connection lifecycle.
 */
export class BrowshTransport implements ConnectionTransport {
  private _ws: WebSocket;
  private _pendingRequests = new Map<number, { method: string }>();
  onmessage?: (message: ProtocolResponse) => void;
  onclose?: (reason?: string) => void;

  private constructor(ws: WebSocket) {
    this._ws = ws;
    this._ws.on('message', (data: Buffer) => {
      try {
        const raw = JSON.parse(data.toString());
        const response = this._browshToProtocol(raw);
        if (response && this.onmessage)
          this.onmessage(response);
      } catch (e) {
        // Ignore malformed messages
      }
    });
    this._ws.on('close', (code, reason) => {
      if (this.onclose)
        this.onclose(reason?.toString() || `WebSocket closed with code ${code}`);
    });
    this._ws.on('error', error => {
      if (this.onclose)
        this.onclose(error.message);
    });
  }

  static async connect(wsEndpoint: string, timeout: number = 30000): Promise<BrowshTransport> {
    return new Promise<BrowshTransport>((resolve, reject) => {
      const ws = new WebSocket(wsEndpoint);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error(`Browsh WebSocket connection timeout after ${timeout}ms to ${wsEndpoint}`));
      }, timeout);

      ws.on('open', () => {
        clearTimeout(timer);
        resolve(new BrowshTransport(ws));
      });
      ws.on('error', error => {
        clearTimeout(timer);
        reject(new Error(`Browsh WebSocket connection failed: ${error.message}`));
      });
    });
  }

  send(message: ProtocolRequest): void {
    const browshMessage = this._protocolToBrowsh(message);
    this._pendingRequests.set(message.id, { method: message.method });
    this._ws.send(JSON.stringify(browshMessage));
  }

  close(): void {
    // Send shutdown command before closing
    try {
      this._ws.send(JSON.stringify({ command: 'shutdown' }));
    } catch (e) {
      // Ignore if already closed
    }
    this._ws.close();
  }

  /**
   * Translate Playwright ProtocolRequest to Browsh command format.
   * Maps known Playwright method names to Browsh commands.
   */
  private _protocolToBrowsh(message: ProtocolRequest): { command: string; args?: string } {
    const { method, params } = message;

    // Map Playwright-style methods to Browsh commands
    switch (method) {
      case 'Page.navigate':
      case 'navigate':
        return { command: 'navigate', args: params?.url || params };
      case 'Page.evaluate':
      case 'evaluate':
        return { command: 'evaluate', args: params?.expression || params };
      case 'Page.snapshot':
      case 'get_aria_snapshot':
        return { command: 'get_aria_snapshot' };
      case 'Page.click':
      case 'click_ref':
        return { command: 'click_ref', args: params?.ref || params };
      case 'Page.type':
      case 'type':
        return { command: 'type', args: params?.text || params };
      case 'Page.press':
      case 'press':
        return { command: 'press', args: params?.key || params };
      case 'Page.goBack':
      case 'back':
        return { command: 'back' };
      case 'Page.goForward':
      case 'forward':
        return { command: 'forward' };
      case 'Page.reload':
      case 'reload':
        return { command: 'reload' };
      case 'Page.screenshot':
      case 'screenshot':
        return { command: 'screenshot' };
      case 'Page.getState':
      case 'get_state':
        return { command: 'get_state' };
      case 'Page.scrollDown':
      case 'scroll_down':
        return { command: 'scroll_down' };
      case 'Page.scrollUp':
      case 'scroll_up':
        return { command: 'scroll_up' };
      case 'Browser.close':
        return { command: 'shutdown' };
      case 'Browser.version':
      case 'version':
        return { command: 'version' };
      default:
        return { command: method, args: params ? JSON.stringify(params) : undefined };
    }
  }

  /**
   * Translate Browsh response to Playwright ProtocolResponse format.
   */
  private _browshToProtocol(raw: any): ProtocolResponse | null {
    // Find the oldest pending request to match this response
    // Browsh uses FIFO response ordering (no request ID in response)
    const firstPending = this._pendingRequests.entries().next();
    if (!firstPending.done) {
      const [id] = firstPending.value;
      this._pendingRequests.delete(id);

      if (raw.success === false)
        return { id, error: { message: raw.error || 'Browsh command failed', data: raw.data } };

      return { id, result: raw.data };
    }

    // Unsolicited event from Browsh (if any)
    if (raw.command)
      return { method: `Browsh.${raw.command}`, params: raw.data };

    return null;
  }
}
