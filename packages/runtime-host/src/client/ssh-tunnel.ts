import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeHostConnectionResource } from './connection.js';

const SSH_BATCH_START_TIMEOUT_MS = 15_000;
const SSH_INTERACTIVE_START_TIMEOUT_MS = 120_000;
const SSH_STOP_TIMEOUT_MS = 2_000;
const SSH_LOCAL_BIND_ATTEMPTS = 3;

export type RuntimeHostSshInteraction = 'batch' | 'inherit' | 'terminal';

export interface RuntimeHostSshTunnelInput {
  readonly destination: string;
  readonly sshPort?: number;
  readonly remotePort: number;
  readonly websocketPath: string;
  readonly interaction: RuntimeHostSshInteraction;
  readonly signal?: AbortSignal;
  readonly startTimeoutMs?: number;
}

export interface RuntimeHostSshProcess {
  readonly pid?: number;
  readonly exited: Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>;
  kill(signal: NodeJS.Signals): void;
}

export type RuntimeHostSshProcessFactory = (input: {
  readonly executable: 'ssh';
  readonly args: readonly string[];
  readonly interaction: RuntimeHostSshInteraction;
}) => RuntimeHostSshProcess;

type RuntimeHostSshConfigurationReader = (input: {
  readonly destination: string;
  readonly sshPort?: number;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
}) => Promise<string>;

export interface RuntimeHostSshTunnel {
  readonly url: string;
  readonly resource: RuntimeHostConnectionResource;
}

export async function openRuntimeHostSshTunnel(
  input: RuntimeHostSshTunnelInput,
  overrides: {
    readonly spawnProcess?: RuntimeHostSshProcessFactory;
    readonly readConfiguration?: RuntimeHostSshConfigurationReader;
  } = {},
): Promise<RuntimeHostSshTunnel> {
  input.signal?.throwIfAborted();
  const destination = requireSshDestination(input.destination);
  const sshPort = input.sshPort === undefined ? undefined : requirePort(input.sshPort, 'SSH port');
  const remotePort = requirePort(input.remotePort, 'Runtime Host remote port');
  const websocketPath = requireWebSocketPath(input.websocketPath);
  const startTimeoutMs =
    input.startTimeoutMs ??
    (input.interaction === 'batch' ? SSH_BATCH_START_TIMEOUT_MS : SSH_INTERACTIVE_START_TIMEOUT_MS);
  const configuration = await (overrides.readConfiguration ?? readSshConfiguration)({
    destination,
    ...(sshPort === undefined ? {} : { sshPort }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    timeoutMs: Math.min(startTimeoutMs, SSH_BATCH_START_TIMEOUT_MS),
  });
  assertNoConfiguredForwarding(configuration);
  for (let attempt = 1; attempt <= SSH_LOCAL_BIND_ATTEMPTS; attempt += 1) {
    input.signal?.throwIfAborted();
    const localPort = await allocateLoopbackPort();
    const readiness = await createSshForwardReadiness(localPort);
    const args = [
      '-v',
      '-E',
      readiness.logPath,
      '-N',
      '-T',
      '-o',
      'ExitOnForwardFailure=yes',
      '-o',
      `ConnectTimeout=${Math.max(1, Math.ceil(Math.min(startTimeoutMs, SSH_BATCH_START_TIMEOUT_MS) / 1_000))}`,
      '-o',
      input.interaction === 'batch' ? 'BatchMode=yes' : 'BatchMode=no',
      '-o',
      'ControlMaster=no',
      '-o',
      'ControlPath=none',
      '-o',
      'ClearAllForwardings=no',
      '-o',
      'ForkAfterAuthentication=no',
      '-L',
      `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
      ...(sshPort === undefined ? [] : ['-p', String(sshPort)]),
      destination,
    ];
    let child: RuntimeHostSshProcess;
    try {
      input.signal?.throwIfAborted();
      child = (overrides.spawnProcess ?? spawnSshProcess)({
        executable: 'ssh',
        args,
        interaction: input.interaction,
      });
    } catch (error) {
      await readiness.close();
      throw error;
    }
    const resource = new SshTunnelResource(child, input.signal, readiness.close);
    try {
      await waitForForward(readiness, resource, startTimeoutMs, input.interaction);
      return {
        url: `ws://127.0.0.1:${localPort}${websocketPath}`,
        resource,
      };
    } catch (error) {
      await resource.close().catch(() => undefined);
      if (error instanceof SshLocalBindConflictError && attempt < SSH_LOCAL_BIND_ATTEMPTS) continue;
      throw error;
    }
  }
  throw new Error('SSH tunnel did not become ready');
}

class SshTunnelResource implements RuntimeHostConnectionResource {
  readonly closed: Promise<void>;
  readonly exited: Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>;
  readonly #child: RuntimeHostSshProcess;
  readonly #signal: AbortSignal | undefined;
  readonly #onAbort: () => void;
  readonly #closeReadiness: () => Promise<void>;
  #hasExited = false;
  #closeTask: Promise<void> | undefined;

  constructor(
    child: RuntimeHostSshProcess,
    signal: AbortSignal | undefined,
    closeReadiness: () => Promise<void>,
  ) {
    this.#child = child;
    this.#signal = signal;
    this.exited = child.exited.finally(() => {
      this.#hasExited = true;
    });
    this.#closeReadiness = closeReadiness;
    this.closed = this.exited.then(() => undefined);
    // `closed` is also an observation signal for the connection. Keep its
    // rejection observable to consumers without letting an SSH spawn failure
    // become an unhandled rejection before the connection attaches.
    void this.closed.catch(() => undefined);
    this.#onAbort = () => void this.close();
    signal?.addEventListener('abort', this.#onAbort, { once: true });
  }

  close(): Promise<void> {
    this.#closeTask ??= this.#close();
    return this.#closeTask;
  }

  async #close(): Promise<void> {
    this.#signal?.removeEventListener('abort', this.#onAbort);
    try {
      if (!this.#hasExited) {
        if (process.platform === 'win32' && this.#child.pid !== undefined) {
          await terminateWindowsProcessTree(this.#child.pid);
        } else {
          this.#child.kill('SIGTERM');
          const killTimer = setTimeout(() => this.#child.kill('SIGKILL'), SSH_STOP_TIMEOUT_MS);
          try {
            await this.exited.catch(() => undefined);
          } finally {
            clearTimeout(killTimer);
          }
        }
      }
      await this.exited.catch(() => undefined);
    } finally {
      await this.#closeReadiness();
    }
  }
}

function spawnSshProcess(input: {
  readonly executable: 'ssh';
  readonly args: readonly string[];
  readonly interaction: RuntimeHostSshInteraction;
}): RuntimeHostSshProcess {
  if (input.interaction === 'terminal') {
    throw new Error('Interactive SSH terminal requires a Client terminal provider');
  }
  const child = spawn(input.executable, input.args, {
    shell: false,
    windowsHide: input.interaction === 'batch',
    stdio: input.interaction === 'inherit' ? 'inherit' : ['ignore', 'ignore', 'ignore'],
  });
  return {
    ...(child.pid === undefined ? {} : { pid: child.pid }),
    exited: childExit(child),
    kill: (signal) => {
      child.kill(signal);
    },
  };
}

function childExit(
  child: ChildProcess,
): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      child.off('exit', onExit);
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      child.off('error', onError);
      resolve({ code, signal });
    };
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

interface SshForwardReadiness {
  readonly logPath: string;
  status(): Promise<'pending' | 'ready' | 'local_bind_conflict'>;
  close(): Promise<void>;
}

class SshLocalBindConflictError extends Error {
  constructor() {
    super('SSH could not bind the local forwarding port');
  }
}

async function createSshForwardReadiness(port: number): Promise<SshForwardReadiness> {
  const directory = await mkdtemp(join(tmpdir(), 'maka-runtime-host-ssh-'));
  try {
    await chmod(directory, 0o700);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  const logPath = join(directory, 'ssh.log');
  const marker = `Local forwarding listening on 127.0.0.1 port ${port}.`;
  return {
    logPath,
    status: async () => {
      try {
        const log = await readFile(logPath, 'utf8');
        if (log.includes(marker)) return 'ready';
        if (hasLocalBindConflict(log, port)) {
          return 'local_bind_conflict';
        }
        return 'pending';
      } catch (error) {
        if (isMissingFileError(error)) return 'pending';
        throw error;
      }
    },
    close: () => rm(directory, { recursive: true, force: true }),
  };
}

function readSshConfiguration(input: {
  readonly destination: string;
  readonly sshPort?: number;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
}): Promise<string> {
  const args = [
    '-G',
    '-o',
    'ControlMaster=no',
    '-o',
    'ControlPath=none',
    '-o',
    'ClearAllForwardings=no',
    ...(input.sshPort === undefined ? [] : ['-p', String(input.sshPort)]),
    input.destination,
  ];
  return new Promise((resolve, reject) => {
    execFile(
      'ssh',
      args,
      {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        timeout: input.timeoutMs,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          reject(new Error('Unable to inspect the OpenSSH configuration', { cause: error }));
        } else {
          resolve(stdout);
        }
      },
    );
  });
}

function assertNoConfiguredForwarding(configuration: string): void {
  for (const line of configuration.split(/\r?\n/u)) {
    const option = line.trimStart().split(/\s/u, 1)[0]?.toLowerCase();
    if (option === 'localforward' || option === 'remoteforward' || option === 'dynamicforward') {
      throw new Error(
        'The selected OpenSSH destination configures additional port forwarding. Remove that forwarding or use a dedicated SSH Host entry.',
      );
    }
  }
}

function hasLocalBindConflict(log: string, port: number): boolean {
  const portMarker = `:${port}:`;
  return log
    .split(/\r?\n/u)
    .some(
      (line) =>
        line.includes(portMarker) &&
        (line.includes('Address already in use') ||
          line.includes('Only one usage of each socket address') ||
          line.includes('WSAEADDRINUSE')),
    );
}

async function waitForForward(
  readiness: SshForwardReadiness,
  resource: SshTunnelResource,
  timeoutMs: number,
  interaction: RuntimeHostSshInteraction,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const outcome = await Promise.race([
      readiness.status().then((status) => ({ kind: 'status' as const, status })),
      resource.exited.then((exit) => ({ kind: 'exit' as const, exit })),
    ]);
    if (outcome.kind === 'status') {
      if (outcome.status === 'ready') return;
      if (outcome.status === 'local_bind_conflict') throw new SshLocalBindConflictError();
    } else {
      if ((await readiness.status()) === 'local_bind_conflict') {
        throw new SshLocalBindConflictError();
      }
      throw sshStartupError(outcome.exit.code ?? outcome.exit.signal ?? 'unknown', interaction);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw sshStartupError('timed out', interaction);
}

function allocateLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close(() => reject(new Error('Unable to allocate an SSH loopback port')));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

function sshStartupError(
  outcome: number | NodeJS.Signals | 'unknown' | 'timed out',
  interaction: RuntimeHostSshInteraction,
): Error {
  const detail = `SSH tunnel did not become ready (${outcome})`;
  return new Error(
    interaction === 'batch'
      ? `${detail}. Configure OpenSSH host verification and key or agent authentication, or connect once from Desktop or TUI.`
      : detail,
  );
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

async function terminateWindowsProcessTree(pid: number): Promise<void> {
  const child = spawn('taskkill.exe', ['/pid', String(pid), '/t', '/f'], {
    shell: false,
    windowsHide: true,
    stdio: 'ignore',
  });
  await new Promise<void>((resolve) => {
    child.once('error', () => resolve());
    child.once('exit', () => resolve());
  });
}

function requireSshDestination(value: string): string {
  const destination = value.trim();
  if (
    destination.length === 0 ||
    destination.length > 512 ||
    destination.startsWith('-') ||
    /\s|[\u0000-\u001f\u007f]/u.test(destination)
  ) {
    throw new Error('Runtime Host SSH destination is invalid');
  }
  return destination;
}

function requirePort(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${label} must be an integer between 1 and 65535`);
  }
  return value;
}

function requireWebSocketPath(value: string): string {
  if (!value.startsWith('/') || value.includes('?') || value.includes('#')) {
    throw new Error('Runtime Host SSH WebSocket path must be an absolute URL path');
  }
  return value;
}
