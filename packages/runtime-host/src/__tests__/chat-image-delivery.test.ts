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
import { createProxiedFetchTransport } from '@maka/runtime/network/scoped-fetch-transport';
import { IMAGE_DELIVERY_OPERATION_SPECS } from '../protocol/image-delivery.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';
import { createHostExecutionArtifactServices } from '../server/execution-artifacts.js';
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
  let present = true;
  const service = new ChatImageDeliveryService({
    artifacts: {
      create: async (input) => {
        beforeCreate?.(input);
        return authority.store.create(input);
      },
      findImageDelivery: authority.store.findImageDelivery,
      setImageDeliveryAttempt: authority.store.setImageDeliveryAttempt,
    },
    admission: new SessionAdmissionGate(),
    limits,
    sourceReadTimeoutMs: 1000,
    canLoadRemote: async () => remoteAllowed,
    download: download ?? downloadChatImage,
    isPresent: async () => present,
    readMessage: async (i) => messages.get(i.messageId),
    readLocalImage: async (sessionId, path, signal) => {
      reads++;
      if (readLocalImage) return readLocalImage(sessionId, path, signal);
      return checkedChatImage(await readFile(path));
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
  });
  return {
    root,
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
    observe(f.service, '/tmp/blocked-1.png');
    observe(f.service, '/tmp/blocked-2.png', 'session-1', 'message-2');
    while (f.reads < 2) await new Promise((resolve) => setImmediate(resolve));
    await f.service.close();
    assert.equal(f.leases, 0);
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});
test('a stalled local source expires within its read budget and can be retried', {
  timeout: 15000,
}, async () => {
  let reads = 0;
  const f = await fixture(undefined, async () => {
    if (++reads === 1) return new Promise(() => {});
    return checkedChatImage(PNG);
  });
  try {
    observe(f.service, REQUEST.source);
    await f.service.waitForIdle();
    assert.deepEqual(await f.service.resolve(REQUEST), { status: 'failed', reason: 'read_failed' });
    assert.equal(f.leases, 0);
    assert.equal((await f.service.resolve({ ...REQUEST, retry: true })).status, 'pending');
    await f.service.waitForIdle();
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
  service.observe(sessionId, {
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
test('automatically saves a local delivery without any UI request; deletion and Host restart do not break replay', async () => {
  const f = await fixture();
  try {
    const source = join(f.root, 'original.png');
    await writeFile(source, PNG);
    observe(f.service, source);
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
test('encoded local Markdown images are archived under the original source and replay after deletion', async () => {
  const reader = createImageFileReader();
  const f = await fixture(undefined, (_session, path, abortSignal) =>
    reader({ path, cwd: f.root, abortSignal }),
  );
  try {
    const directory = join(f.root, 'My Project');
    await mkdir(directory);
    for (const name of ['screen shot.png', '截图.png', 'literal%20name.png']) {
      const path = join(directory, name);
      const source = `${f.root}/My%20Project/${encodeURIComponent(name)}`;
      await writeFile(path, PNG);
      observe(f.service, source);
      await f.service.waitForIdle();
      await rm(path);
      const result = await f.service.resolve({ ...REQUEST, source });
      assert.equal(result.status, 'ready', source);
      if (result.status !== 'ready') continue;
      const bytes = await f.authority.store.readBinaryInSession(
        REQUEST.sessionId,
        result.artifactId,
      );
      assert.equal(bytes.ok, true);
      if (bytes.ok) assert.equal(bytes.base64, PNG.toString('base64'));
    }
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});

test('encoded project roots are retried through the same workspace boundary', async () => {
  const reader = createImageFileReader();
  const paths: string[] = [];
  const f = await fixture(undefined, (_session, path, abortSignal) => {
    paths.push(path);
    return reader({ path, cwd: join(f.root, 'My Project 中文'), abortSignal });
  });
  try {
    const directory = join(f.root, 'My Project 中文');
    await mkdir(directory);
    const path = join(directory, 'image.png');
    await writeFile(path, PNG);
    const source = `${f.root}/${encodeURIComponent('My Project 中文')}/image.png`;
    observe(f.service, source);
    await f.service.waitForIdle();
    assert.equal((await f.service.resolve({ ...REQUEST, source })).status, 'ready');
    assert.deepEqual(paths, [source, path]);
    await rm(path);
    assert.equal((await f.service.resolve({ ...REQUEST, source })).status, 'ready');
    assert.equal(paths.length, 2);
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});

test('decoding a denied source cannot grant access outside the Read boundary', async () => {
  const reader = createImageFileReader();
  const paths: string[] = [];
  const f = await fixture(undefined, (_session, path, abortSignal) => {
    paths.push(path);
    return reader({ path, cwd: join(f.root, 'workspace'), abortSignal });
  });
  try {
    await mkdir(join(f.root, 'workspace'));
    const path = join(f.root, 'private image.png');
    await writeFile(path, PNG);
    const source = `${f.root}/private%20image.png`;
    observe(f.service, source);
    await f.service.waitForIdle();
    assert.deepEqual(await f.service.resolve({ ...REQUEST, source }), {
      status: 'failed',
      reason: 'not_allowed',
    });
    assert.deepEqual(paths, [source, path]);
    assert.deepEqual(f.errors, []);
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
        observe(f.service, source);
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

test('encoded local fallback preserves validation and non-path read failures', async () => {
  for (const reason of ['too_large', 'unsupported_mime', 'read_failed'] as const) {
    const paths: string[] = [];
    const f = await fixture(undefined, async (_session, path) => {
      paths.push(path);
      throw new ImageFileReadError(reason);
    });
    try {
      const source = '/tmp/My%20Project/image.png';
      observe(f.service, source);
      await f.service.waitForIdle();
      assert.deepEqual(await f.service.resolve({ ...REQUEST, source }), {
        status: 'failed',
        reason,
      });
      assert.deepEqual(paths, [source]);
      assert.deepEqual(f.errors, []);
    } finally {
      await f.close();
    }
  }
});

test('decoded local images still pass through the Read workspace boundary', async () => {
  const reader = createImageFileReader();
  const paths: string[] = [];
  const f = await fixture(undefined, (_session, path, abortSignal) => {
    paths.push(path);
    return reader({ path, cwd: join(f.root, 'workspace'), abortSignal });
  });
  try {
    await mkdir(join(f.root, 'workspace'));
    await writeFile(join(f.root, 'private image.png'), PNG);
    const source = '%2e%2e/private%20image.png';
    observe(f.service, source);
    await f.service.waitForIdle();
    assert.deepEqual(await f.service.resolve({ ...REQUEST, source }), {
      status: 'failed',
      reason: 'not_allowed',
    });
    assert.deepEqual(paths, [source, '../private image.png']);
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});

test('missing encoded sources never double-decode file URLs or retry invalid escapes', async () => {
  for (const source of [
    'file:///tmp/missing%2520image.png',
    '/tmp/missing%.png',
    '/tmp/missing%E4.png',
    '/tmp/missing%00.png',
  ]) {
    const paths: string[] = [];
    const f = await fixture(undefined, async (_session, path) => {
      paths.push(path);
      throw new ImageFileReadError('not_found');
    });
    try {
      observe(f.service, source);
      await f.service.waitForIdle();
      assert.deepEqual(await f.service.resolve({ ...REQUEST, source }), {
        status: 'failed',
        reason: 'not_found',
      });
      assert.equal(paths.length, 1, source);
      assert.deepEqual(f.errors, []);
    } finally {
      await f.close();
    }
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
    observe(f.service, source);
    await f.service.waitForIdle();
    assert.equal(requests, 0);
    assert.deepEqual(await f.service.resolve({ ...REQUEST, source }), {
      status: 'requires_confirmation',
    });
    assert.equal(
      (await f.service.resolve({ ...REQUEST, source, loadRemote: true })).status,
      'pending',
    );
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
    observe(f.service, source);
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
    observe(f.service, source);
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
      observe(f.service, REQUEST.source);
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
    observe(f.service, REQUEST.source);
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

test('a conversation copied during capture resumes and cleans its copied pending record', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await fixture(undefined, async () => {
    await gate;
    return checkedChatImage(PNG);
  });
  try {
    observe(f.service, REQUEST.source);
    while (!f.reads) await new Promise<void>((resolve) => setImmediate(resolve));
    await f.authority.store.copyConversationArtifacts({
      sourceSessionId: REQUEST.sessionId,
      targetSessionId: 'session-copy',
      turnIds: [REQUEST.turnId],
    });
    const copied = { ...REQUEST, sessionId: 'session-copy' };
    assert.equal((await f.service.resolve(copied)).status, 'pending');
    release();
    await f.service.waitForIdle();
    for (const sessionId of [REQUEST.sessionId, copied.sessionId]) {
      const page = await f.authority.store.listPage(sessionId, { offset: 0, limit: 10 });
      assert.equal(page.total, 1);
      assert.equal(page.records[0]?.imageDelivery?.status, 'ready');
      const bytes = await f.authority.store.readBinaryInSession(sessionId, page.records[0]!.id);
      assert.ok(bytes.ok);
      if (bytes.ok) assert.equal(bytes.base64, PNG.toString('base64'));
    }
    assert.deepEqual(f.errors, []);
  } finally {
    release();
    await f.close();
  }
});
test('quota admission is atomic under concurrent jobs and identical content shares bytes across sessions', async () => {
  const f = await fixture({ sessionBytes: PNG.length, workspaceBytes: PNG.length });
  try {
    const source = join(f.root, 'same.png');
    await writeFile(source, PNG);
    observe(f.service, source);
    observe(f.service, source, 'session-2');
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
    observe(f.service, different, 'session-1', 'message-2');
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
    observe(f.service, source);
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
test('source readers reject oversized payloads, unsafe MIME and redirects to private networks', async (t) => {
  assert.throws(() => checkedChatImage(Buffer.alloc(2 * 1024 * 1024 + 1)), /too_large/);
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
      res.writeHead(200, { 'content-length': 2 * 1024 * 1024 + 1 });
      res.end();
    } else if (req.url === '/stream') {
      res.writeHead(200);
      res.write(Buffer.alloc(2 * 1024 * 1024 + 1));
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

test('DNS answers containing any private address are denied before a request', async (t) => {
  const answers = [
    { address: '93.184.216.34', family: 4 },
    { address: '127.0.0.1', family: 4 },
  ];
  const lookup = t.mock.method(dns, 'lookup', async () => answers);
  const request = t.mock.method(net, 'connect', () => {
    assert.fail('unsafe DNS must not reach transport');
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      downloadChatImage('http://image.example/image.png', AbortSignal.timeout(1000)),
      /not_allowed/,
    );
    assert.equal(lookup.mock.callCount(), 1);
    assert.equal(request.mock.callCount(), 0);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('literal benchmark addresses, local names and mixed private answers are denied', async (t) => {
  let answers = [{ address: '93.184.216.34', family: 4 }];
  t.mock.method(dns, 'lookup', async () => answers);
  const request = t.mock.method(net, 'connect', () =>
    assert.fail('blocked source reached transport'),
  );
  syncBuiltinESMExports();
  try {
    for (const source of [
      'http://198.18.0.2/a.png',
      'http://198.19.0.2/a.png',
      'http://[2001:2::6]/a.png',
      'http://localhost/a.png',
      'http://localhost./a.png',
      'http://app.localhost/a.png',
      'http://router.lan/a.png',
      'http://server.local/a.png',
      'http://metadata.google.internal/a.png',
      'http://metadata.goog/a.png',
    ]) {
      await assert.rejects(downloadChatImage(source, AbortSignal.timeout(1000)), /not_allowed/);
    }
    for (const address of ['127.0.0.1', '192.168.1.2', '169.254.169.254', '::1']) {
      answers = [
        { address: '93.184.216.34', family: 4 },
        { address, family: address.includes(':') ? 6 : 4 },
      ];
      await assert.rejects(
        downloadChatImage('http://image.example/a.png', AbortSignal.timeout(1000)),
        /not_allowed/,
      );
    }
    assert.equal(request.mock.callCount(), 0);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('a configured HTTP proxy receives the original hostname and checks redirects and limits', async (t) => {
  const tunnels: string[] = [];
  const imageRequests: string[] = [];
  const server = createServer((request, response) => {
    imageRequests.push(
      `${request.method} ${request.url} HTTP/1.1\r\n${request.rawHeaders.map((value, index) => (index % 2 ? `${value}\r\n` : `${value}: `)).join('')}`,
    );
    const path = new URL(request.url!, 'http://image.example').pathname;
    if (path === '/redirect')
      response.writeHead(302, { location: 'http://127.0.0.1/private' }).end();
    else if (path === '/length') response.writeHead(200, { 'content-length': 2097153 }).end();
    else if (path === '/stream') {
      response.writeHead(200);
      response.write(Buffer.alloc(2097153));
      response.end();
    } else if (path === '/loop') response.writeHead(302, { location: '/loop' }).end();
    else if (path === '/stalled') {
      /* Abort must close this unfinished response. */
    } else response.writeHead(200, { 'content-type': 'image/png', connection: 'close' }).end(PNG);
  });
  server.on('connect', (request, socket) => {
    tunnels.push(request.url!);
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    let data = '';
    socket.on('data', (chunk) => {
      data += chunk.toString();
      if (!data.includes('\r\n\r\n')) return;
      imageRequests.push(data);
      const path = data.split(' ')[1];
      if (path === '/redirect')
        socket.end(
          'HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1/private\r\nContent-Length: 0\r\n\r\n',
        );
      else if (path === '/length') socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2097153\r\n\r\n');
      else if (path === '/stream')
        socket.end(
          Buffer.concat([
            Buffer.from('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n200001\r\n'),
            Buffer.alloc(2097153),
            Buffer.from('\r\n0\r\n\r\n'),
          ]),
        );
      else if (path === '/loop')
        socket.end('HTTP/1.1 302 Found\r\nLocation: /loop\r\nContent-Length: 0\r\n\r\n');
      else if (path === '/stalled') {
        /* The caller cancels this tunnel. */
      } else
        socket.end(
          Buffer.concat([
            Buffer.from(
              `HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: ${PNG.length}\r\nConnection: close\r\n\r\n`,
            ),
            PNG,
          ]),
        );
      data = '';
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const lookup = t.mock.method(dns, 'lookup', async () => {
    throw Object.assign(new Error('local DNS is unavailable'), { code: 'ENOTFOUND' });
  });
  syncBuiltinESMExports();
  const transport = createProxiedFetchTransport({
    enabled: true,
    type: 'http',
    host: '127.0.0.1',
    port: (server.address() as import('node:net').AddressInfo).port,
    bypassList: [],
  });
  try {
    const options = { fetch: transport.fetch };
    assert.deepEqual(
      await downloadChatImage('http://image.example/image.png', AbortSignal.timeout(2000), options),
      checkedChatImage(PNG),
    );
    await assert.rejects(
      downloadChatImage('http://image.example/redirect', AbortSignal.timeout(2000), options),
      /not_allowed/,
    );
    await assert.rejects(
      downloadChatImage('http://image.example/length', AbortSignal.timeout(2000), options),
      /too_large/,
    );
    await assert.rejects(
      downloadChatImage('http://image.example/stream', AbortSignal.timeout(2000), options),
      /too_large/,
    );
    await assert.rejects(
      downloadChatImage('http://image.example/loop', AbortSignal.timeout(2000), options),
      /download_failed/,
    );
    await assert.rejects(
      downloadChatImage('http://image.example/stalled', AbortSignal.timeout(50), options),
      { name: 'TimeoutError' },
    );
    assert.equal(lookup.mock.callCount(), 0);
    assert.ok(tunnels.every((target) => target === 'image.example:80'));
    assert.equal(imageRequests.length, 9);
    assert.ok(imageRequests.every((request) => /host: image\.example/i.test(request)));
    assert.ok(
      imageRequests.every(
        (request) => !/93\.184\.216\.34|cookie:|authorization:|referer:/i.test(request),
      ),
    );
  } finally {
    await transport.close();
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('proxy bypass preserves the checked and pinned direct image connection', async (t) => {
  const server = createServer((_req, res) => res.end(PNG));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const transport = createProxiedFetchTransport({
    enabled: true,
    type: 'http',
    host: '127.0.0.1',
    port: 1,
    bypassList: ['image.example'],
  });
  try {
    const local = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/image.png`;
    const source = publicImageOrigin(t, local, 'http:');
    assert.deepEqual(
      await downloadChatImage(source, AbortSignal.timeout(2000), { fetch: transport.fetch }),
      checkedChatImage(PNG),
    );
  } finally {
    await transport.close();
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
    observe(f.service, source);
    await f.service.waitForIdle();
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

test('failed remote downloads issue one request and require a client retry', async () => {
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
    assert.equal(downloads, 1);
    assert.deepEqual(await f.service.resolve({ ...identity, retry: true }), {
      status: 'requires_confirmation',
    });
    assert.equal(downloads, 1);
    await f.service.resolve({ ...identity, retry: true, loadRemote: true });
    await f.service.waitForIdle();
    assert.equal(downloads, 2);
  } finally {
    await f.close();
  }
});

test('unsettled reference destinations never open half-written local paths', async () => {
  const f = await fixture(undefined, async () => checkedChatImage(PNG));
  try {
    f.service.observe(REQUEST.sessionId, {
      type: 'text_delta',
      id: 'delta',
      ts: 1,
      turnId: REQUEST.turnId,
      messageId: REQUEST.messageId,
      text: '![image][ref]\n\n[ref]: /tmp/partial',
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(f.reads, 0);
    observe(f.service, '/tmp/partial-complete.png');
    await f.service.waitForIdle();
    assert.equal(f.reads, 1);
  } finally {
    await f.close();
  }
});

test('a Markdown parser failure stays in presentation and subsequent images still capture', async () => {
  const f = await fixture(undefined, async () => checkedChatImage(PNG));
  try {
    f.service.observe(REQUEST.sessionId, {
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
    observe(f.service, REQUEST.source);
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
    // An untyped caller passing the former fixture option cannot grant access.
    await assert.rejects(
      Reflect.apply(downloadChatImage, undefined, [
        targetUrl,
        AbortSignal.timeout(1000),
        { loopbackOrigin: new URL(targetUrl).origin },
      ]),
      /not_allowed/,
    );
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

test('completed turns release unfinished stream slots without archiving partial messages', async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 40; i++) {
      f.service.observe('session-1', {
        type: 'text_delta',
        id: `delta-${i}`,
        turnId: `turn-${i}`,
        ts: 1,
        messageId: `partial-${i}`,
        text: '![partial](/tmp/missing.png)',
      });
      f.service.observe('session-1', {
        type: 'complete',
        id: `complete-${i}`,
        turnId: `turn-${i}`,
        ts: 2,
        stopReason: 'end_turn',
      });
    }
    const source = join(f.root, 'final.png');
    await writeFile(source, PNG);
    observe(f.service, source);
    await f.service.waitForIdle();
    assert.equal(f.reads, 1);
    assert.equal((await f.service.resolve({ ...REQUEST, source })).status, 'ready');
  } finally {
    await f.close();
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
    assert.equal(isImageDeliveryMetadata({ messageId: 'm', source, status: 'pending' }), false);
    assert.throws(() => decode({ ...REQUEST, source }));
    assert.deepEqual(chatImageSources(`![x](<${source}>)`), []);
  }
  // Explicit attachment refs belong to UI resolution, not automatic source capture.
  assert.deepEqual(chatImageSources('![x](maka://runtime/attachments/image-1)'), []);
  assert.equal(
    isImageDeliveryMetadata({ messageId: 'm\x01', source: REQUEST.source, status: 'pending' }),
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
      [new Uint8Array(2 * 1024 * 1024 + 1), 'too_large'],
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

test('automatic capture and PublishImage share content quota without merging their identities', async () => {
  const limits = { sessionBytes: PNG.length, workspaceBytes: PNG.length };
  const f = await fixture(limits, async () => checkedChatImage(PNG));
  try {
    observe(f.service, REQUEST.source);
    await f.service.waitForIdle();
    const automatic = await f.service.resolve(REQUEST);
    assert.equal(automatic.status, 'ready');
    if (automatic.status !== 'ready') return;
    const services = createHostExecutionArtifactServices({
      artifacts: f.authority.store,
      sessionAdmission: new SessionAdmissionGate(),
      sessions: { probeSessionRemoval: async () => ({ kind: 'present' }) },
      imageArchiveLimits: limits,
      requestDrain: () => assert.fail('shared bytes must not exceed quota or drain'),
    });
    const explicit = await services.publishImage({
      sessionId: REQUEST.sessionId,
      turnId: REQUEST.turnId,
      toolCallId: 'publish-call',
      name: 'published.png',
      bytes: PNG,
      mimeType: 'image/png',
    });
    assert.notEqual(explicit.relativePath, automatic.artifactId);
    const captured = (await f.authority.store.getInSession(REQUEST.sessionId, automatic.artifactId))
      .record!;
    const published = (
      await f.authority.store.getInSession(REQUEST.sessionId, explicit.relativePath)
    ).record!;
    assert.equal(captured.imageDelivery?.contentSha256, published.imageDelivery?.contentSha256);
    assert.equal(captured.imageDelivery?.source, REQUEST.source);
    assert.equal(published.imageDelivery?.source, 'published:publish-call');
    assert.equal(published.imageDelivery?.messageId, 'publish-call');
    assert.equal(published.summary, 'Published chat image');
    assert.equal(
      (await stat(join(f.root, 'artifacts', captured.relativePath))).ino,
      (await stat(join(f.root, 'artifacts', published.relativePath))).ino,
    );
    const page = await f.authority.store.listPage(REQUEST.sessionId, { offset: 0, limit: 10 });
    assert.equal(page.total, 2);
    assert.ok(page.records.every((record) => record.imageDelivery?.status === 'ready'));
    assert.deepEqual(f.errors, []);
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
    else if (fail) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return checkedChatImage(PNG);
  });
  try {
    observe(f.service, REQUEST.source);
    await f.service.waitForIdle();
    assert.deepEqual(await f.service.resolve(REQUEST), { status: 'failed', reason: 'not_found' });
    observe(f.service, '/tmp/blocker-one.png');
    observe(f.service, '/tmp/blocker-two.png');
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
