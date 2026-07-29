import { ipcMain, shell } from 'electron';
import type { LocalMemoryState } from '@maka/core';
import type { LocalMemoryService } from './local-memory-service.js';

interface MemoryIpcDeps {
  localMemory: LocalMemoryService;
}

export function registerMemoryIpc(deps: MemoryIpcDeps): void {
  const { localMemory } = deps;

  ipcMain.handle('memory:getState', async (): Promise<LocalMemoryState> => localMemory.getState());
  ipcMain.handle('memory:listProposals', async () => localMemory.listProposals());
  ipcMain.handle('memory:propose', async (_event, input: unknown) => {
    const proposal = normalizeMemoryTextInput(input);
    if (!proposal) {
      return {
        ok: false,
        state: await localMemory.getState(),
        reason: 'invalid_input',
        message: '记忆提议参数无效。',
      };
    }
    return localMemory.proposeMemory({
      title: proposal.title,
      content: proposal.content,
      scope: proposal.scope,
      sessionId: proposal.sessionId,
    });
  });
  ipcMain.handle('memory:remember', async (_event, input: unknown) => {
    const memory = normalizeMemoryTextInput(input);
    if (!memory) {
      return {
        ok: false,
        state: await localMemory.getState(),
        reason: 'invalid_input',
        message: '记忆参数无效。',
      };
    }
    return localMemory.rememberUserAuthored({
      title: memory.title,
      content: memory.content,
      scope: memory.scope,
      sessionId: memory.sessionId,
    });
  });
  ipcMain.handle('memory:approveProposal', async (_event, proposalId: unknown) => {
    if (typeof proposalId !== 'string') {
      return {
        ok: false,
        state: await localMemory.getState(),
        reason: 'invalid_input',
        message: '记忆提议 ID 无效。',
      };
    }
    return localMemory.approveProposal(proposalId);
  });
  ipcMain.handle('memory:rejectProposal', async (_event, proposalId: unknown) => {
    if (typeof proposalId !== 'string') {
      return {
        ok: false,
        state: await localMemory.getState(),
        reason: 'invalid_input',
        message: '记忆提议 ID 无效。',
      };
    }
    return localMemory.rejectProposal(proposalId);
  });
  ipcMain.handle('memory:archiveEntry', async (_event, entryId: unknown, reason: unknown) => {
    if (typeof entryId !== 'string') {
      return {
        ok: false,
        state: await localMemory.getState(),
        reason: 'invalid_input',
        message: '记忆 ID 无效。',
      };
    }
    return localMemory.archiveEntry(entryId, typeof reason === 'string' ? reason : undefined);
  });
  ipcMain.handle('memory:restoreEntry', async (_event, entryId: unknown) => {
    if (typeof entryId !== 'string') {
      return {
        ok: false,
        state: await localMemory.getState(),
        reason: 'invalid_input',
        message: '记忆 ID 无效。',
      };
    }
    return localMemory.restoreEntry(entryId);
  });
  ipcMain.handle('memory:save', async (_event, content: unknown): Promise<LocalMemoryState> => {
    if (typeof content !== 'string') return localMemory.getState();
    return localMemory.save(content);
  });
  ipcMain.handle('memory:reset', async (): Promise<LocalMemoryState> => localMemory.reset());
  ipcMain.handle('memory:restoreLatestBackup', async (): Promise<
    { ok: true; state: LocalMemoryState } | { ok: false; state: LocalMemoryState; message: string }
  > => localMemory.restoreLatestBackup());
  ipcMain.handle('memory:restoreBackup', async (_event, kind: unknown): Promise<
    { ok: true; state: LocalMemoryState } | { ok: false; state: LocalMemoryState; message: string }
  > => {
    if (kind !== 'save' && kind !== 'reset' && kind !== 'restore') {
      return { ok: false, state: await localMemory.getState(), message: '只能恢复已验证的 MEMORY.md 备份候选。' };
    }
    return localMemory.restoreBackup(kind);
  });
  ipcMain.handle('memory:setEnabled', async (_event, enabled: unknown): Promise<LocalMemoryState> =>
    localMemory.setEnabled(enabled === true),
  );
  ipcMain.handle('memory:setAgentReadEnabled', async (_event, enabled: unknown): Promise<LocalMemoryState> =>
    localMemory.setAgentReadEnabled(enabled === true),
  );
  ipcMain.handle('memory:openFile', async (): Promise<{ ok: true } | { ok: false; message: string }> => {
    const resolved = await localMemory.resolveFileForOpen();
    if (!resolved.ok) return { ok: false, message: localMemoryOpenFailureCopy(resolved.reason) };
    const error = await shell.openPath(resolved.path);
    return error ? { ok: false, message: localMemoryOpenFailureCopy('open-failed') } : { ok: true };
  });
  ipcMain.handle('memory:openLatestBackup', async (): Promise<{ ok: true } | { ok: false; message: string }> => {
    const resolved = await localMemory.resolveLatestBackupForOpen();
    if (!resolved.ok) return { ok: false, message: localMemoryBackupOpenFailureCopy(resolved.reason) };
    const error = await shell.openPath(resolved.path);
    return error ? { ok: false, message: localMemoryBackupOpenFailureCopy('open-failed') } : { ok: true };
  });
  ipcMain.handle('memory:openBackup', async (_event, kind: unknown): Promise<{ ok: true } | { ok: false; message: string }> => {
    if (kind !== 'save' && kind !== 'reset' && kind !== 'restore') return { ok: false, message: localMemoryBackupOpenFailureCopy('not-allowed') };
    const resolved = await localMemory.resolveBackupForOpen(kind);
    if (!resolved.ok) return { ok: false, message: localMemoryBackupOpenFailureCopy(resolved.reason) };
    const error = await shell.openPath(resolved.path);
    return error ? { ok: false, message: localMemoryBackupOpenFailureCopy('open-failed') } : { ok: true };
  });
}

function normalizeMemoryTextInput(input: unknown): {
  title: string;
  content: string;
  scope?: 'workspace' | 'session';
  sessionId?: string;
} | null {
  if (!input || typeof input !== 'object') return null;
  const value = input as Record<string, unknown>;
  if (typeof value.title !== 'string' || typeof value.content !== 'string') return null;
  const scope = value.scope === 'session' ? 'session' : value.scope === 'workspace' ? 'workspace' : undefined;
  const sessionId =
    typeof value.sessionId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value.sessionId)
      ? value.sessionId
      : undefined;
  if (scope === 'session' && !sessionId) return null;
  return {
    title: value.title,
    content: value.content,
    ...(scope ? { scope } : {}),
    ...(scope === 'session' && sessionId ? { sessionId } : {}),
  };
}

function localMemoryOpenFailureCopy(reason: string): string {
  switch (reason) {
    case 'incognito_blocked':
      return '隐身模式下不能打开本地 MEMORY.md。';
    case 'disabled':
      return '本地记忆已关闭。';
    case 'missing':
      return 'MEMORY.md 不存在。';
    case 'not-allowed':
      return 'MEMORY.md 不在允许的工作区范围内。';
    case 'not-a-file':
      return 'MEMORY.md 不是普通文件。';
    case 'open-failed':
      return '系统未能打开 MEMORY.md。';
    default:
      return '无法打开 MEMORY.md。';
  }
}

function localMemoryBackupOpenFailureCopy(reason: string): string {
  switch (reason) {
    case 'incognito_blocked':
      return '隐身模式下不能打开本地 MEMORY.md 备份。';
    case 'disabled':
      return '本地记忆关闭时不能打开 MEMORY.md 备份。';
    case 'missing':
      return '还没有可打开的上一版 MEMORY.md 备份。';
    case 'not-allowed':
      return 'MEMORY.md 备份不在允许的工作区范围内。';
    case 'not-a-file':
      return 'MEMORY.md 备份不是普通文件。';
    case 'open-failed':
      return '系统未能打开 MEMORY.md 备份。';
    default:
      return '无法打开 MEMORY.md 备份。';
  }
}
