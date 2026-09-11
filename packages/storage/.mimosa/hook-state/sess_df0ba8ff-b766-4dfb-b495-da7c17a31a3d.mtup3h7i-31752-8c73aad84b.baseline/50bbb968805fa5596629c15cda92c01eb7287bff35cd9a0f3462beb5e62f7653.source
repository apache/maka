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
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import {
  computeManagedDependencyEnvironmentIdentity,
  createManagedDependencyEnvironmentAuthority,
  createManagedDependencyEnvironmentProducerCapability,
  type ManagedDependencyEnvironmentFailpoint,
} from '../managed-dependency-environment.js';

const execFileAsync = promisify(execFile);
const producerCapability = createManagedDependencyEnvironmentProducerCapability(
  `sha256:${'a'.repeat(64)}`,
);
const childEntrypoint = fileURLToPath(
  new URL('./fixtures/managed-dependency-environment-crash-child.js', import.meta.url),
);
const ownerChildEntrypoint = fileURLToPath(
  new URL('./fixtures/managed-dependency-environment-owner-child.js', import.meta.url),
);

test('rejects a second authority for the same storage root in another process', async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'maka-dependency-owner-process-'));
  const child = spawn(process.execPath, [ownerChildEntrypoint], {
    env: { ...process.env, MAKA_DEPENDENCY_OWNER_ROOT: storageRoot },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    if (child.exitCode === null) await onceChildExit(child);
    await rm(storageRoot, { recursive: true, force: true });
  });
  await waitForChildReady(child);

  const second = await createManagedDependencyEnvironmentAuthority({
    storageRoot,
    producer: {
      capability: producerCapability,
      packageManagerName: 'npm',
      packageManagerVersion: '11.12.1',
      nodeRuntime: {
        version: '24.7.0',
        abi: '137',
        platform: process.platform,
        arch: process.arch,
      },
      async provision() {},
    },
  }).then(
    (authority) => ({ authority }),
    (error: unknown) => ({ error }),
  );
  if ('authority' in second) {
    await second.authority.close();
    assert.fail('a second process acquired the same dependency authority');
  }
  assert.match(String(second.error), /already has an active owner/u);
});

for (const failpoint of [
  'during_environment_provision',
  'after_environment_tree_durable',
  'after_environment_receipt_durable',
  'after_environment_publish',
] as const satisfies readonly (
  | ManagedDependencyEnvironmentFailpoint
  | 'during_environment_provision'
)[]) {
  test(`converges after process exit at ${failpoint}`, async (t) => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'maka-dependency-crash-'));
    t.after(() => rm(storageRoot, { recursive: true, force: true }));
    await assert.rejects(
      execFileAsync(process.execPath, [childEntrypoint], {
        env: {
          ...process.env,
          MAKA_DEPENDENCY_CRASH_ROOT: storageRoot,
          MAKA_DEPENDENCY_CRASH_POINT: failpoint,
        },
        windowsHide: true,
      }),
      (error: unknown) => error instanceof Error && 'code' in error && Number(error.code) === 73,
    );

    let provisionCalls = 0;
    const authority = await createManagedDependencyEnvironmentAuthority({
      storageRoot,
      producer: {
        capability: producerCapability,
        packageManagerName: 'npm',
        packageManagerVersion: '11.12.1',
        nodeRuntime: {
          version: '24.7.0',
          abi: '137',
          platform: process.platform,
          arch: process.arch,
        },
        async provision(input) {
          provisionCalls += 1;
          await mkdir(join(input.outputRoot, 'fixture-package'), {
            recursive: true,
          });
          await writeFile(join(input.outputRoot, 'fixture-package', 'index.js'), 'safe\n');
        },
      },
    });
    const source = dependencySource();
    const lease = await authority.acquire(
      computeManagedDependencyEnvironmentIdentity(source),
      source,
    );
    assert.equal(
      await readFile(join(lease.dependencyRoot, 'fixture-package', 'index.js'), 'utf8'),
      'safe\n',
    );
    assert.equal(provisionCalls, failpoint === 'after_environment_receipt_durable' ? 0 : 1);
    assert.deepEqual(
      await readdir(join(storageRoot, 'managed-workspaces', 'dependency-environments', '.staging')),
      [],
    );
    await lease.release();
    await authority.close();
  });
}

function dependencySource() {
  return {
    manifestPath: 'package.json',
    manifestBytes: Buffer.from('{"packageManager":"npm@11.12.1"}\n'),
    lockfilePath: 'package-lock.json',
    lockfileBytes: Buffer.from('{"lockfileVersion":3}\n'),
    packageManagerName: 'npm' as const,
    packageManagerVersion: '11.12.1',
    nodeVersion: '24.7.0',
    nodeAbi: '137',
    platform: process.platform,
    arch: process.arch,
    producerRuntimeIdentitySha256: producerCapability.runtimeIdentitySha256,
    producerPolicyIdentitySha256: producerCapability.policyIdentitySha256,
    policyVersion: 'managed_dependency_environment_v1' as const,
  };
}

async function waitForChildReady(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => finish(new Error('owner child did not become ready')), 15_000);
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      child.stdout?.off('data', onData);
      child.stderr?.off('data', onErrorData);
      child.off('error', onError);
      child.off('exit', onExit);
      if (error) reject(error);
      else resolve();
    };
    const onData = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (output.includes('READY\n')) finish();
    };
    const onErrorData = (chunk: Buffer) => finish(new Error(chunk.toString('utf8')));
    const onError = (error: Error) => finish(error);
    const onExit = (code: number | null) => finish(new Error(`owner child exited early: ${code}`));
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onErrorData);
    child.on('error', onError);
    child.on('exit', onExit);
  });
}

async function onceChildExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const onExit = () => resolve();
    child.once('exit', onExit);
    if (child.exitCode !== null) {
      child.off('exit', onExit);
      resolve();
    }
  });
}
