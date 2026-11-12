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
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { createImageFileReader } from '@maka/runtime/image-file-reader';
import { createProxiedFetchTransport } from '@maka/runtime/network/scoped-fetch-transport';
import { readAvatarImageSource } from '../server/avatar-image-source.js';
import { downloadChatImage } from '../server/chat-image-source.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64',
);
const signal = () => new AbortController().signal;

test('avatar local capture is anchored to tool Session cwd, including in full access', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'avatar-boundary-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cwd = join(dir, 'worker');
  const sibling = join(dir, 'worker-other');
  await mkdir(cwd);
  await mkdir(sibling);
  await writeFile(join(cwd, 'avatar.png'), png);
  await writeFile(join(sibling, 'private.png'), png);
  await symlink(sibling, join(cwd, 'escape'));
  await symlink(join(sibling, 'private.png'), join(cwd, 'escape.png'));
  await symlink(join(cwd, 'avatar.png'), join(cwd, 'inside.png'));
  const reader = createImageFileReader();
  let reads = 0;
  const ports = {
    workspace: async () => cwd,
    readLocal: async (path: string, abortSignal: AbortSignal) => {
      reads++;
      return reader({ path, cwd, executionBoundary: { kind: 'bypass', revision: 1 }, abortSignal });
    },
    download: async () => {
      throw Error('unexpected network');
    },
  };
  for (const path of [
    'avatar.png',
    join(cwd, 'avatar.png'),
    pathToFileURL(join(cwd, 'avatar.png')).href,
    'inside.png',
  ]) {
    const result = await readAvatarImageSource(path, signal(), ports);
    assert.deepEqual(Buffer.from(result.bytes), png);
  }
  const before = reads;
  for (const path of [
    '../worker-other/private.png',
    join(sibling, 'private.png'),
    'escape/private.png',
    'escape.png',
    cwd,
    'data:image/png;base64,AAA',
    'ftp://example.com/a.png',
  ]) {
    await assert.rejects(readAvatarImageSource(path, signal(), ports));
  }
  assert.equal(reads, before, 'rejected paths never reach the filesystem reader');
  await writeFile(join(cwd, 'big.png'), Buffer.alloc(2 * 1024 * 1024 + 1));
  await assert.rejects(readAvatarImageSource('big.png', signal(), ports), /too_large/);
  assert.equal(reads, before, 'oversized local files rejected before reading');
  await writeFile(join(cwd, 'fake.png'), '<svg onload="alert(1)"/>');
  await assert.rejects(readAvatarImageSource('fake.png', signal(), ports));
  const aborted = AbortSignal.abort(Error('cancelled'));
  await assert.rejects(readAvatarImageSource('avatar.png', aborted, ports), /cancelled/);
});

test('avatar does not replace the Session filesystem authority or trust loader MIME', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'avatar-authority-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, 'avatar.png'), png);
  await assert.rejects(
    readAvatarImageSource('avatar.png', signal(), {
      workspace: async () => cwd,
      readLocal: async () => {
        throw Error('session denied');
      },
      download: async () => {
        throw Error('unexpected network');
      },
    }),
    /session denied/,
  );
  await assert.rejects(
    readAvatarImageSource('https://example.com/a.png', signal(), {
      workspace: async () => {
        throw Error('unexpected workspace');
      },
      readLocal: async () => {
        throw Error('unexpected local');
      },
      download: async () => ({ bytes: Buffer.from('<svg/>'), mimeType: 'image/png' }),
    }),
  );
});

test('avatar rejects observed file replacement while capturing', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'avatar-replaced-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const path = join(cwd, 'avatar.png');
  await writeFile(path, png);
  await assert.rejects(
    readAvatarImageSource('avatar.png', signal(), {
      workspace: async () => cwd,
      readLocal: async (_path, boundedSignal) => {
        assert.ok(boundedSignal instanceof AbortSignal);
        await rm(path);
        await writeFile(path, Buffer.concat([png, Buffer.alloc(10)]));
        return { bytes: png, mimeType: 'image/png' };
      },
      download: async () => {
        throw Error('unexpected network');
      },
    }),
    /not_allowed/,
  );
});

test('avatar downloader rejects local/private and credential URLs through real public transport', async () => {
  for (const url of [
    'http://127.0.0.1/a.png',
    'http://2130706433/a.png',
    'http://0x7f000001/a.png',
    'http://10.0.0.1/a.png',
    'http://172.16.0.1/a.png',
    'http://192.168.1.1/a.png',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/a.png',
    'http://[::ffff:127.0.0.1]/a.png',
    'http://[fc00::1]/a.png',
    'http://localhost/a.png',
    'http://service.local/a.png',
    'https://user:secret@example.com/a.png',
  ])
    await assert.rejects(downloadChatImage(url, signal()), /not_allowed/, url);
});

test('avatar redirects re-enter public transport policy; downgrade and redirect loops fail', async () => {
  const transport = createProxiedFetchTransport(null);
  try {
    for (const destination of [
      'http://127.0.0.1/private.png',
      'http://169.254.169.254/a.png',
      'http://[::1]/a.png',
      'file:///etc/passwd',
      'https://user:pass@example.com/a.png',
    ]) {
      let calls = 0;
      await assert.rejects(
        downloadChatImage('http://example.com/start', signal(), {
          fetch: async (url, init) => {
            calls++;
            assert.equal(init?.targetPolicy, 'public');
            assert.equal(init?.redirect, 'manual');
            return calls === 1
              ? new Response(null, { status: 302, headers: { location: destination } })
              : transport.fetch(url, init);
          },
        }),
        /not_allowed/,
      );
      assert.equal(calls, 2);
    }
    await assert.rejects(
      downloadChatImage('https://example.com/start', signal(), {
        fetch: async () =>
          new Response(null, { status: 302, headers: { location: 'http://example.com/a.png' } }),
      }),
      /not_allowed/,
    );
    let redirects = 0;
    await assert.rejects(
      downloadChatImage('https://example.com/start', signal(), {
        fetch: async () => {
          redirects++;
          return new Response(null, { status: 302, headers: { location: '/again' } });
        },
      }),
      /download_failed/,
    );
    assert.equal(redirects, 4);
  } finally {
    await transport.close();
  }
});

test('avatar download accepts bounded image bytes, limits declared and streamed sizes', async () => {
  const result = await downloadChatImage('https://example.com/a.png', signal(), {
    fetch: async () => new Response(png),
  });
  assert.deepEqual(Buffer.from(result.bytes), png);
  for (const response of [
    new Response(png, { headers: { 'content-length': String(2 * 1024 * 1024 + 1) } }),
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(1024 * 1024));
          controller.enqueue(new Uint8Array(1024 * 1024));
          controller.enqueue(new Uint8Array(1));
          controller.close();
        },
      }),
    ),
  ])
    await assert.rejects(
      downloadChatImage('https://example.com/a.png', signal(), { fetch: async () => response }),
      /too_large/,
    );
});
