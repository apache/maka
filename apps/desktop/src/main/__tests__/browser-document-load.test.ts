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
import { test } from 'node:test';
import { BrowserDocumentLoad } from '../browser/document-load.js';

const url = 'https://example.com/preview';

test('completion needs a commit in this navigation, including same-URL reloads', () => {
  const load = new BrowserDocumentLoad();
  assert.equal(load.snapshot().state, 'unknown');
  load.start(url);
  load.commit(url);
  load.finish(url);
  const previous = load.snapshot();
  assert.equal(previous.state, 'completed');
  load.start(url);
  load.finish(url); // The previous document cannot complete a pending reload.
  assert.equal(load.snapshot().state, 'loading');
  assert.notEqual(load.snapshot().navigationId, previous.navigationId);
  assert.equal(previous.state, 'completed', 'published snapshots remain immutable');
  load.commit(url);
  load.finish(url);
  assert.equal(load.snapshot().state, 'completed');
});

for (const code of [-354, -3]) {
  test(`a committed failure ${code} survives finish and same-document events`, () => {
    const load = new BrowserDocumentLoad();
    load.start(url);
    load.commit(url);
    load.fail(url, code);
    load.inPage(`${url}#hash`);
    load.finish(`${url}#hash`);
    assert.equal(load.snapshot().state, code === -3 ? 'stopped' : 'failed');
    assert.equal(load.snapshot().errorCode, code);
  });
}

test('stop invalidates a pending load but does not revoke an already completed load', () => {
  const load = new BrowserDocumentLoad();
  load.start(url);
  load.commit(url);
  load.stop();
  load.finish(url);
  assert.equal(load.snapshot().state, 'stopped');
  load.start(url);
  load.commit(url);
  load.finish(url);
  load.stop();
  assert.equal(load.snapshot().state, 'completed');
});

test('superseding navigation and redirects cannot reuse old completion or failures', () => {
  const load = new BrowserDocumentLoad();
  load.start(url);
  load.commit(url);
  load.start(`${url}/next`);
  load.fail(url, -3);
  load.finish(url);
  load.redirect(`${url}/final`);
  load.commit(`${url}/final`);
  load.finish(`${url}/next`);
  assert.equal(load.snapshot().state, 'loading');
  load.finish(`${url}/final`);
  assert.equal(load.snapshot().state, 'completed');
  load.fail(url, -354);
  assert.equal(load.snapshot().state, 'completed');
});

test('same-document navigation preserves the outcome without creating completion', () => {
  const load = new BrowserDocumentLoad();
  load.start(url);
  load.commit(url);
  load.inPage(`${url}#pending`);
  assert.equal(load.snapshot().state, 'loading');
  load.finish(`${url}#pending`);
  const complete = load.snapshot();
  load.inPage(`${url}#complete`);
  assert.deepEqual(load.snapshot(), complete);
});
