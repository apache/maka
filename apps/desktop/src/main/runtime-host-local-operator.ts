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
import { mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { redactSecrets } from '@maka/core/redaction';
import {
  DEFAULT_PROCESS_TERMINATION_GRACE_MS,
  terminateChildProcessTree,
} from '@maka/runtime/process-tree-terminator';
import {
  decodeRuntimeHostPeerManagementFrame,
  decodeRuntimeHostServiceManagementFrame,
  decodeRuntimeHostSetupFrame,
  RUNTIME_HOST_PEER_MANAGEMENT_FRAME_PREFIX,
  RUNTIME_HOST_SERVICE_MANAGEMENT_FRAME_PREFIX,
  RUNTIME_HOST_SETUP_FRAME_PREFIX,
  type RuntimeHostPeerManagementFrame,
  type RuntimeHostServiceManagementFrame,
  type RuntimeHostSetupFrame,
} from '@maka/runtime-host/operator';
import { createRuntimeHostFramedOutputFilter } from './runtime-host-framed-output.js';
import {
  isExactRuntimeHostSetupPackageSpecifier,
  type DesktopRuntimeHostSetupPackage,
} from './runtime-host-ssh-terminal.js';

const SETUP_TIMEOUT_MS = 10 * 60_000;
const SETUP_FRAME_PENDING_MAX = 20 * 1024;
const STDERR_MAX_BYTES = 64 * 1024;

type RuntimeHostSetupCompleteFrame = Extract<RuntimeHostSetupFrame, { kind: 'complete' }>;

export interface DesktopRuntimeHostLocalServiceTarget {
  readonly serviceId: string;
  readonly rootPath: string;
  readonly rootId: string;
}

export interface DesktopRuntimeHostLocalSetupInput {
  readonly setupPackage: DesktopRuntimeHostSetupPackage;
  readonly clientDataRoot: string;
  readonly rootPath: string;
  readonly principalId: string;
  readonly projectDirectoryRoots?: readonly { readonly label: string; readonly path: string }[];
  readonly coordinationRelays?: readonly string[];
  readonly signal?: AbortSignal;
}

export interface DesktopRuntimeHostLocalSetupCommand {
  readonly executable: string;
  readonly args: readonly string[];
}

export function runtimeHostLocalSetupCommand(input: {
  readonly packageSpecifier: string;
  readonly clientDataRoot: string;
  readonly rootPath: string;
  readonly principalId: string;
  readonly projectDirectoryRoots?: readonly { readonly label: string; readonly path: string }[];
  readonly coordinationRelays?: readonly string[];
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
      '--enable-direct-peer',
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
    readonly operatorPath: string;
    readonly action: 'enable' | 'disable' | 'status';
    readonly target: DesktopRuntimeHostLocalServiceTarget;
    readonly coordinationRelays?: readonly string[];
    readonly signal?: AbortSignal;
  }): Promise<RuntimeHostPeerManagementFrame>;
  runService(input: {
    readonly operatorPath: string;
    readonly action: 'status' | 'retire' | 'uninstall';
    readonly target: DesktopRuntimeHostLocalServiceTarget;
    readonly allowInterruptActiveTasks?: boolean;
    readonly signal?: AbortSignal;
  }): Promise<RuntimeHostServiceManagementFrame>;
  close(): Promise<void>;
} {
  const active = new Set<ChildProcess>();
  let closed = false;
  const terminate = input.terminateProcess ?? terminateChildProcessTree;

  return {
    async runSetup(setup, onProgress) {
      if (closed) throw new Error('Local Runtime Host operator is closed');
      setup.signal?.throwIfAborted();
      const packageSpecifier = await resolveLocalSetupPackage(setup.setupPackage);
      const command = runtimeHostLocalSetupCommand({ ...setup, packageSpecifier });
      const workingDirectory = await mkdtemp(join(tmpdir(), 'maka-runtime-host-local-setup-'));
      try {
        return await runSetupProcess({
          command,
          cwd: workingDirectory,
          environment: input.environment ?? process.env,
          spawnProcess: input.spawnProcess ?? spawn,
          timeoutMs: input.setupTimeoutMs ?? SETUP_TIMEOUT_MS,
          terminate,
          signal: setup.signal,
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
        command: {
          executable: command.operatorPath,
          args: [
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
            ...managedTargetArgs(command.target),
          ],
        },
        prefix: RUNTIME_HOST_PEER_MANAGEMENT_FRAME_PREFIX,
        decode: decodeRuntimeHostPeerManagementFrame,
        label: 'Local Runtime Host peer management',
        environment: input.environment ?? process.env,
        spawnProcess: input.spawnProcess ?? spawn,
        timeoutMs: input.setupTimeoutMs ?? SETUP_TIMEOUT_MS,
        terminate,
        signal: command.signal,
        active,
      });
    },
    runService(command) {
      if (closed) throw new Error('Local Runtime Host operator is closed');
      return runSingleFrameProcess({
        command: {
          executable: command.operatorPath,
          args: [
            command.action,
            '--framed',
            ...(command.allowInterruptActiveTasks ? ['--allow-interrupt-active-tasks'] : []),
            ...managedTargetArgs(command.target),
          ],
        },
        prefix: RUNTIME_HOST_SERVICE_MANAGEMENT_FRAME_PREFIX,
        decode: decodeRuntimeHostServiceManagementFrame,
        label: 'Local Runtime Host service management',
        environment: input.environment ?? process.env,
        spawnProcess: input.spawnProcess ?? spawn,
        timeoutMs: input.setupTimeoutMs ?? SETUP_TIMEOUT_MS,
        terminate,
        signal: command.signal,
        active,
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      await Promise.allSettled([...active].map((child) => stopProcess(child, terminate)));
    },
  };
}

async function resolveLocalSetupPackage(
  setupPackage: DesktopRuntimeHostSetupPackage,
): Promise<string> {
  if (setupPackage.kind === 'npm') {
    if (!isExactRuntimeHostSetupPackageSpecifier(setupPackage.specifier)) {
      throw new Error('Runtime Host setup package is invalid');
    }
    return setupPackage.specifier;
  }
  const archive = await realpath(setupPackage.path);
  if (!(await stat(archive)).isFile() || !archive.endsWith('.tgz')) {
    throw new Error('Runtime Host development package must be a .tgz file');
  }
  return archive;
}

function managedTargetArgs(target: DesktopRuntimeHostLocalServiceTarget): string[] {
  return [
    '--expected-service-id',
    target.serviceId,
    '--expected-root-path',
    target.rootPath,
    '--expected-root-id',
    target.rootId,
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
}): Promise<Frame> {
  input.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = input.spawnProcess(input.command.executable, [...input.command.args], {
      detached: process.platform !== 'win32',
      env: input.environment,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    input.active.add(child);
    let result: Frame | undefined;
    let failure: Error | undefined;
    let stderr = '';
    let settled = false;
    const filter = createRuntimeHostFramedOutputFilter({
      prefix: input.prefix,
      pendingMaxBytes: SETUP_FRAME_PENDING_MAX,
      decode: input.decode,
      label: input.label,
      onFrame: (frame) => {
        if (result) failure = new Error(`${input.label} returned multiple results`);
        else result = frame;
      },
      onError: (error) => {
        failure = error;
      },
    });
    const cleanup = () => {
      clearTimeout(timeout);
      input.signal?.removeEventListener('abort', onAbort);
      input.active.delete(child);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(result!);
    };
    const stop = (error: Error) => {
      void stopProcess(child, input.terminate).then(
        () => finish(error),
        (stopError) => finish(new AggregateError([error, stopError])),
      );
    };
    const onAbort = () => stop(abortError(input.signal));
    const timeout = setTimeout(() => stop(new Error(`${input.label} timed out`)), input.timeoutMs);
    input.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (chunk: Buffer) => filter.push(chunk.toString('utf8')));
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = appendBounded(stderr, chunk.toString('utf8'), STDERR_MAX_BYTES);
    });
    child.once('error', (error) => finish(error));
    child.once('close', (code, signal) => {
      filter.finish();
      if (failure) return finish(failure);
      if (result) return finish();
      const status = code === null ? signal ?? 'an unknown status' : `code ${code}`;
      const detail = redactSecrets(stderr.trim()).slice(-2_000);
      finish(
        new Error(
          detail
            ? `${input.label} exited with ${status}: ${detail}`
            : `${input.label} exited with ${status}`,
        ),
      );
    });
    if (input.signal?.aborted) onAbort();
  });
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
  return new Promise((resolve, reject) => {
    const child = input.spawnProcess(input.command.executable, [...input.command.args], {
      cwd: input.cwd,
      detached: process.platform !== 'win32',
      env: input.environment,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    input.active.add(child);
    let complete: RuntimeHostSetupCompleteFrame | undefined;
    let failure: Error | undefined;
    let stderr = '';
    let settled = false;
    const filter = createRuntimeHostFramedOutputFilter({
      prefix: RUNTIME_HOST_SETUP_FRAME_PREFIX,
      pendingMaxBytes: SETUP_FRAME_PENDING_MAX,
      decode: decodeRuntimeHostSetupFrame,
      label: 'Local Maka setup',
      onFrame: (frame) => {
        if (frame.kind === 'progress') input.onProgress(frame);
        else if (frame.kind === 'error') failure = new Error(frame.error.message);
        else if (complete) failure = new Error('Local Maka setup returned multiple results');
        else complete = frame;
      },
      onError: (error) => {
        failure = error;
      },
    });
    const cleanup = () => {
      clearTimeout(timeout);
      input.signal?.removeEventListener('abort', onAbort);
      input.active.delete(child);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(complete!);
    };
    const stop = (error: Error) => {
      void stopProcess(child, input.terminate).then(() => finish(error), finish);
    };
    const onAbort = () => stop(abortError(input.signal));
    const timeout = setTimeout(
      () => stop(new Error('Local Maka setup timed out')),
      input.timeoutMs,
    );
    input.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (chunk: Buffer) => {
      filter.push(chunk.toString('utf8'));
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = appendBounded(stderr, chunk.toString('utf8'), STDERR_MAX_BYTES);
    });
    child.once('error', (error) => finish(error));
    child.once('close', (code, signal) => {
      filter.finish();
      if (failure) return finish(failure);
      if (complete && code === 0) return finish();
      const status = code === null ? signal ?? 'an unknown status' : `code ${code}`;
      const detail = redactSecrets(stderr.trim()).slice(-2_000);
      finish(
        new Error(
          complete
            ? `Local Maka setup exited with ${status}`
            : detail
              ? `Local Maka setup exited with ${status}: ${detail}`
              : `Local Maka setup ended without a completion result (${status})`,
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
