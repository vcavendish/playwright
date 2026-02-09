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
 * Key difference from CDP/Juggler: Marionette's ExecuteScript runs each call
 * in a fresh local scope, but the page's `window` object persists. We exploit
 * this by storing persistent objects (UtilityScript, InjectedScript) on window
 * properties, then referencing them by name in subsequent evaluate calls.
 *
 * evaluateWithArguments handles two flows:
 *   1. User evaluate: extracts original expression, evaluates directly
 *   2. Internal handle.evaluateHandle: dereferences handles via window props
 */
export class BrowshExecutionContext implements js.ExecutionContextDelegate {
  private _connection: BrowshConnection;
  private _handleCounter = 0;

  constructor(connection: BrowshConnection) {
    this._connection = connection;
  }

  async rawEvaluateJSON(expression: string): Promise<any> {
    return await this._connection.send('evaluate', { expression });
  }

  async rawEvaluateHandle(context: js.ExecutionContext, expression: string): Promise<js.JSHandle> {
    // Inject the expression result into a window property so it persists
    // across Marionette calls. This enables UtilityScript and InjectedScript
    // to work — they're stored on window and dereferenced by property name.
    //
    // Critical: Marionette's WebDriver:ExecuteScript always serializes the return
    // value via cloneJSON. Complex objects (like InjectedScript) contain cyclic
    // references (window → navigator → MimeType → window) that fail serialization.
    // We wrap the expression so the assignment happens inside a function body
    // and we return a simple string instead of the object itself.
    const handleId = `__pw_handle_${this._handleCounter++}`;
    const safeExpression = `(() => { window.${handleId} = ${expression}; return "${handleId}"; })()`;
    try {
      await this._connection.send('evaluate', { expression: safeExpression });
    } catch (e) {
      // If injection fails, return a dummy handle (graceful degradation)
      return new js.JSHandle(context, 'object', 'BrowshHandle', undefined, undefined);
    }
    return new js.JSHandle(context, 'object', 'BrowshHandle', handleId, undefined);
  }

  async evaluateWithArguments(expression: string, returnByValue: boolean, utilityScript: js.JSHandle, values: any[], handles: js.JSHandle[]): Promise<any> {
    // Playwright wraps all evaluate() calls through UtilityScript:
    //   expression = "(utilityScript, ...args) => utilityScript.evaluate(...args)"
    //   values = [isFunction, returnByValue, originalExpression, argCount, ...userArgs]
    //   handles = [handle0, handle1, ...] referenced by { h: index } in userArgs
    //
    // For user-level evaluate: handles is empty, we extract and run the original expression.
    // For internal handle calls (e.g., injectedScript.evaluateHandle):
    //   handles contains the InjectedScript handle, and the original expression
    //   is a callback like (injected, arg) => injected.querySelectorAll(...)
    //   We dereference handles via their window property names.
    const isFunction = values[0];
    const originalExpression = values[2] as string;
    const argCount = values[3] as number;
    const userArgs = values.slice(4, 4 + argCount);

    // Check if any user args reference handles (via { h: index } markers).
    // If so, this is an internal call that needs handle dereferencing.
    const hasHandleRefs = userArgs.some((a: any) => a && typeof a === 'object' && 'h' in a);

    let script: string;
    if (hasHandleRefs && isFunction) {
      // Internal call pattern: the original expression is a callback function
      // that receives dereferenced handles as arguments.
      // Replace { h: index } references with window property access.
      const resolvedArgs = userArgs.map((a: any) => {
        if (a && typeof a === 'object' && 'h' in a) {
          const handle = handles[a.h];
          if (handle?._objectId)
            return `window.${handle._objectId}`;
          return 'undefined';
        }
        return JSON.stringify(this._deserializeArg(a));
      });
      script = `(${originalExpression})(${resolvedArgs.join(', ')})`;
    } else if (isFunction && argCount === 0) {
      script = `(${originalExpression})()`;
    } else if (isFunction) {
      const deserializedArgs = userArgs.map((a: any) => this._deserializeArg(a));
      const serializedArgs = deserializedArgs.map((a: any) => JSON.stringify(a)).join(', ');
      script = `(${originalExpression})(${serializedArgs})`;
    } else {
      script = originalExpression;
    }

    if (!returnByValue) {
      // Store result on window and return a JSHandle reference.
      // This enables chained handle operations (e.g., result.evaluate(r => r.element))
      // without Marionette trying to serialize DOM elements or complex objects.
      const handleId = `__pw_handle_${this._handleCounter++}`;
      const safeScript = `(() => { window.${handleId} = (${script}); return "${handleId}"; })()`;
      try {
        await this._connection.send('evaluate', { expression: safeScript });
        return new js.JSHandle(utilityScript._context, 'object', 'BrowshHandle', handleId, undefined);
      } catch (e) {
        // If the expression itself fails (not serialization), re-throw
        throw e;
      }
    }

    const result = await this._connection.send('evaluate', { expression: script });
    return hasHandleRefs ? this._fixNullUndefined(result) : result;
  }

  /**
   * Marionette's JSON serialization converts `undefined` to `null`.
   * Playwright checks `!== undefined` in several places (e.g., snapshotForAI
   * incremental field). Convert null object values back to undefined.
   */
  private _fixNullUndefined(value: any): any {
    if (value === null)
      return undefined;
    if (typeof value !== 'object' || Array.isArray(value))
      return value;
    const result: any = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = v === null ? undefined : v;
    }
    return result;
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
