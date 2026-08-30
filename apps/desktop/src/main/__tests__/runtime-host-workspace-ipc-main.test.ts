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
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DesktopRuntimeHostClient } from '../runtime-host-client.js';
import {
  readBoundedWorkspaceText,
  registerRuntimeHostWorkspaceIpc,
} from '../runtime-host-workspace-ipc-main.js';
import type { IpcHandler, ReconnectableReadIpcMain } from '../ipc-reconnect-policy.js';

type WorkspaceHandler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

test('workspace IPC reads Markdown within the limit and opens only Markdown files', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-workspace-ipc-'));
  try {
    await mkdir(join(workspaceRoot, 'docs'), { recursive: true });
    await mkdir(join(workspaceRoot, 'tools'), { recursive: true });
    await writeFile(join(workspaceRoot, 'docs', 'guide.md'), '# Guide\n', 'utf8');
    await writeFile(join(workspaceRoot, 'tools', 'setup.command'), 'echo unsafe\n', 'utf8');

    const opened: string[] = [];
    const revealed: string[] = [];
    const handlers = new Map<string, WorkspaceHandler>();
    registerRuntimeHostWorkspaceIpc({
      ipcMain: ipcHarness(handlers),
      client: workspaceClient(workspaceRoot),
      openPath: async (path) => {
        opened.push(path);
        return '';
      },
      showItemInFolder: (path) => revealed.push(path),
    });

    assert.deepEqual(
      await invoke(handlers, 'workspace:readText', 'session-1', 'docs/guide.md'),
      { ok: true, relativePath: 'docs/guide.md', text: '# Guide\n' },
    );
    assert.deepEqual(
      await invoke(handlers, 'workspace:openFile', 'session-1', 'docs/guide.md'),
      { ok: true, opened: 'docs/guide.md' },
    );
    assert.deepEqual(
      await invoke(handlers, 'workspace:revealFile', 'session-1', 'docs/guide.md'),
      { ok: true, opened: 'docs/guide.md' },
    );
    assert.deepEqual(
      await invoke(handlers, 'workspace:openFile', 'session-1', 'tools/setup.command'),
      { ok: false, reason: 'not-a-file' },
    );
    assert.deepEqual(
      await invoke(handlers, 'workspace:revealFile', 'session-1', 'tools/setup.command'),
      { ok: false, reason: 'not-a-file' },
    );
    const guidePath = await realpath(join(workspaceRoot, 'docs', 'guide.md'));
    assert.deepEqual(opened, [guidePath]);
    assert.deepEqual(revealed, [guidePath]);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('workspace IPC bounds Markdown reads at 256 KiB', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-workspace-ipc-limit-'));
  try {
    const exactText = 'a'.repeat(256 * 1024);
    await writeFile(join(workspaceRoot, 'exact.md'), exactText, 'utf8');
    await writeFile(join(workspaceRoot, 'too-large.md'), `${exactText}b`, 'utf8');

    const handlers = new Map<string, WorkspaceHandler>();
    registerRuntimeHostWorkspaceIpc({
      ipcMain: ipcHarness(handlers),
      client: workspaceClient(workspaceRoot),
    });

    assert.deepEqual(
      await invoke(handlers, 'workspace:readText', 'session-1', 'exact.md'),
      { ok: true, relativePath: 'exact.md', text: exactText },
    );
    assert.deepEqual(
      await invoke(handlers, 'workspace:readText', 'session-1', 'too-large.md'),
      { ok: false, reason: 'too-large', sizeBytes: 256 * 1024 + 1 },
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('workspace text read rejects replacement after authorization and reads only the opened inode', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-workspace-ipc-race-'));
  const outsideRoot = await mkdtemp(join(tmpdir(), 'maka-workspace-ipc-race-out-'));
  try {
    await mkdir(join(workspaceRoot, 'docs'), { recursive: true });
    const guidePath = join(workspaceRoot, 'docs', 'guide.md');
    await writeFile(guidePath, '# Safe\n', 'utf8');
    const secretPath = join(outsideRoot, 'secret.md');
    await writeFile(secretPath, 'secret', 'utf8');

    const result = await readBoundedWorkspaceText(
      { workspaceRoot, relativePath: 'docs/guide.md' },
      async (authorizedPath) => {
        await rename(authorizedPath, `${authorizedPath}.old`);
        await symlink(secretPath, authorizedPath);
      },
    );

    assert.deepEqual(result, { ok: false, reason: 'not-allowed' });
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

function ipcHarness(handlers: Map<string, WorkspaceHandler>): ReconnectableReadIpcMain {
  const register = (channel: string, listener: IpcHandler) => {
    handlers.set(channel, listener as WorkspaceHandler);
  };
  return {
    handle: register,
    handleReconnectableRead: register,
  };
}

function workspaceClient(workspaceRoot: string): Pick<DesktopRuntimeHostClient, 'getSession'> {
  return {
    async getSession() {
      return {
        workspace: { hostCwd: workspaceRoot },
      } as Awaited<ReturnType<DesktopRuntimeHostClient['getSession']>>;
    },
  };
}

async function invoke(
  handlers: Map<string, WorkspaceHandler>,
  channel: string,
  ...args: unknown[]
): Promise<unknown> {
  const handler = handlers.get(channel);
  assert.ok(handler, `missing ${channel} handler`);
  return handler({}, ...args);
}
