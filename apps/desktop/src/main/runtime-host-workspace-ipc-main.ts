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

import { stat } from 'node:fs/promises';
import type { GitReviewSource } from '@maka/core/git-review';
import type { DesktopRuntimeHostClient } from './runtime-host-client.js';
import { readGitReview } from './git-review-main.js';
import {
  handleReconnectableRead,
  type ReconnectableReadIpcMain,
} from './ipc-reconnect-policy.js';

type WorkspaceClient = Pick<DesktopRuntimeHostClient, 'getSession'>;

export function registerRuntimeHostWorkspaceIpc(
  input: {
    readonly ipcMain: ReconnectableReadIpcMain;
    readonly client: WorkspaceClient;
    readonly allowLocalWorkspace?: boolean;
  },
): void {
  handleReconnectableRead(input.ipcMain, 'git-review:read', async (_event, raw: unknown) => {
    if (input.allowLocalWorkspace === false) {
      // A host-owned workspace is not missing — the Desktop simply cannot
      // read it locally. It is a different capability state than a gone
      // directory, so it gets its own reason: no folder to name, no retry
      // that could help, no local-folder recovery that applies.
      return { ok: false as const, reason: 'remote_workspace' as const };
    }
    const request = readRequest(raw);
    const session = await input.client.getSession(request.sessionId);
    if (!session) throw new Error(`No such Session: ${request.sessionId}`);
    // The Session record owns the task's workspace; guidance must name it,
    // never the application default — even when the directory is gone.
    const workspace = session.workspace.hostCwd;
    const directory = await stat(workspace).catch(() => null);
    if (!directory?.isDirectory()) {
      return { ok: false as const, reason: 'workspace_unavailable' as const, workspace };
    }
    const result = await readGitReview(workspace, request.source, undefined, request.baseBranch);
    return result.ok ? result : { ...result, workspace };
  });
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
