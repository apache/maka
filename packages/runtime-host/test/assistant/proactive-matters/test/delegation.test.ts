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

import { readFileSync } from 'node:fs';

import { randomUUID } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { fixture, until, AgentDriver } from './platform-helper.js';
function driver() {
  const d = new AgentDriver();
  d.add('session-1', true);
  let count = 0;
  d.runtime.create = async (o: any) => {
    assert.equal(o.background, true);
    assert.ok(o.labels.includes('personal-assistant-background'));
    count++;
    const id = randomUUID();
    assert.equal(o.sessionId, undefined);
    d.add(id, false);
    Object.assign(d.sessions.get(id), {
      name: o.name,
      labels: o.labels,
      parentSessionId: 'session-1',
    });
    return { id, sessionId: id, root: false };
  };
  d.runtime.get = async (id: string) =>
    d.sessions.has(id) ? { id, sessionId: id, root: false } : undefined;
  return { d, count: () => count };
}
test('delegate retries reuse child; wait and user amendment stay independent of parent chat', async () => {
  const { d, count } = driver(),
    f = await fixture({ driver: d });
  let runs = 0,
    failure: unknown;
  try {
    d.onFollowup = async (id, prompt, turn) => {
      try {
        assert.notEqual(id, 'session-1');
        const available = f.filterTools(id, [...f.tools.resolve(id, []).tools, { name: 'Bash' }]);
        assert.ok(available.some((tool: any) => tool.name === 'Bash'));
        assert.ok(
          available.some(
            (tool: any) => tool.name === 'MatterSettle' && tool.discovery === 'direct',
          ),
        );
        assert.ok(
          !available.some((tool: any) =>
            ['MatterDelegate', 'MatterTaskMessage', 'MatterTaskControl', 'MatterReply'].includes(
              tool.name,
            ),
          ),
        );
        assert.ok(
          f
            .filterTools('session-1', f.tools.resolve('session-1', []).tools)
            .some((tool: any) => tool.name === 'MatterDelegate'),
        );
        runs++;
        const m = (await f.remote('matters.list')).matters.find((m: any) => m.sessionId === id);
        const v = await f.invoke('MatterRead', { activationId: m.activation.id }, turn, id);
        const inbox = await f.invoke('MatterReadFile', { path: v.files.inbox }, turn, id);
        if (runs === 2) {
          assert.match(JSON.stringify(inbox), /只验证测试环境/);
          assert.match(JSON.stringify(inbox), /coordinator/);
        }
        await f.invoke(
          'MatterWriteFile',
          {
            path: v.files.draft,
            content: runs === 1 ? '已查询，等待供应商结果。' : '按新要求只验证了测试环境。',
          },
          turn,
          id,
        );
        await f.invoke(
          'MatterSettle',
          {
            note: readFileSync(v.files.draft, 'utf8'),
            disposition: runs === 1 ? 'wait' : 'complete',
            ...(runs === 1
              ? { waitingFor: '等待供应商结果', wakes: [{ kind: 'at', at: Date.now() + 60000 }] }
              : {}),
            reason: runs === 1 ? '暂时无结果' : '目标满足',
            summary: '核实当前情况',
            update: runs === 1 ? '等待结果' : '测试环境已验证',
          },
          turn,
          id,
        );
      } catch (e) {
        failure = e;
      } finally {
        d.end(id);
      }
    };
    const input = {
      taskKey: 'supplier',
      title: '跟进测试',
      request: '只读核实供应商结果，不联系供应商。',
    };
    const a = await f.invoke('MatterDelegate', input),
      b = await f.invoke('MatterDelegate', input);
    assert.equal(a.id, b.id);
    assert.equal(count(), 1);
    await assert.rejects(
      f.invoke('MatterDelegate', { ...input, request: 'different' }),
      /different request/,
    );
    await until(
      async () =>
        failure ||
        ((await f.invoke('MatterTasks', { id: a.id })).status === 'waiting' &&
          !(await f.remote('matters.list')).matters[0].activation),
    );
    if (failure) throw failure;
    assert.equal(d.sessions.get('session-1').running, true);
    assert.equal(
      (
        await f.turns.evaluate({
          sessionId: 'session-1',
          turnId: 'parent',
          signal: new AbortController().signal,
        })
      ).allow,
      true,
    );
    await f.remote('matters.authorize-session', { sessionId: 'other' });
    await assert.rejects(f.invoke('MatterTasks', { id: a.id }, 'x', 'other'), /outside/);
    assert.deepEqual((await f.invoke('MatterTasks', {}, 'x', 'other')).items, []);
    await f.invoke('MatterTaskMessage', { id: a.id, text: '改为只验证测试环境，不用生产环境。' });
    await until(
      async () => failure || (await f.invoke('MatterTasks', { id: a.id })).status === 'completed',
    );
    if (failure) throw failure;
    assert.equal(runs, 2);
    assert.equal(count(), 1);
    assert.ok(
      (await f.invoke('MatterTasks', { id: a.id })).updates.some(
        (x: any) => x.text === '测试环境已验证',
      ),
    );
    assert.ok(
      d.calls.filter((x: any) => x.op === 'followup').every((x: any) => x.id === a.sessionId),
    );
  } finally {
    await f.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
test('parent cancellation stops only its task and rejects late worker writes', async () => {
  const { d } = driver(),
    f = await fixture({ driver: d });
  try {
    const a = await f.invoke('MatterDelegate', { taskKey: 'a', title: 'A', request: '只读跟进 A' });
    await until(() => d.calls.some((x: any) => x.op === 'followup'));
    await f.remote('matters.authorize-session', { sessionId: 'other' });
    await assert.rejects(
      f.invoke('MatterTaskControl', { id: a.id, action: 'cancel' }, 'x', 'other'),
      /outside/,
    );
    await f.invoke('MatterTaskControl', { id: a.id, action: 'cancel' });
    assert.equal((await f.invoke('MatterTasks', { id: a.id })).status, 'cancelled');
    assert.equal(d.sessions.get('session-1').running, true);
    assert.equal(d.calls.find((x: any) => x.op === 'cancel').id, a.sessionId);
    await assert.rejects(
      f.invoke('MatterRead', {}, d.sessions.get(a.sessionId).turnId, a.sessionId),
      /does not own/,
    );
  } finally {
    await f.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test('uncertain Session creation is recovered by exact identity without spawning a second worker', async () => {
  const { d, count } = driver();
  const original = d.runtime.create;
  d.runtime.create = async (o: any) => {
    await original(o);
    throw Error('connection lost after creation');
  };
  const f = await fixture({ driver: d });
  try {
    const input = { taskKey: 'uncertain', title: 'Uncertain', request: '只读查询测试结果' };
    await assert.rejects(f.invoke('MatterDelegate', input), /connection lost/);
    assert.equal((await f.invoke('MatterOverview')).pending.length, 1);
    const recovered = await f.invoke('MatterDelegationRecover', { taskKey: input.taskKey });
    assert.ok(recovered.id);
    assert.equal((await f.invoke('MatterOverview')).pending.length, 0);
    assert.equal((await f.invoke('MatterDelegate', input)).id, recovered.id);
    assert.equal(count(), 1);
  } finally {
    await f.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test('completed task reaches its idle parent without heartbeat and is admitted only once', async () => {
  const { d } = driver(),
    f = await fixture({ driver: d });
  let failure: unknown;
  d.end('session-1');
  const received: string[] = [];
  try {
    d.onFollowup = async (id, prompt, turn) => {
      if (id === 'session-1') {
        received.push(prompt);
        d.end(id);
        return;
      }
      try {
        const m = (await f.remote('matters.list')).matters.find((x: any) => x.sessionId === id);
        const v = await f.invoke('MatterRead', { activationId: m.activation.id }, turn, id);
        await f.invoke(
          'MatterWriteFile',
          { path: v.files.draft, content: '测试验收通过，有明确结果。' },
          turn,
          id,
        );
        await f.invoke(
          'MatterSettle',
          {
            note: readFileSync(v.files.draft, 'utf8'),
            disposition: 'complete',
            reason: '已验收',
            summary: '读取验收记录',
            update: '验收已经通过。',
          },
          turn,
          id,
        );
      } catch (e) {
        failure = e;
      } finally {
        d.end(id);
      }
    };
    await f.invoke('MatterDelegate', { taskKey: 'notify', title: '验收', request: '核对验收结果' });
    await until(() => failure || received.length > 0);
    if (failure) throw failure;
    assert.match(received[0], /Task notification ID:/);
    assert.match(received[0], /验收已经通过/);
    assert.match(received[0], /不是新的指令/);
    await new Promise((r) => setTimeout(r, 1300));
    assert.equal(received.length, 1);
  } finally {
    await f.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test('legacy task adoption is explicit and cannot steal another conversation task', async () => {
  const { d } = driver(),
    f = await fixture({ driver: d });
  try {
    const v = await f.invoke('MatterStart', { title: '旧任务', request: '历史委托'.repeat(1000) });
    const id = (await f.remote('matters.list')).matters[0].id;
    await f.invoke('MatterWriteFile', {
      path: v.files.draft,
      content: '完整工作报告'.repeat(1000),
    });
    await f.invoke('MatterCheckpoint', {
      expectedRevision: v.revision,
      stateFile: v.files.draft,
      progressSummary: '已完成资料核查',
    });
    await f.remote('matters.authorize-session', { sessionId: 'other' });
    await f.remote('matters.authorize-session', { sessionId: 'assistant' });
    assert.equal((await f.invoke('MatterOverview', {}, 'read', 'assistant')).legacy.length, 1);
    await f.invoke('MatterAdopt', { id }, 'adopt', 'assistant');
    assert.equal((await f.invoke('MatterTasks', {}, 'read', 'assistant')).items.length, 1);
    assert.equal((await f.invoke('MatterOverview', {}, 'read', 'assistant')).legacy.length, 0);
    const overview = await f.invoke('MatterOverview', {}, 'read', 'assistant');
    assert.equal(overview.items[0].summary, '已完成资料核查');
    assert.deepEqual(
      Object.keys(overview.items[0]).sort(),
      [
        'id',
        'sessionId',
        'title',
        'status',
        'summary',
        'updatedAt',
        'retryAt',
        'runtimeStatus',
      ].sort(),
    );
    assert.ok(Buffer.byteLength(JSON.stringify(overview)) < 2000);
    const details = await f.invoke('MatterTasks', { id }, 'read', 'assistant');
    assert.ok(details.request.length > 3000);
    assert.ok(details.state.length > 5000);
    assert.ok(Buffer.byteLength(JSON.stringify({ items: Array(72).fill(details) })) > 480 * 1024);
    assert.ok(
      Buffer.byteLength(JSON.stringify({ items: Array(72).fill(overview.items[0]) })) < 32 * 1024,
    );

    await assert.rejects(f.invoke('MatterAdopt', { id }, 'adopt', 'other'), /另一段对话/);
  } finally {
    await f.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

for (const accepted of [false, true])
  test(`uncertain task notification reconciles without replay: accepted=${accepted}`, async () => {
    const { d } = driver(),
      f = await fixture({ driver: d });
    let failure: unknown,
      attempts = 0;
    const history: any[] = [];
    d.end('session-1');
    const original = d.runtime.followup;
    d.runtime.followup = async (id: string, prompt: string, inv: any) => {
      if (id === 'session-1') {
        attempts++;
        if (accepted) history.push({ type: 'user', text: prompt });
        throw Error('transport response lost');
      }
      return original(id, prompt, inv);
    };
    d.runtime.transcript = async (id: string) => (id === 'session-1' ? history : []);
    try {
      d.onFollowup = async (id, _prompt, turn) => {
        try {
          const m = (await f.remote('matters.list')).matters.find((x: any) => x.sessionId === id);
          const v = await f.invoke('MatterRead', { activationId: m.activation.id }, turn, id);
          await f.invoke(
            'MatterWriteFile',
            { path: v.files.draft, content: '已完成核对' },
            turn,
            id,
          );
          await f.invoke(
            'MatterSettle',
            {
              note: readFileSync(v.files.draft, 'utf8'),
              disposition: 'complete',
              reason: '已完成',
              summary: '已核对',
              update: '任务完成',
            },
            turn,
            id,
          );
        } catch (e) {
          failure = e;
        } finally {
          d.end(id);
        }
      };
      await f.invoke('MatterDelegate', {
        taskKey: 'uncertain-notice',
        title: '核对',
        request: '核对测试结果',
      });
      await until(() => failure || attempts === 1);
      if (failure) throw failure;
      await new Promise((r) => setTimeout(r, 2200));
      assert.equal(attempts, 1);
      const notices = (await f.invoke('MatterOverview')).notifications;
      assert.equal(
        notices.some((n: any) => n.phase === 'uncertain'),
        !accepted,
      );
    } finally {
      await f.close();
      await rm(f.root, { recursive: true, force: true });
    }
  });

test('busy parent defers feedback; an accepted but missing reply survives restart and retries without restarting work', async () => {
  const { d } = driver();
  let f = await fixture({ driver: d });
  let taskRuns = 0,
    parentRuns = 0,
    failure: unknown;
  const history: any[] = [];
  const original = d.runtime.followup;
  d.runtime.transcript = async (id: string) => (id === 'session-1' ? history : []);
  d.runtime.followup = async (id: string, prompt: string, inv: any) => {
    const result = await original(id, prompt, inv);
    if (id === 'session-1') history.push({ type: 'user', text: prompt, turnId: result.turnId });
    return result;
  };
  d.onFollowup = async (id, prompt, turn) => {
    if (id === 'session-1') {
      parentRuns++;
      if (parentRuns > 1) history.push({ type: 'assistant', text: '验收已完成。', turnId: turn });
      d.end(id);
      return;
    }
    try {
      taskRuns++;
      const m = (await f.remote('matters.list')).matters.find((m: any) => m.sessionId === id);
      const v = await f.invoke('MatterRead', { activationId: m.activation.id }, turn, id);
      await f.invoke('MatterWriteFile', { path: v.files.draft, content: '已通过验收' }, turn, id);
      await f.invoke(
        'MatterSettle',
        {
          note: readFileSync(v.files.draft, 'utf8'),
          disposition: 'complete',
          reason: '证据完整',
          summary: '验收核对',
          update: '验收通过',
        },
        turn,
        id,
      );
    } catch (e) {
      failure = e;
    } finally {
      d.end(id);
    }
  };
  try {
    await f.invoke('MatterDelegate', {
      taskKey: 'recover-reply',
      title: '验收',
      request: '核对验收',
    });
    await until(
      async () => failure || (await f.invoke('MatterTasks')).items[0]?.status === 'completed',
    );
    if (failure) throw failure;
    await new Promise((r) => setTimeout(r, 1100));
    assert.equal(parentRuns, 0);
    d.end('session-1');
    await until(async () =>
      (await f.invoke('MatterOverview')).notifications.some(
        (n: any) => n.phase === 'awaiting_reply',
      ),
    );
    const root = f.root;
    await f.close();
    f = await fixture({ root, reopen: true, driver: d });
    const notification = (await f.invoke('MatterOverview')).notifications.find(
      (n: any) => n.phase === 'awaiting_reply',
    );
    assert.ok(notification);
    await f.remote('matters.authorize-session', { sessionId: 'other' });
    await assert.rejects(
      f.invoke('MatterFeedbackRetry', { notificationId: notification.id }, 'retry', 'other'),
      /不属于/,
    );
    await f.invoke('MatterFeedbackRetry', { notificationId: notification.id });
    await until(async () => (await f.invoke('MatterOverview')).notifications.length === 0);
    assert.equal(parentRuns, 2);
    assert.equal(taskRuns, 1);
    assert.equal(history.filter((x) => x.type === 'assistant').length, 1);
  } finally {
    await f.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test('waiting for user approval remains active and is visible to the owner', async () => {
  const { d } = driver();
  const snapshot = d.runtime.snapshot;
  let waiting = false;
  d.runtime.snapshot = async (id: string) =>
    id !== 'session-1' && waiting ? { agent: { status: 'waiting_for_user' } } : snapshot(id);
  const f = await fixture({ driver: d });
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let failure: unknown;
  d.onFollowup = async (id, _prompt, turn) => {
    waiting = true;
    await gate;
    waiting = false;
    try {
      const m = (await f.remote('matters.list')).matters.find((m: any) => m.sessionId === id);
      const v = await f.invoke('MatterRead', { activationId: m.activation.id }, turn, id);
      await f.invoke('MatterWriteFile', { path: v.files.draft, content: '授权后完成' }, turn, id);
      await f.invoke(
        'MatterSettle',
        {
          note: readFileSync(v.files.draft, 'utf8'),
          disposition: 'complete',
          reason: '已完成',
          summary: '已核对',
        },
        turn,
        id,
      );
    } catch (e) {
      failure = e;
    } finally {
      d.end(id);
    }
  };
  try {
    const m = await f.invoke('MatterDelegate', {
      taskKey: 'approval',
      title: '需授权任务',
      request: '核对受限来源',
    });
    await until(() => waiting);
    await new Promise((r) => setTimeout(r, 550));
    const status = await f.invoke('MatterOverview');
    assert.equal(status.items[0].runtimeStatus, 'waiting_for_user');
    assert.ok((await f.remote('matters.list')).matters[0].activation);
    assert.ok(!d.calls.some((x: any) => x.op === 'cancel'));
    release();
    await until(
      async () => failure || (await f.invoke('MatterTasks', { id: m.id })).status === 'completed',
    );
    if (failure) throw failure;
  } finally {
    release();
    await f.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test('quiet interim progress is not an error or replayed for changed waiting details; completion still needs a receipt', async () => {
  const { d } = driver();
  let f = await fixture({ driver: d });
  let runs = 0,
    parentRuns = 0,
    failure: unknown;
  const history: any[] = [];
  const followup = d.runtime.followup;
  d.runtime.transcript = async (id: string) => (id === 'session-1' ? history : []);
  d.runtime.followup = async (id: string, prompt: string, inv: any) => {
    const result = await followup(id, prompt, inv);
    if (id === 'session-1') history.push({ type: 'user', text: prompt, turnId: result.turnId });
    return result;
  };
  d.onFollowup = async (id, _prompt, turn) => {
    if (id === 'session-1') {
      parentRuns++;
      d.end(id);
      return;
    }
    try {
      runs++;
      const m = (await f.remote('matters.list')).matters.find((m: any) => m.sessionId === id);
      const v = await f.invoke('MatterRead', { activationId: m.activation.id }, turn, id);
      await f.invoke(
        'MatterWriteFile',
        { path: v.files.draft, content: `Evidence round ${runs}` },
        turn,
        id,
      );
      await f.invoke(
        'MatterSettle',
        {
          note: readFileSync(v.files.draft, 'utf8'),
          disposition: runs < 3 ? 'wait' : 'complete',
          reason: '核对实际证据',
          summary: '只读检查',
          ...(runs < 3
            ? {
                waitingFor: `等待更新证据 ${runs}`,
                wakes: [{ kind: 'at', at: Date.now() + 60000 }],
              }
            : {}),
          ...(runs === 1
            ? { update: '已安排跟进，不重复例行进度。' }
            : runs === 3
              ? { update: '确认验收完成。' }
              : {}),
        },
        turn,
        id,
      );
    } catch (e) {
      failure = e;
    } finally {
      d.end(id);
    }
  };
  try {
    d.end('session-1');
    const task = await f.invoke('MatterDelegate', {
      taskKey: 'quiet-progress',
      title: '验收',
      request: '完成后再通知',
    });
    await until(() => failure || parentRuns === 1);
    if (failure) throw failure;
    await until(async () => !(await f.invoke('MatterOverview')).notifications.length);
    const root = f.root;
    await f.close();
    f = await fixture({ root, reopen: true, driver: d });
    await f.invoke('MatterTaskControl', { id: task.id, action: 'check' });
    await until(
      async () =>
        failure ||
        (runs === 2 && (await f.invoke('MatterTasks', { id: task.id })).status === 'waiting'),
    );
    if (failure) throw failure;
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(parentRuns, 1, 'old update plus changed waitingFor must not send a new notice');
    assert.equal((await f.invoke('MatterOverview')).notifications.length, 0);
    await f.invoke('MatterTaskControl', { id: task.id, action: 'check' });
    await until(
      async () =>
        failure ||
        (await f.invoke('MatterOverview')).notifications.some(
          (n: any) => n.phase === 'awaiting_reply',
        ),
    );
    if (failure) throw failure;
    assert.equal(runs, 3);
    assert.equal(parentRuns, 2);
  } finally {
    await f.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test('legacy runTimeoutMs cannot cancel a live review or evidence repair before completion', async () => {
  const { d } = driver();
  let releaseReview!: () => void, releaseRepair!: () => void;
  const reviewing = new Promise<void>((resolve) => {
    releaseReview = resolve;
  });
  const repairing = new Promise<void>((resolve) => {
    releaseRepair = resolve;
  });
  let reviews = 0,
    repairStarted = false,
    failure: unknown;
  const f = await fixture({
    driver: d,
    // Existing installations can retain this setting. It no longer imposes a deadline.
    config: { runTimeoutMs: 200 },
    review: async () => {
      reviews++;
      if (reviews === 1) await reviewing;
      return {
        text: JSON.stringify({
          approved: reviews > 1,
          feedback:
            reviews > 1 ? 'Evidence accepted' : 'Read supporting evidence before completing',
        }),
        modelId: 'fixture-review',
      };
    },
  });
  d.onFollowup = async (id, _prompt, turn) => {
    try {
      const m = (await f.remote('matters.list')).matters.find((item: any) => item.sessionId === id);
      const v = await f.invoke('MatterRead', { activationId: m.activation.id }, turn, id);
      await f.invoke(
        'MatterWriteFile',
        { path: v.files.draft, content: 'Report written; checking supporting evidence.' },
        turn,
        id,
      );
      const submission = {
        note: readFileSync(v.files.draft, 'utf8'),
        disposition: 'complete',
        reason: 'Work finished',
        summary: 'Report ready',
      };
      const rejected = await f.invoke('MatterSettle', submission, turn, id);
      assert.equal(rejected.accepted, false);
      repairStarted = true;
      await repairing;
      await f.invoke('MatterReadFile', { path: v.files.draft }, turn, id);
      await f.invoke('MatterSettle', submission, turn, id);
    } catch (error) {
      failure = error;
    } finally {
      d.end(id);
    }
  };
  try {
    const m = await f.invoke('MatterDelegate', {
      taskKey: 'no-activation-deadline',
      title: 'Long review and evidence repair',
      request: 'Write and verify a report',
    });
    const assertActive = async () => {
      await new Promise((resolve) => setTimeout(resolve, 550));
      if (failure) throw failure;
      const current = (await f.remote('matters.list')).matters.find(
        (item: any) => item.id === m.id,
      );
      assert.equal(current.status, 'active');
      assert.ok(current.activation);
      assert.ok(!d.calls.some((call: any) => call.op === 'cancel'));
    };
    await until(() => reviews === 1 || failure);
    await assertActive();
    releaseReview();
    await until(() => repairStarted || failure);
    await assertActive();
    releaseRepair();
    await until(
      async () => failure || (await f.invoke('MatterTasks', { id: m.id })).status === 'completed',
    );
    if (failure) throw failure;
    assert.equal(reviews, 2);
    assert.ok(!d.calls.some((call: any) => call.op === 'cancel'));
  } finally {
    releaseReview();
    releaseRepair();
    await f.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
