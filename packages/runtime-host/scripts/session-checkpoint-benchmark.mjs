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

// Opt-in measurement, not a CI latency assertion. No production instrumentation.
import assert from 'node:assert/strict';
import { fork, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { cpus, release, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { FakeBackend } from '@maka/runtime/test-only/fake-backend';
import { SessionManager } from '@maka/runtime/session-manager';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import { openInteractiveArtifactStoreForWrite } from '@maka/storage/artifact-stores';
import { openInteractiveRuntimePolicyStoresForWrite } from '@maka/storage/runtime-policy-stores';
import { openFileSessionRepository } from '@maka/storage/file-session-repository';
import { NodeSessionBundleFileService } from '@maka/storage/session-bundle-file-service';
import { localExecutionPersistenceProvider } from '../../storage/dist/local-execution-persistence.js';
import { SnapshotOperationGate } from '../../storage/dist/snapshot-operation-gate.js';
import { createExecutionRuntimeHostComposition } from '../dist/server/execution-composition.js';
import { SessionAdmissionGate } from '../dist/server/session-admission-gate.js';

const MiB = 1024 * 1024;
const profiles = [
  { name: 'small', turns: 8, files: 16, fileBytes: 4096, artifactBytes: 64 * 1024 },
  { name: 'many-files', turns: 64, files: 1000, fileBytes: 4096, artifactBytes: 2 * MiB },
  { name: 'large-payload', turns: 128, files: 8, fileBytes: 8 * MiB, artifactBytes: 16 * MiB },
];
const limits = {
  maxCompressedBytes: 256 * MiB,
  maxDecompressedTarBytes: 512 * MiB,
  maxPayloadBytes: 256 * MiB,
  maxFileBytes: 128 * MiB,
  maxEntryCount: 10000,
  maxManifestBytes: 4 * MiB,
  maxStateIdentityBytes: 64 * 1024,
  maxPathBytes: 255,
  maxPathDepth: 32,
};
const operationContext = {
  hostEpoch: 'checkpoint-benchmark',
  connectionId: 'benchmark-client',
  principal: 'local_os_user',
  acquireResidency: () => ({ release() {} }),
};

// Same Host admission/ledger paths without FakeBackend's UI streaming delays.
class BenchmarkBackend extends FakeBackend {
  async *send(input) {
    const common = { turnId: input.turnId, ts: Date.now() };
    yield {
      ...common,
      type: 'text_complete',
      id: randomUUID(),
      messageId: randomUUID(),
      text: input.text,
    };
    yield { ...common, type: 'complete', id: randomUUID(), stopReason: 'end_turn' };
  }
}

if (process.argv[2] === '--worker') {
  const profile = profiles.find((item) => item.name === process.argv[3]);
  assert.ok(profile, 'Unknown benchmark profile');
  const result = await runFixture(profile, process.argv[4] === 'resource');
  process.send(result);
  process.disconnect();
} else {
  const smoke = process.argv.includes('--smoke');
  assert.ok(
    process.argv.slice(2).every((arg) => arg === '--smoke'),
    'Unknown argument',
  );
  const report = {
    schemaVersion: 1,
    measuredAt: new Date().toISOString(),
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    harnessSha256: createHash('sha256')
      .update(readFileSync(new URL(import.meta.url)))
      .digest('hex'),
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      kernel: release(),
      cpu: cpus()[0].model,
      memoryBytes: totalmem(),
    },
    smoke,
    samplesPerProfile: smoke ? 1 : 5,
    profiles: [],
  };
  for (const profile of smoke ? profiles.slice(0, 1) : profiles) {
    // Fresh processes prevent previous profiles' RSS high-water from leaking.
    // One whole fixture warmup is discarded; OS caches are not flushed.
    await runChild(profile.name, 'timing');
    const samples = [];
    for (let index = 0; index < report.samplesPerProfile; index++) {
      process.stderr.write('Measuring ' + profile.name + ' ' + (index + 1) + '\n');
      samples.push(await runChild(profile.name, 'timing'));
    }
    // Directory scans perturb I/O; keep them out of the latency samples.
    const resources = await runChild(profile.name, 'resource');
    report.profiles.push({ ...profile, samples, resources });
  }
  console.log(JSON.stringify(report, null, 2));
}

async function runChild(profile, mode) {
  return new Promise((resolve, reject) => {
    const child = fork(new URL(import.meta.url), ['--worker', profile, mode], {
      execArgv: ['--expose-gc'],
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      timeout: 180000,
    });
    let result;
    child.on('message', (message) => {
      result = message;
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code !== 0 || !result) reject(new Error('Benchmark failed: ' + code + '/' + signal));
      else resolve(result);
    });
  });
}

async function runFixture(profile, resourceMode) {
  // No configurable path: deletion is restricted to this generated fixture.
  const root = await mkdtemp(join(tmpdir(), 'maka-checkpoint-benchmark-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const owner = await tryAcquireInteractiveRootOwner(
    await resolveStorageRoot({ path: join(root, 'state'), kind: 'interactive' }),
  );
  assert.ok(owner);
  const checkpointRoot = join(owner.controlDirectory, 'session-checkpoints-v1');
  let composition;
  let manager;
  let active;
  let fenceHeld = false;
  let stopDisk;
  const restores = [];

  // Benchmark-only wrappers always call the real method, preserving errors.
  function wrap(object, name, wrapper) {
    const original = object[name];
    assert.equal(typeof original, 'function', name);
    object[name] = wrapper(original);
    restores.push(() => {
      object[name] = original;
    });
  }
  async function timed(name, operation) {
    const sample = active;
    if (!sample) return operation();
    const start = performance.now();
    try {
      return await operation();
    } finally {
      sample[name] = (sample[name] ?? 0) + performance.now() - start;
    }
  }
  async function diskSample() {
    if (!resourceMode || !active) return;
    const sample = active;
    const usage = await directoryUsage(checkpointRoot);
    sample.peakCheckpointLogicalBytes = Math.max(sample.peakCheckpointLogicalBytes, usage.bytes);
    sample.peakCheckpointAllocatedBytes = Math.max(
      sample.peakCheckpointAllocatedBytes,
      usage.allocatedBytes,
    );
  }

  try {
    const policyStores = await openInteractiveRuntimePolicyStoresForWrite(owner.lease);
    const policy = await policyStores.runtimePolicy.getSnapshot();
    const changed = await policyStores.runtimePolicy.mutate({
      expectedRevision: policy.revision,
      operation: { kind: 'set_privacy', value: { incognitoActive: true } },
    });
    assert.equal(changed.kind, 'committed');
    wrap(
      SessionManager.prototype,
      'recoverInterruptedSessionsStrict',
      (original) =>
        async function (...args) {
          manager = this;
          return original.apply(this, args);
        },
    );
    wrap(
      SessionAdmissionGate.prototype,
      'run',
      (original) =>
        function (id, operation) {
          return original.call(this, id, (lease) =>
            timed('admissionHeldMs', () => operation(lease)),
          );
        },
    );
    wrap(
      SnapshotOperationGate.prototype,
      'exclusive',
      (original) =>
        function (operation) {
          // Includes drain time, when the barrier already blocks new writes.
          return timed('providerFenceMs', () =>
            original.call(this, async () => {
              fenceHeld = true;
              try {
                return await operation();
              } finally {
                fenceHeld = false;
              }
            }),
          );
        },
    );
    wrap(
      NodeSessionBundleFileService.prototype,
      'pack',
      (original) =>
        async function (...args) {
          assert.equal(fenceHeld, false, 'Packing must run after the live-state fence is released');
          const result = await timed('packMs', () => original.apply(this, args));
          // Capture the private-copy + archive coexistence point before cleanup.
          await diskSample();
          return result;
        },
    );
    const repository = await openFileSessionRepository({
      storageRoot: join(checkpointRoot, 'repository'),
    });
    for (const name of ['createSession', 'commit', 'checkoutCurrent']) {
      wrap(
        Object.getPrototypeOf(repository),
        name,
        (original) =>
          function (...args) {
            return timed(name + 'Ms', () => original.apply(this, args));
          },
      );
    }
    wrap(
      Object.getPrototypeOf(repository.objectStore),
      'publish',
      (original) =>
        async function (...args) {
          const result = await timed('objectPublishMs', () => original.apply(this, args));
          await diskSample();
          return result;
        },
    );
    // Observe the actual selected Local provider, not a replacement snapshot.
    const provider = {
      async open(input) {
        const persistence = await localExecutionPersistenceProvider.open(input);
        const original = persistence.createSnapshotStatePreparer.bind(persistence);
        return {
          ...persistence,
          createSnapshotStatePreparer(lease) {
            const state = original(lease);
            return {
              prepareState: (request) => timed('stateCopyMs', () => state.prepareState(request)),
            };
          },
        };
      },
    };
    composition = await createExecutionRuntimeHostComposition(
      {
        owner,
        hostEpoch: operationContext.hostEpoch,
        acquireResidency: () => ({ release() {} }),
        retainUntilProcessExit: () => {},
        requestDrain: () => {},
      },
      { bootstrapRuntimePolicy: false },
      {
        primaryBackendFactory: (context) => new BenchmarkBackend(context),
        executionPersistenceProvider: provider,
        checkpointPublication: {
          limits,
          workspace: {
            // Private fixture, sole writer; NOT an arbitrary-directory adapter.
            runExclusive: (_input, operation) => timed('workspaceFenceMs', operation),
          },
          privateStagingRootAuthority:
            process.platform === 'win32'
              ? { verifyPrivateStagingRoot: async ({ canonicalPath }) => ({ canonicalPath }) }
              : undefined,
        },
      },
    );
    await composition.recover();
    assert.ok(manager);
    const session = await manager.createSession({
      cwd: workspace,
      llmConnectionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'bypass',
      name: profile.name,
    });
    for (let index = 0; index < profile.turns; index++) {
      const turnId = 'turn-' + index;
      const started = await composition.handlers['turn.start'](
        {
          sessionId: session.id,
          turnId,
          content: { text: 'benchmark ' + index + ' ' + 'x'.repeat(1024) },
        },
        operationContext,
      );
      assert.equal(started.ok, true);
      const deadline = performance.now() + 10000;
      while (true) {
        const messages = await manager.getMessages(session.id);
        const state = messages.findLast(
          (message) => message.type === 'turn_state' && message.turnId === turnId,
        );
        if (state?.status === 'completed') break;
        assert.ok(state?.status !== 'failed' && state?.status !== 'aborted');
        assert.ok(performance.now() < deadline, 'Turn did not settle');
        await sleep(5);
      }
    }
    const stores = await openInteractiveExecutionStoresForWrite(owner.lease, provider);
    const artifacts = await openInteractiveArtifactStoreForWrite(owner.lease);
    await artifacts.create({
      sessionId: session.id,
      turnId: 'turn-0',
      kind: 'file',
      source: 'user_upload',
      name: 'payload.bin',
      content: payload(profile.artifactBytes, 999),
    });
    for (let index = 0; index < profile.files; index++) {
      await writeFile(join(workspace, 'file-' + index + '.bin'), payload(profile.fileBytes, index));
    }
    const sourceUsage = await directoryUsage(root);
    const messages = await manager.getMessages(session.id);
    const runs = await manager.listInvocations(session.id);
    const source = {
      logicalBytes: sourceUsage.bytes,
      allocatedBytes: sourceUsage.allocatedBytes,
      messages: messages.length,
      runs: runs.length,
    };
    assert.equal(runs.length, profile.turns);
    const results = {};
    let previous;
    for (const operation of ['create', 'commit', 'replay']) {
      if (operation === 'commit') {
        // Force a new snapshot, not just immutable-object deduplication.
        await writeFile(join(workspace, 'after-first-checkpoint.txt'), 'new live state');
      }
      global.gc?.();
      const before = await directoryUsage(checkpointRoot);
      active = {
        peakCheckpointLogicalBytes: before.bytes,
        peakCheckpointAllocatedBytes: before.allocatedBytes,
      };
      const sample = active;
      sample.rssBeforeBytes = process.memoryUsage.rss();
      sample.sampledPeakRssBytes = sample.rssBeforeBytes;
      sample.processHighWaterBeforeBytes = process.resourceUsage().maxRSS * 1024;
      const rssTimer = setInterval(() => {
        sample.sampledPeakRssBytes = Math.max(
          sample.sampledPeakRssBytes,
          process.memoryUsage.rss(),
        );
      }, 5);
      let diskRunning = true;
      let diskError;
      stopDisk = (async () => {
        if (!resourceMode) return;
        while (diskRunning) {
          await diskSample();
          await sleep(20);
        }
      })().catch((error) => {
        diskError = error;
      });
      const started = performance.now();
      let result;
      try {
        result = await composition.sessionCheckpoints.publish({
          sessionId: session.id,
          requestId: operation === 'create' ? 'first' : 'second',
        });
        sample.totalMs = performance.now() - started;
      } finally {
        clearInterval(rssTimer);
        diskRunning = false;
        await stopDisk;
      }
      if (diskError) throw diskError;
      sample.processHighWaterAfterBytes = process.resourceUsage().maxRSS * 1024;
      sample.sampledPeakRssBytes = Math.max(sample.sampledPeakRssBytes, process.memoryUsage.rss());
      await diskSample();
      const after = await directoryUsage(checkpointRoot);
      sample.retainedCheckpointLogicalBytes = after.bytes;
      sample.retainedCheckpointAllocatedBytes = after.allocatedBytes;
      sample.checkpointBytesBefore = before.bytes;
      sample.archiveBytes = result.committed.checkpoint.value.compatibilityBundle.bytes;
      assert.equal(result.committed.ref.revision, operation === 'create' ? 'r1' : 'r2');
      assert.equal(result.stagingCleanup, 'released');
      assert.equal(result.bundleCleanup, 'released');
      if (operation === 'replay') {
        assert.deepEqual(result, previous);
        assert.equal(sample.providerFenceMs, undefined);
        assert.equal(sample.packMs, undefined);
      } else {
        assert.ok(sample.providerFenceMs > 0 && sample.stateCopyMs > 0 && sample.packMs > 0);
        assert.ok(sample[operation === 'create' ? 'createSessionMs' : 'commitMs'] > 0);
      }
      previous = result;
      results[operation] = sample;
      active = undefined;
    }
    // Verify bounded cleanup, including all temporary archive copies.
    assert.deepEqual(await readdir(join(checkpointRoot, 'bundles')), []);
    assert.deepEqual(await readdir(join(checkpointRoot, 'staging')), []);
    assert.equal((await stores.sessionStore.readHeader(session.id)).cwd, workspace);
    return { resourceMode, source, results };
  } finally {
    await stopDisk;
    for (const restore of restores.reverse()) restore();
    composition?.beginDrain();
    await composition?.close();
    await owner.close();
    await rm(owner.controlDirectory, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
}

function payload(bytes, seed) {
  // Deterministic high-entropy blocks; avoid misleading all-zero compression.
  const buffer = Buffer.allocUnsafe(bytes);
  for (let offset = 0; offset < bytes; offset += 32) {
    createHash('sha256')
      .update(seed + ':' + offset)
      .digest()
      .copy(buffer, offset);
  }
  return buffer;
}

async function directoryUsage(root) {
  let bytes = 0;
  let allocatedBytes = 0;
  const seen = new Set();
  async function visit(path) {
    let info;
    try {
      info = await lstat(path);
    } catch (error) {
      if (error.code === 'ENOENT') return; // Concurrent owned temporary cleanup.
      throw error;
    }
    if (info.isDirectory()) {
      let children;
      try {
        children = await readdir(path);
      } catch (error) {
        if (error.code === 'ENOENT') return;
        throw error;
      }
      for (const child of children) await visit(join(path, child));
    } else {
      assert.ok(info.isFile(), 'Benchmark never follows symbolic links');
      const identity = info.dev + ':' + info.ino;
      if (seen.has(identity)) return; // Publication uses temporary hard links.
      seen.add(identity);
      bytes += info.size;
      allocatedBytes += info.blocks * 512;
    }
  }
  await visit(root);
  return { bytes, allocatedBytes };
}
