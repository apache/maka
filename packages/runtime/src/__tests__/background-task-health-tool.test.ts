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
import { buildBackgroundTaskHealthTool } from '../background-task-health-tool.js';

const context = {
  sessionId: 'session-1',
  turnId: 'turn-1',
  toolCallId: 'tool-1',
  cwd: '/tmp',
  abortSignal: new AbortController().signal,
} as any;
const shell = (status: string, pid?: number) => ({
  kind: 'shell_run',
  ref: 'maka://runtime/background-tasks/run-1',
  status,
  mode: 'pipes',
  cwd: '/tmp',
  cmd: 'python -m http.server',
  startedAt: 1,
  updatedAt: 2,
  revision: 2,
  ...(pid ? { pid } : {}),
});

test('reports process tracking separately when endpoint is not checked', async () => {
  const tool = buildBackgroundTaskHealthTool(
    { readRuntimeResource: async () => shell('running', 1234) } as any,
    {
      probe: async () => {
        throw new Error('must not probe');
      },
    },
  );
  assert.deepEqual(
    JSON.parse(String(await tool.impl({ ref: 'maka://runtime/background-tasks/run-1' }, context))),
    {
      process: { status: 'running', tracked: true, startedAt: 1, updatedAt: 2, pid: 1234 },
      endpoint: { state: 'not_checked' },
    },
  );
});

test('reports endpoint health only from the probe result', async () => {
  let called = 0;
  const tool = buildBackgroundTaskHealthTool(
    { readRuntimeResource: async () => shell('running', 1234) } as any,
    {
      probe: async () => {
        called += 1;
        return { status: 204, statusText: 'No Content', elapsedMs: 4 };
      },
    },
  );
  assert.deepEqual(
    JSON.parse(
      String(
        await tool.impl(
          { ref: 'maka://runtime/background-tasks/run-1', url: 'http://127.0.0.1:8765/' },
          context,
        ),
      ),
    ),
    {
      process: { status: 'running', tracked: true, startedAt: 1, updatedAt: 2, pid: 1234 },
      endpoint: {
        state: 'checked',
        httpStatus: 204,
        elapsedMs: 4,
        target: 'http://127.0.0.1:8765/',
        health: 'healthy',
      },
    },
  );
  assert.equal(called, 1);
});

test('does not convert a failed probe into a ready claim', async () => {
  const tool = buildBackgroundTaskHealthTool(
    { readRuntimeResource: async () => shell('running', 1234) } as any,
    {
      probe: async () => {
        throw new Error('connection refused');
      },
    },
  );
  assert.deepEqual(
    JSON.parse(
      String(
        await tool.impl(
          { ref: 'maka://runtime/background-tasks/run-1', url: 'http://127.0.0.1:8765/' },
          context,
        ),
      ),
    ),
    {
      process: { status: 'running', tracked: true, startedAt: 1, updatedAt: 2, pid: 1234 },
      endpoint: { state: 'unknown', target: 'http://127.0.0.1:8765/', error: 'connection refused' },
    },
  );
});
