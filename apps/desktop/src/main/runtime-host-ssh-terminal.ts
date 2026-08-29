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
import { posix as pathPosix } from 'node:path';
import type { IpcMain } from 'electron';
import type { IPty } from 'node-pty';
import { spawn as spawnPty } from 'node-pty';
import { terminateProcessTree } from '@maka/runtime/process-tree-terminator';
import {
  activateRuntimeHostSshOperator,
  normalizeRuntimeHostSshDestination,
  openRuntimeHostSshTunnel,
  type RuntimeHostSshOperatorActivationInput,
  type RuntimeHostSshProcess,
  type RuntimeHostSshProcessFactory,
  type RuntimeHostSshTunnel,
  type RuntimeHostSshTunnelInput,
} from '@maka/runtime-host/client';
import {
  decodeRuntimeHostActivationFrame,
  decodeRuntimeHostAccessManagementFrame,
  decodeRuntimeHostPeerManagementFrame,
  decodeRuntimeHostPeerMeshManagementFrame,
  decodeRuntimeHostServiceManagementFrame,
  decodeRuntimeHostSetupFrame,
  RUNTIME_HOST_ACTIVATION_FRAME_MAX_BYTES,
  RUNTIME_HOST_ACTIVATION_FRAME_PREFIX,
  RUNTIME_HOST_ACCESS_MANAGEMENT_FRAME_PREFIX,
  RUNTIME_HOST_OPERATOR_ACCESS_MANAGEMENT_CAPABILITY,
  RUNTIME_HOST_OPERATOR_CAPABILITY_REQUEST_ENV,
  RUNTIME_HOST_OPERATOR_PROJECT_DIRECTORY_CONFIGURATION_REQUEST_ENV,
  RUNTIME_HOST_OPERATOR_UPDATE_SCHEDULER_CAPABILITY,
  RUNTIME_HOST_PEER_MANAGEMENT_FRAME_PREFIX,
  RUNTIME_HOST_PEER_MESH_MANAGEMENT_FRAME_MAX_BYTES,
  RUNTIME_HOST_PEER_MESH_MANAGEMENT_FRAME_PREFIX,
  RUNTIME_HOST_SERVICE_MANAGEMENT_FRAME_PREFIX,
  RUNTIME_HOST_SETUP_FRAME_PREFIX,
  RUNTIME_HOST_SETUP_SOURCE_PACKAGE_INTEGRITY_ENV,
  type RuntimeHostAccessManagementFrame,
  type RuntimeHostActivationResult,
  type RuntimeHostManagedUpdatePolicy,
  type RuntimeHostPeerManagementAction,
  type RuntimeHostPeerManagementFrame,
  type RuntimeHostPeerMeshManagementAction,
  type RuntimeHostPeerMeshManagementFrame,
  type RuntimeHostOperatorCapability,
  type RuntimeHostServiceManagementAction,
  type RuntimeHostServiceManagementFrame,
  type RuntimeHostServiceUpdatePhase,
  type RuntimeHostSetupFrame,
} from '@maka/runtime-host/operator';
import type {
  DesktopRuntimeHostSshTerminalEvent,
  DesktopRuntimeHostSshTerminalSnapshot,
} from '../preload/bridge-contract.js';
import { createRuntimeHostFramedOutputFilter } from './runtime-host-framed-output.js';
import type {
  DesktopRuntimeHostDevelopmentPeerTarget,
  DesktopRuntimeHostSetupPackage,
} from './runtime-host-setup-package.js';

interface ActiveTerminal {
  readonly sessionId: string;
  readonly pty: IPty;
  readonly exited: Promise<void>;
  readonly hasExited: () => boolean;
  revealTimer: ReturnType<typeof setTimeout> | undefined;
  phase: 'connecting' | 'connected';
  revealed: boolean;
  dismissed: boolean;
  presentationSuppressed: boolean;
  output: string;
}

type DesktopRuntimeHostSshProcess = RuntimeHostSshProcess & {
  readonly hasExited: () => boolean;
};

const TERMINAL_REVEAL_DELAY_MS = 500;
const TERMINAL_OUTPUT_MAX = 64 * 1024;
const SETUP_FRAME_PENDING_MAX = 20 * 1024;
const MANAGEMENT_FRAME_PENDING_MAX = 128 * 1024;
const ACCESS_MANAGEMENT_FRAME_PENDING_MAX = 768 * 1024;
const PEER_MANAGEMENT_FRAME_PENDING_MAX = 128 * 1024;
const SETUP_TIMEOUT_MS = 10 * 60_000;
const MANAGEMENT_TIMEOUT_MS = 2 * 60_000;
const PROCESS_STOP_GRACE_MS = 2_000;

export interface DesktopRuntimeHostSshSetupInput {
  readonly destination: string;
  readonly sshPort?: number;
  readonly setupPackage: DesktopRuntimeHostSetupPackage;
  readonly principalId: string;
  readonly lifecycle?: 'supervised' | 'on_demand';
  readonly projectDirectoryRoots?: readonly { readonly label: string; readonly path: string }[];
  readonly signal?: AbortSignal;
}

export interface DesktopRuntimeHostSshTargetInput {
  readonly destination: string;
  readonly sshPort?: number;
  readonly signal?: AbortSignal;
}

export interface DesktopRuntimeHostSshManagementInput {
  readonly destination: string;
  readonly sshPort?: number;
  readonly operatorPath: string;
  readonly action: Exclude<
    RuntimeHostServiceManagementAction,
    'check_update' | 'update' | 'update_policy' | 'reconcile_update'
  >;
  readonly expectedTarget: {
    readonly serviceId: string;
    readonly rootPath: string;
    readonly rootId: string;
    readonly deploymentId?: string;
  };
  readonly rootPath?: string;
  readonly websocketPort?: number;
  readonly websocketPath?: string;
  readonly projectDirectoryRoots?: readonly { readonly label: string; readonly path: string }[];
  readonly expectedConfigFingerprint?: string;
  readonly allowInterruptActiveTasks?: boolean;
  readonly retainManagedDeployment?: boolean;
  readonly capabilityRequest?: RuntimeHostOperatorCapability;
  readonly signal?: AbortSignal;
}

export interface DesktopRuntimeHostSshUpdateInput {
  readonly destination: string;
  readonly sshPort?: number;
  readonly setupPackage: DesktopRuntimeHostSetupPackage;
  readonly expectedTarget: DesktopRuntimeHostSshManagementInput['expectedTarget'];
  readonly allowInterruptActiveTasks?: boolean;
  readonly signal?: AbortSignal;
}

export interface DesktopRuntimeHostSshUpdatePolicyInput {
  readonly destination: string;
  readonly sshPort?: number;
  readonly operatorPath: string;
  readonly policy?: RuntimeHostManagedUpdatePolicy;
  readonly expectedTarget: DesktopRuntimeHostSshManagementInput['expectedTarget'];
  readonly signal?: AbortSignal;
}

export interface DesktopRuntimeHostSshUpdateReconciliationInput {
  readonly destination: string;
  readonly sshPort?: number;
  readonly operatorPath: string;
  readonly expectedTarget: DesktopRuntimeHostSshManagementInput['expectedTarget'];
  readonly signal?: AbortSignal;
}

export interface DesktopRuntimeHostSshPeerManagementInput {
  readonly destination: string;
  readonly sshPort?: number;
  readonly operatorPath: string;
  readonly action: Extract<RuntimeHostPeerManagementAction, 'enable' | 'disable' | 'status'>;
  readonly coordinationRelays?: readonly string[];
  readonly automaticRelayDiscovery?: boolean;
  readonly expectedTarget: DesktopRuntimeHostSshManagementInput['expectedTarget'];
  readonly signal?: AbortSignal;
}

export interface DesktopRuntimeHostSshPeerMeshManagementInput {
  readonly destination: string;
  readonly sshPort?: number;
  readonly operatorPath: string;
  readonly action: RuntimeHostPeerMeshManagementAction;
  readonly expectedTarget: DesktopRuntimeHostSshManagementInput['expectedTarget'];
  readonly meshId?: string;
  readonly peerId?: string;
  readonly invitation?: string;
  readonly signal?: AbortSignal;
}

export interface DesktopRuntimeHostSshCleanupInput {
  readonly destination: string;
  readonly sshPort?: number;
  readonly operatorPath: string;
  readonly expectedTarget: DesktopRuntimeHostSshManagementInput['expectedTarget'];
  readonly finalize?: boolean;
  readonly signal?: AbortSignal;
}

interface DesktopRuntimeHostSshAccessTarget {
  readonly destination: string;
  readonly sshPort?: number;
  readonly operatorPath: string;
  readonly rootPath: string;
  readonly expectedRootId: string;
  readonly signal?: AbortSignal;
}

export type DesktopRuntimeHostSshAccessInput = DesktopRuntimeHostSshAccessTarget &
  (
    | { readonly action: 'list' }
    | { readonly action: 'prepare'; readonly currentCredentialFingerprint: string }
    | {
        readonly action: 'revoke';
        readonly credentialId: string;
        readonly currentCredentialFingerprint: string;
      }
  );

export type RuntimeHostServiceUpdateTerminalFrame =
  | Extract<RuntimeHostServiceManagementFrame, { kind: 'result'; action: 'update' }>
  | (Extract<RuntimeHostServiceManagementFrame, { kind: 'error' }> & {
      readonly action: 'update';
    });

export type RuntimeHostServiceUpdatePolicyTerminalFrame = Extract<
  RuntimeHostServiceManagementFrame,
  { kind: 'result' | 'error'; action: 'update_policy' }
>;

export type RuntimeHostServiceUpdateReconciliationTerminalFrame = Extract<
  RuntimeHostServiceManagementFrame,
  { kind: 'result' | 'error'; action: 'reconcile_update' }
>;

type RuntimeHostSetupCompleteFrame = Extract<RuntimeHostSetupFrame, { kind: 'complete' }>;

export function createDesktopRuntimeHostSshTerminal(input: {
  readonly ipcMain: Pick<IpcMain, 'handle' | 'removeHandler'>;
  readonly send: (channel: string, event: DesktopRuntimeHostSshTerminalEvent) => void;
  readonly spawnPty?: typeof spawnPty;
  readonly openSshTunnel?: typeof openRuntimeHostSshTunnel;
  readonly activateSshOperator?: typeof activateRuntimeHostSshOperator;
  readonly revealDelayMs?: number;
  readonly managementTimeoutMs?: number;
  readonly processStopGraceMs?: number;
  readonly terminateProcessTree?: typeof terminateProcessTree;
}): {
  activateSshOperator(
    input: RuntimeHostSshOperatorActivationInput,
  ): Promise<RuntimeHostActivationResult>;
  openSshTunnel(input: RuntimeHostSshTunnelInput): Promise<RuntimeHostSshTunnel>;
  resolveDevelopmentPeerTarget(
    input: DesktopRuntimeHostSshTargetInput,
  ): Promise<Exclude<DesktopRuntimeHostDevelopmentPeerTarget, 'none'>>;
  runSetup(
    input: DesktopRuntimeHostSshSetupInput,
    onProgress: (frame: Extract<RuntimeHostSetupFrame, { kind: 'progress' }>) => void,
    onComplete?: (frame: RuntimeHostSetupCompleteFrame) => void,
  ): Promise<RuntimeHostSetupCompleteFrame>;
  runServiceManagement(
    input: DesktopRuntimeHostSshManagementInput,
  ): Promise<Exclude<RuntimeHostServiceManagementFrame, { kind: 'progress' }>>;
  runUpdate(
    input: DesktopRuntimeHostSshUpdateInput,
    onProgress: (phase: RuntimeHostServiceUpdatePhase) => void,
  ): Promise<RuntimeHostServiceUpdateTerminalFrame>;
  runUpdatePolicy(
    input: DesktopRuntimeHostSshUpdatePolicyInput,
  ): Promise<RuntimeHostServiceUpdatePolicyTerminalFrame>;
  runUpdateReconciliation(
    input: DesktopRuntimeHostSshUpdateReconciliationInput,
    onProgress: (phase: RuntimeHostServiceUpdatePhase) => void,
  ): Promise<RuntimeHostServiceUpdateReconciliationTerminalFrame>;
  runAccessManagement(
    input: DesktopRuntimeHostSshAccessInput,
  ): Promise<RuntimeHostAccessManagementFrame>;
  runPeerManagement(
    input: DesktopRuntimeHostSshPeerManagementInput,
  ): Promise<RuntimeHostPeerManagementFrame>;
  runPeerMeshManagement(
    input: DesktopRuntimeHostSshPeerMeshManagementInput,
  ): Promise<Exclude<RuntimeHostPeerMeshManagementFrame, { kind: 'input' }>>;
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
    if (terminal.revealed && !terminal.presentationSuppressed) {
      input.send('runtime-host-ssh-terminal:event', {
        kind: 'connected',
        revision,
        sessionId: terminal.sessionId,
      });
    }
  }
  function suppressPresentation(terminal: ActiveTerminal): void {
    if (active !== terminal || terminal.phase !== 'connecting') return;
    terminal.presentationSuppressed = true;
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
  ): { readonly process: DesktopRuntimeHostSshProcess; readonly terminal: ActiveTerminal } => {
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
    let processExited = false;
    const hasExited = () => processExited;
    const terminal: ActiveTerminal = {
      sessionId,
      pty,
      exited: exited.then(() => undefined),
      hasExited,
      revealTimer: undefined,
      phase: 'connecting',
      revealed: false,
      dismissed: false,
      presentationSuppressed: false,
      output: '',
    };
    active = terminal;
    const reveal = () => {
      if (
        active !== terminal ||
        terminal.phase !== 'connecting' ||
        terminal.revealed ||
        terminal.dismissed ||
        terminal.presentationSuppressed
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
      if (!visible || terminal.presentationSuppressed) return;
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
      processExited = true;
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
      hasExited,
    } satisfies DesktopRuntimeHostSshProcess;
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
    await terminateActiveTerminal(
      terminal,
      input.processStopGraceMs,
      input.terminateProcessTree,
    );
  });

  const runFramedManagement = async <Frame>(options: {
    readonly destination: string;
    readonly sshPort?: number;
    readonly signal?: AbortSignal;
    readonly remoteCommand: string;
    readonly prefix: string;
    readonly pendingMaxBytes: number;
    readonly decode: (line: string) => Frame | undefined;
    readonly action: string;
    readonly frameAction: (frame: Frame) => string;
    readonly isTerminalFrame?: (frame: Frame) => boolean;
    readonly onProgress?: (frame: Frame) => void;
    readonly inputLine?: string;
    readonly label: string;
    readonly timeoutMs?: number;
  }): Promise<Frame> => {
    if (closed) throw new Error('Runtime Host SSH terminal is closed');
    options.signal?.throwIfAborted();
    const destination = normalizeRuntimeHostSshDestination(options.destination);
    const sshPort = options.sshPort === undefined ? undefined : requireSetupPort(options.sshPort);
    let frame: Frame | undefined;
    let failure: Error | undefined;
    let activeTerminal: ActiveTerminal | undefined;
    let receivedProgress = false;
    let inputSent = false;
    const sendInput = () => {
      if (inputSent || options.inputLine === undefined || !activeTerminal) return;
      inputSent = true;
      activeTerminal.pty.write(`${options.inputLine}\r`);
    };
    const filter = createRuntimeHostFramedOutputFilter({
      prefix: options.prefix,
      pendingMaxBytes: options.pendingMaxBytes,
      decode: options.decode,
      label: options.label,
      onFrame: (next) => {
        const action = options.frameAction(next);
        if (action !== options.action) {
          failure = new Error(`${options.label} returned ${action} for ${options.action}`);
          return;
        }
        if (options.isTerminalFrame && !options.isTerminalFrame(next)) {
          receivedProgress = true;
          if (activeTerminal) suppressPresentation(activeTerminal);
          options.onProgress?.(next);
          sendInput();
          return;
        }
        if (frame) {
          failure = new Error(`${options.label} returned multiple results`);
          return;
        }
        frame = next;
        if (activeTerminal) completePresentation(activeTerminal);
      },
      onError: (error) => {
        failure = error;
      },
    });
    const { process, terminal } = startTerminalProcess(
      'ssh',
      sshRemoteCommandArgs(destination, sshPort, options.remoteCommand),
      filter.push,
      true,
    );
    activeTerminal = terminal;
    if (receivedProgress) sendInput();
    if (frame) completePresentation(terminal);
    else if (receivedProgress) suppressPresentation(terminal);
    const wait = await waitForTerminalProcess(process, {
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? input.managementTimeoutMs ?? MANAGEMENT_TIMEOUT_MS,
      stopGraceMs: input.processStopGraceMs,
      onAbort: () => dismissPresentation(terminal),
    }, input.terminateProcessTree);
    filter.finish();
    if (failure) throw failure;
    if (!frame) {
      throw new Error(
        wait.timedOut
          ? `${options.label} timed out`
          : wait.exit.code === 0
          ? `${options.label} ended without a result`
          : `${options.label} exited with code ${String(wait.exit.code)}`,
      );
    }
    completePresentation(terminal);
    return frame;
  };

  return {
    activateSshOperator: async (activationInput) => {
      if (activationInput.interaction !== 'terminal') {
        return (input.activateSshOperator ?? activateRuntimeHostSshOperator)(activationInput);
      }
      const frame = await runFramedManagement({
        ...activationInput,
        remoteCommand: runtimeHostActivationRemoteCommand(activationInput),
        prefix: RUNTIME_HOST_ACTIVATION_FRAME_PREFIX,
        pendingMaxBytes: RUNTIME_HOST_ACTIVATION_FRAME_MAX_BYTES,
        decode: decodeRuntimeHostActivationFrame,
        action: 'activate',
        frameAction: () => 'activate',
        label: 'Remote Runtime Host activation',
        timeoutMs: activationInput.timeoutMs,
      });
      if (frame.kind === 'error') throw new Error(frame.error.message);
      if (frame.rootId !== activationInput.rootId) {
        throw new Error('Remote Runtime Host activation returned an inconsistent root');
      }
      return frame;
    },
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
    resolveDevelopmentPeerTarget: async (targetInput) => {
      if (closed) throw new Error('Runtime Host SSH terminal is closed');
      targetInput.signal?.throwIfAborted();
      const destination = normalizeRuntimeHostSshDestination(targetInput.destination);
      const sshPort = targetInput.sshPort === undefined
        ? undefined
        : requireSetupPort(targetInput.sshPort);
      const marker = `__MAKA_RUNTIME_HOST_TARGET_${randomUUID().replaceAll('-', '')}__`;
      const remoteCommand = `printf '${marker}%s:%s\\n' "$(uname -s)" "$(uname -m)"`;
      let target: Exclude<DesktopRuntimeHostDevelopmentPeerTarget, 'none'> | undefined;
      let failure: Error | undefined;
      const filter = createRuntimeHostFramedOutputFilter({
        prefix: marker,
        pendingMaxBytes: 256,
        decode: (line) => line.slice(marker.length).replaceAll('\r', '').trimEnd(),
        label: 'Remote Runtime Host target detection',
        onFrame: (identity) => {
          if (target) {
            failure = new Error('Remote Runtime Host target detection returned multiple results');
            return;
          }
          const [system, machine, ...extra] = identity.split(':');
          if (!system || !machine || extra.length > 0) {
            failure = new Error('Remote Runtime Host target detection returned an invalid result');
            return;
          }
          try {
            target = runtimeHostDevelopmentPeerTargetFromUname(system, machine);
          } catch (error) {
            failure = error instanceof Error ? error : new Error(String(error));
          }
        },
        onError: (error) => {
          failure = error;
        },
      });
      const { process, terminal } = startTerminalProcess(
        'ssh',
        sshRemoteCommandArgs(destination, sshPort, remoteCommand),
        filter.push,
        true,
      );
      const wait = await waitForTerminalProcess(process, {
        signal: targetInput.signal,
        timeoutMs: input.managementTimeoutMs ?? MANAGEMENT_TIMEOUT_MS,
        stopGraceMs: input.processStopGraceMs,
        onAbort: () => dismissPresentation(terminal),
      }, input.terminateProcessTree);
      if (wait.timedOut) throw new Error('Remote Runtime Host target detection timed out');
      if (wait.exit.code !== 0) {
        throw new Error(
          `Remote Runtime Host target detection exited with code ${String(wait.exit.code)}`,
        );
      }
      filter.finish();
      if (failure) throw failure;
      completePresentation(terminal);
      if (!target) throw new Error('Remote Runtime Host target detection returned no result');
      return target;
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
          input.terminateProcessTree,
        );
        const remoteCommand = runtimeHostSetupRemoteCommand(setupPackage, setupInput);
        let complete: RuntimeHostSetupCompleteFrame | undefined;
        let setupFailure: Error | undefined;
        let setupTerminal: ActiveTerminal | undefined;
        const filter = createRuntimeHostFramedOutputFilter({
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
        const wait = await waitForTerminalProcess(process, {
          signal: cancellation.signal,
          timeoutMs: SETUP_TIMEOUT_MS,
          stopGraceMs: input.processStopGraceMs,
          onAbort: () => dismissPresentation(terminal),
        }, input.terminateProcessTree);
        filter.finish();
        if (setupFailure) throw setupFailure;
        if (!complete) {
          throw new Error(
            wait.timedOut
              ? 'Remote Maka setup timed out'
              : wait.exit.code === 0
              ? 'Remote Maka setup ended without a completion result'
              : wait.exit.code === 2
                ? 'The released Maka CLI on this channel does not support automated Runtime Host setup'
                : `Remote Maka setup exited with code ${String(wait.exit.code)}`,
          );
        }
        completePresentation(terminal);
        return complete;
      } finally {
        cancellation.close();
      }
    },
    runServiceManagement: async (managementInput) => {
      const frame = await runFramedManagement({
        ...managementInput,
        remoteCommand: runtimeHostServiceManagementRemoteCommand(managementInput),
        prefix: RUNTIME_HOST_SERVICE_MANAGEMENT_FRAME_PREFIX,
        pendingMaxBytes: MANAGEMENT_FRAME_PENDING_MAX,
        decode: decodeRuntimeHostServiceManagementFrame,
        action: managementInput.action,
        frameAction: (frame) => frame.action,
        label: 'Remote Runtime Host service management',
      });
      if (frame.kind === 'progress') {
        throw new Error('Remote Runtime Host service management returned update progress');
      }
      return frame;
    },
    runUpdate: async (updateInput, onProgress) => {
      if (closed) throw new Error('Runtime Host SSH terminal is closed');
      updateInput.signal?.throwIfAborted();
      const destination = normalizeRuntimeHostSshDestination(updateInput.destination);
      const sshPort = updateInput.sshPort === undefined
        ? undefined
        : requireSetupPort(updateInput.sshPort);
      const setupPackage = await prepareSetupPackage(
        updateInput.setupPackage,
        destination,
        sshPort,
        updateInput.expectedTarget.serviceId,
        startTerminalProcess,
        updateInput.signal,
        input.processStopGraceMs,
        dismissPresentation,
        input.terminateProcessTree,
      );
      const frame = await runFramedManagement({
        ...updateInput,
        destination,
        ...(sshPort === undefined ? {} : { sshPort }),
        remoteCommand: runtimeHostUpdateRemoteCommand(setupPackage, updateInput),
        prefix: RUNTIME_HOST_SERVICE_MANAGEMENT_FRAME_PREFIX,
        pendingMaxBytes: MANAGEMENT_FRAME_PENDING_MAX,
        decode: decodeRuntimeHostServiceManagementFrame,
        action: 'update',
        frameAction: (candidate) => candidate.action,
        isTerminalFrame: (candidate) => candidate.kind !== 'progress',
        onProgress: (candidate) => {
          if (candidate.kind === 'progress') onProgress(candidate.phase);
        },
        label: 'Remote Runtime Host update',
        timeoutMs: SETUP_TIMEOUT_MS,
      });
      if (frame.kind === 'result' && frame.action === 'update') return frame;
      if (frame.kind === 'error' && frame.action === 'update') {
        return { ...frame, action: 'update' };
      }
      throw new Error('Remote Runtime Host update returned an invalid result');
    },
    runUpdatePolicy: async (policyInput) => {
      const frame = await runFramedManagement({
        ...policyInput,
        remoteCommand: runtimeHostUpdatePolicyRemoteCommand(policyInput),
        prefix: RUNTIME_HOST_SERVICE_MANAGEMENT_FRAME_PREFIX,
        pendingMaxBytes: MANAGEMENT_FRAME_PENDING_MAX,
        decode: decodeRuntimeHostServiceManagementFrame,
        action: 'update_policy',
        frameAction: (candidate) => candidate.action,
        label: 'Remote Runtime Host update policy',
      });
      if (frame.kind === 'result' && frame.action === 'update_policy') return frame;
      if (frame.kind === 'error' && frame.action === 'update_policy') return frame;
      throw new Error('Remote Runtime Host update policy returned an invalid result');
    },
    runUpdateReconciliation: async (reconciliationInput, onProgress) => {
      const frame = await runFramedManagement({
        ...reconciliationInput,
        remoteCommand: runtimeHostUpdateReconciliationRemoteCommand(reconciliationInput),
        prefix: RUNTIME_HOST_SERVICE_MANAGEMENT_FRAME_PREFIX,
        pendingMaxBytes: MANAGEMENT_FRAME_PENDING_MAX,
        decode: decodeRuntimeHostServiceManagementFrame,
        action: 'reconcile_update',
        frameAction: (candidate) => candidate.action,
        isTerminalFrame: (candidate) => candidate.kind !== 'progress',
        onProgress: (candidate) => {
          if (candidate.kind === 'progress') onProgress(candidate.phase);
        },
        label: 'Remote Runtime Host update reconciliation',
        timeoutMs: SETUP_TIMEOUT_MS,
      });
      if (frame.kind === 'result' && frame.action === 'reconcile_update') return frame;
      if (frame.kind === 'error' && frame.action === 'reconcile_update') return frame;
      throw new Error('Remote Runtime Host update reconciliation returned an invalid result');
    },
    runAccessManagement: (accessInput) =>
      runFramedManagement({
        ...accessInput,
        remoteCommand: runtimeHostAccessManagementRemoteCommand(accessInput),
        prefix: RUNTIME_HOST_ACCESS_MANAGEMENT_FRAME_PREFIX,
        pendingMaxBytes: ACCESS_MANAGEMENT_FRAME_PENDING_MAX,
        decode: decodeRuntimeHostAccessManagementFrame,
        action: accessInput.action,
        frameAction: (frame) => frame.action,
        label: 'Remote Runtime Host access management',
      }),
    runPeerManagement: (peerInput) =>
      runFramedManagement({
        ...peerInput,
        remoteCommand: runtimeHostPeerManagementRemoteCommand(peerInput),
        prefix: RUNTIME_HOST_PEER_MANAGEMENT_FRAME_PREFIX,
        pendingMaxBytes: PEER_MANAGEMENT_FRAME_PENDING_MAX,
        decode: decodeRuntimeHostPeerManagementFrame,
        action: peerInput.action,
        frameAction: (frame) => frame.action,
        label: 'Remote Runtime Host direct-peer management',
      }),
    runPeerMeshManagement: async (meshInput) => {
      const frame = await runFramedManagement({
        ...meshInput,
        remoteCommand: runtimeHostPeerMeshManagementRemoteCommand(meshInput),
        prefix: RUNTIME_HOST_PEER_MESH_MANAGEMENT_FRAME_PREFIX,
        pendingMaxBytes: RUNTIME_HOST_PEER_MESH_MANAGEMENT_FRAME_MAX_BYTES,
        decode: decodeRuntimeHostPeerMeshManagementFrame,
        action: meshInput.action,
        frameAction: (candidate) => candidate.action,
        isTerminalFrame: (candidate) => candidate.kind !== 'input',
        ...(meshInput.invitation ? { inputLine: meshInput.invitation } : {}),
        label: 'Remote Runtime Host Peer Mesh management',
      });
      if (frame.kind === 'input') {
        throw new Error('Remote Runtime Host Peer Mesh management ended before its result');
      }
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
          runtimeHostManagedDeploymentCleanupRemoteCommand(cleanupInput),
        ),
        undefined,
        true,
      );
      const wait = await waitForTerminalProcess(process, {
        signal: cleanupInput.signal,
        timeoutMs: input.managementTimeoutMs ?? MANAGEMENT_TIMEOUT_MS,
        stopGraceMs: input.processStopGraceMs,
        onAbort: () => dismissPresentation(terminal),
      }, input.terminateProcessTree);
      if (wait.timedOut) {
        throw new Error('Remote Runtime Host deployment cleanup timed out');
      }
      if (wait.exit.code !== 0) {
        throw new Error(
          `Remote Runtime Host deployment cleanup exited with code ${String(wait.exit.code)}`,
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
      await terminateActiveTerminal(
        terminal,
        input.processStopGraceMs,
        input.terminateProcessTree,
      ).catch(() => undefined);
    },
  };
}

export function runtimeHostDevelopmentPeerTargetFromUname(
  system: string,
  machine: string,
): Exclude<DesktopRuntimeHostDevelopmentPeerTarget, 'none'> {
  const normalizedMachine = machine.toLowerCase();
  if (system === 'Darwin' && normalizedMachine === 'arm64') return 'darwin-arm64';
  if (system === 'Linux') {
    if (normalizedMachine === 'x86_64') return 'linux-x64';
    if (normalizedMachine === 'aarch64' || normalizedMachine === 'arm64') {
      return 'linux-arm64';
    }
  }
  throw new Error(`Direct peer is not available on ${system}/${machine}`);
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

type PreparedSetupPackage =
  | { readonly kind: 'npm'; readonly specifier: string }
  | {
      readonly kind: 'development_archive';
      readonly specifier: string;
      readonly integrity: string;
      readonly removeAfterSetup: string;
    };

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
  ) => { readonly process: DesktopRuntimeHostSshProcess; readonly terminal: ActiveTerminal },
  signal: AbortSignal | undefined,
  stopGraceMs: number | undefined,
  dismissPresentation: (terminal: ActiveTerminal) => void,
  terminateTree: typeof terminateProcessTree | undefined,
): Promise<PreparedSetupPackage> {
  if (setupPackage.kind === 'npm') {
    return setupPackage;
  }
  signal?.throwIfAborted();
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
    setupPackage.path,
    `${destination}:${remoteArchive}`,
  ], undefined, true);
  const wait = await waitForTerminalProcess(process, {
    signal,
    timeoutMs: SETUP_TIMEOUT_MS,
    stopGraceMs,
    onAbort: () => dismissPresentation(terminal),
  }, terminateTree);
  if (wait.timedOut) {
    throw new Error('Uploading the Runtime Host development package timed out');
  }
  if (wait.exit.code !== 0) {
    throw new Error(
      `Uploading the Runtime Host development package exited with code ${String(wait.exit.code)}`,
    );
  }
  return {
    kind: 'development_archive',
    specifier: remoteArchive,
    integrity: setupPackage.integrity,
    removeAfterSetup: remoteArchive,
  };
}

function remoteDevelopmentArchivePath(principalId: string): string {
  // Reuse one staging slot because a disconnected Host cannot acknowledge cleanup.
  const owner = createHash('sha256').update(principalId).digest('hex').slice(0, 24);
  return `./.maka-runtime-host-setup-${owner}.tgz`;
}

async function waitForTerminalProcess(
  process: DesktopRuntimeHostSshProcess,
  input: {
    readonly signal?: AbortSignal;
    readonly timeoutMs: number;
    readonly stopGraceMs?: number;
    readonly onAbort?: () => void;
  },
  terminateTree: typeof terminateProcessTree = terminateProcessTree,
): Promise<{
  readonly exit: Awaited<RuntimeHostSshProcess['exited']>;
  readonly timedOut: boolean;
}> {
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
        await terminateTerminalProcess(process, input.stopGraceMs, terminateTree);
        return process.exited;
      }),
    ]);
    input.signal?.throwIfAborted();
    return { exit: result, timedOut: stopReason === 'timeout' };
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener('abort', onAbort);
  }
}

async function terminateTerminalProcess(
  process: Pick<DesktopRuntimeHostSshProcess, 'pid' | 'exited' | 'kill' | 'hasExited'>,
  graceMs = PROCESS_STOP_GRACE_MS,
  terminateTree: typeof terminateProcessTree = terminateProcessTree,
): Promise<void> {
  await signalTerminalProcess(process, 'SIGTERM', terminateTree);
  if (await settlesWithin(process.exited, graceMs)) return;
  await signalTerminalProcess(process, 'SIGKILL', terminateTree);
  if (await settlesWithin(process.exited, graceMs)) return;
  throw new Error('SSH process did not exit after forced termination');
}

async function signalTerminalProcess(
  process: Pick<DesktopRuntimeHostSshProcess, 'pid' | 'kill' | 'hasExited'>,
  signal: 'SIGTERM' | 'SIGKILL',
  terminateTree: typeof terminateProcessTree,
): Promise<void> {
  const fallback = () => process.kill(signal);
  if (process.pid === undefined) {
    fallback();
    return;
  }
  await terminateTree({
    pid: process.pid,
    signal,
    fallback,
    hasExited: process.hasExited,
    beforeSignal: () => !process.hasExited(),
  });
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
  input: Pick<
    DesktopRuntimeHostSshSetupInput,
    'principalId' | 'projectDirectoryRoots' | 'lifecycle'
  >,
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
    '--lifecycle',
    input.lifecycle === 'on_demand' ? 'on-demand' : 'supervised',
    '--defer-pairing-commit',
    ...(input.projectDirectoryRoots === undefined
      ? []
      : input.projectDirectoryRoots.length === 0
        ? ['--no-project-roots']
        : input.projectDirectoryRoots.flatMap(({ label, path }) => [
            '--project-root-json',
            JSON.stringify({ label, path }),
          ])),
    '--json',
  ]);
}

function runtimeHostActivationRemoteCommand(
  input: RuntimeHostSshOperatorActivationInput,
): string {
  if (!pathPosix.isAbsolute(input.operatorPath)) {
    throw new Error('Runtime Host operator path must be absolute');
  }
  return [
    input.operatorPath,
    'activate',
    '--framed',
    '--root-id',
    input.rootId,
  ].map(quotePosix).join(' ');
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
    ...(input.projectDirectoryRoots === undefined
      ? []
      : input.projectDirectoryRoots.length === 0
        ? ['--no-project-roots']
        : input.projectDirectoryRoots.flatMap(({ label, path }) => [
            '--project-root-json',
            JSON.stringify({ label, path }),
          ])),
    ...(input.expectedConfigFingerprint
      ? ['--expected-config-fingerprint', input.expectedConfigFingerprint]
      : []),
    ...(input.allowInterruptActiveTasks ? ['--allow-interrupt-active-tasks'] : []),
    ...(input.retainManagedDeployment ? ['--retain-managed-deployment'] : []),
    ...managedServiceTargetArgs(input.expectedTarget),
  ].map(quotePosix).join(' ');
  const invocation =
    `${RUNTIME_HOST_OPERATOR_PROJECT_DIRECTORY_CONFIGURATION_REQUEST_ENV}=1 ` +
    `${RUNTIME_HOST_OPERATOR_CAPABILITY_REQUEST_ENV}=` +
    `${quotePosix(input.capabilityRequest ?? RUNTIME_HOST_OPERATOR_ACCESS_MANAGEMENT_CAPABILITY)} exec ${command}`;
  return `exec "\${SHELL:-/bin/sh}" -lic ${quotePosix(invocation)}`;
}

function runtimeHostUpdateRemoteCommand(
  setupPackage: PreparedSetupPackage,
  input: DesktopRuntimeHostSshUpdateInput,
): string {
  const deploymentId = input.expectedTarget.deploymentId;
  if (!deploymentId) {
    throw new Error('Runtime Host update requires a deployment generation');
  }
  return runtimeHostPackageRemoteCommand(
    setupPackage,
    [
      'runtime-host',
      'service',
      'update',
      '--framed',
      '--managed-root-id',
      input.expectedTarget.rootId,
      '--operator-deployment-id',
      deploymentId,
      ...managedServiceTargetArgs(input.expectedTarget),
      ...(input.allowInterruptActiveTasks ? ['--allow-interrupt-active-tasks'] : []),
    ],
    {
      [RUNTIME_HOST_OPERATOR_CAPABILITY_REQUEST_ENV]:
        RUNTIME_HOST_OPERATOR_ACCESS_MANAGEMENT_CAPABILITY,
      [RUNTIME_HOST_OPERATOR_PROJECT_DIRECTORY_CONFIGURATION_REQUEST_ENV]: '1',
    },
  );
}

function runtimeHostUpdatePolicyRemoteCommand(
  input: DesktopRuntimeHostSshUpdatePolicyInput,
): string {
  const policy = input.policy;
  const target = policy === undefined
    ? []
    : ['--target', policy.kind === 'channel' ? policy.channel : policy.kind === 'fixed' ? policy.version : 'manual'];
  const command = [
    input.operatorPath,
    'update-policy',
    '--framed',
    ...target,
    ...managedServiceTargetArgs(input.expectedTarget),
  ].map(quotePosix).join(' ');
  const invocation =
    `${RUNTIME_HOST_OPERATOR_CAPABILITY_REQUEST_ENV}=` +
    `${quotePosix(RUNTIME_HOST_OPERATOR_UPDATE_SCHEDULER_CAPABILITY)} exec ${command}`;
  return `exec "\${SHELL:-/bin/sh}" -lic ${quotePosix(invocation)}`;
}

function runtimeHostUpdateReconciliationRemoteCommand(
  input: DesktopRuntimeHostSshUpdateReconciliationInput,
): string {
  const command = [
    input.operatorPath,
    'reconcile-update',
    '--framed',
    ...managedServiceTargetArgs(input.expectedTarget),
  ]
    .map(quotePosix)
    .join(' ');
  const invocation =
    `${RUNTIME_HOST_OPERATOR_PROJECT_DIRECTORY_CONFIGURATION_REQUEST_ENV}=1 ` +
    `${RUNTIME_HOST_OPERATOR_CAPABILITY_REQUEST_ENV}=` +
    `${quotePosix(RUNTIME_HOST_OPERATOR_UPDATE_SCHEDULER_CAPABILITY)} exec ${command}`;
  return `exec "\${SHELL:-/bin/sh}" -lic ${quotePosix(invocation)}`;
}

function runtimeHostAccessManagementRemoteCommand(
  input: DesktopRuntimeHostSshAccessInput,
): string {
  const actionArgs = input.action === 'prepare'
    ? ['--current-fingerprint', input.currentCredentialFingerprint]
    : input.action === 'revoke'
      ? [
          '--credential', input.credentialId,
          '--current-fingerprint', input.currentCredentialFingerprint,
        ]
      : [];
  const command = [
    input.operatorPath,
    'access',
    input.action,
    '--framed',
    '--root',
    input.rootPath,
    '--expected-root',
    input.expectedRootId,
    ...actionArgs,
  ].map(quotePosix).join(' ');
  return `exec "\${SHELL:-/bin/sh}" -lic ${quotePosix(`exec ${command}`)}`;
}

function runtimeHostPeerManagementRemoteCommand(
  input: DesktopRuntimeHostSshPeerManagementInput,
): string {
  const command = [
    input.operatorPath,
    'peer',
    input.action,
    '--framed',
    '--relay-discovery-status',
    ...(input.action === 'enable' && input.coordinationRelays
      ? input.coordinationRelays.length === 0
        ? ['--clear-coordination-relays']
        : input.coordinationRelays.flatMap((relay) => ['--coordination-relay', relay])
      : []),
    ...(input.action === 'enable' && input.automaticRelayDiscovery !== undefined
      ? [input.automaticRelayDiscovery
          ? '--automatic-relay-discovery'
          : '--no-automatic-relay-discovery']
      : []),
    ...managedServiceTargetArgs(input.expectedTarget),
  ].map(quotePosix).join(' ');
  return `exec "\${SHELL:-/bin/sh}" -lic ${quotePosix(`exec ${command}`)}`;
}

function runtimeHostPeerMeshManagementRemoteCommand(
  input: DesktopRuntimeHostSshPeerMeshManagementInput,
): string {
  const command = [
    input.operatorPath,
    'mesh',
    input.action,
    '--framed',
    ...(input.meshId ? ['--mesh', input.meshId] : []),
    ...(input.peerId ? ['--peer', input.peerId] : []),
    ...managedServiceTargetArgs(input.expectedTarget),
  ].map(quotePosix).join(' ');
  return `exec "\${SHELL:-/bin/sh}" -lic ${quotePosix(`exec ${command}`)}`;
}

function runtimeHostManagedDeploymentCleanupRemoteCommand(
  input: DesktopRuntimeHostSshCleanupInput,
): string {
  const operator = quotePosix(input.operatorPath);
  const deploymentRoot = quotePosix(pathPosix.dirname(input.operatorPath));
  const cleanup = [
    input.operatorPath,
    '__cleanup-managed-deployment',
    ...(input.finalize ? ['--finalize'] : []),
    ...managedServiceTargetArgs(input.expectedTarget),
  ].map(quotePosix).join(' ');
  const invocation =
    `if [ ! -e ${operator} ]; then ` +
    `if [ ! -e ${deploymentRoot} ]; then exit 0; fi; ` +
    `exit 1; fi; ` +
    `exec ${cleanup}`;
  return `exec "\${SHELL:-/bin/sh}" -lic ${quotePosix(invocation)}`;
}

function managedServiceTargetArgs(input: {
  readonly serviceId: string;
  readonly rootPath: string;
  readonly rootId: string;
  readonly deploymentId?: string;
}): string[] {
  return [
    '--expected-service-id', input.serviceId,
    '--expected-root-path', input.rootPath,
    '--expected-root-id', input.rootId,
    ...(input.deploymentId ? ['--expected-deployment-id', input.deploymentId] : []),
  ];
}

function runtimeHostPackageRemoteCommand(
  setupPackage: PreparedSetupPackage,
  args: readonly string[],
  environment: Readonly<Record<string, string>> = {},
): string {
  const commandArgs = ['maka', ...args].map(quotePosix).join(' ');
  const environmentPrefix = Object.entries({
    ...environment,
    ...(setupPackage.kind === 'development_archive'
      ? { [RUNTIME_HOST_SETUP_SOURCE_PACKAGE_INTEGRITY_ENV]: setupPackage.integrity }
      : {}),
  })
    .map(([name, value]) => `${name}=${quotePosix(value)}`)
    .join(' ');
  const invocationPrefix = environmentPrefix ? `${environmentPrefix} ` : '';
  const commandInvocation = setupPackage.kind === 'development_archive'
    ? `${invocationPrefix}npx --yes --package ${quotePosix(setupPackage.specifier)} ${commandArgs}`
    : `${invocationPrefix}npx --yes --prefix "$maka_command_prefix" --package ${quotePosix(setupPackage.specifier)} ${commandArgs}`;
  const command = setupPackage.kind === 'development_archive'
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
  terminateTree: typeof terminateProcessTree | undefined,
): Promise<void> {
  return terminateTerminalProcess(
    {
      pid: terminal.pty.pid,
      exited: terminal.exited.then(() => ({ code: null, signal: null })),
      hasExited: terminal.hasExited,
      kill: (signal) => {
        try {
          terminal.pty.kill(signal);
        } catch {
          // The exit promise is the authority for concurrent process exit.
        }
      },
    },
    graceMs,
    terminateTree,
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
