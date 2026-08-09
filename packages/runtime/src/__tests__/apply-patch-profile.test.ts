import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  normalizeApplyPatchReplayInput,
  resolveApplyPatchProfile,
} from '../apply-patch-profile.js';

describe('ApplyPatch profile routing', () => {
  test('selects Codex V4A freeform only for official DeepSeek V4 Flash Responses', () => {
    assert.deepEqual(
      resolveApplyPatchProfile(
        { providerType: 'deepseek', wire: 'openai-responses' },
        'deepseek-v4-flash',
      ),
      { kind: 'codex-v4a-freeform' },
    );
    assert.equal(
      resolveApplyPatchProfile(
        { providerType: 'deepseek', wire: 'openai-chat' },
        'deepseek-v4-flash',
      ),
      null,
    );
    assert.equal(
      resolveApplyPatchProfile(
        { providerType: 'deepseek', wire: 'openai-responses' },
        'deepseek-v4-pro',
      ),
      null,
    );
    assert.equal(
      resolveApplyPatchProfile(
        { providerType: 'openrouter', wire: 'openai-responses' },
        'deepseek/deepseek-v4-flash',
      ),
      null,
    );
    assert.equal(
      resolveApplyPatchProfile(
        {
          providerType: 'deepseek',
          wire: 'openai-responses',
          baseUrl: 'https://gateway.example/v1',
        },
        'deepseek-v4-flash',
      ),
      null,
    );
  });

  test('preserves structured routing for documented native OpenAI models', () => {
    assert.deepEqual(
      resolveApplyPatchProfile({ providerType: 'openai', wire: 'openai-responses' }, 'gpt-5.6'),
      { kind: 'openai-structured' },
    );
    assert.equal(
      resolveApplyPatchProfile({ providerType: 'openai', wire: 'openai-chat' }, 'gpt-5.6'),
      null,
    );
    assert.equal(
      resolveApplyPatchProfile({ providerType: 'openai', wire: 'openai-responses' }, 'gpt-5.5-pro'),
      null,
    );
    assert.equal(
      resolveApplyPatchProfile(
        {
          providerType: 'openai',
          wire: 'openai-responses',
          baseUrl: 'https://gateway.example/v1',
        },
        'gpt-5.6',
      ),
      null,
    );
  });

  test('normalizes portable history and drops an unrepresentable multi-file call', () => {
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
      normalizeApplyPatchReplayInput(
        { kind: 'openai-structured' },
        'call-1',
        [
          '*** Begin Patch',
          '*** Delete File: one.txt',
          '*** Delete File: two.txt',
          '*** End Patch',
        ].join('\n'),
      ),
      null,
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
