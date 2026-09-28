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

import type { RuntimePolicySnapshot } from '@maka/core/runtime-policy';
import type {
  ExternalAgentSetupStart,
  ExternalAgentSetupProjection,
  OperationOutcome,
} from '../protocol/index.js';
import {
  OAUTH_PRESENTATION_SERVICE_ID,
  OAUTH_PRESENTATION_SERVICE_VERSION,
  decodeOAuthPresentationResult,
} from '../protocol/oauth.js';
import type {
  ConnectionContext,
  OperationHandlerMap,
  OperationResidency,
} from './operation-dispatcher.js';
import type { HostClientCapabilityCoordinator } from './client-capability-coordinator.js';
import { runAntigravitySetup } from './acp/antigravity.js';
import { AcpSetupError } from './acp/connection.js';

type Key =
  | 'external_agents.setup.start'
  | 'external_agents.setup.query'
  | 'external_agents.setup.cancel';
interface Attempt {
  projection: ExternalAgentSetupProjection;
  readonly owner: string;
  readonly abort: AbortController;
  done: Promise<void>;
}
export class HostExternalAgentSetupCoordinator {
  readonly handlers: Pick<OperationHandlerMap, Key> = {
    'external_agents.setup.start': (input, context) => this.start(input, context),
    'external_agents.setup.query': (input, context) => this.query(input.attemptId, context),
    'external_agents.setup.cancel': (input, context) => this.cancel(input.attemptId, context),
  };
  private readonly attempts = new Map<string, Attempt>();
  private active: Attempt | undefined;
  private draining = false;
  private gate: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly deps: {
      readPolicy(): Promise<RuntimePolicySnapshot>;
      onCleanupFailure(): void;
      acquireResidency(): OperationResidency;
      capabilities: Pick<HostClientCapabilityCoordinator, 'callService'>;
      install?(input: {
        signal: AbortSignal;
        onProgress(phase: 'downloading' | 'installing', percent: number): void;
      }): Promise<string>;
      run?: typeof runAntigravitySetup;
      platform?: string;
      arch?: string;
    },
  ) {}

  private start(
    input: ExternalAgentSetupStart,
    context: ConnectionContext,
  ): Promise<OperationOutcome<Key>> {
    const result = this.gate.then(async (): Promise<OperationOutcome<Key>> => {
      if (context.principalKind !== 'local_owner') return failure('unauthorized');
      if (this.draining) return failure('host_draining');
      const previous = this.attempts.get(input.attemptId);
      if (previous) {
        if (previous.owner !== context.connectionId) return failure('not_found');
        if (
          previous.projection.action !== input.action ||
          previous.projection.expectedExecutable !== input.expectedExecutable
        )
          return failure('operation_conflict');
        return { ok: true, result: previous.projection };
      }
      if (this.active) return failure('operation_conflict');
      if (
        (this.deps.platform ?? process.platform) !== 'darwin' ||
        (this.deps.arch ?? process.arch) !== 'arm64'
      )
        return failure('operation_unavailable');
      const snapshot = await this.deps.readPolicy();
      if (this.draining) return failure('host_draining');
      if (context.inputClosedSignal?.aborted) return failure('operation_unavailable');
      const executable = snapshot.policy.externalAgents.antigravity.executable;
      if ((input.action !== 'install' && !executable) || executable !== input.expectedExecutable)
        return failure('operation_conflict');
      if (input.action === 'install' && !this.deps.install) return failure('operation_unavailable');
      const attempt: Attempt = {
        projection: { ...input, phase: input.action === 'install' ? 'downloading' : 'connecting' },
        owner: context.connectionId,
        abort: new AbortController(),
        done: Promise.resolve(),
      };
      const residency = this.deps.acquireResidency();
      this.active = attempt;
      this.attempts.set(input.attemptId, attempt);
      attempt.done = this.run(attempt, executable, residency);
      return { ok: true, result: attempt.projection };
    });
    this.gate = result.catch(() => undefined);
    return result;
  }

  private async query(id: string, context: ConnectionContext): Promise<OperationOutcome<Key>> {
    const attempt = this.attempts.get(id);
    if (!attempt || attempt.owner !== context.connectionId) return failure('not_found');
    return { ok: true, result: attempt.projection };
  }
  private async cancel(id: string, context: ConnectionContext): Promise<OperationOutcome<Key>> {
    const attempt = this.attempts.get(id);
    if (!attempt || attempt.owner !== context.connectionId) return failure('not_found');
    this.cancelAttempt(attempt);
    return { ok: true, result: attempt.projection };
  }
  private cancelAttempt(attempt: Attempt): void {
    if (this.active !== attempt || attempt.abort.signal.aborted) return;
    attempt.projection = { ...attempt.projection, phase: 'cancelling' };
    attempt.abort.abort();
  }
  releaseConnection(connectionId: string): void {
    if (this.active?.owner === connectionId) this.cancelAttempt(this.active);
  }
  beginDrain(): void {
    this.draining = true;
    if (this.active) this.cancelAttempt(this.active);
  }
  async close(): Promise<void> {
    this.beginDrain();
    await this.gate;
    await this.active?.done;
  }
  private async run(
    attempt: Attempt,
    executable: string,
    residency: OperationResidency,
  ): Promise<void> {
    try {
      if (attempt.projection.action === 'install') {
        const installedExecutable = await this.deps.install!({
          signal: attempt.abort.signal,
          onProgress: (phase, downloadPercent) => {
            if (!attempt.abort.signal.aborted)
              attempt.projection = { ...attempt.projection, phase, downloadPercent };
          },
        });
        attempt.abort.signal.throwIfAborted();
        await (this.deps.run ?? runAntigravitySetup)({
          executable: installedExecutable,
          action: 'check',
          signal: attempt.abort.signal,
          onAuthorizationUrl: async () => {
            throw new AcpSetupError('authentication_unavailable');
          },
        });
        attempt.abort.signal.throwIfAborted();
        attempt.projection = { ...attempt.projection, phase: 'succeeded', installedExecutable };
        return;
      }
      await (this.deps.run ?? runAntigravitySetup)({
        executable,
        action: attempt.projection.action,
        signal: attempt.abort.signal,
        onAuthorizationUrl: async (url) => {
          attempt.abort.signal.throwIfAborted();
          attempt.projection = { ...attempt.projection, phase: 'awaiting_authorization' };
          try {
            const result = await this.deps.capabilities.callService({
              connectionId: attempt.owner,
              serviceId: OAUTH_PRESENTATION_SERVICE_ID,
              version: OAUTH_PRESENTATION_SERVICE_VERSION,
              method: 'open_external',
              input: { url, stateHint: attempt.projection.attemptId },
              signal: attempt.abort.signal,
            });
            decodeOAuthPresentationResult('open_external', result);
          } catch {
            throw new AcpSetupError('browser_failed');
          }
        },
      });
      attempt.projection = {
        ...attempt.projection,
        phase: attempt.abort.signal.aborted ? 'cancelled' : 'succeeded',
      };
    } catch (error) {
      const cleanupFailed = error instanceof AcpSetupError && error.failure === 'cleanup_failed';
      if (cleanupFailed) {
        this.draining = true;
        this.deps.onCleanupFailure();
      }
      attempt.projection =
        attempt.abort.signal.aborted && !cleanupFailed
          ? { ...attempt.projection, phase: 'cancelled' }
          : {
              ...attempt.projection,
              phase: 'failed',
              failure: error instanceof AcpSetupError ? error.failure : 'connection_failed',
            };
    } finally {
      this.active = undefined;
      residency.release();
      while (this.attempts.size > 32) this.attempts.delete(this.attempts.keys().next().value!);
    }
  }
}
function failure(
  code:
    | 'unauthorized'
    | 'host_draining'
    | 'not_found'
    | 'operation_conflict'
    | 'operation_unavailable',
): OperationOutcome<Key> {
  return { ok: false, error: { code, message: `External agent setup: ${code}` } };
}
