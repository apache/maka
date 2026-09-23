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
  test('routes supported Codex and DeepSeek models through their supported tool transports', () => {
    assert.deepEqual(
      resolveModelRuntime({ providerType: 'openai-codex' }, 'gpt-6-astra').applyPatchProfile,
      { kind: 'codex-v4a-freeform' },
    );
    assert.deepEqual(
      resolveModelRuntime({ providerType: 'deepseek' }, 'deepseek-v4-flash').applyPatchProfile,
      { kind: 'portable-v4a' },
    );
    assert.equal(resolveModelRuntime({ providerType: 'xai' }, 'unknown').applyPatchProfile, null);
    assert.equal(
      resolveModelRuntime({ providerType: 'openai-codex' }, 'unknown').applyPatchProfile,
      null,
    );
    assert.equal(
      resolveModelRuntime({ providerType: 'deepseek' }, 'unknown').applyPatchProfile,
      null,
    );
    assert.deepEqual(
      resolveModelRuntime({ providerType: 'openai-compatible' }, 'gpt-5.6-luna').applyPatchProfile,
      { kind: 'portable-v4a' },
    );
  });

  test('overrides are per model and work for future models without a name whitelist', () => {
    const connection = {
      providerType: 'openai-codex' as const,
      modelOverrides: { disabled: { applyPatch: false }, future: { applyPatch: true } },
    };
    assert.equal(resolveModelRuntime(connection, 'disabled').applyPatchProfile, null);
    assert.deepEqual(resolveModelRuntime(connection, 'future').applyPatchProfile, {
      kind: 'codex-v4a-freeform',
    });
    assert.deepEqual(
      resolveModelRuntime(
        { providerType: 'anthropic', modelOverrides: { future: { applyPatch: true } } },
        'future',
      ).applyPatchProfile,
      { kind: 'portable-v4a' },
    );
    assert.equal(
      resolveModelRuntime(
        { providerType: 'anthropic', modelOverrides: { future: { applyPatch: true } } },
        'other',
      ).applyPatchProfile,
      null,
    );
  });

  test('explicit enablement uses ordinary functions on relays and explicit disablement wins on OpenAI', () => {
    assert.deepEqual(
      resolveModelRuntime(
        {
          providerType: 'openai-responses-compatible',
          modelOverrides: { future: { applyPatch: true } },
        },
        'future',
      ).applyPatchProfile,
      { kind: 'portable-v4a' },
    );
    assert.equal(
      resolveModelRuntime(
        { providerType: 'openai', modelOverrides: { 'gpt-5.4': { applyPatch: false } } },
        'gpt-5.4',
      ).applyPatchProfile,
      null,
    );
    assert.equal(
      resolveModelRuntime(
        {
          providerType: 'deepseek',
          modelOverrides: { 'deepseek-v4-flash': { applyPatch: false } },
        },
        'deepseek-v4-flash',
      ).applyPatchProfile,
      null,
    );
  });

  test('projects the editing surface and the matching input schema', () => {
    const tool = (name: string, providerTool?: MakaTool['providerTool']): MakaTool => ({
      name,
      description: name,
      parameters: {},
      providerTool,
      impl: async () => undefined,
    });
    const tools = [
      tool('Read'),
      tool('Write'),
      tool('Edit'),
      tool('apply_patch', { kind: 'openai-apply-patch' }),
    ];
    assert.deepEqual(
      routeApplyPatchTools(tools, null).map((t) => t.name),
      ['Read', 'Write', 'Edit'],
    );
    const portable = routeApplyPatchTools(tools, { kind: 'portable-v4a' });
    assert.deepEqual(
      portable.map((t) => t.name),
      ['Read', 'apply_patch'],
    );
    assert.equal(portable[1]?.providerTool, undefined);
    const custom = routeApplyPatchTools(tools, { kind: 'codex-v4a-freeform' });
    assert.equal(custom[1]?.providerTool?.kind, 'codex-apply-patch');
    assert.equal(tools[3]?.providerTool?.kind, 'openai-apply-patch');
  });

  test('preserves multi-file history in custom and portable forms', () => {
    const patch = '*** Begin Patch\n*** Delete File: a.txt\n*** Delete File: b.txt\n*** End Patch';
    const portable = { patch };
    assert.equal(
      normalizeApplyPatchReplayInput({ kind: 'codex-v4a-freeform' }, 'c', portable),
      patch,
    );
    assert.deepEqual(
      normalizeApplyPatchReplayInput({ kind: 'portable-v4a' }, 'c', patch),
      portable,
    );
    assert.equal(normalizeApplyPatchReplayInput({ kind: 'portable-v4a' }, 'c', portable), portable);
    assert.equal(
      normalizeApplyPatchReplayInput({ kind: 'openai-structured' }, 'c', portable),
      null,
    );
    assert.equal(normalizeApplyPatchReplayInput(null, 'c', portable), null);
    assert.equal(
      normalizeApplyPatchReplayInput({ kind: 'codex-v4a-freeform' }, 'c', {
        operation: { type: 'delete_file', path: 'old.txt' },
      }),
      '*** Begin Patch\n*** Delete File: old.txt\n*** End Patch',
    );
  });

  test('preserves structured routing for documented native OpenAI models', () => {
    assert.deepEqual(
      resolveApplyPatchProfile(
        { wire: 'openai-responses', applyPatchProtocol: 'openai-structured' },
        'gpt-5.6',
      ),
      { kind: 'openai-structured' },
    );
    assert.deepEqual(
      resolveApplyPatchProfile(
        { wire: 'openai-chat', applyPatchProtocol: 'openai-structured' },
        'gpt-5.6',
      ),
      { kind: 'portable-v4a' },
    );
    assert.equal(
      resolveApplyPatchProfile(
        { wire: 'openai-responses', applyPatchProtocol: 'openai-structured' },
        'gpt-5.5-pro',
      ),
      null,
    );
    assert.deepEqual(resolveApplyPatchProfile({ wire: 'openai-responses' }, 'gpt-5.6'), {
      kind: 'portable-v4a',
    });
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
