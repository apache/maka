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
import { describe, test } from 'node:test';
import {
  normalizeApplyPatchReplayInput,
  resolveApplyPatchProfile,
  routeApplyPatchTools,
} from '../apply-patch-profile.js';
import type { MakaTool } from '../tool-runtime.js';
import { resolveModelRuntime } from '../model-runtime.js';

describe('ApplyPatch profile routing', () => {
  test('derives the effective profile from the provider adapter contract', () => {
    assert.equal(
      resolveModelRuntime(
        {
          providerType: 'deepseek',
          baseUrl: 'https://gateway.example/v1',
        },
        'deepseek-v4-flash',
      ).applyPatchProfile,
      null,
    );
    assert.equal(
      resolveModelRuntime({ providerType: 'deepseek' }, 'deepseek-v4-pro').applyPatchProfile,
      null,
    );
    assert.equal(
      resolveModelRuntime({ providerType: 'xai' }, 'deepseek-v4-flash').applyPatchProfile,
      null,
    );
  });

  test('keeps portable Write/Edit when DeepSeek cannot carry custom ApplyPatch', () => {
    const tool = (name: string, providerTool?: MakaTool['providerTool']): MakaTool => ({
      name,
      description: name,
      parameters: {},
      providerTool,
      impl: async () => undefined,
    });
    const routed = routeApplyPatchTools(
      [tool('Write'), tool('Edit'), tool('apply_patch', { kind: 'openai-apply-patch' })],
      resolveModelRuntime({ providerType: 'deepseek' }, 'deepseek-v4-flash').applyPatchProfile,
    );

    assert.deepEqual(
      routed.map(({ name }) => name),
      ['Write', 'Edit'],
    );
  });

  test('does not expose the dormant Codex V4A freeform target path', () => {
    assert.equal(
      resolveApplyPatchProfile(
        {
          wire: 'openai-responses',
          applyPatchProtocol: 'codex-v4a-freeform',
        },
        'deepseek-v4-flash',
      ),
      null,
    );
    assert.equal(
      resolveApplyPatchProfile(
        { wire: 'openai-chat', applyPatchProtocol: 'codex-v4a-freeform' },
        'deepseek-v4-flash',
      ),
      null,
    );
    assert.equal(
      resolveApplyPatchProfile(
        {
          wire: 'openai-responses',
          applyPatchProtocol: 'codex-v4a-freeform',
        },
        'deepseek-v4-pro',
      ),
      null,
    );
    assert.equal(resolveApplyPatchProfile({ wire: 'openai-responses' }, 'deepseek-v4-flash'), null);
  });

  test('preserves structured routing for documented native OpenAI models', () => {
    assert.deepEqual(
      resolveApplyPatchProfile(
        { wire: 'openai-responses', applyPatchProtocol: 'openai-structured' },
        'gpt-5.6',
      ),
      { kind: 'openai-structured' },
    );
    assert.equal(
      resolveApplyPatchProfile(
        { wire: 'openai-chat', applyPatchProtocol: 'openai-structured' },
        'gpt-5.6',
      ),
      null,
    );
    assert.equal(
      resolveApplyPatchProfile(
        { wire: 'openai-responses', applyPatchProtocol: 'openai-structured' },
        'gpt-5.5-pro',
      ),
      null,
    );
    assert.equal(resolveApplyPatchProfile({ wire: 'openai-responses' }, 'gpt-5.6'), null);
  });

  test('normalizes portable single-operation history', () => {
    assert.equal(
      normalizeApplyPatchReplayInput(
        null,
        'call-1',
        '*** Begin Patch\n*** Delete File: old.txt\n*** End Patch',
      ),
      null,
    );
    assert.deepEqual(
      normalizeApplyPatchReplayInput(
        { kind: 'openai-structured' },
        'call-1',
        '*** Begin Patch\n*** Delete File: old.txt\n*** End Patch',
      ),
      {
        callId: 'call-1',
        operation: { type: 'delete_file', path: 'old.txt' },
      },
    );
  });
});
