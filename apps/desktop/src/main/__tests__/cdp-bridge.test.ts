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

/**
 * CdpBridge security + relay contract. Ported from PawWork (bun:test → node:test).
 * A stub `webContents.debugger` (EventEmitter) stands in for the real target, so
 * these run CI-safe without Electron; the live attach is covered by the GUI smoke.
 */

import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import { EventEmitter, once } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { WebContents } from 'electron';
import { type ClientOptions, WebSocket } from 'ws';
import { CdpBridge, CdpBridgeError } from '../browser/cdp-bridge.js';

// Stand-in for webContents.debugger: an EventEmitter that records sendCommand
// calls and lets a test drive its result and emit CDP messages/detach.
class MockDebugger extends EventEmitter {
  attached = false;
  calls: Array<{ method: string; params: unknown; sessionId?: string }> = [];
  impl: (method: string, params: unknown, sessionId?: string) => Promise<unknown> = async () => ({});
  isAttached() {
    return this.attached;
  }
  attach(_version?: string) {
    this.attached = true;
  }
  detach() {
    this.attached = false;
  }
  sendCommand(method: string, params?: unknown, sessionId?: string) {
    this.calls.push({ method, params, sessionId });
    this.emit('command');
    return this.impl(method, params, sessionId);
  }
}

class MockWebContents extends EventEmitter {
  destroyed = false;
  debugger = new MockDebugger();
  isDestroyed() {
    return this.destroyed;
  }
}

function makeWc() {
  const wc = new MockWebContents();
  return { wc, asWebContents: wc as unknown as WebContents };
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function startBridge(wc: WebContents) {
  const bridge = new CdpBridge(wc);
  const endpoint = await bridge.start();
  cleanups.push(() => bridge.stop());
  return { bridge, cdpEndpoint: endpoint.cdpEndpoint };
}

function open(url: string, opts?: ClientOptions): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, opts);
    let settled = false;
    // Persistent error handler: a rejected upgrade (and teardown-time resets)
    // emit 'error' — keep listening so none of them surface as unhandled.
    ws.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    ws.on('open', () => {
      if (settled) return;
      settled = true;
      cleanups.push(() => ws.terminate());
      resolve(ws);
    });
  });
}

function nextMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => ws.once('message', (data) => resolve(JSON.parse(String(data)))));
}

function waitForCommand(debuggerEmitter: EventEmitter): Promise<unknown[]> {
  return once(debuggerEmitter, 'command', { signal: AbortSignal.timeout(2_000) });
}

function withDifferentSecret(endpoint: string): string {
  return endpoint.replace(/\/[^/]+$/, '/0000000000000000');
}

describe('CdpBridge', () => {
  it('relays a CDP command to the debugger and returns its result', async () => {
    const { wc, asWebContents } = makeWc();
    wc.debugger.impl = async () => ({ result: { value: 42 } });
    const { cdpEndpoint } = await startBridge(asWebContents);
    const ws = await open(cdpEndpoint);
    ws.send(JSON.stringify({ id: 7, method: 'Runtime.evaluate', params: { expression: '6*7' } }));
    const msg = await nextMessage(ws);
    assert.equal(msg.id, 7);
    assert.deepEqual(msg.result, { result: { value: 42 } });
    assert.equal(wc.debugger.calls[0]?.method, 'Runtime.evaluate');
  });

  it('forwards debugger events to the client', async () => {
    const { wc, asWebContents } = makeWc();
    const { cdpEndpoint } = await startBridge(asWebContents);
    const ws = await open(cdpEndpoint);
    const received = nextMessage(ws);
    wc.debugger.emit('message', {}, 'Page.frameNavigated', { frame: { id: 'x' } }, '');
    const msg = await received;
    assert.equal(msg.method, 'Page.frameNavigated');
    assert.deepEqual(msg.params, { frame: { id: 'x' } });
  });

  it('surfaces a debugger command error as a CDP error response', async () => {
    const { wc, asWebContents } = makeWc();
    wc.debugger.impl = async () => {
      throw new Error('boom');
    };
    const { cdpEndpoint } = await startBridge(asWebContents);
    const ws = await open(cdpEndpoint);
    ws.send(JSON.stringify({ id: 1, method: 'Page.navigate', params: {} }));
    const msg = (await nextMessage(ws)) as { id: number; error: { message: string } };
    assert.equal(msg.id, 1);
    assert.equal(msg.error.message, 'boom');
  });

  it('a query string after the secret path does not break authorization', async () => {
    const { asWebContents } = makeWc();
    const { cdpEndpoint } = await startBridge(asWebContents);
    const ws = await open(`${cdpEndpoint}?v=1`);
    assert.equal(ws.readyState, WebSocket.OPEN);
  });

  it('rejects a wrong secret at the upgrade', async () => {
    const { asWebContents } = makeWc();
    const { cdpEndpoint } = await startBridge(asWebContents);
    await assert.rejects(open(withDifferentSecret(cdpEndpoint)));
  });

  it('a rejected wrong-secret attempt does not consume the single slot', async () => {
    const { asWebContents } = makeWc();
    const { cdpEndpoint } = await startBridge(asWebContents);
    await assert.rejects(open(withDifferentSecret(cdpEndpoint)));
    const ws = await open(cdpEndpoint);
    assert.equal(ws.readyState, WebSocket.OPEN);
  });

  it('rejects a connection that carries a browser Origin', async () => {
    const { asWebContents } = makeWc();
    const { cdpEndpoint } = await startBridge(asWebContents);
    await assert.rejects(open(cdpEndpoint, { headers: { origin: 'https://evil.example' } }));
  });

  it('rejects a mismatched Host header (DNS-rebinding guard)', async () => {
    const { asWebContents } = makeWc();
    const { cdpEndpoint } = await startBridge(asWebContents);
    await assert.rejects(open(cdpEndpoint, { headers: { host: 'evil.example' } }));
  });

  it('allows only one connection at a time', async () => {
    const { asWebContents } = makeWc();
    const { cdpEndpoint } = await startBridge(asWebContents);
    const first = await open(cdpEndpoint);
    assert.equal(first.readyState, WebSocket.OPEN);
    await assert.rejects(open(cdpEndpoint));
  });

  it('stop() detaches the debugger and closes the connection', async () => {
    const { wc, asWebContents } = makeWc();
    const bridge = new CdpBridge(asWebContents);
    const { cdpEndpoint } = await bridge.start();
    cleanups.push(() => bridge.stop());
    const ws = await open(cdpEndpoint);
    const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));
    await bridge.stop();
    await closed;
    assert.equal(wc.debugger.attached, false);
  });

  it('teardown fails in-flight commands instead of leaving them to time out', async () => {
    const { wc, asWebContents } = makeWc();
    let release: (value: unknown) => void = () => {};
    // A command the debugger never answers on its own.
    wc.debugger.impl = () => new Promise((resolve) => (release = resolve));
    const { bridge, cdpEndpoint } = await startBridge(asWebContents);
    const ws = await open(cdpEndpoint);
    const errored = nextMessage(ws);
    const commandStarted = waitForCommand(wc.debugger);
    ws.send(JSON.stringify({ id: 99, method: 'Page.navigate', params: {} }));
    await commandStarted;
    await bridge.stop();
    const msg = (await errored) as { id: number; error?: { message: string } };
    assert.equal(msg.id, 99);
    assert.equal(msg.error?.message, 'bridge closed');
    release({}); // resolve the dangling promise so nothing leaks
  });

  it("teardown failure responses carry the command's sessionId", async () => {
    const { wc, asWebContents } = makeWc();
    let release: (value: unknown) => void = () => {};
    wc.debugger.impl = () => new Promise((resolve) => (release = resolve));
    const { bridge, cdpEndpoint } = await startBridge(asWebContents);
    const ws = await open(cdpEndpoint);
    const errored = nextMessage(ws);
    const commandStarted = waitForCommand(wc.debugger);
    ws.send(JSON.stringify({ id: 5, method: 'Page.navigate', params: {}, sessionId: 'session-a' }));
    await commandStarted;
    await bridge.stop();
    const msg = (await errored) as { id: number; sessionId?: string; error?: { message: string } };
    assert.equal(msg.id, 5);
    assert.equal(msg.sessionId, 'session-a');
    assert.equal(msg.error?.message, 'bridge closed');
    release({});
  });

  it('a reconnecting client reusing a command id never sees the previous client result', async () => {
    const { wc, asWebContents } = makeWc();
    const resolvers: Array<(value: unknown) => void> = [];
    wc.debugger.impl = () => new Promise((resolve) => resolvers.push(resolve));
    const { cdpEndpoint } = await startBridge(asWebContents);

    const first = await open(cdpEndpoint);
    const firstCommandStarted = waitForCommand(wc.debugger);
    first.send(JSON.stringify({ id: 1, method: 'Page.navigate', params: {} }));
    await firstCommandStarted;
    first.terminate();

    // The single slot frees only once the server has processed the close.
    let second: WebSocket | null = null;
    for (let attempt = 0; attempt < 50 && !second; attempt++) {
      second = await open(cdpEndpoint).catch(() => null);
      if (!second) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (!second) throw new Error('could not reconnect after terminate');

    const answered = nextMessage(second);
    const secondCommandStarted = waitForCommand(wc.debugger);
    second.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {} }));
    await secondCommandStarted;
    resolvers[0]?.({ stale: true }); // the dead connection's command completes late
    resolvers[1]?.({ fresh: true });
    const msg = (await answered) as { id: number; result: Record<string, unknown> };
    assert.equal(msg.id, 1);
    assert.deepEqual(msg.result, { fresh: true });
  });

  it('an external debugger detach tears the bridge down', async () => {
    const { wc, asWebContents } = makeWc();
    const { cdpEndpoint } = await startBridge(asWebContents);
    const ws = await open(cdpEndpoint);
    const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));
    // DevTools opening forcibly detaches the debugger.
    wc.debugger.emit('detach', {}, 'Target.detachedFromTarget');
    await closed;
    assert.ok(ws.readyState >= WebSocket.CLOSING);
  });

  it('concurrent start() calls share one bridge instead of misreporting target-busy', async () => {
    const { asWebContents } = makeWc();
    const bridge = new CdpBridge(asWebContents);
    cleanups.push(() => bridge.stop());
    const [first, second] = await Promise.all([bridge.start(), bridge.start()]);
    assert.equal(first.cdpEndpoint, second.cdpEndpoint);
  });

  it('stop() racing a start() in flight yields a typed error and a clean restart', async () => {
    const { asWebContents } = makeWc();
    const bridge = new CdpBridge(asWebContents);
    const racing = bridge.start(); // still awaiting its ws listen
    await bridge.stop();
    await assert.rejects(racing, CdpBridgeError);
    const endpoint = await bridge.start();
    cleanups.push(() => bridge.stop());
    const ws = await open(endpoint.cdpEndpoint);
    assert.equal(ws.readyState, WebSocket.OPEN);
  });

  it('destroying the WebContents tears the bridge down', async () => {
    const { wc, asWebContents } = makeWc();
    const { cdpEndpoint } = await startBridge(asWebContents);
    const ws = await open(cdpEndpoint);
    const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));
    // A directly destroyed WebContents is not guaranteed to emit a debugger
    // 'detach' first — the 'destroyed' listener must tear the bridge down.
    wc.destroyed = true;
    wc.emit('destroyed');
    await closed;
    assert.ok(ws.readyState >= WebSocket.CLOSING);
  });

  it('drops an authorized upgrade that races stop() nulling the ws server', async () => {
    const { asWebContents } = makeWc();
    const { bridge, cdpEndpoint } = await startBridge(asWebContents);
    const url = new URL(cdpEndpoint); // ws://127.0.0.1:<port>/<secret>
    // Simulate the teardown window: wss is nulled but the http 'upgrade'
    // listener is still live. An authorized upgrade must be destroyed, not
    // left half-open (neither adopted nor destroyed).
    const internals = bridge as unknown as {
      wss: unknown;
      socket: unknown;
      onUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
    };
    internals.wss = null;
    let destroyed = false;
    const socket = { destroy: () => (destroyed = true) } as unknown as Duplex;
    const req = { url: url.pathname, headers: { host: `127.0.0.1:${url.port}` } } as unknown as IncomingMessage;
    internals.onUpgrade(req, socket, Buffer.alloc(0));
    assert.equal(destroyed, true);
    assert.equal(internals.socket, null);
  });

  it('start() throws target-busy when the debugger is already attached', async () => {
    const { wc, asWebContents } = makeWc();
    wc.debugger.attached = true;
    const bridge = new CdpBridge(asWebContents);
    await assert.rejects(bridge.start(), CdpBridgeError);
  });

  it('start() throws target-destroyed for a gone WebContents', async () => {
    const { wc, asWebContents } = makeWc();
    wc.destroyed = true;
    const bridge = new CdpBridge(asWebContents);
    await assert.rejects(
      bridge.start(),
      (err: unknown) => err instanceof CdpBridgeError && err.code === 'target-destroyed',
    );
  });
});
