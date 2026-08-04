import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { afterEach, describe, test } from 'node:test';

import { executeFilesystemWorkerRequest } from '../filesystem-worker/operations.js';
import {
  FILESYSTEM_WORKER_PROTOCOL_VERSION,
  type FilesystemWorkerOperation,
  type FilesystemWorkerRequest,
  type FilesystemWorkerTarget,
} from '../filesystem-worker/protocol.js';

const cleanup: string[] = [];
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64',
);

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('filesystem worker operations', () => {
  test('runs Grep from the filesystem root without broadening its target permission', async () => {
    const root = await temporaryDirectory('maka-worker-grep-root-');
    const target = join(root, 'file.ts');
    await writeFile(target, 'const healthSignal = true;', 'utf8');
    let grepCwd: string | undefined;

    const response = await executeFilesystemWorkerRequest(
      requestFor(
        {
          kind: 'grep',
          cwd: root,
          path: target,
          pattern: 'healthSignal',
          maxCountPerFile: 50,
          limit: 200,
          timeoutMs: 1_000,
        },
        { enforcementPath: target, access: 'read', scope: 'exact', targetType: 'file' },
      ),
      {
        grepExecutable: '/usr/bin/rg',
        runGrep: async (input) => {
          grepCwd = input.cwd;
          return { exitCode: 0, stdout: '1:const healthSignal = true;\n', stderrTail: '' };
        },
      },
    );

    assert.equal(grepCwd, parse(target).root);
    assert.deepEqual(response, {
      version: FILESYSTEM_WORKER_PROTOCOL_VERSION,
      requestId: 'request-1',
      ok: true,
      result: { kind: 'grep', matches: ['1:const healthSignal = true;'] },
    });
  });

  test('returns no Grep matches for exit code 1 and surfaces bounded stderr for failures', async () => {
    const root = await temporaryDirectory('maka-worker-grep-result-');
    const target = join(root, 'file.ts');
    await writeFile(target, 'const value = 1;', 'utf8');
    const operation = {
      kind: 'grep' as const,
      cwd: root,
      path: target,
      pattern: 'missing',
      maxCountPerFile: 50,
      limit: 200,
      timeoutMs: 1_000,
    };
    const request = requestFor(operation, {
      enforcementPath: target,
      access: 'read',
      scope: 'exact',
      targetType: 'file',
    });

    const empty = await executeFilesystemWorkerRequest(request, {
      grepExecutable: '/usr/bin/rg',
      runGrep: async () => ({ exitCode: 1, stdout: '', stderrTail: '' }),
    });
    assert.equal(empty.ok, true);
    if (empty.ok) assert.deepEqual(empty.result, { kind: 'grep', matches: [] });

    const failed = await executeFilesystemWorkerRequest(request, {
      grepExecutable: '/usr/bin/rg',
      runGrep: async () => ({
        exitCode: 2,
        stdout: '',
        stderrTail: 'rg: invalid regular expression\n',
      }),
    });
    assert.equal(failed.ok, false);
    if (!failed.ok) {
      assert.equal(failed.error.code, 'filesystem_error');
      assert.match(failed.error.message, /rg: invalid regular expression/);
    }

    const sandboxDenied = await executeFilesystemWorkerRequest(request, {
      grepExecutable: '/usr/bin/rg',
      runGrep: async () => ({
        exitCode: 9,
        stdout: '',
        stderrTail:
          'dyld: Library not loaded: /opt/toolchain/lib/libsearch.dylib (file system sandbox blocked open())',
      }),
    });
    assert.equal(sandboxDenied.ok, false);
    if (!sandboxDenied.ok) assert.equal(sandboxDenied.error.code, 'sandbox_denied');
  });

  test('reads a validated image through the approved path capability', async () => {
    const root = await temporaryDirectory('maka-worker-image-');
    const target = join(root, 'image.png');
    await writeFile(target, ONE_PIXEL_PNG);

    const response = await executeFilesystemWorkerRequest(
      requestFor(
        { kind: 'read', cwd: root, path: target, offset: 1, limit: 1 },
        { enforcementPath: target, access: 'read', scope: 'exact', targetType: 'file' },
      ),
    );

    assert.equal(response.ok, true);
    if (response.ok)
      assert.deepEqual(response.result, {
        kind: 'read_image',
        base64: ONE_PIXEL_PNG.toString('base64'),
        mimeType: 'image/png',
      });
  });

  test('classifies symlinks by their canonical target', async () => {
    const root = await temporaryDirectory('maka-worker-image-link-');
    const image = join(root, 'photo.png');
    const imageLink = join(root, 'notes.txt');
    const text = join(root, 'notes.txt.real');
    const textLink = join(root, 'chart.png');
    await writeFile(image, ONE_PIXEL_PNG);
    await writeFile(text, 'notes', 'utf8');
    await symlink(image, imageLink);
    await symlink(text, textLink);

    const imageResponse = await executeFilesystemWorkerRequest(
      requestFor(
        { kind: 'read', cwd: root, path: imageLink },
        { enforcementPath: image, access: 'read', scope: 'exact', targetType: 'file' },
        image,
      ),
    );
    assert.equal(imageResponse.ok, true);
    if (imageResponse.ok) assert.equal(imageResponse.result.kind, 'read_image');

    const textResponse = await executeFilesystemWorkerRequest(
      requestFor(
        { kind: 'read', cwd: root, path: textLink },
        { enforcementPath: text, access: 'read', scope: 'exact', targetType: 'file' },
        text,
      ),
    );
    assert.equal(textResponse.ok, true);
    if (textResponse.ok) assert.deepEqual(textResponse.result, { kind: 'read', content: 'notes' });
  });

  test('reads and writes only the canonical path capability in the request', async () => {
    const root = await temporaryDirectory('maka-worker-root-');
    const outside = await temporaryDirectory('maka-worker-outside-');
    const insidePath = join(root, 'inside.txt');
    const outsidePath = join(outside, 'outside.txt');
    await writeFile(insidePath, 'inside', 'utf8');

    const readResponse = await executeFilesystemWorkerRequest(
      requestFor(
        { kind: 'read', cwd: root, path: insidePath },
        { enforcementPath: insidePath, access: 'read', scope: 'exact', targetType: 'file' },
      ),
    );
    assert.equal(readResponse.ok, true);
    if (readResponse.ok) assert.deepEqual(readResponse.result, { kind: 'read', content: 'inside' });

    const denied = await executeFilesystemWorkerRequest(
      requestFor(
        { kind: 'write', cwd: root, path: outsidePath, content: 'blocked' },
        { enforcementPath: outsidePath, access: 'write', scope: 'exact', targetType: 'missing' },
        insidePath,
      ),
    );
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.error.code, 'path_denied');
    await assert.rejects(readFile(outsidePath, 'utf8'), { code: 'ENOENT' });
  });

  test('denies a write through a dangling symlink the boundary does not cover', async () => {
    // The worker enforces its own boundary rather than trusting the caller to
    // have canonicalised the path: a link inside the root whose target does not
    // exist yet cannot be realpath'd, and a write through it lands on the
    // target, outside the root, while the boundary names only the link.
    const root = await temporaryDirectory('maka-worker-dangling-root-');
    const outside = await temporaryDirectory('maka-worker-dangling-outside-');
    const link = join(root, 'dangling.txt');
    const target = join(outside, 'not-yet.txt');
    await symlink(target, link);

    const response = await executeFilesystemWorkerRequest(
      requestFor(
        { kind: 'write', cwd: root, path: link, content: 'blocked' },
        { enforcementPath: target, access: 'write', scope: 'exact', targetType: 'missing' },
        link,
      ),
    );

    assert.equal(response.ok, false);
    if (!response.ok) assert.equal(response.error.code, 'path_denied');
    await assert.rejects(readFile(target, 'utf8'), { code: 'ENOENT' });
  });

  test('fails when an approved target changes type before execution', async () => {
    const root = await temporaryDirectory('maka-worker-type-');
    const target = join(root, 'target');
    await mkdir(target);

    const response = await executeFilesystemWorkerRequest(
      requestFor(
        { kind: 'read', cwd: root, path: target },
        { enforcementPath: target, access: 'read', scope: 'exact', targetType: 'file' },
      ),
    );
    assert.equal(response.ok, false);
    if (!response.ok) assert.equal(response.error.code, 'path_changed');
  });

  test('fails when a symlink no longer resolves to the approved canonical target', async () => {
    const root = await temporaryDirectory('maka-worker-link-root-');
    const outside = await temporaryDirectory('maka-worker-link-outside-');
    const approved = join(outside, 'approved.txt');
    const replacement = join(outside, 'replacement.txt');
    const link = join(root, 'link.txt');
    await writeFile(approved, 'approved', 'utf8');
    await writeFile(replacement, 'replacement', 'utf8');
    await symlink(replacement, link);

    const response = await executeFilesystemWorkerRequest(
      requestFor(
        { kind: 'read', cwd: root, path: link },
        { enforcementPath: approved, access: 'read', scope: 'exact', targetType: 'file' },
        approved,
      ),
    );
    assert.equal(response.ok, false);
    if (!response.ok) assert.equal(response.error.code, 'path_changed');
  });
});

function requestFor(
  operation: FilesystemWorkerOperation,
  expectedTarget: FilesystemWorkerTarget,
  permissionPath = operation.path,
): FilesystemWorkerRequest {
  const operationBoundary: FilesystemWorkerRequest['operationBoundary'] = {
    filesystem: {
      entries: [
        {
          path: permissionPath,
          access: expectedTarget.access,
          scope: expectedTarget.scope,
        },
      ],
    },
  };
  return {
    version: FILESYSTEM_WORKER_PROTOCOL_VERSION,
    requestId: 'request-1',
    operation,
    operationBoundary,
    expectedTarget,
  };
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  cleanup.push(path);
  return await realpath(path);
}
