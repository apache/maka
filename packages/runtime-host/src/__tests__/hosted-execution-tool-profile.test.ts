import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeHostedExecutionStartInput } from '../protocol/index.js';
import { HostedExecutionToolProfileRegistry } from '../server/hosted-execution-tool-profile.js';

test('hosted execution tool profiles are explicit protocol inputs', () => {
  const decoded = decodeHostedExecutionStartInput({
    executionId: '00000000-0000-4000-8000-000000000001',
    session: {
      workspace: { kind: 'host_path', path: '/workspace' },
      modelTarget: { kind: 'explicit', connectionSlug: 'provider', model: 'model' },
    },
    content: { text: 'solve' },
    toolProfile: 'headless-coding-v1',
  });
  assert.equal(decoded.toolProfile, 'headless-coding-v1');
  assert.throws(
    () =>
      decodeHostedExecutionStartInput({
        ...decoded,
        toolProfile: 'unknown-profile',
      }),
    /Invalid Hosted execution tool profile/u,
  );
});

test('hosted execution tool profiles remain process-local and bounded to one execution', async () => {
  const registry = new HostedExecutionToolProfileRegistry();
  assert.equal(registry.toolNamesFor('execution'), undefined);
  await registry.run('execution', 'headless-coding-v1', async () => {
    assert.deepEqual(registry.toolNamesFor('execution'), [
      'Bash',
      'Read',
      'Write',
      'Edit',
      'Glob',
      'Grep',
      'apply_patch',
    ]);
  });
  assert.equal(registry.toolNamesFor('execution'), undefined);
});
