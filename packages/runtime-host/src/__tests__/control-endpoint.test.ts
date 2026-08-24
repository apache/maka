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
import { type ExecFileException, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import {
  prepareRuntimeHostEndpoint,
  RuntimeHostEndpointError,
  windowsPipeAclFailure,
  windowsPipeAclFailureDiagnostic,
} from '../control/endpoint.js';
import { removePosixEndpointDirectories } from './fixtures/endpoint-hygiene.js';

const ROOT_ID = 'ab'.repeat(32);
const PORTABLE_UNIX_SOCKET_PATH_LIMIT = 100;
const PIPE_PATH = `\\\\.\\pipe\\maka-runtime-host-${ROOT_ID.slice(0, 16)}-epoch-1`;

function execFileException(overrides: Partial<ExecFileException>): ExecFileException {
  return Object.assign(new Error('Command failed: powershell.exe -NoLogo'), {
    cmd: 'powershell.exe -NoLogo',
    ...overrides,
  });
}

test('bounds Windows pipe ACL helper diagnostics without serializing the command', () => {
  const error = Object.assign(new Error('helper failed'), {
    code: 1,
    signal: 'SIGTERM',
    killed: true,
    cmd: 'private PowerShell command',
  });
  const diagnostic = windowsPipeAclFailureDiagnostic(error, `ACL failure ${'x'.repeat(8_192)}`);
  const parsed = JSON.parse(diagnostic);

  assert.deepEqual(
    {
      schemaVersion: parsed.schemaVersion,
      helper: parsed.helper,
      exitCode: parsed.exitCode,
      signal: parsed.signal,
      killed: parsed.killed,
    },
    {
      schemaVersion: 1,
      helper: 'windows_pipe_acl',
      exitCode: 1,
      signal: 'SIGTERM',
      killed: true,
    },
  );
  assert.equal(typeof parsed.stderr, 'string');
  assert.ok(Buffer.byteLength(parsed.stderr, 'utf8') <= 4 * 1024);
  assert.equal(diagnostic.includes('private PowerShell command'), false);
});

function rootTag(): string {
  return Buffer.from(ROOT_ID, 'hex').toString('base64url');
}

function currentPrefix(): string {
  return `m-${process.getuid?.()}-${rootTag().slice(0, 16)}-`;
}

function legacyPrefix(): string {
  return `m-${process.getuid?.()}-${rootTag()}-`;
}

describe('runtime host Windows named-pipe endpoint', { skip: process.platform !== 'win32' }, () => {
  test('derives a stable pipe name and has idempotent cleanup', async () => {
    const endpoint = await prepareRuntimeHostEndpoint({ rootId: ROOT_ID, hostEpoch: 'epoch-1' });
    assert.equal(endpoint.path, `\\\\.\\pipe\\maka-runtime-host-${ROOT_ID.slice(0, 16)}-epoch-1`);
    await endpoint.cleanup();
    await endpoint.cleanup();
  });

  test('rejects an invalid storage root identity', async () => {
    await assert.rejects(
      prepareRuntimeHostEndpoint({ rootId: 'not-a-root-id', hostEpoch: '1' }),
      (error: unknown) =>
        error instanceof RuntimeHostEndpointError && error.code === 'insecure_endpoint_directory',
    );
  });
});

// The ACL call itself only runs on Windows, so the failure mapping is covered
// directly: it is the part a CI log has to be read through.
describe('runtime host Windows named-pipe ACL failures', () => {
  test('reports the exit code and the PowerShell diagnostic on a failed ACL', () => {
    const error = windowsPipeAclFailure(
      PIPE_PATH,
      execFileException({ code: 1 }),
      '',
      'Get-Item : Cannot find path\n  At line:12 char:9\n',
    );
    assert.equal(error.code, 'insecure_endpoint_directory');
    assert.match(error.message, /powershell exited with 1/);
    assert.match(error.message, /Get-Item : Cannot find path At line:12 char:9$/);
    assert.ok(error.message.includes(PIPE_PATH));
    assert.ok(!error.message.includes('\n'));
  });

  test('reports a timeout kill as unconfirmed rather than as a failed ACL', () => {
    const error = windowsPipeAclFailure(
      PIPE_PATH,
      execFileException({ killed: true, signal: 'SIGTERM' }),
      '',
      '',
    );
    assert.equal(error.code, 'insecure_endpoint_directory');
    assert.match(error.message, /could not confirm .* within 30000ms and refused the endpoint/);
    assert.match(error.message, /powershell killed with SIGTERM/);
  });

  test('reports a spawn failure by its errno code', () => {
    const error = windowsPipeAclFailure(PIPE_PATH, execFileException({ code: 'ENOENT' }), '', '');
    assert.equal(error.code, 'insecure_endpoint_directory');
    assert.match(error.message, /\(powershell failed to run: ENOENT\)$/);
  });

  test('falls back to stdout and truncates an oversized diagnostic', () => {
    const error = windowsPipeAclFailure(
      PIPE_PATH,
      execFileException({ code: 1 }),
      'x'.repeat(2000),
      '',
    );
    assert.match(error.message, /: x{1000} \[truncated\]$/);
  });
});

describe('runtime host control endpoint', { skip: process.platform === 'win32' }, () => {
  const originalTmpdir = process.env.TMPDIR;

  afterEach(async () => {
    if (originalTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTmpdir;
    await removePosixEndpointDirectories(ROOT_ID);
  });

  test('honors TMPDIR when the socket path fits and encodes ownership atomically', async () => {
    const root = await mkdtemp('/tmp/ep-root-');
    try {
      process.env.TMPDIR = root;
      const endpoint = await prepareRuntimeHostEndpoint({ rootId: ROOT_ID, hostEpoch: '1' });
      const directory = dirname(endpoint.path);
      assert.ok(directory.startsWith(`${root}/`));
      assert.ok(Buffer.byteLength(endpoint.path, 'utf8') <= PORTABLE_UNIX_SOCKET_PATH_LIMIT);
      const directoryStat = await stat(directory);
      assert.equal(directoryStat.mode & 0o777, 0o700);
      assert.match(directory, new RegExp(`${currentPrefix()}${process.pid.toString(36)}-.{6}$`));
      await endpoint.cleanup();
      await assert.rejects(stat(directory));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('falls back to /tmp when TMPDIR would exceed the socket path budget', async () => {
    const base = await mkdtemp('/tmp/ep-deep-');
    try {
      const deep = join(base, 'x'.repeat(80));
      await mkdir(deep, { recursive: true });
      process.env.TMPDIR = deep;
      const endpoint = await prepareRuntimeHostEndpoint({ rootId: ROOT_ID, hostEpoch: '1' });
      assert.ok(dirname(endpoint.path).startsWith('/tmp/'));
      assert.ok(Buffer.byteLength(endpoint.path, 'utf8') <= PORTABLE_UNIX_SOCKET_PATH_LIMIT);
      await endpoint.cleanup();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test('startup sweep keeps a live same-rootId sibling', async () => {
    const root = await mkdtemp('/tmp/ep-root-');
    try {
      process.env.TMPDIR = root;
      const first = await prepareRuntimeHostEndpoint({ rootId: ROOT_ID, hostEpoch: '1' });
      const second = await prepareRuntimeHostEndpoint({ rootId: ROOT_ID, hostEpoch: '2' });
      const firstDirectory = dirname(first.path);
      assert.notEqual(firstDirectory, dirname(second.path));
      await stat(firstDirectory);
      await first.cleanup();
      await second.cleanup();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('startup sweep reclaims a dead owned directory but preserves ambiguous legacy names', async () => {
    const root = await mkdtemp('/tmp/ep-root-');
    try {
      process.env.TMPDIR = root;
      const exited = spawnSync(process.execPath, ['-e', '']);
      assert.ok(exited.pid);
      const dead = join(root, `${currentPrefix()}${exited.pid.toString(36)}-AAAAAA`);
      await mkdir(dead);
      const legacy = join(root, `${legacyPrefix()}CCCCCC`);
      await mkdir(legacy);
      const endpoint = await prepareRuntimeHostEndpoint({ rootId: ROOT_ID, hostEpoch: '1' });
      await assert.rejects(stat(dead));
      await stat(legacy);
      await endpoint.cleanup();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('rejects an invalid storage root identity', async () => {
    await assert.rejects(
      prepareRuntimeHostEndpoint({ rootId: 'not-a-root-id', hostEpoch: '1' }),
      (error: unknown) =>
        error instanceof RuntimeHostEndpointError && error.code === 'insecure_endpoint_directory',
    );
  });
});
