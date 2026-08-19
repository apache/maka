import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import type { IpcMain } from 'electron';
import type { IPty } from 'node-pty';
import { spawn as spawnPty } from 'node-pty';
import {
  decodeRuntimeHostSetupFrame,
  openRuntimeHostSshTunnel,
  RUNTIME_HOST_SETUP_FRAME_PREFIX,
  type RuntimeHostSetupFrame,
  type RuntimeHostSshProcess,
  type RuntimeHostSshProcessFactory,
  type RuntimeHostSshTunnel,
  type RuntimeHostSshTunnelInput,
} from '@maka/runtime-host/client';
import type {
  DesktopRuntimeHostSshTerminalEvent,
  DesktopRuntimeHostSshTerminalSnapshot,
} from '../preload/bridge-contract.js';

interface ActiveTerminal {
  readonly sessionId: string;
  readonly pty: IPty;
  readonly exited: Promise<void>;
  revealTimer: ReturnType<typeof setTimeout> | undefined;
  phase: 'connecting' | 'connected';
  revealed: boolean;
  dismissed: boolean;
  output: string;
}

const TERMINAL_REVEAL_DELAY_MS = 500;
const TERMINAL_OUTPUT_MAX = 64 * 1024;
const SETUP_FRAME_PENDING_MAX = 20 * 1024;
const SETUP_TIMEOUT_MS = 10 * 60_000;
const PROCESS_STOP_GRACE_MS = 2_000;

export interface DesktopRuntimeHostSshSetupInput {
  readonly destination: string;
  readonly sshPort?: number;
  readonly setupPackage: DesktopRuntimeHostSetupPackage;
  readonly principalId: string;
  readonly signal?: AbortSignal;
}

export type DesktopRuntimeHostSetupPackage =
  | { readonly kind: 'npm'; readonly specifier: string }
  | { readonly kind: 'development_archive'; readonly path: string };

type RuntimeHostSetupCompleteFrame = Extract<RuntimeHostSetupFrame, { kind: 'complete' }>;

export function createDesktopRuntimeHostSshTerminal(input: {
  readonly ipcMain: Pick<IpcMain, 'handle' | 'removeHandler'>;
  readonly send: (channel: string, event: DesktopRuntimeHostSshTerminalEvent) => void;
  readonly spawnPty?: typeof spawnPty;
  readonly openSshTunnel?: typeof openRuntimeHostSshTunnel;
  readonly revealDelayMs?: number;
  readonly processStopGraceMs?: number;
}): {
  openSshTunnel(input: RuntimeHostSshTunnelInput): Promise<RuntimeHostSshTunnel>;
  runSetup(
    input: DesktopRuntimeHostSshSetupInput,
    onProgress: (frame: Extract<RuntimeHostSetupFrame, { kind: 'progress' }>) => void,
  ): Promise<RuntimeHostSetupCompleteFrame>;
  close(): Promise<void>;
} {
  let active: ActiveTerminal | undefined;
  let revision = 0;
  let presentation: Exclude<DesktopRuntimeHostSshTerminalSnapshot, { kind: 'idle' }> | undefined;
  function completePresentation(terminal: ActiveTerminal): void {
    if (active !== terminal || terminal.phase !== 'connecting') return;
    terminal.phase = 'connected';
    presentation = undefined;
    revision += 1;
    if (terminal.revealTimer !== undefined) {
      clearTimeout(terminal.revealTimer);
      terminal.revealTimer = undefined;
    }
    if (terminal.revealed) {
      input.send('runtime-host-ssh-terminal:event', {
        kind: 'connected',
        revision,
        sessionId: terminal.sessionId,
      });
    }
  }
  const startTerminalProcess = (
    executable: 'ssh' | 'scp',
    args: readonly string[],
    transformOutput: (data: string) => string = (data) => data,
    successfulExitCompletes = false,
  ): { readonly process: RuntimeHostSshProcess; readonly terminal: ActiveTerminal } => {
    if (active) throw new Error('Another Runtime Host SSH terminal is already active');
    const sessionId = randomUUID();
    const pty = (input.spawnPty ?? spawnPty)(executable, [...args], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: homedir(),
      env: sshEnvironment(),
    });
    let resolveExit: ((value: {
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    }) => void) | undefined;
    const exited = new Promise<{
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    }>((resolve) => {
      resolveExit = resolve;
    });
    const terminal: ActiveTerminal = {
      sessionId,
      pty,
      exited: exited.then(() => undefined),
      revealTimer: undefined,
      phase: 'connecting',
      revealed: false,
      dismissed: false,
      output: '',
    };
    active = terminal;
    const reveal = () => {
      if (
        active !== terminal ||
        terminal.phase !== 'connecting' ||
        terminal.revealed ||
        terminal.dismissed
      ) {
        return;
      }
      terminal.revealed = true;
      revision += 1;
      presentation = { kind: 'connecting', revision, sessionId, output: terminal.output };
      input.send('runtime-host-ssh-terminal:event', { kind: 'opened', revision, sessionId });
    };
    terminal.revealTimer = setTimeout(reveal, input.revealDelayMs ?? TERMINAL_REVEAL_DELAY_MS);
    pty.onData((data) => {
      if (active !== terminal || terminal.phase !== 'connecting' || terminal.dismissed) return;
      const visible = transformOutput(data);
      if (!visible) return;
      terminal.output = `${terminal.output}${visible}`.slice(-TERMINAL_OUTPUT_MAX);
      reveal();
      revision += 1;
      if (presentation?.kind === 'connecting' && presentation.sessionId === sessionId) {
        presentation = { ...presentation, revision, output: terminal.output };
      }
      input.send('runtime-host-ssh-terminal:event', {
        kind: 'data',
        revision,
        sessionId,
        data: visible,
      });
    });
    pty.onExit(({ exitCode, signal }) => {
      if (terminal.revealTimer !== undefined) clearTimeout(terminal.revealTimer);
      if (successfulExitCompletes && exitCode === 0) completePresentation(terminal);
      if (active === terminal) active = undefined;
      if (terminal.revealed && terminal.phase === 'connecting' && !terminal.dismissed) {
        revision += 1;
        presentation = {
          kind: 'closed',
          revision,
          sessionId,
          output: terminal.output,
          code: exitCode,
          signal: signal === 0 ? null : String(signal),
        };
        input.send('runtime-host-ssh-terminal:event', {
          kind: 'closed',
          revision,
          sessionId,
          code: exitCode,
          signal: signal === 0 ? null : String(signal),
        });
      }
      resolveExit?.({ code: exitCode, signal: null });
    });
    const process = {
      pid: pty.pid,
      exited,
      kill: (signal) => {
        try {
          pty.kill(signal);
        } catch {
          // The exit event is the authority; a concurrent exit makes kill a no-op.
        }
      },
    } satisfies RuntimeHostSshProcess;
    return { process, terminal };
  };
  const spawnProcess: RuntimeHostSshProcessFactory = ({ executable, args, interaction }) => {
    if (interaction !== 'terminal') {
      throw new Error('Desktop SSH terminal received a non-interactive launch');
    }
    return startTerminalProcess(executable, args).process;
  };

  const channels = [
    'runtime-host-ssh-terminal:getSnapshot',
    'runtime-host-ssh-terminal:write',
    'runtime-host-ssh-terminal:resize',
    'runtime-host-ssh-terminal:cancel',
  ] as const;
  input.ipcMain.handle(channels[0], () => presentation ?? { kind: 'idle', revision });
  input.ipcMain.handle(channels[1], (_event, request: { sessionId: string; data: string }) => {
    const terminal = findConnecting(active, request.sessionId);
    if (!terminal) return;
    if (typeof request.data !== 'string' || request.data.length === 0 || request.data.length > 8_192) {
      throw new Error('Runtime Host SSH terminal input is invalid');
    }
    terminal.pty.write(request.data);
  });
  input.ipcMain.handle(
    channels[2],
    (_event, request: { sessionId: string; cols: number; rows: number }) => {
      const terminal = findConnecting(active, request.sessionId);
      if (!terminal) return;
      if (
        !Number.isInteger(request.cols) ||
        request.cols < 1 ||
        request.cols > 500 ||
        !Number.isInteger(request.rows) ||
        request.rows < 1 ||
        request.rows > 200
      ) {
        throw new Error('Runtime Host SSH terminal size is invalid');
      }
      terminal.pty.resize(request.cols, request.rows);
    },
  );
  input.ipcMain.handle(channels[3], (_event, sessionId: string) => {
    if (presentation?.sessionId === sessionId) {
      presentation = undefined;
      revision += 1;
    }
    const terminal = findActive(active, sessionId);
    if (!terminal) return;
    terminal.dismissed = true;
    try {
      terminal.pty.kill();
    } catch {
      // The process may have exited between validation and cancellation.
    }
  });

  return {
    openSshTunnel: async (tunnelInput) => {
      const openSshTunnel = input.openSshTunnel ?? openRuntimeHostSshTunnel;
      if (tunnelInput.interaction !== 'terminal') return openSshTunnel(tunnelInput);
      const tunnel = await openSshTunnel(tunnelInput, { spawnProcess });
      const terminal = active;
      if (terminal) completePresentation(terminal);
      return tunnel;
    },
    runSetup: async (setupInput, onProgress) => {
      setupInput.signal?.throwIfAborted();
      const destination = requireSetupDestination(setupInput.destination);
      const sshPort = setupInput.sshPort === undefined
        ? undefined
        : requireSetupPort(setupInput.sshPort);
      const setupPackage = await prepareSetupPackage(
        setupInput.setupPackage,
        destination,
        sshPort,
        startTerminalProcess,
        setupInput.signal,
        input.processStopGraceMs,
      );
      const remoteCommand = runtimeHostSetupRemoteCommand(setupPackage, setupInput.principalId);
      let complete: RuntimeHostSetupCompleteFrame | undefined;
      let setupFailure: Error | undefined;
      let setupTerminal: ActiveTerminal | undefined;
      const filter = createSetupOutputFilter((frame) => {
        if (frame.kind === 'progress') onProgress(frame);
        else if (frame.kind === 'complete') {
          complete = frame;
          if (setupTerminal) completePresentation(setupTerminal);
        }
        else setupFailure = new Error(frame.error.message);
      }, (error) => {
        setupFailure = error;
      });
      const { process, terminal } = startTerminalProcess('ssh', [
        '-tt',
        '-o',
        'BatchMode=no',
        '-o',
        'ConnectTimeout=15',
        '-o',
        'ControlMaster=no',
        '-o',
        'ControlPath=none',
        '-o',
        'ClearAllForwardings=yes',
        '-o',
        'RemoteCommand=none',
        ...(sshPort === undefined ? [] : ['-p', String(sshPort)]),
        destination,
        remoteCommand,
      ], filter.push);
      setupTerminal = terminal;
      if (complete) completePresentation(terminal);
      const result = await waitForTerminalProcess(process, {
        signal: setupInput.signal,
        timeoutMs: SETUP_TIMEOUT_MS,
        timeoutMessage: 'Remote Maka setup timed out',
        stopGraceMs: input.processStopGraceMs,
      });
      filter.finish();
      if (setupFailure) throw setupFailure;
      if (!complete) {
        throw new Error(
          result.code === 0
            ? 'Remote Maka setup ended without a completion result'
            : result.code === 2
              ? 'The released Maka CLI on this channel does not support automated Runtime Host setup'
            : `Remote Maka setup exited with code ${String(result.code)}`,
        );
      }
      completePresentation(terminal);
      return complete;
    },
    close: async () => {
      for (const channel of channels) input.ipcMain.removeHandler(channel);
      const terminal = active;
      if (!terminal) return;
      active = undefined;
      presentation = undefined;
      terminal.dismissed = true;
      if (terminal.revealTimer !== undefined) clearTimeout(terminal.revealTimer);
      await terminateTerminalProcess(
        {
          exited: terminal.exited.then(() => ({ code: null, signal: null })),
          kill: (signal) => terminal.pty.kill(signal),
        },
        input.processStopGraceMs,
      ).catch(() => undefined);
    },
  };
}

function createSetupOutputFilter(
  onFrame: (frame: RuntimeHostSetupFrame) => void,
  onError: (error: Error) => void,
): { push(data: string): string; finish(): string } {
  let pending = '';
  const drain = (finished: boolean): string => {
    let visible = '';
    while (pending) {
      const marker = pending.indexOf(RUNTIME_HOST_SETUP_FRAME_PREFIX);
      if (marker >= 0) {
        visible += pending.slice(0, marker);
        pending = pending.slice(marker);
        const newline = pending.indexOf('\n');
        if (newline < 0) {
          if (finished) {
            onError(new Error('Remote Maka setup returned an incomplete result'));
            pending = '';
          } else if (pending.length > SETUP_FRAME_PENDING_MAX) {
            onError(new Error('Remote Maka setup returned an oversized result'));
            pending = '';
          }
          break;
        }
        const line = pending.slice(0, newline + 1);
        pending = pending.slice(newline + 1);
        const frame = decodeRuntimeHostSetupFrame(line);
        if (frame) onFrame(frame);
        else onError(new Error('Remote Maka setup returned an invalid result'));
        continue;
      }
      if (finished) {
        visible += pending;
        pending = '';
        break;
      }
      const retained = setupMarkerSuffixLength(pending);
      visible += pending.slice(0, pending.length - retained);
      pending = pending.slice(pending.length - retained);
      break;
    }
    return visible;
  };
  return {
    push(data) {
      pending += data;
      return drain(false);
    },
    finish() {
      return drain(true);
    },
  };
}

function setupMarkerSuffixLength(value: string): number {
  const limit = Math.min(value.length, RUNTIME_HOST_SETUP_FRAME_PREFIX.length - 1);
  for (let length = limit; length > 0; length -= 1) {
    if (RUNTIME_HOST_SETUP_FRAME_PREFIX.startsWith(value.slice(-length))) return length;
  }
  return 0;
}

interface PreparedSetupPackage {
  readonly specifier: string;
  readonly removeAfterSetup?: string;
}

async function prepareSetupPackage(
  setupPackage: DesktopRuntimeHostSetupPackage,
  destination: string,
  sshPort: number | undefined,
  startTerminalProcess: (
    executable: 'ssh' | 'scp',
    args: readonly string[],
    transformOutput?: (data: string) => string,
    successfulExitCompletes?: boolean,
  ) => { readonly process: RuntimeHostSshProcess; readonly terminal: ActiveTerminal },
  signal: AbortSignal | undefined,
  stopGraceMs: number | undefined,
): Promise<PreparedSetupPackage> {
  if (setupPackage.kind === 'npm') {
    if (!/^maka-agent@[A-Za-z0-9._-]+$/u.test(setupPackage.specifier)) {
      throw new Error('Runtime Host setup package is invalid');
    }
    return { specifier: setupPackage.specifier };
  }
  signal?.throwIfAborted();
  const archive = await realpath(setupPackage.path);
  if (!(await stat(archive)).isFile() || !archive.endsWith('.tgz')) {
    throw new Error('Runtime Host development package must be a .tgz file');
  }
  const remoteArchive = `/tmp/maka-runtime-host-setup-${randomUUID()}.tgz`;
  const { process } = startTerminalProcess('scp', [
    '-o',
    'BatchMode=no',
    '-o',
    'ConnectTimeout=15',
    '-o',
    'ControlMaster=no',
    '-o',
    'ControlPath=none',
    '-o',
    'ClearAllForwardings=yes',
    ...(sshPort === undefined ? [] : ['-P', String(sshPort)]),
    archive,
    `${destination}:${remoteArchive}`,
  ], undefined, true);
  const result = await waitForTerminalProcess(process, {
    signal,
    timeoutMs: SETUP_TIMEOUT_MS,
    timeoutMessage: 'Uploading the Runtime Host development package timed out',
    stopGraceMs,
  });
  if (result.code !== 0) {
    throw new Error(
      `Uploading the Runtime Host development package exited with code ${String(result.code)}`,
    );
  }
  return { specifier: remoteArchive, removeAfterSetup: remoteArchive };
}

async function waitForTerminalProcess(
  process: RuntimeHostSshProcess,
  input: {
    readonly signal?: AbortSignal;
    readonly timeoutMs: number;
    readonly timeoutMessage: string;
    readonly stopGraceMs?: number;
  },
): Promise<Awaited<RuntimeHostSshProcess['exited']>> {
  let requestStop!: (reason: 'aborted' | 'timeout') => void;
  let stopReason: 'aborted' | 'timeout' | undefined;
  const stopRequested = new Promise<'aborted' | 'timeout'>((resolve) => {
    requestStop = (reason) => {
      if (stopReason) return;
      stopReason = reason;
      resolve(reason);
    };
  });
  const onAbort = () => requestStop('aborted');
  if (input.signal?.aborted) onAbort();
  else input.signal?.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => requestStop('timeout'), input.timeoutMs);
  try {
    const result = await Promise.race([
      process.exited,
      stopRequested.then(async () => {
        await terminateTerminalProcess(process, input.stopGraceMs);
        return process.exited;
      }),
    ]);
    input.signal?.throwIfAborted();
    if (stopReason === 'timeout') throw new Error(input.timeoutMessage);
    return result;
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener('abort', onAbort);
  }
}

async function terminateTerminalProcess(
  process: Pick<RuntimeHostSshProcess, 'exited' | 'kill'>,
  graceMs = PROCESS_STOP_GRACE_MS,
): Promise<void> {
  process.kill('SIGTERM');
  if (await settlesWithin(process.exited, graceMs)) return;
  process.kill('SIGKILL');
  if (await settlesWithin(process.exited, graceMs)) return;
  throw new Error('SSH process did not exit after forced termination');
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function runtimeHostSetupRemoteCommand(
  setupPackage: PreparedSetupPackage,
  principalId: string,
): string {
  if (!/^[A-Za-z0-9_.:-]{1,128}$/u.test(principalId)) {
    throw new Error('Runtime Host setup principal is invalid');
  }
  const setup = [
    'npx',
    '--yes',
    '--package',
    setupPackage.specifier,
    'maka',
    'runtime-host',
    'setup',
    '--principal',
    principalId,
    '--preset',
    'desktop-client',
    '--json',
  ].map(quotePosix).join(' ');
  const command = setupPackage.removeAfterSetup
    ? `status=0; ${setup} || status=$?; rm -f -- ${quotePosix(setupPackage.removeAfterSetup)}; exit "$status"`
    : `exec ${setup}`;
  return `exec "\${SHELL:-/bin/sh}" -lic ${quotePosix(command)}`;
}

function quotePosix(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function requireSetupPort(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error('SSH port is invalid');
  }
  return value;
}

function requireSetupDestination(value: string): string {
  const destination = value.trim();
  if (
    !destination ||
    destination.length > 512 ||
    destination.startsWith('-') ||
    /[\0\r\n]/u.test(destination)
  ) {
    throw new Error('SSH destination is invalid');
  }
  return destination;
}

function findConnecting(
  active: ActiveTerminal | undefined,
  sessionId: string,
): ActiveTerminal | undefined {
  return active?.sessionId === sessionId && active.phase === 'connecting' ? active : undefined;
}

function findActive(
  active: ActiveTerminal | undefined,
  sessionId: string,
): ActiveTerminal | undefined {
  return active?.sessionId === sessionId ? active : undefined;
}

function sshEnvironment(): Record<string, string> {
  const allowed = new Set([
    'APPDATA',
    'COMSPEC',
    'HOME',
    'HOMEDRIVE',
    'HOMEPATH',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'LOGNAME',
    'PATH',
    'PATHEXT',
    'SHELL',
    'SSH_AUTH_SOCK',
    'SYSTEMROOT',
    'TEMP',
    'TERM',
    'TMP',
    'USER',
    'USERPROFILE',
  ]);
  return Object.fromEntries(
    Object.entries(process.env).flatMap(([key, value]) =>
      allowed.has(key.toUpperCase()) && value !== undefined ? [[key, value]] : [],
    ),
  );
}
