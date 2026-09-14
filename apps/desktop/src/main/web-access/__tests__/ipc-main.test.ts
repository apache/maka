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
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fromBase32, totpAt } from '../crypto.js';
import { loadWebAccess } from '../store.js';
import { registerWebAccessIpc } from '../ipc-main.js';

type Handler = (event: unknown, ...args: unknown[]) => unknown;

function install(): Map<string, Handler> {
  return new Map<string, Handler>();
}

async function invoke<T>(handlers: Map<string, Handler>, channel: string, ...args: unknown[]): Promise<T> {
  const handler = handlers.get(channel);
  assert.ok(handler, `missing handler ${channel}`);
  return handler({}, ...args) as T;
}

test('enroll passphrase + TOTP then enable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-web-ipc-'));
  const handlers = install();
  registerWebAccessIpc({
    ipcMain: {
      handle(channel, listener) {
        handlers.set(channel, listener as Handler);
      },
    },
    userDataDir: dir,
  });
  const tooShort = await invoke(handlers, 'webAccess:setPassphrase', { passphrase: 'short' });
  assert.deepEqual(tooShort, { ok: false, reason: 'too-short' });
  const set = await invoke(handlers, 'webAccess:setPassphrase', { passphrase: 'twelve chars!!' });
  assert.deepEqual(set, { ok: true });
  const enroll = await invoke<{ qrDataUrl: string; otpauthUrl: string }>(handlers, 'webAccess:enrollTotp');
  assert.equal(typeof enroll.qrDataUrl, 'string');
  assert.match(enroll.qrDataUrl, /^data:image\//);
  const file = await loadWebAccess(join(dir, 'web-access.json'));
  assert.ok(file);
  assert.equal(file.totpConfirmed, false);
  const secret = fromBase32(file.totpSecret);
  const code = totpAt(secret, Math.floor(Date.now() / 1000), { digits: 6, period: 30 });
  const tooSoon = await invoke(handlers, 'webAccess:setEnabled', { enabled: true });
  assert.deepEqual(tooSoon, { ok: false, reason: 'not-enrolled' });
  const confirm = await invoke(handlers, 'webAccess:confirmTotp', { code });
  assert.deepEqual(confirm, { ok: true });
  const enabled = await invoke(handlers, 'webAccess:setEnabled', { enabled: true });
  assert.deepEqual(enabled, { ok: true });
  const status = await invoke(handlers, 'webAccess:getStatus');
  assert.deepEqual(status, { enrolled: true, enabled: true });
});
