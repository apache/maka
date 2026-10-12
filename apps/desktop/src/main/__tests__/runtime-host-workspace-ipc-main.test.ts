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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type { GitReviewReadResult } from '@maka/core/git-review';
import type { IpcHandler } from '../ipc-reconnect-policy.js';
import { registerRuntimeHostWorkspaceIpc } from '../runtime-host-workspace-ipc-main.js';

type Handler = (event: unknown, raw: unknown) => Promise<GitReviewReadResult>;

const temporaryDirs: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'maka-review-ipc-'));
  temporaryDirs.push(root);
  return root;
}

afterEach(async () => {
  while (temporaryDirs.length > 0) await rm(temporaryDirs.pop()!, { recursive: true, force: true });
});

function harness(hostCwd: string) {
  let handler: Handler | undefined;
  registerRuntimeHostWorkspaceIpc({
    ipcMain: {
      handle: (_channel: string, listener: IpcHandler) => {
        handler = listener as Handler;
      },
    },
    client: {
      getSession: async (sessionId: string) => ({
        id: sessionId,
        workspace: { hostCwd },
      }) as never,
    },
  });
  assert.ok(handler);
  return async (sessionId = 'session-1') =>
    handler!(undefined, { sessionId, source: 'branch' });
}

describe('git-review:read workspace identity', () => {
  it('names the task’s recorded directory on a non-Git workspace', async () => {
    const root = await temporaryRoot();
    const read = harness(root);
    const result = await read();
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'not_git_repository');
    assert.equal(result.workspace, root, 'guidance shows the current task’s workspace');
  });

  it('names the task’s recorded directory even when it is gone', async () => {
    const gone = join(await temporaryRoot(), 'deleted');
    const read = harness(gone);
    const result = await read();
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'workspace_unavailable');
    assert.equal(result.workspace, gone, 'recovery guidance still names the task’s directory');
  });

  it('names a host-owned workspace its own state, without resolving a local folder', async () => {
    let handler: Handler | undefined;
    let lookedUp = false;
    registerRuntimeHostWorkspaceIpc({
      ipcMain: {
        handle: (_channel: string, listener: IpcHandler) => {
          handler = listener as Handler;
        },
      },
      client: {
        getSession: async () => {
          lookedUp = true;
          throw new Error('must not resolve a local folder for a host-owned workspace');
        },
      },
      allowLocalWorkspace: false,
    });
    const result = await handler!(undefined, { sessionId: 'remote-task', source: 'branch' });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'remote_workspace');
    assert.equal(result.workspace, undefined, 'a host path is not a local folder to name');
    assert.equal(lookedUp, false, 'the denial happens before any Session lookup');
  });

  it('rejects a missing Session instead of reading another workspace', async () => {
    let handler: Handler | undefined;
    registerRuntimeHostWorkspaceIpc({
      ipcMain: {
        handle: (_channel: string, listener: IpcHandler) => {
          handler = listener as Handler;
        },
      },
      client: { getSession: async () => null as never },
    });
    await assert.rejects(() => handler!(undefined, { sessionId: 'ghost', source: 'branch' }));
  });
});
