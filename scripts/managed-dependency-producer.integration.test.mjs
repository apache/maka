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
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { access, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { runManagedDependencyProducer } from '../packages/runtime-host/dist/server/managed-dependency-producer.js';
import { runProducerProcess } from '../packages/runtime-host/dist/server/managed-dependency-process.js';
import {
  computeManagedDependencyEnvironmentIdentity,
  createManagedDependencyEnvironmentAuthority,
  createManagedDependencyEnvironmentProducerCapability,
} from '../packages/storage/dist/managed-dependency-environment.js';

const execute = promisify(execFile);
const supervisorPath = process.env.MAKA_PRODUCER_SUPERVISOR;
const npmCliPath = process.env.MAKA_TEST_NPM_CLI;
// These are opt-in real-platform tests, not mock replacements for unavailable
// confinement. CI/invocation must provide the built launcher or bubblewrap.
const native = { skip: !supervisorPath, timeout: 90_000 };
const npmNative = { skip: !supervisorPath || !npmCliPath, timeout: 120_000 };

async function root(t) {
  const path = await mkdtemp(join(tmpdir(), 'maka-producer-integration-'));
  t.after(() => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return path;
}

function processInput(projectRoot, signal, onOutput = () => {}) {
  return {
    executable: process.execPath,
    projectRoot,
    readRoots: [projectRoot],
    environment: {
      ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}),
    },
    supervisorPath,
    signal,
    timeoutMs: 30_000,
    onOutput,
  };
}

test('native confinement reports actual exit and child diagnostics', native, async (t) => {
  const project = await root(t);
  const chunks = [];
  const result = await runProducerProcess({
    ...processInput(project, new AbortController().signal, (chunk) => chunks.push(chunk)),
    arguments: ['-e', 'console.log("producer-output");process.exit(7)'],
  });
  assert.deepEqual(
    result,
    { settled: true, failed: true, exitCode: 7 },
    Buffer.concat(chunks).toString(),
  );
  assert.match(Buffer.concat(chunks).toString(), /producer-output/);
});

test('root exit cannot leave a detached descendant writing after settlement', native, async (t) => {
  const project = await root(t);
  const late = join(project, 'late');
  const chunks = [];
  const descendant = `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(late)},'late'),1200);setTimeout(()=>{},30000)`;
  const program = `try{const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{detached:true,stdio:'ignore'});c.once('error',()=>{console.log('spawn-denied');process.exit(9)});c.once('spawn',()=>{console.log('spawned');c.unref();process.exit(0)})}catch(e){if(e.code!=='EPERM')throw e;console.log('spawn-denied');process.exit(9)}`;
  const result = await runProducerProcess({
    ...processInput(project, new AbortController().signal, (chunk) => chunks.push(chunk)),
    arguments: ['-e', program],
  });
  assert.equal(result.settled, true, Buffer.concat(chunks).toString());
  const output = Buffer.concat(chunks).toString();
  if (output.includes('spawn-denied')) {
    assert.equal(process.platform, 'win32');
    assert.equal(result.failed, true);
    t.diagnostic('AppContainer denied child creation; no descendant was admitted');
  } else {
    assert.match(output, /spawned/);
  }
  // A long-running descendant must have been killed, even after setsid and
  // closing inherited stdio. Windows may allow it during the drain grace; take
  // the settled snapshot and prove no more writes occur afterwards.
  const before = await readFile(late, 'utf8').catch(() => null);
  await delay(1500);
  assert.equal(await readFile(late, 'utf8').catch(() => null), before);
  if (process.platform === 'linux') assert.equal(before, null);
});

test('cancellation waits for real process teardown', native, async (t) => {
  const project = await root(t);
  const marker = join(project, 'ticks');
  const controller = new AbortController();
  let cancelled = false;
  const result = await runProducerProcess({
    ...processInput(project, controller.signal, (chunk) => {
      if (chunk.toString().includes('ready') && !cancelled) {
        cancelled = true;
        controller.abort();
      }
    }),
    arguments: [
      '-e',
      `console.log('ready');setInterval(()=>require('node:fs').appendFileSync(${JSON.stringify(marker)},'x'),20)`,
    ],
  });
  assert.equal(cancelled, true);
  assert.equal(result.settled, true);
  assert.equal(result.failed, true);
  const before = await readFile(marker, 'utf8').catch(() => null);
  await delay(200);
  assert.equal(await readFile(marker, 'utf8').catch(() => null), before);
});

test('missing supervisor is a settled pre-spawn failure', async (t) => {
  const project = await root(t);
  const result = await runProducerProcess({
    ...processInput(project, new AbortController().signal),
    supervisorPath: join(project, 'missing-supervisor'),
    arguments: ['-e', 'process.exit(0)'],
  });
  assert.deepEqual(result, { settled: true, failed: true, exitCode: null });
});

test('native execution timeout drains the process', native, async (t) => {
  const project = await root(t);
  const result = await runProducerProcess({
    ...processInput(project, new AbortController().signal),
    timeoutMs: 1000,
    arguments: ['-e', 'setInterval(()=>{},1000)'],
  });
  assert.equal(result.settled, true);
  assert.equal(result.failed, true);
});

test('Windows refuses a native CREATE_BREAKAWAY_FROM_JOB attempt', {
  ...native,
  skip: !supervisorPath || process.platform !== 'win32',
}, async (t) => {
  const project = await root(t);
  const chunks = [];
  const result = await runProducerProcess({
    ...processInput(project, new AbortController().signal, (chunk) => chunks.push(chunk)),
    executable: supervisorPath,
    arguments: ['--producer-breakaway-probe'],
  });
  assert.deepEqual(
    result,
    { settled: true, failed: false, exitCode: 0 },
    Buffer.concat(chunks).toString(),
  );
  assert.match(Buffer.concat(chunks).toString(), /"breakawayDenied":true/);
});

test('owner death closes the control channel and stops the producer', native, async (t) => {
  const project = await root(t);
  const marker = join(project, 'owner-loss-ticks');
  const moduleUrl = new URL(
    '../packages/runtime-host/dist/server/managed-dependency-process.js',
    import.meta.url,
  ).href;
  const input = processInput(project, undefined);
  const childCode = `console.log('ready');setInterval(()=>require('node:fs').appendFileSync(${JSON.stringify(marker)},'x'),20)`;
  const ownerCode = `const {runProducerProcess}=await import(${JSON.stringify(moduleUrl)});await runProducerProcess({...${JSON.stringify(input)},arguments:['-e',${JSON.stringify(childCode)}],signal:new AbortController().signal,onOutput:c=>process.stdout.write(c)})`;
  const owner = spawn(process.execPath, ['--input-type=module', '-e', ownerCode], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  t.after(() => {
    owner.kill();
  });
  const exited = once(owner, 'exit');
  const ready = new Promise((resolveReady, reject) => {
    let output = '';
    owner.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes('ready')) resolveReady();
    });
    owner.once('exit', () =>
      reject(new Error(`Owner exited before producer readiness: ${output}`)),
    );
  });
  await ready;
  owner.kill();
  await exited;
  await delay(1200);
  const before = await readFile(marker, 'utf8').catch(() => null);
  await delay(500);
  assert.equal(await readFile(marker, 'utf8').catch(() => null), before);
});

async function npmFixture(t) {
  const fixtureRoot = await root(t);
  const source = join(fixtureRoot, 'package');
  const seed = join(fixtureRoot, 'seed');
  await mkdir(source);
  await mkdir(seed);
  const name = 'maka-producer-offline-fixture';
  await writeFile(
    join(source, 'package.json'),
    JSON.stringify({
      name,
      version: '1.0.0',
      bin: { 'maka-fixture': 'cli.js' },
      scripts: { postinstall: 'node -e "process.exit(99)"' },
    }),
  );
  await writeFile(join(source, 'cli.js'), '#!/usr/bin/env node\nconsole.log("fixture")\n');
  // The fixture itself is local and cannot contact a registry. Package bytes are
  // inserted into npm's content-addressed cache, then consumed by integrity.
  await execute(
    process.execPath,
    [npmCliPath, 'pack', '--offline', '--ignore-scripts', '--pack-destination', fixtureRoot],
    { cwd: source, timeout: 30_000 },
  );
  const tarball = join(fixtureRoot, `${name}-1.0.0.tgz`);
  const integrity = `sha512-${createHash('sha512')
    .update(await readFile(tarball))
    .digest('base64')}`;
  await execute(
    process.execPath,
    [npmCliPath, 'cache', 'add', tarball, '--cache', seed, '--offline', '--ignore-scripts'],
    { timeout: 30_000 },
  );
  const manifest = { name: 'consumer', version: '1.0.0', dependencies: { [name]: '1.0.0' } };
  return {
    name,
    nodeExecutablePath: process.execPath,
    npmCliPath,
    supervisorPath,
    cacheSeedRoot: seed,
    manifestBytes: Buffer.from(JSON.stringify(manifest)),
    lockfileBytes: Buffer.from(
      JSON.stringify({
        name: 'consumer',
        version: '1.0.0',
        lockfileVersion: 3,
        packages: {
          '': manifest,
          [`node_modules/${name}`]: {
            version: '1.0.0',
            resolved: `https://registry.npmjs.org/${name}/-/${name}-1.0.0.tgz`,
            integrity,
            bin: { 'maka-fixture': 'cli.js' },
            hasInstallScript: true,
          },
        },
      }),
    ),
  };
}

test(
  'real offline npm installs a cached bin package without lifecycle scripts',
  npmNative,
  async (t) => {
    const fixture = await npmFixture(t);
    const projectRoot = await root(t);
    const result = await runManagedDependencyProducer({ ...fixture, projectRoot });
    assert.equal(result.kind, 'completed', JSON.stringify(result));
    await access(join(projectRoot, 'node_modules', fixture.name, 'cli.js'));
    if (process.platform === 'linux')
      assert.equal(
        (await lstat(join(projectRoot, 'node_modules', '.bin', 'maka-fixture'))).isSymbolicLink(),
        true,
      );
  },
);

test(
  'offline cache miss and inconsistent lockfile fail without registry access',
  npmNative,
  async (t) => {
    const fixture = await npmFixture(t);
    for (const variant of ['cache-miss', 'lock-mismatch']) {
      const projectRoot = await root(t);
      const result = await runManagedDependencyProducer({
        ...fixture,
        projectRoot,
        ...(variant === 'cache-miss'
          ? { cacheSeedRoot: undefined }
          : {
              manifestBytes: Buffer.from('{"name":"consumer","dependencies":{"missing":"2.0.0"}}'),
            }),
      });
      assert.equal(result.kind, 'failed', JSON.stringify(result));
      assert.equal(result.reason, 'process', JSON.stringify(result));
    }
  },
);

test(
  'test-only adapter publishes after settlement and cleans settled failures',
  npmNative,
  async (t) => {
    const fixture = await npmFixture(t);
    const storageRoot = await root(t);
    const runtimeIdentity = `sha256:${'a'.repeat(64)}`;
    const capability = createManagedDependencyEnvironmentProducerCapability(runtimeIdentity);
    const { stdout } = await execute(process.execPath, [npmCliPath, '--version']);
    const npmVersion = stdout.trim();
    let fail = false;
    let calls = 0;
    let staging;
    const producer = {
      capability,
      packageManagerName: 'npm',
      packageManagerVersion: npmVersion,
      nodeRuntime: {
        version: process.versions.node,
        abi: process.versions.modules,
        platform: process.platform,
        arch: process.arch,
      },
      async provision(input) {
        calls++;
        staging = dirname(input.outputRoot);
        const result = await runManagedDependencyProducer({
          ...fixture,
          projectRoot: staging,
          manifestBytes: input.manifestBytes,
          lockfileBytes: input.lockfileBytes,
          ...(fail ? { cacheSeedRoot: undefined } : {}),
        });
        // Deliberately not a production adapter. Unsettled results have no mapping
        // to Storage's rejection/cleanup contract and must never reach this path.
        assert.notEqual(result.kind, 'unsettled', JSON.stringify(result));
        if (result.kind !== 'completed')
          throw new Error(`settled install failure: ${JSON.stringify(result)}`);
      },
    };
    const authority = await createManagedDependencyEnvironmentAuthority({ storageRoot, producer });
    try {
      const source = {
        manifestPath: 'package.json',
        manifestBytes: fixture.manifestBytes,
        lockfilePath: 'package-lock.json',
        lockfileBytes: fixture.lockfileBytes,
        packageManagerName: 'npm',
        packageManagerVersion: npmVersion,
        nodeVersion: process.versions.node,
        nodeAbi: process.versions.modules,
        platform: process.platform,
        arch: process.arch,
        producerRuntimeIdentitySha256: runtimeIdentity,
        producerPolicyIdentitySha256: capability.policyIdentitySha256,
        policyVersion: 'managed_dependency_environment_v1',
      };
      const identity = computeManagedDependencyEnvironmentIdentity(source);
      const lease = await authority.acquire(identity, source);
      await access(join(lease.dependencyRoot, fixture.name, 'cli.js'));
      await lease.release();
      const again = await authority.acquire(identity, source);
      assert.equal(calls, 1, 'durable receipt should allow reuse without running npm');
      await again.release();
      fail = true;
      const failedSource = {
        ...source,
        manifestBytes: Buffer.from(fixture.manifestBytes.toString() + '\n'),
      };
      await assert.rejects(
        authority.acquire(computeManagedDependencyEnvironmentIdentity(failedSource), failedSource),
        /settled install failure/,
      );
      await assert.rejects(access(staging), { code: 'ENOENT' });
    } finally {
      await authority.close();
    }
  },
);
