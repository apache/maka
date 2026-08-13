import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  normalizeApplyPatchReplayInput,
  resolveApplyPatchProfile,
} from '../apply-patch-profile.js';
import { resolveModelRuntime } from '../model-runtime.js';

describe('ApplyPatch profile routing', () => {
  test('derives the effective profile from the provider adapter contract', () => {
    assert.deepEqual(
      resolveModelRuntime(
        {
          providerType: 'deepseek',
          baseUrl: 'https://gateway.example/v1',
        },
        'deepseek-v4-flash',
      ).applyPatchProfile,
      { kind: 'codex-v4a-freeform' },
    );
    assert.deepEqual(
      resolveModelRuntime({ providerType: 'deepseek' }, 'deepseek-v4-pro').applyPatchProfile,
      { kind: 'codex-v4a-freeform' },
    );
    assert.equal(
      resolveModelRuntime({ providerType: 'xai' }, 'deepseek-v4-flash').applyPatchProfile,
      null,
    );
  });

  test('selects Codex V4A freeform for declared DeepSeek V4 Responses models', () => {
    assert.deepEqual(
      resolveApplyPatchProfile(
        { wire: 'openai-responses', applyPatchProtocol: 'codex-v4a-freeform' },
        'deepseek-v4-flash',
      ),
      { kind: 'codex-v4a-freeform' },
    );
    assert.equal(
      resolveApplyPatchProfile(
        { wire: 'openai-chat', applyPatchProtocol: 'codex-v4a-freeform' },
        'deepseek-v4-flash',
      ),
      null,
    );
    assert.deepEqual(
      resolveApplyPatchProfile(
        { wire: 'openai-responses', applyPatchProtocol: 'codex-v4a-freeform' },
        'deepseek-v4-pro',
      ),
      { kind: 'codex-v4a-freeform' },
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
    assert.equal(
      normalizeApplyPatchReplayInput({ kind: 'codex-v4a-freeform' }, 'call-1', {
        callId: 'call-1',
        operation: { type: 'delete_file', path: 'old.txt' },
      }),
      '*** Begin Patch\n*** Delete File: old.txt\n*** End Patch',
    );
  });
});
