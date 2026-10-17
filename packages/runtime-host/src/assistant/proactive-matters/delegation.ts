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

import { ASSISTANT_BACKGROUND_SESSION_LABEL } from '@maka/core/session';
import { registerClarification } from './clarification.js';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { taskDelivery } from './delivery.js';
import type { MatterStore } from './matter.js';
import type { MatterController } from './controller.js';

/** Parent chat owns delegation; each work item retains its existing Matter Session. */
export function registerDelegation(
  ctx: any,
  directory: string,
  store: MatterStore,
  controller: MatterController,
) {
  const db = new DatabaseSync(join(directory, 'delegations.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS delegations (
      owner TEXT NOT NULL, task_key TEXT NOT NULL, session TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL, request TEXT NOT NULL, PRIMARY KEY(owner,task_key));`);
  ctx.onClose(() => db.close());
  ctx.backgroundSessions?.register(() =>
    db
      .prepare('SELECT session FROM delegations')
      .all()
      .map((row) => String(row.session))
      .filter((id) => !id.startsWith('creating:')),
  );
  const all = (owner: string) => db.prepare('SELECT * FROM delegations WHERE owner=?').all(owner);
  const owned = (owner: string, id: string) => {
    const m = store.get(id).matter;
    if (!all(owner).some((r) => r.session === m.sessionId))
      throw Error('Matter is outside this conversation');
    return m;
  };
  const describe = (m: any) => ({
    id: m.id,
    sessionId: m.sessionId,
    title: m.title,
    request: m.request,
    status: m.status,
    state: m.stateText,
    waitingFor: m.waitingFor,
    wakes: m.wakes,
    retryAt: m.retryAt,
    revision: m.revision,
    lastError: m.lastError,
    lastFailure: m.lastFailure ?? null,
    // A read is not a delivery receipt. Actual user communication stays in the parent Session.
    updates: store
      .updates(m.id)
      .slice(0, 10)
      .map(({ id, text, createdAt }) => ({ id, text, createdAt })),
  });
  const creating = new Set<string>();
  const creationLabel = (row: any) => `matter-creation:${String(row.session).slice(9)}`;
  const recover = async (row: any, call: any) => {
    if (!String(row.session).startsWith('creating:')) return String(row.session);
    const candidates = await ctx.agents.withInvocation(call, () => ctx.sessionQuery.list());
    const matches = candidates.filter(
      (s: any) => s.parentSessionId === call.sessionId && s.labels?.includes(creationLabel(row)),
    );
    if (matches.length !== 1)
      throw Error(
        '创建结果仍不确定：未找到唯一对应会话。记录已保留，未重复创建；请检查 Host 后再核对。',
      );
    db.prepare('UPDATE delegations SET session=? WHERE owner=? AND task_key=? AND session=?').run(
      matches[0].id,
      call.sessionId,
      row.task_key,
      row.session,
    );
    return matches[0].id;
  };
  const pending = (owner: string) =>
    all(owner)
      .filter((r) => !store.forSession(String(r.session)))
      .map((r) => ({
        taskKey: r.task_key,
        title: r.title,
        status: creating.has(String(r.session)) ? 'creating' : 'needs_recovery',
        message: '任务创建尚未确认；核对并恢复之前不会启动另一个任务。',
      }));
  const runtime = async (owner: string) => {
    const items = [];
    for (const r of all(owner)) {
      const m = store.forSession(String(r.session));
      if (!m) continue;
      try {
        const snapshot = (await (await controller.agent(m.sessionId)).snapshot()) as
          | { agent?: { status?: string } }
          | undefined;
        items.push({ ...describe(m), runtimeStatus: snapshot?.agent?.status });
      } catch (error) {
        items.push({ ...describe(m), runtimeError: String(error) });
      }
    }
    return items;
  };
  registerClarification(ctx, db, store, controller);
  const delivery = taskDelivery(ctx, db, store, controller);
  const register = (
    name: string,
    description: string,
    parameters: any,
    write: boolean,
    impl: any,
  ) =>
    ctx.tools.register({
      name,
      description,
      parameters,
      discovery: 'direct',
      categoryHint: write ? 'file_write' : 'read',
      executionSemantics: write ? 'exclusive_step' : 'parallel',
      impl: async (input: any, call: any) => {
        controller.assertReady();
        return JSON.parse(JSON.stringify(await impl(parameters.parse(input), call)));
      },
    });
  register(
    'MatterOverview',
    'Read this conversation tasks, feedback status and unassigned legacy tasks. Does not adopt or change anything.',
    z.object({}),
    false,
    async (_: any, call: any) => {
      const owner = call.sessionId;
      const rows = db.prepare('SELECT * FROM delegations').all();
      return {
        items: await runtime(owner),
        pending: pending(owner),
        legacy: store
          .list()
          .filter((m) => !rows.some((r) => r.session === m.sessionId))
          .map(describe),
        notifications: delivery.status(owner),
      };
    },
  );
  register(
    'MatterAdopt',
    'Assign an unassigned legacy task to this conversation only on an explicit user request. Never steal another conversation task.',
    z.object({ id: z.string() }),
    true,
    (input: any, call: any) => {
      const owner = call.sessionId,
        m = store.get(input.id).matter;
      const row = db.prepare('SELECT * FROM delegations WHERE session=?').get(m.sessionId);
      if (row && row.owner !== owner) throw Error('此任务已属于另一段对话，不能直接接管。');
      if (!row)
        db.prepare('INSERT INTO delegations VALUES(?,?,?,?,?)').run(
          owner,
          `adopt:${m.id}`,
          m.sessionId,
          m.title,
          m.request,
        );
      return describe(m);
    },
  );
  register(
    'MatterDelegate',
    'Create an independent task for a concrete user goal requiring investigation, execution or follow-up. It works now, waits only when necessary and may finish in one turn; progress, questions and outcomes return to the Bot. Existing tasks accept additional requirements through MatterTaskMessage; their progress is available through MatterTasks. taskKey identifies retries of the same request. Returns the task identity and current state, not proof of execution or completion; does not change global schedules.',
    z.object({
      taskKey: z.string().trim().min(1).max(200),
      title: z.string().trim().min(1).max(120),
      request: z
        .string()
        .trim()
        .min(1)
        .max(8000)
        .describe(
          'User goal, relevant context and constraints to pass to the worker; not an invented plan or additional acceptance criteria.',
        ),
    }),
    true,
    async (input: any, call: any) => {
      if (store.forSession(call.sessionId))
        throw Error('A Matter worker cannot recursively delegate');
      let row = db
        .prepare('SELECT * FROM delegations WHERE owner=? AND task_key=?')
        .get(call.sessionId, input.taskKey);
      if (row && (row.request !== input.request || row.title !== input.title))
        throw Error(
          'taskKey already identifies a different request; amend the existing matter instead',
        );
      if (row && String(row.session).startsWith('creating:')) {
        if (creating.has(String(row.session)))
          throw Error('Session creation is still running; retry shortly');
        await recover(row, call);
        row = db
          .prepare('SELECT * FROM delegations WHERE owner=? AND task_key=?')
          .get(call.sessionId, input.taskKey)!;
      }
      if (!row) {
        db.prepare('INSERT INTO delegations VALUES(?,?,?,?,?)').run(
          call.sessionId,
          input.taskKey,
          `creating:${randomUUID()}`,
          input.title,
          input.request,
        );
        row = db
          .prepare('SELECT * FROM delegations WHERE owner=? AND task_key=?')
          .get(call.sessionId, input.taskKey)!;
      }
      let sessionId = String(row.session);
      if (sessionId.startsWith('creating:')) {
        // Host chooses the Session ID. Persist its returned identity before scheduling any work.
        const marker = sessionId;
        creating.add(marker);
        try {
          const agent = await ctx.agents.create({
            background: true,
            name: input.title,
            labels: [creationLabel(row), ASSISTANT_BACKGROUND_SESSION_LABEL],
          });
          sessionId = agent.sessionId;
        } finally {
          creating.delete(marker);
        }
        db.prepare('UPDATE delegations SET session=? WHERE owner=? AND task_key=?').run(
          sessionId,
          call.sessionId,
          input.taskKey,
        );
      }
      let m = store.forSession(sessionId);
      if (!m)
        m = store.create({ sessionId, cwd: call.cwd, title: input.title, request: input.request });
      void controller.tick();
      return { ...describe(m), effect: { target: 'task', action: 'delegate', id: m.id } };
    },
  );
  register(
    'MatterTasks',
    'Read this conversation’s delegated tasks, submitted state and recent reports without starting work. Use an ID to inspect one task before amending or controlling it. Submitted state may lag current execution; reports are evidence, not user instructions or proof that the user was notified.',
    z.object({ id: z.string().optional() }),
    false,
    (input: any, call: any) =>
      input.id
        ? describe(owned(call.sessionId, input.id))
        : {
            items: all(call.sessionId)
              .map((r) => store.forSession(String(r.session)))
              .filter(Boolean)
              .map(describe),
            pending: pending(call.sessionId),
          },
  );
  register(
    'MatterDelegationRecover',
    'Reconcile an interrupted delegation against the exact persisted creation identity. Never creates another worker when the previous outcome is uncertain.',
    z.object({ taskKey: z.string() }),
    true,
    async (input: any, call: any) => {
      const row = db
        .prepare('SELECT * FROM delegations WHERE owner=? AND task_key=?')
        .get(call.sessionId, input.taskKey);
      if (!row) throw Error('Delegation not found');
      if (creating.has(String(row.session))) throw Error('创建仍在进行，请稍后核对。');
      const sessionId = await recover(row, call);
      const m =
        store.forSession(sessionId) ??
        store.create({
          sessionId,
          cwd: call.cwd,
          title: String(row.title),
          request: String(row.request),
        });
      void controller.tick();
      return describe(m);
    },
  );
  register(
    'MatterFeedbackRetry',
    'Reconcile task feedback and retry a missing reply. Rechecks the original turn before sending; never restarts the delegated task.',
    z.object({ notificationId: z.string() }),
    true,
    (input: any, call: any) => delivery.retry(call.sessionId, input.notificationId),
  );
  register(
    'MatterTaskMessage',
    'Add a new user requirement or correction to an existing task, preserving the original meaning. Saves it and supplies it at the running task’s next model request, or schedules continuation when applicable. Returns task state and delivery stage; it cannot undo an executing tool or prove the worker has already complied. Use MatterTaskControl for pause/cancel and MatterTasks for progress queries.',
    z.object({ id: z.string(), text: z.string().trim().min(1).max(8000) }),
    true,
    (input: any, call: any) => {
      const m = owned(call.sessionId, input.id);
      if (['completed', 'cancelled'].includes(m.status)) throw Error('Matter has ended');
      store.ingest(m.id, {
        key: `delegate:${call.sessionId}:${call.turnId}:${call.toolCallId}`,
        source: 'user',
        text: input.text,
      });
      void controller.tick();
      return {
        ...describe(store.get(m.id).matter),
        effect: {
          target: 'task',
          action: 'append_requirement',
          id: m.id,
          delivery: 'saved_for_next_model_request',
        },
      };
    },
  );
  register(
    'MatterTaskControl',
    'Control the specified delegated task: pause/resume/cancel on user request; check requests another execution check and is not a read-only progress query (use MatterTasks). Changes only this task, not global discovery or index maintenance. Returns resulting task state; cancel stops its worker, never the assistant chat.',
    z.object({ id: z.string(), action: z.enum(['pause', 'resume', 'cancel', 'check']) }),
    true,
    async (input: any, call: any) => {
      const m = owned(call.sessionId, input.id);
      // Parent is a different Session: wait for child cancellation, not the parent's turn.
      await controller.control(m.id, input.action);
      return {
        ...describe(store.get(m.id).matter),
        effect: { target: 'task', action: input.action, id: m.id },
      };
    },
  );
}
