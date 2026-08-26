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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  applyLocalHostDeploymentTransition,
  readLocalHostDeploymentRecord,
  type LocalHostDeploymentAuthorityOptions,
  type RuntimeHostInstallationOwner,
} from '../operator/local-deployment-owner.js';
import {
  claimLocalHostProcessDeployment,
  handoffLocalHostProcessDeployment,
  type LocalHostProcessDeploymentClaimAdapter,
  type LocalHostProcessDeploymentHandoffAdapter,
} from '../operator/local-process-deployment-handoff.js';
import type { RuntimeHostDeploymentIdentity } from '../operator/update-package-evidence.js';

const ROOT_ID = 'b'.repeat(64);
const DESKTOP: RuntimeHostInstallationOwner = {
  kind: 'desktop',
  installationId: 'desktop:stable',
};
const CLI: RuntimeHostInstallationOwner = {
  kind: 'cli',
  installationId: 'cli:global',
};
const OLD_DEPLOYMENT: RuntimeHostDeploymentIdentity = {
  kind: 'npm_registry',
  version: '1.0.0',
  integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
};
const TARGET_DEPLOYMENT: RuntimeHostDeploymentIdentity = {
  kind: 'npm_registry',
  version: '2.0.0',
  integrity: `sha512-${Buffer.alloc(64, 2).toString('base64')}`,
};

async function authority(t: test.TestContext): Promise<LocalHostDeploymentAuthorityOptions> {
  const authorityRoot = await mkdtemp(join(tmpdir(), 'maka-local-process-transfer-'));
  t.after(() => rm(authorityRoot, { recursive: true, force: true }));
  return { authorityRoot };
}

async function claimed(options: LocalHostDeploymentAuthorityOptions) {
  const result = await applyLocalHostDeploymentTransition(
    ROOT_ID,
    { kind: 'claim', owner: DESKTOP, selected: OLD_DEPLOYMENT },
    options,
  );
  assert.equal(result.kind, 'applied');
  return result.record!;
}

function adapter(
  events: string[],
  host: 'target_absent' | 'target_present' | 'active_work' = 'target_absent',
): LocalHostProcessDeploymentHandoffAdapter<{ readonly path: string }> {
  return {
    async stageTarget(target, transactionId) {
      events.push(`stage:${target.version}:${transactionId}`);
      return { path: '/verified/maka' };
    },
    async prepareHostCutover(_rootId, _selected, _target, _staged, policy) {
      events.push(`retire:${policy}`);
      return { kind: host };
    },
    async observeWriterRelease() {
      events.push('writer_released');
    },
    async activateTarget(_rootId, staged) {
      events.push(`activate:${staged.path}`);
    },
    async verifyTargetReady(_rootId, target) {
      events.push(`ready:${target.version}`);
    },
  };
}

test('stages first and commits only after retirement, writer release, and exact Ready verification', async (t) => {
  const options = await authority(t);
  const initial = await claimed(options);
  const events: string[] = [];

  const result = await handoffLocalHostProcessDeployment(
    {
      rootId: ROOT_ID,
      expectedRevision: initial.revision,
      transactionId: 'desktop-to-cli',
      from: DESKTOP,
      to: CLI,
      target: TARGET_DEPLOYMENT,
      activeWorkPolicy: 'refuse_active_work',
    },
    {
      ...adapter(events),
      async prepareHostCutover(rootId, _selected, _target, _staged, policy) {
        const intent = await readLocalHostDeploymentRecord(rootId, options);
        assert.equal(intent?.state.kind, 'handoff');
        events.push(`retire:${policy}`);
        return { kind: 'target_absent' };
      },
    },
    options,
  );

  assert.equal(result.kind, 'completed');
  assert.deepEqual(events, [
    'stage:2.0.0:desktop-to-cli',
    'retire:refuse_active_work',
    'writer_released',
    'activate:/verified/maka',
    'ready:2.0.0',
  ]);
  assert.deepEqual(result.record.state, {
    kind: 'owned',
    owner: CLI,
    selected: TARGET_DEPLOYMENT,
    previous: OLD_DEPLOYMENT,
  });

  const retryEvents: string[] = [];
  const retried = await handoffLocalHostProcessDeployment(
    {
      rootId: ROOT_ID,
      expectedRevision: initial.revision,
      transactionId: 'desktop-to-cli',
      from: DESKTOP,
      to: CLI,
      target: TARGET_DEPLOYMENT,
      activeWorkPolicy: 'refuse_active_work',
    },
    adapter(retryEvents),
    options,
  );
  assert.equal(retried.kind, 'completed');
  assert.equal(retried.record.revision, result.record.revision);
  assert.deepEqual(retryEvents, ['stage:2.0.0:desktop-to-cli']);
});

test('replaces a deployment without inventing a second same-owner transaction', async (t) => {
  const options = await authority(t);
  const initial = await claimed(options);
  const events: string[] = [];

  const result = await handoffLocalHostProcessDeployment(
    {
      rootId: ROOT_ID,
      expectedRevision: initial.revision,
      transactionId: 'desktop-upgrade',
      from: DESKTOP,
      to: DESKTOP,
      target: TARGET_DEPLOYMENT,
      activeWorkPolicy: 'refuse_active_work',
    },
    adapter(events),
    options,
  );

  assert.equal(result.kind, 'completed');
  assert.deepEqual(result.record.state, {
    kind: 'owned',
    owner: DESKTOP,
    selected: TARGET_DEPLOYMENT,
    previous: OLD_DEPLOYMENT,
  });
  assert.deepEqual(events, [
    'stage:2.0.0:desktop-upgrade',
    'retire:refuse_active_work',
    'writer_released',
    'activate:/verified/maka',
    'ready:2.0.0',
  ]);
});

test('replays commit to confirm durability instead of trusting read-back state', async (t) => {
  if (process.platform === 'win32') return;
  const base = await authority(t);
  const initial = await claimed(base);
  let publishCount = 0;
  let confirmationFailure = true;
  const options: LocalHostDeploymentAuthorityOptions = {
    ...base,
    beforeDirectorySync: (_path, purpose) => {
      if (purpose === 'record_publish') {
        publishCount += 1;
        if (publishCount === 2) throw new Error('injected commit sync failure');
      }
      if (purpose === 'unchanged_confirmation' && confirmationFailure) {
        confirmationFailure = false;
        throw new Error('injected confirmation sync failure');
      }
    },
  };
  const request = {
    rootId: ROOT_ID,
    expectedRevision: initial.revision,
    transactionId: 'durability-recovery',
    from: DESKTOP,
    to: CLI,
    target: TARGET_DEPLOYMENT,
    activeWorkPolicy: 'refuse_active_work' as const,
  };

  const first = await handoffLocalHostProcessDeployment(request, adapter([]), options);
  assert.equal(first.kind, 'recovery_required');
  assert.equal(first.kind === 'recovery_required' ? first.phase : undefined, 'commit_handoff');

  const recoveryEvents: string[] = [];
  const recovered = await handoffLocalHostProcessDeployment(
    request,
    adapter(recoveryEvents),
    options,
  );
  assert.equal(recovered.kind, 'completed');
  assert.deepEqual(recoveryEvents, ['stage:2.0.0:durability-recovery']);
});

test('rejects a stale confirmation before retiring any Host', async (t) => {
  const options = await authority(t);
  const initial = await claimed(options);
  const released = await applyLocalHostDeploymentTransition(
    ROOT_ID,
    {
      kind: 'release',
      expectedRevision: initial.revision,
      owner: DESKTOP,
    },
    options,
  );
  assert.equal(released.kind, 'applied');
  const reclaimed = await applyLocalHostDeploymentTransition(
    ROOT_ID,
    { kind: 'claim', owner: DESKTOP, selected: OLD_DEPLOYMENT },
    options,
  );
  assert.equal(reclaimed.kind, 'applied');
  const events: string[] = [];

  const result = await handoffLocalHostProcessDeployment(
    {
      rootId: ROOT_ID,
      expectedRevision: initial.revision,
      transactionId: 'stale-confirmation',
      from: DESKTOP,
      to: CLI,
      target: TARGET_DEPLOYMENT,
      activeWorkPolicy: 'refuse_active_work',
    },
    adapter(events),
    options,
  );

  assert.equal(result.kind, 'rejected');
  assert.equal(result.kind === 'rejected' ? result.reason : undefined, 'revision_changed');
  assert.deepEqual(events, ['stage:2.0.0:stale-confirmation']);
});

test('leaves the previous owner authoritative when target staging fails', async (t) => {
  const options = await authority(t);
  const initial = await claimed(options);
  const failingAdapter = adapter([]);
  failingAdapter.stageTarget = async () => {
    throw new Error('integrity verification failed');
  };

  await assert.rejects(
    handoffLocalHostProcessDeployment(
      {
        rootId: ROOT_ID,
        expectedRevision: initial.revision,
        transactionId: 'stage-failed',
        from: DESKTOP,
        to: CLI,
        target: TARGET_DEPLOYMENT,
        activeWorkPolicy: 'refuse_active_work',
      },
      failingAdapter,
      options,
    ),
    /integrity verification failed/,
  );
  assert.deepEqual((await readLocalHostDeploymentRecord(ROOT_ID, options))?.state, {
    kind: 'owned',
    owner: DESKTOP,
    selected: OLD_DEPLOYMENT,
  });
});

test('rolls back durable intent when the exact Host refuses active work', async (t) => {
  const options = await authority(t);
  const initial = await claimed(options);
  const events: string[] = [];

  const result = await handoffLocalHostProcessDeployment(
    {
      rootId: ROOT_ID,
      expectedRevision: initial.revision,
      transactionId: 'active-work',
      from: DESKTOP,
      to: CLI,
      target: TARGET_DEPLOYMENT,
      activeWorkPolicy: 'refuse_active_work',
    },
    adapter(events, 'active_work'),
    options,
  );

  assert.equal(result.kind, 'active_work');
  assert.deepEqual(result.record.state, {
    kind: 'owned',
    owner: DESKTOP,
    selected: OLD_DEPLOYMENT,
  });
  assert.deepEqual(events, ['stage:2.0.0:active-work', 'retire:refuse_active_work']);
});

test('keeps handoff truth after a post-retirement failure and resumes by re-observing', async (t) => {
  const options = await authority(t);
  const initial = await claimed(options);
  const firstEvents: string[] = [];
  const firstAdapter = adapter(firstEvents);
  firstAdapter.activateTarget = async () => {
    firstEvents.push('activate:failed');
    throw new Error('launch failed');
  };

  const request = {
    rootId: ROOT_ID,
    expectedRevision: initial.revision,
    transactionId: 'recover-after-retirement',
    from: DESKTOP,
    to: CLI,
    target: TARGET_DEPLOYMENT,
    activeWorkPolicy: 'interrupt_active_work' as const,
  };
  const failed = await handoffLocalHostProcessDeployment(request, firstAdapter, options);

  assert.equal(failed.kind, 'recovery_required');
  assert.equal(failed.kind === 'recovery_required' ? failed.phase : undefined, 'activate_target');
  assert.equal((await readLocalHostDeploymentRecord(ROOT_ID, options))?.state.kind, 'handoff');

  const recoveryEvents: string[] = [];
  const recovered = await handoffLocalHostProcessDeployment(
    request,
    adapter(recoveryEvents, 'target_absent'),
    options,
  );
  assert.equal(recovered.kind, 'completed');
  assert.deepEqual(recoveryEvents, [
    'stage:2.0.0:recover-after-retirement',
    'retire:interrupt_active_work',
    'writer_released',
    'activate:/verified/maka',
    'ready:2.0.0',
  ]);
});

test('recognizes an already-started exact target without retiring or launching it again', async (t) => {
  const options = await authority(t);
  const initial = await claimed(options);
  const firstEvents: string[] = [];
  const firstAdapter = adapter(firstEvents);
  firstAdapter.verifyTargetReady = async () => {
    firstEvents.push('ready:failed');
    throw new Error('caller lost the Ready result');
  };
  const request = {
    rootId: ROOT_ID,
    expectedRevision: initial.revision,
    transactionId: 'recover-running-target',
    from: DESKTOP,
    to: CLI,
    target: TARGET_DEPLOYMENT,
    activeWorkPolicy: 'refuse_active_work' as const,
  };
  assert.equal(
    (await handoffLocalHostProcessDeployment(request, firstAdapter, options)).kind,
    'recovery_required',
  );

  const recoveryEvents: string[] = [];
  const recovered = await handoffLocalHostProcessDeployment(
    request,
    adapter(recoveryEvents, 'target_present'),
    options,
  );

  assert.equal(recovered.kind, 'completed');
  assert.deepEqual(recoveryEvents, [
    'stage:2.0.0:recover-running-target',
    'retire:refuse_active_work',
    'ready:2.0.0',
  ]);
});

test('serializes the whole cutover so a competing owner mutation cannot enter mid-handoff', async (t) => {
  const options = await authority(t);
  const initial = await claimed(options);
  let releaseRetirement!: () => void;
  let retirementEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    retirementEntered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    releaseRetirement = resolve;
  });
  const events: string[] = [];
  const heldAdapter = adapter(events);
  heldAdapter.prepareHostCutover = async () => {
    retirementEntered();
    await held;
    return { kind: 'target_absent' };
  };

  const handoff = handoffLocalHostProcessDeployment(
    {
      rootId: ROOT_ID,
      expectedRevision: initial.revision,
      transactionId: 'serialized-handoff',
      from: DESKTOP,
      to: CLI,
      target: TARGET_DEPLOYMENT,
      activeWorkPolicy: 'refuse_active_work',
    },
    heldAdapter,
    options,
  );
  await entered;
  let competitorSettled = false;
  const competitor = applyLocalHostDeploymentTransition(
    ROOT_ID,
    {
      kind: 'release',
      expectedRevision: initial.revision,
      owner: DESKTOP,
    },
    options,
  ).finally(() => {
    competitorSettled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(competitorSettled, false);

  releaseRetirement();
  assert.equal((await handoff).kind, 'completed');
  const competingResult = await competitor;
  assert.equal(competingResult.kind, 'rejected');
  assert.equal(
    competingResult.kind === 'rejected' ? competingResult.reason : undefined,
    'owner_changed',
  );
});

function claimAdapter(
  events: string[],
  host: 'target_absent' | 'target_present' | 'active_work' = 'target_absent',
): LocalHostProcessDeploymentClaimAdapter<{ readonly path: string }> {
  return {
    async stageTarget(target, transactionId) {
      events.push(`stage:${target.version}:${transactionId}`);
      return { path: '/verified/maka' };
    },
    async prepareUnownedHostCutover(_rootId, _target, _staged, policy) {
      events.push(`retire:${policy}`);
      return { kind: host };
    },
    async observeWriterRelease() {
      events.push('writer_released');
    },
    async activateTarget(_rootId, staged) {
      events.push(`activate:${staged.path}`);
    },
    async verifyTargetReady(_rootId, target) {
      events.push(`ready:${target.version}`);
    },
  };
}

test('establishes the first owner only after exact target Ready', async (t) => {
  const options = await authority(t);
  const events: string[] = [];
  const result = await claimLocalHostProcessDeployment(
    {
      rootId: ROOT_ID,
      transactionId: 'initial-cli-claim',
      owner: CLI,
      target: TARGET_DEPLOYMENT,
      activeWorkPolicy: 'refuse_active_work',
    },
    claimAdapter(events),
    options,
  );

  assert.equal(result.kind, 'completed');
  assert.deepEqual(events, [
    'stage:2.0.0:initial-cli-claim',
    'retire:refuse_active_work',
    'writer_released',
    'activate:/verified/maka',
    'ready:2.0.0',
  ]);
  assert.deepEqual(result.kind === 'completed' ? result.record.state : undefined, {
    kind: 'owned',
    owner: CLI,
    selected: TARGET_DEPLOYMENT,
  });
});

test('does not invent initial authority when legacy active work refuses cutover', async (t) => {
  const options = await authority(t);
  const events: string[] = [];
  const result = await claimLocalHostProcessDeployment(
    {
      rootId: ROOT_ID,
      transactionId: 'blocked-initial-claim',
      owner: CLI,
      target: TARGET_DEPLOYMENT,
      activeWorkPolicy: 'refuse_active_work',
    },
    claimAdapter(events, 'active_work'),
    options,
  );

  assert.equal(result.kind, 'active_work');
  assert.deepEqual(events, ['stage:2.0.0:blocked-initial-claim', 'retire:refuse_active_work']);
  assert.equal(await readLocalHostDeploymentRecord(ROOT_ID, options), undefined);
});

test('rejects a raced initial claim before touching the observed Host', async (t) => {
  const options = await authority(t);
  await claimed(options);
  const events: string[] = [];
  const result = await claimLocalHostProcessDeployment(
    {
      rootId: ROOT_ID,
      transactionId: 'raced-initial-claim',
      owner: CLI,
      target: TARGET_DEPLOYMENT,
      activeWorkPolicy: 'refuse_active_work',
    },
    claimAdapter(events),
    options,
  );

  assert.equal(result.kind, 'rejected');
  assert.equal(result.kind === 'rejected' ? result.reason : undefined, 'owner_exists');
  assert.deepEqual(events, ['stage:2.0.0:raced-initial-claim']);
});
