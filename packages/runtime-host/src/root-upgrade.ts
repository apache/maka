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

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstatSync } from 'node:fs';
import { chmod, cp, lstat, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import {
  resolveStorageRoot,
  resolveRootOwnershipNamespace,
  withStorageRootUpgrade,
  inspectStorageRootFormat,
  STORAGE_ROOT_MARKER_SCHEMA_VERSION,
  StorageRootAuthorityError,
  type StorageRootUpgradeSession,
  type StorageRootCapability,
  repairStorageRootAfterRemount,
} from '@maka/storage/root-authority';
import {
  hardenDirectory,
  syncDirectoryChain,
  syncFile,
  readStableBoundedFile,
} from '@maka/storage/stable-storage';
import { readAccessCredentialFile, ACCESS_FILE_NAME } from './server/access-credential-store.js';
import { HostPluginCompositionStore } from './server/plugin-composition-store.js';
import {
  decodeRuntimeHostManagedDeploymentAuthorityRecord,
  RuntimeHostManagedDeploymentError,
  decodeRuntimeHostManagedDeploymentConfig,
  type RuntimeHostManagedDeploymentAuthorityRecord,
  type RuntimeHostManagedDeploymentConfig,
  locateRuntimeHostManagedRoot,
  type RuntimeHostManagedDeploymentAuthorityOptions,
} from './operator/managed-deployment.js';
import { resolveRuntimeHostNpmDeploymentLayout } from './operator/update-package-evidence.js';

const source = z.string().refine(isAbsolute).nullable();
const planSchema = z
  .object({
    rootId: z.string(),
    data: source,
    deployment: source,
    locator: source,
    locks: z.array(z.string().refine(isAbsolute)).length(4),
    targetDeployment: z.unknown().optional(),
  })
  .strict();
type UpgradePlan = z.infer<typeof planSchema>;
const COMPLETION = '.upgrade-complete.json';
const UPGRADE_PLAN_FILE = 'upgrade-plan.json';
// A concurrent upgrade or a still-running legacy owner holds the fence; bounded
// retries keep a slow migration from failing every client that arrives mid-way.
const MIGRATION_BUSY_WAIT_MS = 60_000;

/** The only startup entry that can initialize or resume the Host's root format. */
export interface RuntimeHostRootUpgradeOptions {
  /** The existing installer stages its package before the format fence. */
  readonly prepareDeployment?: (
    current: RuntimeHostManagedDeploymentConfig,
  ) => Promise<RuntimeHostManagedDeploymentConfig>;
  readonly retireDeployment?: (current: RuntimeHostManagedDeploymentConfig) => Promise<void>;
  /** Bounded wait while another upgrade or a live legacy owner holds the fence. */
  readonly migrationBusyWaitMs?: number;
}

export async function prepareRuntimeHostRoot(
  path: string,
  options: RuntimeHostRootUpgradeOptions = {},
): Promise<StorageRootCapability<'interactive'>> {
  const deadline = Date.now() + (options.migrationBusyWaitMs ?? MIGRATION_BUSY_WAIT_MS);
  for (;;) {
    try {
      return await resolveStorageRoot({ path, kind: 'interactive' });
    } catch (error) {
      if (
        !(error instanceof StorageRootAuthorityError) ||
        error.code !== 'legacy_root_requires_migration'
      )
        throw error;
    }
    try {
      await withStorageRootUpgrade(path, (session) => upgradeRuntimeHostRoot(session, options));
    } catch (error) {
      const remaining = deadline - Date.now();
      if (
        error instanceof StorageRootAuthorityError &&
        error.code === 'root_migration_busy' &&
        remaining > 0
      ) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(250, remaining)));
        continue;
      }
      throw error;
    }
  }
}

async function upgradeRuntimeHostRoot(
  session: StorageRootUpgradeSession,
  options: RuntimeHostRootUpgradeOptions,
): Promise<void> {
  const authority = resolveRootOwnershipNamespace(session.canonicalPath);
  const planPath = join(authority, UPGRADE_PLAN_FILE);
  // Staging directories are bound to their transaction; anything left by an
  // abandoned one is disposable.
  for (const entry of await readdir(authority, { withFileTypes: true })) {
    if (
      entry.isDirectory() &&
      entry.name.startsWith('upgrade-') &&
      entry.name !== `upgrade-${session.upgrade?.id}`
    )
      await rm(join(authority, entry.name), { recursive: true, force: true });
  }
  // The fence is the only stage bit: an upgrade marker means the plan file is
  // part of the durable transaction record and must read, never be re-derived.
  let plan: UpgradePlan;
  if (session.upgrade !== undefined) {
    plan = await readUpgradePlan(planPath, session.rootId);
    // The durable fence rejects old code, but a writer admitted before it
    // was published still has to release its actual OS lock.
    await admitLegacyLocks(session, plan.locks, planSources(plan));
  } else {
    plan = await inspectLegacySources(session);
    const current = await validateDeploymentSource(
      plan.deployment,
      session.rootId,
      session.canonicalPath,
    );
    if (current) {
      if (current.state !== 'active')
        throw new Error(
          'Legacy deployment has an unfinished lifecycle transaction; settle it through the managed activation or update workflow before migrating',
        );
      const active = current;
      const target = options.prepareDeployment
        ? decodeRuntimeHostManagedDeploymentConfig(await options.prepareDeployment(active))
        : active;
      if (
        target.root.id !== session.rootId ||
        target.root.path !== session.canonicalPath ||
        target.deploymentId !== active.deploymentId
      )
        throw new Error('Prepared deployment targets another root or installation');
      await assertCompatibleDeployment(target);
      if (JSON.stringify(target) !== JSON.stringify(active)) {
        if (target.configRevision <= active.configRevision)
          throw new Error('Prepared deployment must advance its revision');
        plan.targetDeployment = target;
      }
      await options.retireDeployment?.(active);
    }
    // First admission creates writable legacy lock directories so a
    // simultaneous old startup cannot create a different, unlocked path.
    await admitLegacyLocks(session, plan.locks, planSources(plan));
    const lockedSources = await inspectLegacySources(session);
    const lockedDeployment = await validateDeploymentSource(
      lockedSources.deployment,
      session.rootId,
      session.canonicalPath,
    );
    if (JSON.stringify(current) !== JSON.stringify(lockedDeployment))
      throw new Error('Legacy deployment changed while preparing its upgrade');
    // Every source attested by the first inspection must still be there
    // after admission; otherwise the durable plan would attest its absence
    // and the commit would silently drop that data. A source that only
    // appears now stays admissible — admission itself creates a missing
    // data directory to hold its owner lock.
    const locked = planSources(lockedSources);
    for (const source of planSources(plan)) {
      if (!locked.has(source))
        throw new Error('Legacy sources changed while preparing the upgrade');
    }
    plan = {
      ...lockedSources,
      ...(plan.targetDeployment ? { targetDeployment: plan.targetDeployment } : {}),
    };
    await writeUpgradePlan(planPath, plan);
    await session.begin();
  }
  const transaction = session.upgrade!;
  const state = join(authority, 'state');
  const staging = join(authority, `upgrade-${transaction.id}`);
  let restaged = false;
  for (;;) {
    const committed = await completedSnapshot(state, transaction.id);
    if (committed) {
      try {
        // The completion record only proves the staged copy; check what survived.
        await assertCommittedState(state, session, committed);
        break;
      } catch (error) {
        // A completed snapshot is this transaction's disposable copy: a
        // corrupt one restages once rather than wedging the root.
        if (restaged) throw error;
        restaged = true;
      }
    }
    // Stage before deleting: everything under the fenced .maka-host is
    // transaction-owned, but a failed restage must leave the last complete
    // snapshot in place rather than destroying its evidence.
    if (!(await completedSnapshot(staging, transaction.id)))
      await stageSnapshot(session, staging, plan, transaction.id);
    await rm(state, { recursive: true, force: true });
    await rename(staging, state);
    await syncDirectoryChain(authority, session.canonicalPath);
  }
  if (plan.locator) {
    // The locator is a projection of the completed root snapshot. Recreate its
    // directory without recreating or rereading any legacy data source.
    let locatorBoundary = dirname(plan.locator);
    while (!(await present(locatorBoundary))) locatorBoundary = dirname(locatorBoundary);
    await hardenDirectory(dirname(plan.locator));
    const temporary = `${plan.locator}.${transaction.id}.tmp`;
    await writeFile(
      temporary,
      JSON.stringify({ rootId: session.rootId, rootPath: session.canonicalPath }),
      { mode: 0o600 },
    );
    await syncFile(temporary);
    await rename(temporary, plan.locator);
    await syncDirectoryChain(dirname(plan.locator), locatorBoundary);
  }
  await session.commit();
  // The marker is durable once committed; cleanup failure must not report a
  // committed upgrade as failed. A stray plan file is bounded litter.
  await rm(planPath, { force: true }).catch(() => undefined);
  await syncDirectoryChain(authority, session.canonicalPath).catch(() => undefined);
}

async function assertCommittedState(
  state: string,
  session: StorageRootUpgradeSession,
  completion: { readonly deploymentRecord: boolean },
): Promise<void> {
  // stageSnapshot always creates both directories, so a snapshot missing
  // either is incomplete no matter what its remaining contents prove.
  for (const name of ['data', 'deployment'] as const) {
    const entry = await lstat(join(state, name)).catch(() => undefined);
    if (!entry?.isDirectory())
      throw new Error(`Committed snapshot is missing its ${name} directory`);
  }
  await readAccessCredentialFile(join(state, 'data', ACCESS_FILE_NAME));
  await new HostPluginCompositionStore(join(state, 'data')).read();
  const committedDeployment = await validateDeploymentSource(
    join(state, 'deployment'),
    session.rootId,
    session.canonicalPath,
  );
  // The completion record attests whether staging had a deployment record;
  // an attested record that went missing is silent authority loss.
  if (completion.deploymentRecord && committedDeployment === undefined)
    throw new Error('Committed snapshot lost its deployment authority record');
  if (committedDeployment) {
    const target =
      committedDeployment.state === 'active' ? committedDeployment : committedDeployment.to;
    if (!target) throw new Error('Upgraded deployment has no compatible recovery target');
    await assertCompatibleDeployment(target);
  }
}

function planSources(plan: UpgradePlan): ReadonlySet<string> {
  return new Set([plan.data, plan.deployment].filter((source) => source !== null));
}

async function admitLegacyLocks(
  session: StorageRootUpgradeSession,
  locks: readonly string[],
  sources: ReadonlySet<string>,
): Promise<void> {
  for (const lock of locks) {
    // A resumed or derived plan is only trusted within the four legacy lock
    // shapes; anything else is a torn transaction record.
    const name = basename(lock);
    if (
      name !== 'owner.lock' &&
      name !== '.maka-artifact-writer.lock' &&
      !/^[0-9a-f]{64}\.lock$/.test(name)
    )
      throw new Error(`Upgrade plan names an unexpected legacy lock: ${lock}`);
    const parent = dirname(lock);
    if (sources.has(parent)) {
      // A lock inside a plan source exists only with the source. Recreating a
      // deleted source as an empty directory would let the copy below commit
      // empty state, so a missing one skips the lock and fails at copy instead.
      if (!(await present(parent))) continue;
      await session.acquireLegacyLock(lock);
      continue;
    }
    // An inaccessible absent parent cannot admit an old writer either.
    try {
      await mkdir(parent, { recursive: true, mode: 0o700 });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code === 'EACCES' || code === 'EROFS' || code === 'ENOENT') && !(await present(parent)))
        continue;
      throw error;
    }
    await session.acquireLegacyLock(lock);
  }
}

async function stageSnapshot(
  session: StorageRootUpgradeSession,
  staging: string,
  plan: UpgradePlan,
  transactionId: string,
): Promise<void> {
  // Only incomplete staging owned by this transaction is disposable.
  await rm(staging, { recursive: true, force: true });
  await hardenDirectory(staging);
  for (const [name, path] of [
    ['data', plan.data],
    ['deployment', plan.deployment],
  ] as const) {
    const target = join(staging, name);
    if (path === null) await hardenDirectory(target);
    else {
      try {
        // cp must fail if a previously-present source is now missing.
        // Dereference so durable state holds real files, not links out of the
        // root; skip entries cp cannot carry (sockets, FIFOs, devices).
        await cp(path, target, {
          recursive: true,
          dereference: true,
          filter: (entry) => {
            if (
              entry === join(path, 'owner.lock') ||
              entry === join(path, '.maka-artifact-writer.lock')
            )
              return false;
            const kind = lstatSync(entry);
            return kind.isFile() || kind.isDirectory() || kind.isSymbolicLink();
          },
        });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // The durable plan cannot re-derive a source that is gone entirely:
        // pointing at "remove the failing entry" sends the operator after a
        // file that no longer exists.
        const sourceGone = code === 'ENOENT' && !(await present(path));
        const wrapped = new Error(
          sourceGone
            ? `State Root upgrade cannot find its legacy ${name} source (${path}) attested by the durable plan: restore it, or remove the marker's upgrade field and reset schemaVersion to 1 to re-derive the upgrade`
            : `State Root upgrade cannot copy its legacy ${name} source (${path}): repair or remove the failing entry, then retry`,
          { cause: error },
        );
        if (code) Object.assign(wrapped, { code });
        throw wrapped;
      }
    }
  }
  if (plan.targetDeployment) {
    const current = await validateDeploymentSource(
      join(staging, 'deployment'),
      session.rootId,
      session.canonicalPath,
    );
    if (current?.state !== 'active')
      throw new Error('Prepared upgrade no longer has its source deployment');
    const transition = decodeRuntimeHostManagedDeploymentAuthorityRecord({
      schemaVersion: 1,
      state: 'transition',
      transactionId,
      operation: 'update',
      recovery: 'complete_to',
      root: current.root,
      from: current,
      to: decodeRuntimeHostManagedDeploymentConfig(plan.targetDeployment),
    });
    await writeFile(
      join(staging, 'deployment', 'runtime-host-deployment.json'),
      JSON.stringify(transition),
      { mode: 0o600 },
    );
  }
  // Copied entries keep the source's modes; normalize before the validation
  // reads so an unreadable legacy file cannot wedge the upgrade on EACCES.
  await hardenTree(staging);
  await readAccessCredentialFile(join(staging, 'data', ACCESS_FILE_NAME));
  await new HostPluginCompositionStore(join(staging, 'data')).read();
  const stagedDeployment = await validateDeploymentSource(
    join(staging, 'deployment'),
    session.rootId,
    session.canonicalPath,
  );
  await syncTree(staging);
  await writeFile(
    join(staging, COMPLETION),
    JSON.stringify({
      migrationId: transactionId,
      deploymentRecord: stagedDeployment !== undefined,
    }),
    {
      flag: 'wx',
      mode: 0o600,
    },
  );
  await syncFile(join(staging, COMPLETION));
  await syncDirectoryChain(staging, dirname(staging));
}

async function writeUpgradePlan(path: string, plan: UpgradePlan): Promise<void> {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(plan)}\n`, { mode: 0o600 });
  await syncFile(temporary);
  await rename(temporary, path);
  await syncDirectoryChain(dirname(path), dirname(path));
}

async function readUpgradePlan(path: string, rootId: string): Promise<UpgradePlan> {
  try {
    const bytes = await readStableBoundedFile({
      path,
      maxBytes: 4 * 1024 * 1024,
      invalidFile: () => new Error('Invalid upgrade plan'),
    });
    const plan = planSchema.parse(JSON.parse(bytes.toString('utf8')));
    if (plan.rootId !== rootId)
      throw new Error(`Upgrade plan belongs to another State Root: ${path}`);
    // Derived plans always place the locator inside the deployment source; a
    // plan naming it elsewhere is a torn record, not a write target to honor.
    if (
      plan.locator !== null &&
      (plan.deployment === null || plan.locator !== join(plan.deployment, 'root-location.json'))
    )
      throw new Error(`Upgrade plan names an unexpected locator: ${path}`);
    return plan;
  } catch (error) {
    throw new Error(
      `State Root upgrade plan is missing or corrupt: ${path}; restore it, or remove the upgrade field and reset the root marker's schemaVersion to 1 to re-admit the upgrade`,
      { cause: error },
    );
  }
}

export async function prepareRuntimeHostManagedRoot(
  rootId: string,
  authority: RuntimeHostManagedDeploymentAuthorityOptions = {},
): Promise<void> {
  const location = await locateRuntimeHostManagedRoot(rootId, authority);
  if (!location) return;
  if (authority.repairRootAfterRemount)
    await repairStorageRootAfterRemount({
      path: location.rootPath,
      kind: 'interactive',
      expectedRootId: rootId,
    });
  const identity = await inspectStorageRootFormat(location.rootPath);
  if (identity.rootId !== rootId) throw new Error('Managed locator points to another root');
  await prepareRuntimeHostRoot(location.rootPath);
}

async function assertCompatibleDeployment(
  config: RuntimeHostManagedDeploymentConfig,
): Promise<void> {
  const layout = resolveRuntimeHostNpmDeploymentLayout(
    config.deploymentRoot,
    config.launch.package.integrity,
  );
  const authority = join(
    layout.packageRoot,
    'node_modules',
    '@maka',
    'storage',
    'dist',
    'root-authority.js',
  );
  // Ask the exact prepared package, not the invoking Client's version. Importing
  // storage authority creates no root and makes no model/network calls.
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      'const m=await import((await import("node:url")).pathToFileURL(process.argv[1]).href); process.stdout.write(String(m.STORAGE_ROOT_MARKER_SCHEMA_VERSION));',
      authority,
    ],
    { timeout: 15_000, maxBuffer: 4096, env: { ...process.env, NODE_OPTIONS: '' } },
  );
  if (stdout !== String(STORAGE_ROOT_MARKER_SCHEMA_VERSION))
    throw new Error('The prepared managed package cannot open the upgraded State Root');
}

async function inspectLegacySources(session: StorageRootUpgradeSession): Promise<UpgradePlan> {
  const home = userInfo().homedir;
  if (!isAbsolute(home)) throw new Error('Legacy account home must be absolute');
  const cache =
    process.platform === 'darwin'
      ? join(home, 'Library', 'Caches', 'Maka')
      : process.platform === 'win32'
        ? join(home, 'AppData', 'Local', 'Maka')
        : join(home, '.cache', 'maka');
  const durable =
    process.platform === 'darwin'
      ? join(home, 'Library', 'Application Support', 'Maka')
      : process.platform === 'win32'
        ? join(home, 'AppData', 'Local', 'Maka')
        : join(home, '.local', 'share', 'Maka');
  const control = join(cache, 'runtime-hosts', session.rootId);
  const deployment = join(durable, 'runtime-host-deployments', session.rootId);
  const identity = await stat(session.canonicalPath, { bigint: true });
  if (
    process.platform !== 'win32' &&
    typeof process.getuid === 'function' &&
    Number(identity.uid) !== process.getuid()
  ) {
    throw new Error('Upgrade must run as the account that owns the legacy root');
  }
  const bootstrapId = createHash('sha256').update(`${identity.dev}:${identity.ino}`).digest('hex');
  const locks = [
    join(durable, 'state-root-owners', `${session.rootId}.lock`),
    join(control, 'owner.lock'),
    join(cache, 'runtime-hosts', 'artifact-writer-bootstrap', `${bootstrapId}.lock`),
    join(control, '.maka-artifact-writer.lock'),
  ];
  const hasDeployment = await present(deployment);
  return {
    rootId: session.rootId,
    data: (await present(control)) ? control : null,
    deployment: hasDeployment ? deployment : null,
    locator: hasDeployment ? join(deployment, 'root-location.json') : null,
    locks,
  };
}

async function present(path: string): Promise<boolean> {
  try {
    const entry = await stat(path);
    if (!entry.isDirectory()) throw new Error(`Upgrade source is not a directory: ${path}`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

const completionRecordSchema = z
  .object({
    migrationId: z.string(),
    // Whether the staged deployment directory contained an authority record;
    // the committed snapshot must still have it.
    deploymentRecord: z.boolean(),
  })
  .strict();

async function completedSnapshot(
  path: string,
  id: string,
): Promise<{ readonly deploymentRecord: boolean } | false> {
  // A non-directory is debris too: lstat decides type first so a stray file
  // cannot wedge the loop through present()'s directory check.
  if ((await lstat(path).catch(() => undefined))?.isDirectory() !== true) return false;
  let bytes: Buffer;
  try {
    bytes = await readStableBoundedFile({
      path: join(path, COMPLETION),
      maxBytes: 256,
      invalidFile: () =>
        Object.assign(new Error('Invalid upgrade completion record'), {
          code: 'invalid_completion_record',
        }),
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'invalid_completion_record') return false;
    throw error;
  }
  try {
    const value = completionRecordSchema.parse(JSON.parse(bytes.toString('utf8')));
    return value.migrationId === id ? value : false;
  } catch {
    // A torn or foreign record cannot prove completion; re-verify instead.
    return false;
  }
}

async function validateDeploymentSource(
  path: string | null,
  rootId: string,
  rootPath: string,
): Promise<RuntimeHostManagedDeploymentAuthorityRecord | undefined> {
  if (!path) return undefined;
  let contents: Buffer;
  try {
    contents = await readStableBoundedFile({
      path: join(path, 'runtime-host-deployment.json'),
      maxBytes: 512 * 1024,
      invalidFile: () => new Error('Invalid legacy deployment'),
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  let record: ReturnType<typeof decodeRuntimeHostManagedDeploymentAuthorityRecord>;
  try {
    record = decodeRuntimeHostManagedDeploymentAuthorityRecord(
      JSON.parse(contents.toString('utf8')),
    );
  } catch (error) {
    const recordPath = join(path, 'runtime-host-deployment.json');
    if (error instanceof SyntaxError)
      throw new RuntimeHostManagedDeploymentError(
        'invalid_config',
        `Invalid legacy deployment record: ${recordPath}`,
        { cause: error },
      );
    // Keep the typed code; only the message gains the path.
    if (error instanceof RuntimeHostManagedDeploymentError)
      throw new RuntimeHostManagedDeploymentError(error.code, `${error.message}: ${recordPath}`, {
        cause: error,
      });
    throw error;
  }
  if (record.root.id !== rootId || record.root.path !== rootPath)
    throw new Error('Legacy deployment does not belong to the upgrading root');
  return record;
}

async function hardenTree(path: string): Promise<void> {
  await chmod(path, 0o700);
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) await hardenTree(child);
    else if (entry.isFile()) await chmod(child, ((await lstat(child)).mode & 0o700) | 0o600);
  }
}

async function syncTree(path: string): Promise<void> {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) await syncTree(child);
    else if (entry.isFile()) await syncFile(child);
    // The copy admits only files and directories; their parents' directory
    // syncs cover any other dirent that could appear.
  }
  await syncDirectoryChain(path, path);
}
