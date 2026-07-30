import { ipcMain, shell } from 'electron';
import { copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  isCollaborationMode,
  type ArtifactSaveResult,
  type CollaborationMode,
} from '@maka/core';
import type {
  HostCapabilities,
  InvocableSkillEntry,
  SkillSelectionReport,
} from '@maka/runtime';
import { createArtifactStore, resolveArtifactPath } from '@maka/storage';
import type { createMainWindowController } from './main-window.js';
import {
  createStarterSkill,
  deleteSkill,
  getSkillGovernanceDetails,
  installBundledSkill,
  installManagedSkill,
  listBundledSkillCatalog,
  listGovernedSkillEntries,
  previewManagedSkillUpdate,
  resolveSkillOpenPath,
  setSkillEnabled,
  setSkillPinned,
  toSkillEntry,
  updateManagedSkill,
} from './skills.js';
import {
  importManagedSkillSource,
  listManagedSkillSources,
  toManagedSkillSourceEntry,
} from './managed-skill-sources.js';

type ArtifactStore = ReturnType<typeof createArtifactStore>;
type MainWindowController = ReturnType<typeof createMainWindowController>;

export interface NewSessionSkillContext {
  llmConnectionSlug?: string;
  model?: string;
  collaborationMode?: CollaborationMode;
}

interface WorkspaceResourcesIpcDeps {
  workspaceRoot: string;
  artifactStore: ArtifactStore;
  mainWindowController: MainWindowController;
  sendToRenderer: MainWindowController['send'];
  listInvocableSkills(
    sessionId?: string,
    newSessionContext?: NewSessionSkillContext,
  ): Promise<InvocableSkillEntry[]>;
  skillHost?: HostCapabilities;
  getCurrentProjectRoot?: () => Promise<string>;
  getSkillSelectionReport?: (cwd: string) => SkillSelectionReport | undefined;
  invalidateSkillSelectionReport?: (cwd: string) => void;
}

export function registerWorkspaceResourcesIpc(deps: WorkspaceResourcesIpcDeps): void {
  ipcMain.handle(
    'app:openArtifactPath',
    async (
      _event,
      artifactId: string,
    ): Promise<
      | { ok: true; opened: string }
      | {
          ok: false;
          reason: 'unknown-key' | 'not-allowed' | 'missing' | 'not-a-directory' | 'open-failed';
        }
    > => {
      const record = await deps.artifactStore.get(artifactId);
      if (!record) return { ok: false, reason: 'missing' };
      if (record.status === 'deleted') return { ok: false, reason: 'missing' };
      const artifactRoot = join(deps.workspaceRoot, 'artifacts');
      const resolved = await resolveArtifactPath({
        artifactRoot,
        relativePath: record.relativePath,
      });
      if (!resolved.ok) {
        if (resolved.reason === 'not_allowed') return { ok: false, reason: 'not-allowed' };
        return { ok: false, reason: 'missing' };
      }
      shell.showItemInFolder(resolved.path);
      return { ok: true, opened: record.name };
    },
  );

  ipcMain.handle('app:saveArtifactAs', async (_event, artifactId: string): Promise<ArtifactSaveResult> => {
    const record = await deps.artifactStore.get(artifactId);
    if (!record) return { ok: false, reason: 'not_found' };
    if (record.status === 'deleted') return { ok: false, reason: 'deleted' };
    const resolved = await resolveArtifactPath({
      artifactRoot: join(deps.workspaceRoot, 'artifacts'),
      relativePath: record.relativePath,
    });
    if (!resolved.ok) {
      if (resolved.reason === 'not_allowed') return { ok: false, reason: 'not_allowed' };
      return { ok: false, reason: 'not_found' };
    }
    const result = await deps.mainWindowController.showSaveDialog({
      title: `另存为 ${record.name}`,
      defaultPath: record.name,
    });
    if (result.canceled || !result.filePath) return { ok: false, reason: 'canceled' };
    try {
      await copyFile(resolved.path, result.filePath);
      return { ok: true, saved: record.name };
    } catch {
      return { ok: false, reason: 'write_failed' };
    }
  });

  ipcMain.handle('artifacts:list', (_event, sessionId: string, opts?: { includeDeleted?: boolean }) =>
    deps.artifactStore.list(sessionId, opts),
  );
  ipcMain.handle('artifacts:get', (_event, artifactId: string) => deps.artifactStore.get(artifactId));
  ipcMain.handle('artifacts:readText', (_event, artifactId: string) => deps.artifactStore.readText(artifactId));
  ipcMain.handle('artifacts:readBinary', (_event, artifactId: string) => deps.artifactStore.readBinary(artifactId));
  ipcMain.handle('artifacts:delete', async (_event, artifactId: string) => {
    const artifact = await deps.artifactStore.get(artifactId);
    if (artifact?.source === 'deep_research') {
      throw new Error('Deep Research artifacts are protected by the durable research ledger');
    }
    if (artifact?.source === 'tool_result_archive') {
      throw new Error('Tool result archives are read-only runtime evidence');
    }
    await deps.artifactStore.delete(artifactId);
    if (artifact) {
      deps.sendToRenderer('artifacts:changed', {
        reason: 'deleted',
        artifactId,
        sessionId: artifact.sessionId,
        ts: Date.now(),
      });
    }
  });

  ipcMain.handle('skills:list', async () => {
    const cwd = await deps.getCurrentProjectRoot?.();
    return listGovernedSkillEntries(
      deps.workspaceRoot,
      {
        ...(cwd ? { cwd } : {}),
        ...(deps.skillHost ? { host: deps.skillHost } : {}),
        ...(cwd && deps.getSkillSelectionReport?.(cwd)
          ? { selectionReport: deps.getSkillSelectionReport(cwd) }
          : {}),
      },
    );
  });
  ipcMain.handle(
    'skills:listInvocable',
    async (_event, sessionId?: unknown, newSessionContext?: unknown) => {
      return deps.listInvocableSkills(
        typeof sessionId === 'string' ? sessionId : undefined,
        normalizeNewSessionSkillContext(newSessionContext),
      );
    },
  );
  ipcMain.handle('skills:catalog:list', async () => {
    return listBundledSkillCatalog(deps.workspaceRoot);
  });
  ipcMain.handle('skills:catalog:install', async (_event, id: string) => {
    const result = await installBundledSkill(deps.workspaceRoot, id);
    if (!result.ok) return result;
    return { ok: true as const, skill: toSkillEntry(result.skill) };
  });
  ipcMain.handle('skills:sources:list', async () => {
    const sources = await listManagedSkillSources();
    return sources.map(toManagedSkillSourceEntry);
  });
  ipcMain.handle('skills:sources:importLocalFile', async () => {
    const result = await deps.mainWindowController.showOpenDialog({
      title: '导入 Skill 来源',
      properties: ['openFile'],
      filters: [
        { name: 'Skill Markdown', extensions: ['md'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) return { ok: false as const, reason: 'cancelled' as const };
    const imported = await importManagedSkillSource({ sourceFile: result.filePaths[0] });
    if (!imported.ok) return imported;
    return { ok: true as const, source: toManagedSkillSourceEntry(imported.source) };
  });
  ipcMain.handle('skills:installManaged', async (_event, sourceId: string) => {
    const result = await installManagedSkill(deps.workspaceRoot, sourceId);
    if (!result.ok) return result;
    return { ok: true as const, skill: toSkillEntry(result.skill) };
  });
  ipcMain.handle('skills:details', async (_event, skillId: string) => {
    return getSkillGovernanceDetails(deps.workspaceRoot, skillId);
  });
  ipcMain.handle('skills:previewUpdate', async (_event, skillId: string) => {
    return previewManagedSkillUpdate(deps.workspaceRoot, skillId);
  });
  ipcMain.handle('skills:updateManaged', async (_event, skillId: string, options?: { force?: boolean; expectedCurrentSha256?: string; expectedSourceSha256?: string }) => {
    const result = await updateManagedSkill(deps.workspaceRoot, skillId, undefined, {
      force: options?.force === true,
      expectedCurrentSha256: options?.expectedCurrentSha256,
      expectedSourceSha256: options?.expectedSourceSha256,
    });
    if (!result.ok) return result;
    return { ok: true as const, skill: toSkillEntry(result.skill) };
  });
  ipcMain.handle('skills:setEnabled', async (_event, skillId: string, enabled: boolean) => {
    const cwd = await deps.getCurrentProjectRoot?.();
    const result = await setSkillEnabled(
      deps.workspaceRoot,
      skillId,
      enabled === true,
      { ...(cwd ? { cwd } : {}), ...(deps.skillHost ? { host: deps.skillHost } : {}) },
    );
    if (result.ok && cwd) deps.invalidateSkillSelectionReport?.(cwd);
    return result;
  });
  ipcMain.handle('skills:setPinned', async (_event, skillRef: string, pinned: boolean) => {
    const cwd = await deps.getCurrentProjectRoot?.();
    const result = await setSkillPinned(
      deps.workspaceRoot,
      skillRef,
      pinned === true,
      { ...(cwd ? { cwd } : {}), ...(deps.skillHost ? { host: deps.skillHost } : {}) },
    );
    if (result.ok && cwd) deps.invalidateSkillSelectionReport?.(cwd);
    return result;
  });
  ipcMain.handle('skills:createStarter', async () => {
    const result = await createStarterSkill(deps.workspaceRoot);
    if (!result.ok) return result;
    return { ok: true as const, created: result.created, skill: toSkillEntry(result.skill), filePath: result.filePath };
  });
  ipcMain.handle('skills:delete', async (_event, idOrRef: string) => {
    // Same cwd plumbing as skills:open — a scope-aware ref only resolves if the
    // delete scans the same project-level discovery dirs the list did.
    const cwd = await deps.getCurrentProjectRoot?.();
    const result = await deleteSkill(deps.workspaceRoot, idOrRef, cwd ? { cwd } : {});
    if (result.ok && cwd) deps.invalidateSkillSelectionReport?.(cwd);
    return result;
  });
  ipcMain.handle('skills:open', async (_event, id: string, target: 'file' | 'directory' = 'file') => {
    const cwd = await deps.getCurrentProjectRoot?.();
    const resolved = await resolveSkillOpenPath(
      deps.workspaceRoot,
      id,
      target,
      cwd ? { cwd } : {},
    );
    if (!resolved.ok) return resolved;
    const error = await shell.openPath(resolved.path);
    if (error) return { ok: false, reason: 'open_failed' as const };
    return { ok: true as const, target: resolved.target };
  });
}

function normalizeNewSessionSkillContext(input: unknown): NewSessionSkillContext | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  const llmConnectionSlug = boundedText(record.llmConnectionSlug, 128);
  const model = boundedText(record.model, 512);
  const collaborationMode = isCollaborationMode(record.collaborationMode)
    ? record.collaborationMode
    : undefined;
  if (!llmConnectionSlug && !model && !collaborationMode) return undefined;
  return {
    ...(llmConnectionSlug ? { llmConnectionSlug } : {}),
    ...(model ? { model } : {}),
    ...(collaborationMode ? { collaborationMode } : {}),
  };
}

function boundedText(input: unknown, maxLength: number): string | undefined {
  if (typeof input !== 'string') return undefined;
  const value = input.trim();
  return value.length > 0 && value.length <= maxLength ? value : undefined;
}
