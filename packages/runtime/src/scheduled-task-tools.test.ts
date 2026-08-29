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

import assert from 'node:assert/strict';
import test from 'node:test';
import type { ScheduledTaskExecutionTemplate } from '@maka/core/scheduled-task';
import { buildAgentScheduledTaskCreatePayload } from './scheduled-task-tools.js';

function payload(execution: ScheduledTaskExecutionTemplate) {
  return buildAgentScheduledTaskCreatePayload({
    title: 'Review workspace',
    intentBody: 'Review ordinary Session history.',
    schedule: { kind: 'once', runAt: 2_000 },
    effect: 'agent_run',
    sessionId: 'creator-session',
    execution,
    now: 1_000,
  });
}

test('rejects a new Agent ScheduledTask without immutable Connection identity', () => {
  const execution = {
    cwd: '/workspace',
    llmConnectionSlug: 'legacy-default',
    model: 'model-id',
    permissionMode: 'ask',
    collaborationMode: 'agent',
    orchestrationMode: 'default',
  } satisfies ScheduledTaskExecutionTemplate;

  assert.deepEqual(payload(execution), {
    error: 'agent_run requires immutable Connection identity from the creator session',
  });
  assert.equal(
    'error' in payload({ ...execution, llmConnectionId: 'connection-id' }),
    false,
  );
});
