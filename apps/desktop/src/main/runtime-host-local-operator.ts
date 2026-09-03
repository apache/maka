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

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, rmdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { redactSecrets } from '@maka/core/redaction';
import {
  DEFAULT_PROCESS_TERMINATION_GRACE_MS,
  terminateChildProcessTree,
} from '@maka/runtime/process-tree-terminator';
import {
  decodeRuntimeHostAccessManagementFrame,
  decodeRuntimeHostPeerManagementFrame,
  decodeRuntimeHostPeerMeshManagementFrame,
  decodeRuntimeHostServiceManagementFrame,
  decodeRuntimeHostSetupFrame,
  RUNTIME_HOST_OPERATOR_PROJECT_DIRECTORY_CONFIGURATION_REQUEST_ENV,
  RUNTIME_HOST_OPERATOR_UPDATE_SCHEDULER_CAPABILITY,
  RUNTIME_HOST_OPERATOR_CAPABILITY_REQUEST_ENV,
  RUNTIME_HOST_ACCESS_MANAGEMENT_FRAME_PREFIX,
  RUNTIME_HOST_PEER_MANAGEMENT_FRAME_PREFIX,
  RUNTIME_HOST_PEER_MESH_MANAGEMENT_FRAME_MAX_BYTES,
  RUNTIME_HOST_PEER_MESH_MANAGEMENT_FRAME_PREFIX,
  RUNTIME_HOST_SERVICE_MANAGEMENT_FRAME_PREFIX,
  RUNTIME_HOST_SETUP_FRAME_PREFIX,
  RUNTIME_HOST_SETUP_SOURCE_PACKAGE_INTEGRITY_ENV,
  runtimeHostOperatorInvocation,
  type RuntimeHostAccessManagementFrame,
  type RuntimeHostManagedUpdatePolicy,
  type RuntimeHostPeerManagementFrame,
  type RuntimeHostPeerMeshManagementAction,
  type RuntimeHostPeerMeshManagementFrame,
  type RuntimeHostServiceManagementFrame,
  type RuntimeHostServiceUpdatePhase,
  type RuntimeHostSetupFrame,
  type RuntimeHostOperatorCommand,
} from '@maka/runtime-host/operator';
import { createRuntimeHostFramedOutputFilter } from './runtime-host-framed-output.js';
import {
  runtimeHostSetupPackageVersion,
  type DesktopRuntimeHostSetupPackage,
} from './runtime-host-setup-package.js';

const SETUP_TIMEOUT_MS = 10 * 60_000;
const SETUP_FRAME_PENDING_MAX = 20 * 1024;
const STDERR_MAX_BYTES = 64 * 1024;

type RuntimeHostSetupCompleteFrame = Extract<RuntimeHostSetupFrame, { kind: 'complete' }>;

export interface DesktopRuntimeHostLocalServiceTarget {
  readonly serviceId: string;
  readonly rootPath: string;
  readonly rootId: string;
  readonly deploymentId?: string;
}

export interface DesktopRuntimeHostLocalSetupInput {
  readonly setupPackage: DesktopRuntimeHostSetupPackage;
  readonly clientDataRoot: string;
  readonly rootPath: string;
  readonly principalId: string;
  readonly projectDirectoryRoots?: readonly { readonly label: string; readonly path: string }[];
  readonly coordinationRelays?: readonly string[];
  readonly expectedTarget: DesktopRuntimeHostLocalServiceTarget;
  readonly signal?: AbortSignal;
}

export interface DesktopRuntimeHostLocalSetupCommand {
  readonly executable: string;
  readonly args: readonly string[];
}

export interface DesktopRuntimeHostLocalServiceManagementInput {
  readonly operator: RuntimeHostOperatorCommand;
  readonly action:
    | 'status'
    | 'start'
    | 'restart'
    | 'logs'
    | 'install'
    | 'configure'
    | 'retire'
    | 'uninstall';
  readonly target: DesktopRuntimeHostLocalServiceTarget;
  readonly projectDirectoryRoots?: readonly { readonly label: string; readonly path: string }[];
  readonly expectedConfigFingerprint?: string;
  readonly allowInterruptActiveTasks?: boolean;
  readonly retainManagedDeployment?: boolean;
  readonly signal?: AbortSignal;
}

export function runtimeHostLocalSetupCommand(input: {
  readonly packageSpecifier: string;
  readonly clientDataRoot: string;
  readonly rootPath: string;
  readonly principalId: string;
  readonly projectDirectoryRoots?: readonly { readonly label: string; readonly path: string }[];
  readonly coordinationRelays?: readonly string[];
  readonly expectedTarget: DesktopRuntimeHostLocalServiceTarget;
}): DesktopRuntimeHostLocalSetupCommand {
  if (!/^[A-Za-z0-9_.:-]{1,128}$/u.test(input.principalId)) {
    throw new Error('Runtime Host setup principal is invalid');
  }
  return {
    executable: 'npm',
    args: [
      'exec',
      '--yes',
      '--package',
      input.packageSpecifier,
      '--',
      'maka',
      'runtime-host',
      'setup',
      '--client-data-root',
      input.clientDataRoot,
      '--root',
      input.rootPath,
      '--principal',
      input.principalId,
      '--preset',
      'desktop-client',
      '--defer-pairing-commit',
      '--bind-pairing-to-client',
      '--enable-direct-peer',
      ...managedTargetArgs(input.expectedTarget),
      ...(input.coordinationRelays ?? []).flatMap((relay) => [
        '--coordination-relay',
        relay,
      ]),
      ...(input.projectDirectoryRoots === undefined
        ? []
        : input.projectDirectoryRoots.length === 0
          ? ['--no-project-roots']
          : input.projectDirectoryRoots.flatMap(({ label, path }) => [
              '--project-root-json',
              JSON.stringify({ label, path }),
            ])),
      '--json',
    ],
  };
}

export function createDesktopRuntimeHostLocalOperator(input: {
  readonly environment?: NodeJS.ProcessEnv;
  readonly spawnProcess?: typeof spawn;
  readonly setupTimeoutMs?: number;
  readonly terminateProcess?: typeof terminateChildProcessTree;
} = {}): {
  runSetup(
    setup: DesktopRuntimeHostLocalSetupInput,
    onProgress: (frame: Extract<RuntimeHostSetupFrame, { kind: 'progress' }>) => void,
  ): Promise<RuntimeHostSetupCompleteFrame>;
  runPeer(input: {
    readonly operator: RuntimeHostOperatorCommand;
    readonly action: 'enable' | 'disable' | 'status';
    readonly target: DesktopRuntimeHostLocalServiceTarget;
    readonly coordinationRelays?: readonly string[];
    readonly allowInterruptActiveTasks?: boolean;
    readonly signal?: AbortSignal;
  }): Promise<RuntimeHostPeerManagementFrame>;
  runPeerMesh(input: {
    readonly operator: RuntimeHostOperatorCommand;
    readonly action: RuntimeHostPeerMeshManagementAction;
    readonly target: DesktopRuntimeHostLocalServiceTarget;
    readonly meshId?: string | null;
    readonly peerId?: string;
    readonly displayName?: string | null;
    readonly invitation?: string;
    readonly signal?: AbortSignal;
  }): Promise<Exclude<RuntimeHostPeerMeshManagementFrame, { kind: 'input' }>>;
  runAccess(input: {
    readonly operator: RuntimeHostOperatorCommand;
    readonly target: DesktopRuntimeHostLocalServiceTarget;
    readonly signal?: AbortSignal;
  }): Promise<RuntimeHostAccessManagementFrame>;
  runService(
    input: DesktopRuntimeHostLocalServiceManagementInput,
  ): Promise<RuntimeHostServiceManagementFrame>;
  runUpdate(
    input: {
      readonly setupPackage: DesktopRuntimeHostSetupPackage;
      readonly target: DesktopRuntimeHostLocalServiceTarget;
      readonly expectedHost?: { readonly hostEpoch: string; readonly pid: number };
      readonly allowManualUpdate?: boolean;
      readonly allowInterruptActiveTasks?: boolean;
      readonly signal?: AbortSignal;
    },
    onProgress: (phase: RuntimeHostServiceUpdatePhase) => void,
  ): Promise<RuntimeHostServiceManagementFrame>;
  runUpdatePolicy(input: {
    readonly operator: RuntimeHostOperatorCommand;
    readonly target: DesktopRuntimeHostLocalServiceTarget;
    readonly policy?: RuntimeHostManagedUpdatePolicy;
    readonly signal?: AbortSignal;
  }): Promise<RuntimeHostServiceManagementFrame>;
  runUpdateReconciliation(
    input: {
      readonly operator: RuntimeHostOperatorCommand;
      readonly target: DesktopRuntimeHostLocalServiceTarget;
      readonly signal?: AbortSignal;
    },
    onProgress: (phase: RuntimeHostServiceUpdatePhase) => void,
  ): Promise<RuntimeHostServiceManagementFrame>;
  cleanupManagedDeployment(input: {
    readonly operator: RuntimeHostOperatorCommand;
    readonly target: DesktopRuntimeHostLocalServiceTarget;
    readonly finalize?: boolean;
    readonly signal?: AbortSignal;
  }): Promise<void>;
  close(): Promise<void>;
} {
  const active = new Set<ChildProcess>();
  let closed = false;
  const closing = new AbortController();
  const terminate = input.terminateProcess ?? terminateChildProcessTree;

  return {
    async runSetup(setup, onProgress) {
      if (closed) throw new Error('Local Runtime Host operator is closed');
      setup.signal?.throwIfAborted();
      const setupPackage = await resolveLocalSetupPackage(setup.setupPackage);
      const command = runtimeHostLocalSetupCommand({
        ...setup,
        packageSpecifier: setupPackage.specifier,
      });
      const workingDirectory = await mkdtemp(join(tmpdir(), 'maka-runtime-host-local-setup-'));
      try {
        if (closed) throw new Error('Local Runtime Host operator is closed');
        const signal = combinedSignal(setup.signal, closing.signal);
        signal.throwIfAborted();
        return await runSetupProcess({
          command,
          cwd: workingDirectory,
          environment: {
            ...(input.environment ?? process.env),
            ...(setupPackage.integrity
              ? {
                  [RUNTIME_HOST_SETUP_SOURCE_PACKAGE_INTEGRITY_ENV]:
                    setupPackage.integrity,
                }
              : {}),
          },
          spawnProcess: input.spawnProcess ?? spawn,
          timeoutMs: input.setupTimeoutMs ?? SETUP_TIMEOUT_MS,
          terminate,
          signal,
          onProgress,
          active,
        });
      } finally {
        await rm(workingDirectory, { recursive: true, force: true });
      }
    },
    runPeer(command) {
      if (closed) throw new Error('Local Runtime Host operator is closed');
      return runSingleFrameProcess({
        command: runtimeHostOperatorInvocation(command.operator, [
            'peer',
            command.action,
            '--framed',
            ...(command.action === 'enable'
              ? command.coordinationRelays?.length
                ? command.coordinationRelays.flatMap((relay) => [
                    '--coordination-relay',
                    relay,
                  ])
                : ['--clear-coordination-relays']
              : []),
            ...(command.allowInterruptActiveTasks ? ['--allow-interrupt-active-tasks'] : []),
            ...managedTargetArgs(command.target),
          ]),
        prefix: RUNTIME_HOST_PEER_MANAGEMENT_FRAME_PREFIX,
        decode: decodeRuntimeHostPeerManagementFrame,
        label: 'Local Runtime Host peer management',
        environment: input.environment ?? process.env,
        spawnProcess: input.spawnProcess ?? spawn,
        timeoutMs: input.setupTimeoutMs ?? SETUP_TIMEOUT_MS,
        terminate,
        signal: combinedSignal(command.signal, closing.signal),
        active,
      }).then((frame) => requirePeerFrame(frame, command.action, command.target));
    },
    runPeerMesh(command) {
      if (closed) throw new Error('Local Runtime Host operator is closed');
      return runPeerMeshFrameProcess({
        command: runtimeHostOperatorInvocation(command.operator, [
            'mesh',
            command.action,
            '--framed',
            ...(typeof command.meshId === 'string'
              ? ['--mesh', command.meshId]
              : command.meshId === null
                ? ['--off']
                : []),
            ...(command.peerId ? ['--peer', command.peerId] : []),
            ...(command.displayName === null
              ? ['--clear-name']
              : command.displayName
                ? ['--name', command.displayName]
                : []),
            ...managedTargetArgs(command.target),
          ]),
        environment: input.environment ?? process.env,
        spawnProcess: input.spawnProcess ?? spawn,
        timeoutMs: input.setupTimeoutMs ?? SETUP_TIMEOUT_MS,
        terminate,
        signal: combinedSignal(command.signal, closing.signal),
        active,
        ...(command.invitation ? { inputLine: command.invitation } : {}),
        action: command.action,
      });
    },
    runAccess(command) {
      if (closed) throw new Error('Local Runtime Host operator is closed');
      return runSingleFrameProcess({
        command: runtimeHostOperatorInvocation(command.operator, [
            'access',
            'list',
            '--framed',
            '--root',
            command.target.rootPath,
            '--expected-root',
            command.target.rootId,
          ]),
        prefix: RUNTIME_HOST_ACCESS_MANAGEMENT_FRAME_PREFIX,
        decode: decodeRuntimeHostAccessManagementFrame,
        label: 'Local Runtime Host access management',
        environment: input.environment ?? process.env,
        spawnProcess: input.spawnProcess ?? spawn,
        timeoutMs: input.setupTimeoutMs ?? SETUP_TIMEOUT_MS,
        terminate,
        signal: combinedSignal(command.signal, closing.signal),
        active,
      }).then(requireAccessListFrame);
    },
    runService(command) {
      if (closed) throw new Error('Local Runtime Host operator is closed');
      return runSingleFrameProcess({
        command: runtimeHostOperatorInvocation(command.operator, [
            command.action,
            '--framed',
            ...(command.projectDirectoryRoots === undefined
              ? []
              : command.projectDirectoryRoots.length === 0
                ? ['--no-project-roots']
                : command.projectDirectoryRoots.flatMap(({ label, path }) => [
                    '--project-root-json',
                    JSON.stringify({ label, path }),
                  ])),
            ...(command.expectedConfigFingerprint
              ? ['--expected-config-fingerprint', command.expectedConfigFingerprint]
              : []),
            ...(command.allowInterruptActiveTasks ? ['--allow-interrupt-active-tasks'] : []),
            ...(command.retainManagedDeployment ? ['--retain-managed-deployment'] : []),
            ...managedTargetArgs(command.target),
          ]),
        prefix: RUNTIME_HOST_SERVICE_MANAGEMENT_FRAME_PREFIX,
        decode: decodeRuntimeHostServiceManagementFrame,
        label: 'Local Runtime Host service management',
        environment: {
          ...(input.environment ?? process.env),
          [RUNTIME_HOST_OPERATOR_PROJECT_DIRECTORY_CONFIGURATION_REQUEST_ENV]: '1',
        },
        spawnProcess: input.spawnProcess ?? spawn,
        timeoutMs: input.setupTimeoutMs ?? SETUP_TIMEOUT_MS,
        terminate,
        signal: combinedSignal(command.signal, closing.signal),
        active,
      }).then((frame) => requireServiceFrame(frame, command.action));
    },
    runUpdate(command, onProgress) {
      if (closed) throw new Error('Local Runtime Host operator is closed');
      if (!command.target.deploymentId) {
        return Promise.reject(new Error('Runtime Host update requires a deployment generation'));
      }
      const setupPackage = resolveLocalSetupPackage(command.setupPackage);
      const targetVersion = runtimeHostSetupPackageVersion(command.setupPackage);
      return runServiceFrameProcess({
        command: {
          executable: 'npm',
          args: [
            'exec',
            '--yes',
            '--package',
            setupPackage.specifier,
            '--',
            'maka',
            'runtime-host',
            'service',
            'update',
            '--framed',
            ...(targetVersion ? ['--target', targetVersion] : []),
            '--managed-root-id',
            command.target.rootId,
            ...(command.expectedHost
              ? ['--expected-host-json', JSON.stringify(command.expectedHost)]
              : []),
            ...managedTargetArgs(command.target),
            ...(command.allowManualUpdate && targetVersion ? ['--allow-manual-update'] : []),
            ...(command.allowInterruptActiveTasks ? ['--allow-interrupt-active-tasks'] : []),
          ],
        },
        environment: {
          ...(input.environment ?? process.env),
          ...(setupPackage.integrity
            ? { [RUNTIME_HOST_SETUP_SOURCE_PACKAGE_INTEGRITY_ENV]: setupPackage.integrity }
            : {}),
          [RUNTIME_HOST_OPERATOR_PROJECT_DIRECTORY_CONFIGURATION_REQUEST_ENV]: '1',
        },
        spawnProcess: input.spawnProcess ?? spawn,
        timeoutMs: input.setupTimeoutMs ?? SETUP_TIMEOUT_MS,
        terminate,
        signal: combinedSignal(command.signal, closing.signal),
        active,
        action: 'update',
        onProgress,
      });
    },
    runUpdatePolicy(command) {
      if (closed) throw new Error('Local Runtime Host operator is closed');
      const policy = command.policy;
      return runServiceFrameProcess({
        command: runtimeHostOperatorInvocation(command.operator, [
            'update-policy',
            '--framed',
            ...(policy
              ? [
                  '--target',
                  policy.kind === 'channel'
                    ? policy.channel
                    : policy.kind === 'fixed'
                      ? policy.version
                      : 'manual',
                ]
              : []),
            ...managedTargetArgs(command.target),
          ]),
        environment: {
          ...(input.environment ?? process.env),
          [RUNTIME_HOST_OPERATOR_CAPABILITY_REQUEST_ENV]:
            RUNTIME_HOST_OPERATOR_UPDATE_SCHEDULER_CAPABILITY,
        },
        spawnProcess: input.spawnProcess ?? spawn,
        timeoutMs: input.setupTimeoutMs ?? SETUP_TIMEOUT_MS,
        terminate,
        signal: combinedSignal(command.signal, closing.signal),
        active,
        action: 'update_policy',
      });
    },
    runUpdateReconciliation(command, onProgress) {
      if (closed) throw new Error('Local Runtime Host operator is closed');
      return runServiceFrameProcess({
        command: runtimeHostOperatorInvocation(command.operator, [
          'reconcile-update',
          '--framed',
          ...managedTargetArgs(command.target),
        ]),
        environment: {
          ...(input.environment ?? process.env),
          [RUNTIME_HOST_OPERATOR_PROJECT_DIRECTORY_CONFIGURATION_REQUEST_ENV]: '1',
          [RUNTIME_HOST_OPERATOR_CAPABILITY_REQUEST_ENV]:
            RUNTIME_HOST_OPERATOR_UPDATE_SCHEDULER_CAPABILITY,
        },
        spawnProcess: input.spawnProcess ?? spawn,
        timeoutMs: input.setupTimeoutMs ?? SETUP_TIMEOUT_MS,
        terminate,
        signal: combinedSignal(command.signal, closing.signal),
        active,
        action: 'reconcile_update',
        onProgress,
      });
    },
    async cleanupManagedDeployment(command) {
      if (closed) throw new Error('Local Runtime Host operator is closed');
      const operatorPath = command.operator.kind === 'node'
        ? command.operator.modulePath
        : command.operator.executablePath;
      try {
        await stat(operatorPath);
      } catch (error) {
        if (!isNodeError(error, 'ENOENT')) throw error;
        try {
          await rmdir(dirname(operatorPath));
        } catch (directoryError) {
          if (!isNodeError(directoryError, 'ENOENT')) throw directoryError;
        }
        return;
      }
      await runExitProcess({
        command: runtimeHostOperatorInvocation(command.operator, [
            '__cleanup-managed-deployment',
            ...(command.finalize ? ['--finalize'] : []),
            ...managedTargetArgs(command.target),
          ]),
        label: 'Local Runtime Host deployment cleanup',
        environment: input.environment ?? process.env,
        spawnProcess: input.spawnProcess ?? spawn,
        timeoutMs: input.setupTimeoutMs ?? SETUP_TIMEOUT_MS,
        terminate,
        signal: combinedSignal(command.signal, closing.signal),
        active,
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      closing.abort(new Error('Local Runtime Host operator is closed'));
      await Promise.allSettled([...active].map((child) => stopProcess(child, terminate)));
    },
  };
}

function requirePeerFrame(
  frame: RuntimeHostPeerManagementFrame,
  action: 'enable' | 'disable' | 'status',
  target: DesktopRuntimeHostLocalServiceTarget,
): RuntimeHostPeerManagementFrame {
  if (frame.action !== action) {
    throw new Error('Local Runtime Host peer management returned an unrelated result');
  }
  if (
    frame.kind === 'result' &&
    frame.status.state === 'enabled' &&
    frame.status.rootId !== target.rootId
  ) {
    throw new Error('Local Runtime Host peer management returned an unrelated root');
  }
  return frame;
}

function requireAccessListFrame(
  frame: RuntimeHostAccessManagementFrame,
): RuntimeHostAccessManagementFrame {
  if (frame.action !== 'list') {
    throw new Error('Local Runtime Host access management returned an unrelated result');
  }
  return frame;
}

function requireServiceFrame(
  frame: RuntimeHostServiceManagementFrame,
  action: DesktopRuntimeHostLocalServiceManagementInput['action'],
): RuntimeHostServiceManagementFrame {
  if (frame.action !== action) {
    throw new Error('Local Runtime Host service management returned an unrelated result');
  }
  return frame;
}

function runServiceFrameProcess(input: {
  readonly command: DesktopRuntimeHostLocalSetupCommand;
  readonly environment: NodeJS.ProcessEnv;
  readonly spawnProcess: typeof spawn;
  readonly timeoutMs: number;
  readonly terminate: typeof terminateChildProcessTree;
  readonly signal?: AbortSignal;
  readonly active: Set<ChildProcess>;
  readonly action: RuntimeHostServiceManagementFrame['action'];
  readonly onProgress?: (phase: RuntimeHostServiceUpdatePhase) => void;
}): Promise<RuntimeHostServiceManagementFrame> {
  let result: RuntimeHostServiceManagementFrame | undefined;
  let failure: Error | undefined;
  return runFramedProcess({
    ...input,
    prefix: RUNTIME_HOST_SERVICE_MANAGEMENT_FRAME_PREFIX,
    decode: decodeRuntimeHostServiceManagementFrame,
    label: 'Local Runtime Host service management',
    onFrame(frame) {
      if (frame.action !== input.action) {
        failure = new Error('Local Runtime Host service management returned an unrelated result');
        return;
      }
      if (frame.kind === 'progress') {
        if (!input.onProgress) {
          failure = new Error('Local Runtime Host service management returned unexpected progress');
        } else {
          input.onProgress(frame.phase);
        }
        return;
      }
      if (result) {
        failure = new Error('Local Runtime Host service management returned multiple results');
      } else {
        result = frame;
      }
    },
    result: () => result,
    failure: () => failure,
    acceptNonzeroResult: true,
  });
}

function runPeerMeshFrameProcess(input: {
  readonly command: DesktopRuntimeHostLocalSetupCommand;
  readonly environment: NodeJS.ProcessEnv;
  readonly spawnProcess: typeof spawn;
  readonly timeoutMs: number;
  readonly terminate: typeof terminateChildProcessTree;
  readonly signal?: AbortSignal;
  readonly active: Set<ChildProcess>;
  readonly action: RuntimeHostPeerMeshManagementAction;
  readonly inputLine?: string;
}): Promise<Exclude<RuntimeHostPeerMeshManagementFrame, { kind: 'input' }>> {
  let result: Exclude<RuntimeHostPeerMeshManagementFrame, { kind: 'input' }> | undefined;
  let failure: Error | undefined;
  return runFramedProcess({
    ...input,
    prefix: RUNTIME_HOST_PEER_MESH_MANAGEMENT_FRAME_PREFIX,
    decode: decodeRuntimeHostPeerMeshManagementFrame,
    label: 'Local Runtime Host Peer Mesh management',
    onFrame(frame) {
      if (frame.action !== input.action) {
        failure = new Error('Local Runtime Host Peer Mesh management returned an unrelated result');
      } else if (frame.kind !== 'input') {
        if (result) {
          failure = new Error('Local Runtime Host Peer Mesh management returned multiple results');
        } else {
          result = frame;
        }
      }
    },
    result: () => result,
    failure: () => failure,
    acceptNonzeroResult: true,
    pendingMaxBytes: RUNTIME_HOST_PEER_MESH_MANAGEMENT_FRAME_MAX_BYTES,
  });
}

function combinedSignal(
  operation: AbortSignal | undefined,
  closing: AbortSignal,
): AbortSignal {
  return operation ? AbortSignal.any([operation, closing]) : closing;
}

function resolveLocalSetupPackage(
  setupPackage: DesktopRuntimeHostSetupPackage,
): { readonly specifier: string; readonly integrity?: string } {
  if (setupPackage.kind === 'npm') {
    return { specifier: setupPackage.specifier };
  }
  return { specifier: setupPackage.path, integrity: setupPackage.integrity };
}

function managedTargetArgs(target: DesktopRuntimeHostLocalServiceTarget): string[] {
  return [
    '--expected-service-id',
    target.serviceId,
    '--expected-root-path',
    target.rootPath,
    '--expected-root-id',
    target.rootId,
    ...(target.deploymentId
      ? ['--expected-deployment-id', target.deploymentId]
      : []),
  ];
}

function runSingleFrameProcess<Frame>(input: {
  readonly command: DesktopRuntimeHostLocalSetupCommand;
  readonly prefix: string;
  readonly decode: (line: string) => Frame | undefined;
  readonly label: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly spawnProcess: typeof spawn;
  readonly timeoutMs: number;
  readonly terminate: typeof terminateChildProcessTree;
  readonly signal?: AbortSignal;
  readonly active: Set<ChildProcess>;
  readonly inputLine?: string;
}): Promise<Frame> {
  let result: Frame | undefined;
  let failure: Error | undefined;
  return runFramedProcess({
    ...input,
    onFrame(frame) {
      if (result) failure = new Error(`${input.label} returned multiple results`);
      else result = frame;
    },
    result: () => result,
    failure: () => failure,
    acceptNonzeroResult: true,
  });
}

function runExitProcess(input: {
  readonly command: DesktopRuntimeHostLocalSetupCommand;
  readonly label: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly spawnProcess: typeof spawn;
  readonly timeoutMs: number;
  readonly terminate: typeof terminateChildProcessTree;
  readonly signal?: AbortSignal;
  readonly active: Set<ChildProcess>;
}): Promise<void> {
  return runFramedProcess<never, true>({
    ...input,
    prefix: 'MAKA_UNUSED_FRAME ',
    decode: () => undefined,
    onFrame: () => undefined,
    result: () => true,
    failure: () => undefined,
  }).then(() => undefined);
}

function runSetupProcess(input: {
  readonly command: DesktopRuntimeHostLocalSetupCommand;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly spawnProcess: typeof spawn;
  readonly timeoutMs: number;
  readonly terminate: typeof terminateChildProcessTree;
  readonly signal?: AbortSignal;
  readonly onProgress: (frame: Extract<RuntimeHostSetupFrame, { kind: 'progress' }>) => void;
  readonly active: Set<ChildProcess>;
}): Promise<RuntimeHostSetupCompleteFrame> {
  let complete: RuntimeHostSetupCompleteFrame | undefined;
  let failure: Error | undefined;
  return runFramedProcess({
    ...input,
    prefix: RUNTIME_HOST_SETUP_FRAME_PREFIX,
    decode: decodeRuntimeHostSetupFrame,
    label: 'Local Maka setup',
    onFrame(frame) {
      if (frame.kind === 'progress') input.onProgress(frame);
      else if (frame.kind === 'error') failure = new Error(frame.error.message);
      else if (complete) failure = new Error('Local Maka setup returned multiple results');
      else complete = frame;
    },
    result: () => complete,
    failure: () => failure,
  });
}

function runFramedProcess<Frame, Result>(input: {
  readonly command: DesktopRuntimeHostLocalSetupCommand;
  readonly cwd?: string;
  readonly prefix: string;
  readonly decode: (line: string) => Frame | undefined;
  readonly label: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly spawnProcess: typeof spawn;
  readonly timeoutMs: number;
  readonly terminate: typeof terminateChildProcessTree;
  readonly signal?: AbortSignal;
  readonly active: Set<ChildProcess>;
  readonly onFrame: (frame: Frame) => void;
  readonly result: () => Result | undefined;
  readonly failure: () => Error | undefined;
  readonly acceptNonzeroResult?: boolean;
  readonly inputLine?: string;
  readonly pendingMaxBytes?: number;
}): Promise<Result> {
  input.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = input.spawnProcess(input.command.executable, [...input.command.args], {
      ...(input.cwd ? { cwd: input.cwd } : {}),
      detached: process.platform !== 'win32',
      env: input.environment,
      stdio: [input.inputLine === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    input.active.add(child);
    if (input.inputLine !== undefined) child.stdin?.end(`${input.inputLine}\n`);
    let filterFailure: Error | undefined;
    let stopFailure: Error | undefined;
    let stderr = '';
    let settled = false;
    const filter = createRuntimeHostFramedOutputFilter({
      prefix: input.prefix,
      pendingMaxBytes: input.pendingMaxBytes ?? SETUP_FRAME_PENDING_MAX,
      decode: input.decode,
      label: input.label,
      onFrame: (frame) => {
        try {
          input.onFrame(frame);
        } catch (error) {
          filterFailure = error instanceof Error ? error : new Error(String(error));
        }
      },
      onError: (error) => {
        filterFailure = error;
      },
    });
    const cleanup = () => {
      clearTimeout(timeout);
      input.signal?.removeEventListener('abort', onAbort);
      input.active.delete(child);
    };
    const finish = (result: Result | undefined, error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(result!);
    };
    const stop = (error: Error) => {
      if (stopFailure) return;
      stopFailure = error;
      void stopProcess(child, input.terminate).then(
        () => finish(undefined, error),
        (stopError) => finish(undefined, new AggregateError([error, stopError])),
      );
    };
    const onAbort = () => stop(abortError(input.signal));
    const timeout = setTimeout(() => stop(new Error(`${input.label} timed out`)), input.timeoutMs);
    input.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (chunk: Buffer) => filter.push(chunk.toString('utf8')));
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = appendBounded(stderr, chunk.toString('utf8'), STDERR_MAX_BYTES);
    });
    child.once('error', (error) => {
      if (!stopFailure) finish(undefined, error);
    });
    child.once('close', (code, signal) => {
      if (stopFailure) return;
      filter.finish();
      const failure = filterFailure ?? input.failure();
      if (failure) return finish(undefined, failure);
      const result = input.result();
      if (result && (code === 0 || input.acceptNonzeroResult)) return finish(result);
      const status = code === null ? signal ?? 'an unknown status' : `code ${code}`;
      const detail = redactSecrets(stderr.trim()).slice(-2_000);
      finish(
        undefined,
        new Error(
          detail
            ? `${input.label} exited with ${status}: ${detail}`
            : result
              ? `${input.label} exited with ${status}`
              : `${input.label} ended without a result (${status})`,
        ),
      );
    });
    if (input.signal?.aborted) onAbort();
  });
}

async function stopProcess(
  child: ChildProcess,
  terminate: typeof terminateChildProcessTree,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await terminate(child, 'SIGTERM');
  if (await exitsWithin(child, DEFAULT_PROCESS_TERMINATION_GRACE_MS)) return;
  await terminate(child, 'SIGKILL');
  if (!(await exitsWithin(child, DEFAULT_PROCESS_TERMINATION_GRACE_MS))) {
    throw new Error('Local Runtime Host operator did not exit after forced termination');
  }
}

function exitsWithin(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.removeListener('close', onClose);
      resolve(false);
    }, timeoutMs);
    const onClose = () => {
      clearTimeout(timeout);
      resolve(true);
    };
    child.once('close', onClose);
  });
}

function appendBounded(current: string, chunk: string, maxBytes: number): string {
  const next = current + chunk;
  const encoded = Buffer.from(next);
  return encoded.byteLength <= maxBytes
    ? next
    : encoded.subarray(encoded.byteLength - maxBytes).toString('utf8');
}

function abortError(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error('Local Maka setup was cancelled');
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
