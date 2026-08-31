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
import type { WebSocket } from 'undici';
import { createDefaultBotChannel } from '@maka/core/settings';
import { GatewayBridgeBase } from '../gateway-bridge-base.js';
import { reconnectBackoffMs, type WsCloseDecision } from '../ws-bridge-base.js';

/** Large enough that no scheduled heartbeat fires while a test is live. */
const HELLO_INTERVAL_MS = 3_600_000;

/** Let the async identify/resume wrappers flush before asserting frames. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

class FakeWebSocket {
  readyState = 1;
  sent: string[] = [];
  closed: Array<number | undefined> = [];
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number): void {
    this.closed.push(code);
    this.readyState = 3;
    // Real sockets deliver the close event asynchronously, after the
    // caller has finished detaching them (queueMicrotask so the
    // bridge's synchronous forceReconnect/stop completes first).
    queueMicrotask(() => {
      this.emit('close', { code: code ?? 1005, reason: '' });
    });
  }
}

class TestGatewayBridge extends GatewayBridgeBase {
  readonly fake = new FakeWebSocket();
  identifyCalls = 0;
  resumeCalls = 0;
  dispatches: Array<{ type: string; d: unknown }> = [];
  fetchCalls = 0;
  gatewayUrl: string | null = 'wss://gateway.example.invalid';

  protected override createWebSocket(): WebSocket {
    return this.fake as unknown as WebSocket;
  }

  protected override async fetchGatewayUrl(): Promise<string | null> {
    this.fetchCalls += 1;
    return this.gatewayUrl;
  }

  protected override checkCredentials(): string | null {
    return null;
  }

  protected override buildIdentifyPayload(): Record<string, unknown> | null {
    this.identifyCalls += 1;
    return { token: 'test-identify' };
  }

  protected override buildResumePayload(): Record<string, unknown> | null {
    this.resumeCalls += 1;
    return { token: 'test-resume' };
  }

  protected override onDispatch(type: string, d: unknown): void {
    this.dispatches.push({ type, d });
    if (type === 'READY') {
      this.sessionId = (d as { session_id?: unknown }).session_id as string;
      this.promoteToOperational();
    }
  }

  protected override decideClose(code: number, explicitlyStopped: boolean): WsCloseDecision {
    if (explicitlyStopped) return { kind: 'stopped' };
    if (code === 4004) return { kind: 'fatal', code };
    const resumable = code !== 1000 && code !== 1001;
    return { kind: 'reconnect', resumable };
  }

  getSessionState(): { sessionId: string | null; seq: number | null } {
    return { sessionId: this.sessionId, seq: this.seq };
  }

  hasReconnectTimer(): boolean {
    return this.reconnectTimer !== null;
  }

  getReconnectAttempts(): number {
    return this.reconnectAttempts;
  }

  getHeartbeatInterval(): number {
    return this.heartbeatInterval;
  }

  hasInitialHeartbeatTimer(): boolean {
    return this.heartbeatInitialTimer !== null;
  }

  hasHeartbeatTimers(): boolean {
    return this.heartbeatInitialTimer !== null || this.heartbeatTimer !== null;
  }
}

function botSettings() {
  return {
    ...createDefaultBotChannel('qq'),
    enabled: true,
    token: 'token',
    appId: 'app-id',
    appSecret: 'app-secret',
  };
}

async function startBridge(
  platform: 'qq' | 'discord' = 'qq',
): Promise<{ bridge: TestGatewayBridge; fake: FakeWebSocket }> {
  const bridge = new TestGatewayBridge(platform, botSettings());
  await bridge.start();
  return { bridge, fake: bridge.fake };
}

function sendFrame(fake: FakeWebSocket, payload: unknown): void {
  fake.emit('message', { data: JSON.stringify(payload) });
}

function receiveReady(fake: FakeWebSocket): void {
  sendFrame(fake, { op: 0, t: 'READY', s: 12, d: { session_id: 'sess-1' } });
}

describe('reconnectBackoffMs (shared backoff)', () => {
  it('grows exponentially from the floor and caps at the ceiling', () => {
    assert.equal(reconnectBackoffMs(0), 1_000);
    assert.equal(reconnectBackoffMs(1), 2_000);
    assert.equal(reconnectBackoffMs(2), 4_000);
    assert.equal(reconnectBackoffMs(4), 16_000);
    assert.equal(reconnectBackoffMs(5), 30_000);
    assert.equal(reconnectBackoffMs(50), 30_000);
  });
});

describe('GatewayBridgeBase start gate', () => {
  it('does not open a connection when the channel is disabled', async () => {
    const bridge = new TestGatewayBridge('qq', {
      ...createDefaultBotChannel('qq'),
      enabled: false,
      token: 'token',
    });
    await bridge.start();
    assert.equal(bridge.getStatus().reason, 'disabled');
    assert.equal(bridge.fetchCalls, 0);
  });

  it('does not open a connection when credentials are missing', async () => {
    class NoCredentialsBridge extends TestGatewayBridge {
      protected override checkCredentials(): string | null {
        return 'no-credentials';
      }
    }
    const bridge = new NoCredentialsBridge('qq', {
      ...createDefaultBotChannel('qq'),
      enabled: true,
      token: 'token',
    });
    await bridge.start();
    assert.equal(bridge.getStatus().reason, 'no-credentials');
    assert.equal(bridge.getStatus().readiness, 'scaffolded');
    assert.equal(bridge.fetchCalls, 0);
  });

  it('reports as gateway connection kind once connected', async () => {
    const { bridge, fake } = await startBridge('discord');
    fake.emit('open', {});
    assert.equal(bridge.isRunning(), true);
    assert.equal(bridge.getStatus().connection, 'gateway');
    await bridge.stop();
  });
});

describe('GatewayBridgeBase hello / identify / resume', () => {
  it('identifies on HELLO when no session exists', async () => {
    const { bridge, fake } = await startBridge();
    sendFrame(fake, { op: 10, d: { heartbeat_interval: HELLO_INTERVAL_MS } });
    await settle();
    assert.equal(bridge.identifyCalls, 1);
    assert.equal(bridge.resumeCalls, 0);
    assert.deepEqual(JSON.parse(fake.sent[0]!), { op: 2, d: { token: 'test-identify' } });
    await bridge.stop();
  });

  it('resumes on HELLO once READY established a session', async () => {
    const { bridge, fake } = await startBridge();
    receiveReady(fake);
    assert.deepEqual(bridge.getSessionState(), { sessionId: 'sess-1', seq: 12 });
    assert.equal(bridge.getStatus().readiness, 'operational');
    sendFrame(fake, { op: 10, d: { heartbeat_interval: HELLO_INTERVAL_MS } });
    await settle();
    assert.equal(bridge.identifyCalls, 0);
    assert.equal(bridge.resumeCalls, 1);
    assert.deepEqual(JSON.parse(fake.sent[0]!), { op: 6, d: { token: 'test-resume' } });
    await bridge.stop();
  });
});

describe('GatewayBridgeBase inbound dispatch', () => {
  it('forwards DISPATCH events with type and payload', async () => {
    const { bridge, fake } = await startBridge();
    sendFrame(fake, { op: 0, t: 'MESSAGE_CREATE', d: { id: 'm-1' } });
    assert.deepEqual(bridge.dispatches.at(-1), { type: 'MESSAGE_CREATE', d: { id: 'm-1' } });
    await bridge.stop();
  });

  it('ignores frames that are not valid JSON', async () => {
    const { bridge, fake } = await startBridge();
    fake.emit('message', { data: 'not-json{' });
    assert.equal(bridge.dispatches.length, 0);
    await bridge.stop();
  });

  it('answers a server-requested heartbeat with the current seq', async () => {
    const { bridge, fake } = await startBridge();
    receiveReady(fake);
    fake.sent.length = 0;
    sendFrame(fake, { op: 1 });
    assert.equal(fake.sent.length, 1);
    assert.deepEqual(JSON.parse(fake.sent[0]!), { op: 1, d: 12 });
    await bridge.stop();
  });
});

describe('GatewayBridgeBase reconnect triggers', () => {
  it('force-reconnects when a heartbeat fires before the previous ack', async () => {
    const { bridge, fake } = await startBridge();
    sendFrame(fake, { op: 1 });
    assert.equal(fake.sent.length, 1);
    sendFrame(fake, { op: 1 });
    assert.equal(fake.sent.length, 1);
    assert.equal(fake.closed.length, 1);
    assert.equal(bridge.hasReconnectTimer(), true);
    await bridge.stop();
  });

  it('clears the session on non-resumable INVALID_SESSION and keeps it on resumable', async () => {
    const { bridge, fake } = await startBridge();
    receiveReady(fake);
    sendFrame(fake, { op: 9, d: true });
    assert.deepEqual(bridge.getSessionState(), { sessionId: 'sess-1', seq: 12 });
    assert.equal(bridge.hasReconnectTimer(), true);
    await bridge.stop();

    const second = await startBridge();
    receiveReady(second.fake);
    sendFrame(second.fake, { op: 9, d: false });
    assert.deepEqual(second.bridge.getSessionState(), { sessionId: null, seq: null });
    await second.bridge.stop();
  });

  it('schedules a reconnect when the gateway url fetch fails', async () => {
    const bridge = new TestGatewayBridge('qq', {
      ...createDefaultBotChannel('qq'),
      enabled: true,
      token: 'token',
    });
    bridge.gatewayUrl = null;
    await bridge.start();
    assert.equal(bridge.fetchCalls, 1);
    assert.equal(bridge.hasReconnectTimer(), true);
    await bridge.stop();
  });

  it('schedules a reconnect when constructing the socket throws', async () => {
    class ThrowingSocketBridge extends TestGatewayBridge {
      protected override createWebSocket(): WebSocket {
        throw new Error('bad-url');
      }
    }
    const bridge = new ThrowingSocketBridge('qq', {
      ...createDefaultBotChannel('qq'),
      enabled: true,
      token: 'token',
    });
    await bridge.start();
    assert.equal(bridge.getStatus().reason, 'bad-url');
    assert.equal(bridge.getStatus().readiness, 'configured');
    assert.equal(bridge.hasReconnectTimer(), true);
    await bridge.stop();
  });
});

describe('GatewayBridgeBase close policy', () => {
  it('treats a fatal close as terminal: no reconnect, session dropped', async () => {
    const { bridge, fake } = await startBridge();
    receiveReady(fake);
    fake.emit('close', { code: 4004, reason: 'authentication failed' });
    const status = bridge.getStatus();
    assert.equal(status.readiness, 'configured');
    assert.equal(status.reason, 'gateway-closed-4004');
    assert.deepEqual(bridge.getSessionState(), { sessionId: null, seq: null });
    assert.equal(bridge.hasReconnectTimer(), false);
  });

  it('reconnects resumably after an abnormal close, keeping the session', async () => {
    const { bridge, fake } = await startBridge();
    receiveReady(fake);
    fake.emit('close', { code: 4000, reason: 'please reconnect' });
    assert.equal(bridge.getStatus().reason, 'please reconnect');
    assert.equal(bridge.getStatus().readiness, 'degraded');
    assert.deepEqual(bridge.getSessionState(), { sessionId: 'sess-1', seq: 12 });
    assert.equal(bridge.hasReconnectTimer(), true);
    await bridge.stop();
  });

  it('drops the session after a clean close and still reconnects', async () => {
    const { bridge, fake } = await startBridge();
    receiveReady(fake);
    fake.emit('close', { code: 1000, reason: '' });
    assert.equal(bridge.getStatus().reason, 'gateway-closed-1000');
    assert.deepEqual(bridge.getSessionState(), { sessionId: null, seq: null });
    assert.equal(bridge.hasReconnectTimer(), true);
    await bridge.stop();
  });

  it('ignores closes that arrive after an explicit stop', async () => {
    const { bridge, fake } = await startBridge();
    await bridge.stop();
    fake.emit('close', { code: 4000, reason: '' });
    assert.equal(bridge.getStatus().reason, 'stopped');
    assert.equal(bridge.isRunning(), false);
    assert.equal(bridge.hasReconnectTimer(), false);
  });
});

describe('review hardening: HELLO interval validation', () => {
  it('falls back to the default interval when HELLO omits heartbeat_interval', async () => {
    const { bridge, fake } = await startBridge();
    const before = bridge.getHeartbeatInterval();
    sendFrame(fake, { op: 10, d: {} });
    await settle();
    assert.equal(bridge.getHeartbeatInterval(), before);
    assert.equal(bridge.identifyCalls, 1);
    await bridge.stop();
  });

  it('falls back to the default interval when HELLO has no payload at all', async () => {
    const { bridge, fake } = await startBridge();
    const before = bridge.getHeartbeatInterval();
    sendFrame(fake, { op: 10 });
    await settle();
    assert.equal(bridge.getHeartbeatInterval(), before);
    await bridge.stop();
  });

  it('accepts a valid HELLO interval', async () => {
    const { bridge, fake } = await startBridge();
    sendFrame(fake, { op: 10, d: { heartbeat_interval: 5_000 } });
    assert.equal(bridge.getHeartbeatInterval(), 5_000);
    await bridge.stop();
  });
});

describe('review hardening: null auth payloads', () => {
  it('force-reconnects without the session when the identify payload is null', async () => {
    class NullIdentifyBridge extends TestGatewayBridge {
      protected override buildIdentifyPayload(): Record<string, unknown> | null {
        return null;
      }
    }
    const bridge = new NullIdentifyBridge('qq', botSettings());
    await bridge.start();
    sendFrame(bridge.fake, { op: 10, d: { heartbeat_interval: HELLO_INTERVAL_MS } });
    await settle();
    assert.equal(bridge.fake.closed.length, 1);
    assert.equal(bridge.hasReconnectTimer(), true);
    assert.equal(bridge.getReconnectAttempts(), 1);
    await bridge.stop();
  });

  it('force-reconnects keeping the session when the resume payload is null', async () => {
    class NullResumeBridge extends TestGatewayBridge {
      protected override buildResumePayload(): Record<string, unknown> | null {
        return null;
      }
    }
    const bridge = new NullResumeBridge('qq', botSettings());
    await bridge.start();
    receiveReady(bridge.fake);
    sendFrame(bridge.fake, { op: 10, d: { heartbeat_interval: HELLO_INTERVAL_MS } });
    await settle();
    assert.deepEqual(bridge.getSessionState(), { sessionId: 'sess-1', seq: 12 });
    assert.equal(bridge.fake.closed.length, 1);
    assert.equal(bridge.getReconnectAttempts(), 1);
    await bridge.stop();
  });
});

describe('review hardening: jitter timeout ownership', () => {
  it('cancels a pending jitter timeout on stop', async () => {
    const { bridge, fake } = await startBridge();
    sendFrame(fake, { op: 10, d: { heartbeat_interval: HELLO_INTERVAL_MS } });
    assert.equal(bridge.hasInitialHeartbeatTimer(), true);
    await bridge.stop();
    assert.equal(bridge.hasHeartbeatTimers(), false);
  });
});

describe('review hardening: detached socket close events', () => {
  it('ignores the late close event from a socket forceReconnect already closed', async () => {
    const { bridge, fake } = await startBridge();
    receiveReady(fake);
    sendFrame(fake, { op: 1 });
    sendFrame(fake, { op: 1 });
    assert.equal(bridge.getReconnectAttempts(), 1);
    assert.equal(bridge.getStatus().readiness, 'operational');
    await settle();
    assert.equal(bridge.getReconnectAttempts(), 1);
    assert.deepEqual(bridge.getSessionState(), { sessionId: 'sess-1', seq: 12 });
    assert.equal(bridge.getStatus().readiness, 'operational');
    assert.equal(bridge.getStatus().reason, undefined);
    await bridge.stop();
  });

  it('ignores the late close event that fires after an explicit stop', async () => {
    const { bridge } = await startBridge();
    await bridge.stop();
    await settle();
    assert.equal(bridge.getStatus().reason, 'stopped');
    assert.equal(bridge.hasReconnectTimer(), false);
  });
});
