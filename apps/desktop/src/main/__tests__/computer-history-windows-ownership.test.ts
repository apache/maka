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
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { mkdir, mkdtemp, rm, stat, symlink } from 'node:fs/promises';
import { connect, type ListenOptions, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { acquireWindowsHistoryOwnership } from '../computer-history-windows-ownership.js';

const identity = {
  dev: 0xabcd1234n,
  ino: 0xfedc_ba98_7654_3210n,
  isDirectory: () => true,
  isSymbolicLink: () => false,
};
const home = 'C:\\History';
const pipe = '\\\\.\\pipe\\maka-history-abcd1234-fedcba9876543210';

test('admission waits for listening and aliases use exact bigint directory identity', async () => {
  const servers: FakeServer[] = [];
  for (const home of ['C:\\History', 'c:\\history', '\\\\?\\C:\\History']) {
    const server = new FakeServer();
    servers.push(server);
    let admitted = false;
    const pending = acquireWindowsHistoryOwnership(home, {
      lstat: async () => identity,
      createServer: () => server.asServer(),
    }).then((owner) => {
      admitted = true;
      return owner;
    });
    await server.listenCalled.promise;
    assert.equal(admitted, false);
    assert.deepEqual(server.options, { path: pipe, exclusive: true });
    server.emit('listening');
    const owner = await pending;
    assert.equal(server.closeCalls, 0);
    const closed = owner.close();
    server.finishClose();
    await closed;
  }
  assert.equal(new Set(servers.map((server) => server.options?.path)).size, 1);
});

test('missing and unavailable identities never open a pipe', async () => {
  const missing = Object.assign(new Error('missing home'), { code: 'ENOENT' });
  for (const value of [
    missing,
    { ...identity, dev: 0n },
    { ...identity, dev: 0x1_0000_0000n },
    { ...identity, ino: 0n },
    { ...identity, ino: -1n },
    { ...identity, ino: 0x1_0000_0000_0000_0000n },
  ]) {
    await assert.rejects(acquireWindowsHistoryOwnership(home, {
      lstat: async () => {
        if (value instanceof Error) throw value;
        return value;
      },
      createServer: () => assert.fail('invalid identity must not bind'),
    }), value === missing ? (error) => error === missing : /directory identity/);
  }
});

test('relative and network paths are rejected before any filesystem access', async () => {
  for (const path of ['History', 'C:History', '\\History', '\\\\server\\share\\History']) {
    await assert.rejects(acquireWindowsHistoryOwnership(path, {
      lstat: async () => assert.fail('invalid path must not be inspected'),
      createServer: () => assert.fail('invalid path must not bind'),
    }), /absolute local drive path/);
  }
});

test('home and every ancestor must be real directories before binding', async () => {
  const path = 'C:\\Users\\Example\\History';
  for (const invalidPath of [path, 'C:\\Users\\Example', 'C:\\Users', 'C:\\']) {
    for (const invalid of [
      { ...identity, isDirectory: () => false },
      { ...identity, isSymbolicLink: () => true },
    ]) {
      await assert.rejects(acquireWindowsHistoryOwnership(path, {
        lstat: async (ancestor) => ancestor === invalidPath ? invalid : identity,
        createServer: () => assert.fail('invalid ancestor must not bind'),
      }), /real directories/);
    }
  }
});

test('bind errors fail closed without retry and clean up before rejection', async () => {
  for (const synchronous of [false, true]) {
    for (const code of ['EADDRINUSE', 'EACCES', 'EMFILE']) {
      const server = new FakeServer();
      const error = Object.assign(new Error(code), { code });
      if (synchronous) server.listenError = error;
      const pending = acquireWindowsHistoryOwnership(home, {
        lstat: async () => identity,
        createServer: () => server.asServer(),
      });
      const rejected = assert.rejects(pending, (actual) => actual === error);
      await server.listenCalled.promise;
      if (!synchronous) server.emit('error', error);
      await server.closeCalled.promise;
      assert.equal(server.listenerCount('listening'), 0);
      assert.equal(server.listenerCount('error'), 1);
      assert.equal(server.closeCalls, 1);
      server.finishClose(Object.assign(new Error('not listening'), {
        code: 'ERR_SERVER_NOT_RUNNING',
      }));
      await rejected;
    }
  }
});

test('directory replacement or recheck failure releases admission before rejecting', async () => {
  const removed = Object.assign(new Error('home removed'), { code: 'ENOENT' });
  for (const replacement of [{ ...identity, ino: identity.ino + 1n }, removed]) {
    const server = new FakeServer();
    let reads = 0;
    const pending = acquireWindowsHistoryOwnership(home, {
      lstat: async (path) => {
        if (path !== home) return identity;
        if (++reads === 1) return identity;
        if (replacement instanceof Error) throw replacement;
        return replacement;
      },
      createServer: () => server.asServer(),
    });
    const rejected = assert.rejects(pending,
      replacement === removed ? (error) => error === removed : /home changed/);
    await server.listenCalled.promise;
    server.emit('listening');
    await server.closeCalled.promise;
    server.finishClose();
    await rejected;
  }
});

test('a junction introduced in an ancestor during binding releases admission', async () => {
  const server = new FakeServer();
  let bound = false;
  const pending = acquireWindowsHistoryOwnership(home, {
    lstat: async (path) => path === 'C:\\' && bound
      ? { ...identity, isSymbolicLink: () => true }
      : identity,
    createServer: () => server.asServer(),
  });
  const rejected = assert.rejects(pending, /real directories/);
  await server.listenCalled.promise;
  bound = true;
  server.emit('listening');
  await server.closeCalled.promise;
  server.finishClose();
  await rejected;
});

test('clients are destroyed without data exchange and close is awaited and idempotent', async () => {
  const { server, owner } = await admittedFixture();
  const socket = Object.assign(new EventEmitter(), {
    destroyCalls: 0,
    destroy() { this.destroyCalls++; return this; },
  });
  server.emit('connection', socket as unknown as Socket);
  assert.equal(socket.destroyCalls, 1);
  socket.emit('error', new Error('client reset'));
  assert.equal(server.closeCalls, 0);
  let finished = false;
  const first = owner.close();
  const second = owner.close();
  assert.equal(first, second);
  first.then(() => { finished = true; });
  await Promise.resolve();
  assert.equal(finished, false);
  assert.equal(server.closeCalls, 1);
  server.finishClose();
  await first;
  assert.equal(finished, true);
});

test('close errors are observable and repeated close does not retry release', async () => {
  const { server, owner } = await admittedFixture();
  const error = new Error('close failed');
  const closed = owner.close();
  const rejected = assert.rejects(closed, (actual) => actual === error);
  server.finishClose(error);
  await rejected;
  assert.equal(owner.close(), closed);
  assert.equal(server.closeCalls, 1);
});

test('a post-admission server error keeps ownership held and is reported at close', async () => {
  const { server, owner } = await admittedFixture();
  const error = Object.assign(new Error('accept failed'), { code: 'EMFILE' });
  server.emit('error', error);
  assert.equal(server.closeCalls, 0);
  const closed = owner.close();
  const rejected = assert.rejects(closed, (actual) => actual === error);
  server.finishClose();
  await rejected;
});

test('an error during the identity recheck cannot deliver a successful owner', async () => {
  const server = new FakeServer();
  const checking = deferred<void>();
  const checked = deferred<typeof identity>();
  let reads = 0;
  const pending = acquireWindowsHistoryOwnership(home, {
    lstat: async (path) => {
      if (path !== home) return identity;
      if (++reads === 1) return identity;
      checking.resolve();
      return checked.promise;
    },
    createServer: () => server.asServer(),
  });
  const error = new Error('server error during admission');
  const rejected = assert.rejects(pending, (actual) => actual === error);
  await server.listenCalled.promise;
  server.emit('listening');
  await checking.promise;
  server.emit('error', error);
  checked.resolve(identity);
  await server.closeCalled.promise;
  server.finishClose();
  await rejected;
});

test('Windows kernel exclusion survives client traffic, aliases and an unrelated child crash', {
  skip: process.platform !== 'win32',
  timeout: 20_000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-history-ownership-'));
  let owner: Awaited<ReturnType<typeof acquireWindowsHistoryOwnership>> | undefined;
  t.after(async () => {
    try { await owner?.close(); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  const home = join(root, 'History');
  const alias = join(root, 'Alias');
  await mkdir(home);
  await symlink(home, alias, 'junction');
  owner = await acquireWindowsHistoryOwnership(home);
  await assert.rejects(acquireWindowsHistoryOwnership(alias), /real directories/);
  for (const path of [home, join(root, 'history')]) {
    await assert.rejects(acquireWindowsHistoryOwnership(path), { code: 'EADDRINUSE' });
  }
  const info = await stat(home, { bigint: true });
  const socket = connect(`\\\\.\\pipe\\maka-history-${info.dev.toString(16)}-${info.ino.toString(16)}`);
  const disconnected = once(socket, 'close');
  await disconnected;
  await assert.rejects(acquireWindowsHistoryOwnership(home), { code: 'EADDRINUSE' });

  const child = spawn(process.execPath, ['-e', "process.send('ready'); setInterval(() => {}, 1000)"], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  });
  await Promise.race([
    once(child, 'message').then(([message]) => assert.equal(message, 'ready')),
    exited.then(() => { throw new Error('Child exited before crash test'); }),
  ]);
  child.kill('SIGKILL');
  await exited;
  await assert.rejects(acquireWindowsHistoryOwnership(home), { code: 'EADDRINUSE' });
  await owner.close();
  const successor = await acquireWindowsHistoryOwnership(join(root, 'history'));
  await successor.close();
});

test('Windows kernel releases admission after the owning Node process is killed', {
  skip: process.platform !== 'win32',
  timeout: 20_000,
}, async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'maka-history-owner-crash-'));
  const moduleUrl = new URL('../computer-history-windows-ownership.js', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { acquireWindowsHistoryOwnership } from ${JSON.stringify(moduleUrl)};
    const owner = await acquireWindowsHistoryOwnership(process.argv[1]);
    process.send('owned');
    process.on('disconnect', () => owner.close());
  `, home], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    try { await exited; }
    finally { await rm(home, { recursive: true, force: true }); }
  });
  const ready = once(child, 'message');
  await Promise.race([
    ready.then(([message]) => assert.equal(message, 'owned')),
    exited.then(() => { throw new Error('Owner exited before admission'); }),
  ]);
  await assert.rejects(acquireWindowsHistoryOwnership(home), { code: 'EADDRINUSE' });
  child.kill('SIGKILL');
  await exited;
  const successor = await acquireWindowsHistoryOwnership(home);
  await successor.close();
});

async function admittedFixture() {
  const server = new FakeServer();
  const pending = acquireWindowsHistoryOwnership(home, {
    lstat: async () => identity,
    createServer: () => server.asServer(),
  });
  await server.listenCalled.promise;
  server.emit('listening');
  return { server, owner: await pending };
}

class FakeServer extends EventEmitter {
  readonly listenCalled = deferred<void>();
  readonly closeCalled = deferred<void>();
  options?: ListenOptions;
  listenError?: Error;
  closeCalls = 0;
  #closeCallback?: (error?: Error) => void;

  asServer(): Server { return this as unknown as Server; }

  listen(options: ListenOptions): this {
    this.options = options;
    this.listenCalled.resolve();
    if (this.listenError) throw this.listenError;
    return this;
  }

  close(callback: (error?: Error) => void): this {
    this.closeCalls++;
    this.#closeCallback = callback;
    this.closeCalled.resolve();
    return this;
  }

  finishClose(error?: Error): void {
    assert.ok(this.#closeCallback);
    this.#closeCallback(error);
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
