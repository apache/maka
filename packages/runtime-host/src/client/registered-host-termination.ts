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

import { terminateProcessTree } from '@maka/runtime/process-tree-terminator';
import {
  prepareStorageRootControlDirectory,
  resolveStorageRoot,
} from '@maka/storage/root-authority';
import { readHostRegistration } from '../control/registration.js';
import type { HostRegistration } from '../protocol/index.js';
import {
  readRuntimeHostProcessIdentity,
  type RuntimeHostProcessIdentity,
} from './process-identity.js';

const TERMINATION_SETTLE_MS = 2_000;

export interface RegisteredRuntimeHostIdentity {
  readonly rootPath: string;
  readonly rootId: string;
  readonly hostEpoch: string;
  readonly pid: number;
}

interface RuntimeHostExitDependencies {
  readonly isProcessAlive: (pid: number) => boolean;
  readonly settleMs: number;
}

interface RegisteredRuntimeHostTerminationDependencies extends RuntimeHostExitDependencies {
  readonly terminateProcess: typeof terminateProcessTree;
}

export interface ObservedRegisteredRuntimeHostTerminationAuthority {
  readonly processIdentity: RuntimeHostProcessIdentity;
  readonly isCurrent: () => boolean;
}

export interface ObservedRegisteredRuntimeHost {
  readonly rootPath: string;
  readonly registration: HostRegistration;
}

interface ObservedRegisteredRuntimeHostTerminationDependencies extends RuntimeHostExitDependencies {
  readonly readProcessIdentity: typeof readRuntimeHostProcessIdentity;
  readonly readRegistration: typeof readHostRegistration;
  readonly signalProcess: (pid: number) => boolean;
}

const defaultDependencies: RegisteredRuntimeHostTerminationDependencies = {
  terminateProcess: terminateProcessTree,
  isProcessAlive,
  settleMs: TERMINATION_SETTLE_MS,
};

const defaultObservedDependencies: ObservedRegisteredRuntimeHostTerminationDependencies = {
  isProcessAlive,
  readProcessIdentity: readRuntimeHostProcessIdentity,
  readRegistration: readHostRegistration,
  signalProcess: forceKillProcess,
  settleMs: TERMINATION_SETTLE_MS,
};

/**
 * Force-terminates only the exact local ephemeral Host still registered for
 * the expected State Root. Callers must reserve this for explicit recovery
 * and keep their authorization current until the signal is sent.
 */
export function forceTerminateRegisteredRuntimeHost(
  identity: RegisteredRuntimeHostIdentity,
  stillOwnsProcess: () => boolean,
): Promise<boolean> {
  return forceTerminateRegisteredRuntimeHostWithDependencies(
    identity,
    stillOwnsProcess,
    defaultDependencies,
  );
}

export async function forceTerminateRegisteredRuntimeHostWithDependencies(
  identity: RegisteredRuntimeHostIdentity,
  stillOwnsProcess: () => boolean,
  dependencies: RegisteredRuntimeHostTerminationDependencies,
): Promise<boolean> {
  if (!stillOwnsProcess()) return false;
  const capability = await resolveStorageRoot({ path: identity.rootPath, kind: 'interactive' });
  if (capability.rootId !== identity.rootId) return false;
  const { controlDirectory } = await prepareStorageRootControlDirectory(capability);
  const registered = await readHostRegistration(controlDirectory);
  if (!registered) return true;
  if (!matchesIdentity(registered, identity)) return false;
  if (!dependencies.isProcessAlive(identity.pid)) return true;

  let signalTarget: HostRegistration | undefined = registered;
  const signaled = await dependencies.terminateProcess({
    pid: identity.pid,
    signal: 'SIGKILL',
    hasExited: () => !dependencies.isProcessAlive(identity.pid),
    beforeSignal: async () => {
      // This runs after asynchronous process-tree discovery and immediately
      // before the OS signal, so neither a successor nor a reused PID can
      // inherit stale intent.
      signalTarget = await readHostRegistration(controlDirectory);
      return matchesIdentity(signalTarget, identity) && stillOwnsProcess();
    },
    fallback: () => {
      try {
        process.kill(identity.pid, 'SIGKILL');
        return true;
      } catch {
        return false;
      }
    },
  });
  if (!signalTarget) return true;
  if (!matchesIdentity(signalTarget, identity)) return false;
  if (!signaled && dependencies.isProcessAlive(identity.pid)) return false;
  return waitForExit(identity.pid, dependencies);
}

/**
 * Stops an ephemeral Host that Desktop did not launch in this process. Unlike
 * the owned-process path above, its authority is limited to the exact root PID
 * whose OS process lifetime was observed across a valid handshake.
 */
export function forceTerminateObservedRegisteredRuntimeHost(
  observed: ObservedRegisteredRuntimeHost,
  authority: ObservedRegisteredRuntimeHostTerminationAuthority,
): Promise<boolean> {
  return forceTerminateObservedRegisteredRuntimeHostWithDependencies(
    observed,
    authority,
    defaultObservedDependencies,
  );
}

export async function forceTerminateObservedRegisteredRuntimeHostWithDependencies(
  observed: ObservedRegisteredRuntimeHost,
  authority: ObservedRegisteredRuntimeHostTerminationAuthority,
  dependencies: ObservedRegisteredRuntimeHostTerminationDependencies,
): Promise<boolean> {
  const { registration } = observed;
  if (
    registration.lifecycleMode !== 'ephemeral' ||
    !authority.isCurrent() ||
    authority.processIdentity.startIdentity.length === 0
  ) {
    return false;
  }
  const capability = await resolveStorageRoot({ path: observed.rootPath, kind: 'interactive' });
  if (capability.rootId !== registration.rootId) return false;
  const { controlDirectory } = await prepareStorageRootControlDirectory(capability);
  const signalTarget = await dependencies.readRegistration(controlDirectory);
  if (!signalTarget) return true;
  if (!matchesObservedRegistration(signalTarget, registration) || !authority.isCurrent()) {
    return false;
  }
  if (!dependencies.isProcessAlive(registration.pid)) return true;
  const processIdentity = await dependencies.readProcessIdentity(registration.pid);
  if (
    processIdentity?.startIdentity !== authority.processIdentity.startIdentity ||
    !authority.isCurrent()
  ) {
    return false;
  }
  const signaled = dependencies.signalProcess(registration.pid);
  if (!signaled && dependencies.isProcessAlive(registration.pid)) return false;
  return waitForExit(registration.pid, dependencies);
}

function matchesObservedRegistration(
  current: HostRegistration,
  observed: HostRegistration,
): boolean {
  return (
    current.rootId === observed.rootId &&
    current.hostEpoch === observed.hostEpoch &&
    current.pid === observed.pid &&
    current.lifecycleMode === observed.lifecycleMode &&
    current.createdAt === observed.createdAt
  );
}

function matchesIdentity(
  registration: HostRegistration | undefined,
  identity: RegisteredRuntimeHostIdentity,
): boolean {
  return (
    registration?.rootId === identity.rootId &&
    registration.hostEpoch === identity.hostEpoch &&
    registration.pid === identity.pid &&
    registration.lifecycleMode === 'ephemeral'
  );
}

async function waitForExit(
  pid: number,
  dependencies: RuntimeHostExitDependencies,
): Promise<boolean> {
  const deadline = Date.now() + dependencies.settleMs;
  while (dependencies.isProcessAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  return true;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ESRCH'
    );
  }
}

function forceKillProcess(pid: number): boolean {
  try {
    process.kill(pid, 'SIGKILL');
    return true;
  } catch {
    return false;
  }
}
