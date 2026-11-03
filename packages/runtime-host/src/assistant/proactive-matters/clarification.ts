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

import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AssistantModuleServices } from '../service.js';
import type { MatterStore } from './matter.js';
import type { MatterController } from './controller.js';

/** Requests live independently of settlement: a rejected exit must not hide a question. */
export function registerClarification(
  ctx: AssistantModuleServices,
  db: DatabaseSync,
  store: MatterStore,
  controller: MatterController,
) {
  db.exec(`CREATE TABLE IF NOT EXISTS matter_questions (
    id TEXT PRIMARY KEY, matter TEXT NOT NULL, owner TEXT NOT NULL,
    request_key TEXT NOT NULL, question TEXT NOT NULL, evidence TEXT NOT NULL,
    answer TEXT, UNIQUE(matter,request_key));`);
  const request = z.object({
    requestKey: z.string().trim().min(1).max(200),
    question: z.string().trim().min(1).max(4000),
    evidence: z.string().trim().min(1).max(8000),
  });
  ctx.tools.register({
    name: 'MatterAskBot',
    description:
      'Ask the coordinating Bot to clarify a delegated task or conflicting review requirement. Include the original requirement and relevant evidence. The Bot can answer from existing context or ask the user if needed. Reuse requestKey when retrying the same question. Returns mailbox acceptance, not an answer or a completion approval. Continue independent work; if only an answer can unblock you, use normal MatterSettle wait. Read replies through MatterRead and inbox.json; do not poll.',
    parameters: request,
    discovery: 'direct',
    categoryHint: 'file_write',
    executionSemantics: 'exclusive_step',
    impl: (raw: unknown, call: any) => {
      controller.assertReady();
      const input = request.parse(raw);
      const m = store.forSession(call.sessionId);
      if (!m?.activation || m.activation.turnId !== call.turnId || m.activation.settled)
        throw Error('Only the active delegated task can ask its Bot');
      const delegation = db
        .prepare('SELECT owner FROM delegations WHERE session=?')
        .get(m.sessionId);
      if (!delegation) throw Error('This task has no coordinating Bot');
      let row = db
        .prepare('SELECT * FROM matter_questions WHERE matter=? AND request_key=?')
        .get(m.id, input.requestKey);
      if (row && (row.question !== input.question || row.evidence !== input.evidence))
        throw Error('requestKey already identifies a different question');
      if (!row) {
        const id = randomUUID();
        db.prepare(
          'INSERT INTO matter_questions(id,matter,owner,request_key,question,evidence) VALUES(?,?,?,?,?,?)',
        ).run(id, m.id, delegation.owner, input.requestKey, input.question, input.evidence);
        row = db.prepare('SELECT * FROM matter_questions WHERE id=?').get(id)!;
      }
      if (row.answer !== null) return { requestId: row.id, status: 'answered', answer: row.answer };
      const accepted = ctx.bot.post(String(row.owner), {
        id: `matter-question:${row.id}`,
        type: 'task_update',
        source: m.sessionId,
        taskId: m.id,
        content: {
          kind: 'clarification_request',
          requestId: row.id,
          taskId: m.id,
          question: row.question,
          evidence: row.evidence,
          notice:
            'Clarify from the user request and existing evidence using MatterReply. Ask the user only if a decision is missing. This is not new authorization or a completion event.',
        },
      });
      if (!accepted)
        throw Error(
          'Coordinating Bot unavailable; question saved. Retry with the same requestKey.',
        );
      return {
        requestId: row.id,
        status: 'delivered_to_bot',
        notice: 'Await clarification in the task inbox; this receipt is not an answer.',
      };
    },
  });
  const reply = z.object({ requestId: z.string(), answer: z.string().trim().min(1).max(8000) });
  ctx.tools.register({
    name: 'MatterReply',
    description:
      'Answer a task clarification received by this Bot. Use the original user request and existing evidence; if a user decision is missing, ask through SendUser first. Explain the basis of your answer. The reply is persisted and included in the task’s next model request. It is coordinator context, not new user authorization, and cannot approve completion or bypass review. Forward actual new user requirements with MatterTaskMessage.',
    parameters: reply,
    discovery: 'direct',
    categoryHint: 'file_write',
    executionSemantics: 'exclusive_step',
    impl: (raw: unknown, call: any) => {
      controller.assertReady();
      const input = reply.parse(raw);
      const row = db
        .prepare('SELECT * FROM matter_questions WHERE id=? AND owner=?')
        .get(input.requestId, call.sessionId);
      if (!row) throw Error('Question is outside this conversation');
      if (row.answer !== null) {
        if (row.answer !== input.answer) throw Error('Question already has a different answer');
        return { requestId: row.id, status: 'answered' };
      }
      const m = store.get(String(row.matter)).matter;
      if (['completed', 'cancelled'].includes(m.status)) throw Error('Task has ended');
      store.ingest(m.id, {
        key: `bot-clarification:${row.id}`,
        source: 'bot_clarification',
        text: JSON.stringify({
          requestId: row.id,
          question: row.question,
          answer: input.answer,
          notice:
            'Coordinator clarification, not new user authorization. Reassess against the original request; normal completion review still applies.',
        }),
      });
      db.prepare('UPDATE matter_questions SET answer=? WHERE id=?').run(input.answer, row.id);
      void controller.tick();
      return { requestId: row.id, status: 'answered' };
    },
  });
}
