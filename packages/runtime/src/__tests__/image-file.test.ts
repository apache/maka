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

import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readWorkspaceFile, validateImageBytes } from '../image-file.js';
import { LocalWorkspaceExecutor } from '../workspace-executor.js';
import { executeFilesystemOperation } from '../filesystem-worker/operations.js';
import { MAX_READ_IMAGE_BYTES } from '@maka/core/attachments';
import { ARTIFACT_IMAGE_PREVIEW_MAX_BYTES } from '@maka/core/artifacts';
import { createImageFileReader, ImageFileReadError } from '../image-file-reader.js';
import { FilesystemWorkerClientError } from '../filesystem-worker/client.js';
import { executeFilesystemWorkerRequest } from '../filesystem-worker/operations.js';
import { FILESYSTEM_WORKER_PROTOCOL_VERSION } from '../filesystem-worker/protocol.js';
import { buildBuiltinTools } from '../builtin-tools.js';

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64',
);
// Valid 2560x1 PNG, wider than the model input limit but within chat's byte budget.
const WIDE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAACgAAAAABCAYAAAASePczAAAAIUlEQVR4nO3BAQ0AAADCoPdPbQ43oAAAAAAAAAAAAIA7AygBAAEQnI5pAAAAAElFTkSuQmCC',
  'base64',
);
test('chat images cap both edge length and total decoded pixels', () => {
  for (const [width, height] of [
    [16_385, 1],
    [8192, 8192],
  ]) {
    const bytes = Buffer.from(ONE_PIXEL_PNG);
    bytes.writeUInt32BE(width, 16);
    bytes.writeUInt32BE(height, 20);
    assert.throws(() => validateImageBytes(bytes, 'chat'), /Image exceeds/);
  }
  assert.equal(validateImageBytes(WIDE_PNG, 'chat').mimeType, 'image/png');
});

test('chat reader preserves structured Worker failures independently of message wording', async () => {
  for (const [reason, expected] of [
    ['not_found', 'not_found'],
    ['filesystem_denied', 'not_allowed'],
    ['path_denied', 'not_allowed'],
    ['sandbox_denied', 'not_allowed'],
    ['image_too_large', 'too_large'],
    ['invalid_image', 'unsupported_mime'],
    ['worker_io_incomplete', 'read_failed'],
  ] as const) {
    const reader = createImageFileReader({
      filesystemWorker: {
        execute: async () => {
          throw new FilesystemWorkerClientError({
            reason,
            stage: 'operation',
            message: '读取失败',
          });
        },
      },
    });
    await assert.rejects(
      reader({ path: 'image.png', cwd: process.cwd() }),
      (error: unknown) => error instanceof ImageFileReadError && error.reason === expected,
    );
  }
});

test('chat reader preserves local missing paths and workspace boundary denials', async (t) => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'maka-chat-read-errors-')));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const reader = createImageFileReader();
  await assert.rejects(
    reader({ path: 'missing.png', cwd }),
    (error: unknown) => error instanceof ImageFileReadError && error.reason === 'not_found',
  );
  await assert.rejects(
    reader({ path: join(cwd, '..', 'outside.png'), cwd }),
    (error: unknown) => error instanceof ImageFileReadError && error.reason === 'not_allowed',
  );
});

test('Worker transports typed image validation failures instead of generic filesystem errors', async (t) => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'maka-chat-image-wire-')));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const path = join(cwd, 'image.png');
  for (const [content, expected] of [
    [ONE_PIXEL_PNG.subarray(0, 8), 'invalid_image'],
    [Buffer.alloc(ARTIFACT_IMAGE_PREVIEW_MAX_BYTES + 1), 'image_too_large'],
  ] as const) {
    await writeFile(path, content);
    const response = await executeFilesystemWorkerRequest({
      version: FILESYSTEM_WORKER_PROTOCOL_VERSION,
      requestId: 'read-image',
      operation: { kind: 'read', cwd, path, imagePurpose: 'chat' },
      operationBoundary: {
        filesystem: { entries: [{ path: cwd, access: 'read', scope: 'subtree' }] },
      },
      expectedTarget: {
        enforcementPath: path,
        access: 'read',
        scope: 'exact',
        targetType: 'file',
        identity: 'unchecked',
      },
    });
    assert.equal(response.ok, false);
    if (!response.ok) assert.equal(response.error.code, expected);
  }
});

for (const route of ['workspace', 'worker'] as const) {
  test(`${route} chat reads admit wide screenshots without relaxing ordinary Read`, async (t) => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), 'maka-chat-image-policy-')));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    const path = join(cwd, 'wide.png');
    const read = (imagePurpose?: 'chat') =>
      route === 'workspace'
        ? new LocalWorkspaceExecutor().readFile({
            cwd,
            path,
            ...(imagePurpose ? { imagePurpose } : {}),
          })
        : executeFilesystemOperation(
            { kind: 'read', cwd, path, ...(imagePurpose ? { imagePurpose } : {}) },
            {
              filesystem: { entries: [{ path: cwd, access: 'read', scope: 'subtree' }] },
            },
          );
    await writeFile(path, WIDE_PNG);
    await assert.rejects(read(), /dimensions.*model input limit/i);
    const result = await read('chat');
    if ('base64' in result) assert.deepEqual(Buffer.from(result.base64, 'base64'), WIDE_PNG);
    else {
      assert.ok('bytes' in result && result.bytes instanceof Uint8Array);
      assert.deepEqual(Buffer.from(result.bytes), WIDE_PNG);
    }
    await truncate(path, ARTIFACT_IMAGE_PREVIEW_MAX_BYTES + 1);
    await assert.rejects(read('chat'), /2 MiB/);
    await writeFile(path, 'not an image');
    await assert.rejects(read('chat'), /not a supported/i);
  });
}

test('PublishImage saves a wide screenshot through the same chat read policy', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'maka-publish-wide-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, 'wide.png'), WIDE_PNG);
  let published = false;
  const tool = buildBuiltinTools({
    publishImage: async ({ bytes }) => {
      assert.deepEqual(Buffer.from(bytes), WIDE_PNG);
      published = true;
      return { kind: 'session_file', sessionId: 'session', relativePath: 'saved-image' };
    },
  }).find((tool) => tool.name === 'PublishImage')!;
  await tool.impl(
    { path: 'wide.png' },
    {
      sessionId: 'session',
      turnId: 'turn',
      toolCallId: 'publish',
      cwd,
      permissionMode: 'bypass',
      executionBoundary: { kind: 'bypass', revision: 0 },
      abortSignal: new AbortController().signal,
      emitOutput() {},
    },
  );
  assert.equal(published, true);
});

test('chat reads reject FIFOs without waiting for a writer', {
  skip: process.platform === 'win32',
  timeout: 1000,
}, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'maka-image-fifo-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const path = join(cwd, 'blocked.png');
  execFileSync('mkfifo', [path]);
  await assert.rejects(createImageFileReader()({ path, cwd }), /not a file/i);
});

test('chat reads honor cancellation before opening the source', async () => {
  const abortSignal = AbortSignal.abort(new Error('capture cancelled'));
  await assert.rejects(
    readWorkspaceFile('/missing.png', { imagePurpose: 'chat', abortSignal }),
    /capture cancelled/,
  );
});

for (const route of ['workspace', 'worker']) {
  for (const name of ['image.png', 'image', 'image.bin']) {
    test(`${route} Read preserves PNG media semantics for ${name}`, async (t) => {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'maka-image-name-')));
      t.after(() => rm(root, { recursive: true, force: true }));
      const path = join(root, name);
      await writeFile(path, ONE_PIXEL_PNG);
      if (route === 'workspace') {
        const file = await new LocalWorkspaceExecutor().readFile({ cwd: root, path });
        assert.ok('bytes' in file, 'PNG bytes must not become a UTF-8 text read');
        assert.deepEqual(Buffer.from(file.bytes), ONE_PIXEL_PNG);
      } else {
        const file = await executeFilesystemOperation(
          { kind: 'read', cwd: root, path },
          {
            filesystem: { entries: [{ path: root, access: 'read', scope: 'subtree' }] },
          },
        );
        assert.equal(file.kind, 'read_image');
        if (file.kind === 'read_image') assert.equal(file.base64, ONE_PIXEL_PNG.toString('base64'));
      }
    });
  }
}

test('content detection preserves all text bytes, empty files and line windows', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-file-text-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'text');
  for (const content of ['', 'short', '中文🙂首行\nsecond line\nlast']) {
    await writeFile(path, content);
    assert.deepEqual(await readWorkspaceFile(path), { content });
  }
  assert.deepEqual(
    await new LocalWorkspaceExecutor().readFile({ cwd: root, path, offset: 1, limit: 1 }),
    { content: 'second line' },
  );
});

test('an opaque image name keeps image byte limits and invalid-image validation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-file-image-limits-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'opaque');
  await writeFile(path, ONE_PIXEL_PNG);
  await truncate(path, MAX_READ_IMAGE_BYTES + 1);
  await assert.rejects(readWorkspaceFile(path), /too large|exceeds/i);
  await writeFile(path, ONE_PIXEL_PNG.subarray(0, 8));
  await assert.rejects(readWorkspaceFile(path), /dimensions/i);
  await writeFile(join(root, 'invalid.png'), 'ordinary text');
  await assert.rejects(readWorkspaceFile(join(root, 'invalid.png')), /not a supported/i);
});

test('validateImageBytes rejects image signatures without parseable dimensions', () => {
  assert.throws(
    () => validateImageBytes(Buffer.from('\x89PNG\r\n\x1a\n', 'latin1')),
    /dimensions/i,
  );
});

test('validateImageBytes accepts a valid one-pixel image', () => {
  assert.deepEqual(validateImageBytes(ONE_PIXEL_PNG), {
    bytes: ONE_PIXEL_PNG,
    mimeType: 'image/png',
  });
});

test('validateImageBytes rejects non-positive image dimensions', () => {
  const png = Buffer.from(ONE_PIXEL_PNG);
  png.writeUInt32BE(0, 16);

  assert.throws(() => validateImageBytes(png), /dimensions/i);
});

test('readWorkspaceFile rejects images whose dimensions exceed the model input limit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-image-file-'));
  const path = join(root, 'oversized.png');
  const png = Buffer.alloc(33);
  Buffer.from('\x89PNG\r\n\x1a\n', 'latin1').copy(png);
  png.writeUInt32BE(13, 8);
  png.write('IHDR', 12, 'ascii');
  png.writeUInt32BE(8001, 16);
  png.writeUInt32BE(8001, 20);
  png[24] = 8;
  png[25] = 6;
  await writeFile(path, png);

  try {
    await assert.rejects(readWorkspaceFile(path), /dimensions.*downscale/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
