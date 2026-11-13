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

import test from 'node:test';
import assert from 'node:assert/strict';
import { intakeFixture } from './intake-fixture.js';

async function hint(f: any, id: string, direction: string) {
  f.add(id);
  await f.q.intake.collect();
  f.advance();
  f.ctx.llm.generate = async () => ({ text: JSON.stringify(direction) });
  await f.q.intake.judge();
}

/** The Host's durable message authority, reduced to what this regression needs: an
 * identity keeps the body it was first admitted with, an identical resubmission is
 * replayed instead of admitted twice, and any other body is a payload conflict. */
function host(f: any) {
  const receipts = new Map<string, string>();
  let unavailable = false;
  const bodies: string[] = [];
  let conflicts = 0;
  const followup = f.agent.followup;
  f.agent.followup = async (text: string, options?: { messageId?: string }) => {
    const id = options!.messageId!;
    const recorded = receipts.get(id);
    if (recorded !== undefined && recorded !== text) {
      conflicts++;
      return {
        disposition: 'rejected',
        error: { message: 'Durable message receipt has a different payload' },
      };
    }
    bodies.push(text);
    if (unavailable) throw Error('Host unavailable before admission');
    // A replayed receipt is not a new admission: the Host returns the first disposition
    // and starts no second turn.
    if (recorded !== undefined) return { disposition: 'turn_started', turnId: 'replayed' };
    receipts.set(id, text);
    return followup(text, options);
  };
  f.agent.messageExecution = async (messageId: string) => ({
    state: receipts.has(messageId) ? 'owned' : 'not_admitted',
  });
  return {
    bodies,
    conflicts: () => conflicts,
    unavailable: (value: boolean) => {
      unavailable = value;
    },
  };
}

/** Losing the lease stops the turn without writing a new pending activation, exactly like
 * a crash: the state is left with an active activation the next owner has to demote. */
function crash(f: any) {
  const whenIdle = f.agent.whenIdle;
  f.agent.whenIdle = (signal?: AbortSignal) =>
    new Promise<void>((_, reject) =>
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true }),
    );
  return {
    heal: () => {
      f.agent.whenIdle = whenIdle;
    },
  };
}

/** dispatch() starts the run instead of awaiting it, so wait for the Host to see the body. */
const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(check(), 'timed out waiting for the quick discovery wake');
};

const delivered = (f: any) =>
  f.q.intakeStore.db.prepare("SELECT COUNT(*) n FROM intake_wakes WHERE status='delivered'").get()
    ?.n;

test('an unadmitted wake keeps its recorded body across restart: one investigation and no payload conflict', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  await f.q.intake.collect();
  await hint(f, 'one', '客户把评审挪到下周三');
  const authority = host(f);
  authority.unavailable(true);
  await f.q.dispatch();
  await f.q.running;
  assert.equal(f.counts().workerCalls, 0);
  const first = authority.bodies[0];
  assert.match(first, /当前 UTC 时间：/);
  assert.match(first, /\[just now\] 客户把评审挪到下周三/);

  // The Host's query must prove absence. A durable receipt cannot become not_admitted
  // merely because its in-memory cache was lost at restart.
  await f.restart();
  const pending = f.q.state().pending;
  assert.ok(pending, 'the interrupted activation is pending for the next owner');
  assert.equal(pending.submission.input, first, 'the submitted body is persisted with it');
  const wake = pending.eventWake;

  f.advance(3 * 3600000);
  authority.unavailable(false);
  await f.q.dispatch();
  await f.q.running;

  assert.equal(authority.conflicts(), 0, 'the durable receipt is not judged a conflict');
  assert.equal(authority.bodies.length, 2, 'the pending activation is redelivered');
  assert.equal(authority.bodies[1], first, 'the redelivery body is byte-identical');
  assert.match(authority.bodies[1], /\[just now\]/, 'the recorded age label is kept');
  assert.doesNotMatch(authority.bodies[1], /3h ago/, 'the body is not recomposed on retry');
  assert.equal(f.counts().workerCalls, 1, 'one investigation was started, not two');
  assert.equal(f.q.state().lastError, null);
  assert.equal(f.q.state().pending, null);
  assert.deepEqual(pending.eventWake, wake);
  assert.equal(delivered(f), 1);
  assert.equal(await f.q.intake.next(), undefined, 'the wake is consumed exactly once');
});

for (const changedVersion of [false, true]) {
  test(`an admission that survived restart is awaited, never replaced (changed version ${changedVersion})`, async (t) => {
    const f = await intakeFixture();
    t.after(() => f.close());
    await f.q.intake.collect();
    await hint(f, 'one', '明天安排有变化');
    const authority = host(f);
    const gate = crash(f);
    await f.q.dispatch();
    await until(() => authority.bodies.length === 1);

    await f.q.close();
    await f.restart();
    assert.ok(f.q.state().active?.submission, 'the original execution identity survives restart');
    if (changedVersion)
      f.q.store.update((s: any) => {
        s.active.submission.version = 'previous-prompt';
      });

    f.advance(2 * 3600000);
    gate.heal();
    await f.q.dispatch();
    await f.q.running;

    assert.equal(authority.bodies.length, 1, 'the admitted identity is not resubmitted');
    assert.equal(authority.conflicts(), 0);
    assert.equal(f.counts().workerCalls, 1, 'the same messageId did not start a second turn');
    assert.equal(f.q.state().lastError, null);
    assert.equal(f.q.state().pending, null);
    assert.equal(delivered(f), 1);
    assert.equal(await f.q.intake.next(), undefined);
  });
}

test('a changed unadmitted body uses a fresh identity instead of replaying the old one', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  await f.q.intake.collect();
  await hint(f, 'one', '卡片可能没生效');
  const authority = host(f);
  authority.unavailable(true);
  await f.q.dispatch();
  await f.q.running;
  const first = authority.bodies[0];

  await f.restart();
  const pending = f.q.state().pending;
  // The prompt version changed under the pending activation (a release between restarts).
  f.q.store.update((s: any) => {
    s.pending.submission.version = 'previous-prompt';
  });
  assert.equal(pending.submission.input, first);

  f.advance(3 * 3600000);
  authority.unavailable(false);
  await f.q.dispatch();
  await f.q.running;

  assert.equal(authority.bodies.length, 2);
  assert.notEqual(authority.bodies[1], first, 'a new prompt version recomposes the body');
  assert.match(authority.bodies[1], /\[3h ago\]/);
  assert.equal(authority.conflicts(), 0, 'a new identity cannot collide with the old receipt');
  assert.equal(f.q.state().lastError, null);
  assert.equal(delivered(f), 1);
});
