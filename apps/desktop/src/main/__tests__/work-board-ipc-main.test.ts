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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { IpcMain } from 'electron';
import {
  registerWorkBoardIpc,
  type WorkBoardChangedEvent,
  type WorkBoardIpcResult,
} from '../work-board-ipc-main.js';

interface FakeIpcMain {
  handle(channel: string, handler: (...args: unknown[]) => unknown): void;
  invoke<T>(channel: string, ...args: unknown[]): Promise<T>;
}

function createFakeIpcMain(): FakeIpcMain & { readonly channels: string[] } {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const channels: string[] = [];
  return {
    channels,
    handle(channel, handler) {
      channels.push(channel);
      handlers.set(channel, handler);
    },
    invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`No handler registered for ${channel}`);
      return Promise.resolve(handler(undefined, ...args)) as Promise<T>;
    },
  };
}

function createFakeWindowController(): {
  readonly events: Array<{ channel: string; args: unknown[] }>;
  send(channel: string, ...args: unknown[]): void;
} {
  const events: Array<{ channel: string; args: unknown[] }> = [];
  return {
    events,
    send(channel, ...args) {
      events.push({ channel, args });
    },
  };
}

function itemInput(): {
  scope: { kind: 'inbox' };
  title: string;
  creator: { kind: 'user' };
  provenance: { kind: 'manual' };
} {
  return {
    scope: { kind: 'inbox' },
    title: 'Review auth',
    creator: { kind: 'user' },
    provenance: { kind: 'manual' },
  };
}

async function withTempRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-work-board-ipc-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('Work Board IPC', () => {
  test('creates and lists items and emits change signals', async () => {
    await withTempRoot(async (root) => {
      const ipc = createFakeIpcMain();
      const window = createFakeWindowController();
      const registration = registerWorkBoardIpc({
        ipcMain: ipc as unknown as Pick<IpcMain, 'handle'>,
        workspaceRoot: root,
        mainWindowController: window,
      });
      try {
        const created = await ipc.invoke<WorkBoardIpcResult<{ id: string; revision: number }>>(
          'workBoard:create',
          itemInput(),
        );
        assert.equal(created.ok, true);
        assert.ok(created.ok && created.value.id);

        const page = await ipc.invoke<WorkBoardIpcResult<{ items: Array<{ id: string }> }>>(
          'workBoard:list',
          {},
        );
        assert.equal(page.ok, true);
        assert.ok(page.ok);
        assert.equal(page.value.items.length, 1);
        assert.equal(page.value.items[0]?.id, created.ok ? created.value.id : undefined);

        const changed = window.events.filter(
          (event) => event.channel === 'workBoard:changed',
        );
        assert.equal(changed.length, 1);
        const event = changed[0]?.args[0] as WorkBoardChangedEvent;
        assert.equal(event.type, 'work_board_changed');
        assert.ok(typeof event.ts === 'number');
        assert.deepEqual(ipc.channels, [
          'workBoard:list',
          'workBoard:create',
          'workBoard:update',
          'workBoard:archive',
          'workBoard:unarchive',
          'workBoard:remove',
        ]);
      } finally {
        registration.close();
      }
    });
  });

  test('applies lifecycle mutations and fails closed on invalid input', async () => {
    await withTempRoot(async (root) => {
      const ipc = createFakeIpcMain();
      const window = createFakeWindowController();
      const registration = registerWorkBoardIpc({
        ipcMain: ipc as unknown as Pick<IpcMain, 'handle'>,
        workspaceRoot: root,
        mainWindowController: window,
      });
      try {
        const created = await ipc.invoke<WorkBoardIpcResult<{ id: string; revision: number }>>(
          'workBoard:create',
          itemInput(),
        );
        assert.ok(created.ok);
        const id = created.ok ? created.value.id : '';

        const renamed = await ipc.invoke<
          WorkBoardIpcResult<{ title: string; revision: number; state: string }>
        >('workBoard:update', id, { title: 'Review auth v2' });
        assert.ok(renamed.ok);
        assert.equal(renamed.ok && renamed.value.revision, 2);

        const staleRename = await ipc.invoke<WorkBoardIpcResult<unknown>>(
          'workBoard:update',
          id,
          { title: 'stale write' },
          { expectedRevision: 1 },
        );
        assert.equal(staleRename.ok, false);
        if (!staleRename.ok) assert.equal(staleRename.code, 'operation_conflict');

      const removedBeforeArchive = await ipc.invoke<WorkBoardIpcResult<null>>(
        'workBoard:remove',
        id,
      );
      assert.equal(removedBeforeArchive.ok, false);
      if (!removedBeforeArchive.ok) {
        assert.equal(removedBeforeArchive.code, 'must_archive_first');
      }

      const archived = await ipc.invoke<
        WorkBoardIpcResult<{ archived: boolean; revision: number }>
      >('workBoard:archive', id);
      assert.ok(archived.ok);
      assert.equal(archived.ok && archived.value.archived, true);

      const reopened = await ipc.invoke<
        WorkBoardIpcResult<{ archived: boolean; revision: number }>
      >('workBoard:unarchive', id);
      assert.ok(reopened.ok);
      assert.equal(reopened.ok && reopened.value.archived, false);

      const invalidPatch = await ipc.invoke<WorkBoardIpcResult<unknown>>(
        'workBoard:update',
        id,
        { titel: 'x' },
      );
      assert.equal(invalidPatch.ok, false);
      if (!invalidPatch.ok) assert.equal(invalidPatch.code, 'invalid_input');

      const invalidCreate = await ipc.invoke<WorkBoardIpcResult<unknown>>(
        'workBoard:create',
        { ...itemInput(), notes: null },
      );
      assert.equal(invalidCreate.ok, false);
      if (!invalidCreate.ok) assert.equal(invalidCreate.code, 'invalid_input');

      await ipc.invoke('workBoard:archive', id);
      const removed = await ipc.invoke<WorkBoardIpcResult<null>>('workBoard:remove', id);
      assert.ok(removed.ok);

      const page = await ipc.invoke<WorkBoardIpcResult<{ items: unknown[] }>>(
        'workBoard:list',
        {},
      );
      assert.ok(page.ok);
      assert.equal(page.ok && page.value.items.length, 0);

        // create, update, archive, unarchive, archive, remove = 6 mutations
        const changed = window.events.filter(
          (event) => event.channel === 'workBoard:changed',
        );
        assert.equal(changed.length, 6);
      } finally {
        registration.close();
      }
    });
  });
});
