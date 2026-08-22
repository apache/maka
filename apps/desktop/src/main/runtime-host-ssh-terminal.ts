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

import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { posix as pathPosix } from 'node:path';
import type { IpcMain } from 'electron';
import type { IPty } from 'node-pty';
import { spawn as spawnPty } from 'node-pty';
import {
  normalizeRuntimeHostSshDestination,
  openRuntimeHostSshTunnel,
  type RuntimeHostSshProcess,
  type RuntimeHostSshProcessFactory,
  type RuntimeHostSshTunnel,
  type RuntimeHostSshTunnelInput,
} from '@maka/runtime-host/client';
import {
  decodeRuntimeHostServiceManagementFrame,
  decodeRuntimeHostSetupFrame,
  RUNTIME_HOST_SERVICE_MANAGEMENT_FRAME_PREFIX,
  RUNTIME_HOST_SETUP_FRAME_PREFIX,
  type RuntimeHostServiceManagementAction,
  type RuntimeHostServiceManagementFrame,
  type RuntimeHostSetupFrame,
} from '@maka/runtime-host/operator';
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
const MANAGEMENT_FRAME_PENDING_MAX = 128 * 1024;
const SETUP_TIMEOUT_MS = 10 * 60_000;
const MANAGEMENT_TIMEOUT_MS = 2 * 60_000;
const PROCESS_STOP_GRACE_MS = 2_000;

export interface DesktopRuntimeHostSshSetupInput {
  readonly destination: string;
  readonly sshPort?: number;
  readonly setupPackage: DesktopRuntimeHostSetupPackage;
  readonly principalId: string;
  readonly signal?: AbortSignal;
}

export interface DesktopRuntimeHostSshManagementInput {
  readonly destination: string;
  readonly sshPort?: number;
  readonly operatorPath: string;
  readonly action: RuntimeHostServiceManagementAction;
  readonly expectedTarget: {
    readonly serviceId: string;
    readonly rootPath: string;
    readonly rootId: string;
  };
  readonly rootPath?: string;
  readonly websocketPort?: number;
  readonly websocketPath?: string;
  readonly retainManagedDeployment?: boolean;
  readonly signal?: AbortSignal;
}

export interface DesktopRuntimeHostSshCleanupInput {
  readonly destination: string;
  readonly sshPort?: number;
  readonly operatorPath: string;
  readonly signal?: AbortSignal;
}

export type DesktopRuntimeHostSetupPackage =
  | { readonly kind: 'npm'; readonly specifier: string }
  | { readonly kind: 'development_archive'; readonly path: string };

export function isExactRuntimeHostSetupPackageSpecifier(value: unknown): value is string {
  return typeof value === 'string' && /^maka-agent@[0-9][0-9A-Za-z.+-]*$/u.test(value);
}

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
    onComplete?: (frame: RuntimeHostSetupCompleteFrame) => void,
  ): Promise<RuntimeHostSetupCompleteFrame>;
  runServiceManagement(
    input: DesktopRuntimeHostSshManagementInput,
  ): Promise<RuntimeHostServiceManagementFrame>;
  cleanupManagedDeployment(input: DesktopRuntimeHostSshCleanupInput): Promise<void>;
  close(): Promise<void>;
} {
  let active: ActiveTerminal | undefined;
  let closed = false;
  let revision = 0;
  let presentation: Exclude<DesktopRuntimeHostSshTerminalSnapshot, { kind: 'idle' }> | undefined;
  function dismissPresentation(terminal: ActiveTerminal): void {
    terminal.dismissed = true;
    if (terminal.revealTimer !== undefined) {
      clearTimeout(terminal.revealTimer);
      terminal.revealTimer = undefined;
    }
    if (presentation?.sessionId === terminal.sessionId) presentation = undefined;
    if (!terminal.revealed) return;
    revision += 1;
    input.send('runtime-host-ssh-terminal:event', {
      kind: 'dismissed',
      revision,
      sessionId: terminal.sessionId,
    });
  }
  function completePresentation(terminal: ActiveTerminal, releaseProcess = false): void {
    if (active !== terminal || terminal.phase !== 'connecting') return;
    terminal.phase = 'connected';
    if (releaseProcess) active = undefined;
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
    if (closed) throw new Error('Runtime Host SSH terminal is closed');
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
  input.ipcMain.handle(channels[3], async (_event, sessionId: string) => {
    const terminal = findActive(active, sessionId);
    if (!terminal) {
      if (presentation?.sessionId === sessionId) {
        presentation = undefined;
        revision += 1;
      }
      return;
    }
    dismissPresentation(terminal);
    await terminateActiveTerminal(terminal, input.processStopGraceMs);
  });

  return {
    openSshTunnel: async (tunnelInput) => {
      if (closed) throw new Error('Runtime Host SSH terminal is closed');
      const openSshTunnel = input.openSshTunnel ?? openRuntimeHostSshTunnel;
      if (tunnelInput.interaction !== 'terminal') return openSshTunnel(tunnelInput);
      const tunnel = await openSshTunnel(tunnelInput, { spawnProcess });
      const terminal = active;
      if (terminal) {
        completePresentation(terminal);
        if (active === terminal) active = undefined;
      }
      return tunnel;
    },
    runSetup: async (setupInput, onProgress, onComplete) => {
      if (closed) throw new Error('Runtime Host SSH terminal is closed');
      setupInput.signal?.throwIfAborted();
      const cancellation = cancellableUntilComplete(setupInput.signal);
      try {
        const destination = normalizeRuntimeHostSshDestination(setupInput.destination);
        const sshPort = setupInput.sshPort === undefined
          ? undefined
          : requireSetupPort(setupInput.sshPort);
        const setupPackage = await prepareSetupPackage(
          setupInput.setupPackage,
          destination,
          sshPort,
          setupInput.principalId,
          startTerminalProcess,
          cancellation.signal,
          input.processStopGraceMs,
          dismissPresentation,
        );
        const remoteCommand = runtimeHostSetupRemoteCommand(setupPackage, setupInput);
        let complete: RuntimeHostSetupCompleteFrame | undefined;
        let setupFailure: Error | undefined;
        let setupTerminal: ActiveTerminal | undefined;
        const filter = createFramedOutputFilter({
          prefix: RUNTIME_HOST_SETUP_FRAME_PREFIX,
          pendingMaxBytes: SETUP_FRAME_PENDING_MAX,
          decode: decodeRuntimeHostSetupFrame,
          label: 'Remote Maka setup',
          onFrame: (frame) => {
            if (frame.kind === 'progress') onProgress(frame);
            else if (frame.kind === 'complete') {
              if (!cancellation.commit()) return;
              complete = frame;
              onComplete?.(frame);
              if (setupTerminal) completePresentation(setupTerminal);
            } else setupFailure = new Error(frame.error.message);
          },
          onError: (error) => {
            setupFailure = error;
          },
        });
        const { process, terminal } = startTerminalProcess(
          'ssh',
          sshRemoteCommandArgs(destination, sshPort, remoteCommand),
          filter.push,
        );
        setupTerminal = terminal;
        if (complete) completePresentation(terminal);
        const result = await waitForTerminalProcess(process, {
          signal: cancellation.signal,
          timeoutMs: SETUP_TIMEOUT_MS,
          timeoutMessage: 'Remote Maka setup timed out',
          stopGraceMs: input.processStopGraceMs,
          onAbort: () => dismissPresentation(terminal),
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
      } finally {
        cancellation.close();
      }
    },
    runServiceManagement: async (managementInput) => {
      if (closed) throw new Error('Runtime Host SSH terminal is closed');
      managementInput.signal?.throwIfAborted();
      const destination = normalizeRuntimeHostSshDestination(managementInput.destination);
      const sshPort = managementInput.sshPort === undefined
        ? undefined
        : requireSetupPort(managementInput.sshPort);
      let frame: RuntimeHostServiceManagementFrame | undefined;
      let frameFailure: Error | undefined;
      let managementTerminal: ActiveTerminal | undefined;
      const filter = createFramedOutputFilter({
        prefix: RUNTIME_HOST_SERVICE_MANAGEMENT_FRAME_PREFIX,
        pendingMaxBytes: MANAGEMENT_FRAME_PENDING_MAX,
        decode: decodeRuntimeHostServiceManagementFrame,
        label: 'Remote Runtime Host service management',
        onFrame: (next) => {
          if (next.action !== managementInput.action) {
            frameFailure = new Error(
              `Remote Runtime Host service management returned ${next.action} for ${managementInput.action}`,
            );
            return;
          }
          if (frame) {
            frameFailure = new Error(
              'Remote Runtime Host service management returned multiple results',
            );
            return;
          }
          frame = next;
          if (managementTerminal) completePresentation(managementTerminal);
        },
        onError: (error) => {
          frameFailure = error;
        },
      });
      const { process, terminal } = startTerminalProcess(
        'ssh',
        sshRemoteCommandArgs(
          destination,
          sshPort,
          runtimeHostServiceManagementRemoteCommand(managementInput),
        ),
        filter.push,
        true,
      );
      managementTerminal = terminal;
      if (frame) completePresentation(terminal);
      const result = await waitForTerminalProcess(process, {
        signal: managementInput.signal,
        timeoutMs: MANAGEMENT_TIMEOUT_MS,
        timeoutMessage: 'Remote Runtime Host service management timed out',
        stopGraceMs: input.processStopGraceMs,
        onAbort: () => dismissPresentation(terminal),
      });
      filter.finish();
      if (frameFailure) throw frameFailure;
      if (!frame) {
        throw new Error(
          result.code === 0
            ? 'Remote Runtime Host service management ended without a result'
            : `Remote Runtime Host service management exited with code ${String(result.code)}`,
        );
      }
      completePresentation(terminal);
      return frame;
    },
    cleanupManagedDeployment: async (cleanupInput) => {
      if (closed) throw new Error('Runtime Host SSH terminal is closed');
      cleanupInput.signal?.throwIfAborted();
      const destination = normalizeRuntimeHostSshDestination(cleanupInput.destination);
      const sshPort = cleanupInput.sshPort === undefined
        ? undefined
        : requireSetupPort(cleanupInput.sshPort);
      const { process, terminal } = startTerminalProcess(
        'ssh',
        sshRemoteCommandArgs(
          destination,
          sshPort,
          runtimeHostManagedDeploymentCleanupRemoteCommand(cleanupInput.operatorPath),
        ),
        undefined,
        true,
      );
      const result = await waitForTerminalProcess(process, {
        signal: cleanupInput.signal,
        timeoutMs: MANAGEMENT_TIMEOUT_MS,
        timeoutMessage: 'Remote Runtime Host deployment cleanup timed out',
        stopGraceMs: input.processStopGraceMs,
        onAbort: () => dismissPresentation(terminal),
      });
      if (result.code !== 0) {
        throw new Error(
          `Remote Runtime Host deployment cleanup exited with code ${String(result.code)}`,
        );
      }
      completePresentation(terminal);
    },
    close: async () => {
      closed = true;
      for (const channel of channels) input.ipcMain.removeHandler(channel);
      const terminal = active;
      if (!terminal) return;
      active = undefined;
      presentation = undefined;
      terminal.dismissed = true;
      if (terminal.revealTimer !== undefined) clearTimeout(terminal.revealTimer);
      await terminateActiveTerminal(terminal, input.processStopGraceMs).catch(() => undefined);
    },
  };
}

function cancellableUntilComplete(signal: AbortSignal | undefined): {
  readonly signal: AbortSignal;
  commit(): boolean;
  close(): void;
} {
  const controller = new AbortController();
  let committed = false;
  const onAbort = () => {
    if (!committed) controller.abort();
  };
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  const close = () => signal?.removeEventListener('abort', onAbort);
  return {
    signal: controller.signal,
    commit() {
      if (controller.signal.aborted) return false;
      committed = true;
      close();
      return true;
    },
    close,
  };
}

function createFramedOutputFilter<Frame>(input: {
  readonly prefix: string;
  readonly pendingMaxBytes: number;
  readonly decode: (line: string) => Frame | undefined;
  readonly label: string;
  readonly onFrame: (frame: Frame) => void;
  readonly onError: (error: Error) => void;
}): { push(data: string): string; finish(): string } {
  let pending = '';
  let discardReservedLine = false;
  const drain = (finished: boolean): string => {
    let visible = '';
    while (pending) {
      if (discardReservedLine) {
        const newline = pending.indexOf('\n');
        if (newline < 0) {
          pending = '';
          break;
        }
        pending = pending.slice(newline + 1);
        discardReservedLine = false;
        continue;
      }
      const marker = pending.indexOf(input.prefix);
      if (marker >= 0) {
        visible += pending.slice(0, marker);
        pending = pending.slice(marker);
        const newline = pending.indexOf('\n');
        if (newline < 0) {
          if (finished) {
            input.onError(new Error(`${input.label} returned an incomplete result`));
            pending = '';
          } else if (pending.length > input.pendingMaxBytes) {
            input.onError(new Error(`${input.label} returned an oversized result`));
            pending = '';
            discardReservedLine = true;
          }
          break;
        }
        const line = pending.slice(0, newline + 1);
        pending = pending.slice(newline + 1);
        const frame = input.decode(line);
        if (frame) input.onFrame(frame);
        else input.onError(new Error(`${input.label} returned an invalid result`));
        continue;
      }
      if (finished) {
        visible += pending;
        pending = '';
        break;
      }
      const retained = markerSuffixLength(pending, input.prefix);
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

function markerSuffixLength(value: string, prefix: string): number {
  const limit = Math.min(value.length, prefix.length - 1);
  for (let length = limit; length > 0; length -= 1) {
    if (prefix.startsWith(value.slice(-length))) return length;
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
  principalId: string,
  startTerminalProcess: (
    executable: 'ssh' | 'scp',
    args: readonly string[],
    transformOutput?: (data: string) => string,
    successfulExitCompletes?: boolean,
  ) => { readonly process: RuntimeHostSshProcess; readonly terminal: ActiveTerminal },
  signal: AbortSignal | undefined,
  stopGraceMs: number | undefined,
  dismissPresentation: (terminal: ActiveTerminal) => void,
): Promise<PreparedSetupPackage> {
  if (setupPackage.kind === 'npm') {
    if (!isExactRuntimeHostSetupPackageSpecifier(setupPackage.specifier)) {
      throw new Error('Runtime Host setup package is invalid');
    }
    return { specifier: setupPackage.specifier };
  }
  signal?.throwIfAborted();
  const archive = await realpath(setupPackage.path);
  if (!(await stat(archive)).isFile() || !archive.endsWith('.tgz')) {
    throw new Error('Runtime Host development package must be a .tgz file');
  }
  const remoteArchive = remoteDevelopmentArchivePath(principalId);
  const { process, terminal } = startTerminalProcess('scp', [
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
    onAbort: () => dismissPresentation(terminal),
  });
  if (result.code !== 0) {
    throw new Error(
      `Uploading the Runtime Host development package exited with code ${String(result.code)}`,
    );
  }
  return { specifier: remoteArchive, removeAfterSetup: remoteArchive };
}

function remoteDevelopmentArchivePath(principalId: string): string {
  // Reuse one staging slot because a disconnected Host cannot acknowledge cleanup.
  const owner = createHash('sha256').update(principalId).digest('hex').slice(0, 24);
  return `./.maka-runtime-host-setup-${owner}.tgz`;
}

async function waitForTerminalProcess(
  process: RuntimeHostSshProcess,
  input: {
    readonly signal?: AbortSignal;
    readonly timeoutMs: number;
    readonly timeoutMessage: string;
    readonly stopGraceMs?: number;
    readonly onAbort?: () => void;
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
      stopRequested.then(async (reason) => {
        if (reason === 'aborted') input.onAbort?.();
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
  input: Pick<DesktopRuntimeHostSshSetupInput, 'principalId'>,
): string {
  if (!/^[A-Za-z0-9_.:-]{1,128}$/u.test(input.principalId)) {
    throw new Error('Runtime Host setup principal is invalid');
  }
  return runtimeHostPackageRemoteCommand(setupPackage, [
    'runtime-host',
    'setup',
    '--principal',
    input.principalId,
    '--preset',
    'desktop-client',
    '--defer-pairing-commit',
    '--json',
  ]);
}

function runtimeHostServiceManagementRemoteCommand(
  input: DesktopRuntimeHostSshManagementInput,
): string {
  const command = [
    input.operatorPath,
    input.action,
    '--framed',
    ...(input.rootPath ? ['--root', input.rootPath] : []),
    ...(input.websocketPort === undefined
      ? []
      : ['--websocket-port', String(input.websocketPort)]),
    ...(input.websocketPath ? ['--websocket-path', input.websocketPath] : []),
    ...(input.retainManagedDeployment ? ['--retain-managed-deployment'] : []),
    ...managedServiceTargetArgs(input.expectedTarget),
  ].map(quotePosix).join(' ');
  return `exec "\${SHELL:-/bin/sh}" -lic ${quotePosix(`exec ${command}`)}`;
}

function runtimeHostManagedDeploymentCleanupRemoteCommand(operatorPath: string): string {
  const operator = quotePosix(operatorPath);
  const deploymentRoot = quotePosix(pathPosix.dirname(operatorPath));
  const invocation =
    `if [ ! -e ${operator} ]; then ` +
    `if [ ! -e ${deploymentRoot} ]; then exit 0; fi; ` +
    `exec rmdir -- ${deploymentRoot}; fi; ` +
    `exec ${operator} __cleanup-managed-deployment`;
  return `exec "\${SHELL:-/bin/sh}" -lic ${quotePosix(invocation)}`;
}

function managedServiceTargetArgs(input: {
  readonly serviceId: string;
  readonly rootPath: string;
  readonly rootId: string;
}): string[] {
  return [
    '--expected-service-id', input.serviceId,
    '--expected-root-path', input.rootPath,
    '--expected-root-id', input.rootId,
  ];
}

function runtimeHostPackageRemoteCommand(
  setupPackage: PreparedSetupPackage,
  args: readonly string[],
): string {
  const commandArgs = ['maka', ...args].map(quotePosix).join(' ');
  const commandInvocation = setupPackage.removeAfterSetup
    ? `npx --yes --package ${quotePosix(setupPackage.specifier)} ${commandArgs}`
    : `npx --yes --prefix "$maka_command_prefix" --package ${quotePosix(setupPackage.specifier)} ${commandArgs}`;
  const command = setupPackage.removeAfterSetup
    ? `cd "$HOME" || exit 1; maka_command_exit=0; ${commandInvocation} || maka_command_exit=$?; rm -f -- ${quotePosix(setupPackage.removeAfterSetup)}; exit "$maka_command_exit"`
    : `maka_command_prefix=$(mktemp -d) || exit 1; trap 'rm -rf -- "$maka_command_prefix"' EXIT; trap 'exit 129' HUP; trap 'exit 130' INT; trap 'exit 143' TERM; cd "$maka_command_prefix" || exit 1; ${commandInvocation}`;
  const loginCommand = `exec /bin/sh -c ${quotePosix(command)}`;
  return `exec "\${SHELL:-/bin/sh}" -lic ${quotePosix(loginCommand)}`;
}

function sshRemoteCommandArgs(
  destination: string,
  sshPort: number | undefined,
  remoteCommand: string,
): string[] {
  return [
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
  ];
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

function terminateActiveTerminal(
  terminal: ActiveTerminal,
  graceMs: number | undefined,
): Promise<void> {
  return terminateTerminalProcess(
    {
      exited: terminal.exited.then(() => ({ code: null, signal: null })),
      kill: (signal) => {
        try {
          terminal.pty.kill(signal);
        } catch {
          // The exit promise is the authority for concurrent process exit.
        }
      },
    },
    graceMs,
  );
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
