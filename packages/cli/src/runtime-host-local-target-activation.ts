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

import { spawn } from 'node:child_process';
import type { RuntimeHostLocalStagedDeployment } from './runtime-host-local-handoff.js';
import type { RuntimeHostUpdateCandidate } from './runtime-host-registry-update.js';

const TARGET_ACTIVATOR_SETTLEMENT_TIMEOUT_MS = 15_000;

export interface RuntimeHostTargetActivationInput {
  readonly rootPath: string;
  readonly rootId: string;
  readonly staged: RuntimeHostLocalStagedDeployment;
  readonly ownerInstallationId: string;
  readonly target: RuntimeHostUpdateCandidate;
  readonly takeoverHostEpoch?: string;
  readonly inheritableAuthorityLeaseFd: number;
}

export interface RuntimeHostTargetActivation {
  readonly kind: 'ready' | 'active_work' | 'operator_required';
  /** Asks the short-lived child to adjudicate the durable owner record. */
  settle(): Promise<void>;
}

export class RuntimeHostTargetActivationError extends Error {
  constructor(
    readonly code: 'recovery_required',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'RuntimeHostTargetActivationError';
  }
}

/**
 * Launches the exact staged target through its own release and keeps the
 * existing owner-authority lease in the activator until durable commit.
 */
export function launchRuntimeHostTargetActivator(
  input: RuntimeHostTargetActivationInput,
  options: { readonly settlementTimeoutMs?: number } = {},
): Promise<RuntimeHostTargetActivation> {
  const args = [
    input.staged.cliPath,
    'runtime-host',
    'local-update-activate',
    '--root',
    input.rootPath,
    '--expected-root-id',
    input.rootId,
    '--generation',
    input.staged.launchGeneration,
    '--candidate-entrypoint',
    input.staged.candidateEntrypoint,
    '--await-coordinator-commit',
    'true',
    '--expected-owner-installation-id',
    input.ownerInstallationId,
    '--target-version',
    input.target.version,
    '--target-integrity',
    input.target.integrity,
    ...(input.takeoverHostEpoch ? ['--takeover-host-epoch', input.takeoverHostEpoch] : []),
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      // fd 3 is the coordinator channel; fd 4 is the inherited authority
      // lease. The activator, not the long-lived target, owns that lease.
      stdio: ['inherit', 'inherit', 'inherit', 'ipc', input.inheritableAuthorityLeaseFd],
      windowsHide: false,
    });
    let ready = false;
    let settled = false;
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolveClosed) => {
        child.once('close', (code, signal) => resolveClosed({ code, signal }));
      },
    );
    const closeError = async (): Promise<never> => {
      const { code, signal } = await closed;
      if (signal) throw new Error(`Maka target activator exited on ${signal}`);
      if (code === 3) throw new Error('The activated Runtime Host still owns active work');
      if (code === 4) throw new Error('The observed Runtime Host requires its operator');
      throw new Error('The exact Maka target could not be activated');
    };
    const settle = async (): Promise<void> => {
      if (settled) return;
      settled = true;
      let settlementTimedOut = false;
      // This parent owns the activator process and therefore the hard bound.
      // Killing and then awaiting close releases its inherited lease even when
      // an individual authority read in the child never settles.
      const settlementTimer = setTimeout(() => {
        settlementTimedOut = true;
        child.kill('SIGKILL');
      }, options.settlementTimeoutMs ?? TARGET_ACTIVATOR_SETTLEMENT_TIMEOUT_MS);
      settlementTimer.unref();
      if (child.connected) {
        try {
          child.send({ kind: 'settle' });
        } catch {
          // The close result below remains the only settlement evidence.
        }
      }
      try {
        const exited = await closed;
        if (settlementTimedOut) {
          throw new RuntimeHostTargetActivationError(
            'recovery_required',
            'The local Runtime Host update requires recovery because its target activator exceeded the durable settlement deadline',
          );
        }
        if (!exited.signal && exited.code === 0) return;
        throw new RuntimeHostTargetActivationError(
          'recovery_required',
          exited.signal
            ? `The local Runtime Host update requires recovery because its target activator exited on ${exited.signal}`
            : 'The local Runtime Host update requires recovery because its target activator could not confirm durable ownership',
        );
      } finally {
        clearTimeout(settlementTimer);
      }
    };
    child.once('error', reject);
    child.on('message', (message: unknown) => {
      if (ready || !isTargetActivatorReadyMessage(message)) return;
      ready = true;
      resolve({ kind: 'ready', settle });
    });
    void closed.then(({ code, signal }) => {
      if (ready) return;
      if (signal) {
        reject(new Error(`Maka target activator exited on ${signal}`));
      } else if (code === 3) {
        resolve({ kind: 'active_work', settle: async () => undefined });
      } else if (code === 4) {
        resolve({ kind: 'operator_required', settle: async () => undefined });
      } else {
        void closeError().catch(reject);
      }
    });
  });
}

function isTargetActivatorReadyMessage(value: unknown): value is { readonly kind: 'ready' } {
  return (
    typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'ready'
  );
}
