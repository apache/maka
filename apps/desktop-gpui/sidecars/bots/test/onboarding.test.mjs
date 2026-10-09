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

// The guided onboarding against a fake of the providers' endpoints: the
// requests Desktop's adapters send, polling on the providers' schedule,
// expiry, slow-down, the retry of transient failures, cancellation, and the
// channel a confirmed scan hands to the client, which snapshots never carry.

import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { createBotOnboarding, decryptQQBotSecret, wecomTerminalPollStatus } from '../onboarding.mjs';
import { createBotSidecar } from '../sidecar.mjs';
import { fetchThrough, startFakeOnboarding } from './fake-onboarding.mjs';
import { maka } from './support.mjs';

const DINGTALK = '/oapi.dingtalk.com/app/registration';
const FEISHU = '/accounts.feishu.cn/oauth/v1/app/registration';
const LARK = '/accounts.larksuite.com/oauth/v1/app/registration';
const ILINK = '/ilinkai.weixin.qq.com/ilink/bot';

/** An onboarding on a clock the test moves, against a fresh fake. */
async function setup(t, { status = { running: true } } = {}) {
  const loaded = await maka();
  const fake = await startFakeOnboarding();
  t.after(() => fake.close());
  const clock = { now: 1_000_000 };
  const logs = [];
  let ids = 0;
  const onboarding = createBotOnboarding({
    fetch: fetchThrough(fake.origin, loaded.bots.proxiedFetch),
    redaction: loaded.redaction,
    readStatus: () => status,
    log: (level, message) => logs.push({ level, message }),
    productVersion: '9.9.9',
    now: () => clock.now,
    createId: () => `session-${++ids}`,
  });
  t.after(() => onboarding.dispose());
  return { fake, clock, onboarding, logs };
}

function answerDingTalkStart(fake, { expiresIn = 7_200, interval = 5 } = {}) {
  fake.answer(`POST ${DINGTALK}/init`, { errcode: 0, nonce: 'nonce-1' });
  fake.answer(`POST ${DINGTALK}/begin`, {
    device_code: 'device-1',
    verification_uri_complete: 'https://open-dev.dingtalk.com/openapp/registration?code=abc',
    interval,
    expires_in: expiresIn,
  });
}

test('DingTalk: a device code polled on its interval hands over the confirmed app', async (t) => {
  const { fake, clock, onboarding } = await setup(t);
  answerDingTalkStart(fake);
  const started = await onboarding.start({ provider: 'dingtalk' });
  assert.equal(started.state, 'waiting');
  assert.deepEqual(started.qr, { text: 'https://open-dev.dingtalk.com/openapp/registration?code=abc' });
  assert.equal(started.expiresAt, clock.now + 7_200_000);
  assert.equal(started.nextPollAfterMs, 5_000);
  assert.equal(started.canOpenInBrowser, true);
  assert.deepEqual(fake.callsOf(`POST ${DINGTALK}/init`)[0].body, { source: 'MAKA' });
  assert.deepEqual(fake.callsOf(`POST ${DINGTALK}/begin`)[0].body, { nonce: 'nonce-1' });

  // Too early: the provider is not asked, and the QR code is not sent again.
  const early = await onboarding.poll(started.sessionId);
  assert.equal(early.snapshot.state, 'waiting');
  assert.equal(early.snapshot.qr, undefined);
  assert.equal(fake.callsOf(`POST ${DINGTALK}/poll`).length, 0);

  fake.answer(
    `POST ${DINGTALK}/poll`,
    { status: 'WAITING' },
    { status: 'SUCCESS', client_id: 'ding-app', client_secret: 'ding-secret' },
  );
  clock.now += 5_000;
  const waiting = await onboarding.poll(started.sessionId);
  assert.equal(waiting.snapshot.state, 'waiting');
  assert.equal(waiting.channel, undefined);
  assert.deepEqual(fake.callsOf(`POST ${DINGTALK}/poll`)[0].body, { device_code: 'device-1' });

  clock.now += 5_000;
  const confirmed = await onboarding.poll(started.sessionId);
  assert.equal(confirmed.snapshot.state, 'connecting');
  assert.deepEqual(confirmed.snapshot.identity, { id: 'ding-app' });
  assert.deepEqual(confirmed.channel, {
    enabled: true,
    connected: false,
    readiness: 'configured',
    readinessUpdatedAt: clock.now,
    appId: 'ding-app',
    appSecret: 'ding-secret',
  });
  assert.ok(!JSON.stringify(confirmed.snapshot).includes('ding-secret'));
  // Handed over once: later polls only report the state.
  const again = await onboarding.poll(started.sessionId);
  assert.equal(again.channel, undefined);
  assert.equal(again.snapshot.state, 'connecting');

  const connected = onboarding.finish(started.sessionId);
  assert.equal(connected.state, 'connected');
  assert.equal(connected.warningCode, undefined);
  assert.ok(!JSON.stringify(connected).includes('ding-secret'));
});

test('a saved channel whose listener did not start is connected with a warning', async (t) => {
  const { fake, clock, onboarding } = await setup(t, {
    status: { running: false, reason: 'dingtalk_no_access_token' },
  });
  answerDingTalkStart(fake);
  fake.answer(`POST ${DINGTALK}/poll`, { status: 'SUCCESS', client_id: 'a', client_secret: 'b' });
  const { sessionId } = await onboarding.start({ provider: 'dingtalk' });
  clock.now += 5_000;
  await onboarding.poll(sessionId);
  const connected = onboarding.finish(sessionId);
  assert.equal(connected.state, 'connected');
  assert.equal(connected.warningCode, 'saved_not_connected');
  assert.equal(connected.warningDetail, 'dingtalk_no_access_token');
});

test('a code past its expiry is expired without asking the provider', async (t) => {
  const { fake, clock, onboarding } = await setup(t);
  answerDingTalkStart(fake, { expiresIn: 8 });
  fake.answer(`POST ${DINGTALK}/poll`, { status: 'WAITING' });
  const started = await onboarding.start({ provider: 'dingtalk' });
  // The poll is due at the expiry, not after it.
  clock.now += 5_000;
  assert.equal((await onboarding.poll(started.sessionId)).snapshot.nextPollAfterMs, 3_000);
  clock.now += 3_000;
  const expired = await onboarding.poll(started.sessionId);
  assert.equal(expired.snapshot.state, 'expired');
  assert.equal(fake.callsOf(`POST ${DINGTALK}/poll`).length, 1);
  // DingTalk's own answers end a session too.
  fake.answer(`POST ${DINGTALK}/poll`, { status: 'EXPIRED' });
  const next = await onboarding.start({ provider: 'dingtalk' });
  clock.now += 5_000;
  assert.equal((await onboarding.poll(next.sessionId)).snapshot.state, 'expired');
  fake.answer(`POST ${DINGTALK}/poll`, { status: 'FAIL' });
  const denied = await onboarding.start({ provider: 'dingtalk' });
  clock.now += 5_000;
  assert.equal((await onboarding.poll(denied.sessionId)).snapshot.state, 'denied');
});

test('transient failures back off and end the session after five in a row', async (t) => {
  const { fake, clock, onboarding } = await setup(t);
  answerDingTalkStart(fake);
  fake.answer(`POST ${DINGTALK}/poll`, { httpStatus: 503, body: {} });
  const { sessionId } = await onboarding.start({ provider: 'dingtalk' });
  let interval = 5_000;
  for (let failures = 1; failures < 5; failures += 1) {
    clock.now += interval;
    const { snapshot } = await onboarding.poll(sessionId);
    interval += 2_000;
    assert.equal(snapshot.state, 'waiting');
    assert.deepEqual(snapshot.retryHealth, { category: 'server', consecutiveFailures: failures });
    assert.equal(snapshot.nextPollAfterMs, interval);
  }
  clock.now += interval;
  const failed = (await onboarding.poll(sessionId)).snapshot;
  assert.equal(failed.state, 'error');
  assert.equal(failed.errorCode, 'provider_error');
  assert.equal(failed.retryHealth, undefined);

  // A definite provider error is fatal at once.
  fake.answer(`POST ${DINGTALK}/poll`, { status: 'SOMETHING_NEW' });
  const next = await onboarding.start({ provider: 'dingtalk' });
  clock.now += 5_000;
  const unknown = (await onboarding.poll(next.sessionId)).snapshot;
  assert.equal(unknown.state, 'error');
  assert.equal(unknown.errorCode, 'unavailable');
});

test('Feishu and Lark: the brand picks the accounts domain, slow_down stretches the interval', async (t) => {
  const { fake, clock, onboarding } = await setup(t);
  fake.answer(`POST ${LARK}`, (call) => {
    switch (call.body.action) {
      case 'init':
        return { supported_auth_methods: ['client_secret'] };
      case 'begin':
        return {
          device_code: 'lark-device',
          verification_uri_complete: 'https://accounts.larksuite.com/verify?code=1',
          interval: 5,
          expire_in: 600,
        };
      default:
        return { error: 'slow_down' };
    }
  });
  const started = await onboarding.start({ provider: 'feishu', brand: 'lark' });
  assert.equal(started.brand, 'lark');
  const qr = new URL(started.qr.text);
  assert.equal(qr.host, 'accounts.larksuite.com');
  assert.equal(qr.searchParams.get('from'), 'maka');
  assert.equal(qr.searchParams.get('lpv'), '9.9.9');
  const begin = fake.callsOf(`POST ${LARK}`)[1].body;
  assert.deepEqual(begin, {
    action: 'begin',
    archetype: 'PersonalAgent',
    auth_method: 'client_secret',
    request_user_info: 'open_id',
  });
  clock.now += 5_000;
  const slowed = (await onboarding.poll(started.sessionId)).snapshot;
  assert.equal(slowed.state, 'waiting');
  assert.equal(slowed.nextPollAfterMs, 10_000);

  fake.answer(`POST ${LARK}`, { client_id: 'cli_lark', client_secret: 'lark-secret' });
  fake.answer('POST /open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal/', {
    tenant_access_token: 't-1',
  });
  fake.answer('GET /open.larksuite.com/open-apis/bot/v3/info/', { bot: { app_name: 'Maka Lark' } });
  clock.now += 10_000;
  const confirmed = await onboarding.poll(started.sessionId);
  assert.deepEqual(confirmed.snapshot.identity, { id: 'cli_lark', displayName: 'Maka Lark' });
  assert.equal(confirmed.channel.domain, 'larksuite.com');
  assert.equal(confirmed.channel.appSecret, 'lark-secret');
  const [info] = fake.callsOf('GET /open.larksuite.com/open-apis/bot/v3/info/');
  assert.equal(info.headers.authorization, 'Bearer t-1');
  assert.equal(fake.callsOf(`POST ${FEISHU}`).length, 0);
});

test('WeChat: the iLink sign-in sends its header and hands over the bot token', async (t) => {
  const { fake, clock, onboarding } = await setup(t);
  fake.answer(`GET ${ILINK}/get_bot_qrcode`, {
    ret: 0,
    qrcode_img_content: 'https://liteapp.weixin.qq.com/q/abc',
    qrcode: 'qr-token',
  });
  fake.answer(
    `GET ${ILINK}/get_qrcode_status`,
    { status: 'waiting' },
    {
      status: 'confirmed',
      bot_token: 'wx-bot-token',
      baseurl: 'https://ilinkai.weixin.qq.com',
      ilink_bot_id: 'bot@im.bot',
      ilink_user_id: 'user@im.wechat',
    },
  );
  const started = await onboarding.start({ provider: 'wechat' });
  assert.deepEqual(started.qr, { text: 'https://liteapp.weixin.qq.com/q/abc' });
  assert.equal(started.canOpenInBrowser, false);
  const [qrcode] = fake.callsOf(`GET ${ILINK}/get_bot_qrcode`);
  assert.equal(qrcode.query.bot_type, '3');
  assert.match(Buffer.from(qrcode.headers['x-wechat-uin'], 'base64').toString('utf8'), /^\d+$/);
  clock.now += 2_500;
  assert.equal((await onboarding.poll(started.sessionId)).snapshot.state, 'waiting');
  const [status] = fake.callsOf(`GET ${ILINK}/get_qrcode_status`);
  assert.equal(status.query.qrcode, 'qr-token');
  assert.equal(status.headers['ilink-app-clientversion'], '1');
  clock.now += 2_500;
  const confirmed = await onboarding.poll(started.sessionId);
  assert.equal(confirmed.channel.token, 'wx-bot-token');
  assert.equal(confirmed.channel.webhookUrl, 'https://ilinkai.weixin.qq.com');
  assert.equal(confirmed.channel.botUserId, 'bot@im.bot');
  assert.throws(() => onboarding.browserUrl(started.sessionId), /no browser URL/);

  // An image the provider sends is drawn as it is.
  const png = randomBytes(90).toString('base64');
  fake.answer(`GET ${ILINK}/get_bot_qrcode`, { ret: 0, qrcode_img_content: png, qrcode: 'q2' });
  const image = await onboarding.start({ provider: 'wechat' });
  assert.deepEqual(image.qr, { image: `data:image/png;base64,${png}` });
});

test('QQ: the bind task returns the AppSecret sealed with the key sent', async (t) => {
  const { fake, clock, onboarding } = await setup(t);
  let key;
  fake.answer('POST /q.qq.com/lite/create_bind_task', (call) => {
    key = call.body.key;
    return { retcode: 0, data: { task_id: 'task-1' } };
  });
  const started = await onboarding.start({ provider: 'qq' });
  const qr = new URL(started.qr.text);
  assert.equal(qr.pathname, '/qqbot/openclaw/connect.html');
  assert.equal(qr.searchParams.get('task_id'), 'task-1');
  assert.equal(onboarding.browserUrl(started.sessionId), started.qr.text);
  const sealed = seal('qq-secret', key);
  fake.answer(
    'POST /q.qq.com/lite/poll_bind_result',
    { retcode: 0, data: { status: 1 } },
    { retcode: 0, data: { status: 2, bot_appid: 102000001, bot_encrypt_secret: sealed } },
  );
  clock.now += 2_000;
  assert.equal((await onboarding.poll(started.sessionId)).snapshot.state, 'waiting');
  clock.now += 2_000;
  const confirmed = await onboarding.poll(started.sessionId);
  assert.deepEqual(fake.callsOf('POST /q.qq.com/lite/poll_bind_result')[0].body, { task_id: 'task-1' });
  assert.equal(confirmed.channel.appId, '102000001');
  assert.equal(confirmed.channel.appSecret, 'qq-secret');
  assert.throws(() => decryptQQBotSecret(sealed, randomBytes(32).toString('base64')));
});

test('WeCom: a dead code reads as expired, a cancelled one as denied', async (t) => {
  assert.equal(wecomTerminalPollStatus('expired'), 'expired');
  assert.equal(wecomTerminalPollStatus('user_cancel'), 'denied');
  assert.equal(wecomTerminalPollStatus('waiting'), undefined);
  const { fake, clock, onboarding } = await setup(t);
  fake.answer('GET /work.weixin.qq.com/ai/qc/generate', {
    data: { scode: 'scode-1', auth_url: 'https://work.weixin.qq.com/ai/qc/auth?scode=scode-1' },
  });
  fake.answer('GET /work.weixin.qq.com/ai/qc/query_result', { data: { status: 'qrcode_expired' } });
  const started = await onboarding.start({ provider: 'wecom' });
  assert.equal(fake.callsOf('GET /work.weixin.qq.com/ai/qc/generate')[0].query.source, 'maka');
  clock.now += 5_000;
  assert.equal((await onboarding.poll(started.sessionId)).snapshot.state, 'expired');
});

test('a new session cancels the last one, and a cancelled session stays cancelled', async (t) => {
  const { fake, clock, onboarding } = await setup(t);
  answerDingTalkStart(fake);
  fake.answer(`POST ${DINGTALK}/poll`, { status: 'SUCCESS', client_id: 'a', client_secret: 'b' });
  const first = await onboarding.start({ provider: 'dingtalk' });
  clock.now += 5_000;
  const second = await onboarding.start({ provider: 'dingtalk' });
  // The superseded session is gone, as in Desktop.
  await assert.rejects(onboarding.poll(first.sessionId), /Unknown bot onboarding session/);
  clock.now += 5_000;
  assert.equal(onboarding.cancel(second.sessionId).state, 'cancelled');
  assert.equal((await onboarding.poll(second.sessionId)).channel, undefined);
  assert.equal(fake.callsOf(`POST ${DINGTALK}/poll`).length, 0);
  // A start the provider refuses is an error the dialog can retry.
  fake.answer(`POST ${DINGTALK}/init`, { errcode: 40001 });
  const refused = await onboarding.start({ provider: 'dingtalk' });
  assert.equal(refused.state, 'error');
  assert.equal(refused.qr, undefined);
});

test('the sidecar runs the onboarding commands and checks their input', async (t) => {
  const loaded = await maka();
  const fake = await startFakeOnboarding();
  const sidecar = createBotSidecar({
    maka: loaded,
    stateRoot: '/nonexistent',
    emit: () => {},
    log: () => {},
    connectHost: async () => ({ kind: 'unavailable', reason: 'not_registered' }),
    fetch: fetchThrough(fake.origin, loaded.bots.proxiedFetch),
  });
  t.after(async () => {
    await sidecar.close();
    await fake.close();
  });
  answerDingTalkStart(fake);
  const { snapshot } = await sidecar.handle({ command: 'onboarding_start', provider: 'dingtalk' });
  assert.equal(snapshot.state, 'waiting');
  const { url } = await sidecar.handle({ command: 'onboarding_url', sessionId: snapshot.sessionId });
  assert.equal(url, 'https://open-dev.dingtalk.com/openapp/registration?code=abc');
  const polled = await sidecar.handle({ command: 'onboarding_poll', sessionId: snapshot.sessionId });
  assert.equal(polled.snapshot.state, 'waiting');
  const cancelled = await sidecar.handle({ command: 'onboarding_cancel', sessionId: snapshot.sessionId });
  assert.equal(cancelled.snapshot.state, 'cancelled');
  for (const command of [
    { command: 'onboarding_start', provider: 'telegram' },
    { command: 'onboarding_start', provider: 'qq', brand: 'lark' },
    { command: 'onboarding_poll', sessionId: '' },
  ]) {
    await assert.rejects(sidecar.handle(command), { code: 'invalid_command' });
  }
  await assert.rejects(sidecar.handle({ command: 'onboarding_poll', sessionId: 'nope' }), /Unknown/);
  // The local wechat-bridge only answers on loopback.
  const { result } = await sidecar.handle({
    command: 'wechat_bridge_qr',
    channel: { webhookUrl: 'https://example.com' },
  });
  assert.deepEqual({ ok: result.ok, hintCode: result.hintCode }, { ok: false, hintCode: 'wechat_bridge_remote_url' });
});

/** Seals `secret` as QQ does: AES-256-GCM, IV first, tag last. */
function seal(secret, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'base64'), iv, { authTagLength: 16 });
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString('base64');
}
