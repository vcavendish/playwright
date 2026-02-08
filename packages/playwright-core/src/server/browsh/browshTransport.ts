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

import type { ConnectionTransport, ProtocolRequest, ProtocolResponse } from '../transport';

/**
 * Protocol-translating adapter that wraps a raw ConnectionTransport (WebSocket)
 * and bridges between Playwright's internal protocol format and Browsh's
 * native command API.
 *
 * This follows the same pattern as CRConnection (Chrome) and FFConnection
 * (Firefox) — the adapter lives entirely on the Playwright side. Browsh
 * never needs to know about Playwright's protocol; it only speaks its own
 * `{command, args}` / `{success, data, error}` wire format.
 *
 * Playwright sends:    { id, method, params, sessionId }
 * Browsh expects:      { command, args }
 * Browsh responds:     { success, command, data, error }
 */
export class BrowshTransport implements ConnectionTransport {
  private _inner: ConnectionTransport;
  private _pendingRequests = new Map<number, { method: string }>();
  onmessage?: (message: ProtocolResponse) => void;
  onclose?: (reason?: string) => void;

  /**
   * Wrap an existing transport (from base class's WebSocketTransport.connect())
   * in a protocol-translating layer.
   */
  constructor(rawTransport: ConnectionTransport) {
    this._inner = rawTransport;

    // Intercept incoming messages: translate Browsh → Playwright
    this._inner.onmessage = (raw: ProtocolResponse) => {
      const translated = this._browshToProtocol(raw);
      if (translated && this.onmessage)
        this.onmessage(translated);
    };

    this._inner.onclose = (reason?: string) => {
      if (this.onclose)
        this.onclose(reason);
    };
  }

  /**
   * Translate outgoing Playwright protocol request to Browsh command format,
   * then send it over the raw transport.
   */
  send(message: ProtocolRequest): void {
    this._pendingRequests.set(message.id, { method: message.method });
    const browshMessage = this._protocolToBrowsh(message);
    // WebSocketTransport.send() calls JSON.stringify on what it receives.
    // We pass browsh's native format — the type cast is intentional since
    // we're crossing the protocol boundary.
    this._inner.send(browshMessage as any);
  }

  close(): void {
    try {
      this._inner.send({ command: 'shutdown' } as any);
    } catch {
      // Ignore if already closed
    }
    this._inner.close();
  }

  /**
   * Translate Playwright ProtocolRequest → Browsh {command, args}.
   * Only browsh's native commands are used — no Playwright concepts leak.
   */
  private _protocolToBrowsh(message: ProtocolRequest): { command: string; args?: string } {
    const { method, params } = message;

    switch (method) {
      case 'navigate':
        return { command: 'navigate', args: params?.url || params };
      case 'evaluate':
        return { command: 'evaluate', args: params?.expression || params };
      case 'get_aria_snapshot':
        return { command: 'get_aria_snapshot' };
      case 'click_ref':
        return { command: 'click_ref', args: params?.ref || params };
      case 'type':
        return { command: 'type', args: params?.text || params };
      case 'press':
        return { command: 'press', args: params?.key || params };
      case 'back':
        return { command: 'back' };
      case 'forward':
        return { command: 'forward' };
      case 'reload':
        return { command: 'reload' };
      case 'screenshot':
        return { command: 'screenshot' };
      case 'get_state':
        return { command: 'get_state' };
      case 'scroll_down':
        return { command: 'scroll_down' };
      case 'scroll_up':
        return { command: 'scroll_up' };
      case 'shutdown':
        return { command: 'shutdown' };
      case 'version':
        return { command: 'version' };
      default:
        // Pass through as browsh command name directly
        return { command: method, args: params ? JSON.stringify(params) : undefined };
    }
  }

  /**
   * Translate incoming Browsh response → Playwright ProtocolResponse.
   * Browsh sends FIFO responses without request IDs, so we match by order.
   */
  private _browshToProtocol(raw: any): ProtocolResponse | null {
    const firstPending = this._pendingRequests.entries().next();
    if (!firstPending.done) {
      const [id] = firstPending.value;
      this._pendingRequests.delete(id);

      if (raw.success === false)
        return { id, error: { message: raw.error || 'Browsh command failed', data: raw.data } };
      return { id, result: raw.data };
    }

    // Unsolicited event from Browsh
    if (raw.command)
      return { method: `Browsh.${raw.command}`, params: raw.data };
    return null;
  }
}
