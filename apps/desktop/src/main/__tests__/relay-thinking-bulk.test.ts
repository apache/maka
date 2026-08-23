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
import {
  applyBulkThinkingLevel,
  bulkThinkingLevelStates,
  relayProfileWithThinkingLevels,
} from '../../renderer/settings/relay-thinking-bulk.js';
import { DECLARABLE_RELAY_THINKING_LEVELS } from '@maka/core/model-thinking';
import type { RelayModelProfile } from '@maka/core/model-thinking';

const MODELS = ['alpha', 'beta', 'gamma'];

test('a level nobody declares reads as absent, and one everybody declares ticks the box', () => {
  const draft: Record<string, RelayModelProfile> = {
    alpha: { thinkingLevels: ['high'] },
    beta: { thinkingLevels: ['high'] },
    gamma: { thinkingLevels: ['high'] },
  };
  const states = bulkThinkingLevelStates(MODELS, draft, ['high', 'low']);
  assert.deepEqual(states[0], { level: 'high', declaredCount: 3, total: 3, checked: true });
  assert.deepEqual(states[1], { level: 'low', declaredCount: 0, total: 3, checked: false });
});

test('partial coverage does not tick the box — only the count separates it from none', () => {
  // The box is the affordance for "give this to everyone". Ticking at
  // partial coverage would make the next click take the level AWAY from the
  // rows that have it, which is the opposite of what the user just asked for.
  const draft: Record<string, RelayModelProfile> = {
    alpha: { thinkingLevels: ['high'] },
    beta: { thinkingLevels: ['high'] },
  };
  const [state] = bulkThinkingLevelStates(MODELS, draft, ['high']);
  assert.equal(state?.checked, false);
  assert.equal(state?.declaredCount, 2);
  assert.equal(state?.total, 3);
});

test('a repeated model id is one model, not two', () => {
  const draft: Record<string, RelayModelProfile> = { alpha: { thinkingLevels: ['high'] } };
  const [state] = bulkThinkingLevelStates(['alpha', 'alpha'], draft, ['high']);
  assert.deepEqual(state, { level: 'high', declaredCount: 1, total: 1, checked: true });
});

test('an empty selection ticks nothing rather than reading as fully covered', () => {
  // 0 === 0 is the trap: `declaredCount === total` is true of an empty
  // selection, which would present every level as declared everywhere.
  for (const state of bulkThinkingLevelStates([], {}, DECLARABLE_RELAY_THINKING_LEVELS)) {
    assert.equal(state.checked, false);
    assert.equal(state.total, 0);
  }
});

test('ticking a level adds it to every model, including ones with no entry yet', () => {
  const next = applyBulkThinkingLevel(MODELS, { alpha: { vision: true } }, 'high', true);
  assert.deepEqual(next, {
    alpha: { vision: true, thinkingLevels: ['high'] },
    beta: { thinkingLevels: ['high'] },
    gamma: { thinkingLevels: ['high'] },
  });
});

test('a bulk add leaves the levels a model already declared alone', () => {
  const next = applyBulkThinkingLevel(
    MODELS,
    { alpha: { thinkingLevels: ['low', 'medium'] } },
    'high',
    true,
  );
  assert.deepEqual(next.alpha?.thinkingLevels, ['low', 'medium', 'high']);
});

test('ticking a level a model already has does not duplicate it', () => {
  const next = applyBulkThinkingLevel(
    ['alpha'],
    { alpha: { thinkingLevels: ['high'] } },
    'high',
    true,
  );
  assert.deepEqual(next.alpha?.thinkingLevels, ['high']);
});

test('unticking removes only that level, and only from the selection', () => {
  const next = applyBulkThinkingLevel(
    ['alpha', 'beta'],
    {
      alpha: { thinkingLevels: ['low', 'high'] },
      beta: { thinkingLevels: ['high'] },
      gamma: { thinkingLevels: ['high'] },
    },
    'high',
    false,
  );
  assert.deepEqual(next.alpha?.thinkingLevels, ['low']);
  // beta held nothing but `high`: an entry with no keys left is not an
  // entry, or the row keeps reading as declared and 保存 stays armed.
  assert.equal('beta' in next, false);
  // gamma is outside the selection — a bulk edit is scoped to the rows the
  // control sits above.
  assert.deepEqual(next.gamma?.thinkingLevels, ['high']);
});

test('unticking keeps the other declarations on a model whose levels it empties', () => {
  const next = applyBulkThinkingLevel(
    ['alpha'],
    { alpha: { thinkingLevels: ['high'], vision: true, contextWindow: 128_000 } },
    'high',
    false,
  );
  assert.deepEqual(next.alpha, { vision: true, contextWindow: 128_000 });
});

test('a bulk edit does not reshuffle the draft under the rows being edited', () => {
  const next = applyBulkThinkingLevel(
    ['gamma', 'alpha'],
    { alpha: { vision: true }, beta: { vision: false }, gamma: { vision: true } },
    'high',
    true,
  );
  assert.deepEqual(Object.keys(next), ['alpha', 'beta', 'gamma']);
});

test('a model id colliding with a prototype key stores an entry, not a prototype write', () => {
  // Ids come off the relay's /models response. `draft['constructor']` on a
  // plain object answers with Object's constructor rather than "absent",
  // and assigning `__proto__` writes through the prototype.
  const ids = ['__proto__', 'constructor', 'toString'];
  const next = applyBulkThinkingLevel(ids, {}, 'high', true);
  for (const id of ids) {
    assert.deepEqual(Object.getOwnPropertyDescriptor(next, id)?.value, {
      thinkingLevels: ['high'],
    });
  }
  assert.equal(({} as Record<string, unknown>).thinkingLevels, undefined);
  // And the read side sees all three as declaring it, rather than answering
  // "absent" for keys that resolve on Object.prototype.
  const [state] = bulkThinkingLevelStates(ids, next, ['high']);
  assert.deepEqual(state, { level: 'high', declaredCount: 3, total: 3, checked: true });
});

test('an emptied declaration collapses to undefined so the caller drops the key', () => {
  assert.equal(relayProfileWithThinkingLevels({ thinkingLevels: ['high'] }, []), undefined);
  assert.equal(relayProfileWithThinkingLevels({ thinkingLevels: ['high'] }, undefined), undefined);
  assert.deepEqual(relayProfileWithThinkingLevels({ vision: true }, ['high']), {
    vision: true,
    thinkingLevels: ['high'],
  });
});

test('clearing a level a model never declared leaves the draft untouched', () => {
  const draft: Record<string, RelayModelProfile> = { alpha: { vision: true } };
  const next = applyBulkThinkingLevel(MODELS, draft, 'high', false);
  assert.deepEqual(next, { alpha: { vision: true } });
});

test('the bulk edit does not mutate the draft it was handed', () => {
  const draft: Record<string, RelayModelProfile> = { alpha: { thinkingLevels: ['low'] } };
  applyBulkThinkingLevel(MODELS, draft, 'high', true);
  assert.deepEqual(draft, { alpha: { thinkingLevels: ['low'] } });
});
