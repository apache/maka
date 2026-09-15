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
import type { ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { crc32, deflateSync } from 'node:zlib';
import test, { type TestContext } from 'node:test';
import { ComputerHistoryApplications } from '../computer-history-applications.js';

const A = 'com.example.Editor';
const B = 'com.example.Browser';
const C = 'com.example.Terminal';
const PNG = png();
const metadata = (bundleIdentifier: string, iconDataUrl: string | null = PNG) => ({
  bundleIdentifier, name: iconDataUrl ? `App ${bundleIdentifier}` : bundleIdentifier, iconDataUrl,
});

test('validates request limits and exact bundle identifiers before spawning', async (t) => {
  const { resolver, helper } = fixture(t);
  for (const ids of [
    null, undefined, 'com.example.Editor', {}, [null], [1], [''], ['Safari'],
    ['../Applications/Safari.app'], ['com.example.app --capture-text'], ['com..app'],
    [' com.example.app'], ['com.example.app\n'], ['com.example.app/'], ['com.' + 'x'.repeat(253)],
    Array.from({ length: 33 }, () => A), Array(1),
  ]) {
    await assert.rejects(resolver.applications(ids as string[]), /Invalid.*identifiers/);
  }
  assert.deepEqual(await resolver.applications([]), []);
  assert.equal(helper.calls.length, 0);
});

test('duplicates, same-turn rows and overlapping requests coalesce into one bounded batch', async (t) => {
  const { resolver, helper } = fixture(t);
  const first = resolver.applications([A, A, B]);
  const second = resolver.applications([B, C]);
  const call = await helper.next();
  assert.deepEqual(call.ids, [A, B, C]);
  const joined = resolver.applications([C, A]);
  call.reply([metadata(C), metadata(B), metadata(A)]);
  assert.deepEqual(await first, [metadata(A), metadata(B)]);
  assert.deepEqual(await second, [metadata(B), metadata(C)]);
  assert.deepEqual(await joined, [metadata(C), metadata(A)]);
  assert.equal(helper.calls.length, 1);
  const cached = await resolver.applications([A]);
  Object.assign(cached[0]!, { name: 'mutated', iconDataUrl: 'invalid' });
  assert.deepEqual(await resolver.applications([A]), [metadata(A)]);
  assert.equal(helper.calls.length, 1);
});

test('positive cache expires at five minutes and negative cache at thirty seconds', async (t) => {
  let now = 1_000;
  const { resolver, helper } = fixture(t, { now: () => now });
  const initial = resolver.applications([A, B]);
  (await helper.next()).reply([metadata(A), metadata(B, null)]);
  await initial;
  now += 29_999;
  assert.deepEqual(await resolver.applications([A, B]), [metadata(A), metadata(B, null)]);
  assert.equal(helper.calls.length, 1);
  now++;
  const negativeRefresh = resolver.applications([A, B]);
  const negative = await helper.next();
  assert.deepEqual(negative.ids, [B]);
  negative.reply([metadata(B)]);
  await negativeRefresh;
  now = 301_000;
  const positiveRefresh = resolver.applications([A, B]);
  const positive = await helper.next();
  assert.deepEqual(positive.ids, [A]);
  positive.reply([metadata(A)]);
  await positiveRefresh;
});

test('cache retains at most 256 recently used applications', async (t) => {
  const { resolver, helper } = fixture(t);
  const ids = Array.from({ length: 256 }, (_, index) => `com.example.app${index}`);
  for (let offset = 0; offset < ids.length; offset += 32) {
    const request = resolver.applications(ids.slice(offset, offset + 32));
    const call = await helper.next();
    call.reply(call.ids.map((id) => metadata(id)));
    await request;
  }
  await resolver.applications([ids[0]!]);
  const newRequest = resolver.applications([C]);
  (await helper.next()).reply([metadata(C)]);
  await newRequest;
  await resolver.applications([ids[0]!]);
  assert.equal(helper.calls.length, 9);
  const evicted = resolver.applications([ids[1]!]);
  const call = await helper.next();
  assert.deepEqual(call.ids, [ids[1]]);
  call.reply([metadata(ids[1]!)]);
  await evicted;
});

test('in-flight IDs are capped and helper execution is serial with batches of 32', async (t) => {
  const { resolver, helper } = fixture(t);
  const requests = Array.from({ length: 8 }, (_, batch) => resolver.applications(
    Array.from({ length: 32 }, (_, index) => `com.example.app${batch * 32 + index}`),
  ));
  await assert.rejects(resolver.applications([C]), /busy/);
  for (let batch = 0; batch < 8; batch++) {
    const call = await helper.next();
    assert.equal(helper.calls.length, batch + 1);
    assert.equal(call.ids.length, 32);
    call.reply(call.ids.map((id) => metadata(id)));
  }
  const result = await Promise.all(requests);
  assert.ok(result.every((applications) => applications.length === 32));
});

test('unsupported platforms, foreign-platform IDs and unavailable helpers return exact-ID fallbacks without spawning', async (t) => {
  for (const options of [
    { platform: 'linux' as const },
    { platform: 'win32' as const },
    { helperPath: '/maka-fixture-missing/application-helper' },
  ]) {
    const { resolver, helper } = fixture(t, options);
    assert.deepEqual(await resolver.applications([A, B]), [metadata(A, null), metadata(B, null)]);
    assert.equal(helper.calls.length, 0);
  }
});

test('Windows resolves only canonical executable IDs and coalesces native icon requests', async (t) => {
  const { resolver, helper } = fixture(t, { platform: 'win32' });
  const id = 'win32.msedge';
  const pending = resolver.applications([id, A, 'win32.msedge.exe']);
  const joined = resolver.applications([id]);
  const call = await helper.next();
  assert.deepEqual(call.ids, [id]);
  call.reply([{ ...metadata(id), name: 'Microsoft Edge' }]);
  const [values, same] = await Promise.all([pending, joined]);
  assert.deepEqual(values, [
    { ...metadata(id), name: 'Microsoft Edge' }, metadata(A, null), metadata('win32.msedge.exe', null),
  ]);
  assert.deepEqual(same, [values[0]]);
  assert.deepEqual(await resolver.applications([id]), same);
  assert.equal(helper.calls.length, 1);
  const nativeIds = ['win32._fixture_app', 'win32.editor.2026'];
  const extended = resolver.applications(nativeIds);
  const native = await helper.next();
  assert.deepEqual(native.ids, nativeIds);
  native.reply(nativeIds.map((id) => metadata(id)));
  assert.deepEqual(await extended, nativeIds.map((id) => metadata(id)));
  const { resolver: mac, helper: macHelper } = fixture(t);
  assert.deepEqual(await mac.applications(nativeIds), nativeIds.map((id) => metadata(id, null)));
  assert.equal(macHelper.calls.length, 0);
  await assert.rejects(mac.applications(['com._fixture']), /Invalid.*identifiers/);
});

test('rejects missing, duplicate, unsolicited and path-bearing helper records without caching them', async (t) => {
  const { resolver, helper } = fixture(t);
  for (const response of [
    null, {}, [], [metadata(B)], [metadata(A), metadata(A)],
    [{ ...metadata(A), path: '/Applications/Private.app' }],
    [{ ...metadata(A), name: '' }], [{ ...metadata(A), name: '\u0000private' }],
    [{ ...metadata(A), name: 'x'.repeat(513) }],
    [{ ...metadata(A), name: '\u4e2d'.repeat(171) }],
    [{ ...metadata(A), iconDataUrl: undefined }],
    [{ ...metadata(A), iconDataUrl: 'file:///private/icon.png' }],
    [{ ...metadata(A), iconDataUrl: 'https://example.com/icon.png' }],
    [{ ...metadata(A), iconDataUrl: 'data:image/svg+xml,<svg/>' }],
  ]) {
    const request = resolver.applications([A]);
    const rejection = assert.rejects(request, /Invalid.*response/);
    (await helper.next()).reply(response);
    await rejection;
  }
  const recovered = resolver.applications([A]);
  (await helper.next()).reply([metadata(A)]);
  assert.deepEqual(await recovered, [metadata(A)]);
});

test('PNG envelope validation rejects invalid signatures, headers, dimensions and oversized icons', async (t) => {
  const { resolver, helper } = fixture(t);
  const bytes = Buffer.from(PNG.split(',')[1]!, 'base64');
  const invalidHeaders = [0, 8, 12, 24, 25, 26, 27, 28].map((offset) => {
    const changed = Buffer.from(bytes);
    changed[offset] = changed[offset]! ^ 1;
    return 'data:image/png;base64,' + changed.toString('base64');
  });
  const invalidIcons = [
    'data:image/png;base64,not-base64',
    PNG + '\n',
    'data:image/png;base64,' + bytes.subarray(0, 32).toString('base64'),
    ...invalidHeaders, png(47, 48), png(48, 49),
    'data:image/png;base64,' + Buffer.alloc(48 * 1024 + 1).toString('base64'),
  ];
  for (const icon of invalidIcons) {
    const request = resolver.applications([A]);
    const rejection = assert.rejects(request, /Invalid.*response/);
    (await helper.next()).reply([metadata(A, icon)]);
    await rejection;
  }
});

test('accepts full batches over 64KB and rejects output over 2MiB without truncating it', async (t) => {
  const { resolver, helper } = fixture(t);
  const ids = Array.from({ length: 32 }, (_, index) => `com.example.large${index}`);
  const pixels = Buffer.alloc(48 * (48 * 4 + 1));
  let seed = 42;
  for (let index = 0; index < pixels.length; index++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    pixels[index] = index % (48 * 4 + 1) === 0 ? 0 : seed >>> 24;
  }
  const icon = png(48, 48, pixels);
  const response = ids.map((id) => metadata(id, icon));
  assert.ok(Buffer.byteLength(JSON.stringify(response)) > 64 * 1024);
  const request = resolver.applications(ids);
  (await helper.next()).reply(response, 32_000);
  assert.deepEqual(await request, response);

  const oversized = resolver.applications([A]);
  const rejection = assert.rejects(oversized, /exceeds the limit/);
  const call = await helper.next();
  call.raw(Buffer.alloc(2 * 1024 * 1024 + 1));
  await rejection;
  assert.deepEqual(call.killed, ['SIGKILL']);
});

test('timeout, process failures and disposal reject pending calls with bounded messages', async (t) => {
  const { resolver, helper } = fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const timed = resolver.applications([A]);
  const timeoutFailure = assert.rejects(timed, /timed out/);
  const slow = await helper.next();
  t.mock.timers.tick(5_000);
  await timeoutFailure;
  assert.deepEqual(slow.killed, ['SIGKILL']);

  const failed = resolver.applications([A]);
  const processFailure = assert.rejects(failed, /^Error: Computer History application helper failed$/);
  (await helper.next()).child.emit('error', new Error('/private/host path'));
  await processFailure;

  const pending = resolver.applications([A, B]);
  const disposalFailure = assert.rejects(pending, /closed/);
  const active = await helper.next();
  resolver.dispose();
  await disposalFailure;
  assert.deepEqual(active.killed, ['SIGKILL']);
  await assert.rejects(resolver.applications([A]), /closed/);
});

function fixture(t: TestContext, options: Partial<ConstructorParameters<typeof ComputerHistoryApplications>[0]> = {}) {
  const helper = fakeHelper();
  const resolver = new ComputerHistoryApplications({
    helperPath: process.execPath, platform: 'darwin', spawn: helper.spawn, ...options,
  });
  t.after(() => resolver.dispose());
  return { resolver, helper };
}

function fakeHelper() {
  type Call = {
    ids: string[];
    child: ChildProcess;
    killed: string[];
    reply(value: unknown, chunkSize?: number): void;
    raw(value: Buffer): void;
  };
  const calls: Call[] = [];
  const available: Call[] = [];
  let waiting: ((call: Call) => void) | undefined;
  return {
    calls,
    next: () => available.length
      ? Promise.resolve(available.shift()!)
      : new Promise<Call>((resolve) => { waiting = resolve; }),
    spawn: ((command: string, args: string[], options: unknown) => {
      assert.equal(command, process.execPath);
      assert.equal(args[0], 'applications');
      assert.deepEqual(options, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      const killed: string[] = [];
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        kill: (signal: string) => {
          killed.push(signal);
          queueMicrotask(() => child.emit('close', null, signal));
          return true;
        },
      }) as unknown as ChildProcess;
      const call: Call = {
        ids: args.slice(1), child, killed,
        reply: (value, chunkSize = 16_000) => {
          const bytes = Buffer.from(JSON.stringify(value));
          for (let start = 0; start < bytes.length; start += chunkSize) {
            child.stdout!.emit('data', bytes.subarray(start, start + chunkSize));
          }
          child.emit('close', 0, null);
        },
        raw: (value) => child.stdout!.emit('data', value),
      };
      calls.push(call);
      if (waiting) {
        waiting(call);
        waiting = undefined;
      } else available.push(call);
      return child;
    }) as unknown as typeof spawn,
  };
}

function png(width = 48, height = 48, pixels?: Buffer): string {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return 'data:image/png;base64,' + Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(pixels ?? Buffer.alloc(height * (width * 4 + 1)))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}

function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return chunk;
}
