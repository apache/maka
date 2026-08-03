import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createSessionStore } from '../session-store.js';
import {
  createOperationalStateBackup,
  restoreOperationalStateBackup,
  validateOperationalStateBackup,
} from '../operational-state-backup.js';

test('backs up and restores runtime.sqlite plus artifact bytes', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-operational-backup-'));
  const stateRoot = join(base, 'state');
  const backupRoot = join(base, 'backup');
  const restoreRoot = join(base, 'restore');
  const sessions = createSessionStore(stateRoot);
  try {
    const session = await sessions.create({
      cwd: '/tmp/cwd',
      backend: 'fake',
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
      name: 'Backup',
      labels: [],
    });
    await sessions.appendMessage(session.id, {
      type: 'user',
      id: 'message-1',
      turnId: 'turn-1',
      ts: 1,
      text: 'durable',
    });
    await sessions.close?.();
    await mkdir(join(stateRoot, 'artifacts'), { recursive: true });
    await writeFile(join(stateRoot, 'artifacts', 'note.txt'), 'artifact');

    await createOperationalStateBackup({ stateRoot, destinationRoot: backupRoot, now: () => 10 });
    assert.equal((await validateOperationalStateBackup(backupRoot)).createdAt, 10);
    await restoreOperationalStateBackup({ backupRoot, destinationRoot: restoreRoot });

    const restored = createSessionStore(restoreRoot);
    try {
      assert.equal((await restored.readMessages(session.id))[0]?.id, 'message-1');
      assert.equal(await readFile(join(restoreRoot, 'artifacts', 'note.txt'), 'utf8'), 'artifact');
    } finally {
      await restored.close?.();
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
