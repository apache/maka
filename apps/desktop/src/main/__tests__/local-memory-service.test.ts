import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it } from 'node:test';
import { createDefaultSettings, type AppSettings } from '@maka/core';
import { LocalMemoryService } from '../local-memory-service.js';
import { createSystemPromptMainService } from '../system-prompt-main.js';

function makeService(now = 1_700_000_000_000) {
  return async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-memory-'));
    let settings = createDefaultSettings();
    const service = new LocalMemoryService({
      workspaceRoot,
      now: () => now,
      getSettings: async () => settings,
      updateSettings: async (patch: { localMemory: Partial<AppSettings['localMemory']> }) => {
        settings = {
          ...settings,
          localMemory: { ...settings.localMemory, ...patch.localMemory },
        };
        return settings;
      },
      getPrivacyContext: async () => ({ incognitoActive: false }),
    });
    return { service, workspaceRoot };
  };
}

describe('LocalMemoryService', () => {
  it('creates MEMORY.md with 0700 directory and 0600 file', async () => {
    const { service } = await makeService()();
    const state = await service.getState();
    assert.equal(state.status, 'ok');
    const dirStat = await stat(service.dir);
    const fileStat = await stat(service.file);
    assert.equal(dirStat.mode & 0o777, 0o700);
    assert.equal(fileStat.mode & 0o777, 0o600);
  });

  it('saves content and keeps a backup', async () => {
    const { service } = await makeService()();
    await service.getState();
    const next = [
      '# Maka Memory',
      '',
      '## 偏好',
      '<!-- maka-memory: id=pref-1 origin=manual createdAt=1700000000000 -->',
      '喜欢短回答。',
      '',
    ].join('\n');
    const state = await service.save(next);
    assert.equal(state.entryCount, 1);
    assert.equal(state.activeEntryCount, 1);
    assert.equal(state.archivedEntryCount, 0);
    assert.equal(state.entries.length, 1);
    assert.equal(state.activeEntries.length, 1);
    assert.equal(state.archivedEntries.length, 0);
    assert.equal(state.latestBackup?.kind, 'save');
    assert.match(state.latestBackup?.path ?? '', /MEMORY\.md\.bak$/);
    assert.equal(typeof state.latestBackup?.updatedAt, 'number');
    assert.equal(state.latestBackup?.activeEntryCount, 1);
    assert.equal(state.latestBackup?.archivedEntryCount, 0);
    assert.equal(state.latestBackup?.safeMode, false);
    assert.ok((state.latestBackup?.sizeBytes ?? 0) > 0);
    assert.match(await readFile(service.file, 'utf8'), /喜欢短回答/);
    assert.match(await readFile(`${service.file}.bak`, 'utf8'), /示例/);
  });

  it('restores the latest backup while preserving the current file as restore backup', async () => {
    const { service } = await makeService()();
    await service.getState();
    await service.save([
      '# Maka Memory',
      '',
      '## First',
      '<!-- maka-memory: id=first origin=manual createdAt=1700000000000 -->',
      '第一版。',
      '',
    ].join('\n'));
    await service.save([
      '# Maka Memory',
      '',
      '## Second',
      '<!-- maka-memory: id=second origin=manual createdAt=1700000000001 -->',
      '第二版。',
      '',
    ].join('\n'));

    const restored = await service.restoreLatestBackup();

    assert.equal(restored.ok, true);
    assert.match(restored.state.content, /第一版/);
    assert.doesNotMatch(restored.state.content, /第二版/);
    assert.match(await readFile(service.file, 'utf8'), /第一版/);
    assert.match(await readFile(`${service.file}.restore.bak`, 'utf8'), /第二版/);
  });

  it('returns a failure envelope when there is no backup to restore', async () => {
    const { service } = await makeService()();
    await service.getState();

    const restored = await service.restoreLatestBackup();

    assert.equal(restored.ok, false);
    assert.match(restored.message, /没有找到上一版 MEMORY\.md 备份/);
    assert.equal(restored.state.status, 'ok');
  });

  it('can restore the reset backup as the latest previous MEMORY.md version', async () => {
    const { service } = await makeService(1_700_000_000_000)();
    await service.save([
      '# Maka Memory',
      '',
      '## Before reset',
      '<!-- maka-memory: id=before-reset origin=manual createdAt=1700000000000 -->',
      '重置前。',
      '',
    ].join('\n'));
    await service.reset();

    const restored = await service.restoreLatestBackup();

    assert.equal(restored.ok, true);
    assert.match(restored.state.content, /重置前/);
    assert.doesNotMatch(restored.state.content, /示例/);
  });

  it('can restore a specific backup candidate by kind', async () => {
    const { service } = await makeService(1_700_000_000_000)();
    await service.save([
      '# Maka Memory',
      '',
      '## First',
      '<!-- maka-memory: id=first origin=manual createdAt=1700000000000 -->',
      '第一版。',
      '',
    ].join('\n'));
    await service.save([
      '# Maka Memory',
      '',
      '## Second',
      '<!-- maka-memory: id=second origin=manual createdAt=1700000000001 -->',
      '第二版。',
      '',
    ].join('\n'));

    const restored = await service.restoreBackup('save');

    assert.equal(restored.ok, true);
    assert.match(restored.state.content, /第一版/);
    assert.doesNotMatch(restored.state.content, /第二版/);
  });

  it('surfaces the pre-restore backup as a restorable candidate', async () => {
    const { service } = await makeService(1_700_000_000_000)();
    await service.save([
      '# Maka Memory',
      '',
      '## First',
      '<!-- maka-memory: id=first origin=manual createdAt=1700000000000 -->',
      '第一版。',
      '',
    ].join('\n'));
    await service.save([
      '# Maka Memory',
      '',
      '## Second',
      '<!-- maka-memory: id=second origin=manual createdAt=1700000000001 -->',
      '第二版。',
      '',
    ].join('\n'));

    const restored = await service.restoreBackup('save');
    const restoreBackup = await service.resolveBackupForOpen('restore');

    assert.equal(restored.ok, true);
    assert.equal(restored.state.latestBackup?.kind, 'restore');
    assert.match(restored.state.latestBackup?.path ?? '', /MEMORY\.md\.restore\.bak$/);
    assert.ok(restored.state.backups?.some((backup) => backup.kind === 'restore'));
    assert.equal(restoreBackup.ok, true);
    if (restoreBackup.ok) assert.match(restoreBackup.path, /MEMORY\.md\.restore\.bak$/);
  });

  it('keeps the previous restore undo when restoring twice', async () => {
    const { service } = await makeService(1_700_000_000_000)();
    await service.save([
      '# Maka Memory',
      '',
      '## First',
      '<!-- maka-memory: id=first origin=manual createdAt=1700000000000 -->',
      '第一版。',
      '',
    ].join('\n'));
    await service.save([
      '# Maka Memory',
      '',
      '## Second',
      '<!-- maka-memory: id=second origin=manual createdAt=1700000000001 -->',
      '第二版。',
      '',
    ].join('\n'));

    const firstRestore = await service.restoreBackup('save');
    assert.equal(firstRestore.ok, true);
    assert.match(await readFile(`${service.file}.restore.bak`, 'utf8'), /第二版/);

    await service.save([
      '# Maka Memory',
      '',
      '## Third',
      '<!-- maka-memory: id=third origin=manual createdAt=1700000000002 -->',
      '第三版。',
      '',
    ].join('\n'));
    const secondRestore = await service.restoreBackup('save');

    assert.equal(secondRestore.ok, true);
    assert.match(await readFile(`${service.file}.restore.bak`, 'utf8'), /第三版/);
    assert.match(await readFile(`${service.file}.restore.1.bak`, 'utf8'), /第二版/);
  });

  it('can restore the restore backup without overwriting the selected backup first', async () => {
    const { service } = await makeService(1_700_000_000_000)();
    await service.save([
      '# Maka Memory',
      '',
      '## First',
      '<!-- maka-memory: id=first origin=manual createdAt=1700000000000 -->',
      '第一版。',
      '',
    ].join('\n'));
    await service.save([
      '# Maka Memory',
      '',
      '## Second',
      '<!-- maka-memory: id=second origin=manual createdAt=1700000000001 -->',
      '第二版。',
      '',
    ].join('\n'));
    const firstRestore = await service.restoreBackup('save');
    assert.equal(firstRestore.ok, true);

    const undoRestore = await service.restoreBackup('restore');

    assert.equal(undoRestore.ok, true);
    assert.match(undoRestore.state.content, /第二版/);
    assert.doesNotMatch(undoRestore.state.content, /第一版/);
    assert.match(await readFile(`${service.file}.restore.1.bak`, 'utf8'), /第二版/);
  });

  it('surfaces reset backup metadata so restore is visible before click', async () => {
    const { service } = await makeService(1_700_000_000_000)();
    await service.save([
      '# Maka Memory',
      '',
      '## Before reset',
      '<!-- maka-memory: id=before-reset origin=manual createdAt=1700000000000 -->',
      '重置前。',
      '',
    ].join('\n'));

    const state = await service.reset();

    assert.equal(state.latestBackup?.kind, 'reset');
    assert.match(state.latestBackup?.path ?? '', /MEMORY\.md\.reset\.bak$/);
    assert.equal(typeof state.latestBackup?.updatedAt, 'number');
    assert.equal(state.latestBackup?.activeEntryCount, 1);
    assert.equal(state.latestBackup?.archivedEntryCount, 0);
    assert.equal(state.latestBackup?.safeMode, false);
    assert.ok((state.latestBackup?.sizeBytes ?? 0) > 0);
  });

  it('surfaces all validated MEMORY.md backup candidates without exposing content', async () => {
    const { service } = await makeService(1_700_000_000_000)();
    await service.save([
      '# Maka Memory',
      '',
      '## Before reset',
      '<!-- maka-memory: id=before-reset origin=manual createdAt=1700000000000 -->',
      '重置前。',
      '',
    ].join('\n'));
    const state = await service.reset();

    assert.equal(state.backups?.length, 2);
    assert.deepEqual(new Set(state.backups?.map((backup) => backup.kind)), new Set(['save', 'reset']));
    assert.equal(state.latestBackup?.path, state.backups?.[0]?.path);
    assert.ok(state.backups?.every((backup) => backup.sizeBytes > 0));
    assert.ok(state.backups?.every((backup) => typeof backup.activeEntryCount === 'number'));
    assert.ok(state.backups?.every((backup) => !('content' in backup)));
  });

  it('resolves the latest backup for explicit user inspection', async () => {
    const { service } = await makeService()();
    await service.getState();
    await service.save([
      '# Maka Memory',
      '',
      '## Inspectable',
      '<!-- maka-memory: id=inspectable origin=manual createdAt=1700000000000 -->',
      '可检查。',
      '',
    ].join('\n'));

    const result = await service.resolveLatestBackupForOpen();

    assert.equal(result.ok, true);
    if (result.ok) assert.match(result.path, /MEMORY\.md\.bak$/);
  });

  it('resolves a specific backup candidate by kind for explicit user inspection', async () => {
    const { service } = await makeService()();
    await service.save([
      '# Maka Memory',
      '',
      '## Before reset',
      '<!-- maka-memory: id=before-reset origin=manual createdAt=1700000000000 -->',
      '重置前。',
      '',
    ].join('\n'));
    await service.reset();

    const saveBackup = await service.resolveBackupForOpen('save');
    const resetBackup = await service.resolveBackupForOpen('reset');

    assert.equal(saveBackup.ok, true);
    assert.equal(resetBackup.ok, true);
    if (saveBackup.ok) assert.match(saveBackup.path, /MEMORY\.md\.bak$/);
    if (resetBackup.ok) assert.match(resetBackup.path, /MEMORY\.md\.reset\.bak$/);
  });

  it('does not resolve a backup symlink that escapes the workspace', async () => {
    const { service, workspaceRoot } = await makeService()();
    const outsideRoot = await mkdtemp(join(tmpdir(), 'maka-memory-backup-outside-'));
    await service.getState();
    const outsideFile = join(outsideRoot, 'MEMORY.md.bak');
    await writeFile(outsideFile, '# outside backup\n', 'utf8');
    await symlink(outsideFile, `${service.file}.bak`);

    const result = await service.resolveLatestBackupForOpen();
    const explicitResult = await service.resolveBackupForOpen('save');
    const state = await service.getState();

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'missing');
    assert.equal(explicitResult.ok, false);
    if (!explicitResult.ok) assert.equal(explicitResult.reason, 'missing');
    assert.equal(state.latestBackup, undefined);
    assert.match(service.file, new RegExp(workspaceRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  it('redacts secrets before writing durable MEMORY.md content', async () => {
    const { service } = await makeService()();
    await service.getState();
    const state = await service.save([
      '# Maka Memory',
      '',
      '## Provider token',
      '<!-- maka-memory: id=secret origin=manual createdAt=1700000000000 -->',
      'Authorization: Bearer sk-ant-api03-abc123def456ghi789jkl0mn1opq',
      'URL: https://api.example.test/models?api_key=raw-secret-value&timeout=30',
    ].join('\n'));

    assert.equal(state.status, 'ok');
    assert.doesNotMatch(state.content, /sk-ant-api03|raw-secret-value/);
    assert.match(state.content, /Authorization: Bearer \[redacted\]/);
    assert.match(state.content, /api_key=\[redacted\]/);

    const persisted = await readFile(service.file, 'utf8');
    assert.doesNotMatch(persisted, /sk-ant-api03|raw-secret-value/);
    assert.match(persisted, /Authorization: Bearer \[redacted\]/);
    assert.match(persisted, /api_key=\[redacted\]/);
  });

  it('counts archived entries but previews the latest active entry', async () => {
    const { service } = await makeService()();
    const state = await service.save([
      '# Maka Memory',
      '',
      '## Active',
      '<!-- maka-memory: id=active origin=manual status=active -->',
      'Use this.',
      '',
      '## Archived',
      '<!-- maka-memory: id=archived origin=manual status=archived -->',
      'Do not use this.',
    ].join('\n'));

    assert.equal(state.entryCount, 2);
    assert.equal(state.activeEntryCount, 1);
    assert.equal(state.archivedEntryCount, 1);
    assert.equal(state.activeEntries[0]?.id, 'active');
    assert.equal(state.archivedEntries[0]?.id, 'archived');
    assert.equal(state.latestEntry?.id, 'active');
  });

  it('stores assistant proposals in PENDING.md until approval', async () => {
    const { service } = await makeService(1_700_000_000_000)();

    const proposed = await service.proposeMemory({
      title: 'Tone',
      content: 'Prefer direct answers.',
      sourceTurnId: 'turn-1',
    });

    assert.equal(proposed.ok, true);
    assert.equal((await service.getState()).activeEntryCount, 1); // default example remains the only active MEMORY.md entry.
    assert.match(await readFile(service.pendingFile, 'utf8'), /status=review_required/);
    assert.match(await readFile(service.pendingFile, 'utf8'), /Prefer direct answers/);
    assert.doesNotMatch(await readFile(service.file, 'utf8'), /Prefer direct answers/);
    assert.equal((await service.listProposals()).length, 1);
  });

  it('approves a pending proposal into active MEMORY.md and removes it from the queue', async () => {
    const { service } = await makeService(1_700_000_000_000)();
    const proposed = await service.proposeMemory({
      title: 'Tone',
      content: 'Prefer direct answers.',
      sourceTurnId: 'turn-1',
    });
    assert.equal(proposed.ok, true);
    if (!proposed.ok) return;
    const proposalId = proposed.proposal?.proposalId ?? proposed.proposal?.id;
    assert.ok(proposalId);

    const approved = await service.approveProposal(proposalId);

    assert.equal(approved.ok, true);
    assert.equal(approved.entry?.source, 'chat_extracted');
    assert.equal(approved.entry?.status, 'active');
    assert.equal(approved.entry?.confirmedAt, 1_700_000_000_000);
    assert.match(await readFile(service.file, 'utf8'), /source=chat_extracted/);
    assert.match(await readFile(service.file, 'utf8'), /confirmedAt=1700000000000/);
    assert.match(await readFile(service.file, 'utf8'), /Prefer direct answers/);
    assert.doesNotMatch(await readFile(service.pendingFile, 'utf8'), /Prefer direct answers/);
    assert.equal((await service.listProposals()).length, 0);
    const updates = service.consumePendingPromptUpdates();
    assert.equal(updates.length, 1);
    assert.equal(updates[0]?.action, 'approved');
    assert.equal(updates[0]?.title, 'Tone');
    assert.equal(service.consumePendingPromptUpdates().length, 0);
  });

  it('rejects a pending proposal without creating active memory', async () => {
    const { service } = await makeService(1_700_000_000_000)();
    const proposed = await service.proposeMemory({
      title: 'Tone',
      content: 'Do not save this.',
    });
    assert.equal(proposed.ok, true);
    if (!proposed.ok) return;
    const proposalId = proposed.proposal?.proposalId ?? proposed.proposal?.id;
    assert.ok(proposalId);

    const rejected = await service.rejectProposal(proposalId);

    assert.equal(rejected.ok, true);
    assert.match(await readFile(service.pendingFile, 'utf8'), /status=rejected/);
    assert.match(await readFile(service.pendingFile, 'utf8'), /rejectedAt=1700000000000/);
    assert.doesNotMatch(await readFile(service.file, 'utf8'), /Do not save this/);
    assert.equal((await service.listProposals()).length, 0);
  });

  it('archives and restores entries through the service with lifecycle metadata', async () => {
    const { service } = await makeService(1_700_000_000_000)();
    const remembered = await service.rememberUserAuthored({
      title: 'Tone',
      content: 'Prefer direct answers.',
    });
    assert.equal(remembered.ok, true);
    if (!remembered.ok) return;
    const entryId = remembered.entry?.id;
    assert.ok(entryId);
    assert.equal(service.consumePendingPromptUpdates()[0]?.action, 'remembered');

    const archived = await service.archiveEntry(entryId, 'user requested');
    assert.equal(archived.ok, true);
    assert.equal(archived.entry?.status, 'archived');
    assert.match(await readFile(service.file, 'utf8'), /status=archived/);
    assert.match(await readFile(service.file, 'utf8'), /archivedAt=1700000000000/);
    assert.equal((await service.getState()).activeEntries.some((entry) => entry.id === entryId), false);

    const restored = await service.restoreEntry(entryId);
    assert.equal(restored.ok, true);
    assert.equal(restored.entry?.status, 'active');
    assert.equal((await service.getState()).activeEntries.some((entry) => entry.id === entryId), true);
    const updates = service.consumePendingPromptUpdates();
    assert.deepEqual(updates.map((update) => update.action), ['archived', 'restored']);
    assert.equal(updates[0]?.entryId, entryId);
    assert.equal(updates[1]?.entryId, entryId);
  });

  it('builds session-scoped prompt updates only for their owning session', async () => {
    const { service, workspaceRoot } = await makeService(1_700_000_000_000)();
    const remembered = await service.rememberUserAuthored({
      title: 'Session tone',
      content: 'Prefer direct answers in this session.',
      scope: 'session',
      sessionId: 'session-a',
    });
    assert.equal(remembered.ok, true);

    const prompts = createSystemPromptMainService({
      settingsStore: { get: async () => createDefaultSettings() },
      workspaceRoot,
      localMemory: service,
      taskLedger: { list: async () => [] },
    });
    assert.equal(await prompts.buildTurnTailPrompt(undefined, undefined), undefined);
    assert.equal(await prompts.buildTurnTailPrompt(undefined, 'session-b'), undefined);
    const update = await prompts.buildTurnTailPrompt(undefined, 'session-a');
    assert.match(update ?? '', /<memory-update>/);
    assert.match(update ?? '', /Session tone/);
    assert.equal(await prompts.buildTurnTailPrompt(undefined, 'session-a'), undefined);
  });

  it('blocks proposal and approval mutations while incognito is active', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-memory-incognito-mutate-'));
    const service = new LocalMemoryService({
      workspaceRoot,
      getSettings: async () => createDefaultSettings(),
      updateSettings: async () => createDefaultSettings(),
      getPrivacyContext: async () => ({ incognitoActive: true }),
    });

    const proposed = await service.proposeMemory({ title: 'Blocked', content: 'Do not store.' });
    const remembered = await service.rememberUserAuthored({ title: 'Blocked', content: 'Do not store.' });
    const archived = await service.archiveEntry('mem-missing');

    assert.equal(proposed.ok, false);
    if (!proposed.ok) assert.equal(proposed.reason, 'incognito_active');
    assert.equal(remembered.ok, false);
    if (!remembered.ok) assert.equal(remembered.reason, 'incognito_active');
    assert.equal(archived.ok, false);
    if (!archived.ok) assert.equal(archived.reason, 'incognito_active');
  });

  it('does not write oversized content', async () => {
    const { service } = await makeService()();
    await service.getState();
    const state = await service.save('x'.repeat(200_000));
    assert.equal(state.status, 'safe_mode');
    assert.doesNotMatch(await readFile(service.file, 'utf8'), /^x+$/);
  });

  it('returns incognito_blocked without creating the file', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-memory-incognito-'));
    const service = new LocalMemoryService({
      workspaceRoot,
      getSettings: async () => createDefaultSettings(),
      updateSettings: async () => createDefaultSettings(),
      getPrivacyContext: async () => ({ incognitoActive: true }),
    });
    const state = await service.getState();
    assert.equal(state.status, 'incognito_blocked');
  });

  it('resolves MEMORY.md for opening only after the file is inside the workspace', async () => {
    const { service } = await makeService()();
    const result = await service.resolveFileForOpen();
    assert.equal(result.ok, true);
    if (result.ok) assert.match(result.path, /MEMORY\.md$/);
  });

  it('does not resolve MEMORY.md for opening in incognito mode', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-memory-open-incognito-'));
    const service = new LocalMemoryService({
      workspaceRoot,
      getSettings: async () => createDefaultSettings(),
      updateSettings: async () => createDefaultSettings(),
      getPrivacyContext: async () => ({ incognitoActive: true }),
    });

    assert.deepEqual(await service.resolveFileForOpen(), { ok: false, reason: 'incognito_blocked' });
  });

  it('rejects a symlinked MEMORY.md that escapes the workspace', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-memory-symlink-workspace-'));
    const outsideRoot = await mkdtemp(join(tmpdir(), 'maka-memory-symlink-outside-'));
    await mkdir(join(workspaceRoot, 'memory'), { recursive: true });
    const outsideFile = join(outsideRoot, 'MEMORY.md');
    await writeFile(outsideFile, '# outside\n', 'utf8');
    await symlink(outsideFile, join(workspaceRoot, 'memory', 'MEMORY.md'));
    const service = new LocalMemoryService({
      workspaceRoot,
      getSettings: async () => createDefaultSettings(),
      updateSettings: async () => createDefaultSettings(),
      getPrivacyContext: async () => ({ incognitoActive: false }),
    });

    const state = await service.getState();

    assert.equal(state.status, 'error');
    assert.match(state.reason ?? '', /outside the workspace/);
  });
});
