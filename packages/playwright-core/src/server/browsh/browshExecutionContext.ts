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

import * as js from '../javascript';

import type { BrowshConnection } from './browshConnection';

/**
 * BrowshExecutionContext — delegates JS evaluation to browsh's remote
 * control API, which in turn uses Marionette's WebDriver:ExecuteScript.
 *
 * Key difference from CDP/Juggler: Marionette's ExecuteScript is stateless —
 * each call runs in a fresh scope with no persistent object references.
 * We can't use Playwright's UtilityScript (it requires persistent contexts).
 * Instead, evaluateWithArguments extracts the original expression from
 * Playwright's wrapper and evaluates it directly.
 */
export class BrowshExecutionContext implements js.ExecutionContextDelegate {
  private _connection: BrowshConnection;

  constructor(connection: BrowshConnection) {
    this._connection = connection;
  }

  async rawEvaluateJSON(expression: string): Promise<any> {
    return await this._connection.send('evaluate', { expression });
  }

  async rawEvaluateHandle(context: js.ExecutionContext, expression: string): Promise<js.JSHandle> {
    // UtilityScript injection lands here. We can't persist it across
    // Marionette calls, so return a dummy handle. evaluateWithArguments
    // bypasses it and sends the original expression directly.
    return new js.JSHandle(context, 'object', 'BrowshUtilityScript', '__browsh_utility__', {});
  }

  async evaluateWithArguments(expression: string, returnByValue: boolean, utilityScript: js.JSHandle, values: any[], handles: js.JSHandle[]): Promise<any> {
    // Playwright wraps all evaluate() calls through UtilityScript:
    //   expression = "(utilityScript, ...args) => utilityScript.evaluate(...args)"
    //   values = [isFunction, returnByValue, originalExpression, argCount, ...userArgs]
    //
    // We skip the UtilityScript and evaluate the original expression directly
    // via Marionette's WebDriver:ExecuteScript.
    //
    // userArgs are serialized by Playwright's serializeAsCallArgument — each
    // arg is wrapped as { v: "undefined" } | { v: "null" } | { v: "NaN" } |
    // { n: number } | { s: string } | { b: boolean } | { o: [...] } etc.
    // We need to deserialize them back to plain values for JSON.stringify.
    const isFunction = values[0];
    const originalExpression = values[2] as string;
    const argCount = values[3] as number;
    const userArgs = values.slice(4, 4 + argCount);

    let script: string;
    if (isFunction && argCount === 0) {
      script = `(${originalExpression})()`;
    } else if (isFunction) {
      const deserializedArgs = userArgs.map((a: any) => this._deserializeArg(a));
      const serializedArgs = deserializedArgs.map((a: any) => JSON.stringify(a)).join(', ');
      script = `(${originalExpression})(${serializedArgs})`;
    } else {
      script = originalExpression;
    }

    return await this._connection.send('evaluate', { expression: script });
  }

  /**
   * Deserialize a Playwright-serialized argument back to a plain JS value.
   * Playwright's serializeAsCallArgument produces objects like:
   *   { n: 42 }, { s: "hello" }, { b: true }, { v: "undefined" },
   *   { a: [...items] }, { o: [...entries] }
   */
  private _deserializeArg(arg: any): any {
    if (arg === null || arg === undefined) return arg;
    if (typeof arg !== 'object') return arg;
    if ('v' in arg) {
      if (arg.v === 'undefined') return undefined;
      if (arg.v === 'null') return null;
      if (arg.v === 'NaN') return NaN;
      if (arg.v === 'Infinity') return Infinity;
      if (arg.v === '-Infinity') return -Infinity;
      if (arg.v === '-0') return -0;
      return undefined;
    }
    if ('n' in arg) return arg.n;
    if ('s' in arg) return arg.s;
    if ('b' in arg) return arg.b;
    if ('a' in arg) return (arg.a as any[]).map((item: any) => this._deserializeArg(item));
    if ('o' in arg) {
      const obj: any = {};
      for (const { k, v } of arg.o)
        obj[k] = this._deserializeArg(v);
      return obj;
    }
    // Fallthrough: return as-is
    return arg;
  }

  async getProperties(object: js.JSHandle): Promise<Map<string, js.JSHandle>> {
    return new Map();
  }

  async releaseHandle(_handle: js.JSHandle): Promise<void> {
    // No-op: browsh has no persistent object handles.
  }
}
