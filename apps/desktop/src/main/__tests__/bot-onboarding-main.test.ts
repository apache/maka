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

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  createDefaultSettings,
  mergeSettings,
  type AppSettings,
  type UpdateAppSettingsInput,
} from '@maka/core/settings';
import type { BotRegistry } from '@maka/runtime/bots';
import type { SettingsStore } from '@maka/storage';
import {
  BotOnboardingService,
  wecomTerminalPollStatus,
  type BotOnboardingProviderAdapter,
} from '../bot-onboarding-main.js';

const QR_DATA = 'data:image/png;base64,ZmFrZQ==';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function harness(
  adapter: BotOnboardingProviderAdapter,
  applyEffect?: (settings: AppSettings, patch: UpdateAppSettingsInput) => Promise<void>,
  options?: { getStatus?: () => Record<string, unknown> },
) {
  let now = 1_000;
  const updates: UpdateAppSettingsInput[] = [];
  const effects: UpdateAppSettingsInput[] = [];
  let currentSettings = createDefaultSettings();
  const settingsStore = {
    async get() {
      return currentSettings;
    },
    async update(patch: UpdateAppSettingsInput) {
      updates.push(patch);
      currentSettings = mergeSettings(currentSettings, patch);
      return currentSettings;
    },
    async updateIf(
      predicate: (current: AppSettings) => boolean,
      patch: UpdateAppSettingsInput,
    ) {
      if (!predicate(currentSettings)) return { applied: false, settings: currentSettings };
      updates.push(patch);
      currentSettings = mergeSettings(currentSettings, patch);
      return { applied: true, settings: currentSettings };
    },
  } as SettingsStore;
  const botRegistry = {
    getStatus: options?.getStatus ?? (() => ({
      platform: 'dingtalk',
      running: true,
      readiness: 'credentials_valid',
      connection: 'gateway',
    })),
  } as unknown as BotRegistry;
  let sequence = 0;
  const service = new BotOnboardingService({
    settingsStore,
    botRegistry,
    applySettingsRuntimeEffects: async (settings, patch) => {
      effects.push(patch);
      await applyEffect?.(settings, patch);
    },
    adapters: { dingtalk: adapter },
    now: () => now,
    createId: () => `session-${++sequence}`,
    openExternal: async () => undefined,
  });
  return {
    service,
    updates,
    effects,
    settingsStore,
    getSettings() { return currentSettings; },
    advance(ms: number) { now += ms; },
  };
}

function startResult() {
  return {
    opaqueToken: 'opaque-device-code',
    qrCodeDataUrl: QR_DATA,
    verificationUrl: 'https://example.com/device',
    pollIntervalMs: 5_000,
    expiresInSeconds: 600,
  };
}

describe('BotOnboardingService', () => {
  it('persists confirmed credentials in main while returning a secret-free snapshot', async () => {
    const adapter: BotOnboardingProviderAdapter = {
      async start() { return startResult(); },
      async poll() {
        return {
          status: 'confirmed',
          credential: {
            provider: 'dingtalk',
            clientId: 'public-client-id',
            clientSecret: 'private-client-secret',
          },
          identity: { id: 'public-client-id' },
        };
      },
    };
    const test = harness(adapter);
    const started = await test.service.start({ provider: 'dingtalk' });
    assert.equal(started.state, 'waiting');
    assert.equal(started.qrCodeDataUrl, QR_DATA);
    assert.equal(JSON.stringify(started).includes('opaque-device-code'), false);

    test.advance(5_000);
    const connected = await test.service.poll(started.sessionId);
    assert.equal(connected.state, 'connected');
    assert.equal(connected.identity?.id, 'public-client-id');
    assert.equal(test.updates.length, 1);
    assert.equal(test.effects.length, 1);
    assert.equal(JSON.stringify(connected).includes('private-client-secret'), false);
    assert.equal(JSON.stringify(connected).includes('opaque-device-code'), false);
    assert.equal(
      (test.updates[0].botChat?.channels?.dingtalk as { appSecret?: string } | undefined)?.appSecret,
      'private-client-secret',
    );
  });

  it('emits the QR data URL only on the start snapshot, not on every poll', async () => {
    // PR1197 review (P2-13): the QR payload is large; only start() carries it.
    const adapter: BotOnboardingProviderAdapter = {
      async start() { return startResult(); },
      async poll() { return { status: 'pending' }; },
    };
    const test = harness(adapter);
    const started = await test.service.start({ provider: 'dingtalk' });
    assert.equal(started.qrCodeDataUrl, QR_DATA);
    test.advance(5_000);
    const polled = await test.service.poll(started.sessionId);
    assert.equal(polled.qrCodeDataUrl, undefined, 'poll snapshots must not resend the QR payload');
  });

  it('cancels an in-flight poll and rejects its late credential result', async () => {
    const pending = deferred<any>();
    const adapter: BotOnboardingProviderAdapter = {
      async start() { return startResult(); },
      async poll() { return pending.promise; },
    };
    const test = harness(adapter);
    const started = await test.service.start({ provider: 'dingtalk' });
    test.advance(5_000);
    const polling = test.service.poll(started.sessionId);
    const cancelled = test.service.cancel(started.sessionId);
    assert.equal(cancelled.state, 'cancelled');
    pending.resolve({
      status: 'confirmed',
      credential: {
        provider: 'dingtalk',
        clientId: 'late-client-id',
        clientSecret: 'late-secret',
      },
    });
    assert.equal((await polling).state, 'cancelled');
    assert.equal(test.updates.length, 0);
    assert.equal(test.effects.length, 0);
  });

  it('rolls back credentials when cancellation crosses the runtime-effect commit window', async () => {
    const effectStarted = deferred<void>();
    const releaseEffect = deferred<void>();
    let effectCalls = 0;
    const adapter: BotOnboardingProviderAdapter = {
      async start() { return startResult(); },
      async poll() {
        return {
          status: 'confirmed',
          credential: {
            provider: 'dingtalk',
            clientId: 'cancelled-client-id',
            clientSecret: 'cancelled-secret',
          },
        };
      },
    };
    const test = harness(adapter, async () => {
      effectCalls += 1;
      if (effectCalls === 1) {
        effectStarted.resolve();
        await releaseEffect.promise;
      }
    });
    const started = await test.service.start({ provider: 'dingtalk' });
    test.advance(5_000);
    const polling = test.service.poll(started.sessionId);
    await effectStarted.promise;
    test.service.cancel(started.sessionId);
    releaseEffect.resolve();

    assert.equal((await polling).state, 'cancelled');
    const channel = test.getSettings().botChat.channels.dingtalk;
    assert.equal(channel.enabled, false);
    assert.equal(channel.appId, undefined);
    assert.equal(channel.appSecret, undefined);
    assert.equal(test.updates.length, 2);
    assert.equal(test.effects.length, 2);
  });

  it('does not overwrite a concurrent manual credential edit during cancellation rollback', async () => {
    const effectStarted = deferred<void>();
    const releaseEffect = deferred<void>();
    let effectCalls = 0;
    const adapter: BotOnboardingProviderAdapter = {
      async start() { return startResult(); },
      async poll() {
        return {
          status: 'confirmed',
          credential: {
            provider: 'dingtalk',
            clientId: 'onboarding-client-id',
            clientSecret: 'onboarding-secret',
          },
        };
      },
    };
    const test = harness(adapter, async () => {
      effectCalls += 1;
      if (effectCalls === 1) {
        effectStarted.resolve();
        await releaseEffect.promise;
      }
    });
    const started = await test.service.start({ provider: 'dingtalk' });
    test.advance(5_000);
    const polling = test.service.poll(started.sessionId);
    await effectStarted.promise;
    test.service.cancel(started.sessionId);
    await test.settingsStore.update({
      botChat: {
        channels: {
          dingtalk: {
            appId: 'manual-client-id',
            appSecret: 'manual-secret',
          },
        },
      },
    });
    releaseEffect.resolve();

    assert.equal((await polling).state, 'cancelled');
    const channel = test.getSettings().botChat.channels.dingtalk;
    assert.equal(channel.appId, 'manual-client-id');
    assert.equal(channel.appSecret, 'manual-secret');
    assert.equal(test.effects.length, 1);
  });

  it('rolls back credentials even when a concurrent status write lands mid-commit', async () => {
    // PR1197 review (P0-2): main.ts's onStatusChange persistence writer mutates
    // volatile status fields (readiness/readinessUpdatedAt/lastError) during the
    // applySettingsRuntimeEffects window. The rollback CAS predicate must ignore
    // those fields — otherwise the concurrent status write flips it false and the
    // cancel silently leaves live credentials behind.
    const effectStarted = deferred<void>();
    const releaseEffect = deferred<void>();
    let effectCalls = 0;
    const adapter: BotOnboardingProviderAdapter = {
      async start() { return startResult(); },
      async poll() {
        return {
          status: 'confirmed',
          credential: {
            provider: 'dingtalk',
            clientId: 'onboarding-client-id',
            clientSecret: 'onboarding-secret',
          },
        };
      },
    };
    const test = harness(adapter, async () => {
      effectCalls += 1;
      if (effectCalls === 1) {
        // Simulate the concurrent status writer: touches only volatile status
        // fields, never the credential identity fields.
        await test.settingsStore.update({
          botChat: {
            channels: {
              dingtalk: { readiness: 'operational', readinessUpdatedAt: 424_242 },
            },
          },
        });
        effectStarted.resolve();
        await releaseEffect.promise;
      }
    });
    const started = await test.service.start({ provider: 'dingtalk' });
    test.advance(5_000);
    const polling = test.service.poll(started.sessionId);
    await effectStarted.promise;
    test.service.cancel(started.sessionId);
    releaseEffect.resolve();

    assert.equal((await polling).state, 'cancelled');
    const channel = test.getSettings().botChat.channels.dingtalk;
    assert.equal(channel.appId, undefined, 'live credential must be rolled back');
    assert.equal(channel.appSecret, undefined, 'live secret must be rolled back');
    assert.equal(channel.enabled, false);
  });

  it('marks a connected session with a warning when the bridge is not running', async () => {
    // PR1197 review (P0-3): credentials persisted fine, but the live bridge
    // failed to start (bot-registry swallows start() errors). The snapshot must
    // stay `connected` (credentials are valid + saved) while carrying an honest,
    // secret-free warning — never a lie about a healthy connection.
    const adapter: BotOnboardingProviderAdapter = {
      async start() { return startResult(); },
      async poll() {
        return {
          status: 'confirmed',
          credential: {
            provider: 'dingtalk',
            clientId: 'public-client-id',
            clientSecret: 'private-client-secret',
          },
          identity: { id: 'public-client-id' },
        };
      },
    };
    const test = harness(adapter, undefined, {
      getStatus: () => ({
        platform: 'dingtalk',
        running: false,
        readiness: 'configured',
        reason: '鉴权失败',
        connection: 'none',
      }),
    });
    const started = await test.service.start({ provider: 'dingtalk' });
    test.advance(5_000);
    const connected = await test.service.poll(started.sessionId);
    assert.equal(connected.state, 'connected');
    assert.match(connected.warning ?? '', /凭据已保存，但连接未建立/);
    assert.match(connected.warning ?? '', /鉴权失败/);
    assert.equal(JSON.stringify(connected).includes('private-client-secret'), false);
  });

  it('omits the warning when the bridge is running', async () => {
    const adapter: BotOnboardingProviderAdapter = {
      async start() { return startResult(); },
      async poll() {
        return {
          status: 'confirmed',
          credential: {
            provider: 'dingtalk',
            clientId: 'public-client-id',
            clientSecret: 'private-client-secret',
          },
          identity: { id: 'public-client-id' },
        };
      },
    };
    const test = harness(adapter);
    const started = await test.service.start({ provider: 'dingtalk' });
    test.advance(5_000);
    const connected = await test.service.poll(started.sessionId);
    assert.equal(connected.state, 'connected');
    assert.equal(connected.warning, undefined);
  });

  it('invalidates an older session when the same provider starts again', async () => {
    const pending = deferred<any>();
    let polls = 0;
    const adapter: BotOnboardingProviderAdapter = {
      async start() { return startResult(); },
      async poll() {
        polls += 1;
        return pending.promise;
      },
    };
    const test = harness(adapter);
    const first = await test.service.start({ provider: 'dingtalk' });
    test.advance(5_000);
    const firstPoll = test.service.poll(first.sessionId);
    const second = await test.service.start({ provider: 'dingtalk' });
    assert.notEqual(second.sessionId, first.sessionId);
    pending.resolve({
      status: 'confirmed',
      credential: {
        provider: 'dingtalk',
        clientId: 'stale-client-id',
        clientSecret: 'stale-secret',
      },
    });
    assert.equal((await firstPoll).state, 'cancelled');
    assert.equal(polls, 1);
    assert.equal(test.updates.length, 0);
  });

  it('evicts a superseded session from the map on the next start', async () => {
    // PR1197 review (P2-9): the session map must not grow unbounded across
    // repeated onboarding attempts.
    const pending = deferred<any>();
    const adapter: BotOnboardingProviderAdapter = {
      async start() { return startResult(); },
      async poll() { return pending.promise; },
    };
    const test = harness(adapter);
    const first = await test.service.start({ provider: 'dingtalk' });
    const second = await test.service.start({ provider: 'dingtalk' });
    assert.notEqual(second.sessionId, first.sessionId);
    await assert.rejects(
      () => test.service.poll(first.sessionId),
      /Unknown bot onboarding session/,
      'the superseded session must be pruned from the map',
    );
  });

  it('dispose() aborts and clears all sessions', async () => {
    const pending = deferred<any>();
    const adapter: BotOnboardingProviderAdapter = {
      async start() { return startResult(); },
      async poll() { return pending.promise; },
    };
    const test = harness(adapter);
    const started = await test.service.start({ provider: 'dingtalk' });
    test.service.dispose();
    await assert.rejects(
      () => test.service.poll(started.sessionId),
      /Unknown bot onboarding session/,
      'dispose must clear the session map',
    );
  });

  it('coalesces duplicate polls and applies provider slow-down backoff', async () => {
    const pending = deferred<any>();
    let polls = 0;
    const adapter: BotOnboardingProviderAdapter = {
      async start() { return startResult(); },
      async poll() {
        polls += 1;
        return pending.promise;
      },
    };
    const test = harness(adapter);
    const started = await test.service.start({ provider: 'dingtalk' });
    test.advance(5_000);
    const first = test.service.poll(started.sessionId);
    const duplicate = test.service.poll(started.sessionId);
    pending.resolve({ status: 'slow_down' });
    const [a, b] = await Promise.all([first, duplicate]);
    assert.equal(polls, 1);
    assert.equal(a.nextPollAfterMs, 10_000);
    assert.deepEqual(a, b);
  });

  it('survives a transient poll failure and only goes terminal after repeated errors', async () => {
    // PR1197 review (P1-5): a single timeout/network blip must not burn a
    // still-valid device code; the session keeps waiting and retries until the
    // consecutive-failure threshold is crossed.
    let attempts = 0;
    const timeoutError = Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' });
    const adapter: BotOnboardingProviderAdapter = {
      async start() { return startResult(); },
      async poll() {
        attempts += 1;
        throw timeoutError;
      },
    };
    const test = harness(adapter);
    const started = await test.service.start({ provider: 'dingtalk' });
    test.advance(5_000);
    const afterFirst = await test.service.poll(started.sessionId);
    assert.equal(afterFirst.state, 'waiting', 'a single transient blip must not kill the session');
    assert.equal(attempts, 1);

    let last = afterFirst;
    for (let i = 0; i < 12 && last.state !== 'error'; i += 1) {
      test.advance(60_000);
      last = await test.service.poll(started.sessionId);
    }
    assert.equal(last.state, 'error', 'repeated consecutive transient failures must go terminal');
  });

  it('fails immediately on a fatal (non-transient) poll error', async () => {
    const adapter: BotOnboardingProviderAdapter = {
      async start() { return startResult(); },
      async poll() { throw new Error('DingTalk registration returned an unknown status'); },
    };
    const test = harness(adapter);
    const started = await test.service.start({ provider: 'dingtalk' });
    test.advance(5_000);
    const result = await test.service.poll(started.sessionId);
    assert.equal(result.state, 'error');
  });

  it('expires locally without polling after the provider TTL', async () => {
    let polls = 0;
    const adapter: BotOnboardingProviderAdapter = {
      async start() { return { ...startResult(), expiresInSeconds: 1 }; },
      async poll() { polls += 1; return { status: 'pending' }; },
    };
    const test = harness(adapter);
    const started = await test.service.start({ provider: 'dingtalk' });
    test.advance(1_001);
    const expired = await test.service.poll(started.sessionId);
    assert.equal(expired.state, 'expired');
    assert.equal(polls, 0);
  });

  it('maps a dead WeCom QR status to a terminal outcome instead of endless pending', () => {
    // PR1197 review (P1-6): a dead/expired/cancelled WeCom QR must resolve to a
    // terminal state so the modal can offer a refresh, not spin forever.
    assert.equal(wecomTerminalPollStatus('expired'), 'expired');
    assert.equal(wecomTerminalPollStatus('qr_timeout'), 'expired');
    assert.equal(wecomTerminalPollStatus('invalid'), 'expired');
    assert.equal(wecomTerminalPollStatus('user_cancel'), 'denied');
    assert.equal(wecomTerminalPollStatus('rejected'), 'denied');
    // Unknown / still-pending markers keep polling (local TTL is the backstop).
    assert.equal(wecomTerminalPollStatus('wait'), undefined);
    assert.equal(wecomTerminalPollStatus('scanned'), undefined);
    assert.equal(wecomTerminalPollStatus(undefined), undefined);
  });
});
