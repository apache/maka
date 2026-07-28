import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

for (const { failpoint, partial } of [
  {
    failpoint: 'after_replace_baseline',
    partial: (
      expected: ManagedSkillTransactionArtifacts,
      next: ManagedSkillTransactionArtifacts,
    ) => ({
      skill: expected.skill,
      lock: expected.lock,
      baseline: next.baseline,
    }),
  },
  {
    failpoint: 'after_replace_skill',
    partial: (
      expected: ManagedSkillTransactionArtifacts,
      next: ManagedSkillTransactionArtifacts,
    ) => ({
      skill: next.skill,
      lock: expected.lock,
      baseline: next.baseline,
    }),
  },
  {
    failpoint: 'after_replace_lock',
    partial: (
      _expected: ManagedSkillTransactionArtifacts,
      next: ManagedSkillTransactionArtifacts,
    ) => next,
  },
] as const) {
  test(`managed replacement recovers from ${failpoint} including baseline`, async () => {
    const root = await tempRoot();
    const expected = managedArtifacts('old');
    const next = managedArtifacts('new');
    await createManaged(root, 'managed', expected);

    await assert.rejects(
      writer(root, failpoint).replaceManagedSkill('managed', expected, next),
      isTransactionError('commit_outcome_unknown'),
    );
    assert.deepEqual(await readManaged(root, 'managed'), partial(expected, next));

    const reopened = writer(root);
    await reopened.recover();
    await reopened.recover();
    assert.deepEqual(await readManaged(root, 'managed'), next);
    assert.deepEqual(await transactionEntries(root), []);
  });
}

test('managed recovery discards a transaction temp fsynced before rename', async () => {
  const root = await tempRoot();
  const expected = managedArtifacts('old');
  const next = managedArtifacts('new');
  await createManaged(root, 'managed', expected);

  await assert.rejects(
    writer(root, 'after_managed_temp_file_sync_before_rename').replaceManagedSkill(
      'managed',
      expected,
      next,
    ),
    isTransactionError('commit_outcome_unknown'),
  );
  assert.deepEqual(await readManaged(root, 'managed'), expected);
  assert.deepEqual((await readdir(join(root, 'skills', 'managed'))).sort(), [
    'SKILL.md',
    'skill.baseline.md',
    'skill.lock.json',
  ]);
  assert.ok((await readdir(await onlyTransaction(root))).includes('managed-replacement.tmp'));

  await writer(root).recover();
  assert.deepEqual(await readManaged(root, 'managed'), next);
  assert.deepEqual(await transactionEntries(root), []);
});

test('managed recovery accepts baseline rename before directory synchronization', async () => {
  const root = await tempRoot();
  const expected = managedArtifacts('old');
  const next = managedArtifacts('new');
  await createManaged(root, 'managed', expected);

  await assert.rejects(
    writer(root, 'after_managed_replace_rename_before_directory_sync').replaceManagedSkill(
      'managed',
      expected,
      next,
    ),
    isTransactionError('commit_outcome_unknown'),
  );
  assert.deepEqual(await readManaged(root, 'managed'), {
    skill: expected.skill,
    lock: expected.lock,
    baseline: next.baseline,
  });

  await writer(root).recover();
  assert.deepEqual(await readManaged(root, 'managed'), next);
  assert.deepEqual(await transactionEntries(root), []);
});

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
    const entries = await transactionEntries(root);
    assert.equal(entries.length, 1);
    assert.match(entries[0], /^gc-/);
    if (failpoint === 'during_gc_cleanup') {
      assert.equal(
        await countTreeEntries(join(root, '.maka', 'skill-transactions', entries[0])),
        8,
      );
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
  await writeFile(join(transaction, 'next', 'skill.baseline.md'), 'tampered');

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
  const directory = join(root, 'skills', id);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'SKILL.md'), artifacts.skill);
  await writeFile(join(directory, 'skill.lock.json'), artifacts.lock);
  await writeFile(join(directory, 'skill.baseline.md'), artifacts.baseline);
}

async function readManaged(
  root: string,
  id: string,
): Promise<{ skill: string; lock: string; baseline: string }> {
  const directory = join(root, 'skills', id);
  const [skill, lock, baseline] = await Promise.all([
    readFile(join(directory, 'SKILL.md'), 'utf8'),
    readFile(join(directory, 'skill.lock.json'), 'utf8'),
    readFile(join(directory, 'skill.baseline.md'), 'utf8'),
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
