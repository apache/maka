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
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { IPty } from 'node-pty';
import {
  type RuntimeHostSshProcessFactory,
} from '@maka/runtime-host/client';
import {
  encodeRuntimeHostServiceManagementFrame,
  encodeRuntimeHostSetupFrame,
  RUNTIME_HOST_SETUP_FRAME_PREFIX,
} from '@maka/runtime-host/operator';
import { createDesktopRuntimeHostSshTerminal } from '../runtime-host-ssh-terminal.js';

test('keeps a connecting SSH prompt observable across renderer presentation changes', async () => {
  const harness = createHarness('pending');
  const opening = openTunnel(harness);
  harness.pty.emitData('Password: ');
  const snapshot = await harness.getSnapshot();
  assert.match(JSON.stringify(snapshot), /Password/u);
  assert.equal((snapshot as { kind?: string }).kind, 'connecting');

  harness.releaseTunnel();
  const tunnel = await opening;
  assert.deepEqual(harness.eventKinds(), ['opened', 'data', 'connected']);
  assert.deepEqual(await harness.getSnapshot(), { kind: 'idle', revision: 3 });

  const secondTunnel = await openTunnel(harness);

  await tunnel.resource.close();
  await secondTunnel.resource.close();
  await harness.terminal.close();
  assert.equal(harness.handlers.size, 0);
});

test('dismisses a closed SSH prompt from the authoritative presentation', async () => {
  const harness = createHarness('exit');
  const opening = openTunnel(harness);
  harness.pty.emitData('Password: ');
  harness.pty.exit(1);
  await assert.rejects(opening, /SSH exited/u);

  const closed = (await harness.getSnapshot()) as { kind: string; sessionId?: string };
  assert.equal(closed.kind, 'closed');
  assert.ok(closed.sessionId);

  await harness.cancel(closed.sessionId);
  assert.deepEqual(await harness.getSnapshot(), { kind: 'idle', revision: 4 });

  await harness.terminal.close();
});

test('does not reopen a cancelled SSH prompt for late process output', async () => {
  const harness = createHarness('exit');
  const opening = openTunnel(harness);
  harness.pty.emitData('Password: ');
  const connecting = (await harness.getSnapshot()) as { sessionId?: string };
  assert.ok(connecting.sessionId);

  await harness.cancel(connecting.sessionId);
  harness.pty.emitData('late output');
  await assert.rejects(opening, /SSH exited/u);

  assert.deepEqual(harness.eventKinds(), ['opened', 'data', 'dismissed']);
  assert.deepEqual(await harness.getSnapshot(), { kind: 'idle', revision: 3 });
  await harness.terminal.close();
});

test('keeps setup credentials out of the interactive terminal projection', async () => {
  const harness = createHarness('pending');
  const controller = new AbortController();
  const progress: string[] = [];
  const setup = harness.terminal.runSetup(
    {
      destination: 'operator@example.com',
      setupPackage: { kind: 'npm', specifier: 'maka-agent@1.2.3+desktop.1' },
      principalId: 'desktop:stable-client',
      signal: controller.signal,
    },
    (frame) => progress.push(frame.phase),
  );
  await waitFor(() => harness.pty.hasDataListener());
  harness.pty.emitData('Password: ');
  const progressFrame = encodeRuntimeHostSetupFrame({
    schemaVersion: 1,
    sequence: 0,
    kind: 'progress',
    phase: 'installing_service',
  });
  harness.pty.emitData(progressFrame.slice(0, 12));
  harness.pty.emitData(progressFrame.slice(12));
  const completeFrame = encodeRuntimeHostSetupFrame({
    schemaVersion: 1,
    sequence: 1,
    kind: 'complete',
    version: '0.1.0-beta.1',
    serviceId: 'b'.repeat(64),
    operatorPath: '/home/operator/.local/share/maka/operator',
    rootPath: '/home/operator/.config/Maka/workspaces/default',
    rootId: 'a'.repeat(64),
    endpoint: 'ws://127.0.0.1:7443/runtime-host',
    credentialId: 'credential-1',
    credential: 'secret-access-token',
  });
  harness.pty.emitData(completeFrame);
  controller.abort();
  await Promise.resolve();
  assert.deepEqual(harness.pty.killSignals, []);
  harness.pty.exit(0);

  const result = await setup;
  assert.equal(result.credential, 'secret-access-token');
  assert.deepEqual(progress, ['installing_service']);
  assert.doesNotMatch(JSON.stringify(harness.events), /secret-access-token|MAKA_RUNTIME/u);
  assert.match(JSON.stringify(harness.events), /Password/u);
  assert.match(harness.launchArgs.at(-1)?.at(-1) ?? '', /mktemp -d/u);
  assert.match(harness.launchArgs.at(-1)?.at(-1) ?? '', /--prefix/u);
  assert.match(harness.launchArgs.at(-1)?.at(-1) ?? '', /trap.*HUP.*trap.*INT.*trap.*TERM/u);
  await harness.terminal.close();
});

test('discards an oversized reserved setup line instead of projecting its tail', async () => {
  const harness = createHarness('pending');
  const setup = harness.terminal.runSetup(
    {
      destination: 'operator@example.com',
      setupPackage: { kind: 'npm', specifier: 'maka-agent@1.2.3' },
      principalId: 'desktop:stable-client',
    },
    () => undefined,
  );
  await waitFor(() => harness.pty.hasDataListener());
  harness.pty.emitData(`${RUNTIME_HOST_SETUP_FRAME_PREFIX}${'x'.repeat(21 * 1024)}`);
  harness.pty.emitData('"credential":"must-not-reach-renderer"}\nvisible output\n');
  harness.pty.exit(1);

  await assert.rejects(setup, /oversized result/u);
  assert.doesNotMatch(
    JSON.stringify([harness.events, await harness.getSnapshot()]),
    /must-not-reach-renderer/u,
  );
  assert.match(JSON.stringify(harness.events), /visible output/u);
  await harness.terminal.close();
});

test('keeps a completed setup process owned until it exits', async () => {
  const harness = createHarness('pending');
  const setup = harness.terminal.runSetup(
    {
      destination: 'operator@example.com',
      setupPackage: { kind: 'npm', specifier: 'maka-agent@1.2.3' },
      principalId: 'desktop:stable-client',
    },
    () => undefined,
  );
  await waitFor(() => harness.pty.hasDataListener());
  harness.pty.emitData(encodeRuntimeHostSetupFrame({
    schemaVersion: 1,
    sequence: 0,
    kind: 'complete',
    version: '1.2.3',
    serviceId: 'b'.repeat(64),
    operatorPath: '/home/operator/.local/share/maka/operator',
    rootPath: '/home/operator/.config/Maka/workspaces/default',
    rootId: 'a'.repeat(64),
    endpoint: 'ws://127.0.0.1:7443/runtime-host',
    credentialId: 'credential-1',
    credential: 'secret-access-token',
  }));

  await harness.terminal.close();

  assert.deepEqual(harness.pty.killSignals, ['SIGTERM']);
  assert.equal((await setup).credentialId, 'credential-1');
});

test('force-stops a cancelled setup when SSH ignores graceful termination', async () => {
  const harness = createHarness('pending');
  harness.pty.deferKill = true;
  harness.pty.exitOnForceKill = true;
  const controller = new AbortController();
  const setup = harness.terminal.runSetup(
    {
      destination: 'operator@example.com',
      setupPackage: { kind: 'npm', specifier: 'maka-agent@1.2.3' },
      principalId: 'desktop:stable-client',
      signal: controller.signal,
    },
    () => undefined,
  );
  await waitFor(() => harness.pty.hasDataListener());
  harness.pty.emitData('Password: ');

  controller.abort();

  await assert.rejects(setup, /aborted/u);
  assert.deepEqual(harness.pty.killSignals, ['SIGTERM', 'SIGKILL']);
  assert.deepEqual(harness.eventKinds(), ['opened', 'data', 'dismissed']);
  assert.deepEqual(await harness.getSnapshot(), { kind: 'idle', revision: 3 });
  await harness.terminal.close();
});

test('reads a framed service result without projecting it into the SSH terminal', async () => {
  const harness = createHarness('pending');
  const management = harness.terminal.runServiceManagement({
    destination: 'operator@example.com',
    operatorPath: '/home/operator/.local/share/maka/operator',
    action: 'status',
    expectedTarget: {
      serviceId: 'b'.repeat(64),
      rootPath: '/home/operator/.config/Maka/workspaces/default',
      rootId: 'a'.repeat(64),
    },
  });
  await waitFor(() => harness.pty.hasDataListener());
  const remoteCommand = harness.launchArgs.at(-1)?.at(-1) ?? '';
  assert.match(remoteCommand, /\.local\/share\/maka\/operator/u);
  assert.doesNotMatch(remoteCommand, /npx|maka-agent@/u);
  harness.pty.emitData('Password: ');
  harness.pty.emitData(
    encodeRuntimeHostServiceManagementFrame({
      schemaVersion: 1,
      kind: 'result',
      action: 'status',
      service: {
        platform: 'linux',
        arch: 'x64',
        osRelease: '6.8.0',
        state: 'running',
        pid: 42,
        lastExitCode: 0,
        installedVersion: '1.2.3',
        stateRoot: '/home/operator/.config/Maka/workspaces/default',
        projectDirectoryRoots: [],
      },
    }),
  );
  harness.pty.exit(0);

  const result = await management;
  assert.equal(result.kind, 'result');
  if (result.kind !== 'result') assert.fail('expected service management result');
  assert.equal(result.service.installedVersion, '1.2.3');
  assert.doesNotMatch(JSON.stringify(harness.events), /MAKA_RUNTIME_HOST_SERVICE/u);
  assert.match(JSON.stringify(harness.events), /Password/u);
  await harness.terminal.close();
});

test('rejects a framed service result for a different action', async () => {
  const harness = createHarness('pending');
  const management = harness.terminal.runServiceManagement({
    destination: 'operator@example.com',
    operatorPath: '/home/operator/.local/share/maka/operator',
    action: 'uninstall',
    expectedTarget: {
      serviceId: 'b'.repeat(64),
      rootPath: '/srv/maka',
      rootId: 'a'.repeat(64),
    },
  });
  await waitFor(() => harness.pty.hasDataListener());
  harness.pty.emitData(
    encodeRuntimeHostServiceManagementFrame({
      schemaVersion: 1,
      kind: 'result',
      action: 'status',
      service: {
        platform: 'linux',
        arch: 'x64',
        osRelease: '6.8.0',
        state: 'running',
        pid: 42,
        lastExitCode: 0,
        installedVersion: '1.2.3',
        projectDirectoryRoots: [],
      },
    }),
  );
  harness.pty.exit(0);

  await assert.rejects(management, /returned status for uninstall/u);
  await harness.terminal.close();
});

test('requires an absent operator deployment root to be absent or empty', async () => {
  const harness = createHarness('pending');
  const cleanup = harness.terminal.cleanupManagedDeployment({
    destination: 'operator@example.com',
    operatorPath: '/home/operator/.local/share/maka/operator',
  });
  await waitFor(() => harness.pty.hasDataListener());
  const remoteCommand = harness.launchArgs.at(-1)?.at(-1) ?? '';
  assert.match(remoteCommand, /if \[ ! -e/u);
  assert.match(remoteCommand, /rmdir --/u);
  assert.match(remoteCommand, /home\/operator\/\.local\/share\/maka/u);
  assert.match(remoteCommand, /__cleanup-managed-deployment/u);
  harness.pty.exit(0);

  await cleanup;
  await harness.terminal.close();
});

test('does not launch a management process after the terminal owner closes', async () => {
  const launches: unknown[] = [];
  const terminal = createDesktopRuntimeHostSshTerminal({
    ipcMain: { handle: () => undefined, removeHandler: () => undefined },
    send: () => undefined,
    spawnPty: ((...args: unknown[]) => {
      launches.push(args);
      return new FakePty() as unknown as IPty;
    }) as typeof import('node-pty').spawn,
  });
  await terminal.close();
  await assert.rejects(
    terminal.runServiceManagement({
      destination: 'operator@example.com',
      operatorPath: '/home/operator/.local/share/maka/operator',
      action: 'status',
      expectedTarget: {
        serviceId: 'b'.repeat(64),
        rootPath: '/srv/maka',
        rootId: 'a'.repeat(64),
      },
    }),
    /terminal is closed/u,
  );
  assert.equal(launches.length, 0);
});

test('uploads a development release archive before running the same remote setup', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-runtime-host-development-package-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const archive = join(directory, 'maka-agent-development.tgz');
  await writeFile(archive, 'development package');
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const launches: Array<{ file: string; args: string[]; pty: FakePty }> = [];
  const terminal = createDesktopRuntimeHostSshTerminal({
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler as (...args: unknown[]) => unknown),
      removeHandler: (channel) => handlers.delete(channel),
    },
    send: () => undefined,
    spawnPty: ((file: string, args: string[]) => {
      const pty = new FakePty();
      launches.push({ file, args, pty });
      return pty as unknown as IPty;
    }) as typeof import('node-pty').spawn,
  });
  t.after(() => terminal.close());

  const setupInput = {
    destination: 'operator@example.com',
    setupPackage: { kind: 'development_archive', path: archive } as const,
    principalId: 'desktop:stable-client',
  };
  const setup = terminal.runSetup(setupInput, () => undefined);
  await waitFor(() => launches.length === 1);
  assert.equal(launches[0]?.file, 'scp');
  assert.match(launches[0]?.args.at(-2) ?? '', /maka-agent-development\.tgz$/u);
  assert.match(
    launches[0]?.args.at(-1) ?? '',
    /^operator@example\.com:\.\/\.maka-runtime-host-setup-.+\.tgz$/u,
  );
  launches[0]?.pty.exit(0);

  await waitFor(() => launches.length === 2);
  assert.equal(launches[1]?.file, 'ssh');
  const remoteCommand = launches[1]?.args.at(-1) ?? '';
  assert.match(remoteCommand, /--package.*maka-runtime-host-setup-.+\.tgz/u);
  assert.match(remoteCommand, /--defer-pairing-commit/u);
  assert.match(remoteCommand, /cd.*\$HOME/u);
  assert.match(remoteCommand, /rm -f/u);
  assert.match(remoteCommand, /exec \/bin\/sh -c/u);
  launches[1]?.pty.exit(255);
  await assert.rejects(setup, /exited with code 255/u);
});

function createHarness(mode: 'pending' | 'exit') {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const events: Array<{ kind: string }> = [];
  const pty = new FakePty();
  const launchArgs: string[][] = [];
  let releaseTunnel!: () => void;
  const tunnelReady = new Promise<void>((resolve) => {
    releaseTunnel = resolve;
  });
  const resource = { closed: pty.exited, close: async () => pty.exit(0) };
  const terminal = createDesktopRuntimeHostSshTerminal({
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler as (...args: unknown[]) => unknown),
      removeHandler: (channel) => handlers.delete(channel),
    },
    send: (_channel, event) => events.push(event),
    spawnPty: ((_file: string, args: string[]) => {
      launchArgs.push(args);
      return pty as unknown as IPty;
    }) as typeof import('node-pty').spawn,
    revealDelayMs: 0,
    processStopGraceMs: 1,
    openSshTunnel: async (input, overrides) => {
      const spawnProcess = overrides?.spawnProcess as RuntimeHostSshProcessFactory;
      const process = spawnProcess({ executable: 'ssh', args: [], interaction: input.interaction });
      if (mode === 'pending') {
        await tunnelReady;
        return { url: 'ws://127.0.0.1:50000/runtime-host', resource };
      }
      await process.exited;
      throw new Error('SSH exited');
    },
  });
  const invoke = (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    assert.ok(handler);
    return handler({}, ...args);
  };
  return {
    terminal,
    handlers,
    pty,
    launchArgs,
    releaseTunnel,
    eventKinds: () => events.map(({ kind }) => kind),
    events,
    getSnapshot: () => invoke('runtime-host-ssh-terminal:getSnapshot'),
    cancel: (sessionId: string) => invoke('runtime-host-ssh-terminal:cancel', sessionId),
  };
}

function openTunnel(harness: ReturnType<typeof createHarness>) {
  return harness.terminal.openSshTunnel({
    destination: 'operator@example.com',
    remotePort: 7443,
    websocketPath: '/runtime-host',
    interaction: 'terminal',
  });
}

class FakePty {
  readonly pid = 42;
  readonly exited: Promise<void>;
  deferKill = false;
  exitOnForceKill = false;
  readonly killSignals: Array<string | undefined> = [];
  readonly #dataListeners = new Set<(data: string) => void>();
  readonly #exitListeners = new Set<(event: { exitCode: number; signal: number }) => void>();
  #resolveExit!: () => void;
  #exited = false;

  constructor() {
    this.exited = new Promise((resolve) => {
      this.#resolveExit = resolve;
    });
  }

  onData(listener: (data: string) => void) {
    this.#dataListeners.add(listener);
    return { dispose: () => this.#dataListeners.delete(listener) };
  }

  onExit(listener: (event: { exitCode: number; signal: number }) => void) {
    this.#exitListeners.add(listener);
    return { dispose: () => this.#exitListeners.delete(listener) };
  }

  emitData(data: string): void {
    for (const listener of this.#dataListeners) listener(data);
  }

  hasDataListener(): boolean {
    return this.#dataListeners.size > 0;
  }

  exit(code: number): void {
    if (this.#exited) return;
    this.#exited = true;
    for (const listener of this.#exitListeners) listener({ exitCode: code, signal: 0 });
    this.#resolveExit();
  }

  write(): void {}
  resize(): void {}
  kill(signal?: string): void {
    this.killSignals.push(signal);
    if (!this.deferKill || (this.exitOnForceKill && signal === 'SIGKILL')) this.exit(0);
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail('Condition was not reached');
}
