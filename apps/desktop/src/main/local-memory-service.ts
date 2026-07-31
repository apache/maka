import { chmod, copyFile, mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import {
  appendApprovedLocalMemoryEntryDraft,
  appendLocalMemoryProposalDraft,
  approveLocalMemoryProposalDraft,
  defaultLocalMemoryMarkdown,
  findLocalMemoryEntryDraft,
  normalizeMemoryContent,
  normalizeMemoryScope,
  parseLocalMemoryMarkdown,
  rejectLocalMemoryProposalDraft,
  redactSecrets,
  setLocalMemoryEntryStatusDraft,
  stableLocalMemoryEntryId,
  stableLocalMemoryProposalId,
  validateMemoryWriteRequest,
  type AppSettings,
  type LocalMemoryBackupInfo,
  type LocalMemoryEntryPreview,
  type LocalMemoryScope,
  type LocalMemoryState,
} from '@maka/core';
import type { WorkspacePrivacyContext } from '@maka/core/incognito';

export interface LocalMemoryServiceDeps {
  workspaceRoot: string;
  getSettings(): Promise<AppSettings>;
  updateSettings(patch: { localMemory: Partial<AppSettings['localMemory']> }): Promise<AppSettings>;
  getPrivacyContext(): Promise<WorkspacePrivacyContext>;
  now?(): number;
}

export type LocalMemoryMutationResult =
  | { ok: true; state: LocalMemoryState; entry?: LocalMemoryEntryPreview; proposal?: LocalMemoryEntryPreview }
  | { ok: false; state: LocalMemoryState; reason: string; message: string };
type LocalMemoryMutationBlocked = Extract<LocalMemoryMutationResult, { ok: false }>;

export interface LocalMemoryProposalInput {
  title: string;
  content: string;
  scope?: LocalMemoryScope;
  sessionId?: string;
  sourceTurnId?: string;
}

export interface LocalMemoryRememberInput {
  title: string;
  content: string;
  scope?: LocalMemoryScope;
  sessionId?: string;
}

export type LocalMemoryPromptUpdateAction =
  | 'approved'
  | 'remembered'
  | 'archived'
  | 'restored'
  | 'saved'
  | 'reset'
  | 'backup_restored';

export interface LocalMemoryPromptUpdate {
  action: LocalMemoryPromptUpdateAction;
  entryId?: string;
  title?: string;
  sessionId?: string;
  ts: number;
}

export class LocalMemoryService {
  readonly dir: string;
  readonly file: string;
  readonly pendingFile: string;
  private readonly now: () => number;
  private queue: Promise<unknown> = Promise.resolve();
  private pendingPromptUpdates: LocalMemoryPromptUpdate[] = [];

  constructor(private readonly deps: LocalMemoryServiceDeps) {
    this.dir = join(deps.workspaceRoot, 'memory');
    this.file = join(this.dir, 'MEMORY.md');
    this.pendingFile = join(this.dir, 'PENDING.md');
    this.now = deps.now ?? Date.now;
  }

  consumePendingPromptUpdates(sessionId?: string): ReadonlyArray<LocalMemoryPromptUpdate> {
    const updates: LocalMemoryPromptUpdate[] = [];
    const retained: LocalMemoryPromptUpdate[] = [];
    for (const update of this.pendingPromptUpdates) {
      if (!update.sessionId || update.sessionId === sessionId) updates.push(update);
      else retained.push(update);
    }
    this.pendingPromptUpdates = retained;
    return updates;
  }

  async getState(): Promise<LocalMemoryState> {
    const settings = await this.deps.getSettings();
    if ((await this.deps.getPrivacyContext()).incognitoActive) {
      return {
        path: this.file,
        enabled: settings.localMemory.enabled,
        agentReadEnabled: false,
        status: 'incognito_blocked',
        content: '',
        entryCount: 0,
        activeEntryCount: 0,
        archivedEntryCount: 0,
        entries: [],
        activeEntries: [],
        archivedEntries: [],
        reason: '隐身模式下禁用本地记忆读写。',
      };
    }
    if (!settings.localMemory.enabled) {
      return {
        path: this.file,
        enabled: false,
        agentReadEnabled: settings.localMemory.agentReadEnabled,
        status: 'disabled',
        content: '',
        entryCount: 0,
        activeEntryCount: 0,
        archivedEntryCount: 0,
        entries: [],
        activeEntries: [],
        archivedEntries: [],
      };
    }
    try {
      await this.ensure();
      const content = await readFile(this.file, 'utf8');
      const parsed = parseLocalMemoryMarkdown(content);
      const backups = await this.backupInfos();
      const latestBackup = backups[0];
      if (parsed.safeMode) {
        return {
          path: this.file,
          enabled: true,
          agentReadEnabled: settings.localMemory.agentReadEnabled,
          status: 'safe_mode',
          content,
          entryCount: 0,
          activeEntryCount: 0,
          archivedEntryCount: 0,
          entries: [],
          activeEntries: [],
          archivedEntries: [],
          latestBackup: latestBackup ?? undefined,
          backups,
          reason: parsed.reason,
        };
      }
      return {
        path: this.file,
        enabled: true,
        agentReadEnabled: settings.localMemory.agentReadEnabled,
        status: 'ok',
        content,
        entryCount: parsed.entries.length,
        activeEntryCount: parsed.activeEntries.length,
        archivedEntryCount: parsed.archivedEntries.length,
        entries: parsed.entries,
        activeEntries: parsed.activeEntries,
        archivedEntries: parsed.archivedEntries,
        latestEntry: parsed.activeEntries.at(-1),
        latestBackup: latestBackup ?? undefined,
        backups,
      };
    } catch (error) {
      return {
        path: this.file,
        enabled: true,
        agentReadEnabled: settings.localMemory.agentReadEnabled,
        status: 'error',
        content: '',
        entryCount: 0,
        activeEntryCount: 0,
        archivedEntryCount: 0,
        entries: [],
        activeEntries: [],
        archivedEntries: [],
        reason: error instanceof Error ? error.message : 'memory read failed',
      };
    }
  }

  async save(content: string): Promise<LocalMemoryState> {
    if ((await this.deps.getPrivacyContext()).incognitoActive) {
      return this.getState();
    }
    const redactedContent = redactSecrets(content);
    const parsed = parseLocalMemoryMarkdown(redactedContent);
    if (parsed.safeMode) {
      return {
        path: this.file,
        enabled: true,
        agentReadEnabled: (await this.deps.getSettings()).localMemory.agentReadEnabled,
        status: 'safe_mode',
        content: redactedContent,
        entryCount: 0,
        activeEntryCount: 0,
        archivedEntryCount: 0,
        entries: [],
        activeEntries: [],
        archivedEntries: [],
        reason: parsed.reason,
      };
    }
    await this.enqueue(async () => {
      await this.ensure();
      await this.backup('bak');
      const tmp = `${this.file}.${this.now()}.tmp`;
      await writeFile(tmp, redactedContent, { mode: 0o600 });
      await rename(tmp, this.file);
      await chmod(this.file, 0o600);
    });
    this.recordPromptUpdate('saved');
    return this.getState();
  }

  async listProposals(): Promise<ReadonlyArray<LocalMemoryEntryPreview>> {
    const state = await this.getState();
    if (state.status !== 'ok') return [];
    const content = await this.readPendingContent();
    const parsed = parseLocalMemoryMarkdown(content);
    if (parsed.safeMode) return [];
    return parsed.entries.filter((entry) => entry.status === 'draft' || entry.status === 'review_required');
  }

  async proposeMemory(input: LocalMemoryProposalInput): Promise<LocalMemoryMutationResult> {
    const gate = await this.requireMutationAllowed();
    if (!gate.ok) return gate;

    const now = this.now();
    const content = normalizeMemoryContent(input.content);
    if (!content.ok) return this.mutationBlocked(content.reason, content.message);
    const scope = normalizeMemoryScope(input.scope ?? 'workspace');
    if (!scope.ok) return this.mutationBlocked(scope.reason, scope.message);

    const proposalId = stableLocalMemoryProposalId(content.value, now);
    let proposal: LocalMemoryEntryPreview | undefined;
    const result = await this.enqueue(async () => {
      await this.ensure();
      const current = await this.readPendingContent();
      const draft = appendLocalMemoryProposalDraft(current, {
        proposalId,
        title: input.title,
        content: redactSecrets(content.value),
        scope: scope.value,
        sessionId: input.sessionId,
        sourceTurnId: input.sourceTurnId,
        proposedAt: now,
      });
      if (!draft.ok) return draft;
      await this.writePendingContent(draft.draft);
      const parsed = parseLocalMemoryMarkdown(draft.draft);
      proposal = parsed.entries.find((entry) => entry.proposalId === proposalId || entry.id === proposalId);
      return draft;
    });
    if (!result.ok) return this.mutationBlocked(result.reason, localMemoryMutationFailureMessage(result.reason));
    return { ok: true, state: await this.getState(), proposal };
  }

  async rememberUserAuthored(input: LocalMemoryRememberInput): Promise<LocalMemoryMutationResult> {
    const gate = await this.requireMutationAllowed();
    if (!gate.ok) return gate;

    const now = this.now();
    const validation = validateMemoryWriteRequest(
      {
        source: 'user_authored',
        persistenceState: 'active',
        content: input.content,
        scope: input.scope ?? 'workspace',
        confirmedAt: now,
      },
      { mode: 'manual_with_drafts', incognitoActive: gate.privacy.incognitoActive, originatedFromRenderer: false, now },
    );
    if (!validation.ok) return this.mutationBlocked(validation.reason, validation.message);

    const entryId = stableLocalMemoryEntryId(validation.value.content, now);
    const result = await this.enqueue(async () => {
      await this.ensure();
      await this.backup('bak');
      const current = await readFile(this.file, 'utf8');
      const draft = appendApprovedLocalMemoryEntryDraft(current, {
        id: entryId,
        title: input.title,
        content: redactSecrets(validation.value.content),
        source: 'user_authored',
        scope: input.scope ?? 'workspace',
        sessionId: input.sessionId,
        confirmedAt: now,
        approvalSurface: 'manual_editor_save',
      });
      if (!draft.ok) return draft;
      await this.writeMemoryContent(draft.draft);
      return draft;
    });
    if (!result.ok) return this.mutationBlocked(result.reason, localMemoryMutationFailureMessage(result.reason));
    const state = await this.getState();
    const entry = state.activeEntries.find((candidate) => candidate.id === entryId);
    this.recordPromptUpdate('remembered', entry, entryId);
    return { ok: true, state, entry };
  }

  async approveProposal(proposalId: string): Promise<LocalMemoryMutationResult> {
    const gate = await this.requireMutationAllowed();
    if (!gate.ok) return gate;

    const now = this.now();
    let approvedEntry: LocalMemoryEntryPreview | undefined;
    const result = await this.enqueue(async () => {
      await this.ensure();
      const memoryContent = await readFile(this.file, 'utf8');
      const pendingContent = await this.readPendingContent();
      const proposal = findLocalMemoryEntryDraft(pendingContent, proposalId);
      if (!proposal) return { ok: false as const, reason: 'not_found' as const };
      if (proposal.status !== 'draft' && proposal.status !== 'review_required') {
        return { ok: false as const, reason: 'not_pending' as const };
      }
      const validation = validateMemoryWriteRequest(
        {
          source: 'chat_extracted',
          persistenceState: 'active',
          content: proposal.content,
          scope: proposal.scope ?? 'workspace',
          confirmedAt: now,
          sourceTurnId: proposal.sourceTurnId,
        },
        { mode: 'manual_with_drafts', incognitoActive: gate.privacy.incognitoActive, originatedFromRenderer: false, now },
      );
      if (!validation.ok) return { ok: false as const, reason: validation.reason };
      await this.backup('bak');
      const entryId = stableLocalMemoryEntryId(validation.value.content, now);
      const approved = approveLocalMemoryProposalDraft(memoryContent, pendingContent, {
        proposalId,
        entryId,
        confirmedAt: now,
        approvalSurface: 'settings_review_queue',
      });
      if (!approved.ok) return approved;
      await this.writeMemoryContent(approved.memoryDraft);
      await this.writePendingContent(approved.pendingDraft);
      approvedEntry = approved.entry;
      return approved;
    });
    if (!result.ok) return this.mutationBlocked(result.reason, localMemoryMutationFailureMessage(result.reason));
    this.recordPromptUpdate('approved', approvedEntry);
    return { ok: true, state: await this.getState(), entry: approvedEntry };
  }

  async rejectProposal(proposalId: string): Promise<LocalMemoryMutationResult> {
    const gate = await this.requireMutationAllowed();
    if (!gate.ok) return gate;

    const result = await this.enqueue(async () => {
      await this.ensure();
      const current = await this.readPendingContent();
      const rejected = rejectLocalMemoryProposalDraft(current, { proposalId, rejectedAt: this.now() });
      if (!rejected.ok) return rejected;
      await this.writePendingContent(rejected.draft);
      return rejected;
    });
    if (!result.ok) return this.mutationBlocked(result.reason, localMemoryMutationFailureMessage(result.reason));
    return { ok: true, state: await this.getState() };
  }

  async archiveEntry(entryId: string, archiveReason?: string): Promise<LocalMemoryMutationResult> {
    return this.updateEntryStatus(entryId, 'archived', archiveReason);
  }

  async restoreEntry(entryId: string): Promise<LocalMemoryMutationResult> {
    return this.updateEntryStatus(entryId, 'active');
  }

  async reset(): Promise<LocalMemoryState> {
    if ((await this.deps.getPrivacyContext()).incognitoActive) {
      return this.getState();
    }
    await this.enqueue(async () => {
      await this.ensure();
      await this.backup('reset.bak');
      await writeFile(this.file, defaultLocalMemoryMarkdown(this.now()), { mode: 0o600 });
      await chmod(this.file, 0o600);
    });
    this.recordPromptUpdate('reset');
    return this.getState();
  }

  async restoreLatestBackup(): Promise<
    { ok: true; state: LocalMemoryState } | { ok: false; state: LocalMemoryState; message: string }
  > {
    return this.restoreBackupBySelector(() => this.requireLatestBackupInfo());
  }

  async restoreBackup(kind: LocalMemoryBackupInfo['kind']): Promise<
    { ok: true; state: LocalMemoryState } | { ok: false; state: LocalMemoryState; message: string }
  > {
    return this.restoreBackupBySelector(async () => {
      const backup = (await this.backupInfos()).find((candidate) => candidate.kind === kind);
      if (!backup) {
        const error = new Error('没有找到指定的 MEMORY.md 备份。') as Error & { code: string };
        error.code = 'ENOENT';
        throw error;
      }
      return backup;
    });
  }

  private async restoreBackupBySelector(
    selectBackup: () => Promise<LocalMemoryBackupInfo>,
  ): Promise<{ ok: true; state: LocalMemoryState } | { ok: false; state: LocalMemoryState; message: string }> {
    if ((await this.deps.getPrivacyContext()).incognitoActive) {
      return { ok: false, state: await this.getState(), message: '隐身模式下不能恢复 MEMORY.md。' };
    }
    if (!(await this.deps.getSettings()).localMemory.enabled) {
      return { ok: false, state: await this.getState(), message: '本地记忆关闭时不能恢复 MEMORY.md。' };
    }
    try {
      await this.enqueue(async () => {
        await this.ensure();
        const backupInfo = await selectBackup();
        const [root, backup] = await Promise.all([
          realpath(this.deps.workspaceRoot),
          realpath(backupInfo.path),
        ]);
        if (!isInsideOrSamePath(root, backup)) {
          throw new Error('MEMORY.md backup is outside the workspace.');
        }
        const backupStat = await stat(backup);
        if (!backupStat.isFile()) {
          throw new Error('MEMORY.md backup is not a file.');
        }
        const backupContent = await readFile(backup);
        await this.backupRestoreUndo();
        await writeFile(this.file, backupContent, { mode: 0o600 });
        await chmod(this.file, 0o600);
      });
      this.recordPromptUpdate('backup_restored');
      return { ok: true, state: await this.getState() };
    } catch (error) {
      return {
        ok: false,
        state: await this.getState(),
        message: backupRestoreFailureMessage(error),
      };
    }
  }

  private async latestBackupInfo(): Promise<LocalMemoryBackupInfo | null> {
    return (await this.backupInfos())[0] ?? null;
  }

  private async backupInfos(): Promise<ReadonlyArray<LocalMemoryBackupInfo>> {
    type BackupCandidate = LocalMemoryBackupInfo & { priority: number };
    const root = await realpath(this.deps.workspaceRoot);
    const candidates: Array<BackupCandidate | null> = await Promise.all(
      [
        { path: `${this.file}.bak`, priority: 0, kind: 'save' as const },
        { path: `${this.file}.reset.bak`, priority: 1, kind: 'reset' as const },
        { path: `${this.file}.restore.bak`, priority: 2, kind: 'restore' as const },
      ].map(async (candidate) => {
        const { path, priority, kind } = candidate;
        const backupPath = await realpath(path).catch(() => null);
        if (!backupPath || !isInsideOrSamePath(root, backupPath)) return null;
        const fileStat = await stat(backupPath).catch(() => null);
        if (!fileStat?.isFile()) return null;
        const parsed = parseLocalMemoryMarkdown(await readFile(backupPath, 'utf8'));
        return {
          path: backupPath,
          updatedAt: Math.round(fileStat.mtimeMs),
          sizeBytes: fileStat.size,
          entryCount: parsed.safeMode ? 0 : parsed.entries.length,
          activeEntryCount: parsed.safeMode ? 0 : parsed.activeEntries.length,
          archivedEntryCount: parsed.safeMode ? 0 : parsed.archivedEntries.length,
          safeMode: parsed.safeMode,
          reason: parsed.reason,
          priority,
          kind,
        };
      }),
    );
    const latest = candidates
      .filter((candidate): candidate is BackupCandidate => candidate !== null)
      .sort((a, b) => b.updatedAt - a.updatedAt || b.priority - a.priority);
    return latest.map((backup) => ({
      path: backup.path,
      kind: backup.kind,
      updatedAt: backup.updatedAt,
      sizeBytes: backup.sizeBytes,
      entryCount: backup.entryCount,
      activeEntryCount: backup.activeEntryCount,
      archivedEntryCount: backup.archivedEntryCount,
      safeMode: backup.safeMode,
      reason: backup.reason,
    }));
  }

  private async requireLatestBackupInfo(): Promise<LocalMemoryBackupInfo> {
    const latest = await this.latestBackupInfo();
    if (!latest) {
      const error = new Error('没有找到上一版 MEMORY.md 备份。') as Error & { code: string };
      error.code = 'ENOENT';
      throw error;
    }
    return latest;
  }

  private async updateEntryStatus(
    entryId: string,
    status: 'active' | 'archived',
    archiveReason?: string,
  ): Promise<LocalMemoryMutationResult> {
    const gate = await this.requireMutationAllowed();
    if (!gate.ok) return gate;

    const result = await this.enqueue(async () => {
      await this.ensure();
      await this.backup('bak');
      const current = await readFile(this.file, 'utf8');
      const updated = setLocalMemoryEntryStatusDraft(current, {
        id: entryId,
        status,
        now: this.now(),
        archiveReason,
        recordLifecycleMetadata: true,
      });
      if (!updated.ok) return updated;
      await this.writeMemoryContent(updated.draft);
      return updated;
    });
    if (!result.ok) return this.mutationBlocked(result.reason, localMemoryMutationFailureMessage(result.reason));
    const state = await this.getState();
    const entries = status === 'active' ? state.activeEntries : state.archivedEntries;
    const entry = entries.find((candidate) => candidate.id === entryId);
    this.recordPromptUpdate(status === 'active' ? 'restored' : 'archived', entry, entryId);
    return { ok: true, state, entry };
  }

  async setEnabled(enabled: boolean): Promise<LocalMemoryState> {
    await this.deps.updateSettings({ localMemory: { enabled } });
    if (enabled) await this.ensure();
    return this.getState();
  }

  async setAgentReadEnabled(agentReadEnabled: boolean): Promise<LocalMemoryState> {
    await this.deps.updateSettings({ localMemory: { agentReadEnabled } });
    return this.getState();
  }

  async resolveFileForOpen(): Promise<
    | { ok: true; path: string }
    | { ok: false; reason: 'incognito_blocked' | 'disabled' | 'missing' | 'not-allowed' | 'not-a-file' }
  > {
    const settings = await this.deps.getSettings();
    if ((await this.deps.getPrivacyContext()).incognitoActive) {
      return { ok: false, reason: 'incognito_blocked' };
    }
    if (!settings.localMemory.enabled) return { ok: false, reason: 'disabled' };

    await this.ensure();

    let root: string;
    let target: string;
    try {
      [root, target] = await Promise.all([
        realpath(this.deps.workspaceRoot),
        realpath(this.file),
      ]);
    } catch {
      return { ok: false, reason: 'missing' };
    }

    if (!isInsideOrSamePath(root, target)) return { ok: false, reason: 'not-allowed' };

    const targetStat = await stat(target).catch(() => null);
    if (!targetStat) return { ok: false, reason: 'missing' };
    if (!targetStat.isFile()) return { ok: false, reason: 'not-a-file' };

    return { ok: true, path: target };
  }

  async resolveLatestBackupForOpen(): Promise<
    | { ok: true; path: string }
    | { ok: false; reason: 'incognito_blocked' | 'disabled' | 'missing' | 'not-allowed' | 'not-a-file' }
  > {
    const settings = await this.deps.getSettings();
    if ((await this.deps.getPrivacyContext()).incognitoActive) {
      return { ok: false, reason: 'incognito_blocked' };
    }
    if (!settings.localMemory.enabled) return { ok: false, reason: 'disabled' };

    await this.ensure();

    try {
      const backup = await this.requireLatestBackupInfo();
      const backupStat = await stat(backup.path).catch(() => null);
      if (!backupStat) return { ok: false, reason: 'missing' };
      if (!backupStat.isFile()) return { ok: false, reason: 'not-a-file' };
      return { ok: true, path: backup.path };
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
        return { ok: false, reason: 'missing' };
      }
      return { ok: false, reason: 'not-allowed' };
    }
  }

  async resolveBackupForOpen(kind: LocalMemoryBackupInfo['kind']): Promise<
    | { ok: true; path: string }
    | { ok: false; reason: 'incognito_blocked' | 'disabled' | 'missing' | 'not-allowed' | 'not-a-file' }
  > {
    const settings = await this.deps.getSettings();
    if ((await this.deps.getPrivacyContext()).incognitoActive) {
      return { ok: false, reason: 'incognito_blocked' };
    }
    if (!settings.localMemory.enabled) return { ok: false, reason: 'disabled' };

    await this.ensure();

    const backup = (await this.backupInfos()).find((candidate) => candidate.kind === kind);
    if (!backup) return { ok: false, reason: 'missing' };

    const backupStat = await stat(backup.path).catch(() => null);
    if (!backupStat) return { ok: false, reason: 'missing' };
    if (!backupStat.isFile()) return { ok: false, reason: 'not-a-file' };
    return { ok: true, path: backup.path };
  }

  private async ensure(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const root = await realpath(this.deps.workspaceRoot);
    const dir = await realpath(this.dir);
    if (!isInsideOrSamePath(root, dir)) {
      throw new Error('MEMORY.md directory is outside the workspace.');
    }
    await chmod(dir, 0o700);
    try {
      await stat(this.file);
    } catch {
      await writeFile(this.file, defaultLocalMemoryMarkdown(this.now()), { mode: 0o600 });
    }
    const file = await realpath(this.file);
    if (!isInsideOrSamePath(root, file)) {
      throw new Error('MEMORY.md file is outside the workspace.');
    }
    const fileStat = await stat(file);
    if (!fileStat.isFile()) {
      throw new Error('MEMORY.md is not a file.');
    }
    await chmod(file, 0o600);
  }

  private async readPendingContent(): Promise<string> {
    await this.ensure();
    try {
      const root = await realpath(this.deps.workspaceRoot);
      const pending = await realpath(this.pendingFile);
      if (!isInsideOrSamePath(root, pending)) throw new Error('PENDING.md file is outside the workspace.');
      const pendingStat = await stat(pending);
      if (!pendingStat.isFile()) throw new Error('PENDING.md is not a file.');
      await chmod(pending, 0o600);
      return readFile(pending, 'utf8');
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
        return '# Maka Pending Memory\n';
      }
      throw error;
    }
  }

  private async writePendingContent(content: string): Promise<void> {
    const redactedContent = redactSecrets(content);
    const parsed = parseLocalMemoryMarkdown(redactedContent);
    if (parsed.safeMode) throw new Error(parsed.reason ?? 'pending memory safe mode');
    const tmp = `${this.pendingFile}.${this.now()}.tmp`;
    await writeFile(tmp, redactedContent, { mode: 0o600 });
    await rename(tmp, this.pendingFile);
    await chmod(this.pendingFile, 0o600);
  }

  private async writeMemoryContent(content: string): Promise<void> {
    const redactedContent = redactSecrets(content);
    const parsed = parseLocalMemoryMarkdown(redactedContent);
    if (parsed.safeMode) throw new Error(parsed.reason ?? 'memory safe mode');
    const tmp = `${this.file}.${this.now()}.tmp`;
    await writeFile(tmp, redactedContent, { mode: 0o600 });
    await rename(tmp, this.file);
    await chmod(this.file, 0o600);
  }

  private async requireMutationAllowed(): Promise<LocalMemoryMutationBlocked | { ok: true; privacy: WorkspacePrivacyContext }> {
    const [settings, privacy] = await Promise.all([
      this.deps.getSettings(),
      this.deps.getPrivacyContext(),
    ]);
    if (privacy.incognitoActive) {
      return this.mutationBlocked('incognito_active', '隐身模式下禁用本地记忆写入。');
    }
    if (!settings.localMemory.enabled) {
      return this.mutationBlocked('disabled', '本地记忆关闭时不能写入记忆。');
    }
    return { ok: true, privacy };
  }

  private recordPromptUpdate(
    action: LocalMemoryPromptUpdateAction,
    entry?: LocalMemoryEntryPreview,
    fallbackEntryId?: string,
  ): void {
    this.pendingPromptUpdates.push({
      action,
      ts: this.now(),
      ...(entry?.id || fallbackEntryId ? { entryId: entry?.id ?? fallbackEntryId } : {}),
      ...(entry?.title ? { title: entry.title } : {}),
      ...(entry?.scope === 'session' && entry.sessionId ? { sessionId: entry.sessionId } : {}),
    });
    if (this.pendingPromptUpdates.length > 50) {
      this.pendingPromptUpdates = this.pendingPromptUpdates.slice(-50);
    }
  }

  private async mutationBlocked(reason: string, message: string): Promise<LocalMemoryMutationBlocked> {
    return { ok: false, state: await this.getState(), reason, message };
  }

  private async backup(suffix: string): Promise<void> {
    try {
      await copyFile(this.file, `${this.file}.${suffix}`);
      await chmod(`${this.file}.${suffix}`, 0o600);
    } catch {
      // No prior file to back up.
    }
  }

  private async backupRestoreUndo(): Promise<void> {
    await this.rotateRestoreBackupHistory();
    await this.backup('restore.bak');
  }

  private async rotateRestoreBackupHistory(): Promise<void> {
    const maxRestoreHistory = 5;
    for (let index = maxRestoreHistory - 1; index >= 1; index -= 1) {
      await rename(
        `${this.file}.restore.${index}.bak`,
        `${this.file}.restore.${index + 1}.bak`,
      ).catch(() => {});
    }
    await rename(`${this.file}.restore.bak`, `${this.file}.restore.1.bak`).catch(() => {});
  }

  private async enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.catch(() => undefined).then(task);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

function isInsideOrSamePath(root: string, target: string): boolean {
  if (target === root) return true;
  const rel = relative(root, target);
  return rel !== '' && !rel.startsWith('..') && rel !== '..' && !rel.includes(`..${sep}`) && !rel.startsWith(sep);
}

function backupRestoreFailureMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
    return '没有找到上一版 MEMORY.md 备份。';
  }
  return error instanceof Error ? error.message : 'memory backup restore failed';
}

function localMemoryMutationFailureMessage(reason: string): string {
  switch (reason) {
    case 'invalid_id':
      return '记忆 ID 无效。';
    case 'invalid_session_id':
      return '会话记忆缺少有效的会话标识。';
    case 'empty_title':
      return '标题不能为空。';
    case 'empty_content':
    case 'content_invalid':
      return '内容不能为空或超过长度限制。';
    case 'not_found':
      return '找不到这条记忆。';
    case 'not_pending':
      return '这条记忆不在待审核状态。';
    case 'oversize':
      return 'MEMORY.md 超出安全上限。';
    case 'mode_off':
      return '记忆功能未开启。';
    case 'incognito_active':
      return '隐身模式下禁用本地记忆写入。';
    default:
      return '记忆写入被拦截。';
  }
}
