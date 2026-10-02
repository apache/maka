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
import { describe, it, type TestContext } from 'node:test';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher, type WebSocket } from 'undici';
import { createDefaultBotChannel } from '@maka/core/settings';
import { DiscordBotBridge } from '../discord-bridge.js';
import { DingTalkBotBridge } from '../dingtalk-bridge.js';
import { GatewayBridgeBase } from '../gateway-bridge-base.js';
import { QQBotBridge } from '../qq-bridge.js';
import type { WsBridgeBase, WsCloseDecision } from '../ws-bridge-base.js';

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const hello = { op: 10, d: { heartbeat_interval: 3_600_000 } };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class FakeSocket extends EventTarget {
  readyState = 1;
  sent: Array<{ op: number; d: Record<string, unknown> }> = [];
  closed: Array<number | undefined> = [];

  frame(payload: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(payload) }));
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(code?: number): void {
    this.closed.push(code);
    this.readyState = 3;
    queueMicrotask(() => {
      this.dispatchEvent(Object.assign(new Event('close'), { code: code ?? 1005, reason: '' }));
    });
  }
}

function installSockets(bridge: WsBridgeBase): FakeSocket[] {
  const sockets: FakeSocket[] = [];
  Object.defineProperty(bridge, 'createWebSocket', {
    value: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  });
  return sockets;
}

function settings(platform: 'qq' | 'discord' | 'dingtalk') {
  return {
    ...createDefaultBotChannel(platform),
    enabled: true,
    token: 'fixture-token',
    appId: 'fixture-app',
    appSecret: 'fixture-secret',
  };
}

function ready(socket: FakeSocket, session = 'current-session'): void {
  socket.dispatchEvent(new Event('open'));
  socket.frame({ op: 0, t: 'READY', s: 42, d: { session_id: session, user: { id: 'bot' } } });
}

class AsyncGateway extends GatewayBridgeBase {
  gateway: Promise<string | null> = Promise.resolve('wss://fixture.invalid');
  auth: Promise<Record<string, unknown> | null> = Promise.resolve({ token: 'current' });

  protected override fetchGatewayUrl(): Promise<string | null> {
    return this.gateway;
  }

  protected override checkCredentials(): null {
    return null;
  }

  protected override buildIdentifyPayload(): Promise<Record<string, unknown> | null> {
    return this.auth;
  }

  protected override buildResumePayload(): Promise<Record<string, unknown> | null> {
    return this.auth;
  }

  protected override onDispatch(type: string, d: unknown): void {
    if (type === 'READY') {
      this.sessionId = (d as { session_id: string }).session_id;
      this.promoteToOperational();
    }
  }

  protected override decideClose(_code: number, stopped: boolean): WsCloseDecision {
    return stopped ? { kind: 'stopped' } : { kind: 'reconnect', resumable: true };
  }

  async reconnect(): Promise<void> {
    this.forceReconnect(true);
    this.clearReconnect();
    await this.openConnection();
  }

  lifecycle() {
    return { session: this.sessionId, seq: this.seq, retry: this.reconnectTimer !== null };
  }
}

describe('async gateway lifecycle', () => {
  for (const operation of ['identify', 'resume'] as const) {
    for (const result of [null, { token: 'retired' }]) {
      it(`ignores retired ${operation} ${result ? 'success' : 'failure'} after reconnect`, async (t) => {
        const bridge = new AsyncGateway('qq', settings('qq'));
        const sockets = installSockets(bridge);
        t.after(() => bridge.stop());
        await bridge.start();
        if (operation === 'resume') ready(sockets[0], 'old-session');
        const pending = deferred<Record<string, unknown> | null>();
        bridge.auth = pending.promise;
        sockets[0].frame(hello);
        await bridge.reconnect();
        ready(sockets[1]);
        const before = bridge.lifecycle();
        pending.resolve(result);
        await settle();
        assert.deepEqual(sockets[1].closed, []);
        assert.deepEqual(sockets[1].sent, []);
        assert.deepEqual(bridge.lifecycle(), before);
        bridge.auth = Promise.resolve({ token: 'current' });
        sockets[1].frame(hello);
        await settle();
        assert.deepEqual(sockets[1].sent, [{ op: 6, d: { token: 'current' } }]);
      });
    }
  }

  it('does not create a socket when a gateway request completes after stop', async (t) => {
    const bridge = new AsyncGateway('qq', settings('qq'));
    const sockets = installSockets(bridge);
    t.after(() => bridge.stop());
    const pending = deferred<string | null>();
    bridge.gateway = pending.promise;
    const starting = bridge.start();
    await bridge.stop();
    const stopped = bridge.getStatus();
    pending.resolve('wss://retired.invalid');
    await starting;
    assert.equal(sockets.length, 0);
    assert.deepEqual(bridge.getStatus(), stopped);
  });

  for (const result of [null, 'wss://retired.invalid']) {
    it(`ignores an older gateway ${result ? 'success' : 'failure'} after stop/start`, async (t) => {
      const bridge = new AsyncGateway('qq', settings('qq'));
      const sockets = installSockets(bridge);
      t.after(() => bridge.stop());
      const pending = deferred<string | null>();
      bridge.gateway = pending.promise;
      const starting = bridge.start();
      await bridge.stop();
      bridge.gateway = Promise.resolve('wss://current.invalid');
      await bridge.start();
      ready(sockets[0]);
      pending.resolve(result);
      await starting;
      assert.equal(sockets.length, 1);
      assert.deepEqual(bridge.lifecycle(), { session: 'current-session', seq: 42, retry: false });
    });
  }
});

type Reply = { statusCode: number; data: Record<string, unknown> };

function mockHttp(t: TestContext): MockAgent {
  const previous = getGlobalDispatcher();
  const agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  t.after(async () => {
    setGlobalDispatcher(previous);
    await agent.close();
  });
  return agent;
}

function deferredReply(agent: MockAgent, origin: string, path: string, method = 'GET') {
  const pending = deferred<Reply>();
  const entered = deferred<void>();
  agent
    .get(origin)
    .intercept({ path, method })
    .reply(() => {
      entered.resolve();
      return pending.promise;
    });
  return { ...pending, entered: entered.promise };
}

const platforms = [
  {
    name: 'discord',
    Bridge: DiscordBotBridge,
    origin: 'https://discord.com',
    path: '/api/v10/gateway/bot',
  },
  { name: 'qq', Bridge: QQBotBridge, origin: 'https://api.sgroup.qq.com', path: '/gateway/bot' },
  {
    name: 'dingtalk',
    Bridge: DingTalkBotBridge,
    origin: 'https://api.dingtalk.com',
    path: '/v1.0/gateway/connections/open',
  },
] as const;

function tokenReply(
  agent: MockAgent,
  platform: 'qq' | 'dingtalk',
  token = 'current',
  expires = 7200,
) {
  const origin = platform === 'qq' ? 'https://bots.qq.com' : 'https://oapi.dingtalk.com';
  const path =
    platform === 'qq'
      ? '/app/getAppAccessToken'
      : '/gettoken?appkey=fixture-app&appsecret=fixture-secret';
  const method = platform === 'qq' ? 'POST' : 'GET';
  agent
    .get(origin)
    .intercept({ path, method })
    .reply(200, { access_token: token, expires_in: expires });
}

function gatewayReply(platform: 'qq' | 'discord' | 'dingtalk'): Reply {
  return {
    statusCode: 200,
    data:
      platform === 'dingtalk'
        ? { endpoint: 'wss://fixture.invalid', ticket: 'fixture-ticket' }
        : { url: 'wss://fixture.invalid' },
  };
}

describe('provider HTTP handshake lifecycle', () => {
  for (const platform of platforms) {
    it(`${platform.name} still reports current gateway failure and reconnects`, async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const agent = mockHttp(t);
      const bridge = new platform.Bridge(platform.name, settings(platform.name));
      const sockets = installSockets(bridge);
      t.after(() => bridge.stop());
      if (platform.name !== 'discord') tokenReply(agent, platform.name);
      const method = platform.name === 'dingtalk' ? 'POST' : 'GET';
      agent.get(platform.origin).intercept({ path: platform.path, method }).reply(503, {});
      await bridge.start();
      assert.equal(sockets.length, 0);
      assert.equal(bridge.getStatus().readiness, 'configured');
      assert.equal(
        bridge.getStatus().reason,
        platform.name === 'dingtalk' ? 'connections-open-503' : 'gateway-bot-503',
      );
      const retry = deferredReply(agent, platform.origin, platform.path, method);
      t.mock.timers.tick(1_000);
      await retry.entered;
      retry.resolve(gatewayReply(platform.name));
      await settle();
      assert.equal(sockets.length, 1);
      ready(sockets[0]);
      assert.equal(bridge.getStatus().readiness, 'operational');
    });

    for (const restart of [false, true]) {
      for (const outcome of ['success', 'http failure', 'network failure'] as const) {
        it(`${platform.name} discards gateway ${outcome} after ${restart ? 'stop/start' : 'stop'}`, async (t) => {
          const agent = mockHttp(t);
          const bridge = new platform.Bridge(platform.name, settings(platform.name));
          const sockets = installSockets(bridge);
          t.after(() => bridge.stop());
          if (platform.name !== 'discord') tokenReply(agent, platform.name);
          const method = platform.name === 'dingtalk' ? 'POST' : 'GET';
          const pending = deferredReply(agent, platform.origin, platform.path, method);
          const starting = bridge.start();
          await pending.entered;
          await bridge.stop();
          if (restart) {
            const reply = gatewayReply(platform.name);
            agent
              .get(platform.origin)
              .intercept({ path: platform.path, method })
              .reply(reply.statusCode, reply.data);
            await bridge.start();
            ready(sockets[0]);
          }
          const before = bridge.getStatus();
          const statuses: unknown[] = [];
          bridge.on('statusChange', (status: unknown) => statuses.push(status));
          if (outcome === 'network failure') pending.reject(new Error('retired HTTP failure'));
          else
            pending.resolve(
              outcome === 'success' ? gatewayReply(platform.name) : { statusCode: 503, data: {} },
            );
          await starting;
          assert.equal(sockets.length, restart ? 1 : 0);
          assert.deepEqual(bridge.getStatus(), before);
          assert.deepEqual(statuses, []);
        });
      }
    }
  }

  for (const platform of platforms.filter((p) => p.name !== 'discord')) {
    for (const outcome of ['success', 'failure'] as const) {
      it(`${platform.name} discards token ${outcome} from a retired start`, async (t) => {
        const agent = mockHttp(t);
        const bridge = new platform.Bridge(platform.name, settings(platform.name));
        const sockets = installSockets(bridge);
        t.after(() => bridge.stop());
        const isQQ = platform.name === 'qq';
        const pending = deferredReply(
          agent,
          isQQ ? 'https://bots.qq.com' : 'https://oapi.dingtalk.com',
          isQQ ? '/app/getAppAccessToken' : '/gettoken?appkey=fixture-app&appsecret=fixture-secret',
          isQQ ? 'POST' : 'GET',
        );
        const starting = bridge.start();
        await pending.entered;
        await bridge.stop();
        tokenReply(agent, platform.name);
        const reply = gatewayReply(platform.name);
        const headers: Record<string, string> = isQQ
          ? { authorization: 'QQBot current' }
          : { 'x-acs-dingtalk-access-token': 'current' };
        agent
          .get(platform.origin)
          .intercept({ path: platform.path, method: isQQ ? 'GET' : 'POST', headers })
          .reply(reply.statusCode, reply.data)
          .times(2);
        await bridge.start();
        ready(sockets[0]);
        const before = bridge.getStatus();
        pending.resolve(
          outcome === 'success'
            ? { statusCode: 200, data: { access_token: 'retired', expires_in: 7200 } }
            : { statusCode: 401, data: { errcode: 1, errmsg: 'retired token failure' } },
        );
        await starting;
        assert.equal(sockets.length, 1);
        assert.deepEqual(bridge.getStatus(), before);
        await bridge.stop();
        await bridge.start();
        assert.equal(sockets.length, 2, 'a later start still uses the current cached token');
      });
    }
  }
});

describe('QQ async authentication lifecycle', () => {
  for (const operation of ['identify', 'resume'] as const) {
    for (const outcome of ['success', 'http failure', 'network failure'] as const) {
      it(`discards retired ${operation} token ${outcome} after stop/start`, async (t) => {
        const agent = mockHttp(t);
        const bridge = new QQBotBridge('qq', settings('qq'));
        const sockets = installSockets(bridge);
        t.after(() => bridge.stop());
        // A short-lived token forces the HELLO auth path to refresh it.
        tokenReply(agent, 'qq', 'expiring', 1);
        agent
          .get('https://api.sgroup.qq.com')
          .intercept({ path: '/gateway/bot' })
          .reply(200, { url: 'wss://fixture.invalid' })
          .times(2);
        await bridge.start();
        if (operation === 'resume') ready(sockets[0], 'old-session');
        const pending = deferredReply(
          agent,
          'https://bots.qq.com',
          '/app/getAppAccessToken',
          'POST',
        );
        sockets[0].frame(hello);
        await pending.entered;
        await bridge.stop();
        tokenReply(agent, 'qq');
        await bridge.start();
        ready(sockets[1]);
        const before = bridge.getStatus();
        if (outcome === 'network failure') pending.reject(new Error('retired auth failure'));
        else
          pending.resolve(
            outcome === 'success'
              ? { statusCode: 200, data: { access_token: 'retired', expires_in: 7200 } }
              : { statusCode: 401, data: {} },
          );
        await settle();
        assert.deepEqual(bridge.getStatus(), before);
        assert.deepEqual(sockets[1].closed, []);
        assert.deepEqual(sockets[1].sent, []);
        sockets[1].frame(hello);
        await settle();
        assert.deepEqual(sockets[1].sent, [
          {
            op: 6,
            d: {
              token: 'QQBot current',
              session_id: 'current-session',
              seq: 42,
            },
          },
        ]);
      });
    }
  }
});
