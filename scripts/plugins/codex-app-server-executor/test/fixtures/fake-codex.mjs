#!/usr/bin/env node

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

import { createInterface } from 'node:readline';

if (process.argv.slice(2).join(' ') !== 'app-server --stdio') process.exit(64);

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
let threadStarts = 0;
let turnCount = 0;
let pendingApproval;
let interrupted;
let threadModel;
let turnModel;
let turnEffort;

function completeTurn(input, approvalDecision = 'none') {
  const turnId = `turn-${turnCount}`;
  send({
    method: 'item/completed',
    params: {
      threadId: 'thread-1',
      turnId,
      completedAtMs: Date.now(),
      item: {
        id: `command-${turnCount}`,
        type: 'commandExecution',
        command: 'printf fake',
        cwd: process.cwd(),
        status: approvalDecision === 'decline' ? 'declined' : 'completed',
        commandActions: [],
        aggregatedOutput: approvalDecision === 'decline' ? null : 'fake output',
        exitCode: approvalDecision === 'decline' ? null : 0,
        durationMs: 1,
      },
    },
  });
  send({
    method: 'item/reasoning/summaryTextDelta',
    params: {
      threadId: 'thread-1',
      turnId,
      itemId: `reasoning-${turnCount}`,
      delta: 'Checked by fake Codex. ',
      summaryIndex: 0,
    },
  });
  const text = `Codex handled: ${input} (threadStarts=${threadStarts}, threadModel=${String(threadModel)}, turnModel=${String(turnModel)}, turnEffort=${String(turnEffort)}, approval=${approvalDecision})`;
  send({
    method: 'item/agentMessage/delta',
    params: {
      threadId: 'thread-1',
      turnId,
      itemId: `message-${turnCount}`,
      delta: text,
    },
  });
  send({
    method: 'item/completed',
    params: {
      threadId: 'thread-1',
      turnId,
      completedAtMs: Date.now(),
      item: {
        id: `message-${turnCount}`,
        type: 'agentMessage',
        text,
        phase: 'final_answer',
      },
    },
  });
  send({
    method: 'turn/completed',
    params: {
      threadId: 'thread-1',
      turn: { id: turnId, status: 'completed', items: [], error: null },
    },
  });
}

for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ id: message.id, result: { userAgent: 'fake-codex' } });
  } else if (message.method === 'model/list') {
    send({
      id: message.id,
      result: {
        data: [
          {
            model: 'gpt-fake',
            displayName: 'GPT Fake',
            description: 'Fixture model',
            isDefault: true,
            defaultReasoningEffort: 'medium',
            supportedReasoningEfforts: [
              { reasoningEffort: 'low', description: 'Fast' },
              { reasoningEffort: 'medium', description: 'Balanced' },
            ],
          },
        ],
        nextCursor: null,
      },
    });
  } else if (message.method === 'thread/start') {
    threadStarts += 1;
    threadModel = message.params.model;
    send({
      id: message.id,
      result: { thread: { id: 'thread-1', ephemeral: true } },
    });
  } else if (message.method === 'turn/start') {
    turnCount += 1;
    turnModel = message.params.model;
    turnEffort = message.params.effort;
    const turnId = `turn-${turnCount}`;
    send({
      id: message.id,
      result: { turn: { id: turnId, status: 'inProgress', items: [] } },
    });
    send({
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        turnId,
        startedAtMs: Date.now(),
        item: {
          id: `command-${turnCount}`,
          type: 'commandExecution',
          command: 'printf fake',
          cwd: process.cwd(),
          status: 'inProgress',
          commandActions: [],
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
        },
      },
    });
    send({
      method: 'item/commandExecution/outputDelta',
      params: {
        threadId: 'thread-1',
        turnId,
        itemId: `command-${turnCount}`,
        delta: 'pending',
      },
    });
    const input = message.params.input[0].text;
    if (input.includes('WAIT_FOR_INTERRUPT')) {
      interrupted = { turnId, omitCompletion: input.includes('OMIT_COMPLETION') };
    } else {
      pendingApproval = { id: 10_000 + turnCount, input };
      send({
        id: pendingApproval.id,
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: 'thread-1',
          turnId,
          itemId: `command-${turnCount}`,
        },
      });
    }
  } else if (pendingApproval && message.id === pendingApproval.id) {
    const current = pendingApproval;
    pendingApproval = undefined;
    completeTurn(current.input, message.result?.decision);
  } else if (message.method === 'turn/interrupt') {
    send({ id: message.id, result: {} });
    const turnId = interrupted?.turnId ?? message.params.turnId;
    if (!interrupted?.omitCompletion) {
      send({
        method: 'turn/completed',
        params: {
          threadId: 'thread-1',
          turn: { id: turnId, status: 'interrupted', items: [], error: null },
        },
      });
    }
    interrupted = undefined;
  }
}
