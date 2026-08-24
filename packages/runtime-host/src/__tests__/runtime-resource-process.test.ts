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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { isActiveShellRunStatus } from '@maka/core/shell-run';
import { ShellRunProcessManager } from '@maka/runtime/shell-run-manager';
import {
  ShellRunPtyControlClosedError,
  type ShellRunBashInput,
} from '@maka/runtime/shell-run-contract';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import {
  openInteractiveShellRunStoreForWrite,
  type InteractiveShellRunWriter,
} from '@maka/storage/shell-run-authority';
import type { ConnectionContext } from '../server/operation-dispatcher.js';
import { HostRuntimeResourceCoordinator } from '../server/runtime-resource-coordinator.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';

const SESSION_ID = 'real-resource-session';

describe('real Host Runtime Resource process lifecycle', {
  skip: process.platform === 'win32',
}, () => {
  let base: string;
  let owner: Awaited<ReturnType<typeof tryAcquireInteractiveRootOwner>>;
  let writer: InteractiveShellRunWriter;
  let manager: ShellRunProcessManager;
  let coordinator: HostRuntimeResourceCoordinator;
  let activeResidencies = 0;
  let drainRequests = 0;

  before(async () => {
    base = await mkdtemp(join(tmpdir(), 'maka-host-runtime-resource-'));
    const capability = await resolveStorageRoot({
      path: join(base, 'interactive'),
      kind: 'interactive',
    });
    owner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(owner);
    if (!owner) throw new Error('Expected an Interactive root owner');
    writer = await openInteractiveShellRunStoreForWrite(owner.lease);
    manager = new ShellRunProcessManager({
      store: writer,
      newId: randomUUID,
      now: Date.now,
      onShellRunUpdate: (update) => coordinator?.observeShellRunUpdate(update),
    });
    coordinator = new HostRuntimeResourceCoordinator({
      manager,
      sessions: {
        listShellRunUpdates: (sessionId) => manager.listSessionUpdates(sessionId),
        getShellRunUpdate: (sessionId, ref) =>
          manager.getSessionUpdate(sessionId, ref).then((update) => update ?? null),
      },
      sessionHeaders: {
        readHeader: async () => ({ cwd: base, status: 'idle', isArchived: false }),
      },
      sessionAdmission: new SessionAdmissionGate(),
      acquireResidency: () => {
        activeResidencies += 1;
        let active = true;
        return {
          release: () => {
            if (!active) return;
            active = false;
            activeResidencies -= 1;
          },
        };
      },
      requestDrain: () => {
        drainRequests += 1;
      },
    });
  });

  after(async () => {
    await coordinator?.close();
    writer?.close();
    if (owner && !owner.closed) await owner.close();
    await rm(base, { recursive: true, force: true });
  });

  test('runs pipes and serializes one PTY controller across two connections', async () => {
    const foreground = await coordinator.runForegroundBash(
      bashInput('printf foreground-ok', 'call.foreground/1'),
    );
    assert.equal(foreground.status, 'completed');
    assert.equal(foreground.output.mode, 'pipes');
    assert.equal(foreground.output.mode === 'pipes' && foreground.output.stdout, 'foreground-ok');

    const background = await coordinator.runBackgroundBash({
      ...bashInput('IFS= read -r line; printf "received:%s\\n" "$line"', 'call.pty/1'),
      pty: true,
    });
    assert.equal(background.status, 'running');
    assert.equal(background.mode, 'pty');
    assert.equal(activeResidencies, 1);

    const firstConnection = connection('connection-1');
    const secondConnection = connection('connection-2');
    const identity = {
      sessionId: SESSION_ID,
      ref: background.ref,
      controllerId: 'controller-1',
    };
    const acquired = await coordinator.handlers['runtime.resource.controller.acquire'](
      identity,
      firstConnection,
    );
    assert.equal(acquired.ok, true);
    const contested = await coordinator.handlers['runtime.resource.controller.acquire'](
      { ...identity, controllerId: 'controller-2' },
      secondConnection,
    );
    assert.equal(contested.ok, false);
    assert.equal(!contested.ok && contested.error.code, 'operation_conflict');

    const control = {
      ...identity,
      sequence: 1,
      control: { kind: 'input' as const, input: 'hello\r' },
    };
    const controlled = await coordinator.handlers['runtime.resource.controller.control'](
      control,
      firstConnection,
    );
    assert.equal(controlled.ok, true);
    const exactRetry = await coordinator.handlers['runtime.resource.controller.control'](
      control,
      firstConnection,
    );
    assert.deepEqual(exactRetry, controlled);

    const terminal = await waitForTerminal(background.ref);
    assert.equal(terminal.status, 'completed');
    assert.equal(terminal.output.mode, 'pty');
    if (terminal.output.mode === 'pty') {
      assert.match(`${terminal.output.scrollback}\n${terminal.output.screen}`, /received:hello/);
    }
    assert.equal(activeResidencies, 0);

    const release = await coordinator.handlers['runtime.resource.controller.release'](
      identity,
      firstConnection,
    );
    assert.deepEqual(release, {
      ok: true,
      result: { controllerId: 'controller-1', released: false },
    });
    const stopped = await coordinator.handlers['runtime.resource.stop'](
      { sessionId: SESSION_ID, ref: background.ref },
      secondConnection,
    );
    assert.equal(stopped.ok, true);
    assert.equal(stopped.ok && stopped.result.resource.status, 'completed');

    const queried = await coordinator.handlers['runtime.resource.query'](
      { kind: 'get', sessionId: SESSION_ID, ref: background.ref },
      secondConnection,
    );
    assert.equal(queried.ok, true);
    assert.equal(
      queried.ok && queried.result.kind === 'resource' && queried.result.resource?.result.status,
      'completed',
    );
    assert.equal(
      queried.ok && queried.result.kind === 'resource' && queried.result.resource?.sourceToolCallId,
      'call.pty/1',
    );
    assert.equal(drainRequests, 0);
  });

  test('treats control during PTY timeout as a resource conflict without draining Host', async () => {
    const background = await coordinator.runBackgroundBash({
      ...bashInput(
        'trap "" TERM; stty -echo; printf "READY\\n"; while :; do sleep 1; done',
        'call.timeout/1',
      ),
      pty: true,
      timeoutMs: 350,
    });
    assert.equal(background.status, 'running');
    assert.equal(activeResidencies, 1);

    const client = connection('connection-timeout');
    const identity = {
      sessionId: SESSION_ID,
      ref: background.ref,
      controllerId: 'controller-timeout',
    };
    const acquired = await coordinator.handlers['runtime.resource.controller.acquire'](
      identity,
      client,
    );
    assert.equal(acquired.ok, true);

    await waitUntil(async () => {
      try {
        await manager.writeStdin({
          sessionId: SESSION_ID,
          ref: background.ref,
          input: 'x',
        });
        return false;
      } catch (error) {
        if (error instanceof ShellRunPtyControlClosedError) return true;
        throw error;
      }
    });

    const controlled = await coordinator.handlers['runtime.resource.controller.control'](
      { ...identity, sequence: 1, control: { kind: 'input', input: 'late input' } },
      client,
    );
    assert.equal(controlled.ok, false);
    assert.equal(!controlled.ok && controlled.error.code, 'operation_conflict');
    assert.equal(drainRequests, 0);

    const released = await coordinator.handlers['runtime.resource.controller.release'](
      identity,
      client,
    );
    assert.deepEqual(released, {
      ok: true,
      result: { controllerId: 'controller-timeout', released: false },
    });
    const terminal = await waitForTerminal(background.ref);
    assert.equal(terminal.status, 'timed_out');
    assert.equal(activeResidencies, 0);
    assert.equal(drainRequests, 0);
  });

  test('drain terminates a real process and synchronously rejects new startup', async () => {
    const background = await coordinator.runBackgroundBash(bashInput('sleep 60', 'shutdown-tool'));
    assert.equal(background.status, 'running');
    assert.equal(activeResidencies, 1);

    coordinator.beginDrain();
    await assert.rejects(
      () => coordinator.runBackgroundBash(bashInput('printf too-late', 'late-tool')),
      /Runtime resources are draining/,
    );
    await coordinator.close();

    const terminal = await manager.inspectResource(SESSION_ID, background.ref);
    assert.equal(terminal.status, 'cancelled');
    assert.equal(activeResidencies, 0);
    assert.equal(drainRequests, 0);
  });

  async function waitForTerminal(ref: string) {
    const deadline = Date.now() + 10_000;
    while (true) {
      const snapshot = await manager.inspectResource(SESSION_ID, ref);
      if (!isActiveShellRunStatus(snapshot.status)) return snapshot;
      if (Date.now() >= deadline) throw new Error('Timed out waiting for real PTY completion');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  async function waitUntil(check: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (!(await check())) {
      if (Date.now() >= deadline) throw new Error('Timed out waiting for PTY control to close');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
});

function bashInput(command: string, sourceToolCallId: string): ShellRunBashInput {
  return {
    sessionId: SESSION_ID,
    sourceTurnId: 'turn-1',
    sourceToolCallId,
    cwd: process.cwd(),
    command,
    emitOutput: () => {},
  };
}

function connection(connectionId: string): ConnectionContext {
  return {
    hostEpoch: 'host-1',
    connectionId,
    principal: 'local_os_user',
    acquireResidency: () => ({ release: () => {} }),
  };
}
