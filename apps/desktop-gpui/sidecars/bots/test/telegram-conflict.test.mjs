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

// The sidecar's commands against the real Telegram bridge of
// `@maka/runtime/bots`, pointed at the fake Bot API: a 409 on getUpdates
// suspends the channel and says so, a restart or new credentials resume it,
// and a channel test reaches the same API.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { createBotSidecar } from '../sidecar.mjs';
import {
  TELEGRAM_API_ORIGIN,
  observeTelegramConflicts,
  parseTestOrigin,
  redirectTelegramApi,
  telegramMethod,
} from '../telegram-api.mjs';
import { CONFLICT_DESCRIPTION, FAKE_BOT, startFakeTelegram } from './fake-telegram.mjs';
import { maka } from './support.mjs';

test('the test origin must be plain HTTP on loopback', () => {
  assert.equal(parseTestOrigin('http://127.0.0.1:8081'), 'http://127.0.0.1:8081');
  for (const bad of ['https://127.0.0.1:1', 'http://example.com:80', 'http://127.0.0.1:1/api', 'nope']) {
    assert.throws(() => parseTestOrigin(bad), /MAKA_BOTS_TELEGRAM_API_ORIGIN/, bad);
  }
  assert.equal(telegramMethod('/bot123:abc/getUpdates'), 'getUpdates');
  assert.equal(telegramMethod('/bot123:abc/getUpdates?offset=1'), 'getUpdates');
  assert.equal(telegramMethod('/getUpdates'), undefined);
});

test('a conflict on getUpdates suspends Telegram until restarted', { timeout: 20_000 }, async (t) => {
  const loaded = await maka();
  const fake = await startFakeTelegram();
  redirectTelegramApi(loaded.undici, fake.origin);
  const events = new EventEmitter();
  const sidecar = createBotSidecar({
    maka: loaded,
    stateRoot: '/nonexistent',
    emit: (event) => events.emit(event.event, event),
    log: () => {},
    connectHost: async () => ({ kind: 'unavailable', reason: 'not_registered' }),
  });
  const unobserve = observeTelegramConflicts((conflict) => sidecar.telegramConflict(conflict), {
    origins: [TELEGRAM_API_ORIGIN, fake.origin],
  });
  sidecar.start();
  t.after(async () => {
    unobserve();
    await sidecar.close();
    await fake.close();
  });

  const telegramStatus = (predicate) =>
    new Promise((resolve) => {
      const listener = (event) => {
        if (event.status.platform !== 'telegram' || !predicate(event)) return;
        events.off('status', listener);
        resolve(event);
      };
      events.on('status', listener);
    });
  const settings = (token) => ({ channels: { telegram: { enabled: true, token } } });

  const polling = telegramStatus((event) => event.status.running);
  await sidecar.handle({ command: 'apply_settings', settings: settings('123:first') });
  const running = await polling;
  assert.equal(running.status.readiness, 'credentials_valid');
  assert.equal(running.status.identity.username, FAKE_BOT.username);
  assert.equal(running.conflict, undefined);

  const suspended = telegramStatus((event) => event.conflict && !event.status.running);
  fake.setConflict(true);
  const conflict = await suspended;
  assert.equal(conflict.conflict.kind, 'polling');
  assert.equal(conflict.conflict.description, CONFLICT_DESCRIPTION.slice(0, 200));
  assert.equal(typeof conflict.conflict.detectedAt, 'number');
  // Listed statuses carry it too, and settings with the same token keep it.
  await sidecar.handle({ command: 'apply_settings', settings: settings('123:first') });
  const { statuses } = await sidecar.handle({ command: 'list_statuses' });
  assert.equal(statuses[0].status.platform, 'telegram');
  assert.equal(statuses[0].conflict.kind, 'polling');

  fake.setConflict(false);
  const resumed = telegramStatus((event) => event.status.running && !event.conflict);
  const restarted = await sidecar.handle({ command: 'restart_listeners', provider: 'telegram' });
  assert.equal(restarted.statuses[0].conflict, undefined);
  await resumed;

  // Another token is another bot: its conflict state starts clean.
  fake.setConflict(true);
  await telegramStatus((event) => event.conflict);
  fake.setConflict(false);
  const renewed = telegramStatus((event) => event.status.running && !event.conflict);
  await sidecar.handle({ command: 'apply_settings', settings: settings('123:second') });
  await renewed;
});

test('a channel test calls getMe on the same API', { timeout: 20_000 }, async (t) => {
  const loaded = await maka();
  const fake = await startFakeTelegram();
  redirectTelegramApi(loaded.undici, fake.origin);
  const sidecar = createBotSidecar({
    maka: loaded,
    stateRoot: '/nonexistent',
    emit: () => {},
    log: () => {},
    connectHost: async () => ({ kind: 'unavailable', reason: 'not_registered' }),
  });
  t.after(async () => {
    await sidecar.close();
    await fake.close();
  });
  const { result } = await sidecar.handle({
    command: 'test_channel',
    provider: 'telegram',
    channel: { enabled: false, token: '123:abc' },
  });
  assert.deepEqual(result, {
    ok: true,
    identity: { id: String(FAKE_BOT.id), username: FAKE_BOT.username, displayName: FAKE_BOT.first_name },
    messageSent: false,
  });
  const rejected = await sidecar.handle({
    command: 'test_channel',
    provider: 'telegram',
    channel: { token: 'rejected' },
  });
  assert.equal(rejected.result.ok, false);
  assert.equal(rejected.result.errorCode, 'token_invalid');
  await assert.rejects(sidecar.handle({ command: 'test_channel', provider: 'fax', channel: {} }), {
    code: 'invalid_command',
  });
  assert.deepEqual(fake.calls.map(({ method }) => method), ['getMe', 'getMe']);
});
