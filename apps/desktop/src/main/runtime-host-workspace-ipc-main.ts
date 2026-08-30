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

import { open, realpath, stat } from 'node:fs/promises';
import type { GitReviewSource } from '@maka/core/git-review';
import type { DesktopRuntimeHostClient } from './runtime-host-client.js';
import { readGitReview } from './git-review-main.js';
import {
  handleReconnectableRead,
  type ReconnectableReadIpcMain,
} from './ipc-reconnect-policy.js';
import {
  isAllowedWorkspaceMarkdownPath,
  isPathInsideWorkspace,
  resolveWorkspaceFile,
} from './workspace-file-guard.js';

const WORKSPACE_TEXT_LIMIT_BYTES = 256 * 1024;

type WorkspaceClient = Pick<DesktopRuntimeHostClient, 'getSession'>;

export function registerRuntimeHostWorkspaceIpc(
  input: {
    readonly ipcMain: ReconnectableReadIpcMain;
    readonly client: WorkspaceClient;
    readonly allowLocalWorkspace?: boolean;
    readonly openPath?: (path: string) => Promise<string>;
    readonly showItemInFolder?: (path: string) => void;
  },
): void {
  handleReconnectableRead(input.ipcMain, 'git-review:read', async (_event, raw: unknown) => {
    if (input.allowLocalWorkspace === false) {
      return { ok: false as const, reason: 'workspace_unavailable' as const };
    }
    const request = readRequest(raw);
    const cwd = await sessionWorkspace(input.client, request.sessionId);
    if (!cwd) return { ok: false as const, reason: 'workspace_unavailable' as const };
    return readGitReview(cwd, request.source, undefined, request.baseBranch);
  });
  handleReconnectableRead(
    input.ipcMain,
    'workspace:readText',
    async (_event, sessionId: unknown, relativePath: unknown) => {
      if (input.allowLocalWorkspace === false) {
        return { ok: false as const, reason: 'not-allowed' as const };
      }
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        return { ok: false as const, reason: 'invalid' as const };
      }
      if (typeof relativePath !== 'string') {
        return { ok: false as const, reason: 'invalid' as const };
      }
      const cwd = await sessionWorkspace(input.client, sessionId);
      if (!cwd) return { ok: false as const, reason: 'missing' as const };
      return readBoundedWorkspaceText({ workspaceRoot: cwd, relativePath });
    },
  );

  input.ipcMain.handle('workspace:openFile', async (_event, sessionId: unknown, relativePath: unknown) => {
    const resolved = await resolveSessionWorkspaceFile(input, sessionId, relativePath);
    if (!resolved.ok) return resolved;
    const error = await input.openPath?.(resolved.path);
    if (error) return { ok: false as const, reason: 'open-failed' as const };
    return { ok: true as const, opened: resolved.relativePath };
  });

  input.ipcMain.handle('workspace:revealFile', async (_event, sessionId: unknown, relativePath: unknown) => {
    const resolved = await resolveSessionWorkspaceFile(input, sessionId, relativePath);
    if (!resolved.ok) return resolved;
    input.showItemInFolder?.(resolved.path);
    return { ok: true as const, opened: resolved.relativePath };
  });
}

async function resolveSessionWorkspaceFile(
  input: {
    readonly client: WorkspaceClient;
    readonly allowLocalWorkspace?: boolean;
  },
  sessionId: unknown,
  relativePath: unknown,
): Promise<
  | { ok: true; path: string; root: string; relativePath: string }
  | { ok: false; reason: 'invalid' | 'missing' | 'not-a-file' | 'not-allowed' }
> {
  if (input.allowLocalWorkspace === false) return { ok: false, reason: 'not-allowed' };
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return { ok: false, reason: 'invalid' };
  }
  if (typeof relativePath !== 'string') return { ok: false, reason: 'invalid' };
  const cwd = await sessionWorkspace(input.client, sessionId);
  if (!cwd) return { ok: false, reason: 'missing' };
  return resolveWorkspaceFile({ workspaceRoot: cwd, relativePath });
}

export async function readBoundedWorkspaceText(
  input: { readonly workspaceRoot: string; readonly relativePath: string },
  beforeOpen: (path: string) => void | Promise<void> = () => undefined,
): Promise<
  | { ok: true; relativePath: string; text: string }
  | { ok: false; reason: 'invalid' | 'missing' | 'not-a-file' | 'not-allowed' }
  | { ok: false; reason: 'too-large'; sizeBytes: number }
> {
  const resolved = await resolveWorkspaceFile(input);
  if (!resolved.ok) return resolved;
  await beforeOpen(resolved.path);

  const handle = await open(resolved.path, 'r').catch(() => null);
  if (!handle) return { ok: false, reason: 'missing' };
  try {
    const fileStat = await handle.stat({ bigint: true });
    if (!fileStat.isFile()) return { ok: false, reason: 'not-a-file' };

    const currentTarget = await realpath(resolved.path).catch(() => null);
    if (!currentTarget) return { ok: false, reason: 'missing' };
    if (!isPathInsideWorkspace(resolved.root, currentTarget)) {
      return { ok: false, reason: 'not-allowed' };
    }
    if (!isAllowedWorkspaceMarkdownPath(currentTarget)) {
      return { ok: false, reason: 'not-a-file' };
    }
    const currentStat = await stat(currentTarget, { bigint: true }).catch(() => null);
    if (
      !currentStat
      || currentStat.dev !== fileStat.dev
      || currentStat.ino !== fileStat.ino
    ) {
      return { ok: false, reason: 'not-allowed' };
    }
    if (fileStat.size > BigInt(WORKSPACE_TEXT_LIMIT_BYTES)) {
      return { ok: false, reason: 'too-large', sizeBytes: Number(fileStat.size) };
    }

    const bytes = Buffer.allocUnsafe(WORKSPACE_TEXT_LIMIT_BYTES + 1);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.read(bytes, offset, bytes.byteLength - offset, null);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset > WORKSPACE_TEXT_LIMIT_BYTES) {
      return {
        ok: false,
        reason: 'too-large',
        sizeBytes: Math.max(Number(fileStat.size), offset),
      };
    }
    return {
      ok: true,
      relativePath: resolved.relativePath,
      text: bytes.subarray(0, offset).toString('utf8'),
    };
  } finally {
    await handle.close();
  }
}

async function sessionWorkspace(client: WorkspaceClient, sessionId: string): Promise<string | null> {
  const session = await client.getSession(sessionId);
  if (!session) throw new Error(`No such Session: ${sessionId}`);
  const workspace = await stat(session.workspace.hostCwd).catch(() => null);
  return workspace?.isDirectory() ? session.workspace.hostCwd : null;
}

function readRequest(value: unknown): {
  sessionId: string;
  source: GitReviewSource;
  baseBranch?: string;
} {
  const record = requiredRecord(value, 'Git review');
  const sessionId = requiredString(record.sessionId, 'Session id');
  if (record.source !== 'branch' && record.source !== 'unstaged' && record.source !== 'staged') {
    throw new Error('Invalid Git review source');
  }
  const baseBranch = record.baseBranch;
  if (
    baseBranch !== undefined &&
    (typeof baseBranch !== 'string' ||
      baseBranch.length === 0 ||
      baseBranch.length > 1024 ||
      /[\u0000-\u001f\u007f]/u.test(baseBranch))
  ) {
    throw new Error('Invalid Git review base branch');
  }
  return {
    sessionId,
    source: record.source,
    ...(typeof baseBranch === 'string' ? { baseBranch } : {}),
  };
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${label} input`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Invalid ${label}`);
  return value;
}
