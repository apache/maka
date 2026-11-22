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

const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === './locale')
      return {
        url:
          'data:text/javascript,' +
          encodeURIComponent(
            'export const tr = (key, args = {}) => key.replace(/\\{(\\w+)\\}/g, (_, name) => args[name]);',
          ),
        shortCircuit: true,
      };
    return next(specifier, context);
  },
});
const {
  availableSpeeds,
  speedCaption,
  sameRoute,
  selectionForChoice,
  sameBackend,
  routeKey,
  withThinkingLevel,
  thinkingLevel,
  modelCaption,
  effortCaption,
  effectiveThinkingLevel,
} = await import('../app/modelSelection.ts');
hooks.deregister();

const native = { kind: 'model', connectionId: 'local', modelId: 'shared', thinkingLevel: null };
const executor = {
  kind: 'executor',
  selection: { executor: 'external', settings: { runtime: 'codex', model: 'shared' } },
};
const choice = {
  selection: executor,
  sourceName: 'Native CLI · Codex',
  label: 'Shared',
  thinkingLevels: ['provider-custom'],
  defaultThinkingLevel: 'provider-custom',
};

test('equal model names from different sources and executor runtimes remain distinct', () => {
  const other = {
    ...executor,
    selection: { ...executor.selection, settings: { runtime: 'claude', model: 'shared' } },
  };
  assert.equal(sameRoute(native, executor), false);
  assert.equal(sameRoute(executor, other), false);
  assert.equal(new Set([native, executor, other].map(routeKey)).size, 3);
  assert.equal(sameRoute(native, { ...native, connectionId: 'other' }), false);
  assert.equal(sameRoute(executor, structuredClone(executor)), true);
  assert.equal(sameRoute(null, executor), false);
});

test('executor effort accepts provider-owned strings without losing its selection', () => {
  const selected = withThinkingLevel(executor, 'provider-custom');
  assert.deepEqual(selected, {
    kind: 'executor',
    selection: {
      executor: 'external',
      settings: {
        runtime: 'codex',
        model: 'shared',
        thinkingLevel: 'provider-custom',
      },
    },
  });
  assert.equal(thinkingLevel(executor), null);
  assert.equal(sameRoute(executor, selected), true);
  assert.equal(sameBackend(executor, selected), false);
  assert.equal(sameBackend(executor, withThinkingLevel(selected, null)), true);
  assert.equal(effectiveThinkingLevel(executor, choice), 'provider-custom');
});

test('native effort retains the native contract and rejects executor-only effort', () => {
  assert.deepEqual(withThinkingLevel(native, 'high'), { ...native, thinkingLevel: 'high' });
  assert.throws(() => withThinkingLevel(native, 'provider-custom'), /Unsupported native/);
  assert.equal(sameBackend(native, { ...native, thinkingLevel: undefined }), true);
  assert.equal(
    effectiveThinkingLevel(native, { ...choice, defaultThinkingLevel: undefined }),
    null,
  );
});

test('selection captions expose source and preserve unavailable selections', () => {
  assert.equal(modelCaption(executor, { kind: 'ready', choice }), 'Shared · Native CLI · Codex');
  assert.equal(modelCaption(executor, { kind: 'loading' }), 'shared');
  assert.equal(
    modelCaption(executor, { kind: 'unavailable', message: '' }),
    'shared · Unavailable',
  );
  assert.equal(effortCaption(executor, { kind: 'ready', choice }), 'provider-custom');
  const removedEffort = withThinkingLevel(executor, 'removed');
  assert.equal(effortCaption(removedEffort, { kind: 'ready', choice }), 'removed · Unavailable');
  assert.equal(thinkingLevel(removedEffort), 'removed');
});

test('catalog aliases preserve saved variant strength and explicit overrides without merging sources', () => {
  const base = {
    kind: 'executor',
    selection: { executor: 'external', settings: { runtime: 'antigravity', model: 'opus' } },
  };
  const legacy = {
    kind: 'executor',
    selection: { executor: 'external', settings: { runtime: 'antigravity', model: 'opus-high' } },
  };
  const grouped = {
    selection: base,
    label: 'Opus',
    sourceName: 'Native CLI · antigravity',
    thinkingLevels: ['low', 'high'],
    defaultThinkingLevel: null,
    aliases: [withThinkingLevel(legacy, 'high')],
  };
  const selected = selectionForChoice(legacy, grouped);
  assert.deepEqual(selected, withThinkingLevel(base, 'high'));
  assert.deepEqual(
    selectionForChoice(withThinkingLevel(legacy, 'low'), grouped),
    withThinkingLevel(base, 'low'),
  );
  assert.equal(effectiveThinkingLevel(legacy, grouped), 'high');
  assert.equal(effortCaption(legacy, { kind: 'ready', choice: grouped }), 'high');
  assert.equal(
    modelCaption(legacy, { kind: 'ready', choice: grouped }),
    'Opus · Native CLI · antigravity',
  );
  assert.equal(
    selectionForChoice(
      {
        ...legacy,
        selection: {
          ...legacy.selection,
          settings: { ...legacy.selection.settings, runtime: 'codex' },
        },
      },
      grouped,
    ),
    null,
  );
  assert.equal(
    selectionForChoice(
      {
        ...legacy,
        selection: {
          ...legacy.selection,
          settings: { ...legacy.selection.settings, model: 'opus-ultra' },
        },
      },
      grouped,
    ),
    null,
  );
});

test('a default-only catalog hides speed and reselecting the model clears its old tier', () => {
  const saved = { ...native, serviceTier: 'priority' };
  for (const serviceTiers of [undefined, [], [{ id: 'default', name: 'Default' }]]) {
    const model = { ...choice, selection: native, serviceTiers };
    assert.deepEqual(availableSpeeds(model), []);
    assert.equal(speedCaption(saved, { kind: 'ready', choice: model }), '');
    assert.deepEqual(selectionForChoice(saved, model), { ...native, serviceTier: null });
  }
});
