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
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';

import { createDefaultBotChannel } from '@maka/core/bot-chat-settings';

import { TelegramBotBridge, __TEST__ } from '../telegram-bridge.js';
import type { BotIncomingMessage, BotStatus } from '../types.js';

const { classifyTelegramSendResponse } = __TEST__;

describe('classifyTelegramSendResponse', () => {
  it('returns the optional message id on successful responses', () => {
    assert.deepEqual(classifyTelegramSendResponse({ ok: true, result: { message_id: 12345 } }), {
      kind: 'ok',
      messageId: '12345',
    });
    assert.deepEqual(classifyTelegramSendResponse({ ok: true, result: {} }), {
      kind: 'ok',
      messageId: null,
    });
  });

  it('clamps Telegram retry hints to the bounded retry window', () => {
    for (const [retryAfter, expected] of [
      [5, 5_000],
      [3600, 30_000],
      ['wat', 1_000],
    ] as const) {
      const result = classifyTelegramSendResponse({
        ok: false,
        error_code: 429,
        parameters: { retry_after: retryAfter },
      });
      assert.equal(result.kind, 'retry');
      if (result.kind === 'retry') assert.equal(result.delayMs, expected, String(retryAfter));
    }
  });

  it('classifies permanent and malformed failures with stable descriptions', () => {
    const cases: Array<[unknown, string]> = [
      [{ ok: false, error_code: 400, description: 'Bad Request' }, 'Bad Request'],
      [null, 'send-failed'],
    ];
    for (const [payload, description] of cases) {
      assert.deepEqual(classifyTelegramSendResponse(payload), { kind: 'fatal', description });
    }
  });
});

/**
 * Issue #6330: poll failures after a successful getMe (revoked token,
 * sustained 4xx/5xx, network outage) kept readiness at 'operational' —
 * the channel looked healthy while never receiving. The poll loop must
 * hold the same failure contract as sendMessage: degrade readiness,
 * record the failure, and emit a statusChange. Recovery stays
 * message/send-driven, matching the wechat bridge precedent.
 */
describe('pollTelegram readiness (issue #6330)', () => {
  const TELEGRAM_ORIGIN = 'https://api.telegram.org';
  const TOKEN_PATH = '/bottest-token';

  function readinessEvent(
    bridge: TelegramBotBridge,
    readiness: BotStatus['readiness'],
  ): Promise<BotStatus> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`no statusChange with readiness=${readiness}`)),
        10_000,
      );
      const onStatus = (status: BotStatus): void => {
        if (status.readiness !== readiness) return;
        bridge.off('statusChange', onStatus);
        clearTimeout(timer);
        resolve(status);
      };
      bridge.on('statusChange', onStatus);
    });
  }

  async function withMockedTelegramApi(
    run: (pool: ReturnType<MockAgent['get']>) => Promise<void>,
  ): Promise<void> {
    const previous = getGlobalDispatcher();
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);
    try {
      const pool = mock.get(TELEGRAM_ORIGIN);
      pool
        .intercept({ path: `${TOKEN_PATH}/getMe`, method: 'POST' })
        .reply(200, {
          ok: true,
          result: { id: 42, username: 'maka_bot', first_name: 'Maka' },
        })
        .persist();
      await run(pool);
    } finally {
      setGlobalDispatcher(previous);
      await mock.close();
    }
  }

  function createBridge(): TelegramBotBridge {
    return new TelegramBotBridge('telegram', {
      ...createDefaultBotChannel('telegram'),
      enabled: true,
      token: 'test-token',
    });
  }

  it('degrades readiness when getUpdates reports failure after being operational, and recovers on the next delivered message', async () => {
    await withMockedTelegramApi(async (pool) => {
      // Poll script (the loop is strictly sequential, so steps fire in
      // order): deliver one message (promotes the channel to
      // operational), then fail like a revoked token, then recover with
      // another delivered message, then idle so teardown has no pending
      // backoff sleep.
      const script: Array<'deliver' | 'fail' | 'idle'> = ['deliver', 'fail', 'deliver', 'idle'];
      let cursor = 0;
      pool
        .intercept({ path: `${TOKEN_PATH}/getUpdates`, method: 'POST' })
        .reply(200, () => {
          const step = script[Math.min(cursor, script.length - 1)];
          cursor += 1;
          if (step === 'fail') {
            return { ok: false, error_code: 401, description: 'Unauthorized' };
          }
          if (step === 'deliver') {
            return {
              ok: true,
              result: [
                {
                  update_id: cursor,
                  message: {
                    message_id: cursor,
                    from: { id: 100, username: 'alice', first_name: 'Alice' },
                    chat: { id: 100, type: 'private' },
                    text: `hello ${cursor}`,
                    date: 1_700_000_000,
                  },
                },
              ],
            };
          }
          return { ok: true, result: [] };
        })
        // Telegram's success path has no client-side sleep (the server
        // long-poll holds the connection in production). Without a
        // mocked delay the loop would re-poll in a pure-microtask cycle
        // and starve the event loop, so every response yields once.
        .delay(50)
        .persist();

      const bridge = createBridge();
      const statusEvents: BotStatus[] = [];
      bridge.on('statusChange', (status) => statusEvents.push(status));
      const nextMessage = (): Promise<BotIncomingMessage> =>
        new Promise((resolve) => bridge.once('message', resolve));
      try {
        // Attach every waiter before start(): the loop re-polls without
        // sleeping after successful polls, so late attachment can miss
        // already-emitted events.
        const credentialsValid = readinessEvent(bridge, 'credentials_valid');
        const promoted = readinessEvent(bridge, 'operational');
        const degraded = readinessEvent(bridge, 'degraded');
        const firstMessage = nextMessage();
        await bridge.start();
        await credentialsValid;
        await promoted;
        assert.equal((await firstMessage).text, 'hello 1');

        // Failure while operational must degrade the channel, record the
        // failure reason, and emit the change.
        await degraded;
        assert.equal(bridge.isRunning(), true);
        assert.equal(bridge.getStatus().readiness, 'degraded');
        assert.equal(bridge.getStatus().reason, 'token_invalid');
        assert.ok(
          statusEvents.some((status) => status.readiness === 'degraded'),
          'degraded statusChange must be emitted',
        );

        // Recovery is receive-driven, as in the wechat bridge: the next
        // successfully delivered message returns the channel to
        // operational and clears the failure reason.
        const recovered = readinessEvent(bridge, 'operational');
        const secondMessage = nextMessage();
        await recovered;
        assert.equal((await secondMessage).text, 'hello 3');
        assert.equal(bridge.getStatus().readiness, 'operational');
        assert.equal(bridge.getStatus().reason, undefined);
        const degradedAt = statusEvents.findIndex((status) => status.readiness === 'degraded');
        const recoveredAt = statusEvents.findIndex(
          (status, index) => index > degradedAt && status.readiness === 'operational',
        );
        assert.ok(degradedAt >= 0 && recoveredAt > degradedAt, 'operational must follow degraded');
      } finally {
        await bridge.stop();
      }
    });
  });

  it('degrades readiness when the poll loop throws on a non-JSON gateway response', async () => {
    await withMockedTelegramApi(async (pool) => {
      const script: Array<'deliver' | 'throw' | 'idle'> = ['deliver', 'throw', 'idle'];
      let cursor = 0;
      pool
        .intercept({ path: `${TOKEN_PATH}/getUpdates`, method: 'POST' })
        .reply(200, () => {
          const step = script[Math.min(cursor, script.length - 1)];
          cursor += 1;
          if (step === 'throw') return '<html>bad gateway</html>';
          if (step === 'deliver') {
            return {
              ok: true,
              result: [
                {
                  update_id: cursor,
                  message: {
                    message_id: cursor,
                    from: { id: 100, username: 'alice', first_name: 'Alice' },
                    chat: { id: 100, type: 'private' },
                    text: `hello ${cursor}`,
                    date: 1_700_000_000,
                  },
                },
              ],
            };
          }
          return { ok: true, result: [] };
        })
        // See the first test: yield the event loop between polls so the
        // success path cannot starve timers with a microtask spin.
        .delay(50)
        .persist();

      const bridge = createBridge();
      const statusEvents: BotStatus[] = [];
      bridge.on('statusChange', (status) => statusEvents.push(status));
      try {
        const credentialsValid = readinessEvent(bridge, 'credentials_valid');
        const promoted = readinessEvent(bridge, 'operational');
        const degraded = readinessEvent(bridge, 'degraded');
        await bridge.start();
        await credentialsValid;
        await promoted;

        // A thrown poll error (gateway junk here, but the same path
        // covers network outages and timeouts) must degrade too.
        await degraded;
        assert.equal(bridge.isRunning(), true);
        assert.equal(bridge.getStatus().readiness, 'degraded');
        assert.ok(
          typeof bridge.getStatus().reason === 'string' && bridge.getStatus().reason!.length > 0,
          'recordFailure must set a reason',
        );
        assert.ok(
          statusEvents.some((status) => status.readiness === 'degraded'),
          'degraded statusChange must be emitted',
        );
      } finally {
        await bridge.stop();
      }
    });
  });
});
