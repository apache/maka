/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const base = new URL('../../../crates/js-runtime/src/plugin/', import.meta.url);
const source = await readFile(new URL('presenter.js', base), 'utf8');
const builderSource = await readFile(new URL('terminal-builders.js', base), 'utf8');

/** A bridge stand-in: the Host implementation separately validates real tickets. */
export function presenter(factory, backend) {
  const calls = new Map();
  let sequence = 0;
  const scope = vm.createContext({
    Deno: {
      core: {
        ops: {
          op_maka_plugin: async (_key, method, input) => {
            assert.equal(method, 'page.backend');
            assert.deepEqual(Object.keys(input), ['authority']);
            const call = calls.get(input.authority);
            assert.ok(call && !call.used, 'a live, one-use original invocation');
            call.used = true;
            return await backend(call.input, call.caller);
          },
        },
      },
    },
  });
  const terminal = vm.runInContext(builderSource, scope);
  const runtime = vm.runInContext(source, scope)({ default: factory }, 'page', terminal);
  return {
    runtime,
    async invoke(input, caller) {
      const authority = `call-${++sequence}`;
      calls.set(authority, { input: structuredClone(input), caller, used: false });
      try {
        return await runtime.invoke(structuredClone(input), authority);
      } finally {
        calls.delete(authority);
      }
    },
    cancel: () => runtime.cancel(),
  };
}
