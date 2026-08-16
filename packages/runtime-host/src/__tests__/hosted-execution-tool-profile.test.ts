import assert from 'node:assert/strict';
import test from 'node:test';
import type { MakaTool } from '@maka/runtime/tool-runtime';
import { z } from 'zod';
import { decodeHostedExecutionStartInput } from '../protocol/index.js';
import {
  hostedExecutionRunProfile,
  projectHostedExecutionTools,
} from '../server/hosted-execution-tool-profile.js';

test('hosted execution tool profiles are durable Session creation inputs', () => {
  const decoded = decodeHostedExecutionStartInput({
    executionId: '00000000-0000-4000-8000-000000000001',
    session: {
      workspace: { kind: 'host_path', path: '/workspace' },
      modelTarget: { kind: 'explicit', connectionSlug: 'provider', model: 'model' },
      toolProfile: 'headless-coding-v1',
    },
    content: { text: 'solve' },
  });
  assert.equal(decoded.session.toolProfile, 'headless-coding-v1');
  assert.throws(
    () =>
      decodeHostedExecutionStartInput({
        ...decoded,
        session: { ...decoded.session, toolProfile: 'unknown-profile' },
      }),
    /Invalid Session tool profile/u,
  );
});

test('the headless coding profile freezes prompt, tools, memory, and foreground Bash', async () => {
  const profile = hostedExecutionRunProfile('headless-coding-v1');
  assert.ok(profile);
  assert.deepEqual(profile.toolNames, [
    'Bash',
    'Read',
    'Write',
    'Edit',
    'Glob',
    'Grep',
    'apply_patch',
  ]);
  assert.equal(profile.memoryExtraction, false);
  assert.equal(
    profile.systemPrompt,
    [
      'Complete the task by acting with the available tools, not by narrating.',
      'Prefer Read, Glob, and Grep for inspection, Edit and Write for file changes, and Bash for shell commands and tests.',
      'Verify the result when practical.',
      'Stop when the task is complete.',
    ].join('\n'),
  );

  const original: MakaTool = {
    name: 'Bash',
    description: 'Product Bash',
    parameters: z.object({
      command: z.string(),
      run_in_background: z.boolean().optional(),
      pty: z.boolean().optional(),
    }),
    impl: async () => 'ok',
  };
  const [bash] = projectHostedExecutionTools([original], 'headless-coding-v1');
  assert.ok(bash);
  const schema = bash.parameters as z.ZodType;
  assert.equal((await schema.safeParseAsync({ command: 'true' })).success, true);
  assert.equal(
    (await schema.safeParseAsync({ command: 'true', run_in_background: true })).success,
    false,
  );
  assert.equal((await schema.safeParseAsync({ command: 'true', pty: true })).success, false);
});
