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
 * can tell whether it ran. `attachments` maps resource slots to text, such as
 * the `secret` of `settings.saveCredential`, or to `{ file: handle }`, a file
 * `maka-files` registered, such as the `file` of `agent.uploadAttachment`; it
 * never reaches the log.
 *
 * @param {string} endpoint
 * @param {string} method
 * @param {unknown} input
 * @param {Record<string, string | { file: string }>} [attachments]
 */
export async function operation(endpoint, method, input, attachments) {
  const reply = await mutate(endpoint, method, input, attachments);
  const receipt = reply?.receipt;
  if (receipt?.kind !== 'recorded' || receipt.outcome?.kind !== 'returned') {
    throw new Error(
      `${endpoint}.${method} was not recorded as returned: ${JSON.stringify(receipt).slice(0, 300)}`,
    );
  }
  return receipt.outcome.value;
}

/**
 * Every model the Host offers that matches `search`, read page by page:
 * `{ choices, defaultModel }`. When the list changes between pages it is read
 * again from the start, once; null when it changed again.
 */
export async function readModels(search = '') {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let page = await query('settings', 'models', { kind: 'start', query: search });
    if (page.kind !== 'ready') continue;
    const { revision, defaultModel } = page;
    const choices = [...page.choices];
    while (page.kind === 'ready' && (page.next ?? null) !== null) {
      page = await query('settings', 'models', { kind: 'continue', revision, cursor: page.next });
      if (page.kind === 'ready') choices.push(...page.choices);
    }
    if (page.kind === 'ready') return { choices, defaultModel };
  }
  return null;
}

/**
 * Reads one `history` page of an Agent endpoint (`agent`, or WorkHub's
 * `coordinator`), asking again with the same fence and position while the
 * Host answers `preparing` (as the TUI does,
 * plugins/agent/agent-screen/results.ts:705). Resolves with the ready page and
 * the number of calls it took.
 */
export async function readHistory(input, endpoint = 'agent') {
  for (let calls = 1; ; calls += 1) {
    const page = await query(endpoint, 'history', input);
    if (input.through !== undefined && page.through !== input.through) {
      throw new Error(`history answered fence ${page.through} for ${input.through}`);
    }
    if (page.kind === 'ready') return { page, calls };
  }
}

/**
 * Reads one excerpt of a transcript field with an Agent endpoint's `source`,
 * asking again while the Host answers `preparing` (as the TUI's tool details
 * do, plugins/agent/tool-details/index.ts:156-180). Resolves with the source.
 */
export async function readSource(input, endpoint = 'agent') {
  for (;;) {
    const page = await query(endpoint, 'source', input);
    if (page.kind === 'ready') return page.source;
  }
}
