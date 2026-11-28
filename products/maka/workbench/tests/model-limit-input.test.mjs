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
import { registerHooks } from 'node:module';
import test from 'node:test';

const appRoot = new URL('../app/', import.meta.url);
const {
  effectiveInputCapacity,
  findModelLimitConflicts,
  isShorthandTokenInput,
  parseModelLimitStates,
  parseTokenCountInput,
  suggestedCompactionThreshold,
} = await import(new URL('modelLimitInput.ts', appRoot));

const native = {
  nsh: `export const signal = initial => { let value = initial; const read = () => value; read.set = next => { value = next; }; return read; }; export const computed = fn => fn; export const cleanup = () => {}; export const batch = fn => fn(); export const effect = fn => fn(); export const untracked = fn => fn(); export const Clipboard = { setString: async () => {} }; export const openUrl = async () => {};`,
  locale: `export const tr = (key, values) => values ? key.replace(/\\{(\\w+)\\}/g, (_, name) => values[name]) : key; export const currentLocale = () => 'en'; export const applyLanguagePreference = () => {}; export const localizedPresentation = (presentation) => presentation;`,
};
const hooks = registerHooks({
  resolve(specifier, context, next) {
    let key = specifier;
    if (context.parentURL?.startsWith(appRoot.href) && specifier === './locale') key = 'locale';
    if (key in native)
      return { url: `data:text/javascript,${encodeURIComponent(native[key])}`, shortCircuit: true };
    if (
      specifier.endsWith('.js') &&
      (specifier.includes('/packages/plugin-sdk/src/') ||
        context.parentURL?.includes('/packages/plugin-sdk/src/'))
    )
      return next(`${specifier.slice(0, -3)}.ts`, context);
    if (
      context.parentURL?.startsWith(appRoot.href) &&
      specifier.startsWith('.') &&
      !/\.\w+$/.test(specifier)
    )
      return next(`${specifier}.ts`, context);
    return next(specifier, context);
  },
});
const { createSettingsOperations } = await import(new URL('settingsOperations.ts', appRoot));
const { createModelSettings } = await import(new URL('settings.ts', appRoot));
hooks.deregister();

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

test('parseTokenCountInput accepts plain integers, grouped integers, and decimal k/M shorthands', () => {
  assert.equal(parseTokenCountInput('128000'), 128000);
  assert.equal(parseTokenCountInput('  128000  '), 128000);
  assert.equal(parseTokenCountInput('128,000'), 128000);
  assert.equal(parseTokenCountInput('1,048,576'), 1048576);
  assert.equal(parseTokenCountInput('128_000'), 128000);
  assert.equal(parseTokenCountInput('1_048_576'), 1048576);
  assert.equal(parseTokenCountInput('128k'), 128000);
  assert.equal(parseTokenCountInput('200K'), 200000);
  assert.equal(parseTokenCountInput('0.5k'), 500);
  assert.equal(parseTokenCountInput('1.001k'), 1001);
  assert.equal(parseTokenCountInput('1M'), 1000000);
  assert.equal(parseTokenCountInput('1.5M'), 1500000);
  assert.equal(parseTokenCountInput('1.25m'), 1250000);
  assert.equal(parseTokenCountInput('128.0'), 128);
  assert.equal(parseTokenCountInput(String(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER);
});

test('parseTokenCountInput rejects zero, negatives, non-integers, malformed grouping, and unsafe integers', () => {
  for (const invalid of [
    '',
    '   ',
    '0',
    '0k',
    '0.0M',
    '-128k',
    '+128k',
    'NaN',
    'Infinity',
    '1.5',
    '1.0001k',
    '1.0000001M',
    '.5k',
    '128.',
    '128 k',
    '128g',
    '1,5',
    '1,5M',
    '128,00',
    ',128',
    '128,',
    '128,,000',
    '_128',
    '128_',
    '128__000',
    '128,000_000',
    String(Number.MAX_SAFE_INTEGER + 1),
    '9007199255M',
  ]) {
    assert.equal(
      parseTokenCountInput(invalid),
      null,
      `expected null for ${JSON.stringify(invalid)}`,
    );
  }
});

test('isShorthandTokenInput distinguishes shorthand/grouped values from plain digits', () => {
  assert.equal(isShorthandTokenInput('200k'), true);
  assert.equal(isShorthandTokenInput('1.5M'), true);
  assert.equal(isShorthandTokenInput('128,000'), true);
  assert.equal(isShorthandTokenInput('128_000'), true);
  assert.equal(isShorthandTokenInput('128000'), false);
  assert.equal(isShorthandTokenInput(''), false);
  assert.equal(isShorthandTokenInput('invalid'), false);
});

test('limit conflict detection and 90% compaction suggestion combine typed overrides with defaults', () => {
  const emptyLimits = {
    contextWindow: '',
    inputLimit: '',
    maxOutputTokens: '',
    compactionThreshold: '',
  };

  // Explicit inputLimit > explicit contextWindow
  assert.deepEqual(
    findModelLimitConflicts(
      parseModelLimitStates({ ...emptyLimits, contextWindow: '128k', inputLimit: '200k' }),
      null,
    ),
    { inputLimit: 'exceeds_context_window' },
  );

  // Explicit inputLimit > default contextWindow
  assert.deepEqual(
    findModelLimitConflicts(parseModelLimitStates({ ...emptyLimits, inputLimit: '200k' }), {
      contextWindow: 128000,
      inputLimit: 128000,
    }),
    { inputLimit: 'exceeds_context_window' },
  );

  // Lowering contextWindow while inputLimit stays blank must not falsely conflict with inherited default inputLimit
  const lowered = parseModelLimitStates({ ...emptyLimits, contextWindow: '64k' });
  assert.deepEqual(
    findModelLimitConflicts(lowered, { contextWindow: 128000, inputLimit: 128000 }),
    {},
  );
  assert.equal(
    effectiveInputCapacity(lowered, { contextWindow: 128000, inputLimit: 128000 }),
    64000,
  );

  // Raising contextWindow while inputLimit stays blank uses raised capacity when default inputLimit mirrored contextWindow
  const raised = parseModelLimitStates({ ...emptyLimits, contextWindow: '200k' });
  assert.equal(
    effectiveInputCapacity(raised, { contextWindow: 128000, inputLimit: 128000 }),
    200000,
  );
  assert.equal(
    suggestedCompactionThreshold(raised, { contextWindow: 128000, inputLimit: 128000 }),
    180000,
  );

  // Distinct tighter default inputLimit still bounds capacity when contextWindow is overridden
  assert.equal(
    effectiveInputCapacity(raised, { contextWindow: 200000, inputLimit: 100000 }),
    100000,
  );

  // Compaction threshold exceeding min(contextWindow, inputLimit)
  assert.deepEqual(
    findModelLimitConflicts(
      parseModelLimitStates({
        ...emptyLimits,
        contextWindow: '200k',
        inputLimit: '180k',
        compactionThreshold: '190k',
      }),
      null,
    ),
    { compactionThreshold: 'exceeds_capacity' },
  );

  // Compaction threshold exceeding inherited defaults capacity when both capacity inputs are blank
  assert.deepEqual(
    findModelLimitConflicts(
      parseModelLimitStates({
        ...emptyLimits,
        compactionThreshold: '150k',
      }),
      { contextWindow: 128000, inputLimit: 128000 },
    ),
    { compactionThreshold: 'exceeds_capacity' },
  );

  // Invalid contextWindow does not spuriously compare inputLimit against stale default contextWindow
  assert.deepEqual(
    findModelLimitConflicts(
      parseModelLimitStates({ ...emptyLimits, contextWindow: 'abc', inputLimit: '200k' }),
      { contextWindow: 128000, inputLimit: 128000 },
    ),
    {},
  );

  // Suggested 90% threshold
  assert.equal(
    suggestedCompactionThreshold(
      parseModelLimitStates({ ...emptyLimits, contextWindow: '200k', inputLimit: '180k' }),
      null,
    ),
    162000,
  );
  assert.equal(
    suggestedCompactionThreshold(
      parseModelLimitStates({ ...emptyLimits, contextWindow: '1' }),
      null,
    ),
    1,
  );
  assert.equal(suggestedCompactionThreshold(parseModelLimitStates(emptyLimits), null), null);
});

test('createModelSettings validates duplicate IDs, limit conflicts, and saves shorthand tokens as integers', async () => {
  const savedMutations = [];
  const resolvedModels = [];
  const provider = {
    entryId: 'maka.openai',
    name: 'openai',
    packageId: 'maka.openai',
    scope: 'profile',
  };
  let revision = 1;
  let editing = {
    discoveredModelIds: ['gpt-4.1', 'discovered-disabled'],
    enabledModelIds: ['gpt-4.1'],
    modelOverrides: { 'manual-disabled': { displayName: 'Manual Disabled' } },
    requestBodyOverlay: null,
  };
  const detail = () => ({
    kind: 'ready',
    name: 'OpenAI',
    enabled: true,
    target: {
      connectionId: 'openai',
      revision,
      slug: 'openai',
      provider,
      configuration: { baseUrl: 'https://api.openai.com/v1' },
    },
    editing,
  });
  const host = {
    pendingSettings: async () => [],
    async settingsMutation(endpoint, method, input) {
      savedMutations.push({ endpoint, method, input });
      revision += 1;
      editing = {
        ...editing,
        ...(input.changes.enabledModelIds
          ? { enabledModelIds: input.changes.enabledModelIds }
          : {}),
        ...(input.changes.modelOverrides ? { modelOverrides: input.changes.modelOverrides } : {}),
      };
      return {
        operationId: `op-${revision}`,
        reply: {
          receipt: {
            kind: 'recorded',
            outcome: {
              kind: 'returned',
              result: {
                kind: 'success',
                value: { kind: 'committed', connection: { connectionId: 'openai', revision } },
              },
            },
          },
        },
      };
    },
    async query(_endpoint, method, input) {
      if (method === 'connections')
        return {
          kind: 'page',
          revision: 1,
          next: null,
          defaultTarget: null,
          connections: [
            {
              basis: { connectionId: 'openai', revision },
              name: 'OpenAI',
              slug: 'openai',
              provider,
              enabled: true,
              enabledModelCount: editing.enabledModelIds.length,
              editable: true,
            },
          ],
        };
      if (method === 'models')
        return { kind: 'ready', revision: 1, next: null, choices: [], defaultModel: null };
      if (method === 'provider')
        return {
          identity: provider,
          descriptor: {
            label: 'OpenAI',
            anonymous: false,
            customEndpoint: true,
            discovery: true,
            configurationDefaults: { baseUrl: 'https://api.openai.com/v1' },
            authentication: [{ id: 'api-key', interactive: false, label: 'API key' }],
          },
        };
      if (method === 'connection') return detail();
      if (method === 'credentialStatus')
        return {
          kind: 'status',
          status: {
            locator: { scope: 'connection', connectionId: 'openai', kind: 'provider' },
            configured: true,
            credentialId: 'cred-1',
            revision: 1,
            updatedAt: null,
          },
        };
      if (method === 'resolveModel') {
        resolvedModels.push(input.modelId);
        const known = input.modelId === 'gpt-4.1';
        const contextWindow = input.overrides?.contextWindow ?? (known ? 128000 : null);
        const inputLimit = input.overrides?.inputLimit ?? contextWindow;
        const effectiveInput =
          contextWindow != null && inputLimit != null
            ? Math.min(contextWindow, inputLimit)
            : (contextWindow ?? inputLimit);
        const compactionThreshold =
          effectiveInput != null ? Math.max(1, Math.floor(effectiveInput * 0.85)) : null;
        return {
          kind: 'ready',
          defaults: known
            ? {
                label: 'GPT-4.1',
                contextWindow: 128000,
                inputLimit: contextWindow ?? 128000,
                maxOutputTokens: 16384,
                compactionThreshold,
                thinkingLevels: ['off', 'medium', 'high'],
                defaultThinkingLevel: 'medium',
                codeMode: true,
                applyPatch: true,
                catalogMatched: true,
              }
            : {
                label: input.modelId,
                contextWindow: null,
                inputLimit: contextWindow,
                maxOutputTokens: 8000,
                compactionThreshold,
                thinkingLevels: [],
                defaultThinkingLevel: null,
                codeMode: true,
                applyPatch: false,
                catalogMatched: false,
              },
          choice: {
            selection: { connectionId: 'openai', modelId: input.modelId },
            thinkingLevels: [],
            defaultThinkingLevel: null,
            limits: null,
          },
        };
      }
      throw new Error(`Unexpected query ${method}`);
    },
  };
  const operations = createSettingsOperations(host);
  operations.pendingKnown.set(true);
  const owner = createModelSettings(host, operations, () => true);
  await settled();
  await owner.openConnection({ connectionId: 'openai', revision: 1 });
  await settled();

  // Adding a new model flags duplicates across enabled, discovered-disabled, and manual-disabled models
  // (including surrounding whitespace), skips resolveModel IPC on duplicates, and preserves case sensitivity.
  owner.editModel({ ...owner.action(), id: null });
  for (const duplicate of ['gpt-4.1', '  gpt-4.1  ', 'discovered-disabled', 'manual-disabled']) {
    owner.changeModel({ id: duplicate });
    assert.equal(owner.modelProblems().id?.key, 'This model already exists on this connection.');
    assert.ok(owner.modelProblem());
  }
  await settled();
  assert.deepEqual(resolvedModels, []);
  owner.changeModel({ id: 'GPT-4.1' });
  assert.equal(owner.modelProblems().id, undefined);

  // Unique ID clears duplicate error; typing shorthand + conflict flags inputLimit
  owner.changeModel({ id: 'custom-v1' });
  await settled();
  assert.equal(owner.modelProblems().id, undefined);
  owner.changeModel({
    limits: {
      contextWindow: '200k',
      inputLimit: '250k',
      maxOutputTokens: '16k',
      compactionThreshold: '',
    },
  });
  assert.equal(owner.modelProblems().inputLimit?.key, 'Input limit cannot exceed context window.');

  // Direct saveModel call is also blocked while a conflict exists
  await owner.saveModel(owner.modelAction());
  assert.equal(savedMutations.length, 0);

  // Fixing inputLimit and adding shorthand compactionThreshold saves exact integer tokens
  owner.changeModel({
    limits: {
      contextWindow: '1.5M',
      inputLimit: '200k',
      maxOutputTokens: '16,384',
      compactionThreshold: '180_000',
    },
  });
  assert.deepEqual(owner.modelProblems(), {});
  await owner.saveModel(owner.modelAction());
  assert.equal(savedMutations.length, 1);
  assert.deepEqual(savedMutations[0].input.changes.modelOverrides['custom-v1'], {
    contextWindow: 1500000,
    inputLimit: 200000,
    maxOutputTokens: 16384,
    compactionThreshold: 180000,
  });
  assert.ok(savedMutations[0].input.changes.enabledModelIds.includes('custom-v1'));

  // Editing an existing model whose compactionThreshold is blank stays clean and never injects a threshold on save.
  owner.editModel({ ...owner.action(), id: 'gpt-4.1' });
  await settled();
  assert.equal(owner.modelProblems().id, undefined);
  assert.equal(owner.modelDirty(), false);
  owner.changeModel({ label: 'GPT-4.1 Custom' });
  await owner.saveModel(owner.modelAction());
  assert.equal(savedMutations.length, 2);
  assert.equal(
    savedMutations[1].input.changes.modelOverrides['gpt-4.1'].compactionThreshold,
    undefined,
  );

  // Typing shorthand equal to a saved numeric override stays clean (not dirty).
  owner.editModel({ ...owner.action(), id: 'custom-v1' });
  await settled();
  assert.equal(owner.modelDirty(), false);
  owner.changeModel({
    limits: {
      contextWindow: '1.5M',
      inputLimit: '200k',
      maxOutputTokens: '16,384',
      compactionThreshold: '180_000',
    },
  });
  assert.equal(owner.modelDirty(), false);

  // Editing an existing model keeps defaults intact when typing limits and detects conflicts against defaults.
  owner.editModel({ ...owner.action(), id: 'gpt-4.1' });
  await settled();
  owner.changeModel({
    limits: {
      contextWindow: '',
      inputLimit: '200k',
      maxOutputTokens: '',
      compactionThreshold: '',
    },
  });
  assert.equal(owner.modelProblems().inputLimit?.key, 'Input limit cannot exceed context window.');
});
