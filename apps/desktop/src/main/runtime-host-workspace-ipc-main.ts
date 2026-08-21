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
      return { ok: false as const, reason: 'workspace_unavailable' as const };
    }
    const request = readRequest(raw);
    const cwd = await sessionWorkspace(input.client, request.sessionId);
    if (!cwd) return { ok: false as const, reason: 'workspace_unavailable' as const };
    return readGitReview(cwd, request.source, undefined, request.baseBranch);
  });
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
