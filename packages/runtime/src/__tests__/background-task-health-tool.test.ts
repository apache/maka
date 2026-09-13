/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildBackgroundTaskHealthTool } from '../background-task-health-tool.js';

const context = { sessionId: 'session-1', turnId: 'turn-1', toolCallId: 'tool-1', cwd: '/tmp', abortSignal: new AbortController().signal } as any;
const shell = (status: string, pid?: number) => ({ kind: 'shell_run', ref: 'maka://runtime/background-tasks/run-1', status, mode: 'pipes', cwd: '/tmp', cmd: 'python -m http.server', startedAt: 1, updatedAt: 2, revision: 2, ...(pid ? { pid } : {}) });

test('reports process tracking separately when endpoint is not checked', async () => {
  const tool = buildBackgroundTaskHealthTool({ readRuntimeResource: async () => shell('running', 1234) } as any, { probe: async () => { throw new Error('must not probe'); } });
  assert.deepEqual(JSON.parse(String(await tool.impl({ ref: 'maka://runtime/background-tasks/run-1' }, context))), { process: { status: 'running', tracked: true, pid: 1234 }, endpoint: { status: 'not_checked' } });
});

test('reports endpoint health only from the probe result', async () => {
  let called = 0;
  const tool = buildBackgroundTaskHealthTool({ readRuntimeResource: async () => shell('running', 1234) } as any, { probe: async () => { called += 1; return { status: 204, statusText: 'No Content', elapsedMs: 4 }; } });
  assert.deepEqual(JSON.parse(String(await tool.impl({ ref: 'maka://runtime/background-tasks/run-1', url: 'http://127.0.0.1:8765/' }, context))), { process: { status: 'running', tracked: true, pid: 1234 }, endpoint: { status: 204, statusText: 'No Content', elapsedMs: 4, health: 'healthy' } });
  assert.equal(called, 1);
});
