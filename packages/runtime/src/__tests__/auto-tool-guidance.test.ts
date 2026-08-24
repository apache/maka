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
import { resolveAutoToolGuidance } from '../system-prompt/auto-tool-guidance.js';

test('guides an Auto session with a usable Bash tool', () => {
  const guidance = resolveAutoToolGuidance({
    permissionMode: 'ask',
    toolNames: ['Bash', 'Read', 'Edit'],
  });
  const repeated = resolveAutoToolGuidance({
    permissionMode: 'ask',
    toolNames: ['Bash', 'Read', 'Edit'],
  });

  assert.ok(guidance);
  assert.equal(repeated, guidance);
  assert.match(guidance, /Auto-mode tool guidance/u);
  assert.match(guidance, /batching, pipelines, transformations/u);
  assert.match(guidance, /Read/u);
  assert.match(guidance, /Edit/u);
  assert.match(guidance, /not a permission bypass/u);
});

test('does not guide a non-Auto or Bash-free session', () => {
  for (const permissionMode of ['explore', 'bypass'] as const) {
    assert.equal(
      resolveAutoToolGuidance({ permissionMode, toolNames: ['Bash', 'Read', 'Edit'] }),
      undefined,
    );
  }
  assert.equal(
    resolveAutoToolGuidance({ permissionMode: 'ask', toolNames: ['Read', 'Edit'] }),
    undefined,
  );
});

test('does not guide restricted or unavailable tool surfaces', () => {
  const base = { permissionMode: 'ask' as const, toolNames: ['Bash', 'Read'] };
  assert.equal(resolveAutoToolGuidance({ ...base, shellAvailable: false }), undefined);
  assert.equal(resolveAutoToolGuidance({ ...base, restrictedToolSurface: true }), undefined);
  assert.equal(resolveAutoToolGuidance({ ...base, sideConversation: true }), undefined);
  assert.equal(resolveAutoToolGuidance({ ...base, toolProfile: 'headless-coding-v1' }), undefined);
});

test('advertises only structured tools that are actually exposed', () => {
  const guidance = resolveAutoToolGuidance({
    permissionMode: 'ask',
    toolNames: ['Bash'],
  });

  assert.ok(guidance);
  assert.match(guidance, /Bash/u);
  assert.doesNotMatch(guidance, /Read, Glob, and Grep/u);
  assert.doesNotMatch(guidance, /Edit, Write, or apply_patch/u);
});
