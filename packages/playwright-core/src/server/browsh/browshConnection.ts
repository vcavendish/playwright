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
import { helper } from '../helper';

import type { ConnectionTransport, ProtocolResponse } from '../transport';
import type { ProtocolLogger } from '../types';
import type { RecentLogsCollector } from '../utils/debugLogger';

/**
 * BrowshConnection — protocol logic layer between transport and browser.
 *
 * Follows the same pattern as CRConnection (Chrome/CDP) and FFConnection
 * (Firefox/Juggler):
 *   Transport (raw I/O)  →  Connection (protocol logic)  →  Browser
 *   WebSocketTransport   →  BrowshConnection              →  BrowshBrowser
 *
 * The Transport handles raw WebSocket I/O. This Connection layer handles:
 * - Translating between Playwright protocol and Browsh's native wire format
 * - Tracking pending requests (FIFO matching since browsh has no request IDs)
 * - Lifecycle events (close/disconnect)
 *
 * Browsh's wire format:
 *   Request:   { command: string, args?: string }
 *   Response:  { success: boolean, command: string, data?: any, error?: string }
 *
 * Browsh never sees Playwright concepts — all translation lives here.
 */
export class BrowshConnection extends EventEmitter {
  private _transport: ConnectionTransport;
  private readonly _protocolLogger: ProtocolLogger;
  private readonly _browserLogsCollector: RecentLogsCollector;
  private _pendingCallbacks = new Map<number, { resolve: (o: any) => void; reject: (e: Error) => void; method: string }>();
  private _lastId = 0;
  _browserDisconnectedLogs: string | undefined;
  _closed = false;

  constructor(transport: ConnectionTransport, protocolLogger: ProtocolLogger, browserLogsCollector: RecentLogsCollector) {
    super();
    this.setMaxListeners(0);
    this._transport = transport;
    this._protocolLogger = protocolLogger;
    this._browserLogsCollector = browserLogsCollector;

    this._transport.onmessage = this._onMessage.bind(this);
    this._transport.onclose = this._onClose.bind(this);
  }

  /**
   * Send a command to browsh. Translates from Playwright method/params to
   * browsh's native {command, args} format.
   */
  send(method: string, params?: any): Promise<any> {
    const id = ++this._lastId;
    const browshCommand = this._toBrowshCommand(method, params);
    this._protocolLogger('send', { id, method, params });
    // Send browsh's native format over the wire
    this._transport.send(browshCommand as any);
    return new Promise((resolve, reject) => {
      this._pendingCallbacks.set(id, { resolve, reject, method });
    });
  }

  /**
   * Handle incoming messages from browsh — translate to Playwright format
   * and resolve pending callbacks.
   */
  private _onMessage(raw: ProtocolResponse) {
    // Browsh sends {success, command, data, error} — match to oldest pending request
    const firstPending = this._pendingCallbacks.entries().next();
    if (!firstPending.done) {
      const [id, callback] = firstPending.value;
      this._pendingCallbacks.delete(id);
      this._protocolLogger('receive', { id, result: (raw as any).data });

      if ((raw as any).success === false) {
        callback.reject(new Error((raw as any).error || 'Browsh command failed'));
        return;
      }
      callback.resolve((raw as any).data);
      return;
    }

    // Unsolicited event from browsh
    if ((raw as any).command)
      this.emit('event', { method: (raw as any).command, params: (raw as any).data });
  }

  private _onClose(reason?: string) {
    this._closed = true;
    this._transport.onmessage = undefined;
    this._transport.onclose = undefined;
    this._browserDisconnectedLogs = helper.formatBrowserLogs(this._browserLogsCollector.recentLogs(), reason);

    // Reject all pending callbacks
    for (const [, callback] of this._pendingCallbacks)
      callback.reject(new Error('Connection closed'));
    this._pendingCallbacks.clear();

    this.emit('disconnected');
  }

  close() {
    if (!this._closed)
      this._transport.close();
  }

  /**
   * Translate Playwright method/params → browsh {command, args}.
   * Only browsh's native command vocabulary is used here.
   */
  private _toBrowshCommand(method: string, params?: any): { command: string; args?: string } {
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
        return { command: method, args: params ? JSON.stringify(params) : undefined };
    }
  }
}
