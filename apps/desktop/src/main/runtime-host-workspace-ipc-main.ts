import { stat } from 'node:fs/promises';
import type { GitReviewMutationAction, GitReviewSource } from '@maka/core/git-review';
import type { DesktopRuntimeHostClient } from './runtime-host-client.js';
import { mutateGitReview, readGitReview } from './git-review-main.js';
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

  input.ipcMain.handle('git-review:mutate', async (_event, raw: unknown) => {
    if (input.allowLocalWorkspace === false) {
      return { ok: false as const, reason: 'git_failed' as const };
    }
    const request = mutateRequest(raw);
    const cwd = await sessionWorkspace(input.client, request.sessionId);
    if (!cwd) return { ok: false as const, reason: 'git_failed' as const };
    return mutateGitReview({
      cwd,
      source: request.source,
      revision: request.revision,
      path: request.path,
      action: request.action,
    });
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

function mutateRequest(value: unknown): {
  sessionId: string;
  source: Extract<GitReviewSource, 'unstaged' | 'staged'>;
  revision: string;
  path: string;
  action: GitReviewMutationAction;
} {
  const record = requiredRecord(value, 'Git review mutation');
  const sessionId = requiredString(record.sessionId, 'Session id');
  if (record.source !== 'unstaged' && record.source !== 'staged') {
    throw new Error('Invalid Git review mutation source');
  }
  if (typeof record.revision !== 'string' || !/^[a-f0-9]{64}$/u.test(record.revision)) {
    throw new Error('Invalid Git review revision');
  }
  const path = requiredString(record.path, 'Git review path');
  if (path.length > 4096) throw new Error('Invalid Git review path');
  if (record.action !== 'stage' && record.action !== 'unstage' && record.action !== 'revert') {
    throw new Error('Invalid Git review mutation action');
  }
  return {
    sessionId,
    source: record.source,
    revision: record.revision,
    path,
    action: record.action,
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
