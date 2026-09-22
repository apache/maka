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
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  assertExpectedEpochRelation,
  durableStateLocations,
  parseQualificationArgs,
  qualificationSandboxArgs,
  qualificationSandboxInvocation,
  runInstalledRuntimeHost,
  sha256File,
} from './qualify-released-cli-state-root.mjs';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const FIXTURE_LIFECYCLE = {
  startupTimeoutMs: 1_000,
  livenessMs: 50,
  shutdownKillAfterMs: 1_000,
};
const workspaceCliPath = fileURLToPath(new URL('../packages/cli/dist/cli.js', import.meta.url));

test('parses two exact artifacts and an epoch relation', () => {
  const source = resolve(tmpdir(), 'source.tgz');
  const target = resolve(tmpdir(), 'target.tgz');
  assert.deepEqual(
    parseQualificationArgs([
      '--source',
      source,
      '--source-sha256',
      SHA_A,
      '--target',
      target,
      '--target-sha256',
      SHA_B,
      '--expect-epoch-relation',
      'same',
    ]),
    {
      source,
      sourceSha256: SHA_A,
      target,
      targetSha256: SHA_B,
      expectedEpochRelation: 'same',
    },
  );
});

test('rejects ambiguous artifact identity and unknown arguments', () => {
  const target = resolve(tmpdir(), 'target.tgz');
  assert.throws(
    () =>
      parseQualificationArgs([
        '--source',
        'source.tgz',
        '--source-sha256',
        SHA_A,
        '--target',
        target,
        '--target-sha256',
        SHA_B,
        '--expect-epoch-relation',
        'any',
      ]),
    /source must be an absolute path/u,
  );
  assert.throws(
    () =>
      parseQualificationArgs([
        '--source',
        resolve(tmpdir(), 'source.tgz'),
        '--source-sha256',
        SHA_A,
        '--target',
        target,
        '--target-sha256',
        SHA_B,
        '--extra',
        'value',
      ]),
    /Unknown qualification argument/u,
  );
});

test('uses privilege only for mount setup and drops every privilege before Node', () => {
  const args = ['--die-with-parent', '--', '/usr/bin/node'];
  assert.deepEqual(
    qualificationSandboxInvocation({ args, account: { uid: 1001, gid: 1002 }, useSudo: false }),
    { command: 'bwrap', args },
  );
  assert.deepEqual(
    qualificationSandboxInvocation({ args, account: { uid: 1001, gid: 1002 }, useSudo: true }),
    {
      command: 'sudo',
      args: [
        '--non-interactive',
        '--',
        '/usr/bin/bwrap',
        '--die-with-parent',
        '--cap-add',
        'CAP_SETUID',
        '--cap-add',
        'CAP_SETGID',
        '--cap-add',
        'CAP_SETPCAP',
        '--',
        '/usr/bin/setpriv',
        '--regid',
        '1002',
        '--reuid',
        '1001',
        '--clear-groups',
        '--inh-caps=-all',
        '--ambient-caps=-all',
        '--bounding-set=-all',
        '--no-new-privs',
        '/usr/bin/node',
      ],
    },
  );
  assert.throws(
    () =>
      qualificationSandboxInvocation({ args: ['--die-with-parent'], account: {}, useSudo: true }),
    /sandbox command is missing/u,
  );
});

test('creates a private Host IPC temp root before mounting a scope that may live below it', () => {
  const args = qualificationSandboxArgs({
    innerInputPath: '/qualification/input.json',
    scope: '/qualification',
    sandbox: {
      home: '/qualification/home',
      temp: '/qualification/tmp',
      passwd: '/qualification/etc/passwd',
      group: '/qualification/etc/group',
      environment: {
        XDG_CACHE_HOME: '/qualification/home/.cache',
        XDG_CONFIG_HOME: '/qualification/home/.config',
        XDG_DATA_HOME: '/qualification/home/.local/share',
      },
    },
  });
  const tmpfsIndex = args.indexOf('--tmpfs');
  assert.deepEqual(args.slice(tmpfsIndex, tmpfsIndex + 8), [
    '--tmpfs',
    '/tmp',
    '--chmod',
    '1777',
    '/tmp',
    '--bind',
    '/qualification',
    '/qualification',
  ]);
});

test('classifies and fences the expected epoch relationship', () => {
  assert.equal(assertExpectedEpochRelation(74, 76, 'different'), 'different');
  assert.equal(assertExpectedEpochRelation(76, 76, 'same'), 'same');
  assert.equal(assertExpectedEpochRelation(76, 78, 'any'), 'different');
  assert.throws(
    () => assertExpectedEpochRelation(76, 78, 'same'),
    /Expected same compatibility epochs/u,
  );
});

test('computes the exact artifact SHA-256', () => {
  const root = mkdtempSync(join(tmpdir(), 'maka-release-digest-'));
  try {
    const path = join(root, 'artifact.tgz');
    writeFileSync(path, 'released bytes');
    assert.equal(
      sha256File(path),
      '2f9e0acbd320f87ceff2b9d259c99ec87830fc87d99bf914cef87394294a6682',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('durable state covers the control namespace, not only the State Root', () => {
  // The access file the Host opens before its Kernel starts lives beside the
  // State Root, not inside it. A golden copy scoped to the State Root alone
  // restored a workspace whose control records had already moved on, so the
  // transition it proved was never the one a user performs.
  const scope = resolve(tmpdir(), 'qualification-scope');
  const locations = durableStateLocations(scope);
  assert.ok(locations.length >= 2);
  assert.ok(locations.some(({ live }) => live === join(scope, 'state-root')));
  assert.ok(
    locations.some(({ live }) => live.endsWith(join('.cache', 'maka', 'runtime-hosts'))),
    'the account-local control namespace must be captured and restored',
  );
  for (const { live, golden } of locations) {
    assert.ok(isAbsolute(live) && isAbsolute(golden));
    assert.ok(
      !golden.startsWith(`${live}${sep}`),
      'a golden copy must not nest inside its live path',
    );
  }
});

test('a workspace target replaces tarball identity instead of weakening it', () => {
  const source = resolve(tmpdir(), 'source.tgz');
  const repo = resolve(tmpdir(), 'checkout');
  assert.deepEqual(
    parseQualificationArgs([
      '--source',
      source,
      '--source-sha256',
      SHA_A,
      '--target-workspace',
      repo,
    ]),
    { source, sourceSha256: SHA_A, targetWorkspace: repo, expectedEpochRelation: 'any' },
  );
  // The source stays an exact published artifact either way: the point of the
  // run is that state written by a real release still opens.
  assert.throws(
    () => parseQualificationArgs(['--target-workspace', repo]),
    /--source must be an absolute path/u,
  );
  assert.throws(
    () =>
      parseQualificationArgs([
        '--source',
        source,
        '--source-sha256',
        SHA_A,
        '--target-workspace',
        repo,
        '--target-sha256',
        SHA_B,
      ]),
    /cannot also name a tarball target/u,
  );
});

async function runRuntimeHostFixture(source, lifecycleOptions) {
  const scope = mkdtempSync(join(tmpdir(), 'maka-runtime-host-fixture-'));
  try {
    const cliPath = join(scope, 'runtime-host.mjs');
    writeFileSync(cliPath, source);
    return await runInstalledRuntimeHost(
      {
        artifact: { role: 'fixture', cliPath },
        rootPath: join(scope, 'state-root'),
        scope,
      },
      { ...FIXTURE_LIFECYCLE, ...lifecycleOptions },
    );
  } finally {
    rmSync(scope, { recursive: true, force: true });
  }
}

// Windows terminates on kill('SIGINT') instead of delivering it, and the
// qualification these exercise runs on Linux only.
test('starts the liveness window after a delayed Runtime Host Ready', {
  skip: process.platform === 'win32',
}, async () => {
  const ready = await runRuntimeHostFixture(
    `
        setTimeout(() => {
          console.log(JSON.stringify({ event: 'runtime_host_ready', rootId: 'root', hostEpoch: 'epoch' }));
        }, 150);
        process.once('SIGINT', () => process.exit(0));
        setInterval(() => undefined, 1000);
      `,
  );
  assert.deepEqual(ready, { rootId: 'root', hostEpoch: 'epoch' });
});

test('starts the liveness window after the real Runtime Host is ready', {
  skip: process.platform === 'win32',
}, async (t) => {
  if (!existsSync(workspaceCliPath)) {
    t.skip('build the workspace CLI before running the real Runtime Host regression');
    return;
  }
  const scope = mkdtempSync(join(tmpdir(), 'maka-runtime-host-workspace-'));
  const home = join(scope, 'home');
  const temporaryDirectory = join(home, 'tmp');
  mkdirSync(temporaryDirectory, { recursive: true });
  try {
    const ready = await runInstalledRuntimeHost(
      {
        artifact: { role: 'workspace', cliPath: workspaceCliPath },
        rootPath: join(scope, 'state-root'),
        scope,
      },
      {
        ...FIXTURE_LIFECYCLE,
        environment: {
          ...process.env,
          HOME: home,
          XDG_CONFIG_HOME: join(home, '.config'),
          XDG_DATA_HOME: join(home, '.local', 'share'),
          XDG_STATE_HOME: join(home, '.local', 'state'),
          TMPDIR: temporaryDirectory,
        },
        startupTimeoutMs: 10_000,
      },
    );
    assert.ok(ready.rootId);
    assert.ok(ready.hostEpoch);
  } finally {
    rmSync(scope, { recursive: true, force: true });
  }
});

test('rejects a Runtime Host that exits cleanly after Ready', async () => {
  await assert.rejects(
    runRuntimeHostFixture(
      `
          console.log(JSON.stringify({ event: 'runtime_host_ready', rootId: 'root', hostEpoch: 'epoch' }));
          setTimeout(() => process.exit(0), 20);
        `,
      { livenessMs: 200 },
    ),
    /exited with status 0 after Ready/u,
  );
});

test('rejects a Runtime Host that fails verifier shutdown', {
  skip: process.platform === 'win32',
}, async () => {
  await assert.rejects(
    runRuntimeHostFixture(
      `
          console.log(JSON.stringify({ event: 'runtime_host_ready', rootId: 'root', hostEpoch: 'epoch' }));
          process.once('SIGINT', () => process.exit(7));
          setInterval(() => undefined, 1000);
        `,
    ),
    /completed verifier shutdown with status 7/u,
  );
});
