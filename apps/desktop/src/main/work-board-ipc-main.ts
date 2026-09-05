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

import type { IpcMain } from 'electron';
import type { WorkBoardItem, WorkBoardPage } from '@maka/core/work-board';
import {
  createWorkBoardStore,
  WorkBoardStoreError,
  type WorkBoardStore,
  type WorkBoardStoreErrorCode,
  type WorkBoardMutationOptions,
} from '@maka/storage/work-board-store';
import type { createMainWindowController } from './main-window.js';
import type { WorkBoardChangedEvent, WorkBoardIpcResult } from '../shared/work-board-ipc.js';

export type { WorkBoardChangedEvent, WorkBoardIpcResult } from '../shared/work-board-ipc.js';

type MainWindowController = Pick<ReturnType<typeof createMainWindowController>, 'send'>;

export interface WorkBoardIpcRegistration {
  close(): void;
}

/**
 * Desktop main process owns the Work Board store (the v1 mutation boundary).
 * Renderer code reads a projection through IPC and reloads on the change
 * signal; the Runtime Host and model tools are intentionally not involved.
 */
export function registerWorkBoardIpc(input: {
  readonly ipcMain: Pick<IpcMain, 'handle'>;
  readonly workspaceRoot: string;
  readonly mainWindowController: MainWindowController;
  readonly store?: WorkBoardStore;
  readonly now?: () => number;
}): WorkBoardIpcRegistration {
  const store = input.store ?? createWorkBoardStore(input.workspaceRoot);
  const now = input.now ?? Date.now;
  const emitChanged = (): void => {
    input.mainWindowController.send('workBoard:changed', {
      type: 'work_board_changed',
      ts: now(),
    } satisfies WorkBoardChangedEvent);
  };

  input.ipcMain.handle(
    'workBoard:list',
    async (_event, query: unknown): Promise<WorkBoardIpcResult<WorkBoardPage>> => {
      try {
        return { ok: true, value: await store.list(query) };
      } catch (error) {
        return { ok: false, ...workBoardFailure(error) };
      }
    },
  );

  input.ipcMain.handle(
    'workBoard:create',
    async (_event, item: unknown): Promise<WorkBoardIpcResult<WorkBoardItem>> => {
      try {
        const created = await store.create(item);
        emitChanged();
        return { ok: true, value: created };
      } catch (error) {
        return { ok: false, ...workBoardFailure(error) };
      }
    },
  );

  input.ipcMain.handle(
    'workBoard:update',
    async (
      _event,
      id: unknown,
      patch: unknown,
      options?: unknown,
    ): Promise<WorkBoardIpcResult<WorkBoardItem>> => {
      try {
        const updated = await store.update(
          requireWorkBoardId(id),
          patch,
          options as WorkBoardMutationOptions | undefined,
        );
        emitChanged();
        return { ok: true, value: updated };
      } catch (error) {
        return { ok: false, ...workBoardFailure(error) };
      }
    },
  );

  input.ipcMain.handle(
    'workBoard:archive',
    async (_event, id: unknown, options?: unknown): Promise<WorkBoardIpcResult<WorkBoardItem>> => {
      try {
        const archived = await store.archive(
          requireWorkBoardId(id),
          options as WorkBoardMutationOptions | undefined,
        );
        emitChanged();
        return { ok: true, value: archived };
      } catch (error) {
        return { ok: false, ...workBoardFailure(error) };
      }
    },
  );

  input.ipcMain.handle(
    'workBoard:unarchive',
    async (_event, id: unknown, options?: unknown): Promise<WorkBoardIpcResult<WorkBoardItem>> => {
      try {
        const unarchived = await store.unarchive(
          requireWorkBoardId(id),
          options as WorkBoardMutationOptions | undefined,
        );
        emitChanged();
        return { ok: true, value: unarchived };
      } catch (error) {
        return { ok: false, ...workBoardFailure(error) };
      }
    },
  );

  input.ipcMain.handle(
    'workBoard:remove',
    async (
      _event,
      id: unknown,
      options?: unknown,
    ): Promise<WorkBoardIpcResult<null>> => {
      try {
        await store.remove(requireWorkBoardId(id), options as WorkBoardMutationOptions | undefined);
        emitChanged();
        return { ok: true, value: null };
      } catch (error) {
        return { ok: false, ...workBoardFailure(error) };
      }
    },
  );

  return {
    close: () => store.close(),
  };
}

function requireWorkBoardId(id: unknown): string {
  if (typeof id !== 'string') {
    throw new WorkBoardStoreError('invalid_input', 'Work Board item id must be a string');
  }
  return id;
}

function workBoardFailure(error: unknown): {
  readonly code: WorkBoardStoreErrorCode | 'unknown';
  readonly message: string;
} {
  if (error instanceof WorkBoardStoreError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: 'unknown',
    message: error instanceof Error ? error.message : 'Work Board operation failed',
  };
}
