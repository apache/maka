import { defineInteractiveRuntimeHostComposition } from '../server/host-composition.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { isActiveShellRunStatus } from '@maka/core/shell-run';
import { ShellRunProcessManager } from '@maka/runtime/shell-run-manager';
import {
  resolveRootControlNamespace,
  resolveStorageRoot,
  tryAcquireInteractiveRootOwner,
} from '@maka/storage/root-authority';
import { openInteractiveShellRunStoreForWrite } from '@maka/storage/shell-run-authority';
import {
  connectRuntimeHost,
  type RuntimeHostConnection,
  RuntimeHostOperationError,
} from '../client/index.js';
import { RUNTIME_HOST_PROTOCOL_VERSION } from '../protocol/index.js';
import { RuntimeHostKernel } from '../server/host-kernel.js';
import { createUnavailableDomainOperationHandlers } from '../server/operation-dispatcher.js';
import { HostRuntimeResourceCoordinator } from '../server/runtime-resource-coordinator.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';

const SESSION_ID = 'runtime-resource-continuity';
const PROTOCOL = {
  min: RUNTIME_HOST_PROTOCOL_VERSION,
  max: RUNTIME_HOST_PROTOCOL_VERSION,
} as const;

test('a Host-owned PTY survives Desktop disconnect and transfers control to TUI', {
  skip: process.platform === 'win32' ? 'POSIX UDS and shell integration' : false,
  timeout: 30_000,
}, async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-runtime-resource-two-client-'));
  const root = join(base, 'interactive');
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  let owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) return;
  let resources: HostRuntimeResourceCoordinator | undefined;
  let host: RuntimeHostKernel | undefined;
  let desktop: RuntimeHostConnection | undefined;
  let tui: RuntimeHostConnection | undefined;

  try {
    host = await RuntimeHostKernel.start({
      owner,
      idleGraceMs: 30_000,
      composition: defineInteractiveRuntimeHostComposition(async (context) => {
        const writer = await openInteractiveShellRunStoreForWrite(context.owner.lease);
        let coordinator: HostRuntimeResourceCoordinator;
        const manager = new ShellRunProcessManager({
          store: writer,
          newId: randomUUID,
          now: Date.now,
          onShellRunUpdate: (update) => coordinator.observeShellRunUpdate(update),
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
          acquireResidency: () => context.acquireResidency('runtime-resource'),
          requestDrain: context.requestDrain,
        });
        resources = coordinator;
        return {
          handlers: {
            ...createUnavailableDomainOperationHandlers(),
            ...coordinator.handlers,
          },
          releaseConnection: (connectionId) => coordinator.releaseConnection(connectionId),
          beginDrain: () => coordinator.beginDrain(),
          recover: async () => undefined,
          close: async () => {
            await coordinator.close();
            writer.close();
          },
        };
      }),
    });
    owner = undefined;
    assert.ok(resources);

    const started = await resources.runBackgroundBash({
      sessionId: SESSION_ID,
      sourceTurnId: 'turn-1',
      sourceToolCallId: 'tool.pty/continuity',
      cwd: process.cwd(),
      command:
        'stty -echo; printf "READY\\n"; IFS= read -r first; printf "desktop:%s\\n" "$first"; IFS= read -r second; printf "tui:%s\\n" "$second"; while :; do sleep 1; done',
      pty: true,
      emitOutput: () => undefined,
    });
    assert.equal(started.status, 'running');

    [desktop, tui] = await Promise.all([connect(root, 'desktop'), connect(root, 'tui')]);
    const desktopList = await desktop.request('runtime.resource.query', {
      kind: 'list_start',
      sessionId: SESSION_ID,
    });
    const tuiList = await tui.request('runtime.resource.query', {
      kind: 'list_start',
      sessionId: SESSION_ID,
    });
    assert.deepEqual(tuiList, desktopList);

    const desktopController = {
      sessionId: SESSION_ID,
      ref: started.ref,
      controllerId: 'desktop-controller',
    };
    const acquiredByDesktop = await desktop.request(
      'runtime.resource.controller.acquire',
      desktopController,
    );
    assert.equal(acquiredByDesktop.controllerId, desktopController.controllerId);
    await desktop.request('runtime.resource.controller.control', {
      ...desktopController,
      sequence: acquiredByDesktop.nextSequence,
      control: { kind: 'input_and_resize', input: 'first\r', cols: 100, rows: 30 },
    });
    await waitForOutput(tui, started.ref, /desktop:first/);

    await desktop.close();
    desktop = undefined;

    const tuiController = {
      sessionId: SESSION_ID,
      ref: started.ref,
      controllerId: 'tui-controller',
    };
    const acquiredByTui = await waitForController(tui, tuiController);
    await tui.request('runtime.resource.controller.control', {
      ...tuiController,
      sequence: acquiredByTui.nextSequence,
      control: { kind: 'input_and_resize', input: 'second\r', cols: 120, rows: 40 },
    });
    const continued = await waitForOutput(tui, started.ref, /tui:second/);
    const continuedOutput = continued.output;
    assert.ok(continuedOutput);
    assert.equal(continuedOutput?.mode, 'pty');
    if (!continuedOutput || continuedOutput.mode !== 'pty') {
      throw new Error('Runtime Resource did not retain PTY output');
    }
    assert.equal(continuedOutput.cols, 120);
    assert.equal(continuedOutput.rows, 40);
    const output = `${continuedOutput.scrollback}\n${continuedOutput.screen}`;
    assert.equal(output.match(/desktop:first/g)?.length, 1);
    assert.equal(output.match(/tui:second/g)?.length, 1);

    const stopped = await tui.request('runtime.resource.stop', {
      sessionId: SESSION_ID,
      ref: started.ref,
    });
    assert.equal(stopped.resource.status, 'cancelled');
    const terminal = await waitForTerminal(tui, started.ref);
    assert.equal(terminal.status, 'cancelled');
  } finally {
    await Promise.allSettled([desktop?.close(), tui?.close()]);
    await host?.close().catch(() => undefined);
    await owner?.close().catch(() => undefined);
    await rm(join(resolveRootControlNamespace(), capability.rootId), {
      recursive: true,
      force: true,
    });
    await rm(base, { recursive: true, force: true });
  }
});

async function connect(
  rootPath: string,
  surface: 'desktop' | 'tui',
): Promise<RuntimeHostConnection> {
  const result = await connectRuntimeHost({ rootPath, surface, protocol: PROTOCOL });
  assert.equal(result.kind, 'connected');
  if (result.kind !== 'connected') throw new Error('Runtime Host Client did not connect');
  return result.connection;
}

async function waitForController(
  client: RuntimeHostConnection,
  input: { sessionId: string; ref: string; controllerId: string },
) {
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      return await client.request('runtime.resource.controller.acquire', input);
    } catch (error) {
      if (!(error instanceof RuntimeHostOperationError) || error.code !== 'operation_conflict') {
        throw error;
      }
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

async function waitForOutput(client: RuntimeHostConnection, ref: string, pattern: RegExp) {
  const deadline = Date.now() + 10_000;
  while (true) {
    const resource = await queryResource(client, ref);
    if (resource.output?.mode === 'pty') {
      const output = `${resource.output.scrollback}\n${resource.output.screen}`;
      if (pattern.test(output)) return resource;
    }
    if (Date.now() >= deadline) throw new Error(`PTY output did not match ${pattern}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForTerminal(client: RuntimeHostConnection, ref: string) {
  const deadline = Date.now() + 10_000;
  while (true) {
    const resource = await queryResource(client, ref);
    if (!isActiveShellRunStatus(resource.status)) return resource;
    if (Date.now() >= deadline) throw new Error('PTY did not stop before the deadline');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function queryResource(client: RuntimeHostConnection, ref: string) {
  const result = await client.request('runtime.resource.query', {
    kind: 'get',
    sessionId: SESSION_ID,
    ref,
  });
  assert.equal(result.kind, 'resource');
  assert.ok(result.kind === 'resource' && result.resource);
  if (result.kind !== 'resource' || !result.resource) {
    throw new Error('Runtime Resource disappeared');
  }
  return result.resource.result;
}
