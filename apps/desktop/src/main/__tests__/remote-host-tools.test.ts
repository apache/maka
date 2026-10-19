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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RemoteHostToolsBridge } from '../remote-host-tools.js';
function setup() {
  const calls: { host: string; input: any }[] = [];
  let online = true,
    accepted = true,
    ackFails = false;
  const pending = [{ id: 'event-1', sessionId: 'owner', content: { text: 'done' } }];
  const targets = ['main', 'remote'].map((host) => ({
    hostId: host,
    epoch: host,
    readiness: 'ready',
    target: { profile: { name: host } },
    candidate: {
      client: {
        request: async (_op: string, input: any) => {
          calls.push({ host, input });
          if (input.action === 'origin') return { value: { sessionId: 'owner' } };
          if (input.action === 'events') return { value: host === 'remote' ? [...pending] : [] };
          if (input.action === 'deliver') return { value: { accepted } };
          if (input.action === 'ack') {
            if (ackFails) throw Error('disconnect');
            pending.splice(0);
          }
          return { value: { ok: true } };
        },
      },
    },
  }));
  const bridge = new RemoteHostToolsBridge(
    () =>
      ({
        entries: () => (online ? targets : [targets[0]]),
        ownsScope: (s: any) => s.hostId === 'main' && s.targetEpoch === 'main',
      }) as any,
  );
  return {
    bridge,
    calls,
    pending,
    tools: bridge.tools({ hostId: 'main', targetEpoch: 'main' }),
    offline: () => {
      online = false;
    },
    accept: (v: boolean) => {
      accepted = v;
    },
    failAck: (v: boolean) => {
      ackFails = v;
    },
  };
}
test('remote tools bind the origin and stable target, never default Host', async () => {
  const f = setup();
  try {
    const open = f.tools.find((t) => t.name === 'RemoteHostOpen')!;
    await open.impl({ hostId: 'remote', templateSession: 'template' }, {
      sessionId: 'bot-worker',
    } as any);
    assert.equal(f.calls[1].host, 'remote');
    assert.equal(f.calls[1].input.originSession, 'owner');
    await assert.rejects(
      async () =>
        open.impl({ hostId: 'main', templateSession: 'template' }, {
          sessionId: 'bot-worker',
        } as any),
      /local tools/,
    );
    await f.tools
      .find((t) => t.name === 'RemoteToolSearch')!
      .impl({ hostId: 'remote', contextId: 'context', query: '' }, {
        sessionId: 'bot-worker',
      } as any);
    assert.deepEqual(f.calls.at(-1)!.input.origin, { hostId: 'main', sessionId: 'owner' });
    f.offline();
    await assert.rejects(
      async () =>
        open.impl({ hostId: 'remote', templateSession: 'template' }, {
          sessionId: 'bot-worker',
        } as any),
      /offline/,
    );
  } finally {
    f.bridge.close();
  }
});
test('feedback is acknowledged only after durable Inbox acceptance; lost acknowledgement retries same identity', async () => {
  const f = setup();
  try {
    f.accept(false);
    await f.bridge.poll();
    assert.equal(f.pending.length, 1);
    f.accept(true);
    f.failAck(true);
    await f.bridge.poll();
    assert.equal(f.pending.length, 1);
    f.failAck(false);
    await f.bridge.poll();
    assert.equal(f.pending.length, 0);
    const delivered = f.calls.filter((c) => c.input.action === 'deliver');
    assert.equal(new Set(delivered.map((c) => c.input.id)).size, 1);
    assert.equal(delivered[0].input.content.hostId, 'remote');
  } finally {
    f.bridge.close();
  }
});
test('stale origin scope cannot start remote work', async () => {
  const f = setup();
  try {
    const tools = f.bridge.tools({ hostId: 'main', targetEpoch: 'expired' });
    await assert.rejects(
      async () => tools.find((t) => t.name === 'HostList')!.impl({}, {} as any),
      /unavailable/,
    );
    assert.equal(f.calls.length, 0);
  } finally {
    f.bridge.close();
  }
});

test('a stalled Host cannot block another Host feedback; every request has a transport deadline', async () => {
  const delivered: string[] = [];
  const timeouts: number[] = [];
  let slowFinished = false;
  const targets = ['main', 'slow', 'healthy'].map((hostId) => ({
    hostId, readiness: 'ready', target: { profile: { name: hostId } }, candidate: { client: {
      request: async (_op: string, input: any, timeoutMs: number) => {
        timeouts.push(timeoutMs);
        if (hostId === 'slow') {
          await new Promise((resolve) => setTimeout(resolve, timeoutMs));
          slowFinished = true;
          throw Error('request_timeout');
        }
        if (input.action === 'events') return { value: hostId === 'healthy' && input.originHost === 'main' ? [{ id: 'ok', sessionId: 'bot', content: { text: 'ready' } }] : [] };
        if (input.action === 'deliver') {
          assert.equal(slowFinished, false, 'healthy feedback must not wait for the stalled Host');
          delivered.push(input.id);
          return { value: { accepted: true } };
        }
        return { value: {} };
      },
    } },
  }));
  const bridge = new RemoteHostToolsBridge(() => ({ entries: () => targets }) as any, 50);
  try {
    await bridge.poll();
    assert.deepEqual(delivered, ['remote:healthy:ok']);
    assert.ok(timeouts.length > 0 && timeouts.every((ms) => ms === 50));
  } finally { bridge.close(); }
});

test('a rejected event does not hide later feedback and failed calls retain retry identity', async () => {
  const delivered: string[] = [];
  const targets = ['main', 'remote'].map((hostId) => ({ hostId, readiness: 'ready', candidate: { client: {
    request: async (_op: string, input: any) => {
      if (input.action === 'origin') return { value: { sessionId: 'bot' } };
      if (input.action === 'call') throw Error('connection lost after dispatch');
      if (input.action === 'events') return { value: hostId === 'remote' ? [
        { id: 'bad', sessionId: 'old', content: {} }, { id: 'good', sessionId: 'bot', content: {} },
      ] : [] };
      if (input.action === 'deliver') {
        if (input.sessionId === 'old') throw Error('conversation unavailable');
        delivered.push(input.id);
        return { value: { accepted: true } };
      }
      return { value: {} };
    },
  } } }));
  const bridge = new RemoteHostToolsBridge(() => ({ entries: () => targets, ownsScope: () => true }) as any);
  try {
    await bridge.poll();
    assert.deepEqual(delivered, ['remote:remote:good']);
    const call = bridge.tools({ hostId: 'main', targetEpoch: 'e' }).find((t) => t.name === 'RemoteToolCall')!;
    await assert.rejects(async () => call.impl({ hostId: 'remote', contextId: 'ctx', callId: 'stable-id', tool: 'Write', arguments: {} }, { sessionId: 'bot' } as any), /callId=stable-id.*RemoteToolResult.*SAME/);
  } finally { bridge.close(); }
});
