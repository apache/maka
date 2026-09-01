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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  assertExpectedEpochRelation,
  parseQualificationArgs,
  qualificationSandboxArgs,
  qualificationSandboxInvocation,
  sha256File,
} from './qualify-released-cli-state-root.mjs';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

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
