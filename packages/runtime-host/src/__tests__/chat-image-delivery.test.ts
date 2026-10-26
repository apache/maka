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
import { test, type TestContext } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns/promises';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { createImageFileReader, ImageFileReadError } from '@maka/runtime/image-file-reader';
import { FilesystemWorkerClientError } from '@maka/runtime/filesystem-worker';
import { openInteractiveArtifactStoreForWrite } from '@maka/storage/artifact-stores';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import {
  ChatImageDeliveryService,
  type ChatImageDeliveryPorts,
} from '../server/chat-image-delivery.js';
import { chatImageSources } from '../server/chat-image-markdown.js';
import { checkedChatImage, downloadChatImage } from '../server/chat-image-source.js';
import { IMAGE_DELIVERY_OPERATION_SPECS } from '../protocol/image-delivery.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';
import { isImageDeliveryMetadata, isImageDeliverySource } from '@maka/core/image-delivery';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64',
);
// Mock only Node's DNS/transport boundary. The production downloader still
// checks public addresses, pins DNS, follows redirects and validates HTTP bytes.
// Top-level tests in this file run serially; restore the ESM bindings at teardown.
function publicImageOrigin(
  t: TestContext,
  localSource: string,
  protocol = 'http:',
  address = '93.184.216.34',
): string {
  const local = new URL(localSource);
  const source = new URL(localSource);
  source.hostname = 'image.example';
  source.protocol = protocol;
  const connect = net.connect;
  t.mock.method(dns, 'lookup', async (host: string) => {
    assert.equal(host, source.hostname);
    return [{ address, family: address.includes(':') ? 6 : 4 }];
  });
  const transport = (options: net.TcpNetConnectOpts & { servername?: string }) => {
    assert.equal(options.host, source.hostname);
    assert.ok(options.lookup);
    options.lookup(source.hostname, { all: true }, (error, addresses) => {
      assert.equal(error, null);
      assert.deepEqual(addresses, [{ address, family: address.includes(':') ? 6 : 4 }]);
    });
    const socket = connect({ host: local.hostname, port: Number(local.port) });
    if (protocol === 'https:') {
      assert.equal(options.servername, source.hostname);
      // This HTTP fixture exercises HTTPS redirect policy, not TLS verification.
      socket.once('connect', () => socket.emit('secureConnect'));
    }
    return socket;
  };
  t.mock.method(net, 'connect', transport);
  t.mock.method(tls, 'connect', transport);
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return source.href;
}

const REQUEST = {
  sessionId: 'session-1',
  turnId: 'turn-1',
  messageId: 'message-1',
  source: '/tmp/image.png',
};
async function fixture(
  limits?: { sessionBytes: number; workspaceBytes: number },
  readLocalImage?: ChatImageDeliveryPorts['readLocalImage'],
  beforeCreate?: (input: Parameters<ChatImageDeliveryPorts['artifacts']['create']>[0]) => void,
  download?: ChatImageDeliveryPorts['download'],
) {
  const root = await mkdtemp(join(tmpdir(), 'maka-image-delivery-'));
  const owner = await tryAcquireInteractiveRootOwner(
    await resolveStorageRoot({ path: root, kind: 'interactive' }),
  );
  assert.ok(owner);
  const store = await openInteractiveArtifactStoreForWrite(owner.lease);
  const authority = { store, close: () => store.close() };
  const errors: unknown[] = [];
  const presentationErrors: unknown[] = [];
  let remoteAllowed = true;
  let reads = 0;
  let leases = 0;
  const messages = new Map<string, string>();
  const localReader = createImageFileReader();
  let present = true;
  const ports: ChatImageDeliveryPorts = {
    artifacts: {
      putImageDeliveryJob: authority.store.putImageDeliveryJob,
      readImageDeliveryJob: authority.store.readImageDeliveryJob,
      listImageDeliveryJobs: authority.store.listImageDeliveryJobs,
      deleteImageDeliveryJob: authority.store.deleteImageDeliveryJob,
      create: async (input) => {
        beforeCreate?.(input);
        return authority.store.create(input);
      },
      findImageDelivery: authority.store.findImageDelivery,
      getInSession: authority.store.getInSession,
      setImageDeliveryAttempt: authority.store.setImageDeliveryAttempt,
    },
    admission: new SessionAdmissionGate(),
    limits,
    sourceReadTimeoutMs: 1000,
    retryDelayMs: 1,
    canLoadRemote: async () => remoteAllowed,
    download: download ?? downloadChatImage,
    isPresent: async () => present,
    readMessage: async (i) => messages.get(i.messageId),
    readLocalImage: async (sessionId, path, signal) => {
      reads++;
      if (readLocalImage) return readLocalImage(sessionId, path, signal);
      return localReader({ path, cwd: root, abortSignal: signal });
    },
    acquireResidency: () => {
      leases++;
      return {
        release: () => {
          leases--;
        },
      };
    },
    persistenceFailed: (error) => errors.push(error),
    presentationFailed: (error) => presentationErrors.push(error),
  };
  const service = new ChatImageDeliveryService(ports);
  return {
    root,
    ports,
    owner,
    authority,
    service,
    messages,
    errors,
    presentationErrors,
    allowRemote(value: boolean) {
      remoteAllowed = value;
    },
    get reads() {
      return reads;
    },
    get leases() {
      return leases;
    },
    removeSession: () => {
      present = false;
    },
    async close() {
      await service.close();
      authority.close();
      await owner.close();
      await rm(owner.controlDirectory, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('Host drain releases both capture slots even when a source reader ignores cancellation', {
  timeout: 2000,
}, async () => {
  const f = await fixture(undefined, () => new Promise(() => {}));
  try {
    await observe(f.service, '/tmp/blocked-1.png');
    await observe(f.service, '/tmp/blocked-2.png', 'session-1', 'message-2');
    while (f.reads < 2) await new Promise((resolve) => setImmediate(resolve));
    await f.service.close();
    assert.equal(f.leases, 0);
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});
test('a stalled local source automatically retries within a bounded attempt budget', {
  timeout: 15000,
}, async () => {
  let reads = 0;
  const f = await fixture(undefined, async () => {
    if (++reads === 1) return new Promise(() => {});
    return checkedChatImage(PNG);
  });
  try {
    await observe(f.service, REQUEST.source);
    await f.service.waitForIdle();
    assert.equal(reads, 2);
    assert.equal(f.leases, 0);
    assert.equal((await f.service.resolve(REQUEST)).status, 'ready');
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});
function observe(
  service: ChatImageDeliveryService,
  source: string,
  sessionId = REQUEST.sessionId,
  messageId = REQUEST.messageId,
) {
  return service.observe(sessionId, {
    id: 'text-event',
    type: 'text_complete',
    turnId: REQUEST.turnId,
    ts: 1,
    messageId,
    text: `![Screenshot](<${source}>)`,
  });
}
test('parses real Markdown image nodes, including references and balanced destinations, without scanning code or HTML', () => {
  const text = [
    '![one](</tmp/a (1).png>)',
    '![two][pic]',
    '![titled](https://example.com/titled.png "Screenshot title")',
    String.raw`![escaped](/tmp/a\(1\).png)`,
    '',
    '[pic]: https://example.com/a.png',
    '`![code](/tmp/secret.png)`',
    '```md',
    '![fenced](/tmp/secret2.png)',
    '```',
    '<img src="/tmp/html.png">',
    '![incomplete](https://example.com/',
  ].join('\n');
  assert.deepEqual(chatImageSources(text), [
    '/tmp/a (1).png',
    'https://example.com/a.png',
    'https://example.com/titled.png',
    '/tmp/a(1).png',
  ]);
});
test('automatically saves a local delivery without any UI request; deletion and ArtifactStore reopen do not break replay', async () => {
  const f = await fixture();
  try {
    const source = join(f.root, 'original.png');
    await writeFile(source, PNG);
    await observe(f.service, source);
    await f.service.waitForIdle();
    assert.equal(f.reads, 1);
    assert.equal(f.leases, 0);
    assert.deepEqual(f.errors, []);
    await rm(source);
    const input = { ...REQUEST, source };
    const result = await f.service.resolve(input);
    assert.equal(result.status, 'ready');
    if (result.status !== 'ready') return;
    f.authority.close();
    const reopenedStore = await openInteractiveArtifactStoreForWrite(f.owner.lease);
    const reopened = { store: reopenedStore, close: () => reopenedStore.close() };
    try {
      const record = await reopened.store.findImageDelivery(
        input.sessionId,
        input.turnId,
        input.messageId,
        source,
      );
      assert.equal(record?.status, 'ready');
      const bytes = await reopened.store.readBinaryInSession(input.sessionId, result.artifactId);
      assert.equal(bytes.ok, true);
      if (bytes.ok) assert.equal(bytes.base64, PNG.toString('base64'));
    } finally {
      reopened.close();
    }
  } finally {
    await f.close();
  }
});

test('literal percent filenames retain precedence and file URLs are decoded only once', async () => {
  const paths: string[] = [];
  const reader = createImageFileReader();
  const f = await fixture(undefined, (_session, path, abortSignal) => {
    paths.push(path);
    return reader({ path, cwd: f.root, abortSignal });
  });
  try {
    for (const name of ['literal%20name.png', '100%.png', 'invalid%E4.png']) {
      const path = join(f.root, name);
      await writeFile(path, PNG);
      if (name.includes('%20')) await writeFile(path.replace('%20', ' '), 'wrong source');
      for (const source of [path, pathToFileURL(path).href]) {
        paths.length = 0;
        await observe(f.service, source);
        await f.service.waitForIdle();
        assert.equal((await f.service.resolve({ ...REQUEST, source })).status, 'ready', source);
        assert.deepEqual(paths, [path]);
      }
    }
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});

test('remote delivery is downloaded once, remains replayable after the origin server disappears, and sends no credentials/referrer', async (t) => {
  const f = await fixture();
  let requests = 0;
  const server = createServer((req, res) => {
    requests++;
    assert.equal(req.headers.referer, undefined);
    assert.equal(req.headers.cookie, undefined);
    assert.equal(req.headers.authorization, undefined);
    res.setHeader('Content-Type', 'image/png');
    res.end(PNG);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const source = publicImageOrigin(
    t,
    `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/image.png`,
  );
  try {
    f.messages.set(REQUEST.messageId, `![Screenshot](${source})`);
    await observe(f.service, source);
    await f.service.waitForIdle();
    assert.equal(requests, 1);
    await f.service.waitForIdle();
    assert.deepEqual(f.errors, []);
    assert.equal((await f.service.resolve({ ...REQUEST, source })).status, 'ready');
    assert.equal(requests, 1);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    assert.equal((await f.service.resolve({ ...REQUEST, source })).status, 'ready');
    assert.equal(requests, 1);
  } finally {
    server.close();
    await f.close();
  }
});
test('a supplied path is never a read grant; sources inside code cannot trigger archival', async () => {
  const f = await fixture();
  try {
    f.messages.set(REQUEST.messageId, '`![secret](/tmp/image.png)`');
    assert.deepEqual(await f.service.resolve(REQUEST), { status: 'unavailable' });
    f.messages.set(REQUEST.messageId, 'plain text');
    assert.deepEqual(await f.service.resolve(REQUEST), { status: 'unavailable' });
    assert.equal(f.reads, 0);
  } finally {
    await f.close();
  }
});
test('transient failure is persisted and is retried only on an explicit request', async () => {
  const f = await fixture();
  try {
    const source = join(f.root, 'later.png');
    await observe(f.service, source);
    await f.service.waitForIdle();
    assert.deepEqual(await f.service.resolve({ ...REQUEST, source }), {
      status: 'failed',
      reason: 'not_found',
    });
    await writeFile(source, PNG);
    assert.equal((await f.service.resolve({ ...REQUEST, source })).status, 'failed');
    assert.equal(f.reads, 1);
    assert.equal((await f.service.resolve({ ...REQUEST, source, retry: true })).status, 'pending');
    await f.service.waitForIdle();
    assert.equal((await f.service.resolve({ ...REQUEST, source })).status, 'ready');
    assert.equal(f.reads, 2);
  } finally {
    await f.close();
  }
});

test('truncated HTTP images are rejected, and an explicit retry archives the repaired source', async (t) => {
  const f = await fixture();
  let content = PNG.subarray(0, 8);
  let requests = 0;
  const server = createServer((_req, res) => {
    requests++;
    res.setHeader('Content-Type', 'image/png');
    res.end(content);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const source = publicImageOrigin(
    t,
    `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/image.png`,
  );
  const identity = { ...REQUEST, source, loadRemote: true };
  try {
    f.messages.set(REQUEST.messageId, `![Screenshot](${source})`);
    await f.service.resolve(identity);
    await f.service.waitForIdle();
    assert.deepEqual(await f.service.resolve(identity), {
      status: 'failed',
      reason: 'unsupported_mime',
    });
    assert.equal(requests, 1);
    const failed = await f.authority.store.listPage(REQUEST.sessionId, { offset: 0, limit: 10 });
    assert.equal(failed.total, 0, 'failed delivery is not a file');
    content = PNG;
    assert.equal((await f.service.resolve({ ...identity, retry: true })).status, 'pending');
    await f.service.waitForIdle();
    const ready = await f.service.resolve(identity);
    assert.equal(ready.status, 'ready');
    assert.equal(requests, 2);
    if (ready.status === 'ready') {
      const bytes = await f.authority.store.readBinaryInSession(
        identity.sessionId,
        ready.artifactId,
      );
      assert.ok(bytes.ok);
      if (bytes.ok) assert.equal(bytes.base64, PNG.toString('base64'));
    }
    assert.equal(
      (await f.authority.store.listPage(identity.sessionId, { offset: 0, limit: 10 })).total,
      1,
    );
    assert.deepEqual(f.errors, []);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.close();
  }
});

test('ready image retries retain the only saved copy after its source is deleted', async () => {
  const f = await fixture();
  const source = join(f.root, 'temporary.png');
  try {
    await writeFile(source, PNG);
    await observe(f.service, source);
    await f.service.waitForIdle();
    const identity = { ...REQUEST, source };
    const ready = await f.service.resolve(identity);
    assert.equal(ready.status, 'ready');
    await rm(source);
    const retries = await Promise.all([
      f.service.resolve({ ...identity, retry: true }),
      f.service.resolve({ ...identity, retry: true }),
    ]);
    assert.deepEqual(retries, [ready, ready]);
    assert.equal(f.reads, 1);
    assert.equal(
      (await f.authority.store.listPage(REQUEST.sessionId, { offset: 0, limit: 10 })).total,
      1,
    );
    if (ready.status === 'ready') {
      const bytes = await f.authority.store.readBinaryInSession(
        REQUEST.sessionId,
        ready.artifactId,
      );
      assert.ok(bytes.ok);
      if (bytes.ok) assert.equal(bytes.base64, PNG.toString('base64'));
    }
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});

test('Worker read errors retain their image delivery reasons in persisted failures', async () => {
  for (const [reason, expected] of [
    ['not_found', 'not_found'],
    ['filesystem_denied', 'not_allowed'],
    ['image_too_large', 'too_large'],
    ['invalid_image', 'unsupported_mime'],
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
    const f = await fixture(undefined, (_session, path, abortSignal) =>
      reader({ path, cwd: process.cwd(), abortSignal }),
    );
    try {
      await observe(f.service, REQUEST.source);
      await f.service.waitForIdle();
      assert.deepEqual(await f.service.resolve(REQUEST), { status: 'failed', reason: expected });
      assert.deepEqual(f.errors, []);
    } finally {
      await f.close();
    }
  }
});

test('pending capture survives persistence failure and is removed only after a durable terminal record', async () => {
  let failPublication = true;
  const f = await fixture(
    undefined,
    async () => checkedChatImage(PNG),
    (input) => {
      if (failPublication && input.imageDelivery?.status === 'ready')
        throw new Error('publication failed');
    },
  );
  try {
    await observe(f.service, REQUEST.source);
    await f.service.waitForIdle();
    const pending = await f.authority.store.listPage(REQUEST.sessionId, { offset: 0, limit: 10 });
    assert.equal(pending.total, 0, 'pending capture is not an artifact');
    assert.deepEqual(
      await f.authority.store.findImageDelivery(
        REQUEST.sessionId,
        REQUEST.turnId,
        REQUEST.messageId,
        REQUEST.source,
      ),
      { status: 'pending' },
    );
    assert.equal(f.errors.length, 1);
    failPublication = false;
    assert.equal((await f.service.resolve(REQUEST)).status, 'pending');
    await f.service.waitForIdle();
    const ready = await f.authority.store.listPage(REQUEST.sessionId, { offset: 0, limit: 10 });
    assert.equal(ready.total, 1);
    assert.equal(ready.records[0]?.imageDelivery?.status, 'ready');
    assert.equal(f.errors.length, 1);
  } finally {
    await f.close();
  }
});

test('quota admission is atomic under concurrent jobs and identical content shares bytes across sessions', async () => {
  const f = await fixture({ sessionBytes: PNG.length, workspaceBytes: PNG.length });
  try {
    const source = join(f.root, 'same.png');
    await writeFile(source, PNG);
    await observe(f.service, source);
    await observe(f.service, source, 'session-2');
    await f.service.waitForIdle();
    const a = await f.service.resolve({ ...REQUEST, source });
    const b = await f.service.resolve({ ...REQUEST, sessionId: 'session-2', source });
    assert.equal(a.status, 'ready');
    assert.equal(b.status, 'ready');
    if (a.status !== 'ready' || b.status !== 'ready') return;
    const ra = (await f.authority.store.getInSession('session-1', a.artifactId)).record!;
    const rb = (await f.authority.store.getInSession('session-2', b.artifactId)).record!;
    assert.equal(
      (await stat(join(f.root, 'artifacts', ra.relativePath))).ino,
      (await stat(join(f.root, 'artifacts', rb.relativePath))).ino,
    );
    const different = join(f.root, 'different.png');
    await writeFile(different, Buffer.concat([PNG, Buffer.from('different')]));
    await observe(f.service, different, 'session-1', 'message-2');
    await f.service.waitForIdle();
    assert.deepEqual(
      await f.service.resolve({ ...REQUEST, source: different, messageId: 'message-2' }),
      { status: 'failed', reason: 'quota_exceeded' },
    );
    await f.authority.store.purgeSessionArtifacts('session-1');
    assert.equal((await f.authority.store.readBinaryInSession('session-2', b.artifactId)).ok, true);
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});
test('copying a conversation carries delivery provenance and saved bytes; it does not read the original source', async () => {
  const f = await fixture();
  try {
    const source = join(f.root, 'original.png');
    await writeFile(source, PNG);
    await observe(f.service, source);
    await f.service.waitForIdle();
    await rm(source);
    await f.authority.store.copyConversationArtifacts({
      sourceSessionId: 'session-1',
      targetSessionId: 'session-copy',
      turnIds: ['turn-1'],
    });
    const original = await f.service.resolve({ ...REQUEST, source });
    const copied = await f.service.resolve({ ...REQUEST, sessionId: 'session-copy', source });
    assert.equal(copied.status, 'ready');
    if (copied.status === 'ready' && original.status === 'ready') {
      const sourceRecord = (await f.authority.store.getInSession('session-1', original.artifactId))
        .record!;
      const targetRecord = (await f.authority.store.getInSession('session-copy', copied.artifactId))
        .record!;
      assert.equal(
        (await stat(join(f.root, 'artifacts', sourceRecord.relativePath))).ino,
        (await stat(join(f.root, 'artifacts', targetRecord.relativePath))).ino,
      );
      await f.authority.store.purgeSessionArtifacts('session-1');
      assert.equal(
        (await f.authority.store.readBinaryInSession('session-copy', copied.artifactId)).ok,
        true,
      );
    }
    assert.equal(f.reads, 1);
  } finally {
    await f.close();
  }
});
test('source readers reject unsafe MIME and redirects to private networks', async (t) => {
  assert.throws(() => checkedChatImage(Buffer.from('<svg/>')), /unsupported_mime/);
  const server = createServer((_req, res) => {
    res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const source = publicImageOrigin(
      t,
      `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/redirect`,
    );
    await assert.rejects(downloadChatImage(source, AbortSignal.timeout(2000)), /not_allowed/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
test('HTTP download enforces header/stream limits, redirect budget and cancellation', async (t) => {
  const server = createServer((req, res) => {
    if (req.url === '/length') {
      res.writeHead(200, { 'content-length': 8 * 1024 * 1024 + 1 });
      res.end();
    } else if (req.url === '/stream') {
      res.writeHead(200);
      res.write(Buffer.alloc(8 * 1024 * 1024 + 1));
      res.end();
    } else if (req.url === '/redirect') {
      res.writeHead(302, { location: '/redirect' });
      res.end();
    } else if (req.url === '/stalled') {
      // Keep the response open until the downloader's cancellation closes it.
    } else {
      res.writeHead(503);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const source = publicImageOrigin(
    t,
    `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/`,
  );
  try {
    for (const [path, reason] of [
      ['length', 'too_large'],
      ['stream', 'too_large'],
      ['redirect', 'download_failed'],
      ['unavailable', 'download_failed'],
    ]) {
      await assert.rejects(
        downloadChatImage(source + path, AbortSignal.timeout(2000)),
        new RegExp(reason),
      );
    }
    await assert.rejects(downloadChatImage(source + 'stalled', AbortSignal.timeout(50)), {
      name: 'TimeoutError',
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('HTTPS download cannot redirect to HTTP', async (t) => {
  let requests = 0;
  const server = createServer((_req, res) => {
    requests++;
    res.writeHead(302, { location: 'http://image.example/image.png' });
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const source = publicImageOrigin(
    t,
    `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/`,
    'https:',
  );
  try {
    await assert.rejects(downloadChatImage(source, AbortSignal.timeout(2000)), /not_allowed/);
    assert.equal(requests, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('resolver codec rejects excess fields and noncanonical artifact identities', () => {
  const spec = IMAGE_DELIVERY_OPERATION_SPECS['artifact.image.resolve'];
  assert.deepEqual(spec.decodeInput(REQUEST), REQUEST);
  assert.throws(() => spec.decodeInput({ ...REQUEST, arbitraryRead: true }));
  assert.throws(() => spec.decodeOutput({ status: 'ready', artifactId: '../private' }));
  assert.deepEqual(spec.decodeInput({ ...REQUEST, loadRemote: true }), {
    ...REQUEST,
    loadRemote: true,
  });
  assert.deepEqual(spec.decodeOutput({ status: 'requires_confirmation' }), {
    status: 'requires_confirmation',
  });
  assert.throws(() => spec.decodeInput({ ...REQUEST, loadRemote: 'true' }));
  assert.throws(() => spec.decodeOutput({ status: 'requires_confirmation', source: '/private' }));
});

test('remote capture requires client display authority and application network access, including on retry', async () => {
  let downloads = 0;
  const f = await fixture(undefined, undefined, undefined, async () => {
    downloads++;
    return checkedChatImage(PNG);
  });
  const source = 'https://example.invalid/image.png?data=secret';
  const identity = { ...REQUEST, source };
  f.messages.set(REQUEST.messageId, `![](${source})`);
  try {
    assert.equal(downloads, 0);
    assert.deepEqual(await f.service.resolve(identity), { status: 'requires_confirmation' });
    f.allowRemote(false);
    assert.deepEqual(await f.service.resolve(identity), {
      status: 'failed',
      reason: 'not_allowed',
    });
    assert.deepEqual(await f.service.resolve({ ...identity, loadRemote: true }), {
      status: 'failed',
      reason: 'not_allowed',
    });
    assert.equal(downloads, 0);
    assert.equal(
      (await f.authority.store.listPage(REQUEST.sessionId, { offset: 0, limit: 10 })).total,
      0,
    );
    f.allowRemote(true);
    assert.deepEqual(await f.service.resolve({ ...identity, loadRemote: true }), {
      status: 'pending',
    });
    await f.service.waitForIdle();
    assert.equal(downloads, 1);
    const ready = await f.service.resolve(identity);
    assert.equal(ready.status, 'ready');
    f.allowRemote(false);
    assert.deepEqual(await f.service.resolve({ ...identity, retry: true }), ready);
    assert.equal(downloads, 1, 'saved replay/retry never contacts origin');
    assert.deepEqual(
      await f.service.resolve({
        ...identity,
        source: 'https://example.invalid/forged',
        loadRemote: true,
      }),
      { status: 'unavailable' },
    );
  } finally {
    await f.close();
  }
});

test('remote downloads retry three times, then require an explicit authorized retry', async () => {
  let downloads = 0;
  const f = await fixture(undefined, undefined, undefined, async () => {
    downloads++;
    throw new Error('offline');
  });
  const source = 'https://example.invalid/image.png';
  const identity = { ...REQUEST, source };
  f.messages.set(REQUEST.messageId, `![](${source})`);
  try {
    await f.service.resolve({ ...identity, loadRemote: true });
    await f.service.waitForIdle();
    assert.equal(downloads, 3);
    assert.deepEqual(await f.service.resolve({ ...identity, retry: true }), {
      status: 'requires_confirmation',
    });
    assert.equal(downloads, 3);
    await f.service.resolve({ ...identity, retry: true, loadRemote: true });
    await f.service.waitForIdle();
    assert.equal(downloads, 6);
  } finally {
    await f.close();
  }
});

test('a Markdown parser failure stays in presentation and subsequent images still capture', async () => {
  const f = await fixture(undefined, async () => checkedChatImage(PNG));
  try {
    await f.service.observe(REQUEST.sessionId, {
      type: 'text_complete',
      id: 'deep-text',
      ts: 1,
      turnId: REQUEST.turnId,
      messageId: REQUEST.messageId,
      text: '> '.repeat(5000) + '![](/tmp/image.png)',
    });
    assert.equal(f.presentationErrors.length, 1);
    assert.ok(f.presentationErrors[0] instanceof RangeError);
    assert.deepEqual(f.errors, []);
    await observe(f.service, REQUEST.source);
    await f.service.waitForIdle();
    assert.equal((await f.service.resolve(REQUEST)).status, 'ready');
  } finally {
    await f.close();
  }
});

test('loopback is denied before GET, including redirects from a public origin', async (t) => {
  let hits = 0;
  const target = createServer((_req, res) => {
    hits++;
    res.end(PNG);
  });
  await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
  const targetUrl = `http://127.0.0.1:${(target.address() as import('node:net').AddressInfo).port}/image.png`;
  const origin = createServer((_req, res) => {
    res.writeHead(302, { location: targetUrl });
    res.end();
  });
  await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve));
  try {
    const source = publicImageOrigin(
      t,
      `http://127.0.0.1:${(origin.address() as import('node:net').AddressInfo).port}/redirect`,
    );
    for (const url of [targetUrl, 'http://[::1]:80/image.png'])
      await assert.rejects(downloadChatImage(url, AbortSignal.timeout(1000)), /not_allowed/);
    await assert.rejects(downloadChatImage(source, AbortSignal.timeout(1000)), /not_allowed/);
    assert.equal(hits, 0);
  } finally {
    await Promise.all(
      [target, origin].map(
        (server) => new Promise<void>((resolve) => server.close(() => resolve())),
      ),
    );
  }
});

test('capture, wire and stored metadata share source limits while retaining boundary policies', () => {
  const decode = IMAGE_DELIVERY_OPERATION_SPECS['artifact.image.resolve'].decodeInput;
  const source = '/' + 'a'.repeat(4095);
  assert.deepEqual(chatImageSources(`![x](<${source}>)`), [source]);
  assert.equal(decode({ ...REQUEST, source, messageId: 'm'.repeat(512) }).source, source);
  assert.throws(() => decode({ ...REQUEST, messageId: 'm'.repeat(513) }));
  for (const source of ['', '/' + 'a'.repeat(4096), '/tmp/a\x01.png', '/tmp/a\x7f.png']) {
    assert.equal(isImageDeliverySource(source), false);
    assert.equal(
      isImageDeliveryMetadata({
        messageId: 'm',
        source,
        status: 'ready',
        contentSha256: 'a'.repeat(64),
      }),
      false,
    );
    assert.throws(() => decode({ ...REQUEST, source }));
    assert.deepEqual(chatImageSources(`![x](<${source}>)`), []);
  }
  // Explicit attachment refs belong to UI resolution, not automatic source capture.
  assert.deepEqual(chatImageSources('![x](maka://runtime/attachments/image-1)'), []);
  assert.equal(
    isImageDeliveryMetadata({
      messageId: 'm\x01',
      source: REQUEST.source,
      status: 'ready',
      contentSha256: 'a'.repeat(64),
    }),
    true,
  );
  assert.throws(() => decode({ ...REQUEST, messageId: 'm\x01' }));
  assert.equal(
    chatImageSources(Array.from({ length: 70 }, (_, i) => `![x](/tmp/${i}.png)`).join('\n')).length,
    64,
  );
});

test('local and downloaded invalid image bytes retain identical failure reasons', async () => {
  const f = await fixture();
  try {
    for (const [bytes, reason] of [
      [PNG.subarray(0, 8), 'unsupported_mime'],
      [new Uint8Array(8 * 1024 * 1024 + 1), 'too_large'],
    ] as const) {
      assert.throws(
        () => checkedChatImage(bytes),
        (error: unknown) => error instanceof Error && 'reason' in error && error.reason === reason,
      );
      const source = join(f.root, 'invalid.png');
      await writeFile(source, bytes);
      await assert.rejects(
        createImageFileReader()({ path: source, cwd: f.root }),
        (error: unknown) => error instanceof Error && 'reason' in error && error.reason === reason,
      );
    }
  } finally {
    await f.close();
  }
});

test('a queued retry reports pending instead of replaying the previous failure', async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let fail = true;
  const f = await fixture(undefined, async (_sessionId, path) => {
    if (path !== REQUEST.source) await blocked;
    else if (fail) throw new ImageFileReadError('not_found');
    return checkedChatImage(PNG);
  });
  try {
    await observe(f.service, REQUEST.source);
    await f.service.waitForIdle();
    assert.deepEqual(await f.service.resolve(REQUEST), { status: 'failed', reason: 'not_found' });
    await observe(f.service, '/tmp/blocker-one.png');
    await observe(f.service, '/tmp/blocker-two.png');
    while (f.reads < 3) await new Promise((resolve) => setImmediate(resolve));
    fail = false;
    assert.deepEqual(await f.service.resolve({ ...REQUEST, retry: true }), { status: 'pending' });
    assert.deepEqual(await f.service.resolve(REQUEST), { status: 'pending' });
    release();
    await f.service.waitForIdle();
    assert.equal((await f.service.resolve(REQUEST)).status, 'ready');
    assert.deepEqual(f.errors, []);
  } finally {
    release();
    await f.close();
  }
});

test('executor inline media and Markdown use the same archive, deduplicate and replay after source deletion', async () => {
  let writes = 0;
  const f = await fixture(undefined, undefined, () => {
    writes++;
  });
  const owner = { sessionId: 'session-1', turnId: 'turn-1', messageId: 'message-1' };
  try {
    const input = {
      kind: 'inline' as const,
      mimeType: 'image/svg+xml',
      base64: PNG.toString('base64'),
    };
    const [a, b] = await Promise.all([
      f.service.publish(owner, input),
      f.service.publish(owner, input),
    ]);
    assert.deepEqual(a, b);
    assert.equal(a.kind, 'image');
    assert.equal(writes, 1);
    if (a.kind !== 'image') throw new Error('Image not published');
    assert.equal(a.mimeType, 'image/png'); // Bytes, not the external MIME claim, are authoritative.
    const read = await f.authority.store.readBinaryInSession(owner.sessionId, a.ref.relativePath);
    assert.ok(read.ok);
    if (read.ok) assert.equal(read.base64, PNG.toString('base64'));
    const file = join(f.root, 'drawing.png');
    await writeFile(file, PNG);
    const saved = await f.service.publish(owner, { kind: 'source', source: file });
    assert.equal(saved.kind, 'image');
    if (saved.kind !== 'image') throw new Error('Image not published');
    const imageRead = await f.authority.store.readBinaryInSession(
      owner.sessionId,
      saved.ref.relativePath,
    );
    assert.ok(imageRead.ok);
    if (imageRead.ok) assert.equal(imageRead.mimeType, 'image/png');
    await rm(file);
    const replay = await f.authority.store.readBinaryInSession(
      owner.sessionId,
      saved.ref.relativePath,
    );
    assert.ok(replay.ok);
    if (replay.ok) assert.equal(replay.base64, PNG.toString('base64'));
    assert.equal(f.reads, 1);
    assert.equal(f.leases, 0);
  } finally {
    await f.close();
  }
});

test('executor publication keeps invalid bytes, quota and network failures out of image references', async () => {
  const f = await fixture({ sessionBytes: 10, workspaceBytes: 10 });
  const owner = { sessionId: 'session-1', turnId: 'turn-1', messageId: 'message-1' };
  try {
    const invalid = await f.service.publish(owner, {
      kind: 'inline',
      mimeType: 'image/png',
      base64: Buffer.from('not an image').toString('base64'),
    });
    assert.equal(invalid.kind, 'text');
    const quota = await f.service.publish(owner, {
      kind: 'inline',
      mimeType: 'image/png',
      base64: PNG.toString('base64'),
    });
    assert.deepEqual(quota, { kind: 'text', text: '[Media unavailable: quota_exceeded]' });
    f.allowRemote(false);
    assert.deepEqual(
      await f.service.publish(owner, { kind: 'source', source: 'https://example.com/image.svg' }),
      { kind: 'text', text: '[Media unavailable: not_allowed]' },
    );
    assert.equal(f.leases, 0);
  } finally {
    await f.close();
  }
});

test('separate source publications archive changed bytes in the same turn and keep both references readable', async () => {
  const f = await fixture();
  const owner = { sessionId: 'session-1', turnId: 'turn-1', messageId: 'message-1' };
  const file = join(f.root, 'plot.png');
  const updated = Buffer.concat([PNG, Buffer.from('second version')]);
  try {
    await writeFile(file, PNG);
    const first = await f.service.publish(owner, { kind: 'source', source: file });
    await writeFile(file, updated);
    const second = await f.service.publish(owner, { kind: 'source', source: file });
    assert.equal(first.kind, 'image');
    assert.equal(second.kind, 'image');
    if (first.kind !== 'image' || second.kind !== 'image') throw new Error('Image not published');
    assert.notEqual(first.ref.relativePath, second.ref.relativePath);
    assert.equal(f.reads, 2);
    await rm(file);
    for (const [part, bytes] of [
      [first, PNG],
      [second, updated],
    ] as const) {
      const replay = await f.authority.store.readBinaryInSession(
        owner.sessionId,
        part.ref.relativePath,
      );
      assert.ok(replay.ok);
      if (replay.ok) assert.equal(replay.base64, bytes.toString('base64'));
    }
    assert.equal((await f.service.publish(owner, { kind: 'source', source: file })).kind, 'text');
    assert.equal(f.leases, 0);
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});

test('concurrent source publications return their own archive despite reversed capture order', {
  timeout: 5000,
}, async () => {
  let release!: () => void;
  let started!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const updated = Buffer.concat([PNG, Buffer.from('second version')]);
  let reads = 0;
  const f = await fixture(undefined, async () => {
    if (++reads === 1) {
      started();
      await blocked;
      return checkedChatImage(PNG);
    }
    return checkedChatImage(updated);
  });
  const owner = { sessionId: 'session-1', turnId: 'turn-1', messageId: 'message-1' };
  try {
    const firstPending = f.service.publish(owner, { kind: 'source', source: '/plot.png' });
    await firstStarted;
    const second = await f.service.publish(owner, { kind: 'source', source: '/plot.png' });
    release();
    const first = await firstPending;
    assert.equal(first.kind, 'image');
    assert.equal(second.kind, 'image');
    if (first.kind !== 'image' || second.kind !== 'image') throw new Error('Image not published');
    assert.notEqual(first.ref.relativePath, second.ref.relativePath);
    for (const [part, bytes] of [
      [first, PNG],
      [second, updated],
    ] as const) {
      const saved = await f.authority.store.readBinaryInSession(
        owner.sessionId,
        part.ref.relativePath,
      );
      assert.ok(saved.ok);
      if (saved.ok) assert.equal(saved.base64, bytes.toString('base64'));
    }
    assert.equal(reads, 2);
    assert.equal(f.leases, 0);
    assert.deepEqual(f.errors, []);
  } finally {
    release();
    await f.close();
  }
});

test('startup finishes a durably staged image after the source disappears and without a mounted client', async () => {
  let failCommit = true;
  const f = await fixture(
    undefined,
    async () => checkedChatImage(PNG),
    () => {
      if (failCommit) throw new Error('simulated process interruption before Artifact commit');
    },
  );
  let resumed: ChatImageDeliveryService | undefined;
  try {
    await observe(f.service, REQUEST.source);
    await f.service.waitForIdle();
    assert.equal(f.errors.length, 1);
    const pending = await f.authority.store.listImageDeliveryJobs(Date.now());
    assert.equal(pending.length, 1);
    const staged = await f.authority.store.readImageDeliveryJob(pending[0]!.id);
    assert.deepEqual(Buffer.from(staged!.bytes!), PNG);
    await f.service.close();
    failCommit = false;
    resumed = new ChatImageDeliveryService({
      ...f.ports,
      readLocalImage: async () => {
        assert.fail('recovery must use received bytes, not the deleted source');
      },
    });
    await resumed.start();
    await resumed.waitForIdle();
    const ready = await resumed.resolve(REQUEST);
    assert.equal(ready.status, 'ready');
    assert.deepEqual(await f.authority.store.listImageDeliveryJobs(Date.now()), []);
    if (ready.status === 'ready') {
      const bytes = await f.authority.store.readBinaryInSession(
        REQUEST.sessionId,
        ready.artifactId,
      );
      assert.ok(bytes.ok);
      if (bytes.ok) assert.deepEqual(Buffer.from(bytes.base64, 'base64'), PNG);
    }
  } finally {
    await resumed?.close();
    await f.close();
  }
});

test('startup resumes a queued authorized source without a viewport request', async () => {
  const f = await fixture(undefined, async () => checkedChatImage(PNG));
  try {
    await f.authority.store.putImageDeliveryJob({
      job: {
        ...REQUEST,
        id: 'recovered-image',
        attempts: 0,
        nextAttemptAt: 0,
        loadRemote: false,
      },
    });
    await f.service.start();
    await f.service.waitForIdle();
    assert.equal(f.reads, 1);
    assert.equal((await f.service.resolve(REQUEST)).status, 'ready');
  } finally {
    await f.close();
  }
});

test('Host captures allowed remote images without a viewport and does not fetch redacted or disallowed sources', async () => {
  let downloads = 0;
  const f = await fixture(undefined, undefined, undefined, async () => {
    downloads++;
    return checkedChatImage(PNG);
  });
  try {
    await observe(f.service, 'https://example.invalid/image.png');
    await f.service.waitForIdle();
    assert.equal(downloads, 1);
    assert.equal(
      (await f.service.resolve({ ...REQUEST, source: 'https://example.invalid/image.png' })).status,
      'ready',
    );
    await observe(f.service, 'https://example.invalid/image.png?api_key=secret-value');
    f.allowRemote(false);
    await observe(f.service, 'https://example.invalid/second.png');
    await f.service.waitForIdle();
    assert.equal(downloads, 1);
  } finally {
    await f.close();
  }
});

test('a restarted Host never retries a terminal source failure or resurrects a removed Session', async () => {
  const f = await fixture(undefined, async () => checkedChatImage(PNG));
  try {
    await f.authority.store.putImageDeliveryJob({
      job: {
        ...REQUEST,
        id: 'failed-image',
        attempts: 3,
        nextAttemptAt: 0,
        loadRemote: false,
        failure: 'read_failed',
      },
    });
    await f.service.start();
    await f.service.waitForIdle();
    assert.equal(f.reads, 0);
    await f.authority.store.putImageDeliveryJob({
      job: {
        ...REQUEST,
        id: 'deleted-session-image',
        attempts: 0,
        nextAttemptAt: 0,
        loadRemote: false,
      },
    });
    f.removeSession();
    await f.service.close();
    const resumed = new ChatImageDeliveryService(f.ports);
    try {
      await resumed.start();
      await resumed.waitForIdle();
      assert.equal(f.reads, 0);
      assert.equal(
        await f.authority.store.readImageDeliveryJob('deleted-session-image'),
        undefined,
      );
    } finally {
      await resumed.close();
    }
  } finally {
    await f.close();
  }
});

test('valid originals above the inline preview budget are archived byte-for-byte', async () => {
  const f = await fixture();
  const original = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]);
  const path = join(f.root, 'large-original.png');
  try {
    await writeFile(path, original);
    await observe(f.service, path);
    await f.service.waitForIdle();
    const saved = await f.service.resolve({ ...REQUEST, source: path });
    assert.equal(saved.status, 'ready');
    if (saved.status !== 'ready') return;
    await rm(path);
    const bytes = await f.authority.store.readBinaryInSession(REQUEST.sessionId, saved.artifactId, {
      maxBytes: original.length,
    });
    assert.ok(bytes.ok);
    if (bytes.ok) assert.deepEqual(Buffer.from(bytes.base64, 'base64'), original);
  } finally {
    await f.close();
  }
});

test('inline publication accepts the exact archive byte limit with Base64 padding', async () => {
  const f = await fixture();
  try {
    const bytes = Buffer.alloc(8 * 1024 * 1024);
    PNG.copy(bytes);
    const part = await f.service.publish(REQUEST, {
      kind: 'inline',
      mimeType: 'image/png',
      base64: bytes.toString('base64'),
    });
    assert.equal(part.kind, 'image');
    const tooLarge = await f.service.publish(REQUEST, {
      kind: 'inline',
      mimeType: 'image/png',
      base64: Buffer.alloc(bytes.length + 1).toString('base64'),
    });
    assert.equal(tooLarge.kind, 'text');
  } finally {
    await f.close();
  }
});

for (const crashPoint of ['spooled', 'archived'] as const) {
  test(`startup reconnects ${crashPoint} executor images to the canonical transcript exactly once`, async () => {
    const { createSqliteRuntimeStore } = await import('@maka/storage/sqlite-runtime-store');
    const { seedInvocation } = await import('@maka/runtime/test-only/invocation-fixture');
    const { projectRuntimeEventsToStoredMessages } = await import(
      '@maka/runtime/runtime-event-read-model'
    );
    const { recoverChatImagePublications } = await import('../server/chat-image-recovery.js');
    const f = await fixture(undefined, undefined, () => {
      if (crashPoint === 'spooled') throw new Error('interrupted before Artifact commit');
    });
    const events = createSqliteRuntimeStore(join(f.root, 'recovery-runtime.sqlite'));
    let recovery: ChatImageDeliveryService | undefined;
    try {
      await seedInvocation(events, { ...REQUEST, runId: 'run-1' });
      await f.service.publish(
        { ...REQUEST, runId: 'run-1' },
        { kind: 'inline', mimeType: 'image/png', base64: PNG.toString('base64') },
      );
      await f.service.close();
      recovery = new ChatImageDeliveryService({
        ...f.ports,
        artifacts: { ...f.ports.artifacts, create: f.authority.store.create },
      });
      const input = {
        sessionIds: [REQUEST.sessionId],
        events,
        artifacts: f.authority.store,
        delivery: recovery,
      };
      await recoverChatImagePublications(input);
      await recoverChatImagePublications(input);
      const invocation = await events.readRunInvocation(REQUEST.sessionId, 'run-1');
      assert.ok(invocation);
      const saved = await events.readImmutableRuntimeEvents(REQUEST.sessionId, 'run-1');
      const recovered = saved.filter((event) => event.refs?.artifactId);
      assert.equal(recovered.length, 1);
      assert.equal(recovered[0]?.author, 'host');
      assert.equal(recovered[0]?.modelVisibility, 'hidden');
      const transcript = projectRuntimeEventsToStoredMessages(saved, { invocations: [invocation] });
      const message = transcript.messages.find((message) => message.type === 'assistant');
      assert.ok(message?.type === 'assistant');
      assert.match(message.text, /Recovered image.*interruption/);
      assert.match(message.text, /maka:\/\/runtime\/attachments\//);
      const image = await f.authority.store.readDurableAttachmentBinary({
        sessionId: REQUEST.sessionId,
        artifactId: recovered[0]!.refs!.artifactId!,
      });
      assert.ok(image.ok);
      assert.deepEqual(Buffer.from(image.base64, 'base64'), PNG);
      await events.appendRuntimeEvent(REQUEST.sessionId, 'run-1', {
        id: 'terminal',
        sessionId: REQUEST.sessionId,
        turnId: REQUEST.turnId,
        runId: 'run-1',
        invocationId: invocation.invocationId,
        ts: Date.now(),
        partial: false,
        role: 'system',
        author: 'host',
        status: 'failed',
      });
      await recoverChatImagePublications(input);
      assert.equal(
        (await events.readImmutableRuntimeEvents(REQUEST.sessionId, 'run-1')).length,
        saved.length + 1,
      );
    } finally {
      await recovery?.close();
      events.close();
      await f.close();
    }
  });
}

for (const placement of ['body', 'tool'] as const) {
  test(`startup preserves a committed ${placement} image and registers missing body reception work`, async () => {
    const { createSqliteRuntimeStore } = await import('@maka/storage/sqlite-runtime-store');
    const { seedInvocation } = await import('@maka/runtime/test-only/invocation-fixture');
    const { recoverChatImagePublications } = await import('../server/chat-image-recovery.js');
    const f = await fixture();
    const events = createSqliteRuntimeStore(join(f.root, 'recovery-runtime.sqlite'));
    try {
      await seedInvocation(events, { ...REQUEST, runId: 'run-1' });
      const part = await f.service.publish(
        { ...REQUEST, runId: 'run-1' },
        { kind: 'inline', mimeType: 'image/png', base64: PNG.toString('base64') },
      );
      assert.equal(part.kind, 'image');
      assert.ok(part.kind === 'image');
      const identity = {
        sessionId: REQUEST.sessionId,
        turnId: REQUEST.turnId,
        runId: 'run-1',
        invocationId: 'run-1',
        partial: false,
        ts: 2,
      };
      if (placement === 'tool')
        await events.appendRuntimeEvent(REQUEST.sessionId, 'run-1', {
          ...identity,
          id: 'call',
          role: 'model',
          author: 'agent',
          content: { kind: 'function_call', id: 'draw', name: 'Draw', args: {} },
        });
      await events.appendRuntimeEvent(REQUEST.sessionId, 'run-1', {
        ...identity,
        id: 'published',
        role: placement === 'body' ? 'model' : 'tool',
        author: placement === 'body' ? 'agent' : 'tool',
        content:
          placement === 'body'
            ? {
                kind: 'text',
                text: `![saved](maka://runtime/attachments/${part.ref.relativePath})`,
              }
            : {
                kind: 'function_response',
                id: 'draw',
                name: 'Draw',
                result: { kind: 'content', parts: [part] },
              },
      });
      const path = join(f.root, 'unobserved.png');
      await writeFile(path, PNG);
      await events.appendRuntimeEvent(REQUEST.sessionId, 'run-1', {
        ...identity,
        id: 'unobserved',
        role: 'model',
        author: 'agent',
        content: { kind: 'text', text: `![image](${path})` },
      });
      await recoverChatImagePublications({
        sessionIds: [REQUEST.sessionId],
        events,
        artifacts: f.authority.store,
        delivery: f.service,
      });
      await f.service.waitForIdle();
      const saved = await events.readImmutableRuntimeEvents(REQUEST.sessionId, 'run-1');
      assert.equal(saved.filter((event) => event.id.startsWith('recovered_image_')).length, 0);
      assert.equal(
        (
          await f.authority.store.findImageDelivery(
            REQUEST.sessionId,
            REQUEST.turnId,
            'unobserved',
            path,
          )
        )?.status,
        'ready',
      );
    } finally {
      events.close();
      await f.close();
    }
  });
}

test('queue capacity failure cannot recreate attempts after Session deletion', async () => {
  const { ImageDeliveryCapacityError } = await import('@maka/storage/artifact-stores');
  const f = await fixture();
  const service = new ChatImageDeliveryService({
    ...f.ports,
    artifacts: {
      ...f.ports.artifacts,
      putImageDeliveryJob: async () => {
        f.removeSession();
        await f.authority.store.purgeSessionArtifacts(REQUEST.sessionId);
        throw new ImageDeliveryCapacityError('full');
      },
    },
  });
  try {
    await service.observe(REQUEST.sessionId, {
      type: 'text_complete',
      id: 'body',
      turnId: REQUEST.turnId,
      messageId: REQUEST.messageId,
      ts: 1,
      text: `![image](${REQUEST.source})`,
    });
    assert.equal(
      await f.authority.store.findImageDelivery(
        REQUEST.sessionId,
        REQUEST.turnId,
        REQUEST.messageId,
        REQUEST.source,
      ),
      undefined,
    );
  } finally {
    await service.close();
    await f.close();
  }
});
