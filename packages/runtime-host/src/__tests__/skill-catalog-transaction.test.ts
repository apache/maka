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
import { spawn } from 'node:child_process';
import { closeSync, fsyncSync, openSync, writeSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, test } from 'node:test';
import {
  SkillCatalogTransactionError,
  SkillCatalogTransactionWriter,
  snapshotWorkspaceSkillTree,
  type ManagedSkillTransactionArtifacts,
  type SkillCatalogTransactionFailpoint,
} from '../server/skill-catalog-transaction.js';

const roots = new Set<string>();

afterEach(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

test('publish reports unknown after its durable intent and recovery publishes exactly once', async () => {
  const root = await tempRoot();
  const artifacts = managedArtifacts('published');
  const crashing = writer(root, 'after_publish_rename');

  await assert.rejects(
    crashing.publishSkill('alpha', artifacts),
    isTransactionError('commit_outcome_unknown'),
  );
  assert.deepEqual(await readManaged(root, 'alpha'), artifacts);

  const reopened = writer(root);
  await reopened.recover();
  await reopened.recover();
  assert.deepEqual(await readManaged(root, 'alpha'), artifacts);
  assert.deepEqual(await transactionEntries(root), []);
});

test('publish dual-copy crash recovery keeps one target when target and staged next match intent', async () => {
  const root = await tempRoot();
  const artifacts = managedArtifacts('dual-copy');

  await assert.rejects(
    writer(root, 'after_intent').publishSkill('alpha', artifacts),
    isTransactionError('commit_outcome_unknown'),
  );
  const transaction = await onlyTransaction(root);
  await writeManagedDirectory(join(root, 'skills', 'alpha'), artifacts);
  assert.deepEqual(await readManaged(root, 'alpha'), artifacts);
  assert.deepEqual(await readManagedDirectory(join(transaction, 'next')), artifacts);

  const reopened = writer(root);
  await reopened.recover();
  await reopened.recover();
  assert.deepEqual(await readManaged(root, 'alpha'), artifacts);
  assert.deepEqual(await readdir(join(root, 'skills')), ['alpha']);
  assert.deepEqual(await transactionEntries(root), []);
});

for (const changedCopy of ['target', 'staged next'] as const) {
  test(`publish dual-copy crash recovery fails closed when ${changedCopy} mismatches intent next`, async () => {
    const root = await tempRoot();
    const artifacts = managedArtifacts('expected');
    const conflicting = managedArtifacts(`conflicting-${changedCopy.replace(' ', '-')}`);

    await assert.rejects(
      writer(root, 'after_intent').publishSkill('alpha', artifacts),
      isTransactionError('commit_outcome_unknown'),
    );
    const transaction = await onlyTransaction(root);
    const target = join(root, 'skills', 'alpha');
    const next = join(transaction, 'next');
    await writeManagedDirectory(target, changedCopy === 'target' ? conflicting : artifacts);
    if (changedCopy === 'staged next') await writeManagedDirectory(next, conflicting);
    const transactionsBeforeRecovery = await transactionEntries(root);

    await assert.rejects(writer(root).recover(), isTransactionError('persistence_failed'));
    assert.deepEqual(
      await readManagedDirectory(target),
      changedCopy === 'target' ? conflicting : artifacts,
    );
    assert.deepEqual(
      await readManagedDirectory(next),
      changedCopy === 'staged next' ? conflicting : artifacts,
    );
    assert.deepEqual(await transactionEntries(root), transactionsBeforeRecovery);
  });
}

test('publish recovers a durable intent before the directory rename', async () => {
  const root = await tempRoot();
  const artifacts = { skill: '# Starter\n' };

  await assert.rejects(
    writer(root, 'after_intent').publishSkill('starter', artifacts),
    isTransactionError('commit_outcome_unknown'),
  );
  await assert.rejects(readFile(join(root, 'skills', 'starter', 'SKILL.md')), {
    code: 'ENOENT',
  });

  await writer(root).recover();
  assert.equal(
    await readFile(join(root, 'skills', 'starter', 'SKILL.md'), 'utf8'),
    artifacts.skill,
  );
  assert.deepEqual(await transactionEntries(root), []);
});

test('publish recovers after atomic intent rename and before transaction directory sync', async () => {
  const root = await tempRoot();
  const artifacts = { skill: '# Starter\n' };

  await assert.rejects(
    writer(root, 'after_intent_rename_before_directory_sync').publishSkill('starter', artifacts),
    isTransactionError('commit_outcome_unknown'),
  );
  const transaction = await onlyTransaction(root);
  assert.ok((await readdir(transaction)).includes('intent.json'));

  await writer(root).recover();
  assert.equal(
    await readFile(join(root, 'skills', 'starter', 'SKILL.md'), 'utf8'),
    artifacts.skill,
  );
  assert.deepEqual(await transactionEntries(root), []);
});

test('publish recovers after rename and before directory synchronization', async () => {
  const root = await tempRoot();
  const artifacts = { skill: '# Starter\n' };

  await assert.rejects(
    writer(root, 'after_publish_rename_before_directory_sync').publishSkill('starter', artifacts),
    isTransactionError('commit_outcome_unknown'),
  );
  assert.equal(
    await readFile(join(root, 'skills', 'starter', 'SKILL.md'), 'utf8'),
    artifacts.skill,
  );

  await writer(root).recover();
  assert.equal(
    await readFile(join(root, 'skills', 'starter', 'SKILL.md'), 'utf8'),
    artifacts.skill,
  );
  assert.deepEqual(await transactionEntries(root), []);
});

test('publish recovers between skills and transaction directory synchronization', async () => {
  const root = await tempRoot();
  const artifacts = { skill: '# Starter\n' };

  await assert.rejects(
    writer(root, 'after_publish_skills_directory_sync_before_transaction_sync').publishSkill(
      'starter',
      artifacts,
    ),
    isTransactionError('commit_outcome_unknown'),
  );
  assert.equal(
    await readFile(join(root, 'skills', 'starter', 'SKILL.md'), 'utf8'),
    artifacts.skill,
  );
  assert.match((await transactionEntries(root))[0], /^tx-/);

  await writer(root).recover();
  assert.equal(
    await readFile(join(root, 'skills', 'starter', 'SKILL.md'), 'utf8'),
    artifacts.skill,
  );
  assert.deepEqual(await transactionEntries(root), []);
});

test('intent body write failure cleans staging and does not poison recovery', async () => {
  const root = await tempRoot();
  const artifacts = { skill: '# Starter\n' };

  await assert.rejects(
    writer(root, 'after_intent_write_before_file_sync').publishSkill('starter', artifacts),
    isTransactionError('persistence_failed'),
  );
  assert.deepEqual(await transactionEntries(root), []);
  await writer(root).recover();

  await writer(root).publishSkill('starter', artifacts);
  assert.equal(
    await readFile(join(root, 'skills', 'starter', 'SKILL.md'), 'utf8'),
    artifacts.skill,
  );
  assert.deepEqual(await transactionEntries(root), []);
});

test('a process killed before intent publication leaves only a GC-safe pre-intent transaction', async () => {
  if (process.platform === 'win32') return;
  const root = await tempRoot();
  const moduleUrl = new URL('../server/skill-catalog-transaction.js', import.meta.url).href;
  const script = `
    import { SkillCatalogTransactionWriter } from ${JSON.stringify(moduleUrl)};
    const root = process.argv[1];
    const writer = new SkillCatalogTransactionWriter(
      async (operation) => operation(root),
      { failpoint(point) {
        if (point === 'after_intent_write_before_file_sync') process.kill(process.pid, 'SIGKILL');
      } },
    );
    await writer.publishSkill('killed', { skill: '# killed\\n' });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', script, root], {
    stdio: 'ignore',
  });
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    },
  );
  assert.equal(exit.signal, 'SIGKILL');
  const transaction = await onlyTransaction(root);
  assert.deepEqual((await readdir(transaction)).sort(), ['intent.json.tmp', 'next']);
  await writer(root).recover();
  assert.deepEqual(await transactionEntries(root), []);
  await assert.rejects(readFile(join(root, 'skills', 'killed', 'SKILL.md')), { code: 'ENOENT' });
});

for (const failpoint of [
  'after_managed_freeze_rename_before_directory_sync',
  'after_managed_freeze',
] as const) {
  test(`managed replacement recovers from ${failpoint} after freezing the whole directory`, async () => {
    const root = await tempRoot();
    const expected = managedArtifacts('old');
    const next = managedArtifacts('new');
    await createManaged(root, 'managed', expected);

    await assert.rejects(
      writer(root, failpoint).replaceManagedSkill('managed', expected, next),
      isTransactionError('commit_outcome_unknown'),
    );
    await assert.rejects(readManaged(root, 'managed'), { code: 'ENOENT' });
    assert.deepEqual(await readManagedDirectory(await onlyFrozen(root)), expected);
    assert.equal((await readdir(await onlyTransaction(root))).includes('tombstone'), false);

    const reopened = writer(root);
    await reopened.recover();
    await reopened.recover();
    assert.deepEqual(await readManaged(root, 'managed'), next);
    assert.deepEqual(await transactionEntries(root), []);
  });
}

for (const failpoint of [
  'after_managed_publish_rename_before_directory_sync',
  'after_managed_publish_skills_directory_sync_before_transaction_sync',
  'after_managed_publish',
] as const) {
  test(`managed replacement recovers from ${failpoint} after publishing one complete directory`, async () => {
    const root = await tempRoot();
    const expected = managedArtifacts('old');
    const next = managedArtifacts('new');
    await createManaged(root, 'managed', expected);

    await assert.rejects(
      writer(root, failpoint).replaceManagedSkill('managed', expected, next),
      isTransactionError('commit_outcome_unknown'),
    );
    assert.deepEqual(await readManaged(root, 'managed'), next);
    assert.deepEqual(await readManagedDirectory(await onlyFrozen(root)), expected);
    assert.equal((await readdir(await onlyTransaction(root))).includes('tombstone'), false);

    await writer(root).recover();
    assert.deepEqual(await readManaged(root, 'managed'), next);
    assert.deepEqual(await transactionEntries(root), []);
  });
}

test('managed recovery rolls back a frozen old generation when staged next is missing', async () => {
  const root = await tempRoot();
  const expected = managedArtifacts('old');
  const next = managedArtifacts('new');
  await createManaged(root, 'managed', expected);

  await assert.rejects(
    writer(root, 'after_managed_freeze').replaceManagedSkill('managed', expected, next),
    isTransactionError('commit_outcome_unknown'),
  );
  const transaction = await onlyTransaction(root);
  assert.deepEqual(await readManagedDirectory(await onlyFrozen(root)), expected);
  await rm(join(transaction, 'next'), { recursive: true });

  const reopened = writer(root);
  await reopened.recover();
  await reopened.recover();
  assert.deepEqual(await readManaged(root, 'managed'), expected);
  assert.deepEqual(await frozenEntries(root), []);
  assert.deepEqual(await transactionEntries(root), []);
});

test('managed recovery keeps durable next live when its stale frozen generation is missing', async () => {
  const root = await tempRoot();
  const expected = managedArtifacts('old');
  const next = managedArtifacts('new');
  await createManaged(root, 'managed', expected);

  await assert.rejects(
    writer(root, 'after_managed_publish').replaceManagedSkill('managed', expected, next),
    isTransactionError('commit_outcome_unknown'),
  );
  assert.deepEqual(await readManaged(root, 'managed'), next);
  await rm(await onlyFrozen(root), { recursive: true });

  const reopened = writer(root);
  await reopened.recover();
  await reopened.recover();
  assert.deepEqual(await readManaged(root, 'managed'), next);
  assert.deepEqual(await frozenEntries(root), []);
  assert.deepEqual(await transactionEntries(root), []);
});

test('managed recovery removes a frozen duplicate after tombstone handoff is durable', async () => {
  const root = await tempRoot();
  const expected = managedArtifacts('old');
  const next = managedArtifacts('new');
  await createManaged(root, 'managed', expected);

  await assert.rejects(
    writer(root, 'after_managed_publish').replaceManagedSkill('managed', expected, next),
    isTransactionError('commit_outcome_unknown'),
  );
  const transaction = await onlyTransaction(root);
  const frozen = await onlyFrozen(root);
  await writeManagedDirectory(join(transaction, 'tombstone'), expected);
  assert.deepEqual(await readManaged(root, 'managed'), next);
  assert.deepEqual(await readManagedDirectory(frozen), expected);
  assert.deepEqual(await readManagedDirectory(join(transaction, 'tombstone')), expected);

  const reopened = writer(root);
  await reopened.recover();
  await reopened.recover();
  assert.deepEqual(await readManaged(root, 'managed'), next);
  assert.deepEqual(await frozenEntries(root), []);
  assert.deepEqual(await transactionEntries(root), []);
});

for (const changed of ['frozen', 'tombstone'] as const) {
  test(`managed recovery strictly verifies the ${changed} copy when both old generations exist`, async () => {
    const root = await tempRoot();
    const expected = managedArtifacts('old');
    const next = managedArtifacts('new');
    await createManaged(root, 'managed', expected);

    await assert.rejects(
      writer(root, 'after_managed_publish').replaceManagedSkill('managed', expected, next),
      isTransactionError('commit_outcome_unknown'),
    );
    const transaction = await onlyTransaction(root);
    const frozen = await onlyFrozen(root);
    const tombstone = join(transaction, 'tombstone');
    await writeManagedDirectory(tombstone, expected);
    await writeFile(join(changed === 'frozen' ? frozen : tombstone, 'SKILL.md'), '# changed\n');

    await assert.rejects(writer(root).recover(), isTransactionError('persistence_failed'));
    assert.deepEqual(await readManaged(root, 'managed'), next);
    assert.equal(
      await readFile(join(frozen, 'SKILL.md'), 'utf8'),
      changed === 'frozen' ? '# changed\n' : expected.skill,
    );
    assert.equal(
      await readFile(join(tombstone, 'SKILL.md'), 'utf8'),
      changed === 'tombstone' ? '# changed\n' : expected.skill,
    );
    assert.deepEqual(await frozenEntries(root), [basename(frozen)]);
    assert.deepEqual(await transactionEntries(root), [basename(transaction)]);
  });
}

for (const targetState of ['expected', 'absent'] as const) {
  test(`managed recovery fails closed for ${targetState} target with both retained old copies`, async () => {
    const root = await tempRoot();
    const expected = managedArtifacts('old');
    const next = managedArtifacts('new');
    await createManaged(root, 'managed', expected);

    await assert.rejects(
      writer(root, 'after_managed_publish').replaceManagedSkill('managed', expected, next),
      isTransactionError('commit_outcome_unknown'),
    );
    const transaction = await onlyTransaction(root);
    const frozen = await onlyFrozen(root);
    await writeManagedDirectory(join(transaction, 'tombstone'), expected);
    await rm(join(root, 'skills', 'managed'), { recursive: true });
    if (targetState === 'expected') await createManaged(root, 'managed', expected);

    await assert.rejects(writer(root).recover(), isTransactionError('persistence_failed'));
    if (targetState === 'expected') {
      assert.deepEqual(await readManaged(root, 'managed'), expected);
    } else {
      await assert.rejects(readManaged(root, 'managed'), { code: 'ENOENT' });
    }
    assert.deepEqual(await readManagedDirectory(frozen), expected);
    assert.deepEqual(await readManagedDirectory(join(transaction, 'tombstone')), expected);
    assert.deepEqual(await frozenEntries(root), [basename(frozen)]);
    assert.deepEqual(await transactionEntries(root), [basename(transaction)]);
  });
}

test('managed recovery treats expected target plus tombstone as an uncommitted duplicate', async () => {
  const root = await tempRoot();
  const expected = managedArtifacts('old');
  const next = managedArtifacts('new');
  await createManaged(root, 'managed', expected);

  await assert.rejects(
    writer(root, 'after_intent').replaceManagedSkill('managed', expected, next),
    isTransactionError('commit_outcome_unknown'),
  );
  const transaction = await onlyTransaction(root);
  await writeManagedDirectory(join(transaction, 'tombstone'), expected);

  const reopened = writer(root);
  await reopened.recover();
  await reopened.recover();
  assert.deepEqual(await readManaged(root, 'managed'), expected);
  assert.deepEqual(await transactionEntries(root), []);
});

for (const failpoint of [
  'after_managed_handoff_rename_before_directory_sync',
  'after_managed_handoff_transaction_sync_before_skills_sync',
  'after_managed_handoff',
] as const) {
  test(`managed recovery completes post-commit stale-old handoff from ${failpoint}`, async () => {
    const root = await tempRoot();
    const expected = managedArtifacts('old');
    const next = managedArtifacts('new');
    await createManaged(root, 'managed', expected);

    await assert.rejects(
      writer(root, failpoint).replaceManagedSkill('managed', expected, next),
      isTransactionError('commit_outcome_unknown'),
    );
    assert.deepEqual(await readManaged(root, 'managed'), next);
    assert.deepEqual(await frozenEntries(root), []);
    assert.deepEqual(
      await readManagedDirectory(join(await onlyTransaction(root), 'tombstone')),
      expected,
    );

    const reopened = writer(root);
    await reopened.recover();
    await reopened.recover();
    assert.deepEqual(await readManaged(root, 'managed'), next);
    assert.deepEqual(await transactionEntries(root), []);
  });
}

for (const failpoint of [
  'after_gc_handoff_rename_before_directory_sync',
  'after_gc_handoff',
  'during_gc_cleanup',
] as const) {
  test(`managed recovery cleans ${failpoint} without reopening staged artifacts`, async () => {
    const root = await tempRoot();
    const expected = managedArtifacts('old');
    const next = managedArtifacts('new');
    await createManaged(root, 'managed', expected);

    await assert.rejects(
      writer(root, failpoint).replaceManagedSkill('managed', expected, next),
      isTransactionError('commit_outcome_unknown'),
    );
    assert.deepEqual(await readManaged(root, 'managed'), next);
    assert.deepEqual(await frozenEntries(root), []);
    const entries = await transactionEntries(root);
    assert.equal(entries.length, 1);
    assert.match(entries[0], /^gc-/);
    const gcDirectory = join(root, '.maka', 'skill-transactions', entries[0]);
    if (failpoint !== 'during_gc_cleanup') {
      assert.deepEqual(await readManagedDirectory(join(gcDirectory, 'tombstone')), expected);
    }
    if (failpoint === 'during_gc_cleanup') {
      assert.equal(await countTreeEntries(gcDirectory), 12);
    }

    const reopened = writer(root);
    await reopened.recover();
    await reopened.recover();
    assert.deepEqual(await readManaged(root, 'managed'), next);
    assert.deepEqual(await transactionEntries(root), []);
  });
}

test('managed recovery fails closed without overwriting a third-party edit', async () => {
  const root = await tempRoot();
  const expected = managedArtifacts('old');
  const next = managedArtifacts('new');
  await createManaged(root, 'managed', expected);

  await assert.rejects(
    writer(root, 'after_intent').replaceManagedSkill('managed', expected, next),
    isTransactionError('commit_outcome_unknown'),
  );
  const edited = '# edited by somebody else\n';
  await writeFile(join(root, 'skills', 'managed', 'SKILL.md'), edited);

  await assert.rejects(writer(root).recover(), isTransactionError('persistence_failed'));
  assert.equal(await readFile(join(root, 'skills', 'managed', 'SKILL.md'), 'utf8'), edited);
  assert.equal((await readManaged(root, 'managed')).baseline, expected.baseline);
  const entries = await transactionEntries(root);
  assert.equal(entries.length, 1);
  assert.match(entries[0], /^tx-/);

  await assert.rejects(writer(root).recover(), isTransactionError('persistence_failed'));
  assert.equal(await readFile(join(root, 'skills', 'managed', 'SKILL.md'), 'utf8'), edited);
  assert.deepEqual(await transactionEntries(root), entries);
});

test('managed replacement preserves a pre-GC open-fd save and fails before transaction completion', async () => {
  if (process.platform === 'win32') return;
  const root = await tempRoot();
  const expected = managedArtifacts('old');
  const next = managedArtifacts('new');
  await createManaged(root, 'managed', expected);
  const fd = openSync(join(root, 'skills', 'managed', 'SKILL.md'), 'r+');
  const transactionWriter = new SkillCatalogTransactionWriter(
    async (operation) => operation(root),
    {
      failpoint(point) {
        if (point !== 'after_managed_publish') return;
        writeSync(fd, Buffer.from('# open fd edit\n'), 0, 15, 0);
        fsyncSync(fd);
      },
    },
  );
  try {
    await assert.rejects(
      transactionWriter.replaceManagedSkill('managed', expected, next),
      isTransactionError('commit_outcome_unknown'),
    );
  } finally {
    closeSync(fd);
  }

  assert.deepEqual(await readManaged(root, 'managed'), next);
  const frozen = await onlyFrozen(root);
  assert.match(await readFile(join(frozen, 'SKILL.md'), 'utf8'), /^# open fd edit/);
  await assert.rejects(writer(root).recover(), isTransactionError('persistence_failed'));
  assert.deepEqual(await readManaged(root, 'managed'), next);
  assert.match(await readFile(join(frozen, 'SKILL.md'), 'utf8'), /^# open fd edit/);
});

test('managed replacement rejects a stale expected set before creating an intent', async () => {
  const root = await tempRoot();
  const actual = managedArtifacts('actual');
  await createManaged(root, 'managed', actual);

  await assert.rejects(
    writer(root).replaceManagedSkill(
      'managed',
      managedArtifacts('stale'),
      managedArtifacts('next'),
    ),
    isTransactionError('persistence_failed'),
  );
  assert.deepEqual(await readManaged(root, 'managed'), actual);
  assert.deepEqual(await transactionEntries(root), []);
});

test('recovery rejects modified staged artifacts and leaves live files untouched', async () => {
  const root = await tempRoot();
  const expected = managedArtifacts('old');
  const next = managedArtifacts('new');
  await createManaged(root, 'managed', expected);

  await assert.rejects(
    writer(root, 'after_intent').replaceManagedSkill('managed', expected, next),
    isTransactionError('commit_outcome_unknown'),
  );
  const transaction = await onlyTransaction(root);
  await writeFile(join(transaction, 'next', '.maka', 'baseline', 'SKILL.md'), 'tampered');

  await assert.rejects(writer(root).recover(), isTransactionError('persistence_failed'));
  assert.deepEqual(await readManaged(root, 'managed'), expected);
});

test('recovery rejects modified intents by the digest bound into the transaction directory', async () => {
  const root = await tempRoot();
  await assert.rejects(
    writer(root, 'after_intent').publishSkill('alpha', { skill: '# alpha\n' }),
    isTransactionError('commit_outcome_unknown'),
  );
  const transaction = await onlyTransaction(root);
  const intentPath = join(transaction, 'intent.json');
  const intent = JSON.parse(await readFile(intentPath, 'utf8')) as Record<string, unknown>;
  intent.skillId = 'beta';
  await writeFile(intentPath, `${JSON.stringify(intent)}\n`);

  await assert.rejects(writer(root).recover(), isTransactionError('persistence_failed'));
  await assert.rejects(readFile(join(root, 'skills', 'alpha', 'SKILL.md')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(root, 'skills', 'beta', 'SKILL.md')), { code: 'ENOENT' });
});

test('managed recovery rejects symlinks without following them', async () => {
  if (process.platform === 'win32') return;
  const root = await tempRoot();
  const expected = managedArtifacts('old');
  const next = managedArtifacts('new');
  await createManaged(root, 'managed', expected);

  await assert.rejects(
    writer(root, 'after_intent').replaceManagedSkill('managed', expected, next),
    isTransactionError('commit_outcome_unknown'),
  );
  const transaction = await onlyTransaction(root);
  await rm(join(transaction, 'next', 'SKILL.md'));
  await symlink(join(root, 'skills', 'managed', 'SKILL.md'), join(transaction, 'next', 'SKILL.md'));

  await assert.rejects(writer(root).recover(), isTransactionError('persistence_failed'));
  assert.deepEqual(await readManaged(root, 'managed'), expected);
});

test('workspace deletion recovers a tombstone rename and is idempotent', async () => {
  const root = await tempRoot();
  const directory = join(root, 'skills', 'workspace-skill');
  await mkdir(join(directory, 'references'), { recursive: true });
  await writeFile(join(directory, 'SKILL.md'), '# workspace\n');
  await writeFile(join(directory, 'references', 'notes.txt'), 'notes\n');
  await writeFile(join(directory, '__proto__'), 'ordinary file\n');

  await assert.rejects(
    deleteWorkspaceSkill(writer(root, 'after_delete_rename'), root, 'workspace-skill'),
    isTransactionError('commit_outcome_unknown'),
  );
  await assert.rejects(readFile(join(directory, 'SKILL.md')), { code: 'ENOENT' });

  const reopened = writer(root);
  await reopened.recover();
  await reopened.recover();
  await assert.rejects(readFile(join(directory, 'SKILL.md')), { code: 'ENOENT' });
  assert.deepEqual(await transactionEntries(root), []);
});

test('delete dual-copy crash recovery removes a recreated target matching the tombstone', async () => {
  const root = await tempRoot();
  const artifacts = managedArtifacts('workspace');
  await createManaged(root, 'workspace-skill', artifacts);

  await assert.rejects(
    deleteWorkspaceSkill(writer(root, 'after_delete_rename'), root, 'workspace-skill'),
    isTransactionError('commit_outcome_unknown'),
  );
  const transaction = await onlyTransaction(root);
  const tombstone = join(transaction, 'tombstone');
  await writeManagedDirectory(join(root, 'skills', 'workspace-skill'), artifacts);
  assert.deepEqual(await readManaged(root, 'workspace-skill'), artifacts);
  assert.deepEqual(await readManagedDirectory(tombstone), artifacts);

  const reopened = writer(root);
  await reopened.recover();
  await reopened.recover();
  await assert.rejects(readManaged(root, 'workspace-skill'), { code: 'ENOENT' });
  assert.deepEqual(await readdir(join(root, 'skills')), []);
  assert.deepEqual(await transactionEntries(root), []);
});

test('delete dual-copy crash recovery fails closed for a live target mismatching expected', async () => {
  const root = await tempRoot();
  const expected = managedArtifacts('workspace');
  const conflicting = managedArtifacts('conflicting-live-target');
  await createManaged(root, 'workspace-skill', expected);

  await assert.rejects(
    deleteWorkspaceSkill(writer(root, 'after_delete_rename'), root, 'workspace-skill'),
    isTransactionError('commit_outcome_unknown'),
  );
  const transaction = await onlyTransaction(root);
  const tombstone = join(transaction, 'tombstone');
  await writeManagedDirectory(join(root, 'skills', 'workspace-skill'), conflicting);
  const transactionsBeforeRecovery = await transactionEntries(root);

  await assert.rejects(writer(root).recover(), isTransactionError('persistence_failed'));
  assert.deepEqual(await readManaged(root, 'workspace-skill'), conflicting);
  assert.deepEqual(await readManagedDirectory(tombstone), expected);
  assert.deepEqual(await transactionEntries(root), transactionsBeforeRecovery);
});

test('delete dual-copy crash recovery fails closed for a tombstone mismatching expected', async () => {
  const root = await tempRoot();
  const expected = managedArtifacts('workspace');
  const conflicting = managedArtifacts('conflicting-tombstone');
  await createManaged(root, 'workspace-skill', expected);

  await assert.rejects(
    deleteWorkspaceSkill(writer(root, 'after_delete_rename'), root, 'workspace-skill'),
    isTransactionError('commit_outcome_unknown'),
  );
  const transaction = await onlyTransaction(root);
  const target = join(root, 'skills', 'workspace-skill');
  const tombstone = join(transaction, 'tombstone');
  await writeManagedDirectory(target, expected);
  await writeManagedDirectory(tombstone, conflicting);
  const transactionsBeforeRecovery = await transactionEntries(root);

  await assert.rejects(writer(root).recover(), isTransactionError('persistence_failed'));
  assert.deepEqual(await readManagedDirectory(target), expected);
  assert.deepEqual(await readManagedDirectory(tombstone), conflicting);
  assert.deepEqual(await transactionEntries(root), transactionsBeforeRecovery);
});

for (const failpoint of [
  'after_delete_rename_before_directory_sync',
  'after_delete_skills_directory_sync_before_transaction_sync',
] as const) {
  test(`workspace deletion recovers from ${failpoint}`, async () => {
    const root = await tempRoot();
    const directory = join(root, 'skills', 'workspace-skill');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'SKILL.md'), '# workspace\n');

    await assert.rejects(
      deleteWorkspaceSkill(writer(root, failpoint), root, 'workspace-skill'),
      isTransactionError('commit_outcome_unknown'),
    );
    await assert.rejects(readFile(join(directory, 'SKILL.md')), { code: 'ENOENT' });
    const transaction = await onlyTransaction(root);
    assert.equal(
      await readFile(join(transaction, 'tombstone', 'SKILL.md'), 'utf8'),
      '# workspace\n',
    );

    const reopened = writer(root);
    await reopened.recover();
    await reopened.recover();
    await assert.rejects(readFile(join(directory, 'SKILL.md')), { code: 'ENOENT' });
    assert.deepEqual(await transactionEntries(root), []);
  });
}

test('workspace deletion refuses a changed tree before tombstoning it', async () => {
  const root = await tempRoot();
  const directory = join(root, 'skills', 'workspace-skill');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'SKILL.md'), '# workspace\n');

  await assert.rejects(
    deleteWorkspaceSkill(writer(root, 'after_intent'), root, 'workspace-skill'),
    isTransactionError('commit_outcome_unknown'),
  );
  await writeFile(join(directory, 'SKILL.md'), '# third-party edit\n');

  await assert.rejects(writer(root).recover(), isTransactionError('persistence_failed'));
  assert.equal(await readFile(join(directory, 'SKILL.md'), 'utf8'), '# third-party edit\n');
});

test('workspace deletion compares the caller snapshot before publishing intent', async () => {
  const root = await tempRoot();
  const directory = join(root, 'skills', 'workspace-skill');
  await mkdir(join(directory, 'references'), { recursive: true });
  await writeFile(join(directory, 'SKILL.md'), '# workspace\n');
  const manifest = await snapshotWorkspaceSkillTree(root, 'workspace-skill');
  await writeFile(join(directory, 'references', 'added.txt'), 'added after snapshot\n');

  await assert.rejects(
    writer(root).deleteWorkspaceSkill('workspace-skill', manifest),
    isTransactionError('persistence_failed'),
  );
  assert.equal(
    await readFile(join(directory, 'references', 'added.txt'), 'utf8'),
    'added after snapshot\n',
  );
  assert.deepEqual(await transactionEntries(root), []);

  await writer(root).publishSkill('subsequent-write', { skill: '# still writable\n' });
  assert.equal(
    await readFile(join(root, 'skills', 'subsequent-write', 'SKILL.md'), 'utf8'),
    '# still writable\n',
  );
});

test('workspace deletion detects third-party empty-directory changes', async () => {
  const root = await tempRoot();
  const directory = join(root, 'skills', 'workspace-skill');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'SKILL.md'), '# workspace\n');

  await assert.rejects(
    deleteWorkspaceSkill(writer(root, 'after_intent'), root, 'workspace-skill'),
    isTransactionError('commit_outcome_unknown'),
  );
  await mkdir(join(directory, 'new-empty-directory'));

  await assert.rejects(writer(root).recover(), isTransactionError('persistence_failed'));
  assert.equal(await readFile(join(directory, 'SKILL.md'), 'utf8'), '# workspace\n');
});

test('workspace deletion bounds files and directories with one traversal budget', async () => {
  const root = await tempRoot();
  const directory = join(root, 'skills', 'workspace-skill');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'SKILL.md'), '# workspace\n');
  await Promise.all(
    Array.from({ length: 256 }, (_, index) =>
      mkdir(join(directory, `empty-${index.toString().padStart(3, '0')}`)),
    ),
  );

  await assert.rejects(
    deleteWorkspaceSkill(writer(root), root, 'workspace-skill'),
    isTransactionError('persistence_failed'),
  );
  assert.equal(await readFile(join(directory, 'SKILL.md'), 'utf8'), '# workspace\n');
  assert.deepEqual(await transactionEntries(root), []);
});

test('transactions write only skills and .maka/skill-transactions in the Data Root', async () => {
  const root = await tempRoot();
  await writeFile(join(root, 'unrelated.json'), 'unchanged');

  const transactionWriter = writer(root);
  await transactionWriter.publishSkill('alpha', managedArtifacts('one'));
  await transactionWriter.replaceManagedSkill(
    'alpha',
    managedArtifacts('one'),
    managedArtifacts('two'),
  );
  await deleteWorkspaceSkill(transactionWriter, root, 'alpha');
  await transactionWriter.recover();

  assert.deepEqual((await readdir(root)).sort(), ['.maka', 'skills', 'unrelated.json']);
  assert.deepEqual(await readdir(join(root, '.maka')), ['skill-transactions']);
  assert.deepEqual(await transactionEntries(root), []);
  assert.equal(await readFile(join(root, 'unrelated.json'), 'utf8'), 'unchanged');
});

function writer(
  root: string,
  failAt?: SkillCatalogTransactionFailpoint,
): SkillCatalogTransactionWriter {
  let armed = failAt !== undefined;
  return new SkillCatalogTransactionWriter(
    async (operation) => operation(root),
    failAt
      ? {
          failpoint(point) {
            if (armed && point === failAt) {
              armed = false;
              throw new Error(`failure at ${point}`);
            }
          },
        }
      : {},
  );
}

async function deleteWorkspaceSkill(
  transactionWriter: SkillCatalogTransactionWriter,
  root: string,
  skillId: string,
): Promise<void> {
  const manifest = await snapshotWorkspaceSkillTree(root, skillId);
  await transactionWriter.deleteWorkspaceSkill(skillId, manifest);
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'maka-skill-transaction-'));
  roots.add(root);
  return root;
}

function managedArtifacts(label: string): ManagedSkillTransactionArtifacts {
  return {
    skill: `# skill ${label}\n`,
    lock: `${JSON.stringify({ label })}\n`,
    baseline: `# baseline ${label}\n`,
  };
}

async function createManaged(
  root: string,
  id: string,
  artifacts: ManagedSkillTransactionArtifacts,
): Promise<void> {
  await writeManagedDirectory(join(root, 'skills', id), artifacts);
}

async function writeManagedDirectory(
  directory: string,
  artifacts: ManagedSkillTransactionArtifacts,
): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'SKILL.md'), artifacts.skill);
  await writeFile(join(directory, 'skill.lock.json'), artifacts.lock);
  await mkdir(join(directory, '.maka', 'baseline'), { recursive: true });
  await writeFile(join(directory, '.maka', 'baseline', 'SKILL.md'), artifacts.baseline);
}

async function readManaged(
  root: string,
  id: string,
): Promise<{ skill: string; lock: string; baseline: string }> {
  return readManagedDirectory(join(root, 'skills', id));
}

async function readManagedDirectory(
  directory: string,
): Promise<{ skill: string; lock: string; baseline: string }> {
  const [skill, lock, baseline] = await Promise.all([
    readFile(join(directory, 'SKILL.md'), 'utf8'),
    readFile(join(directory, 'skill.lock.json'), 'utf8'),
    readFile(join(directory, '.maka', 'baseline', 'SKILL.md'), 'utf8'),
  ]);
  return { skill, lock, baseline };
}

async function transactionEntries(root: string): Promise<string[]> {
  try {
    return await readdir(join(root, '.maka', 'skill-transactions'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function frozenEntries(root: string): Promise<string[]> {
  try {
    return (await readdir(join(root, 'skills')))
      .filter((entry) => entry.startsWith('.maka-frozen-'))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function onlyFrozen(root: string): Promise<string> {
  const entries = await frozenEntries(root);
  assert.equal(entries.length, 1);
  return join(root, 'skills', entries[0]);
}

async function onlyTransaction(root: string): Promise<string> {
  const entries = await transactionEntries(root);
  assert.equal(entries.length, 1);
  return join(root, '.maka', 'skill-transactions', entries[0]);
}

async function countTreeEntries(directory: string): Promise<number> {
  let count = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    count += 1;
    if (entry.isDirectory()) count += await countTreeEntries(join(directory, entry.name));
  }
  return count;
}

function isTransactionError(code: SkillCatalogTransactionError['code']) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof SkillCatalogTransactionError);
    assert.equal(error.code, code);
    return true;
  };
}
