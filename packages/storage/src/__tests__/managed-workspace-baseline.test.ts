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
import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  cp,
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, before, test } from 'node:test';
import { openManagedWorkspaceOwner } from '../managed-workspace-owner.js';
import { managedWorkspaceExecutionAuthorityTestSupport } from '../managed-workspace-execution-authority-internal.js';
import { createGitWorkspaceService } from '../git-workspace-service.js';
import * as publicStorage from '../index.js';
import { acquireOperationalStateDatabase } from '../operational-state-store.js';
import {
  adoptStorageRootOnImport,
  resolveStorageRoot,
  STORAGE_ROOT_MARKER_FILE,
  tryAcquireInteractiveRootOwner,
} from '../root-authority.js';
import { createSqliteRuntimeStore } from '../sqlite-runtime-store.js';

const execFileAsync = promisify(execFile);
const cleanup: string[] = [];
const {
  inspectHandle: inspectManagedWorkspaceExecutionHandleInternal,
  inspectScope: inspectManagedWorkspaceExecutionScopeInternal,
} = managedWorkspaceExecutionAuthorityTestSupport;
let gitExecutablePath: string;
let gitExecutableSha256: `sha256:${string}`;

before(async () => {
  gitExecutablePath = await findGitExecutable();
  gitExecutableSha256 = await sha256File(gitExecutablePath);
});

test('does not expose baseline receipt issuance on the public Git workspace service', () => {
  const service = createGitWorkspaceService({
    storageRoot: join(tmpdir(), 'maka-public-receipt-authority-test'),
    gitRuntime: {
      executablePath: gitExecutablePath,
      expectedSha256: gitExecutableSha256,
    },
  });
  assert.equal('openManagedWorkspaceBaselineReceipt' in service, false);
  assert.equal('requireManagedWorkspaceBaselineReceipt' in service, false);
  assert.equal('verifyManagedWorkspaceBaselineReceipt' in service, false);
});

test('does not expose artifact-only workspace creation through the public storage API', async () => {
  assert.equal('createGitWorkspaceService' in publicStorage, false);
  assert.equal('issueManagedWorkspaceExecutionHandleInternal' in publicStorage, false);
  assert.equal('inspectManagedWorkspaceExecutionHandleInternal' in publicStorage, false);
  assert.equal('issueManagedWorkspaceExecutionScopeInternal' in publicStorage, false);
  assert.equal('inspectManagedWorkspaceExecutionScopeInternal' in publicStorage, false);
  const root = await temporaryRoot();
  const storageRoot = join(root, 'storage');
  const capability = await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(rootOwner);
  try {
    const owner = await openManagedWorkspaceOwner({
      rootOwner,
      gitRuntime: {
        executablePath: gitExecutablePath,
        expectedSha256: gitExecutableSha256,
      },
    });
    assert.equal('createManagedWorkspaceFromSource' in owner, false);
    assert.equal('openManagedWorkspaceFromBinding' in owner, false);
    await owner.close();
  } finally {
    await rootOwner.close();
  }
});

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test('opens one canonical baseline from a durable verified Git receipt', async () => {
  const root = await temporaryRoot();
  const storageRoot = join(root, 'storage');
  const sourceRoot = await createEligibleSource(join(root, 'source'));
  const capability = await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(rootOwner);
  const runtimeStore = createSqliteRuntimeStore(join(storageRoot, 'runtime.sqlite'));
  try {
    const owner = await openManagedWorkspaceOwner({
      rootOwner,
      gitRuntime: {
        executablePath: gitExecutablePath,
        expectedSha256: gitExecutableSha256,
      },
    });
    const input = openRequest(sourceRoot);

    const first = await owner.openManagedWorkspaceBaseline(runtimeStore, input);
    const retry = await owner.openManagedWorkspaceBaseline(runtimeStore, input);
    const firstEvidence = inspectManagedWorkspaceExecutionHandleInternal(first.executionHandle);
    const retryEvidence = inspectManagedWorkspaceExecutionHandleInternal(retry.executionHandle);

    assert.equal(first.created, true);
    assert.equal(retry.created, false);
    assert.equal('committedAt' in firstEvidence.receipt, false);
    assert.deepEqual(retryEvidence.receipt, firstEvidence.receipt);
    assert.equal(first.head.commitOid, firstEvidence.binding.baselineCommitOid);
    assert.equal(first.head.treeOid, firstEvidence.binding.baselineTreeOid);
    assert.equal(firstEvidence.receipt.changedFileCount, 2);
    assert.equal(firstEvidence.receipt.deletedFileCount, 0);
    assert.equal(firstEvidence.receipt.policyVersion, 1);
    assert.equal(
      firstEvidence.receipt.policyHash,
      'sha256:48eb80c9c8dd6c4d1e7a635dcc187488e0e0b20e2296b81bbaae0be7c5467341',
    );
    assert.match(firstEvidence.receipt.treeDeltaDigest, /^sha256:[a-f0-9]{64}$/u);
    assert.equal(
      firstEvidence.receipt.treeDeltaDigest,
      'sha256:84a37411a467c40c9fd763ab128a6b23e56ec74ab3da2bd54de8d61e375244e8',
    );
    assert.deepEqual(
      await runtimeStore.readWorkspaceHead(input.workspaceId, input.workspaceEpochId),
      first.head,
    );
    const unrelatedStore = createSqliteRuntimeStore(join(root, 'other-root', 'runtime.sqlite'));
    try {
      await assert.rejects(
        owner.openManagedWorkspaceBaseline(unrelatedStore, input),
        /belongs to a different storage root/u,
      );
    } finally {
      unrelatedStore.close();
    }

    const receiptPath = join(dirname(firstEvidence.binding.worktreePath), 'baseline-receipt.json');
    await writeFile(
      receiptPath,
      `${JSON.stringify({
        ...firstEvidence.receipt,
        treeDeltaDigest: `sha256:${'f'.repeat(64)}`,
      })}\n`,
      'utf8',
    );
    await assert.rejects(
      owner.openManagedWorkspaceBaseline(runtimeStore, input),
      /does not match its verified Git boundary/u,
    );
    await writeFile(receiptPath, `${JSON.stringify(firstEvidence.receipt)}\n`, 'utf8');

    await writeFile(
      receiptPath,
      `${JSON.stringify({
        ...firstEvidence.receipt,
        workspaceVersionId: `version_${'a'.repeat(32)}`,
        epochOpenedEventId: `workspace_epoch_opened_${'b'.repeat(64)}`,
        baselineAcceptedEventId: `workspace_baseline_accepted_${'c'.repeat(64)}`,
        policyHash: `sha256:${'d'.repeat(64)}`,
      })}\n`,
      'utf8',
    );
    await assert.rejects(
      owner.openManagedWorkspaceBaseline(runtimeStore, input),
      /does not match its verified Git boundary/u,
    );
    await writeFile(receiptPath, `${JSON.stringify(firstEvidence.receipt)}\n`, 'utf8');

    await writeFile(
      receiptPath,
      `${JSON.stringify({ ...firstEvidence.receipt, committedAt: Date.now() })}\n`,
      'utf8',
    );
    await assert.rejects(
      owner.openManagedWorkspaceBaseline(runtimeStore, input),
      /Invalid managed workspace baseline receipt/u,
    );
    await writeFile(receiptPath, `${JSON.stringify(firstEvidence.receipt)}\n`, 'utf8');

    const bindingPath = join(dirname(firstEvidence.binding.worktreePath), 'binding.json');
    await rm(receiptPath);
    await rm(bindingPath);
    await assert.rejects(
      owner.openManagedWorkspaceBaseline(runtimeStore, input),
      /baseline receipt is unavailable/u,
    );
    await assert.rejects(readFile(bindingPath, 'utf8'), { code: 'ENOENT' });
    assert.deepEqual(
      await runtimeStore.readWorkspaceHead(input.workspaceId, input.workspaceEpochId),
      first.head,
    );
    await owner.close();
  } finally {
    runtimeStore.close();
    await rootOwner.close();
  }
});

test('reuses an orphan receipt after interruption before SQLite acceptance', async () => {
  const root = await temporaryRoot();
  const storageRoot = join(root, 'storage');
  const sourceRoot = await createEligibleSource(join(root, 'source'));
  const capability = await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(rootOwner);
  const runtimeStore = createSqliteRuntimeStore(join(storageRoot, 'runtime.sqlite'));
  let interruptOnce = true;
  try {
    const owner = await openManagedWorkspaceOwner({
      rootOwner,
      gitRuntime: {
        executablePath: gitExecutablePath,
        expectedSha256: gitExecutableSha256,
      },
      failpoint(point) {
        if (point === 'after_baseline_receipt' && interruptOnce) {
          interruptOnce = false;
          throw new Error('simulated interruption after durable baseline receipt');
        }
      },
    });
    const input = openRequest(sourceRoot);

    await assert.rejects(
      owner.openManagedWorkspaceBaseline(runtimeStore, input),
      /simulated interruption/u,
    );
    assert.equal(
      await runtimeStore.readWorkspaceHead(input.workspaceId, input.workspaceEpochId),
      undefined,
    );

    const recovered = await owner.openManagedWorkspaceBaseline(runtimeStore, input);
    const recoveredEvidence = inspectManagedWorkspaceExecutionHandleInternal(
      recovered.executionHandle,
    );
    assert.equal(recovered.created, true);
    assert.equal(recoveredEvidence.receipt.baselineAcceptedEventId, recovered.head.acceptedEventId);
    await owner.close();
  } finally {
    runtimeStore.close();
    await rootOwner.close();
  }
});

test('rejects a receipt read through a replaced instance-root symlink before parsing it', async () => {
  const root = await temporaryRoot();
  const storageRoot = join(root, 'storage');
  const sourceRoot = await createEligibleSource(join(root, 'source'));
  const capability = await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(rootOwner);
  const runtimeStore = createSqliteRuntimeStore(join(storageRoot, 'runtime.sqlite'));
  try {
    const owner = await openManagedWorkspaceOwner({
      rootOwner,
      gitRuntime: {
        executablePath: gitExecutablePath,
        expectedSha256: gitExecutableSha256,
      },
    });
    const accepted = await owner.openManagedWorkspaceBaseline(
      runtimeStore,
      openRequest(sourceRoot),
    );
    const acceptedEvidence = inspectManagedWorkspaceExecutionHandleInternal(
      accepted.executionHandle,
    );
    const instanceRoot = dirname(acceptedEvidence.binding.worktreePath);
    const externalRoot = join(root, 'external-instance');
    await mkdir(externalRoot, { recursive: true });
    const movedInstance = join(externalRoot, 'instance');
    await rename(instanceRoot, movedInstance);
    await symlink(movedInstance, instanceRoot, process.platform === 'win32' ? 'junction' : 'dir');
    await writeFile(join(movedInstance, 'baseline-receipt.json'), '{invalid-json', 'utf8');

    await assert.rejects(
      owner.openManagedWorkspaceBaseline(runtimeStore, openRequest(sourceRoot)),
      /owned directory escaped or changed identity/u,
    );
    await owner.close();
  } finally {
    runtimeStore.close();
    await rootOwner.close();
  }
});

test('serializes concurrent baseline opens under the same managed workspace owner', async () => {
  const root = await temporaryRoot();
  const storageRoot = join(root, 'storage');
  const sourceRoot = await createEligibleSource(join(root, 'source'));
  const capability = await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(rootOwner);
  const runtimeStore = createSqliteRuntimeStore(join(storageRoot, 'runtime.sqlite'));
  try {
    const owner = await openManagedWorkspaceOwner({
      rootOwner,
      gitRuntime: {
        executablePath: gitExecutablePath,
        expectedSha256: gitExecutableSha256,
      },
    });
    const [left, right] = await Promise.all([
      owner.openManagedWorkspaceBaseline(runtimeStore, openRequest(sourceRoot)),
      owner.openManagedWorkspaceBaseline(runtimeStore, openRequest(sourceRoot)),
    ]);
    assert.deepEqual([left.created, right.created].sort(), [false, true]);
    assert.deepEqual(
      inspectManagedWorkspaceExecutionHandleInternal(left.executionHandle).receipt,
      inspectManagedWorkspaceExecutionHandleInternal(right.executionHandle).receipt,
    );
    assert.deepEqual(left.head, right.head);
    await owner.close();
  } finally {
    runtimeStore.close();
    await rootOwner.close();
  }
});

test('rejects a leased authority database whose real root differs from its claimed path', async () => {
  const root = await temporaryRoot();
  const actualRoot = join(root, 'actual-storage');
  const claimedRoot = join(root, 'claimed-storage');
  const sourceRoot = await createEligibleSource(join(root, 'source'));
  const capability = await resolveStorageRoot({ path: claimedRoot, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(rootOwner);
  const databaseLease = acquireOperationalStateDatabase(actualRoot);
  const runtimeStore = createSqliteRuntimeStore(join(claimedRoot, 'runtime.sqlite'), {
    databaseLease,
  });
  try {
    const owner = await openManagedWorkspaceOwner({
      rootOwner,
      gitRuntime: {
        executablePath: gitExecutablePath,
        expectedSha256: gitExecutableSha256,
      },
    });
    await assert.rejects(
      owner.openManagedWorkspaceBaseline(runtimeStore, {
        ...openRequest(sourceRoot),
      }),
      /belongs to a different storage root/u,
    );
    await owner.close();
  } finally {
    runtimeStore.close();
    await rootOwner.close();
  }
});

test('rejects a non-canonical SQLite file in the authenticated storage root', async () => {
  const root = await temporaryRoot();
  const storageRoot = join(root, 'storage');
  const capability = await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(rootOwner);
  const runtimeStore = createSqliteRuntimeStore(join(storageRoot, 'other.sqlite'));
  try {
    const owner = await openManagedWorkspaceOwner({
      rootOwner,
      gitRuntime: {
        executablePath: gitExecutablePath,
        expectedSha256: gitExecutableSha256,
      },
    });
    await assert.rejects(
      owner.openManagedWorkspaceBaseline(runtimeStore, {
        ...openRequest(join(root, 'unused-source')),
      }),
      /unavailable for this storage root/u,
    );
    await owner.close();
  } finally {
    runtimeStore.close();
    await rootOwner.close();
  }
});

test('rejects an in-memory SQLite authority store', async () => {
  const root = await temporaryRoot();
  const storageRoot = join(root, 'storage');
  const capability = await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(rootOwner);
  const runtimeStore = createSqliteRuntimeStore(':memory:');
  try {
    const owner = await openManagedWorkspaceOwner({
      rootOwner,
      gitRuntime: {
        executablePath: gitExecutablePath,
        expectedSha256: gitExecutableSha256,
      },
    });
    await assert.rejects(
      owner.openManagedWorkspaceBaseline(runtimeStore, {
        ...openRequest(join(root, 'unused-source')),
      }),
      /unavailable for this storage root/u,
    );
    await owner.close();
  } finally {
    runtimeStore.close();
    await rootOwner.close();
  }
});

test('rejects a cross-root hard link to the canonical SQLite authority database', async () => {
  const root = await temporaryRoot();
  const sourceStorageRoot = join(root, 'source-storage');
  const claimedStorageRoot = join(root, 'claimed-storage');
  await mkdir(claimedStorageRoot, { recursive: true });
  const sourceDatabasePath = join(sourceStorageRoot, 'runtime.sqlite');
  const sourceStore = createSqliteRuntimeStore(sourceDatabasePath);
  sourceStore.close();
  await link(sourceDatabasePath, join(claimedStorageRoot, 'runtime.sqlite'));

  const capability = await resolveStorageRoot({ path: claimedStorageRoot, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(rootOwner);
  const runtimeStore = createSqliteRuntimeStore(join(claimedStorageRoot, 'runtime.sqlite'));
  try {
    const owner = await openManagedWorkspaceOwner({
      rootOwner,
      gitRuntime: {
        executablePath: gitExecutablePath,
        expectedSha256: gitExecutableSha256,
      },
    });
    await assert.rejects(
      owner.openManagedWorkspaceBaseline(runtimeStore, {
        ...openRequest(join(root, 'unused-source')),
      }),
      /unavailable for this storage root/u,
    );
    await owner.close();
  } finally {
    runtimeStore.close();
    await rootOwner.close();
  }
});

test('rejects a canonical SQLite database copied from a different durable storage root', async () => {
  const root = await temporaryRoot();
  const sourceStorageRoot = join(root, 'storage-a');
  const claimedStorageRoot = join(root, 'storage-b');
  const sourceRoot = await createEligibleSource(join(root, 'source'));
  const request = openRequest(sourceRoot);
  const sourceCapability = await resolveStorageRoot({
    path: sourceStorageRoot,
    kind: 'interactive',
  });
  const sourceRootOwner = await tryAcquireInteractiveRootOwner(sourceCapability);
  assert.ok(sourceRootOwner);
  const sourceStore = createSqliteRuntimeStore(join(sourceStorageRoot, 'runtime.sqlite'));
  try {
    const sourceOwner = await openManagedWorkspaceOwner({
      rootOwner: sourceRootOwner,
      gitRuntime: {
        executablePath: gitExecutablePath,
        expectedSha256: gitExecutableSha256,
      },
    });
    await sourceOwner.openManagedWorkspaceBaseline(sourceStore, request);
    await sourceOwner.close();
  } finally {
    sourceStore.close();
    await sourceRootOwner.close();
  }

  const claimedCapability = await resolveStorageRoot({
    path: claimedStorageRoot,
    kind: 'interactive',
  });
  await copyFile(
    join(sourceStorageRoot, 'runtime.sqlite'),
    join(claimedStorageRoot, 'runtime.sqlite'),
  );
  const claimedRootOwner = await tryAcquireInteractiveRootOwner(claimedCapability);
  assert.ok(claimedRootOwner);
  const claimedStore = createSqliteRuntimeStore(join(claimedStorageRoot, 'runtime.sqlite'));
  try {
    const claimedOwner = await openManagedWorkspaceOwner({
      rootOwner: claimedRootOwner,
      gitRuntime: {
        executablePath: gitExecutablePath,
        expectedSha256: gitExecutableSha256,
      },
    });
    await assert.rejects(
      claimedOwner.openManagedWorkspaceBaseline(claimedStore, request),
      /different durable storage root/u,
    );
    await claimedOwner.close();
  } finally {
    claimedStore.close();
    await claimedRootOwner.close();
  }
});

test('preserves the durable database root binding across formal whole-root import', async () => {
  const root = await temporaryRoot();
  const sourceStorageRoot = join(root, 'storage-a');
  const importedStorageRoot = join(root, 'storage-imported');
  const sourceCapability = await resolveStorageRoot({
    path: sourceStorageRoot,
    kind: 'interactive',
  });
  const sourceRootOwner = await tryAcquireInteractiveRootOwner(sourceCapability);
  assert.ok(sourceRootOwner);
  const sourceStore = createSqliteRuntimeStore(join(sourceStorageRoot, 'runtime.sqlite'));
  try {
    const sourceOwner = await openManagedWorkspaceOwner({
      rootOwner: sourceRootOwner,
      gitRuntime: {
        executablePath: gitExecutablePath,
        expectedSha256: gitExecutableSha256,
      },
    });
    await assert.rejects(
      sourceOwner.openManagedWorkspaceBaseline(
        sourceStore,
        openRequest(join(root, 'missing-source')),
      ),
      /Directory is unavailable/u,
    );
    await sourceOwner.close();
  } finally {
    sourceStore.close();
    await sourceRootOwner.close();
  }

  await cp(sourceStorageRoot, importedStorageRoot, { recursive: true });
  await rm(sourceStorageRoot, { recursive: true, force: true });
  const importedCapability = await adoptStorageRootOnImport({
    path: importedStorageRoot,
    kind: 'interactive',
    expectedRootId: sourceCapability.rootId,
  });
  const importedRootOwner = await tryAcquireInteractiveRootOwner(importedCapability);
  assert.ok(importedRootOwner);
  const importedStore = createSqliteRuntimeStore(join(importedStorageRoot, 'runtime.sqlite'));
  try {
    const importedOwner = await openManagedWorkspaceOwner({
      rootOwner: importedRootOwner,
      gitRuntime: {
        executablePath: gitExecutablePath,
        expectedSha256: gitExecutableSha256,
      },
    });
    await assert.rejects(
      importedOwner.openManagedWorkspaceBaseline(
        importedStore,
        openRequest(join(root, 'missing-source')),
      ),
      /Directory is unavailable/u,
    );
    await importedOwner.close();
  } finally {
    importedStore.close();
    await importedRootOwner.close();
  }
});

test('rejects an authenticated owner after its durable root marker id is replaced', async () => {
  const root = await temporaryRoot();
  const storageRoot = join(root, 'storage');
  const capability = await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(rootOwner);
  const runtimeStore = createSqliteRuntimeStore(join(storageRoot, 'runtime.sqlite'));
  const markerPath = join(storageRoot, STORAGE_ROOT_MARKER_FILE);
  const originalMarker = await readFile(markerPath, 'utf8');
  try {
    const owner = await openManagedWorkspaceOwner({
      rootOwner,
      gitRuntime: {
        executablePath: gitExecutablePath,
        expectedSha256: gitExecutableSha256,
      },
    });
    const marker = JSON.parse(originalMarker) as { rootId: string };
    marker.rootId = `${marker.rootId.startsWith('0') ? '1' : '0'}${marker.rootId.slice(1)}`;
    await writeFile(markerPath, `${JSON.stringify(marker)}\n`, 'utf8');
    await assert.rejects(
      owner.openManagedWorkspaceBaseline(runtimeStore, openRequest(join(root, 'missing-source'))),
      /storage root|root identity|marker/u,
    );
    await writeFile(markerPath, originalMarker, 'utf8');
    await owner.close();
  } finally {
    await writeFile(markerPath, originalMarker, 'utf8');
    runtimeStore.close();
    await rootOwner.close();
  }
});

test('rejects final admission when the root marker changes after post-commit artifact verification', async () => {
  const root = await temporaryRoot();
  const storageRoot = join(root, 'storage');
  const sourceRoot = await createEligibleSource(join(root, 'source'));
  const request = openRequest(sourceRoot);
  const capability = await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(rootOwner);
  const runtimeStore = createSqliteRuntimeStore(join(storageRoot, 'runtime.sqlite'));
  const markerPath = join(storageRoot, STORAGE_ROOT_MARKER_FILE);
  const originalMarker = await readFile(markerPath, 'utf8');
  let replaceOnce = true;
  const owner = await openManagedWorkspaceOwner({
    rootOwner,
    gitRuntime: {
      executablePath: gitExecutablePath,
      expectedSha256: gitExecutableSha256,
    },
    async failpoint(point) {
      if ((point as string) !== 'after_post_commit_artifact_verification' || !replaceOnce) return;
      replaceOnce = false;
      const marker = JSON.parse(originalMarker) as { rootId: string };
      marker.rootId = `${marker.rootId.startsWith('0') ? '1' : '0'}${marker.rootId.slice(1)}`;
      await writeFile(markerPath, `${JSON.stringify(marker)}\n`, 'utf8');
    },
  });
  try {
    await assert.rejects(
      owner.openManagedWorkspaceBaseline(runtimeStore, request),
      /storage root|root identity|marker/u,
    );
    assert.ok(await runtimeStore.readWorkspaceHead(request.workspaceId, request.workspaceEpochId));
  } finally {
    await writeFile(markerPath, originalMarker, 'utf8');
    await owner.close();
    runtimeStore.close();
    await rootOwner.close();
  }
});

test('rejects an authority database whose file identity changes after registration', {
  skip:
    process.platform === 'win32'
      ? 'Windows cannot rename an open SQLite database to replace its file identity'
      : false,
}, async () => {
  const root = await temporaryRoot();
  const storageRoot = join(root, 'storage');
  const databasePath = join(storageRoot, 'runtime.sqlite');
  const capability = await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(rootOwner);
  const runtimeStore = createSqliteRuntimeStore(databasePath);
  try {
    const owner = await openManagedWorkspaceOwner({
      rootOwner,
      gitRuntime: {
        executablePath: gitExecutablePath,
        expectedSha256: gitExecutableSha256,
      },
    });
    await rename(databasePath, `${databasePath}.replaced`);
    await writeFile(databasePath, 'replacement database identity\n', 'utf8');
    await assert.rejects(
      owner.openManagedWorkspaceBaseline(runtimeStore, openRequest(join(root, 'unused-source'))),
      /database file identity changed/u,
    );
    await owner.close();
  } finally {
    runtimeStore.close();
    await rootOwner.close();
  }
});

test('does not return an accepted baseline when runtime.sqlite is replaced after the initial root check', {
  skip:
    process.platform === 'win32'
      ? 'Windows cannot rename an open SQLite database during the verification race'
      : false,
}, async () => {
  const root = await temporaryRoot();
  const storageRoot = join(root, 'storage');
  const databasePath = join(storageRoot, 'runtime.sqlite');
  const sourceRoot = await createEligibleSource(join(root, 'source'));
  const request = openRequest(sourceRoot);
  const capability = await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(rootOwner);
  const runtimeStore = createSqliteRuntimeStore(databasePath);
  let replaceOnce = true;
  const owner = await openManagedWorkspaceOwner({
    rootOwner,
    gitRuntime: {
      executablePath: gitExecutablePath,
      expectedSha256: gitExecutableSha256,
    },
    async failpoint(point) {
      if ((point as string) !== 'after_initial_store_root_validation' || !replaceOnce) return;
      replaceOnce = false;
      await rename(databasePath, `${databasePath}.detached`);
      await writeFile(databasePath, 'replacement database identity\n', 'utf8');
    },
  });
  try {
    await assert.rejects(
      owner.openManagedWorkspaceBaseline(runtimeStore, request),
      /database file identity changed/u,
    );
  } finally {
    await owner.close();
    runtimeStore.close();
    await rootOwner.close();
  }

  await Promise.all([
    rm(databasePath, { force: true }),
    rm(`${databasePath}-wal`, { force: true }),
    rm(`${databasePath}-shm`, { force: true }),
  ]);
  // SQLite may keep the accepted transaction in a WAL that remains associated
  // with the original pathname, so the detached main file is not a portable
  // authority read after this adversarial rename. The safety invariant is that
  // the replacement canonical database never receives that head and no usable
  // baseline was returned above.
  const replacementStore = createSqliteRuntimeStore(databasePath);
  try {
    assert.equal(
      await replacementStore.readWorkspaceHead(request.workspaceId, request.workspaceEpochId),
      undefined,
    );
  } finally {
    replacementStore.close();
  }
});

test('rejects runtime.sqlite when the canonical database path is a symlink', async (context) => {
  const root = await temporaryRoot();
  const storageRoot = join(root, 'storage');
  const externalRoot = join(root, 'external');
  await mkdir(storageRoot, { recursive: true });
  const externalPath = join(externalRoot, 'runtime.sqlite');
  createSqliteRuntimeStore(externalPath).close();
  try {
    await symlink(externalPath, join(storageRoot, 'runtime.sqlite'), 'file');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES')) {
      context.skip('File symlinks require Windows developer mode or elevated privileges');
      return;
    }
    throw error;
  }

  const capability = await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(rootOwner);
  const runtimeStore = createSqliteRuntimeStore(join(storageRoot, 'runtime.sqlite'));
  try {
    const owner = await openManagedWorkspaceOwner({
      rootOwner,
      gitRuntime: {
        executablePath: gitExecutablePath,
        expectedSha256: gitExecutableSha256,
      },
    });
    await assert.rejects(
      owner.openManagedWorkspaceBaseline(runtimeStore, {
        ...openRequest(join(root, 'unused-source')),
      }),
      /unavailable for this storage root/u,
    );
    await owner.close();
  } finally {
    runtimeStore.close();
    await rootOwner.close();
  }
});

test('keeps an orphan receipt across SQLite rollback and accepts it on retry', async () => {
  const root = await temporaryRoot();
  const storageRoot = join(root, 'storage');
  const sourceRoot = await createEligibleSource(join(root, 'source'));
  const capability = await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(rootOwner);
  let interruptOnce = true;
  const runtimeStore = createSqliteRuntimeStore(join(storageRoot, 'runtime.sqlite'), {
    failpoint(point) {
      if (point === 'after_workspace_version_event_insert' && interruptOnce) {
        interruptOnce = false;
        throw new Error('simulated SQLite baseline rollback');
      }
    },
  });
  try {
    const owner = await openManagedWorkspaceOwner({
      rootOwner,
      gitRuntime: {
        executablePath: gitExecutablePath,
        expectedSha256: gitExecutableSha256,
      },
    });
    const input = openRequest(sourceRoot);

    await assert.rejects(
      owner.openManagedWorkspaceBaseline(runtimeStore, input),
      /simulated SQLite baseline rollback/u,
    );
    assert.equal(
      await runtimeStore.readWorkspaceHead(input.workspaceId, input.workspaceEpochId),
      undefined,
    );

    const recovered = await owner.openManagedWorkspaceBaseline(runtimeStore, input);
    const recoveredEvidence = inspectManagedWorkspaceExecutionHandleInternal(
      recovered.executionHandle,
    );
    assert.equal(recovered.created, true);
    assert.equal(recoveredEvidence.receipt.workspaceVersionId, recovered.head.workspaceVersionId);
    await owner.close();
  } finally {
    runtimeStore.close();
    await rootOwner.close();
  }
});

test('accepts the same durable receipt after a real process crash before SQLite authority', {
  timeout: 60_000,
}, async () => {
  const root = await temporaryRoot();
  const storageRoot = join(root, 'storage');
  const sourceRoot = await createEligibleSource(join(root, 'source'));
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('./fixtures/git-workspace-service-crash-child.js', import.meta.url))],
    {
      env: {
        ...process.env,
        MAKA_GIT_WORKSPACE_STORAGE: storageRoot,
        MAKA_GIT_WORKSPACE_SOURCE: sourceRoot,
        MAKA_GIT_WORKSPACE_EXECUTABLE: gitExecutablePath,
        MAKA_GIT_WORKSPACE_SHA256: gitExecutableSha256,
        MAKA_GIT_WORKSPACE_FAILPOINT: 'after_baseline_receipt',
        MAKA_GIT_WORKSPACE_ACTION: 'baseline-receipt',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  try {
    await waitForReady(child, 30_000);
    const durableBeforeCrash = JSON.parse(
      await readFile(baselineReceiptPath(storageRoot, openRequest(sourceRoot)), 'utf8'),
    );
    child.kill('SIGKILL');
    await waitForExit(child);

    const capability = await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
    const rootOwner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(rootOwner);
    const runtimeStore = createSqliteRuntimeStore(join(storageRoot, 'runtime.sqlite'));
    try {
      const owner = await openManagedWorkspaceOwner({
        rootOwner,
        gitRuntime: {
          executablePath: gitExecutablePath,
          expectedSha256: gitExecutableSha256,
        },
      });
      const accepted = await owner.openManagedWorkspaceBaseline(runtimeStore, {
        ...openRequest(sourceRoot),
      });
      const acceptedEvidence = inspectManagedWorkspaceExecutionHandleInternal(
        accepted.executionHandle,
      );
      assert.equal(accepted.created, true);
      assert.equal(acceptedEvidence.receipt.baselineAcceptedEventId, accepted.head.acceptedEventId);
      assert.deepEqual(acceptedEvidence.receipt, durableBeforeCrash);
      await owner.close();
    } finally {
      runtimeStore.close();
      await rootOwner.close();
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

test('reopens the exact accepted baseline after a real crash before post-commit verification', {
  timeout: 60_000,
}, async () => {
  const root = await temporaryRoot();
  const storageRoot = join(root, 'storage');
  const sourceRoot = await createEligibleSource(join(root, 'source'));
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('./fixtures/git-workspace-service-crash-child.js', import.meta.url))],
    {
      env: {
        ...process.env,
        MAKA_GIT_WORKSPACE_STORAGE: storageRoot,
        MAKA_GIT_WORKSPACE_SOURCE: sourceRoot,
        MAKA_GIT_WORKSPACE_EXECUTABLE: gitExecutablePath,
        MAKA_GIT_WORKSPACE_SHA256: gitExecutableSha256,
        MAKA_GIT_WORKSPACE_FAILPOINT: 'after_baseline_authority_commit',
        MAKA_GIT_WORKSPACE_ACTION: 'baseline-receipt',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  try {
    await waitForReady(child, 30_000);
    const durableBeforeCrash = JSON.parse(
      await readFile(baselineReceiptPath(storageRoot, openRequest(sourceRoot)), 'utf8'),
    );
    child.kill('SIGKILL');
    await waitForExit(child);

    const capability = await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
    const rootOwner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(rootOwner);
    const runtimeStore = createSqliteRuntimeStore(join(storageRoot, 'runtime.sqlite'));
    try {
      const owner = await openManagedWorkspaceOwner({
        rootOwner,
        gitRuntime: {
          executablePath: gitExecutablePath,
          expectedSha256: gitExecutableSha256,
        },
      });
      const reopened = await owner.openManagedWorkspaceBaseline(
        runtimeStore,
        openRequest(sourceRoot),
      );
      const reopenedEvidence = inspectManagedWorkspaceExecutionHandleInternal(
        reopened.executionHandle,
      );
      assert.equal(reopened.created, false);
      assert.deepEqual(reopenedEvidence.receipt, durableBeforeCrash);
      assert.equal(reopened.head.acceptedEventId, reopenedEvidence.receipt.baselineAcceptedEventId);
      await owner.close();
    } finally {
      runtimeStore.close();
      await rootOwner.close();
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

test('reissues execution authority after a real process crash during admission verification', {
  timeout: 60_000,
}, async () => {
  const root = await temporaryRoot();
  const storageRoot = join(root, 'storage');
  const sourceRoot = await createEligibleSource(join(root, 'source'));
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('./fixtures/git-workspace-service-crash-child.js', import.meta.url))],
    {
      env: {
        ...process.env,
        MAKA_GIT_WORKSPACE_STORAGE: storageRoot,
        MAKA_GIT_WORKSPACE_SOURCE: sourceRoot,
        MAKA_GIT_WORKSPACE_EXECUTABLE: gitExecutablePath,
        MAKA_GIT_WORKSPACE_SHA256: gitExecutableSha256,
        MAKA_GIT_WORKSPACE_FAILPOINT: 'after_execution_artifact_verification',
        MAKA_GIT_WORKSPACE_ACTION: 'execution-admission',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  try {
    await waitForReady(child, 30_000);
    child.kill('SIGKILL');
    await waitForExit(child);

    const capability = await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
    const rootOwner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(rootOwner);
    const runtimeStore = createSqliteRuntimeStore(join(storageRoot, 'runtime.sqlite'));
    try {
      const owner = await openManagedWorkspaceOwner({
        rootOwner,
        gitRuntime: {
          executablePath: gitExecutablePath,
          expectedSha256: gitExecutableSha256,
        },
      });
      const reopened = await owner.openManagedWorkspaceBaseline(
        runtimeStore,
        openRequest(sourceRoot),
      );
      let observedCwd: string | undefined;
      await owner.withManagedWorkspaceExecution(reopened.executionHandle, async (scope) => {
        const context = inspectManagedWorkspaceExecutionScopeInternal(scope);
        observedCwd = context.cwd;
        assert.equal(await readFile(join(context.cwd, 'tracked.txt'), 'utf8'), 'tracked\n');
      });
      assert.equal(
        observedCwd,
        inspectManagedWorkspaceExecutionHandleInternal(reopened.executionHandle).binding
          .worktreePath,
      );
      await owner.close();
    } finally {
      runtimeStore.close();
      await rootOwner.close();
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

test('rejects a source tree containing a non-UTF-8 Git path', {
  skip: process.platform === 'win32',
}, async () => {
  const root = await temporaryRoot();
  const storageRoot = join(root, 'storage');
  const sourceRoot = await createEligibleSource(join(root, 'source'));
  await commitInvalidUtf8Path(sourceRoot);
  const capability = await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(rootOwner);
  const runtimeStore = createSqliteRuntimeStore(join(storageRoot, 'runtime.sqlite'));
  try {
    const owner = await openManagedWorkspaceOwner({
      rootOwner,
      gitRuntime: {
        executablePath: gitExecutablePath,
        expectedSha256: gitExecutableSha256,
      },
    });
    await assert.rejects(
      owner.openManagedWorkspaceBaseline(runtimeStore, openRequest(sourceRoot)),
      /requires Git paths to be valid UTF-8/u,
    );
    await owner.close();
  } finally {
    runtimeStore.close();
    await rootOwner.close();
  }
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'maka-managed-workspace-baseline-'));
  cleanup.push(root);
  return root;
}

async function findGitExecutable(): Promise<string> {
  const command = process.platform === 'win32' ? 'where.exe' : 'which';
  const { stdout } = await execFileAsync(command, ['git'], { encoding: 'utf8' });
  const first = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean);
  if (!first) throw new Error('Git executable is unavailable for integration tests');
  return realpath(first);
}

async function sha256File(path: string): Promise<`sha256:${string}`> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return `sha256:${hash.digest('hex')}`;
}

async function createEligibleSource(sourceRoot: string): Promise<string> {
  await mkdir(sourceRoot, { recursive: true });
  await git(sourceRoot, 'init', '--quiet');
  await writeFile(join(sourceRoot, 'tracked.txt'), 'tracked\n', 'utf8');
  await writeFile(join(sourceRoot, '.gitignore'), '.maka-workspace.json\n', 'utf8');
  await writeFile(join(sourceRoot, '.maka-workspace.json'), '{"host":"metadata"}\n', 'utf8');
  await git(sourceRoot, 'add', 'tracked.txt', '.gitignore');
  await git(
    sourceRoot,
    '-c',
    'user.name=Maka Test',
    '-c',
    'user.email=test@maka.invalid',
    'commit',
    '--quiet',
    '-m',
    'source baseline',
  );
  return realpath(sourceRoot);
}

async function commitInvalidUtf8Path(sourceRoot: string): Promise<void> {
  const invalidPath = Buffer.from([0xff]);
  const blobOid = gitWithInput(sourceRoot, ['hash-object', '-w', '--stdin'], 'invalid\n')
    .toString('ascii')
    .trim();
  const existingEntries = gitWithInput(sourceRoot, ['ls-tree', '-z', 'HEAD']);
  const invalidEntry = Buffer.concat([
    Buffer.from(`100644 blob ${blobOid}\t`, 'ascii'),
    invalidPath,
    Buffer.from([0]),
  ]);
  const treeOid = gitWithInput(
    sourceRoot,
    ['mktree', '-z'],
    Buffer.concat([existingEntries, invalidEntry]),
  )
    .toString('ascii')
    .trim();
  const parentOid = await git(sourceRoot, 'rev-parse', 'HEAD');
  const commitOid = gitWithInput(
    sourceRoot,
    [
      '-c',
      'user.name=Maka Test',
      '-c',
      'user.email=test@maka.invalid',
      'commit-tree',
      treeOid,
      '-p',
      parentOid,
    ],
    'add invalid path\n',
  )
    .toString('ascii')
    .trim();

  await git(sourceRoot, 'update-ref', 'HEAD', commitOid, parentOid);
  await git(sourceRoot, 'read-tree', treeOid);
  // Keep Git status clean without asking the filesystem to materialize the invalid path.
  gitWithInput(
    sourceRoot,
    ['update-index', '--skip-worktree', '-z', '--stdin'],
    Buffer.concat([invalidPath, Buffer.from([0])]),
  );
}

function openRequest(sourceRoot: string) {
  return {
    repositoryId: 'repository_11111111111111111111111111111111',
    workspaceId: 'workspace_22222222222222222222222222222222',
    workspaceEpochId: 'epoch_33333333333333333333333333333333',
    workspaceInstanceId: 'instance_44444444444444444444444444444444',
    sourceRoot,
  } as const;
}

function baselineReceiptPath(
  storageRoot: string,
  identity: ReturnType<typeof openRequest>,
): string {
  const compact = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 20);
  return join(
    storageRoot,
    'managed-workspaces',
    'w',
    compact(identity.workspaceId),
    'e',
    compact(identity.workspaceEpochId),
    'i',
    compact(identity.workspaceInstanceId),
    'baseline-receipt.json',
  );
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout.trim();
}

function gitWithInput(
  cwd: string,
  args: readonly string[],
  input: string | Buffer = Buffer.alloc(0),
): Buffer {
  return execFileSync('git', args, {
    cwd,
    input,
    maxBuffer: 8 * 1024 * 1024,
  });
}

function waitForReady(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Managed baseline crash child did not become ready: ${stderr}`));
    }, timeoutMs);
    const onStdout = (chunk: unknown) => {
      stdout += String(chunk);
      if (stdout.includes('READY\n')) {
        cleanup();
        resolve();
      }
    };
    const onStderr = (chunk: unknown) => {
      stderr += String(chunk);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`Managed baseline crash child exited early: ${code}/${signal} ${stderr}`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout?.off('data', onStdout);
      child.stderr?.off('data', onStderr);
      child.off('exit', onExit);
    };
    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);
    child.once('exit', onExit);
  });
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    child.once('exit', () => resolve());
    child.once('error', reject);
  });
}
