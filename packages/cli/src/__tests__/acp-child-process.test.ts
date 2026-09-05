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
import { once } from 'node:events';
import { realpath } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { describe, test } from 'node:test';
import { RequestError, methods } from '@agentclientprotocol/sdk';
import {
  pipeCapturedStdout,
  StdoutCaptureBridge,
  withAcpChildProcessHarness,
} from './acp-child-process-harness.js';

describe('Maka ACP child process', () => {
  test('replays pre-subscription stdout once and continues capture after protocol cancellation', async () => {
    const tap = new PassThrough();
    const bridge = new StdoutCaptureBridge(tap);
    tap.write('early\n');

    const reader = bridge.protocolInput().getReader();
    tap.write('late\n');
    assert.equal(new TextDecoder().decode((await reader.read()).value), 'early\n');
    assert.equal(new TextDecoder().decode((await reader.read()).value), 'late\n');
    await reader.cancel();

    const ended = once(tap, 'end');
    tap.end('after-cancel\n');
    await ended;
    assert.equal(bridge.text, 'early\nlate\nafter-cancel\n');
    assert.deepEqual(
      bridge.snapshot.map((chunk) => new TextDecoder().decode(chunk)),
      ['early\n', 'late\n', 'after-cancel\n'],
    );
    assert.equal(bridge.ended, true);
    assert.equal(bridge.error, undefined);

    const endedTap = new PassThrough();
    const endedBridge = new StdoutCaptureBridge(endedTap);
    const endedEvent = once(endedTap, 'end');
    endedTap.end('already-ended\n');
    await endedEvent;
    const endedReader = endedBridge.protocolInput().getReader();
    assert.equal(new TextDecoder().decode((await endedReader.read()).value), 'already-ended\n');
    assert.deepEqual(await endedReader.read(), { value: undefined, done: true });
  });

  test('replays captured stdout before surfacing its stored error', async () => {
    const tap = new PassThrough();
    const bridge = new StdoutCaptureBridge(tap);
    tap.write('before-error\n');
    const error = new Error('stdout failed');
    const errorEvent = once(tap, 'error');
    tap.destroy(error);
    await errorEvent;

    const reader = bridge.protocolInput().getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value), 'before-error\n');
    await assert.rejects(reader.read(), (actual: unknown) => actual === error);
    assert.equal(bridge.error, error);
  });

  test('forwards a child stdout error into the capture tap', async () => {
    const childStdout = new PassThrough();
    const tap = new PassThrough();
    const bridge = new StdoutCaptureBridge(tap);
    pipeCapturedStdout(childStdout, tap);

    const error = new Error('child stdout failed');
    const errorEvent = once(tap, 'error');
    childStdout.destroy(error);
    await errorEvent;
    assert.equal(bridge.error, error);
  });

  test('accepts only exclusive JSON-RPC request, notification, and response forms', () => {
    for (const message of [
      { jsonrpc: '2.0', method: 'initialize', id: 1 },
      { jsonrpc: '2.0', method: 'session/update' },
      { jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session-1' } },
      { jsonrpc: '2.0', id: 1, result: {} },
      { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found' } },
    ]) {
      assertJsonRpcMessage(message);
    }

    for (const message of [
      { jsonrpc: '2.0', result: {} },
      { jsonrpc: '2.0', id: 1, result: {}, error: { code: -32603, message: 'Internal error' } },
      { jsonrpc: '2.0', method: 'initialize', id: 1, result: {} },
      { jsonrpc: '2.0', method: 'session/update', params: 'not-an-object' },
      { jsonrpc: '2.0', id: 1, error: { code: 'bad', message: 'Method not found' } },
    ]) {
      assert.throws(() => assertJsonRpcMessage(message));
    }
  });

  test('serves ACP without a Runtime Host and exits after stdin EOF', {
    timeout: 30_000,
  }, async () => {
    await withAcpChildProcessHarness(async (harness) => {
      await harness.withClient(async ({ context }) => {
        assert.deepEqual(await context.request(methods.agent.initialize, { protocolVersion: 1 }), {
          protocolVersion: 1,
          agentCapabilities: { sessionCapabilities: { list: {} } },
          authMethods: [],
          agentInfo: { name: 'maka', title: 'Maka', version: '0.2.0' },
        });
        assert.equal(
          await harness.hasRuntimeHostRootMarker(),
          false,
          'initialize must not begin Runtime Host discovery or candidate startup',
        );
      });

      await harness.closeStdin();
      assert.deepEqual(await harness.waitForExit(), { code: 0, signal: null });
      assert.equal(harness.stderr, '');

      const lines = harness.stdout.split(/\r?\n/u).filter((line) => line.trim().length > 0);
      assert.ok(lines.length >= 1, 'expected initialize response');
      for (const line of lines) {
        const message: unknown = JSON.parse(line);
        assertJsonRpcMessage(message);
      }
    });
  });

  test('serves multiple ACP Sessions through a real Runtime Host', {
    timeout: 30_000,
  }, async () => {
    await withAcpChildProcessHarness(
      async (harness) => {
        await harness.withClient(async ({ context }) => {
          await context.request(methods.agent.initialize, { protocolVersion: 1 });
          const first = await context.request(methods.agent.session.new, {
            cwd: harness.workspaceRoot,
            mcpServers: [],
          });
          assert.deepEqual(
            (first.configOptions ?? []).map((option) => [option.id, option.currentValue]),
            [
              ['permission_mode', 'ask'],
              ['collaboration_mode', 'agent'],
              ['orchestration_mode', 'default'],
            ],
          );
          const configured = await context.request(methods.agent.session.setConfigOption, {
            sessionId: first.sessionId,
            configId: 'collaboration_mode',
            value: 'plan',
          });
          assert.deepEqual(
            (configured.configOptions ?? []).map((option) => [option.id, option.currentValue]),
            [
              ['permission_mode', 'ask'],
              ['collaboration_mode', 'plan'],
              ['orchestration_mode', 'default'],
            ],
          );
          const second = await context.request(methods.agent.session.new, {
            cwd: harness.workspaceRoot,
            mcpServers: [],
          });
          assert.notEqual(first.sessionId, second.sessionId);
          const listed = await context.request(methods.agent.session.list, {
            cwd: harness.workspaceRoot,
          });
          assert.deepEqual(
            new Set(listed.sessions.map((session) => session.sessionId)),
            new Set([first.sessionId, second.sessionId]),
          );
          const hostCwd = await realpath(harness.workspaceRoot);
          assert.equal(
            listed.sessions.every((session) => session.cwd === hostCwd),
            true,
          );

          await assert.rejects(
            context.request(methods.agent.session.close, { sessionId: first.sessionId }),
            (error: unknown) => {
              assert.ok(error instanceof RequestError);
              assert.equal(error.code, -32601);
              assert.deepEqual(error.data, { method: 'session/close' });
              return true;
            },
          );
        });

        await harness.closeStdin();
        assert.deepEqual(await harness.waitForExit(), { code: 0, signal: null });
        assert.equal(harness.stderr, '');

        const lines = harness.stdout.split(/\r?\n/u).filter((line) => line.trim().length > 0);
        assert.ok(lines.length >= 5, 'expected initialize, new, list, and method responses');
        for (const line of lines) {
          const message: unknown = JSON.parse(line);
          assertJsonRpcMessage(message);
        }
      },
      { startRuntimeHost: true },
    );
  });

  test('configures every advertised option for a reasoning model through a real Runtime Host', {
    timeout: 30_000,
  }, async () => {
    await withAcpChildProcessHarness(
      async (harness) => {
        await harness.withClient(async ({ context }) => {
          await context.request(methods.agent.initialize, { protocolVersion: 1 });
          const created = await context.request(methods.agent.session.new, {
            cwd: harness.workspaceRoot,
            mcpServers: [],
          });
          assert.deepEqual(
            (created.configOptions ?? []).map(({ id, currentValue }) => [id, currentValue]),
            [
              ['permission_mode', 'ask'],
              ['thinking_level', 'default'],
              ['collaboration_mode', 'agent'],
              ['orchestration_mode', 'default'],
            ],
          );
          const permission = created.configOptions?.find(({ id }) => id === 'permission_mode');
          assert.ok(permission?.type === 'select');
          assert.deepEqual(
            permission.options.flatMap((option) => ('value' in option ? [option.value] : [])),
            ['ask', 'bypass'],
          );
          const thinking = created.configOptions?.find(({ id }) => id === 'thinking_level');
          assert.ok(thinking?.type === 'select');
          assert.deepEqual(
            thinking.options.flatMap((option) => ('value' in option ? [option.value] : [])),
            ['default', 'low', 'high'],
          );

          let configuredOptions = created.configOptions;
          for (const [configId, value] of [
            ['permission_mode', 'bypass'],
            ['thinking_level', 'high'],
            ['collaboration_mode', 'plan'],
            ['orchestration_mode', 'swarm'],
          ] as const) {
            configuredOptions = (
              await context.request(methods.agent.session.setConfigOption, {
                sessionId: created.sessionId,
                configId,
                value,
              })
            ).configOptions;
          }
          assert.deepEqual(
            (configuredOptions ?? []).map(({ id, currentValue }) => [id, currentValue]),
            [
              ['permission_mode', 'bypass'],
              ['thinking_level', 'high'],
              ['collaboration_mode', 'plan'],
              ['orchestration_mode', 'swarm'],
            ],
          );
        });

        await harness.closeStdin();
        assert.deepEqual(await harness.waitForExit(), { code: 0, signal: null });
        assert.equal(harness.stderr, '');
      },
      {
        startRuntimeHost: true,
        model: { id: 'relay-reasoner', thinkingLevels: ['low', 'high'] },
      },
    );
  });

  test('creates more than sixteen Sessions without attaching on a real Runtime Host', {
    timeout: 30_000,
  }, async () => {
    await withAcpChildProcessHarness(
      async (harness) => {
        await harness.withClient(async ({ context }) => {
          await context.request(methods.agent.initialize, { protocolVersion: 1 });
          const createdSessionIds: string[] = [];
          for (let index = 0; index < 17; index += 1) {
            const created = await context.request(methods.agent.session.new, {
              cwd: harness.workspaceRoot,
              mcpServers: [],
            });
            createdSessionIds.push(created.sessionId);
          }

          const listed = await context.request(methods.agent.session.list, {
            cwd: harness.workspaceRoot,
          });
          assert.deepEqual(
            new Set(listed.sessions.map((session) => session.sessionId)),
            new Set(createdSessionIds),
          );
        });

        await harness.closeStdin();
        assert.deepEqual(await harness.waitForExit(), { code: 0, signal: null });
        assert.equal(harness.stderr, '');
      },
      { startRuntimeHost: true },
    );
  });
});

function assertJsonRpcMessage(message: unknown): void {
  assert.ok(message && typeof message === 'object' && !Array.isArray(message));
  const record = message as Record<string, unknown>;
  assert.equal(record.jsonrpc, '2.0');
  if (Object.hasOwn(record, 'method')) {
    assert.equal(typeof record.method, 'string');
    assert.equal(Object.hasOwn(record, 'result'), false);
    assert.equal(Object.hasOwn(record, 'error'), false);
    if (Object.hasOwn(record, 'id')) assertJsonRpcId(record.id);
    if (Object.hasOwn(record, 'params')) {
      assert.ok(
        record.params !== null && typeof record.params === 'object',
        'JSON-RPC method params are an object or array when present',
      );
    }
    return;
  }

  assert.equal(Object.hasOwn(record, 'id'), true, 'a JSON-RPC response requires an id');
  assertJsonRpcId(record.id);
  const hasResult = Object.hasOwn(record, 'result');
  const hasError = Object.hasOwn(record, 'error');
  assert.notEqual(hasResult, hasError, 'a JSON-RPC response has exactly one of result or error');
  if (!hasError) return;
  assert.ok(record.error && typeof record.error === 'object' && !Array.isArray(record.error));
  const error = record.error as Record<string, unknown>;
  assert.equal(typeof error.code, 'number');
  assert.equal(Number.isFinite(error.code), true);
  assert.equal(typeof error.message, 'string');
}

function assertJsonRpcId(id: unknown): void {
  assert.ok(
    id === null || typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id)),
    'a JSON-RPC id is a string, finite number, or null',
  );
}
