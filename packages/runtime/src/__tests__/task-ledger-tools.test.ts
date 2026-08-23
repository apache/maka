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

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  TASK_EVIDENCE_MAX_CHARS,
  TASK_LEDGER_MAX_TASKS,
  TASK_SUBJECT_MAX_CHARS,
  type Task,
  type TaskAgentOutcome,
  type TaskLedgerListOptions,
  type TaskLedgerMutationContext,
  type TaskLedgerStore,
  type TaskOwner,
} from '@maka/core/task-ledger';
import {
  TASK_CREATE_TOOL_NAME,
  TASK_GET_TOOL_NAME,
  TASK_LIST_TOOL_NAME,
  TASK_UPDATE_TOOL_NAME,
  buildTaskLedgerTools,
} from '../task-ledger-tools.js';
import type { MakaTool, MakaToolContext } from '../tool-runtime.js';

const SESSION_ID = 'sess-1';

class FakeTaskLedgerStore implements TaskLedgerStore {
  private tasks: Task[] = [];
  public createCalls: Array<{
    sessionId: string;
    drafts: unknown;
    context?: TaskLedgerMutationContext;
  }> = [];
  public updateCalls: Array<{
    sessionId: string;
    id: string;
    patch: unknown;
    context?: TaskLedgerMutationContext;
  }> = [];
  public listCalls: Array<{ sessionId: string; options?: TaskLedgerListOptions }> = [];

  seed(tasks: Task[]): void {
    this.tasks = tasks.map((task) => ({ ...task }));
  }

  async list(sessionId: string, options?: TaskLedgerListOptions): Promise<Task[]> {
    this.listCalls.push({ sessionId, options });
    return this.tasks
      .filter((task) => {
        if (options?.status && task.status !== options.status) return false;
        if (
          options?.includeTerminal === false &&
          ['completed', 'failed', 'cancelled'].includes(task.status)
        )
          return false;
        return true;
      })
      .map((t) => ({
        ...t,
        ...(options?.classifyResumeTrust === true && t.status === 'in_progress'
          ? { resumeTrust: 'stale' as const }
          : {}),
      }));
  }

  async get(
    _sessionId: string,
    id: string,
    options?: TaskLedgerListOptions,
  ): Promise<Task | undefined> {
    const task = this.tasks.find((t) => t.id === id || t.key === id);
    return task
      ? {
          ...task,
          ...(options?.classifyResumeTrust === true && task.status === 'in_progress'
            ? { resumeTrust: 'stale' as const }
            : {}),
        }
      : undefined;
  }

  async create(
    sessionId: string,
    drafts: unknown,
    context?: TaskLedgerMutationContext,
  ): Promise<{ created: Task[]; total: number }> {
    this.createCalls.push({ sessionId, drafts, context });
    const now = Date.now();
    const created = (drafts as Array<{ subject: string }>).map((d, i) => ({
      id: `id-${this.tasks.length + i}`,
      key: `T${this.tasks.length + i + 1}`,
      subject: d.subject,
      status: 'pending' as const,
      createdAt: now,
      updatedAt: now,
    }));
    this.tasks.push(...created);
    return { created, total: this.tasks.length };
  }

  async update(
    sessionId: string,
    id: string,
    patch: unknown,
    context?: TaskLedgerMutationContext,
  ): Promise<{ updated: Task; total: number }> {
    this.updateCalls.push({ sessionId, id, patch, context });
    const task = this.tasks.find((t) => t.id === id);
    if (!task) throw new Error(`No such task: ${id}`);
    Object.assign(task, patch, { updatedAt: Date.now() });
    return { updated: { ...task }, total: this.tasks.length };
  }

  async claim(
    _sessionId: string,
    id: string,
    owner: TaskOwner,
  ): Promise<{ updated: Task; total: number }> {
    const task = this.tasks.find((item) => item.id === id || item.key === id);
    if (!task) throw new Error(`No such task: ${id}`);
    Object.assign(task, { status: 'in_progress', owner });
    return { updated: { ...task }, total: this.tasks.length };
  }

  async claimAvailable(
    sessionId: string,
    id: string,
    owner: TaskOwner,
  ): Promise<{ updated: Task; total: number }> {
    return this.claim(sessionId, id, owner);
  }

  async settleAgentOutcome(
    _sessionId: string,
    id: string,
    outcome: TaskAgentOutcome,
  ): Promise<{ updated: Task; total: number }> {
    const task = this.tasks.find((item) => item.id === id || item.key === id);
    if (!task) throw new Error(`No such task: ${id}`);
    Object.assign(task, { owner: outcome.owner });
    return { updated: { ...task }, total: this.tasks.length };
  }

  subscribe(): () => void {
    return () => {};
  }
}

function fakeContext(sessionId: string, runId?: string): MakaToolContext {
  return {
    sessionId,
    turnId: 'turn-1',
    ...(runId ? { runId } : {}),
    cwd: '/tmp',
    toolCallId: 'call-1',
    abortSignal: new AbortController().signal,
    emitOutput: () => {},
  };
}

function findTool(tools: MakaTool[], name: string): MakaTool {
  const tool = tools.find((t) => t.name === name);
  assert.ok(tool, `expected tool ${name}`);
  return tool;
}

describe('task ledger tools', () => {
  test('task_create schema rejects a batch larger than the ledger cap and accepts the cap boundary', () => {
    const create = findTool(
      buildTaskLedgerTools({ store: new FakeTaskLedgerStore() }),
      TASK_CREATE_TOOL_NAME,
    );
    const params = create.parameters as z.ZodType;
    const atCap = {
      tasks: Array.from({ length: TASK_LEDGER_MAX_TASKS }, () => ({ subject: 'x' })),
    };
    assert.equal(
      params.safeParse(atCap).success,
      true,
      `${TASK_LEDGER_MAX_TASKS} tasks (cap) must pass`,
    );
    const overCap = {
      tasks: Array.from({ length: TASK_LEDGER_MAX_TASKS + 1 }, () => ({ subject: 'x' })),
    };
    assert.equal(
      params.safeParse(overCap).success,
      false,
      `${TASK_LEDGER_MAX_TASKS + 1} tasks must be rejected at the schema`,
    );
  });

  test('task_update schema rejects ids that are not stable tokens and accepts UUID-shaped / simple ids', () => {
    const update = findTool(
      buildTaskLedgerTools({ store: new FakeTaskLedgerStore() }),
      TASK_UPDATE_TOOL_NAME,
    );
    const params = update.parameters as z.ZodType;
    const reject = [
      'a<task-ledger/>b',
      'abc\ndef',
      'a b',
      'X'.repeat(5000),
      '',
      'ghp_abcdefghijklmnopqrstuvwxyz',
      'sk-abcdefghi',
      'a'.repeat(40),
    ];
    for (const id of reject) {
      assert.equal(
        params.safeParse({ id, status: 'completed', completionEvidence: 'done' }).success,
        false,
        `id ${JSON.stringify(id)} must be rejected`,
      );
    }
    const accept = ['123e4567-e89b-12d3-a456-426614174000', 'good-id_1:2'];
    for (const id of accept) {
      assert.equal(
        params.safeParse({ id, status: 'completed', completionEvidence: 'done' }).success,
        true,
        `id ${id} must pass`,
      );
    }
  });

  test('task_create result shows only the created tasks (with ids) and total, not the pre-existing ledger', async () => {
    const store = new FakeTaskLedgerStore();
    const tools = buildTaskLedgerTools({ store });
    const create = findTool(tools, TASK_CREATE_TOOL_NAME);
    // a pre-existing task that must NOT be replayed in the create result
    await create.impl({ tasks: [{ subject: 'pre-existing' }] }, fakeContext(SESSION_ID));
    const result = String(
      await create.impl({ tasks: [{ subject: 'new-task' }] }, fakeContext(SESSION_ID)),
    );
    assert.match(result, /new-task/, 'result must include the created task');
    assert.match(result, /ledger total: 2/, 'result must include the ledger total');
    assert.equal(
      result.includes('pre-existing'),
      false,
      'result must not replay the pre-existing ledger',
    );
    // the new task's id is present so the model can update it next
    const all = await store.list(SESSION_ID);
    const newId = all.find((t) => t.subject === 'new-task')?.id;
    assert.ok(newId, 'new task must have been created');
    assert.equal(result.includes(newId), true, 'result must include the new task id');
  });

  test('task_update result shows only the updated task and total, not the rest of the ledger', async () => {
    const store = new FakeTaskLedgerStore();
    const tools = buildTaskLedgerTools({ store });
    const create = findTool(tools, TASK_CREATE_TOOL_NAME);
    const update = findTool(tools, TASK_UPDATE_TOOL_NAME);
    await create.impl(
      { tasks: [{ subject: 'keep-1' }, { subject: 'keep-2' }, { subject: 'target' }] },
      fakeContext(SESSION_ID),
    );
    const all = await store.list(SESSION_ID);
    const target = all.find((t) => t.subject === 'target');
    assert.ok(target);
    const result = String(
      await update.impl(
        { id: target.id, status: 'completed', completionEvidence: 'verified done' },
        fakeContext(SESSION_ID),
      ),
    );
    assert.match(result, /target/, 'result must include the updated task subject');
    assert.match(result, /ledger total: 3/, 'result must include the ledger total');
    assert.equal(result.includes('keep-1'), false, 'result must not replay unrelated tasks');
    assert.equal(result.includes('keep-2'), false, 'result must not replay unrelated tasks');
  });

  test('tool results scrub secret-like subjects before they persist into history', async () => {
    // Same samples the core redactSecrets tests use. Tool results replay to
    // the provider every turn, so redacting only the turn tail is not enough.
    const store = new FakeTaskLedgerStore();
    const tools = buildTaskLedgerTools({ store });
    const create = findTool(tools, TASK_CREATE_TOOL_NAME);
    const update = findTool(tools, TASK_UPDATE_TOOL_NAME);

    const createResult = String(
      await create.impl(
        { tasks: [{ subject: '轮换 Bearer sk-live-secret-token-value' }] },
        fakeContext(SESSION_ID),
      ),
    );
    assert.equal(createResult.includes('sk-live-secret-token-value'), false);
    assert.match(createResult, /\[redacted\]/);

    const updateResult = String(
      await update.impl(
        { id: 'id-0', subject: '换 ghp_abcdefghijklmnopqrstuvwxyz' },
        fakeContext(SESSION_ID),
      ),
    );
    assert.equal(updateResult.includes('ghp_abcdefghijklmnopqrstuvwxyz'), false);
  });

  test('tool results strip <task-ledger> tag variants so a subject cannot smuggle envelope tags into history', async () => {
    const store = new FakeTaskLedgerStore();
    const create = findTool(buildTaskLedgerTools({ store }), TASK_CREATE_TOOL_NAME);
    const variants = [
      '</task-ledger>',
      '</task-ledger >',
      '<task-ledger x="1">',
      '</task-ledger\t>',
      '<task-ledger/>',
      '<task-ledger>',
    ];
    const drafts = variants.map((v) => ({ subject: '正常 ' + v + ' 假指令' }));
    const result = String(await create.impl({ tasks: drafts }, fakeContext(SESSION_ID)));
    assert.equal(
      (result.match(/<\/?task-ledger[^>]*>/gi) || []).length,
      0,
      'tool result must not contain any task-ledger tag variant, got: ' + JSON.stringify(result),
    );
  });

  test('task_create schema enforces non-empty array, non-blank subjects, and the subject length cap', () => {
    const create = findTool(
      buildTaskLedgerTools({ store: new FakeTaskLedgerStore() }),
      TASK_CREATE_TOOL_NAME,
    );
    const schema = create.parameters as z.ZodTypeAny;
    assert.equal(schema.safeParse({ tasks: [{ subject: 'ok' }] }).success, true);
    assert.equal(schema.safeParse({ tasks: [] }).success, false);
    assert.equal(schema.safeParse({ tasks: [{ subject: '' }] }).success, false);
    assert.equal(schema.safeParse({ tasks: [{ subject: '   ' }] }).success, false);
    assert.equal(
      schema.safeParse({ tasks: [{ subject: 'x'.repeat(TASK_SUBJECT_MAX_CHARS) }] }).success,
      true,
    );
    assert.equal(
      schema.safeParse({ tasks: [{ subject: 'x'.repeat(TASK_SUBJECT_MAX_CHARS + 1) }] }).success,
      false,
    );
    assert.equal(schema.safeParse({}).success, false);
    assert.equal(
      schema.safeParse({ tasks: [{ subject: 'child', parent_id: 'T1' }] }).success,
      true,
    );
    assert.equal(
      schema.safeParse({ tasks: [{ subject: 'child', parent_id: '../T1' }] }).success,
      false,
    );
  });

  test('task_create forwards parent_id as the storage parent reference', async () => {
    const store = new FakeTaskLedgerStore();
    const create = findTool(buildTaskLedgerTools({ store }), TASK_CREATE_TOOL_NAME);
    await create.impl({ tasks: [{ subject: 'child', parent_id: 'T1' }] }, fakeContext(SESSION_ID));
    assert.deepEqual(store.createCalls[0]?.drafts, [{ subject: 'child', parentId: 'T1' }]);
  });

  test('task_update schema requires id and at least one of status/subject, with the same subject cap', () => {
    const update = findTool(
      buildTaskLedgerTools({ store: new FakeTaskLedgerStore() }),
      TASK_UPDATE_TOOL_NAME,
    );
    const schema = update.parameters as z.ZodTypeAny;
    assert.equal(
      schema.safeParse({ id: 'x', status: 'completed', completionEvidence: 'done' }).success,
      true,
    );
    assert.equal(schema.safeParse({ id: 'x', subject: 'new' }).success, true);
    assert.equal(
      schema.safeParse({ id: 'x', status: 'blocked', blockedReason: 'waiting' }).success,
      true,
    );
    assert.equal(
      schema.safeParse({ id: 'x', status: 'failed', failureReason: 'cannot proceed' }).success,
      true,
    );
    assert.equal(
      schema.safeParse({ id: 'x', status: 'in_progress', explicitReopen: true }).success,
      true,
    );
    assert.equal(schema.safeParse({ id: 'x' }).success, false);
    assert.equal(
      schema.safeParse({ status: 'completed', completionEvidence: 'done' }).success,
      false,
    );
    assert.equal(schema.safeParse({ id: 'x', status: 'bogus' }).success, false);
    assert.equal(schema.safeParse({ id: 'x', status: 'completed' }).success, false);
    assert.equal(schema.safeParse({ id: 'x', status: 'blocked' }).success, false);
    assert.equal(schema.safeParse({ id: 'x', status: 'failed' }).success, false);
    assert.equal(
      schema.safeParse({ id: 'x', subject: 'x'.repeat(TASK_SUBJECT_MAX_CHARS + 1) }).success,
      false,
    );
    assert.equal(
      schema.safeParse({ id: 'x', completionEvidence: 'x'.repeat(TASK_EVIDENCE_MAX_CHARS + 1) })
        .success,
      false,
    );
  });

  test('task_update forwards evidence fields to the store', async () => {
    const store = new FakeTaskLedgerStore();
    const tools = buildTaskLedgerTools({ store });
    const create = findTool(tools, TASK_CREATE_TOOL_NAME);
    const update = findTool(tools, TASK_UPDATE_TOOL_NAME);
    await create.impl({ tasks: [{ subject: '原始' }] }, fakeContext(SESSION_ID));

    const result = await update.impl(
      {
        id: 'id-0',
        status: 'blocked',
        blockedReason: 'waiting for approval',
      },
      fakeContext(SESSION_ID, 'run-2'),
    );
    assert.deepEqual(store.updateCalls.at(-1)?.patch, {
      status: 'blocked',
      blockedReason: 'waiting for approval',
    });
    assert.deepEqual(store.updateCalls.at(-1)?.context, {
      turnId: 'turn-1',
      runId: 'run-2',
      toolCallId: 'call-1',
      source: 'tool',
      actor: 'main_agent',
    });
    assert.match(String(result), /blockedReason/);
  });

  test('task_update forwards explicitReopen without requiring evidence', async () => {
    const store = new FakeTaskLedgerStore();
    const tools = buildTaskLedgerTools({ store });
    const create = findTool(tools, TASK_CREATE_TOOL_NAME);
    const update = findTool(tools, TASK_UPDATE_TOOL_NAME);
    await create.impl({ tasks: [{ subject: 'reopen' }] }, fakeContext(SESSION_ID));

    await update.impl(
      {
        id: 'id-0',
        status: 'in_progress',
        explicitReopen: true,
      },
      fakeContext(SESSION_ID, 'run-3'),
    );

    assert.deepEqual(store.updateCalls.at(-1)?.patch, {
      status: 'in_progress',
      explicitReopen: true,
    });
    assert.deepEqual(store.updateCalls.at(-1)?.context, {
      runId: 'run-3',
      turnId: 'turn-1',
      toolCallId: 'call-1',
      source: 'tool',
      actor: 'main_agent',
    });
  });

  test('task_list and task_get return compact task summaries', async () => {
    const store = new FakeTaskLedgerStore();
    const tools = buildTaskLedgerTools({ store });
    const create = findTool(tools, TASK_CREATE_TOOL_NAME);
    const update = findTool(tools, TASK_UPDATE_TOOL_NAME);
    const list = findTool(tools, TASK_LIST_TOOL_NAME);
    const get = findTool(tools, TASK_GET_TOOL_NAME);
    await create.impl(
      { tasks: [{ subject: 'first' }, { subject: 'second' }] },
      fakeContext(SESSION_ID),
    );
    await update.impl({ id: 'id-1', status: 'in_progress' }, fakeContext(SESSION_ID));

    const listResult = String(await list.impl({}, fakeContext(SESSION_ID)));
    assert.match(listResult, /Task ledger total: 2/);
    assert.match(listResult, /first/);
    assert.match(listResult, /second/);
    assert.equal(listResult.includes('resumeTrust='), false);

    const getResult = String(await get.impl({ id: 'id-1' }, fakeContext(SESSION_ID)));
    assert.match(getResult, /second/);
    assert.equal(getResult.includes('first'), false);
    assert.equal(getResult.includes('resumeTrust='), false);
    assert.equal(
      await get.impl({ id: 'missing' }, fakeContext(SESSION_ID)),
      'No such task: missing',
    );
  });

  test('task_list forwards filters and rejects contradictory terminal options', async () => {
    const store = new FakeTaskLedgerStore();
    store.seed([
      { id: 'a', key: 'T1', subject: 'active', status: 'pending', createdAt: 1, updatedAt: 1 },
      {
        id: 'b',
        key: 'T2',
        subject: 'done',
        status: 'completed',
        completionEvidence: 'ok',
        createdAt: 2,
        updatedAt: 3,
      },
    ]);
    const list = findTool(buildTaskLedgerTools({ store }), TASK_LIST_TOOL_NAME);
    const schema = list.parameters as z.ZodTypeAny;
    assert.equal(schema.safeParse({ status: 'completed', include_terminal: false }).success, false);
    const result = String(
      await list.impl(
        {
          status: 'pending',
          include_terminal: false,
          include_archived: false,
        },
        fakeContext(SESSION_ID),
      ),
    );
    assert.match(result, /active/);
    assert.doesNotMatch(result, /done/);
    assert.deepEqual(store.listCalls.at(-1)?.options, {
      status: 'pending',
      includeTerminal: false,
      includeArchived: false,
    });
  });

  test('task_list and task_get hide untrusted fallback tasks from model-visible output', async () => {
    const store = new FakeTaskLedgerStore();
    store.seed([
      {
        id: 'safe-task',
        key: 'T1',
        subject: 'visible task',
        status: 'pending',
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'fallback-task',
        key: 'T2',
        subject: 'corrupt cache fallback',
        status: 'pending',
        createdAt: 2,
        updatedAt: 2,
        resumeTrust: 'untrusted',
      },
    ]);
    const tools = buildTaskLedgerTools({ store });
    const list = findTool(tools, TASK_LIST_TOOL_NAME);
    const get = findTool(tools, TASK_GET_TOOL_NAME);

    const listResult = String(await list.impl({}, fakeContext(SESSION_ID)));
    assert.match(listResult, /visible task/);
    assert.equal(listResult.includes('corrupt cache fallback'), false);
    assert.equal(listResult.includes('fallback-task'), false);
    assert.equal(listResult.includes('resumeTrust='), false);

    assert.equal(
      await get.impl({ id: 'fallback-task' }, fakeContext(SESSION_ID)),
      'No such task: fallback-task',
    );
  });
});
