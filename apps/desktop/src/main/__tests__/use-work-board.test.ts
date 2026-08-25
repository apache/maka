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

import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import { act, createElement } from 'react';
import type { WorkBoardItem } from '@maka/core/work-board';
import type {
  WorkBoardChangedEvent,
  WorkBoardIpcResult,
} from '../../shared/work-board-ipc.js';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';
import { useWorkBoard } from '../../renderer/use-work-board.js';

interface Harness {
  listCalls: Array<{ cursor?: string; limit?: number }>;
  emitChanged(): void;
}

function item(id: number): WorkBoardItem {
  return {
    schemaVersion: 1,
    id: `item-${id}`,
    revision: 1,
    scope: { kind: 'inbox' },
    title: `Item ${id}`,
    state: 'todo',
    creator: { kind: 'user' },
    provenance: { kind: 'manual' },
    createdAt: id,
    updatedAt: id,
    archived: false,
  };
}

function installHarness(): Harness {
  const allItems = Array.from({ length: 60 }, (_, index) => item(index));
  const listCalls: Harness['listCalls'] = [];
  let changed: ((event: WorkBoardChangedEvent) => void) | undefined;
  const list = async (query?: { cursor?: string; limit?: number }): Promise<WorkBoardIpcResult<{
    items: WorkBoardItem[];
    nextCursor?: string;
  }>> => {
    listCalls.push({ cursor: query?.cursor, limit: query?.limit });
    const start = query?.cursor ? Number(query.cursor) : 0;
    const limit = query?.limit ?? 50;
    const end = Math.min(start + limit, allItems.length);
    return {
      ok: true,
      value: {
        items: allItems.slice(start, end),
        nextCursor: end < allItems.length ? String(end) : undefined,
      },
    };
  };
  const unexpectedMutation = async (): Promise<never> => {
    throw new Error('mutation is not expected in this test');
  };
  (globalThis.window as unknown as { maka: unknown }).maka = {
    workBoard: {
      list,
      create: unexpectedMutation,
      update: unexpectedMutation,
      archive: unexpectedMutation,
      unarchive: unexpectedMutation,
      remove: unexpectedMutation,
      subscribeChanges(listener: (event: WorkBoardChangedEvent) => void) {
        changed = listener;
        return () => {
          changed = undefined;
        };
      },
    },
  };
  return {
    listCalls,
    emitChanged() {
      changed?.({ type: 'work_board_changed', ts: 1 });
    },
  };
}

function Probe(props: { onValue(value: ReturnType<typeof useWorkBoard>): void }) {
  props.onValue(useWorkBoard());
  return null;
}

describe('useWorkBoard', () => {
  afterEach(() => {
    cleanupFakeDom();
  });

  it('preserves the loaded window when a mutation change signal refreshes the board', async () => {
    const { root } = installReactRenderer();
    const harness = installHarness();
    let board: ReturnType<typeof useWorkBoard> | undefined;

    await act(async () => {
      root.render(createElement(Probe, { onValue: (value) => (board = value) }));
    });
    await act(async () => board?.loadMore());

    assert.equal(board?.items.length, 60);
    assert.equal(board?.nextCursor, undefined);
    assert.deepEqual(harness.listCalls, [
      { cursor: undefined, limit: undefined },
      { cursor: '50', limit: undefined },
    ]);

    await act(async () => harness.emitChanged());

    assert.equal(board?.items.length, 60);
    assert.equal(board?.nextCursor, undefined);
    assert.deepEqual(harness.listCalls.at(-1), { cursor: undefined, limit: 60 });
  });
});
