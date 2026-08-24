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
import { describe, test } from 'node:test';
import { RunTrace, type RunTraceEvent } from '../run-trace.js';

describe('RunTrace error diagnostics', () => {
  test('records a path-free active sandbox snapshot', () => {
    const events: RunTraceEvent[] = [];
    const trace = new RunTrace({
      sessionId: 'session-1',
      turnId: 'turn-1',
      connectionSlug: 'deepseek',
      providerId: 'openai-compatible',
      modelId: 'deepseek-v4-pro',
      newId: () => `trace-${events.length + 1}`,
      now: () => 123,
      record: (event) => events.push(event),
    });

    trace.sandboxContextResolved({
      schemaVersion: 1,
      platform: 'darwin',
      profile: {
        name: 'workspace-write',
        type: 'managed',
        fileSystem: 'workspace-write',
        network: 'restricted',
        protectedMetadata: ['.git'],
      },
      capabilities: {
        command: {
          status: 'available',
          backend: 'macos-seatbelt',
          selectionReason: 'platform_sandbox_selected',
        },
        filesystem: {
          status: 'unavailable',
          backend: 'macos-seatbelt',
          failure: { stage: 'launch', reason: 'filesystem_worker_unavailable' },
        },
      },
    });

    assert.equal(events[0]?.type, 'sandbox_context_resolved');
    assert.equal(events[0]?.phase, 'sandbox');
    assert.equal(JSON.stringify(events[0]).includes('/Users/'), false);
    const snapshot = events[0]?.data?.snapshot as { profile?: { name?: string } } | undefined;
    assert.equal(snapshot?.profile?.name, 'workspace-write');
  });

  test('model stream failures keep generic copy plus redacted raw diagnostics', () => {
    const events: RunTraceEvent[] = [];
    const trace = new RunTrace({
      sessionId: 'session-1',
      turnId: 'turn-1',
      connectionSlug: 'deepseek',
      providerId: 'openai-compatible',
      modelId: 'deepseek-v4-pro',
      newId: () => `trace-${events.length + 1}`,
      now: () => 123,
      record: (event) => events.push(event),
    });
    const error = new TypeError(
      'Cannot read properties of undefined (reading "role") token=sk-live-secret-token-value',
    );
    error.stack = [
      'TypeError: Cannot read properties of undefined (reading "role") token=sk-live-secret-token-value',
      '    at projectRequest (file:///repo/packages/runtime/src/ai-sdk-backend.ts:123:45)',
    ].join('\n');

    trace.modelStreamFailed('TypeError', error);

    assert.equal(events.length, 1);
    const data = events[0]?.data ?? {};
    assert.equal(data.errorClass, 'TypeError');
    assert.equal(data.error, 'Operation failed');
    assert.equal(data.rawErrorName, 'TypeError');
    assert.equal(data.rawErrorType, 'object');
    assert.match(String(data.redactedErrorMessage), /Cannot read properties/);
    assert.match(String(data.redactedErrorMessage), /token=\[redacted\]/);
    assert.match(String(data.redactedErrorMessageSha256), /^sha256:[a-f0-9]{64}$/);
    assert.match(String(data.redactedErrorStackSha256), /^sha256:[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(data).includes('sk-live-secret-token-value'), false);
  });

  test('model stream failure diagnostics are bounded', () => {
    const events: RunTraceEvent[] = [];
    const trace = new RunTrace({
      sessionId: 'session-1',
      turnId: 'turn-1',
      connectionSlug: 'deepseek',
      providerId: 'openai-compatible',
      modelId: 'deepseek-v4-pro',
      newId: () => `trace-${events.length + 1}`,
      now: () => 123,
      record: (event) => events.push(event),
    });

    trace.modelStreamFailed(undefined, new Error('x'.repeat(3_000)));

    const data = events[0]?.data ?? {};
    assert.equal(String(data.redactedErrorMessage).length, 2_048);
    assert.equal(data.redactedErrorMessageTruncated, true);
    assert.match(String(data.redactedErrorMessageSha256), /^sha256:[a-f0-9]{64}$/);
  });

  test('model stream failure diagnostics preserve redacted structured error fields', () => {
    const events: RunTraceEvent[] = [];
    const trace = new RunTrace({
      sessionId: 'session-1',
      turnId: 'turn-1',
      connectionSlug: 'sub2api',
      providerId: 'openai',
      modelId: 'gpt-test',
      newId: () => `trace-${events.length + 1}`,
      now: () => 123,
      record: (event) => events.push(event),
    });

    trace.modelStreamFailed('Other', {
      status: 502,
      code: 'upstream_reset',
      message: 'upstream stream reset',
      apiKey: 'sk-live-secret-token-value',
    });

    const data = events[0]?.data ?? {};
    assert.equal(data.rawErrorName, 'object');
    assert.equal(data.rawErrorType, 'object');
    assert.match(String(data.redactedErrorMessage), /upstream stream reset/);
    assert.match(String(data.redactedErrorMessage), /upstream_reset/);
    assert.match(String(data.redactedErrorMessage), /"apiKey":"\[redacted\]"/);
    assert.equal(String(data.redactedErrorMessage).includes('sk-live-secret-token-value'), false);
  });
});
