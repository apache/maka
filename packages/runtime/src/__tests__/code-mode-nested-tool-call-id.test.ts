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
import test from 'node:test';
import {
  CODE_MODE_NESTED_TOOL_CALL_ID_MAX_CHARS,
  codeModeNestedToolCallId,
} from '../code-mode-nested-tool-call-id.js';

test('preserves fitting Code Mode nested tool-call identities exactly', () => {
  const child = 'c'.repeat(36);
  const parent = 'p'.repeat(
    CODE_MODE_NESTED_TOOL_CALL_ID_MAX_CHARS - ':nested:'.length - child.length,
  );
  assert.equal(codeModeNestedToolCallId(parent, child), `${parent}:nested:${child}`);
});

test('hashes oversized identities with framed, domain-separated tuple input', () => {
  const child = 'c'.repeat(36);
  const parent = 'p'.repeat(
    CODE_MODE_NESTED_TOOL_CALL_ID_MAX_CHARS - ':nested:'.length - child.length + 1,
  );
  const identity = codeModeNestedToolCallId(parent, child);
  assert.match(identity, /^code_nested_v1_[a-f0-9]{64}$/);
  assert.ok(identity.length <= CODE_MODE_NESTED_TOOL_CALL_ID_MAX_CHARS);
  assert.equal(codeModeNestedToolCallId(parent, child), identity);

  const prefix = 'x'.repeat(120);
  const firstParent = `${prefix}:nested:y`;
  const firstChild = 'z';
  const secondParent = prefix;
  const secondChild = 'y:nested:z';
  assert.equal(`${firstParent}:nested:${firstChild}`, `${secondParent}:nested:${secondChild}`);
  assert.notEqual(
    codeModeNestedToolCallId(firstParent, firstChild),
    codeModeNestedToolCallId(secondParent, secondChild),
  );
});

test('uses the same UTF-16 length boundary as the Host id decoder', () => {
  const child = 'child';
  const fittingParent = '😀'.repeat(
    Math.floor((CODE_MODE_NESTED_TOOL_CALL_ID_MAX_CHARS - ':nested:'.length - child.length) / 2),
  );
  assert.equal(codeModeNestedToolCallId(fittingParent, child), `${fittingParent}:nested:${child}`);
  assert.match(codeModeNestedToolCallId(`${fittingParent}😀`, child), /^code_nested_v1_/);
});
