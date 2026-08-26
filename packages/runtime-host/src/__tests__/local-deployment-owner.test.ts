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
import { execFileSync, spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { chmod, mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  applyLocalHostDeploymentTransition,
  LocalHostDeploymentAuthorityError,
  readLocalHostDeploymentRecord,
  resolveLocalHostDeploymentAuthorityRoot,
  type LocalHostDeploymentAuthorityOptions,
  type RuntimeHostInstallationOwner,
} from '../operator/local-deployment-owner.js';
import type { RuntimeHostDeploymentIdentity } from '../operator/update-package-evidence.js';

const ROOT_ID = 'a'.repeat(64);
const DESKTOP: RuntimeHostInstallationOwner = {
  kind: 'desktop',
  installationId: 'desktop:stable',
};
const CLI: RuntimeHostInstallationOwner = {
  kind: 'cli',
  installationId: 'cli:global',
};
const DESKTOP_DEPLOYMENT: RuntimeHostDeploymentIdentity = {
  kind: 'npm_registry',
  version: '1.0.0',
  integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
};
const CLI_DEPLOYMENT: RuntimeHostDeploymentIdentity = {
  kind: 'npm_registry',
  version: '2.0.0',
  integrity: `sha512-${Buffer.alloc(64, 2).toString('base64')}`,
};
const CLAIM_FIXTURE = fileURLToPath(
  new URL('./fixtures/local-deployment-owner-claim.js', import.meta.url),
);

async function authority(t: test.TestContext): Promise<LocalHostDeploymentAuthorityOptions> {
  const authorityRoot = await mkdtemp(join(tmpdir(), 'maka-local-owner-'));
  t.after(() => rm(authorityRoot, { recursive: true, force: true }));
  return { authorityRoot };
}

test('resolves one durable account-local namespace outside cache and State Root paths', () => {
  assert.equal(
    resolveLocalHostDeploymentAuthorityRoot({
      platform: 'linux',
      homeDir: '/home/ada',
    }),
    '/home/ada/.local/share/Maka/runtime-host-ownership',
  );
  assert.equal(
    resolveLocalHostDeploymentAuthorityRoot({
      platform: 'darwin',
      homeDir: '/Users/ada',
    }),
    '/Users/ada/Library/Application Support/Maka/runtime-host-ownership',
  );
  assert.equal(
    resolveLocalHostDeploymentAuthorityRoot({
      platform: 'win32',
      homeDir: 'C:\\Users\\Ada',
    }),
    'C:\\Users\\Ada\\AppData\\Local\\Maka\\runtime-host-ownership',
  );
});

test('different process data environments still compete for one account authority', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'maka-local-owner-env-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const homeDir = join(parent, 'home');
  const results = await Promise.all([
    claimFromAccountProcess(homeDir, 'desktop-no-xdg', DESKTOP_DEPLOYMENT.integrity, undefined),
    claimFromAccountProcess(homeDir, 'cli-with-xdg', CLI_DEPLOYMENT.integrity, join(parent, 'xdg')),
  ]);

  assert.equal(results.filter((result) => result.kind === 'applied').length, 1);
  assert.equal(results.filter((result) => result.kind === 'rejected').length, 1);
});

test('serializes competing initial claims and never uses last-launch-wins', async (t) => {
  const options = await authority(t);
  const results = await Promise.all([
    claimFromIndependentProcess(options.authorityRoot!, 'desktop-a', DESKTOP_DEPLOYMENT.integrity),
    claimFromIndependentProcess(options.authorityRoot!, 'desktop-b', CLI_DEPLOYMENT.integrity),
  ]);

  assert.equal(results.filter((result) => result.kind === 'applied').length, 1);
  assert.equal(results.filter((result) => result.kind === 'rejected').length, 1);
  const stored = await readLocalHostDeploymentRecord(ROOT_ID, options);
  assert.equal(stored?.state.kind, 'owned');
  assert.ok(
    stored?.state.kind === 'owned' &&
      (stored.state.owner.installationId === 'desktop-a' ||
        stored.state.owner.installationId === 'desktop-b'),
  );
});

test('creates a missing authority hierarchy before durably publishing the first record', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'maka-local-owner-parent-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const options = { authorityRoot: join(parent, 'account', 'Maka', 'runtime-host-ownership') };

  const claimed = await applyLocalHostDeploymentTransition(
    ROOT_ID,
    { kind: 'claim', owner: DESKTOP, selected: DESKTOP_DEPLOYMENT },
    options,
  );

  assert.equal(claimed.kind, 'applied');
  assert.deepEqual(await readLocalHostDeploymentRecord(ROOT_ID, options), claimed.record);
});

test('does not sync above the OS-managed account-home durability boundary', async (t) => {
  if (process.platform === 'win32') return;
  const parent = await mkdtemp(join(tmpdir(), 'maka-local-owner-home-boundary-'));
  const homeDir = join(parent, 'home');
  await mkdir(homeDir, { mode: 0o700 });
  await chmod(parent, 0o111);
  t.after(async () => {
    await chmod(parent, 0o700);
    await rm(parent, { recursive: true, force: true });
  });
  await assert.rejects(
    open(parent, 'r'),
    (error: unknown) => (error as NodeJS.ErrnoException).code === 'EACCES',
  );

  const claimed = await applyLocalHostDeploymentTransition(
    ROOT_ID,
    { kind: 'claim', owner: DESKTOP, selected: DESKTOP_DEPLOYMENT },
    { homeDir },
  );

  assert.equal(claimed.kind, 'applied');
  assert.deepEqual(await readLocalHostDeploymentRecord(ROOT_ID, { homeDir }), claimed.record);
});

test('keeps an exact initial-owner claim retry idempotent without changing revision', async (t) => {
  const options = await authority(t);
  const first = await applyLocalHostDeploymentTransition(
    ROOT_ID,
    { kind: 'claim', owner: DESKTOP, selected: DESKTOP_DEPLOYMENT },
    options,
  );
  const retried = await applyLocalHostDeploymentTransition(
    ROOT_ID,
    { kind: 'claim', owner: DESKTOP, selected: DESKTOP_DEPLOYMENT },
    options,
  );

  assert.equal(first.kind, 'applied');
  assert.equal(retried.kind, 'unchanged');
  assert.equal(retried.record?.revision, first.record?.revision);
});

test('retries a directory-entry durability barrier after mkdir', async (t) => {
  if (process.platform === 'win32') return;
  const parent = await mkdtemp(join(tmpdir(), 'maka-local-owner-mkdir-sync-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  let remainingFailures = 2;
  const options: LocalHostDeploymentAuthorityOptions = {
    authorityRoot: join(parent, 'account', 'Maka', 'runtime-host-ownership'),
    beforeDirectorySync: (path, purpose) => {
      if (purpose === 'directory_entry' && path === parent && remainingFailures > 0) {
        remainingFailures -= 1;
        throw new Error('injected directory-entry sync failure');
      }
    },
  };
  const transition = { kind: 'claim', owner: DESKTOP, selected: DESKTOP_DEPLOYMENT } as const;

  await assertCommitUnknown(applyLocalHostDeploymentTransition(ROOT_ID, transition, options));
  await assertCommitUnknown(applyLocalHostDeploymentTransition(ROOT_ID, transition, options));
  const retried = await applyLocalHostDeploymentTransition(ROOT_ID, transition, options);

  assert.equal(retried.kind, 'applied');
});

test('an exact claim retry re-establishes rename durability before succeeding', async (t) => {
  if (process.platform === 'win32') return;
  const base = await authority(t);
  let publishFailure = true;
  let confirmationFailure = true;
  const options: LocalHostDeploymentAuthorityOptions = {
    ...base,
    beforeDirectorySync: (_path, purpose) => {
      if (purpose === 'record_publish' && publishFailure) {
        publishFailure = false;
        throw new Error('injected record publish sync failure');
      }
      if (purpose === 'unchanged_confirmation' && confirmationFailure) {
        confirmationFailure = false;
        throw new Error('injected unchanged confirmation failure');
      }
    },
  };
  const transition = { kind: 'claim', owner: DESKTOP, selected: DESKTOP_DEPLOYMENT } as const;

  await assertCommitUnknown(applyLocalHostDeploymentTransition(ROOT_ID, transition, options));
  await assertCommitUnknown(applyLocalHostDeploymentTransition(ROOT_ID, transition, options));
  const retried = await applyLocalHostDeploymentTransition(ROOT_ID, transition, options);

  assert.equal(retried.kind, 'unchanged');
});

test('an exact release retry re-establishes unlink durability before succeeding', async (t) => {
  if (process.platform === 'win32') return;
  const base = await authority(t);
  const claimed = await applyLocalHostDeploymentTransition(
    ROOT_ID,
    { kind: 'claim', owner: DESKTOP, selected: DESKTOP_DEPLOYMENT },
    base,
  );
  let removeFailure = true;
  let confirmationFailure = true;
  const options: LocalHostDeploymentAuthorityOptions = {
    ...base,
    beforeDirectorySync: (_path, purpose) => {
      if (purpose === 'record_remove' && removeFailure) {
        removeFailure = false;
        throw new Error('injected record removal sync failure');
      }
      if (purpose === 'unchanged_confirmation' && confirmationFailure) {
        confirmationFailure = false;
        throw new Error('injected unchanged confirmation failure');
      }
    },
  };
  const transition = {
    kind: 'release',
    expectedRevision: claimed.record!.revision,
    owner: DESKTOP,
  } as const;

  await assertCommitUnknown(applyLocalHostDeploymentTransition(ROOT_ID, transition, options));
  await assertCommitUnknown(applyLocalHostDeploymentTransition(ROOT_ID, transition, options));
  const retried = await applyLocalHostDeploymentTransition(ROOT_ID, transition, options);

  assert.deepEqual(retried, { kind: 'unchanged', record: undefined });
});

test('snapshots caller-owned transition values before the first await', async (t) => {
  const options = await authority(t);
  const owner: { kind: 'desktop'; installationId: string } = {
    kind: 'desktop',
    installationId: 'desktop:invocation-time',
  };
  const selected: { kind: 'npm_registry'; version: string; integrity: string } = {
    ...DESKTOP_DEPLOYMENT,
  };

  const pending = applyLocalHostDeploymentTransition(
    ROOT_ID,
    { kind: 'claim', owner, selected },
    options,
  );
  owner.installationId = `mutated-${'x'.repeat(600)}`;
  selected.version = 'not-a-release-version';
  const result = await pending;

  assert.equal(result.kind, 'applied');
  assert.equal(result.record?.state.kind, 'owned');
  assert.deepEqual(result.record?.state, {
    kind: 'owned',
    owner: { kind: 'desktop', installationId: 'desktop:invocation-time' },
    selected: DESKTOP_DEPLOYMENT,
  });
  assert.deepEqual(await readLocalHostDeploymentRecord(ROOT_ID, options), result.record);
});

test('removes abandoned record workspaces before applying the next transition', async (t) => {
  const options = await authority(t);
  const abandoned = `${ROOT_ID}.json.00000000-0000-4000-8000-000000000000.tmp`;
  const unrelated = `${ROOT_ID}.json.keep.tmp`;
  await writeFile(join(options.authorityRoot!, abandoned), 'partial', 'utf8');
  await writeFile(join(options.authorityRoot!, unrelated), 'keep', 'utf8');

  const claimed = await applyLocalHostDeploymentTransition(
    ROOT_ID,
    { kind: 'claim', owner: DESKTOP, selected: DESKTOP_DEPLOYMENT },
    options,
  );

  assert.equal(claimed.kind, 'applied');
  const entries = await readdir(options.authorityRoot!);
  assert.equal(entries.includes(abandoned), false);
  assert.equal(entries.includes(unrelated), true);
});

test('persists transfer intent before cutover and commits the exact target', async (t) => {
  const options = await authority(t);
  const claimed = await applyLocalHostDeploymentTransition(
    ROOT_ID,
    { kind: 'claim', owner: DESKTOP, selected: DESKTOP_DEPLOYMENT },
    options,
  );
  assert.equal(claimed.kind, 'applied');

  const begun = await applyLocalHostDeploymentTransition(
    ROOT_ID,
    {
      kind: 'begin_transfer',
      expectedRevision: claimed.record!.revision,
      transactionId: 'desktop-to-cli',
      from: DESKTOP,
      to: CLI,
      target: CLI_DEPLOYMENT,
    },
    options,
  );
  assert.equal(begun.kind, 'applied');
  assert.deepEqual(await readLocalHostDeploymentRecord(ROOT_ID, options), begun.record);
  assert.equal(begun.record?.state.kind, 'transferring');

  const committed = await applyLocalHostDeploymentTransition(
    ROOT_ID,
    {
      kind: 'commit_transfer',
      expectedRevision: begun.record!.revision,
      transactionId: 'desktop-to-cli',
      to: CLI,
      target: CLI_DEPLOYMENT,
    },
    options,
  );
  assert.equal(committed.kind, 'applied');
  assert.deepEqual(committed.record?.state, {
    kind: 'owned',
    owner: CLI,
    selected: CLI_DEPLOYMENT,
    previous: DESKTOP_DEPLOYMENT,
  });

  const retried = await applyLocalHostDeploymentTransition(
    ROOT_ID,
    {
      kind: 'commit_transfer',
      expectedRevision: begun.record!.revision,
      transactionId: 'desktop-to-cli',
      to: CLI,
      target: CLI_DEPLOYMENT,
    },
    options,
  );
  assert.equal(retried.kind, 'unchanged');
});

test('rejects stale confirmation after the owner revision changes', async (t) => {
  const options = await authority(t);
  const claimed = await applyLocalHostDeploymentTransition(
    ROOT_ID,
    { kind: 'claim', owner: DESKTOP, selected: DESKTOP_DEPLOYMENT },
    options,
  );
  assert.equal(claimed.kind, 'applied');
  const selected = await applyLocalHostDeploymentTransition(
    ROOT_ID,
    {
      kind: 'select',
      expectedRevision: claimed.record!.revision,
      owner: DESKTOP,
      selected: {
        ...DESKTOP_DEPLOYMENT,
        version: '1.1.0',
        integrity: CLI_DEPLOYMENT.integrity,
      },
    },
    options,
  );
  assert.equal(selected.kind, 'applied');

  const stale = await applyLocalHostDeploymentTransition(
    ROOT_ID,
    {
      kind: 'begin_transfer',
      expectedRevision: claimed.record!.revision,
      transactionId: 'stale-prompt',
      from: DESKTOP,
      to: CLI,
      target: CLI_DEPLOYMENT,
    },
    options,
  );
  assert.deepEqual(
    {
      kind: stale.kind,
      reason: stale.kind === 'rejected' ? stale.reason : null,
    },
    {
      kind: 'rejected',
      reason: 'revision_changed',
    },
  );
});

test('rolls an interrupted transfer back to the exact previous owner state', async (t) => {
  const options = await authority(t);
  const claimed = await applyLocalHostDeploymentTransition(
    ROOT_ID,
    { kind: 'claim', owner: DESKTOP, selected: DESKTOP_DEPLOYMENT },
    options,
  );
  const begun = await applyLocalHostDeploymentTransition(
    ROOT_ID,
    {
      kind: 'begin_transfer',
      expectedRevision: claimed.record!.revision,
      transactionId: 'recover-me',
      from: DESKTOP,
      to: CLI,
      target: CLI_DEPLOYMENT,
    },
    options,
  );
  const rolledBack = await applyLocalHostDeploymentTransition(
    ROOT_ID,
    {
      kind: 'rollback_transfer',
      expectedRevision: begun.record!.revision,
      transactionId: 'recover-me',
      from: DESKTOP,
      selected: DESKTOP_DEPLOYMENT,
    },
    options,
  );

  assert.equal(rolledBack.kind, 'applied');
  assert.deepEqual(rolledBack.record?.state, {
    kind: 'owned',
    owner: DESKTOP,
    selected: DESKTOP_DEPLOYMENT,
  });

  const changedSelection = await applyLocalHostDeploymentTransition(
    ROOT_ID,
    {
      kind: 'select',
      expectedRevision: rolledBack.record!.revision,
      owner: DESKTOP,
      selected: {
        ...DESKTOP_DEPLOYMENT,
        version: '1.1.0',
        integrity: CLI_DEPLOYMENT.integrity,
      },
    },
    options,
  );
  const staleRetry = await applyLocalHostDeploymentTransition(
    ROOT_ID,
    {
      kind: 'rollback_transfer',
      expectedRevision: begun.record!.revision,
      transactionId: 'recover-me',
      from: DESKTOP,
      selected: DESKTOP_DEPLOYMENT,
    },
    options,
  );
  assert.equal(changedSelection.kind, 'applied');
  assert.equal(staleRetry.kind, 'rejected');
  assert.equal(staleRetry.kind === 'rejected' ? staleRetry.reason : undefined, 'transfer_changed');
});

test('requires exact owner and revision before releasing durable authority', async (t) => {
  const options = await authority(t);
  const claimed = await applyLocalHostDeploymentTransition(
    ROOT_ID,
    { kind: 'claim', owner: DESKTOP, selected: DESKTOP_DEPLOYMENT },
    options,
  );
  const wrongOwner = await applyLocalHostDeploymentTransition(
    ROOT_ID,
    { kind: 'release', expectedRevision: claimed.record!.revision, owner: CLI },
    options,
  );
  assert.equal(wrongOwner.kind, 'rejected');
  assert.equal(wrongOwner.kind === 'rejected' ? wrongOwner.reason : undefined, 'owner_changed');

  const released = await applyLocalHostDeploymentTransition(
    ROOT_ID,
    {
      kind: 'release',
      expectedRevision: claimed.record!.revision,
      owner: DESKTOP,
    },
    options,
  );
  assert.deepEqual(released, { kind: 'applied', record: undefined });
  assert.equal(await readLocalHostDeploymentRecord(ROOT_ID, options), undefined);
});

test('fails closed on a malformed durable record instead of silently claiming it', async (t) => {
  const options = await authority(t);
  await applyLocalHostDeploymentTransition(
    ROOT_ID,
    { kind: 'claim', owner: DESKTOP, selected: DESKTOP_DEPLOYMENT },
    options,
  );
  const path = join(options.authorityRoot!, `${ROOT_ID}.json`);
  await writeFile(path, '{"schemaVersion":999}\n', 'utf8');

  await assert.rejects(
    applyLocalHostDeploymentTransition(
      ROOT_ID,
      { kind: 'claim', owner: CLI, selected: CLI_DEPLOYMENT },
      options,
    ),
    (error: unknown) =>
      error instanceof LocalHostDeploymentAuthorityError && error.code === 'invalid_record',
  );
  assert.equal(await readFile(path, 'utf8'), '{"schemaVersion":999}\n');
});

test('reports record acquisition failures as authority I/O rather than corruption', async (t) => {
  if (process.platform === 'win32') return;
  const options = await authority(t);
  await applyLocalHostDeploymentTransition(
    ROOT_ID,
    { kind: 'claim', owner: DESKTOP, selected: DESKTOP_DEPLOYMENT },
    options,
  );
  const path = join(options.authorityRoot!, `${ROOT_ID}.json`);
  await chmod(path, 0o000);
  try {
    await assert.rejects(readLocalHostDeploymentRecord(ROOT_ID, options), (error: unknown) => {
      assert.ok(error instanceof LocalHostDeploymentAuthorityError);
      assert.equal(error.code, 'authority_io_failed');
      assert.equal((error.cause as NodeJS.ErrnoException | undefined)?.code, 'EACCES');
      return true;
    });
  } finally {
    await chmod(path, 0o600);
  }
});

test('rejects a FIFO owner record without blocking before file-type validation', async (t) => {
  if (process.platform === 'win32') return;
  const options = await authority(t);
  const path = join(options.authorityRoot!, `${ROOT_ID}.json`);
  execFileSync('mkfifo', [path]);
  const startedAt = Date.now();
  const unblock = setTimeout(() => {
    void open(path, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK)
      .then((handle) => handle.close())
      .catch(() => undefined);
  }, 500);
  try {
    await assert.rejects(
      readLocalHostDeploymentRecord(ROOT_ID, options),
      (error: unknown) =>
        error instanceof LocalHostDeploymentAuthorityError && error.code === 'invalid_record',
    );
  } finally {
    clearTimeout(unblock);
  }
  assert.ok(Date.now() - startedAt < 250);
});

test('rejects non-UTF-8 owner record bytes instead of replacing them', async (t) => {
  const options = await authority(t);
  await applyLocalHostDeploymentTransition(
    ROOT_ID,
    {
      kind: 'claim',
      owner: { kind: 'desktop', installationId: 'ZMARKZ' },
      selected: DESKTOP_DEPLOYMENT,
    },
    options,
  );
  const path = join(options.authorityRoot!, `${ROOT_ID}.json`);
  const document = await readFile(path);
  const markerOffset = document.indexOf(Buffer.from('ZMARKZ'));
  assert.notEqual(markerOffset, -1);
  document[markerOffset + 2] = 0xff;
  await writeFile(path, document);

  await assert.rejects(
    readLocalHostDeploymentRecord(ROOT_ID, options),
    (error: unknown) =>
      error instanceof LocalHostDeploymentAuthorityError && error.code === 'invalid_record',
  );
});

test('rejects transient npx and remote identities at the durable record seam', async (t) => {
  const options = await authority(t);
  await assert.rejects(
    applyLocalHostDeploymentTransition(
      ROOT_ID,
      {
        kind: 'claim',
        owner: { kind: 'npx', installationId: 'temporary' } as never,
        selected: CLI_DEPLOYMENT,
      },
      options,
    ),
    (error: unknown) =>
      error instanceof LocalHostDeploymentAuthorityError && error.code === 'invalid_input',
  );
  await assert.rejects(
    applyLocalHostDeploymentTransition(
      ROOT_ID,
      {
        kind: 'claim',
        owner: { kind: 'remote', installationId: 'ssh-client' } as never,
        selected: CLI_DEPLOYMENT,
      },
      options,
    ),
    (error: unknown) =>
      error instanceof LocalHostDeploymentAuthorityError && error.code === 'invalid_input',
  );
});

function claimFromIndependentProcess(
  authorityRoot: string,
  installationId: string,
  integrity: string,
): Promise<{ readonly kind: string }> {
  return claimFromProcess(
    ['--authority-root', authorityRoot, ROOT_ID, installationId, integrity],
    process.env,
  );
}

async function assertCommitUnknown(pending: Promise<unknown>): Promise<void> {
  await assert.rejects(
    pending,
    (error: unknown) =>
      error instanceof LocalHostDeploymentAuthorityError && error.code === 'commit_unknown',
  );
}

function claimFromAccountProcess(
  homeDir: string,
  installationId: string,
  integrity: string,
  xdgDataHome: string | undefined,
): Promise<{ readonly kind: string }> {
  const env = { ...process.env };
  if (xdgDataHome === undefined) delete env.XDG_DATA_HOME;
  else env.XDG_DATA_HOME = xdgDataHome;
  return claimFromProcess(['--account-home', homeDir, ROOT_ID, installationId, integrity], env);
}

function claimFromProcess(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<{ readonly kind: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLAIM_FIXTURE, ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Owner claim fixture exited ${String(code)}: ${stderr}`));
        return;
      }
      resolve(JSON.parse(stdout) as { readonly kind: string });
    });
  });
}
