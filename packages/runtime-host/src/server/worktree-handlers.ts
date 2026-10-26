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

import { createWorktreeCatalogPage } from './worktree-catalog.js';
import type { SessionHeader } from '@maka/core/session';
import type { OperationHandlerMap } from './operation-dispatcher.js';
import type { HostWorktreeManager } from './worktree-manager.js';

/** Worktree protocol outcomes belong with their Host authority, not Desktop discovery. */
export function createWorktreeHandlers(
  manager: HostWorktreeManager,
  readSession: (sessionId: string) => Promise<Pick<SessionHeader, 'cwd' | 'projectId'>>,
): Pick<
  OperationHandlerMap,
  'worktree.query' | 'worktree.mutate' | 'worktree.session.query' | 'worktree.preparation.query'
> {
  return {
    'worktree.preparation.query': async (input) => ({
      ok: true,
      result: await manager.preparation(input.operationId),
    }),
    'worktree.session.query': async (input) => {
      try {
        const header = await readSession(input.sessionId);
        return {
          ok: true,
          result: {
            path: header.cwd,
            canCreate: await manager.canCreateFrom(header.projectId, header.cwd),
          },
        };
      } catch {
        return {
          ok: false,
          error: { code: 'operation_unavailable', message: 'Session workspace is unavailable' },
        };
      }
    },
    'worktree.query': async (input) => {
      try {
        return {
          ok: true,
          result: createWorktreeCatalogPage(await manager.snapshot(input.projectId), input),
        };
      } catch (error) {
        return {
          ok: false,
          error:
            error instanceof RangeError
              ? { code: 'invalid_request', message: 'Invalid worktree catalog cursor' }
              : { code: 'internal_failure', message: 'Worktree catalog is unavailable' },
        };
      }
    },
    'worktree.mutate': async (input) => {
      try {
        return { ok: true, result: await manager.mutate(input) };
      } catch (error) {
        return {
          ok: false,
          error: {
            code: 'operation_conflict',
            message: error instanceof Error ? error.message : 'Worktree operation failed',
          },
        };
      }
    },
  };
}
