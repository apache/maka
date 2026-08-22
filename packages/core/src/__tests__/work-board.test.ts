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
  applyWorkBoardItemPatch,
  archiveWorkBoardItem,
  decodeWorkBoardItem,
  WORK_BOARD_CURSOR_MAX_CHARS,
  normalizeCreateWorkBoardItemInput,
  normalizeWorkBoardCreator,
  normalizeWorkBoardScope,
  normalizeUpdateWorkBoardItemInput,
  normalizeWorkBoardListQuery,
  unarchiveWorkBoardItem,
  type WorkBoardItem,
} from '../work-board.js';

const baseItem: WorkBoardItem = {
  schemaVersion: 1,
  id: 'item-1',
  revision: 3,
  scope: { kind: 'inbox' },
  title: 'Review auth',
  state: 'todo',
  archived: false,
  creator: { kind: 'user' },
  provenance: { kind: 'manual' },
  createdAt: 100,
  updatedAt: 100,
};

describe('Work Board contract', () => {
  test('decodes a valid main-conversation item', () => {
    const decoded = decodeWorkBoardItem({
      ...baseItem,
      provenance: {
        kind: 'main_conversation',
        sessionId: 'session-1',
        messageId: 'message-1',
        capturedAt: 50,
        excerpt: 'remember to rotate the token',
      },
    });
    assert.ok(decoded);
    assert.equal(decoded.id, 'item-1');
    assert.equal(decoded.revision, 3);
    assert.deepEqual(decoded.provenance, {
      kind: 'main_conversation',
      sessionId: 'session-1',
      messageId: 'message-1',
      capturedAt: 50,
      excerpt: 'remember to rotate the token',
    });
  });

  test('decodes a side-conversation item only when parentSessionId is present', () => {
    const withParent = decodeWorkBoardItem({
      ...baseItem,
      provenance: {
        kind: 'side_conversation',
        sessionId: 'side-1',
        parentSessionId: 'session-1',
        messageId: 'message-2',
        capturedAt: 60,
        excerpt: 'add this to the current project todo',
      },
    });
    assert.ok(withParent);
    const withoutParent = decodeWorkBoardItem({
      ...baseItem,
      provenance: {
        kind: 'side_conversation',
        sessionId: 'side-1',
        messageId: 'message-2',
        capturedAt: 60,
        excerpt: 'add this to the current project todo',
      },
    });
    assert.equal(withoutParent, null);
  });

  test('rejects parentSessionId on main-conversation provenance', () => {
    const decoded = decodeWorkBoardItem({
      ...baseItem,
      provenance: {
        kind: 'main_conversation',
        sessionId: 'session-1',
        parentSessionId: 'session-0',
        messageId: 'message-1',
        capturedAt: 50,
        excerpt: 'x',
      },
    });
    assert.equal(decoded, null);
  });

  test('enforces the archive invariant in both directions', () => {
    assert.equal(decodeWorkBoardItem({ ...baseItem, archivedAt: 200 }), null);
    assert.equal(
      decodeWorkBoardItem({
        ...baseItem,
        archived: true,
      }),
      null,
    );
    const archived = decodeWorkBoardItem({
      ...baseItem,
      archived: true,
      archivedAt: 200,
    });
    assert.ok(archived);
    assert.equal(archived.archivedAt, 200);
  });

  test('enforces scope/projectId consistency', () => {
    assert.equal(
      decodeWorkBoardItem({ ...baseItem, scope: { kind: 'inbox', projectId: 'p1' } }),
      null,
    );
    assert.equal(decodeWorkBoardItem({ ...baseItem, scope: { kind: 'project' } }), null);
    const projectItem = decodeWorkBoardItem({
      ...baseItem,
      scope: { kind: 'project', projectId: 'p1' },
    });
    assert.ok(projectItem);
  });

  test('normalizes create input and rejects agent suggestions without confirmation', () => {
    const ok = normalizeCreateWorkBoardItemInput({
      scope: { kind: 'project', projectId: 'p1' },
      title: '  Review auth  ',
      creator: { kind: 'agent_suggestion', confirmedAt: 5 },
      provenance: { kind: 'manual' },
    });
    assert.ok(ok.ok);
    if (ok.ok) assert.equal(ok.value.title, 'Review auth');

    const unconfirmed = normalizeCreateWorkBoardItemInput({
      scope: { kind: 'inbox' },
      title: 'x',
      creator: { kind: 'agent_suggestion' },
      provenance: { kind: 'manual' },
    });
    assert.equal(unconfirmed.ok, false);
  });

  test('rejects linkedSessions as a Phase 3 field in create input and stored records', () => {
    const createResult = normalizeCreateWorkBoardItemInput({
      scope: { kind: 'inbox' },
      title: 'x',
      creator: { kind: 'user' },
      provenance: { kind: 'manual' },
      linkedSessions: [{ sessionId: 'session-1', linkedAt: 10 }],
    });
    assert.equal(createResult.ok, false);
    assert.equal(
      decodeWorkBoardItem({
        ...baseItem,
        linkedSessions: [{ sessionId: 'session-1', linkedAt: 10 }],
      }),
      null,
    );
  });

  test('rejects unknown fields at the contract boundary', () => {
    const unknownCreate = normalizeCreateWorkBoardItemInput({
      scope: { kind: 'inbox' },
      title: 'x',
      creator: { kind: 'user' },
      provenance: { kind: 'manual' },
      extra: true,
    });
    assert.equal(unknownCreate.ok, false);

    for (const patch of [{ titel: 'x' }, { status: 'done' }, { linkedSessions: [] }]) {
      assert.equal(normalizeUpdateWorkBoardItemInput(patch).ok, false, JSON.stringify(patch));
    }

    assert.equal(normalizeWorkBoardListQuery({ page: 1 }).ok, false);
    assert.equal(decodeWorkBoardItem({ ...baseItem, extraField: true }), null);
    assert.equal(
      normalizeWorkBoardScope({ kind: 'inbox', projectId: 'p1', extra: true }).ok,
      false,
    );
    assert.equal(normalizeWorkBoardCreator({ kind: 'user', confirmedAt: 5 }).ok, false);
  });

  test('keeps null notes exclusive to update patches', () => {
    const createResult = normalizeCreateWorkBoardItemInput({
      scope: { kind: 'inbox' },
      title: 'x',
      creator: { kind: 'user' },
      provenance: { kind: 'manual' },
      notes: null,
    });
    assert.equal(createResult.ok, false);
    assert.equal(decodeWorkBoardItem({ ...baseItem, notes: null }), null);
  });

  test('normalizes notes patch semantics for absent, undefined, null, empty, whitespace, and values', () => {
    const cases: Array<[unknown, unknown]> = [
      [{}, {}],
      [{ notes: undefined }, {}],
      [{ notes: null }, { notes: null }],
      [{ notes: '' }, { notes: null }],
      [{ notes: '   ' }, { notes: null }],
      [{ notes: 'new' }, { notes: 'new' }],
    ];
    for (const [input, expected] of cases) {
      const result = normalizeUpdateWorkBoardItemInput(input);
      assert.ok(result.ok, JSON.stringify(input));
      if (result.ok) assert.deepEqual(result.value, expected);
    }
  });

  test('applies notes patch semantics without clearing on undefined', () => {
    const withNotes: WorkBoardItem = { ...baseItem, notes: 'keep me' };
    const untouched = applyWorkBoardItemPatch(withNotes, { notes: undefined }, 101);
    assert.equal(untouched.changed, false);
    assert.equal(untouched.item.notes, 'keep me');

    for (const clearValue of [null, '', '   ']) {
      const cleared = applyWorkBoardItemPatch(withNotes, { notes: clearValue }, 102);
      assert.equal(cleared.changed, true, `notes: ${JSON.stringify(clearValue)}`);
      assert.equal('notes' in cleared.item, false, `notes: ${JSON.stringify(clearValue)}`);
    }

    const replaced = applyWorkBoardItemPatch(withNotes, { notes: 'new' }, 103);
    assert.equal(replaced.changed, true);
    assert.equal(replaced.item.notes, 'new');
  });

  test('applies semantic patches and bumps the revision only on effective changes', () => {
    const renamed = applyWorkBoardItemPatch(baseItem, { title: 'Review auth v2' }, 101);
    assert.equal(renamed.changed, true);
    assert.equal(renamed.item.revision, 4);
    assert.equal(renamed.item.updatedAt, 101);

    const noop = applyWorkBoardItemPatch(baseItem, { title: 'Review auth' }, 101);
    assert.equal(noop.changed, false);
    assert.equal(noop.item, baseItem);
  });

  test('allows todo -> done without passing through in_progress', () => {
    const done = applyWorkBoardItemPatch(baseItem, { state: 'done' }, 102);
    assert.equal(done.item.state, 'done');
  });

  test('archive and reopen are reversible and keep the item identity', () => {
    const archived = archiveWorkBoardItem(baseItem, 110);
    assert.equal(archived.changed, true);
    assert.equal(archived.item.archived, true);
    assert.equal(archived.item.archivedAt, 110);
    assert.equal(archived.item.revision, 4);

    const idempotentArchive = archiveWorkBoardItem(archived.item, 111);
    assert.equal(idempotentArchive.changed, false);

    const reopened = unarchiveWorkBoardItem(archived.item, 112);
    assert.equal(reopened.item.archived, false);
    assert.equal('archivedAt' in reopened.item, false);
    assert.equal(reopened.item.id, baseItem.id);
    assert.equal(reopened.item.revision, 5);
  });

  test('bounds the list query page size and cursor', () => {
    assert.equal(normalizeWorkBoardListQuery({ limit: 0 }).ok, false);
    assert.equal(normalizeWorkBoardListQuery({ limit: 101 }).ok, false);
    assert.equal(
      normalizeWorkBoardListQuery({ cursor: 'x'.repeat(WORK_BOARD_CURSOR_MAX_CHARS) }).ok,
      true,
    );
    assert.equal(
      normalizeWorkBoardListQuery({ cursor: 'x'.repeat(WORK_BOARD_CURSOR_MAX_CHARS + 1) }).ok,
      false,
    );
    const bounded = normalizeWorkBoardListQuery({ limit: 25, includeArchived: true });
    assert.ok(bounded.ok);
    if (bounded.ok) {
      assert.equal(bounded.value.limit, 25);
      assert.equal(bounded.value.includeArchived, true);
    }
  });
});
