import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { prepareRuntimeHostEndpoint, RuntimeHostEndpointError } from '../control/endpoint.js';
import { removePosixEndpointDirectories } from './fixtures/endpoint-hygiene.js';

const ROOT_ID = 'ab'.repeat(32);
const PORTABLE_UNIX_SOCKET_PATH_LIMIT = 100;

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
