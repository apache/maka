import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IPty } from 'node-pty';
import type { RuntimeHostSshProcessFactory } from '@maka/runtime-host/client';
import { createDesktopRuntimeHostSshTerminal } from '../runtime-host-ssh-terminal.js';

test('keeps a connecting SSH prompt observable across renderer presentation changes', async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const events: Array<{ kind: string; sessionId: string }> = [];
  const pty = new FakePty();
  let releaseTunnel!: () => void;
  const tunnelReady = new Promise<void>((resolve) => {
    releaseTunnel = resolve;
  });
  const resource = {
    closed: pty.exited,
    close: async () => pty.exit(0),
  };
  const terminal = createDesktopRuntimeHostSshTerminal({
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler as (...args: unknown[]) => unknown),
      removeHandler: (channel) => handlers.delete(channel),
    },
    send: (_channel, event) => events.push(event),
    spawnPty: (() => pty as unknown as IPty) as typeof import('node-pty').spawn,
    revealDelayMs: 0,
    openSshTunnel: async (input, overrides) => {
      const spawnProcess = overrides?.spawnProcess as RuntimeHostSshProcessFactory;
      spawnProcess({ executable: 'ssh', args: [], interaction: input.interaction });
      await tunnelReady;
      return { url: 'ws://127.0.0.1:50000/runtime-host', resource };
    },
  });

  const opening = terminal.openSshTunnel({
    destination: 'operator@example.com',
    remotePort: 7443,
    websocketPath: '/runtime-host',
    interaction: 'terminal',
  });
  pty.emitData('Password: ');
  const getSnapshot = handlers.get('runtime-host-ssh-terminal:getSnapshot');
  assert.ok(getSnapshot);
  const snapshot = await getSnapshot({});
  assert.match(JSON.stringify(snapshot), /Password/u);
  assert.equal((snapshot as { kind?: string }).kind, 'connecting');

  releaseTunnel();
  const tunnel = await opening;
  assert.deepEqual(events.map(({ kind }) => kind), ['opened', 'data', 'connected']);
  assert.deepEqual(await getSnapshot({}), { kind: 'idle', revision: 3 });

  await tunnel.resource.close();
  await terminal.close();
  assert.equal(handlers.size, 0);
});

test('dismisses a closed SSH prompt from the authoritative presentation', async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const pty = new FakePty();
  const terminal = createDesktopRuntimeHostSshTerminal({
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler as (...args: unknown[]) => unknown),
      removeHandler: (channel) => handlers.delete(channel),
    },
    send: () => undefined,
    spawnPty: (() => pty as unknown as IPty) as typeof import('node-pty').spawn,
    revealDelayMs: 0,
    openSshTunnel: async (input, overrides) => {
      const spawnProcess = overrides?.spawnProcess as RuntimeHostSshProcessFactory;
      const process = spawnProcess({ executable: 'ssh', args: [], interaction: input.interaction });
      await process.exited;
      throw new Error('SSH exited');
    },
  });

  const opening = terminal.openSshTunnel({
    destination: 'operator@example.com',
    remotePort: 7443,
    websocketPath: '/runtime-host',
    interaction: 'terminal',
  });
  pty.emitData('Password: ');
  pty.exit(1);
  await assert.rejects(opening, /SSH exited/u);

  const getSnapshot = handlers.get('runtime-host-ssh-terminal:getSnapshot');
  const cancel = handlers.get('runtime-host-ssh-terminal:cancel');
  assert.ok(getSnapshot);
  assert.ok(cancel);
  const closed = (await getSnapshot({})) as { kind: string; sessionId?: string };
  assert.equal(closed.kind, 'closed');
  assert.ok(closed.sessionId);

  await cancel({}, closed.sessionId);
  assert.deepEqual(await getSnapshot({}), { kind: 'idle', revision: 4 });

  await terminal.close();
});

test('does not reopen a cancelled SSH prompt for late process output', async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const events: Array<{ kind: string }> = [];
  const pty = new FakePty();
  pty.deferKill = true;
  const terminal = createDesktopRuntimeHostSshTerminal({
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler as (...args: unknown[]) => unknown),
      removeHandler: (channel) => handlers.delete(channel),
    },
    send: (_channel, event) => events.push(event),
    spawnPty: (() => pty as unknown as IPty) as typeof import('node-pty').spawn,
    revealDelayMs: 0,
    openSshTunnel: async (input, overrides) => {
      const spawnProcess = overrides?.spawnProcess as RuntimeHostSshProcessFactory;
      const process = spawnProcess({ executable: 'ssh', args: [], interaction: input.interaction });
      await process.exited;
      throw new Error('SSH exited');
    },
  });

  const opening = terminal.openSshTunnel({
    destination: 'operator@example.com',
    remotePort: 7443,
    websocketPath: '/runtime-host',
    interaction: 'terminal',
  });
  pty.emitData('Password: ');
  const getSnapshot = handlers.get('runtime-host-ssh-terminal:getSnapshot');
  const cancel = handlers.get('runtime-host-ssh-terminal:cancel');
  assert.ok(getSnapshot);
  assert.ok(cancel);
  const connecting = (await getSnapshot({})) as { sessionId?: string };
  assert.ok(connecting.sessionId);

  await cancel({}, connecting.sessionId);
  pty.emitData('late output');
  pty.exit(1);
  await assert.rejects(opening, /SSH exited/u);

  assert.deepEqual(events.map(({ kind }) => kind), ['opened', 'data']);
  assert.deepEqual(await getSnapshot({}), { kind: 'idle', revision: 3 });
  await terminal.close();
});

class FakePty {
  readonly pid = 42;
  readonly exited: Promise<void>;
  deferKill = false;
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

  exit(code: number): void {
    if (this.#exited) return;
    this.#exited = true;
    for (const listener of this.#exitListeners) listener({ exitCode: code, signal: 0 });
    this.#resolveExit();
  }

  write(): void {}
  resize(): void {}
  kill(): void {
    if (!this.deferKill) this.exit(0);
  }
}
