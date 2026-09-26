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

import { createHash, randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import type { ShellRunSnapshotResult, ShellRunUpdate, ToolResultContent } from '@maka/core/events';
import { isActiveShellRunStatus } from '@maka/core/shell-run';
import { shellRunStateProjection } from '@maka/core/shell-run-result';
import {
  type BackgroundTaskStopper,
  type PtyControlWriter,
  type PtyHandoffController,
  type RuntimeResourceReader,
  type ShellRunBashInput,
  type ShellRunPtySnapshot,
  type ShellRunWriteInput,
  ShellRunPtyControlClosedError,
  isShellRunResourceRef,
} from '@maka/runtime/shell-run-contract';
import { type ShellRunLauncher } from '@maka/runtime/shell-tools';
import { defaultShellPlan, ShellPreferenceError, type ShellPlan } from '@maka/runtime/shell-detect';
import { isSessionNotFoundError } from '@maka/storage/execution-stores';
import {
  decodeRuntimeResourceControllerAcquireResult,
  decodeRuntimeResourceControllerControlResult,
  decodeRuntimeResourceQueryResult,
  decodeRuntimeResourceStopResult,
  decodeRuntimeResourceStartResult,
  RUNTIME_RESOURCE_CONTROLLER_ACQUIRE_RESULT_MAX_BYTES,
  RUNTIME_RESOURCE_MAX_CONTROL_SEQUENCE,
  type OperationOutcome,
  type RuntimeResourceControllerAcquireInput,
  type RuntimeResourceControllerControlInput,
  type RuntimeResourceControllerReleaseInput,
  type RuntimeResourceControllerReleaseResult,
  type RuntimeResourcePtyControl,
  type RuntimeResourceQueryInput,
  type RuntimeResourceQueryResult,
  type RuntimeResourceRevision,
  type RuntimeResourceStopInput,
  type RuntimeResourceStartInput,
  type RuntimeResourceHandoffInput,
  type RuntimeResourceHandoffResult,
} from '../protocol/index.js';
import type { HostInteractionCoordinator } from './interaction-coordinator.js';
import type { MakaToolContext } from '@maka/runtime/tool-runtime';
import type { RuntimeHostResidency } from './host-kernel.js';
import type {
  ConnectionContext,
  RuntimeResourceOperationHandlerMap,
} from './operation-dispatcher.js';
import type { RuntimeHostAccessAuthority } from './access-authority.js';
import { boundedFailureDiagnostic } from './failure-diagnostic.js';
import { SessionAdmissionGate } from './session-admission-gate.js';
import {
  boundedRuntimeResourceState,
  canonicalRuntimeResources,
  createRuntimeResourcePage,
  runtimeResourceRevision,
} from './runtime-resource-projection.js';

const MAX_CONTROL_REPLAYS = 128;

interface RuntimeResourceSessionReader {
  listShellRunUpdates(sessionId: string): Promise<ShellRunUpdate[]>;
  getShellRunUpdate(sessionId: string, ref: string): Promise<ShellRunUpdate | null>;
}

interface RuntimeResourceHeaderReader {
  readHeader(sessionId: string): Promise<{
    readonly cwd: string;
    readonly isArchived: boolean;
  }>;
}

interface RuntimeResourceManager
  extends ShellRunLauncher,
    RuntimeResourceReader,
    BackgroundTaskStopper,
    PtyControlWriter {
  getLivePtySnapshot(sessionId: string, ref: string): ShellRunPtySnapshot | null;
  inspectResource(sessionId: string, ref: string): Promise<ShellRunSnapshotResult>;
  terminateAll(): Promise<void>;
}

export interface HostRuntimeResourceCoordinatorInput {
  readonly humanControl?: PtyHandoffController;
  readonly interactionAuthority?: () => Pick<
    HostInteractionCoordinator,
    'requestTerminalHandoff' | 'closeTerminalHandoff'
  >;
  readonly manager: RuntimeResourceManager;
  readonly sessions: RuntimeResourceSessionReader;
  readonly sessionHeaders: RuntimeResourceHeaderReader;
  readonly sessionAdmission: SessionAdmissionGate;
  readonly acquireResidency: () => RuntimeHostResidency;
  readonly requestDrain: () => void;
  readonly sessionAccessAuthority?: Pick<RuntimeHostAccessAuthority, 'activeSessionGrant'>;
  readonly onProjectionChanged?: (update: ShellRunUpdate) => void;
  /**
   * Fallback shell resolution for callers that do not carry a plan (e.g.
   * integrated terminal launches, which capture their plan at launch). A
   * caller-supplied plan — the turn's admission-time resolution — always
   * wins, so a mid-turn settings change cannot split guidance from execution.
   */
  readonly resolveShell?: () => Promise<ShellPlan> | ShellPlan;
}

interface ControllerState {
  readonly connectionId: string;
  readonly controllerId: string;
  nextSequence: number;
}

interface ControlReplay {
  readonly connectionId: string;
  readonly controllerId: string;
  readonly resourceKey: string;
  readonly sequence: number;
  readonly digest: string;
  readonly result: ReturnType<typeof decodeRuntimeResourceControllerControlResult>;
}

interface TerminalHandoffState {
  readonly message: string;
  command: string;
  readonly sessionId: string;
  readonly ref: string;
  readonly requestId: string;
  phase: RuntimeResourceHandoffResult['phase'];
  connectionId?: string;
  controllerId?: string;
  nextSequence: number;
  lastReceipt?: { sequence: number; status: 'written' | 'outcome_unknown' };
  readonly lifetime: AbortController;
}

/** Owns Host Shell/PTY tools plus the connection-scoped Client controller fence. */
export class HostRuntimeResourceCoordinator
  implements ShellRunLauncher, RuntimeResourceReader, BackgroundTaskStopper, PtyControlWriter
{
  readonly handlers: RuntimeResourceOperationHandlerMap = {
    'runtime.resource.handoff': (input, context) => this.#handoffControl(input, context),
    'runtime.resource.query': (input, context) => this.#query(input, context),
    'runtime.resource.start': (input) => this.#start(input),
    'runtime.resource.controller.acquire': (input, context) => this.#acquire(input, context),
    'runtime.resource.controller.control': (input, context) => this.#control(input, context),
    'runtime.resource.controller.release': (input, context) => this.#release(input, context),
    'runtime.resource.stop': (input) => this.#stop(input),
  };

  readonly #manager: RuntimeResourceManager;
  readonly #sessions: RuntimeResourceSessionReader;
  readonly #sessionHeaders: RuntimeResourceHeaderReader;
  readonly #sessionAdmission: SessionAdmissionGate;
  readonly #acquireResidency: () => RuntimeHostResidency;
  readonly #requestDrain: () => void;
  readonly #sessionAccessAuthority:
    | Pick<RuntimeHostAccessAuthority, 'activeSessionGrant'>
    | undefined;
  readonly #onProjectionChanged: (update: ShellRunUpdate) => void;
  readonly #resolveShell: () => Promise<ShellPlan> | ShellPlan;
  readonly #resourceQueue = new ResourceSerialQueue();
  readonly #controllers = new Map<string, ControllerState>();
  readonly #controllerResources = new Map<string, string>();
  readonly #controlReplays = new Map<string, ControlReplay>();
  readonly #handoffs = new Map<string, TerminalHandoffState>();
  readonly #inputEpochs = new Map<string, number>();
  readonly #humanSurfaces = new Map<string, string>();
  readonly #humanControl: PtyHandoffController | undefined;
  readonly #interactionAuthority: HostRuntimeResourceCoordinatorInput['interactionAuthority'];
  #draining = false;
  #termination: Promise<void> | undefined;

  constructor(input: HostRuntimeResourceCoordinatorInput) {
    this.#humanControl = input.humanControl;
    this.#interactionAuthority = input.interactionAuthority;
    this.#manager = input.manager;
    this.#sessions = input.sessions;
    this.#sessionHeaders = input.sessionHeaders;
    this.#sessionAdmission = input.sessionAdmission;
    this.#acquireResidency = input.acquireResidency;
    this.#requestDrain = input.requestDrain;
    this.#sessionAccessAuthority = input.sessionAccessAuthority;
    this.#onProjectionChanged = input.onProjectionChanged ?? (() => undefined);
    this.#resolveShell = input.resolveShell ?? defaultShellPlan;
  }

  async runForegroundBash(
    input: ShellRunBashInput,
  ): Promise<Awaited<ReturnType<ShellRunLauncher['runForegroundBash']>>> {
    if (this.#draining) throw new Error('Runtime resources are draining');
    const residency = this.#acquireResidency();
    try {
      const { execution } = await this.#sessionAdmission.run(input.sessionId, async () => {
        if (this.#draining) throw new Error('Runtime resources are draining');
        await this.#assertActiveSession(input.sessionId);
        if (this.#draining) throw new Error('Runtime resources are draining');
        const shell = input.shell ?? (await this.#resolveShell());
        if (this.#draining) throw new Error('Runtime resources are draining');
        return { execution: this.#manager.runForegroundBash({ ...input, shell }) };
      });
      return await execution;
    } finally {
      residency.release();
    }
  }

  async runBackgroundBash(
    input: ShellRunBashInput,
  ): Promise<Awaited<ReturnType<ShellRunLauncher['runBackgroundBash']>>> {
    if (this.#draining) throw new Error('Runtime resources are draining');
    const residency = this.#acquireResidency();
    let completed = false;
    const complete = (outcome: { successful: boolean }) => {
      if (completed) return;
      completed = true;
      try {
        input.onCompletion?.(outcome);
      } finally {
        residency.release();
      }
    };
    try {
      return await this.#sessionAdmission.run(input.sessionId, async () => {
        if (this.#draining) throw new Error('Runtime resources are draining');
        await this.#assertActiveSession(input.sessionId);
        if (this.#draining) throw new Error('Runtime resources are draining');
        const shell = input.shell ?? (await this.#resolveShell());
        if (this.#draining) throw new Error('Runtime resources are draining');
        return this.#manager.runBackgroundBash({ ...input, shell, onCompletion: complete });
      });
    } catch (error) {
      complete({ successful: false });
      throw error;
    }
  }

  readRuntimeResource(
    sessionId: string,
    ref: string,
    abortSignal: AbortSignal,
  ): Promise<ToolResultContent> {
    return this.#sessionAdmission.run(sessionId, () =>
      this.#manager.readRuntimeResource(sessionId, ref, abortSignal),
    );
  }

  stopBackgroundTask(
    sessionId: string,
    ref: string,
    abortSignal: AbortSignal,
  ): Promise<ToolResultContent> {
    return this.#sessionAdmission.run(sessionId, () =>
      this.#resourceQueue.run(resourceKey(sessionId, ref), async () => {
        const result = await this.#manager.stopBackgroundTask(sessionId, ref, abortSignal);
        this.#releaseControllerIfTerminal(sessionId, ref, result);
        return result;
      }),
    );
  }

  writeStdin(input: ShellRunWriteInput): ReturnType<PtyControlWriter['writeStdin']> {
    const key = resourceKey(input.sessionId, input.ref);
    const epoch = this.#inputEpochs.get(key) ?? 0;
    if (
      this.#handoffs.get(key)?.phase === 'human' ||
      this.#handoffs.get(key)?.phase === 'waiting'
    ) {
      return Promise.reject(new Error('This terminal is awaiting explicit human completion'));
    }
    return this.#sessionAdmission.run(input.sessionId, () =>
      this.#resourceQueue.run(resourceKey(input.sessionId, input.ref), async () => {
        if ((this.#inputEpochs.get(key) ?? 0) !== epoch)
          throw new Error('Terminal input expired across a human handoff');
        if (this.#controllers.has(resourceKey(input.sessionId, input.ref))) {
          throw new Error('This PTY is controlled by a connected Client');
        }
        const result = await this.#manager.writeStdin(input);
        this.#releaseControllerIfTerminal(input.sessionId, input.ref, result);
        return result;
      }),
    );
  }

  isHandoffAvailable(sessionId: string): boolean {
    return (
      !this.#draining &&
      process.platform !== 'win32' &&
      Boolean(
        this.#humanControl && this.#interactionAuthority && this.#humanSurfaces.has(sessionId),
      )
    );
  }

  async requestHandoff(ref: string, message: string, ctx: MakaToolContext): Promise<string> {
    if (!this.isHandoffAvailable(ctx.sessionId) || !ctx.runId) {
      throw new Error(
        'Interactive terminal handoff is unavailable. Open this task in a connected Desktop window.',
      );
    }
    const key = resourceKey(ctx.sessionId, ref);
    const state: TerminalHandoffState = {
      message,
      command: '',
      sessionId: ctx.sessionId,
      ref,
      requestId: randomUUID(),
      phase: 'waiting',
      nextSequence: 1,
      lifetime: new AbortController(),
    };
    await this.#sessionAdmission.run(ctx.sessionId, async () => {
      await this.#assertActiveSession(ctx.sessionId);
      // Validate model visibility before installing a fence or any failure cleanup.
      // Client inspection alone also accepts user-owned terminals.
      await this.#manager.readRuntimeResource(ctx.sessionId, ref, ctx.abortSignal);
      const previous = this.#handoffs.get(key);
      if (previous && previous.phase !== 'resumed' && previous.phase !== 'closed')
        throw new Error('Terminal handoff is already pending');
      const resource = await this.#manager.inspectResource(ctx.sessionId, ref);
      state.command = Array.from(resource.cmd).slice(0, 1_024).join('');
      if (resource.mode !== 'pty' || !isActiveShellRunStatus(resource.status))
        throw new Error('Handoff requires the original live PTY');
      const controller = this.#controllers.get(key);
      if (controller && controller.connectionId !== this.#humanSurfaces.get(ctx.sessionId))
        throw new Error('Terminal is controlled by another client');
      this.#inputEpochs.set(key, (this.#inputEpochs.get(key) ?? 0) + 1);
      this.#releaseController(key);
      this.#handoffs.set(key, state);
    });
    const authority = this.#interactionAuthority!();
    const abort = () => {
      state.lifetime.abort();
      void authority
        .closeTerminalHandoff(ctx.sessionId, state.requestId)
        .catch(() => this.#requestDrain());
    };
    ctx.abortSignal.addEventListener('abort', abort, { once: true });
    // Bound only readiness, never the time a person needs to authenticate.
    const readyDeadline = setTimeout(() => {
      if (state.phase === 'waiting') abort();
    }, 30_000);
    readyDeadline.unref();
    try {
      const signal = AbortSignal.any([
        ctx.abortSignal,
        state.lifetime.signal,
        AbortSignal.timeout(5_000),
      ]);
      await this.#resourceQueue.run(key, () =>
        this.#humanControl!.preparePtyHandoff(ctx.sessionId, ref, signal),
      );
      if (!this.isHandoffAvailable(ctx.sessionId) || ctx.abortSignal.aborted)
        throw new Error('Interactive terminal surface disappeared before handoff');
      const outcome = await authority.requestTerminalHandoff({
        signal: state.lifetime.signal,
        sessionId: ctx.sessionId,
        runId: ctx.runId,
        turnId: ctx.turnId,
        requestId: state.requestId,
        request: { kind: 'terminal_handoff', toolUseId: ctx.toolCallId, ref, message },
        canAnswer: (action, connectionId, controllerId) =>
          action === 'cancel' ||
          (state.phase === 'human' &&
            state.connectionId === connectionId &&
            state.controllerId === controllerId &&
            state.lastReceipt?.status !== 'outcome_unknown'),
        apply: async (action) => {
          await this.#resourceQueue.run(key, async () => {
            if (this.#handoffs.get(key) !== state || state.phase === 'closed') return;
            if (action === 'resume') {
              // A child can exit while its final input fence is draining. That
              // closes this handoff; it is not an Interaction-store failure.
              const live = await this.#humanControl!.resumePtyHandoff(ctx.sessionId, ref).catch(
                () => false,
              );
              state.phase = live ? 'resumed' : 'closed';
              this.#inputEpochs.set(key, (this.#inputEpochs.get(key) ?? 0) + 1);
              if (!live) {
                state.lifetime.abort();
                await this.#manager.stopBackgroundTask(
                  ctx.sessionId,
                  ref,
                  new AbortController().signal,
                  'model',
                );
              }
            } else {
              state.phase = 'closed';
              state.lifetime.abort();
              await this.#manager.stopBackgroundTask(
                ctx.sessionId,
                ref,
                new AbortController().signal,
                'client',
              );
            }
          });
        },
      });
      return JSON.stringify({
        ref,
        outcome:
          outcome.kind === 'terminal_handoff_answer' &&
          outcome.action === 'resume' &&
          state.phase === 'resumed'
            ? 'resumed'
            : 'closed',
        outputVisibility: 'private',
        instruction:
          state.phase === 'resumed'
            ? 'The user explicitly pressed Resume. You control this same terminal again and may execute the next requested command under existing permissions. Do not wait for a second Resume. This does not prove authentication succeeded. Output stays private; ask the user to review and share a new observation before relying on it. After the user shares, use Read on this ref to retrieve the published observation.'
            : 'The handoff closed without returning control. Do not retry credentials or recreate the original terminal.',
      });
    } catch (error) {
      state.phase = 'closed';
      state.lifetime.abort();
      // Failure after admission must not leave a secretly writable half-handoff.
      await this.#manager
        .stopBackgroundTask(ctx.sessionId, ref, new AbortController().signal, 'model')
        .catch(() => {});
      throw error;
    } finally {
      clearTimeout(readyDeadline);
      ctx.abortSignal.removeEventListener('abort', abort);
    }
  }

  async #handoffControl(
    input: RuntimeResourceHandoffInput,
    context: ConnectionContext,
  ): Promise<OperationOutcome<'runtime.resource.handoff'>> {
    try {
      const failure = await this.#mutableSessionFailure(input.sessionId);
      if (failure) return mutationFailure('runtime.resource.handoff', failure);
      if (input.action === 'lookup') {
        const handoff = this.#handoffs.get(resourceKey(input.sessionId, input.ref));
        return {
          ok: true,
          result: {
            status: handoff ? 'available' : 'unavailable',
            phase: handoff?.phase ?? 'closed',
            nextSequence: handoff?.nextSequence ?? 1,
            ...(handoff
              ? {
                  request: {
                    requestId: handoff.requestId,
                    ref: handoff.ref,
                    message: handoff.message,
                    command: handoff.command,
                  },
                }
              : {}),
          },
        };
      }
      if (input.action === 'surface') {
        if (input.available) this.#humanSurfaces.set(input.sessionId, context.connectionId);
        else if (this.#humanSurfaces.get(input.sessionId) === context.connectionId)
          this.#humanSurfaces.delete(input.sessionId);
        return {
          ok: true,
          result: {
            status: this.isHandoffAvailable(input.sessionId) ? 'available' : 'unavailable',
            phase: 'waiting',
            nextSequence: 1,
          },
        };
      }
      const state = [...this.#handoffs.values()].find(
        (entry) => entry.sessionId === input.sessionId && entry.requestId === input.requestId,
      );
      if (!state || !this.#humanControl || state.phase === 'closed')
        throw new Error('Original terminal handoff is no longer live');
      return await this.#resourceQueue.run(resourceKey(state.sessionId, state.ref), async () => {
        const result = (
          status: RuntimeResourceHandoffResult['status'],
        ): RuntimeResourceHandoffResult => ({
          status: state.lastReceipt?.status === 'outcome_unknown' ? 'outcome_unknown' : status,
          phase: state.phase,
          nextSequence: state.nextSequence,
        });
        if (input.action === 'ready') {
          if (this.#humanSurfaces.get(input.sessionId) !== context.connectionId)
            throw new Error('No interactive terminal surface on this connection');
          // A renderer reload keeps the Desktop's authenticated Host connection.
          // Reclaiming from that connection fences the old card identity.
          if (state.connectionId && state.connectionId !== context.connectionId)
            throw new Error('Terminal handoff belongs to another controller');
          state.connectionId = context.connectionId;
          state.controllerId = input.controllerId;
          if (state.phase === 'waiting') state.phase = 'human';
          return { ok: true as const, result: result('ready') };
        }
        if (
          state.connectionId !== context.connectionId ||
          state.controllerId !== input.controllerId
        )
          throw new Error('Terminal handoff controller expired');
        if (input.action === 'release') {
          delete state.connectionId;
          delete state.controllerId;
          return { ok: true as const, result: result('observed') };
        }
        if (input.action === 'observe') {
          const display = await this.#humanControl!.readPrivatePtySnapshot(
            state.sessionId,
            state.ref,
          );
          return {
            ok: true as const,
            result: {
              ...result('observed'),
              display: { ...display, text: Array.from(display.text).slice(-12_000).join('') },
            },
          };
        }
        if (input.action === 'share') {
          if (state.phase !== 'resumed') throw new Error('Resume before sharing a new observation');
          await this.#humanControl!.sharePrivatePtyObservation(
            state.sessionId,
            state.ref,
            input.sequence,
            input.text,
          );
          return { ok: true as const, result: result('shared') };
        }
        if (input.action !== 'input' || state.phase !== 'human')
          throw new Error('Terminal is not accepting private input');
        if (state.lastReceipt?.sequence === input.sequence)
          return { ok: true as const, result: result(state.lastReceipt.status) };
        if (state.lastReceipt?.status === 'outcome_unknown')
          throw new Error('Resolve unknown input delivery by stopping this terminal');
        if (input.sequence !== state.nextSequence)
          throw new Error('Private input sequence expired');
        if (!input.input || /[\x00-\x1f\x7f]/.test(input.input))
          throw new Error('Enter one line without embedded control characters');
        state.nextSequence++;
        state.lastReceipt = { sequence: input.sequence, status: 'outcome_unknown' };
        try {
          await this.#humanControl!.writePrivatePtyInput(
            state.sessionId,
            state.ref,
            `${input.input}\r`,
            AbortSignal.any([state.lifetime.signal, AbortSignal.timeout(5_000)]),
          );
          state.lastReceipt.status = 'written';
        } catch {
          // Never echo input, retry it, or call a partial delivery "not sent".
        }
        return { ok: true as const, result: result(state.lastReceipt.status) };
      });
    } catch {
      return mutationFailure('runtime.resource.handoff', {
        code: 'operation_conflict',
        message:
          'Terminal handoff is unavailable, stale, or no longer accepts this operation. Reconnect to the original task and inspect its live terminal.',
      });
    }
  }

  observeShellRunUpdate(update: ShellRunUpdate): void {
    if (!isActiveShellRunStatus(update.result.status)) {
      const key = resourceKey(update.sessionId, update.result.ref);
      this.#inputEpochs.delete(key);
      const handoff = this.#handoffs.get(key);
      if (handoff) {
        handoff.phase = 'closed';
        handoff.lifetime.abort();
        this.#handoffs.delete(key);
        void this.#interactionAuthority?.()
          .closeTerminalHandoff(handoff.sessionId, handoff.requestId)
          .catch(() => this.#requestDrain());
      }
      this.#releaseController(resourceKey(update.sessionId, update.result.ref));
    }
    this.#onProjectionChanged(update);
  }

  releaseConnection(connectionId: string): void {
    for (const [sessionId, connection] of this.#humanSurfaces) {
      if (connection === connectionId) this.#humanSurfaces.delete(sessionId);
    }
    for (const handoff of this.#handoffs.values()) {
      if (handoff.connectionId === connectionId) {
        delete handoff.connectionId;
        delete handoff.controllerId;
      }
    }
    for (const [key, controller] of this.#controllers) {
      if (controller.connectionId === connectionId) this.#releaseController(key);
    }
    for (const [key, replay] of this.#controlReplays) {
      if (replay.connectionId === connectionId) this.#controlReplays.delete(key);
    }
  }

  beginDrain(): void {
    if (this.#draining) return;
    this.#draining = true;
    for (const handoff of this.#handoffs.values()) handoff.lifetime.abort();
    this.#humanSurfaces.clear();
    this.#controllers.clear();
    this.#controllerResources.clear();
    this.#controlReplays.clear();
    this.#termination = this.#manager.terminateAll();
  }

  async close(): Promise<void> {
    this.beginDrain();
    await this.#termination;
  }

  async hasLiveSessionResources(sessionId: string): Promise<boolean> {
    const updates = await this.#sessions.listShellRunUpdates(sessionId);
    return updates.some((update) => isActiveShellRunStatus(update.result.status));
  }

  async #query(
    input: RuntimeResourceQueryInput,
    context: ConnectionContext,
  ): Promise<OperationOutcome<'runtime.resource.query'>> {
    if (input.kind === 'get' && !isShellRunResourceRef(input.ref)) {
      return queryFailure('invalid_request', 'Runtime Resource ref is unsupported');
    }
    const guestGrantId = this.#guestObservationGrantId(context, input.sessionId);
    if (context.principalKind === 'session_guest' && !guestGrantId) {
      return queryFailure('not_found', 'Session was not found');
    }
    const outcome: OperationOutcome<'runtime.resource.query'> = await this.#sessionAdmission.run(
      input.sessionId,
      async () => {
        try {
          await this.#sessionHeaders.readHeader(input.sessionId);
        } catch (error) {
          if (isSessionNotFoundError(error)) {
            return queryFailure('not_found', 'Session was not found');
          }
          return this.#canonicalReadFailure(error, 'Session state is unavailable');
        }
        if (input.kind === 'get') {
          try {
            const resource = await this.#sessions.getShellRunUpdate(input.sessionId, input.ref);
            const visible =
              context.principalKind !== 'session_guest' || resource?.sessionId === input.sessionId
                ? resource
                : null;
            const canonical = visible ? (canonicalRuntimeResources([visible])[0] ?? null) : null;
            return {
              ok: true,
              result: decodeRuntimeResourceQueryResult({
                kind: 'resource',
                sessionId: input.sessionId,
                revision: runtimeResourceRevision(canonical ? [canonical] : []),
                resource: canonical,
              }),
            };
          } catch (error) {
            return this.#canonicalReadFailure(error, 'Runtime Resource state is unavailable');
          }
        }
        let updates: ShellRunUpdate[];
        try {
          updates = await this.#sessions.listShellRunUpdates(input.sessionId);
          if (context.principalKind === 'session_guest') {
            updates = updates.filter((update) => update.sessionId === input.sessionId);
          }
        } catch (error) {
          return this.#canonicalReadFailure(error, 'Runtime Resource state is unavailable');
        }
        try {
          const resources = canonicalRuntimeResources(updates);
          const revision = runtimeResourceRevision(resources);
          if (input.kind === 'list_continue' && input.revision !== revision) {
            return {
              ok: true,
              result: { kind: 'revision_changed', expected: input.revision, actual: revision },
            };
          }
          const offset = input.kind === 'list_start' ? 0 : decodeCursor(input.cursor);
          if (
            offset === undefined ||
            offset > resources.length ||
            (input.kind === 'list_continue' && offset === 0) ||
            (input.kind === 'list_continue' && offset === resources.length)
          ) {
            return queryFailure('invalid_request', 'Runtime Resource cursor is invalid');
          }
          return {
            ok: true,
            result: createRuntimeResourcePage(input.sessionId, revision, resources, offset),
          };
        } catch {
          return queryFailure('internal_failure', 'Runtime Resource projection is unavailable');
        }
      },
    );
    return guestGrantId && this.#guestObservationGrantId(context, input.sessionId) !== guestGrantId
      ? queryFailure('not_found', 'Session was not found')
      : outcome;
  }

  #canonicalReadFailure(
    error: unknown,
    message: string,
  ): OperationOutcome<'runtime.resource.query'> {
    console.error(
      `[runtime-host] canonical Runtime Resource read failed: ${boundedFailureDiagnostic(error)}`,
    );
    this.#requestDrain();
    return queryFailure('internal_failure', message);
  }

  #guestObservationGrantId(context: ConnectionContext, sessionId: string): string | undefined {
    if (context.principalKind !== 'session_guest') return;
    return this.#sessionAccessAuthority?.activeSessionGrant(
      context.principal,
      sessionId,
      'session_observation',
    )?.grantId;
  }

  async #start(
    input: RuntimeResourceStartInput,
  ): Promise<OperationOutcome<'runtime.resource.start'>> {
    const unavailable = await this.#mutableSessionFailure(input.sessionId);
    if (unavailable) return mutationFailure('runtime.resource.start', unavailable);
    try {
      // Header read, shell resolution, launch, and the initial snapshot all
      // share ONE admission section: a concurrent `session.workspace.relocate`
      // can otherwise commit between reading `header.cwd` and the admitted
      // launch, admitting the command with a stale cwd (#3210 review).
      return await this.#sessionAdmission.run(input.sessionId, async () => {
        if (this.#draining) throw new Error('Runtime resources are draining');
        const admittedUnavailable = await this.#mutableSessionFailure(input.sessionId);
        if (admittedUnavailable) {
          return mutationFailure('runtime.resource.start', admittedUnavailable);
        }
        const header = await this.#sessionHeaders.readHeader(input.sessionId);
        if (this.#draining) throw new Error('Runtime resources are draining');
        const shell = await this.#resolveShell();
        if (this.#draining) throw new Error('Runtime resources are draining');
        const env = { ...process.env };
        let command: string;
        if (input.command !== undefined) {
          command = input.command;
        } else if (shell.kind === 'git-bash') {
          env.SHELL = shell.exe;
          env.CHERE_INVOKING = '1';
          env.DISABLE_AUTO_UPDATE = 'true';
          env.DISABLE_UPDATE_PROMPT = 'true';
          command = 'exec "$SHELL" -l';
        } else if (shell.kind === 'legacy-wsl-bash') {
          env.DISABLE_AUTO_UPDATE = 'true';
          env.DISABLE_UPDATE_PROMPT = 'true';
          command = 'exec bash -l';
        } else if (shell.kind === 'posix') {
          env.SHELL ||=
            userInfo().shell || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh');
          env.DISABLE_AUTO_UPDATE = 'true';
          env.DISABLE_UPDATE_PROMPT = 'true';
          command = 'exec "$SHELL" -l';
        } else if (shell.kind === 'cmd') {
          command = '%ComSpec% /d /q';
        } else {
          const executable = (shell.exe ?? shell.displayName).replace(/'/g, "''");
          command = `& '${executable}' -NoLogo`;
        }
        const residency = this.#acquireResidency();
        let completed = false;
        const complete = (): void => {
          if (completed) return;
          completed = true;
          residency.release();
        };
        let launched: Awaited<ReturnType<ShellRunLauncher['runBackgroundBash']>>;
        try {
          launched = await this.#manager.runBackgroundBash({
            sessionId: input.sessionId,
            sourceTurnId: input.launchId,
            sourceToolCallId: input.launchId,
            // Only the one-shot `!<command>` resources this Client owns are
            // hidden from the model; the Desktop interactive login shell (no
            // `command`) keeps its prior model-visible visibility (#3210).
            ...(input.command === undefined ? {} : { visibility: 'user' as const }),
            cwd: header.cwd,
            command,
            env,
            pty: input.command === undefined,
            emitOutput: () => undefined,
            shell,
            onCompletion: complete,
          });
        } catch (launchError) {
          complete();
          throw launchError;
        }
        try {
          return {
            ok: true as const,
            result: decodeRuntimeResourceStartResult({
              resource: boundedRuntimeResourceState(shellRunStateProjection(launched)),
            }),
          };
        } catch (replyError) {
          // The command is already live but the operation must not report a
          // success it cannot honor: stop it so a client retry cannot
          // double-execute (#3210 review). Best-effort — the surfaced error
          // stays the reply failure.
          try {
            await this.#manager.stopBackgroundTask(
              input.sessionId,
              launched.ref,
              new AbortController().signal,
              'client',
            );
          } catch {
            /* keep the reply failure as the surfaced cause */
          }
          throw replyError;
        }
      });
    } catch (error) {
      if (error instanceof ShellPreferenceError) {
        return mutationFailure('runtime.resource.start', {
          code: 'invalid_request',
          message: error.message,
        });
      }
      return this.#resourceFailure('runtime.resource.start', error);
    }
  }

  #acquire(
    input: RuntimeResourceControllerAcquireInput,
    context: ConnectionContext,
  ): Promise<OperationOutcome<'runtime.resource.controller.acquire'>> {
    if (!isShellRunResourceRef(input.ref)) {
      return Promise.resolve(
        mutationFailure('runtime.resource.controller.acquire', {
          code: 'invalid_request',
          message: 'Runtime Resource ref is unsupported',
        }),
      );
    }
    return this.#sessionAdmission.run(input.sessionId, () =>
      this.#resourceQueue.run(resourceKey(input.sessionId, input.ref), async () => {
        const sessionFailure = await this.#mutableSessionFailure(input.sessionId);
        if (sessionFailure)
          return mutationFailure('runtime.resource.controller.acquire', sessionFailure);
        try {
          const pty = this.#manager.getLivePtySnapshot(input.sessionId, input.ref);
          if (!pty) {
            // No live handle: read through the manager so a stale active record
            // is repaired to orphaned; the reply is a conflict either way.
            await this.#manager.inspectResource(input.sessionId, input.ref);
            return mutationFailure('runtime.resource.controller.acquire', {
              code: 'operation_conflict',
              message: 'Only an active PTY Runtime Resource can be controlled',
            });
          }
          const key = resourceKey(input.sessionId, input.ref);
          if (this.#handoffs.has(key))
            return mutationFailure('runtime.resource.controller.acquire', {
              code: 'operation_conflict',
              message: 'Use this terminal’s private handoff surface',
            });
          const identity = controllerIdentity(context.connectionId, input.controllerId);
          const claimedResource = this.#controllerResources.get(identity);
          if (claimedResource && claimedResource !== key) {
            return mutationFailure('runtime.resource.controller.acquire', {
              code: 'operation_conflict',
              message: 'Controller identity is already bound to another Runtime Resource',
            });
          }
          const current = this.#controllers.get(key);
          if (
            current &&
            (current.connectionId !== context.connectionId ||
              current.controllerId !== input.controllerId)
          ) {
            return mutationFailure('runtime.resource.controller.acquire', {
              code: 'operation_conflict',
              message: 'Runtime Resource already has a connected controller',
            });
          }
          const controller = current ?? {
            connectionId: context.connectionId,
            controllerId: input.controllerId,
            nextSequence: 1,
          };
          this.#controllers.set(key, controller);
          this.#controllerResources.set(identity, key);
          return {
            ok: true,
            result: boundedControllerAcquireResult(
              controller.controllerId,
              controller.nextSequence,
              pty,
            ),
          };
        } catch (error) {
          return this.#resourceFailure('runtime.resource.controller.acquire', error);
        }
      }),
    );
  }

  #control(
    input: RuntimeResourceControllerControlInput,
    context: ConnectionContext,
  ): Promise<OperationOutcome<'runtime.resource.controller.control'>> {
    if (!isShellRunResourceRef(input.ref)) {
      return Promise.resolve(
        mutationFailure('runtime.resource.controller.control', {
          code: 'invalid_request',
          message: 'Runtime Resource ref is unsupported',
        }),
      );
    }
    return this.#sessionAdmission.run(input.sessionId, () =>
      this.#resourceQueue.run(resourceKey(input.sessionId, input.ref), async () => {
        const key = resourceKey(input.sessionId, input.ref);
        if (this.#handoffs.has(key))
          return mutationFailure('runtime.resource.controller.control', {
            code: 'operation_conflict',
            message: 'Use this terminal’s private handoff surface',
          });
        const digest = controlDigest(input.control);
        const replay = this.#controlReplays.get(controlReplayKey(context.connectionId, input));
        if (replay && replay.sequence === input.sequence) {
          return replay.digest === digest
            ? { ok: true, result: structuredClone(replay.result) }
            : mutationFailure('runtime.resource.controller.control', {
                code: 'operation_conflict',
                message: 'Controller sequence was retried with different input',
              });
        }
        const sessionFailure = await this.#mutableSessionFailure(input.sessionId);
        if (sessionFailure)
          return mutationFailure('runtime.resource.controller.control', sessionFailure);
        const controller = this.#controllers.get(key);
        if (
          !controller ||
          controller.connectionId !== context.connectionId ||
          controller.controllerId !== input.controllerId
        ) {
          return mutationFailure('runtime.resource.controller.control', {
            code: 'operation_conflict',
            message: 'Runtime Resource controller is not held by this connection',
          });
        }
        if (input.sequence !== controller.nextSequence) {
          return mutationFailure('runtime.resource.controller.control', {
            code: 'operation_conflict',
            message: 'Runtime Resource controller sequence is out of order',
          });
        }
        try {
          const controlled = await this.#manager.writeStdin({
            sessionId: input.sessionId,
            ref: input.ref,
            caller: 'client',
            ...controlWrite(input.control),
          });
          const result = decodeRuntimeResourceControllerControlResult({
            controllerId: input.controllerId,
            sequence: input.sequence,
          });
          this.#rememberReplay({
            connectionId: context.connectionId,
            controllerId: input.controllerId,
            resourceKey: key,
            sequence: input.sequence,
            digest,
            result,
          });
          if (controller.nextSequence === RUNTIME_RESOURCE_MAX_CONTROL_SEQUENCE) {
            this.#releaseController(key);
          } else {
            controller.nextSequence += 1;
            this.#releaseControllerIfTerminal(input.sessionId, input.ref, controlled);
          }
          return { ok: true, result };
        } catch (error) {
          if (error instanceof ShellRunPtyControlClosedError) {
            this.#releaseController(key);
            return mutationFailure('runtime.resource.controller.control', {
              code: 'operation_conflict',
              message: 'Runtime Resource PTY control is closed while the process is stopping',
            });
          }
          return this.#resourceFailure('runtime.resource.controller.control', error);
        }
      }),
    );
  }

  #release(
    input: RuntimeResourceControllerReleaseInput,
    context: ConnectionContext,
  ): Promise<OperationOutcome<'runtime.resource.controller.release'>> {
    if (!isShellRunResourceRef(input.ref)) {
      return Promise.resolve(
        mutationFailure('runtime.resource.controller.release', {
          code: 'invalid_request',
          message: 'Runtime Resource ref is unsupported',
        }),
      );
    }
    return this.#sessionAdmission.run(input.sessionId, () =>
      this.#resourceQueue.run(resourceKey(input.sessionId, input.ref), async () => {
        const key = resourceKey(input.sessionId, input.ref);
        const controller = this.#controllers.get(key);
        if (!controller) {
          return releaseSuccess(input.controllerId, false);
        }
        if (
          controller.connectionId !== context.connectionId ||
          controller.controllerId !== input.controllerId
        ) {
          return mutationFailure('runtime.resource.controller.release', {
            code: 'operation_conflict',
            message: 'Runtime Resource controller is held by another connection',
          });
        }
        this.#releaseController(key);
        this.#controlReplays.delete(controlReplayKey(context.connectionId, input));
        return releaseSuccess(input.controllerId, true);
      }),
    );
  }

  #stop(input: RuntimeResourceStopInput): Promise<OperationOutcome<'runtime.resource.stop'>> {
    if (!isShellRunResourceRef(input.ref)) {
      return Promise.resolve(
        mutationFailure('runtime.resource.stop', {
          code: 'invalid_request',
          message: 'Runtime Resource ref is unsupported',
        }),
      );
    }
    return this.#sessionAdmission.run(input.sessionId, () =>
      this.#resourceQueue.run(resourceKey(input.sessionId, input.ref), async () => {
        const sessionFailure = await this.#mutableSessionFailure(input.sessionId);
        if (sessionFailure) return mutationFailure('runtime.resource.stop', sessionFailure);
        try {
          const result = await this.#manager.stopBackgroundTask(
            input.sessionId,
            input.ref,
            new AbortController().signal,
            'client',
          );
          this.#releaseControllerIfTerminal(input.sessionId, input.ref, result);
          return { ok: true, result: decodeRuntimeResourceStopResult({}) };
        } catch (error) {
          return this.#resourceFailure('runtime.resource.stop', error);
        }
      }),
    );
  }

  async #assertActiveSession(sessionId: string): Promise<void> {
    const header = await this.#sessionHeaders.readHeader(sessionId);
    if (header.isArchived) {
      throw new Error('Session is archived');
    }
  }

  async #mutableSessionFailure(
    sessionId: string,
  ): Promise<
    { code: 'not_found' | 'session_archived' | 'internal_failure'; message: string } | undefined
  > {
    try {
      const header = await this.#sessionHeaders.readHeader(sessionId);
      return header.isArchived
        ? { code: 'session_archived', message: 'Session is archived' }
        : undefined;
    } catch (error) {
      if (isSessionNotFoundError(error)) {
        return { code: 'not_found', message: 'Session was not found' };
      }
      this.#requestDrain();
      return { code: 'internal_failure', message: 'Session state is unavailable' };
    }
  }

  #resourceFailure<
    K extends Exclude<keyof RuntimeResourceOperationHandlerMap, 'runtime.resource.query'>,
  >(operation: K, error: unknown): OperationOutcome<K> {
    if (isNotFoundError(error)) {
      return mutationFailure(operation, {
        code: 'not_found',
        message: 'Runtime Resource was not found in this Session',
      });
    }
    this.#requestDrain();
    return mutationFailure(operation, {
      code: 'internal_failure',
      message: 'Runtime Resource operation failed',
    });
  }

  #releaseControllerIfTerminal(sessionId: string, ref: string, result: ToolResultContent): void {
    if (result.kind === 'shell_run' && !isActiveShellRunStatus(result.status)) {
      this.#releaseController(resourceKey(sessionId, ref));
    }
  }

  #releaseController(key: string): void {
    const controller = this.#controllers.get(key);
    if (!controller) return;
    this.#controllers.delete(key);
    this.#controllerResources.delete(
      controllerIdentity(controller.connectionId, controller.controllerId),
    );
  }

  #rememberReplay(replay: ControlReplay): void {
    const key = controlReplayIdentity(replay.connectionId, replay.controllerId, replay.resourceKey);
    this.#controlReplays.delete(key);
    this.#controlReplays.set(key, structuredClone(replay));
    if (this.#controlReplays.size <= MAX_CONTROL_REPLAYS) return;
    const oldest = this.#controlReplays.keys().next().value;
    if (oldest !== undefined) this.#controlReplays.delete(oldest);
  }
}

function controlWrite(
  control: RuntimeResourcePtyControl,
): Pick<ShellRunWriteInput, 'input' | 'size'> {
  switch (control.kind) {
    case 'input':
      return { input: control.input };
    case 'resize':
      return { size: { cols: control.cols, rows: control.rows } };
    case 'input_and_resize':
      return { input: control.input, size: { cols: control.cols, rows: control.rows } };
  }
}

function boundedControllerAcquireResult(
  controllerId: string,
  nextSequence: number,
  snapshot: ShellRunPtySnapshot,
): ReturnType<typeof decodeRuntimeResourceControllerAcquireResult> {
  const pty = structuredClone(snapshot);
  let result = { controllerId, nextSequence, pty };
  while (
    Buffer.byteLength(JSON.stringify(result), 'utf8') >
    RUNTIME_RESOURCE_CONTROLLER_ACQUIRE_RESULT_MAX_BYTES
  ) {
    const codePoints = Array.from(pty.buffer);
    if (codePoints.length === 0) {
      throw new Error('Runtime Resource PTY metadata exceeds the wire limit');
    }
    pty.buffer = codePoints.slice(Math.ceil(codePoints.length / 2)).join('');
    result = { controllerId, nextSequence, pty };
  }
  return decodeRuntimeResourceControllerAcquireResult(result);
}

function decodeCursor(cursor: string): number | undefined {
  if (!/^(?:0|[1-9]\d*)$/.test(cursor)) return undefined;
  const offset = Number(cursor);
  return Number.isSafeInteger(offset) ? offset : undefined;
}

function resourceKey(sessionId: string, ref: string): string {
  return `${sessionId}\0${ref}`;
}

function controllerIdentity(connectionId: string, controllerId: string): string {
  return `${connectionId}\0${controllerId}`;
}

function controlReplayKey(
  connectionId: string,
  input: Pick<RuntimeResourceControllerControlInput, 'sessionId' | 'ref' | 'controllerId'>,
): string {
  return controlReplayIdentity(
    connectionId,
    input.controllerId,
    resourceKey(input.sessionId, input.ref),
  );
}

function controlReplayIdentity(connectionId: string, controllerId: string, key: string): string {
  return `${controllerIdentity(connectionId, controllerId)}\0${key}`;
}

function controlDigest(control: RuntimeResourcePtyControl): string {
  return createHash('sha256').update(JSON.stringify(control)).digest('hex');
}

function isNotFoundError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function queryFailure(
  code: Extract<OperationOutcome<'runtime.resource.query'>, { ok: false }>['error']['code'],
  message: string,
): OperationOutcome<'runtime.resource.query'> {
  return { ok: false, error: { code, message } };
}

function mutationFailure<
  K extends Exclude<keyof RuntimeResourceOperationHandlerMap, 'runtime.resource.query'>,
>(
  _operation: K,
  error: {
    code:
      | 'not_found'
      | 'session_archived'
      | 'operation_conflict'
      | 'invalid_request'
      | 'internal_failure';
    message: string;
  },
): OperationOutcome<K> {
  return { ok: false, error } as OperationOutcome<K>;
}

function releaseSuccess(
  controllerId: string,
  released: boolean,
): OperationOutcome<'runtime.resource.controller.release'> {
  const result: RuntimeResourceControllerReleaseResult = { controllerId, released };
  return { ok: true, result };
}

class ResourceSerialQueue {
  readonly #tails = new Map<string, Promise<void>>();

  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.#tails.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    }
  }
}
