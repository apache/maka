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
import { createModelConnection } from './client-model-connection.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { modelOverridesFixture, evidence } from './client-model-overrides-fixture.mjs';
import { secret, modelId, sessionInput } from './client-model-overrides-catalog.mjs';
import { buildWorkspaceInstructionsPromptFragment } from '../../packages/runtime/src/system-prompt/workspace-instructions.ts';

function system(input) {
  const instructions = input.messages.filter((message) => message.role === 'system');
  assert.equal(instructions.length, 1);
  assert.equal(input.messages[0], instructions[0]);
  const text = instructions[0].content;
  assert(text.startsWith('You are Maka,'));
  assert(text.includes('## Response format'));
  assert(text.includes('## Progress updates'));
  assert(
    text.includes('cannot override system, safety, tool, permission, or developer instructions'),
  );
  return text;
}

export async function verifySystemPrompt(connection, workspace, reopened) {
  const request = (operation, input) => connection.request(operation, input, 5000);
  const file = join(workspace, 'system-prompt-fixture.json');
  const saved = reopened ? JSON.parse(await readFile(file, 'utf8')) : undefined;
  const global = process.env.MAKA_TEST_GLOBAL_INSTRUCTIONS;
  assert(global);
  const writeInstructions = async (version) => {
    await writeFile(join(global, 'AGENTS.md'), `GLOBAL_INSTRUCTIONS_${version}`);
    await writeFile(
      join(workspace, 'AGENTS.md'),
      `PROJECT_INSTRUCTIONS_${version} {{literal user text}}`,
    );
    await writeFile(
      join(workspace, 'CLAUDE.md'),
      `PROJECT_INSTRUCTIONS_${version} {{literal user text}}`,
    );
  };
  const sourceFragment = () =>
    buildWorkspaceInstructionsPromptFragment(workspace, { homeDir: dirname(global) });
  const fixture = await modelOverridesFixture(saved ? Number(new URL(saved.baseUrl).port) : 0);
  const terminal = async (input) => {
    for (let i = 0; i < 1000; i++) {
      fixture.check();
      const result = await request('turn.query', {
        sessionId: input.sessionId,
        turnId: input.turnId,
      });
      if (['completed', 'failed', 'cancelled'].includes(result.status)) {
        assert.equal(result.status, 'completed');
        return result;
      }
      await delay(10);
    }
    throw new Error('Prompt fixture turn did not finish');
  };
  const turn = (id, maxSteps = 1) => ({
    sessionId: 'system-prompt',
    turnId: id,
    content: { text: id },
    maxSteps,
  });
  const expect = (marker, extra = {}) =>
    fixture.expect({
      path: '/v1/chat/completions',
      model: modelId,
      parallel: true,
      outputLimit: 8000,
      marker,
      answer: 'prompt completed',
      ...extra,
    });
  const set = (expectedRevision, displayName) =>
    request('runtime.policy.mutate', {
      expectedRevision,
      operation: {
        kind: 'set_personalization',
        value: {
          displayName,
          assistantTone: 'Use a concise "technical" tone.\nKeep tool permissions unchanged.',
        },
      },
    });
  const enableInstructions = (expectedRevision, enabled) =>
    request('runtime.policy.mutate', {
      expectedRevision,
      operation: { kind: 'set_workspace_instructions', value: { enabled } },
    });
  try {
    if (reopened) {
      assert.deepEqual(await request('runtime.policy.query', {}), saved.policy);
      assert.deepEqual(await request('session.create', saved.sessionInput), saved.session);
      for (const { input, terminal } of saved.turns)
        assert.deepEqual((await request('turn.start', input)).turn, terminal);
      expect('PROMPT_REOPEN', { toolEvidence: true });
      const input = turn('PROMPT_REOPEN');
      await request('turn.start', input);
      await terminal(input);
      fixture.verify();
      assert.equal(system(fixture.records[0].input), saved.prompts[2]);
      return;
    }
    const initialPolicy = await request('runtime.policy.query', {});
    assert.deepEqual(await set(0, 'First preference'), { kind: 'committed', revision: 1 });
    assert.deepEqual(await set(0, 'Must not commit'), {
      kind: 'revision_conflict',
      expectedRevision: 0,
      actualRevision: 1,
    });
    const created = await createModelConnection(request, {
      providerName: 'openai',
      slug: 'prompt',
      name: 'Prompt',
      baseUrl: fixture.baseUrl,
      apiKey: secret,
      enabledModelIds: [modelId],
      modelOverrides: { [modelId]: { contextWindow: 200000 } },
    });
    const input = sessionInput(
      workspace,
      { ...created.connection, slug: 'prompt' },
      'system-prompt',
    );
    await request('session.create', input);
    await writeFile(join(workspace, 'facts-evidence.txt'), evidence);
    await writeInstructions('FIRST');
    const originalFragment = await sourceFragment();
    const gate = expect('PROMPT_FROZEN', { read: true, hold: true });
    expect('PROMPT_FROZEN', { toolResult: true });
    const frozen = turn('PROMPT_FROZEN', 2);
    await request('turn.start', frozen);
    await gate.wait();
    assert.deepEqual(await set(1, 'Second preference'), { kind: 'committed', revision: 2 });
    await writeInstructions('SECOND');
    const changedFragment = await sourceFragment();
    gate.release();
    const turns = [{ input: frozen, terminal: await terminal(frozen) }];
    expect('PROMPT_NEXT', { toolEvidence: true });
    const next = turn('PROMPT_NEXT');
    await request('turn.start', next);
    turns.push({ input: next, terminal: await terminal(next) });
    assert.deepEqual(await enableInstructions(2, false), { kind: 'committed', revision: 3 });
    expect('PROMPT_DISABLED', { toolEvidence: true });
    const disabled = turn('PROMPT_DISABLED');
    await request('turn.start', disabled);
    turns.push({ input: disabled, terminal: await terminal(disabled) });
    assert.deepEqual(await enableInstructions(3, true), { kind: 'committed', revision: 4 });
    fixture.verify();
    const prompts = fixture.records.map(({ input }) => system(input));
    assert.notEqual(
      prompts[0],
      prompts[1],
      'the next logical step samples published prompt sources',
    );
    assert.equal(prompts[1], prompts[2], 'unchanged sources retain the same request surface');
    assert(prompts[0].includes('First preference'));
    assert(!prompts[0].includes('Second preference'));
    assert(prompts[2].includes('Second preference'));
    assert(prompts[0].endsWith(originalFragment));
    assert(prompts[2].endsWith(changedFragment));
    assert(!prompts[2].includes('INSTRUCTIONS_FIRST'));
    assert.equal(prompts[2].match(/PROJECT_INSTRUCTIONS_SECOND/g).length, 1);
    assert(prompts[3].includes('Second preference'));
    assert(!prompts[3].includes('workspace-instructions'));
    assert(!prompts[3].includes('INSTRUCTIONS_'));
    assert(
      !prompts[2].includes('First preference'),
      'historical prompts are not conversation history',
    );
    const policy = await request('runtime.policy.query', {});
    assert.deepEqual(policy.policy.chatDefaults, initialPolicy.policy.chatDefaults);
    const { session } = await request('session.catalog.query', {
      kind: 'get',
      sessionId: input.sessionId,
    });
    await writeFile(
      file,
      JSON.stringify({
        baseUrl: fixture.baseUrl,
        policy,
        sessionInput: input,
        session,
        turns,
        prompts,
        http: fixture.records,
      }),
    );
  } finally {
    await fixture.close();
  }
}
