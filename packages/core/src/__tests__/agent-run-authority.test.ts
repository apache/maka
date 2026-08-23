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
import { test } from 'node:test';
import { decodeAgentRunHeader, type AgentRunHeader } from '../agent-run.js';

test('rejects a Run header with multiple hosted root authorities', () => {
  assert.throws(
    () =>
      decodeAgentRunHeader({
        ...runHeader(),
        scheduledTaskId: 'scheduled-task-1',
        goalId: 'goal-1',
      }),
    /Invalid AgentRun header schema/,
  );
});

test('decodes a released Automation Run as read-only legacy provenance', () => {
  const decoded = decodeAgentRunHeader({
    ...runHeader(),
    automationId: 'automation-1',
  });
  assert.equal(decoded.legacyAutomationId, 'automation-1');
  assert.equal(Object.hasOwn(decoded, 'automationId'), false);
});

function runHeader(): AgentRunHeader {
  return {
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    status: 'created',
    backendKind: 'fake',
    llmConnectionSlug: 'fake',
    modelId: 'fake-model',
    cwd: '/workspace',
    permissionMode: 'ask',
    createdAt: 1,
    updatedAt: 1,
  };
}
