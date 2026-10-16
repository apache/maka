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

// Thin wrappers over the `maka-host` module, and the debug log. Every Host
// call the application makes goes through this file.

import { query, mutate, subscribe, next, close } from 'maka-host';

export { query, subscribe, next, close };

let debugging = false;
const started = Date.now();

/** Turns the debug log on; `dev.js` beside `main.js` does this. Off by default. */
export function setDebug(enabled) {
  debugging = enabled;
}

/** Writes one line to stderr when debugging, with milliseconds since start. */
export function log(message) {
  if (debugging) console.log(`maka-desktop +${Date.now() - started}ms ${message}`);
}

/**
 * Runs a mutation and returns the method's own result. `mutate` resolves with
 * the operation reply; the result is the receipt's returned value. Any other
 * receipt is an error. A mutation is never retried: only the original call
 * can tell whether it ran.
 */
export async function operation(endpoint, method, input) {
  const reply = await mutate(endpoint, method, input);
  const receipt = reply?.receipt;
  if (receipt?.kind !== 'recorded' || receipt.outcome?.kind !== 'returned') {
    throw new Error(
      `${endpoint}.${method} was not recorded as returned: ${JSON.stringify(receipt).slice(0, 300)}`,
    );
  }
  return receipt.outcome.value;
}

/**
 * Reads one `agent.history` page, asking again with the same fence and
 * position while the Host answers `preparing` (as the TUI does,
 * plugins/agent/agent-screen/results.ts:705). Resolves with the ready page and
 * the number of calls it took.
 */
export async function readHistory(input) {
  for (let calls = 1; ; calls += 1) {
    const page = await query('agent', 'history', input);
    if (input.through !== undefined && page.through !== input.through) {
      throw new Error(`history answered fence ${page.through} for ${input.through}`);
    }
    if (page.kind === 'ready') return { page, calls };
  }
}
