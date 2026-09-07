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

import { randomUUID } from 'node:crypto';
import { isHostActivityIdle, type HostActivitySnapshot } from '../protocol/host-status.js';
import type { RuntimeHostRetirementMode } from './host-retirement.js';
import { RuntimeHostPermanentReconnectError } from './reconnect-lifecycle.js';
import { formatHostHandoff } from './host-handoff-copy.js';
import { redactSecrets } from '@maka/core/redaction';

export type HostHandoffAction = 'cancel' | 'retry' | 'interrupt';
export type HostHandoffPhase =
  | 'checking'
  | 'staging'
  | 'pausing'
  | 'retiring'
  | 'replacing'
  | 'verifying';

export interface HostHandoffTarget {
  readonly name: string;
  readonly location: 'local' | 'remote';
  readonly rootId?: string;
  readonly hostEpoch?: string;
}

/** An owner adapter binds this capability to its exact observed deployment/process lifetime.
 * It must revalidate that identity and fence admission inside the existing transaction.
 * Neither a Surface choice nor this in-memory coordinator grants mutation authority.
 */
export interface HostHandoffReplacement {
  readonly kind: 'replace' | 'repair';
  readonly canReplaceIdle: boolean;
  readonly canInterrupt: boolean;
  execute(
    policy: RuntimeHostRetirementMode,
    progress: (phase: HostHandoffPhase) => void,
    consent: 'automatic' | 'explicit',
    signal?: AbortSignal,
  ): Promise<HostHandoffReplacementResult>;
}

export type HostHandoffReplacementResult =
  | { readonly kind: 'completed' | 'active_work' | 'changed' }
  | { readonly kind: 'recovery_required'; readonly diagnostic: string };

export interface HostHandoffBlocker {
  /** Includes all authority evidence that invalidates consent when it changes. */
  readonly identity: string;
  readonly target: HostHandoffTarget;
  readonly reason: 'upgrade' | 'repair' | 'unavailable';
  readonly activity?: HostActivitySnapshot;
  readonly mayExitNaturally: boolean;
  readonly replacement?: HostHandoffReplacement;
  readonly operatorStep?: string;
  readonly diagnostic?: string;
}

export type HostHandoffObservation<T> =
  | { readonly kind: 'ready'; readonly value: T }
  | { readonly kind: 'blocked'; readonly blocker: HostHandoffBlocker };

/** Data-only projection. A Surface cannot supply policy, a target, or a transaction. */
export interface HostHandoffView {
  readonly revision: string;
  readonly target: HostHandoffTarget;
  readonly state: 'attention' | 'progress';
  readonly reason:
    | 'busy'
    | 'activity_unknown'
    | 'operator_required'
    | 'repair_required'
    | 'retry_required';
  readonly activity?: HostActivitySnapshot;
  readonly mayExitNaturally: boolean;
  readonly operation?: 'replace' | 'repair';
  readonly phase?: HostHandoffPhase;
  readonly actions: readonly HostHandoffAction[];
  readonly defaultAction: 'cancel';
  readonly operatorStep?: string;
  readonly diagnostic?: string;
}

export interface HostHandoffSurface {
  update(view: HostHandoffView): void;
  close(): void;
}

export type OpenHostHandoffSurface = (
  submit: (revision: string, action: HostHandoffAction) => void,
) => HostHandoffSurface;

export class HostHandoffCancelledError extends RuntimeHostPermanentReconnectError {
  readonly code = 'runtime_host_handoff_cancelled';
  constructor() {
    super('Runtime Host handoff was cancelled');
    this.name = 'HostHandoffCancelledError';
  }
}

/** Noninteractive callers receive the same decision instead of prompting or silently stopping work. */
export class HostHandoffRequiredError extends RuntimeHostPermanentReconnectError {
  readonly code = 'runtime_host_handoff_required';
  constructor(readonly view: HostHandoffView) {
    const copy = formatHostHandoff(view, 'en');
    super([copy.title, copy.description, copy.detail, view.diagnostic].filter(Boolean).join('\n'));
    this.name = 'HostHandoffRequiredError';
  }
}

/** One live attempt; persisted deployment transactions remain the sole recovery authority. */
export async function runHostHandoff<T extends { close(): Promise<void> }>(input: {
  observe(signal?: AbortSignal): Promise<HostHandoffObservation<T>>;
  openSurface?: OpenHostHandoffSurface;
  signal?: AbortSignal;
  pollIntervalMs?: number;
}): Promise<T> {
  const interval = input.pollIntervalMs ?? 1_000;
  if (!Number.isFinite(interval) || interval <= 0)
    throw new RangeError('Invalid handoff observation interval');
  let surface: HostHandoffSurface | undefined;
  let view: HostHandoffView | undefined;
  let signature: string | undefined;
  let choice: { revision: string; action: HostHandoffAction } | undefined;
  let wake: (() => void) | undefined;
  let attemptAbort: AbortController | undefined;
  let cancelled = false;
  // Admission can refuse an apparently idle snapshot. Do not turn that race
  // (or a broken successor) into an automatic replacement storm.
  const attempted = new Set<string>();
  let automaticAttempts = 0;
  let recovery: { identity: string; diagnostic: string } | undefined;
  const publish = (next: HostHandoffView) => {
    view = next;
    surface?.update(next);
  };
  const submit = (revision: string, action: HostHandoffAction) => {
    if (!view || revision !== view.revision || !view.actions.includes(action)) return;
    if (view.state === 'progress') {
      if (action !== 'cancel' || cancelled) return;
      cancelled = true;
      attemptAbort?.abort(new HostHandoffCancelledError());
      publish({ ...view, revision: randomUUID(), actions: [] });
      return;
    }
    if (choice) return;
    choice = { revision, action };
    wake?.();
  };
  try {
    for (;;) {
      input.signal?.throwIfAborted();
      if (cancelled) throw new HostHandoffCancelledError();
      if (choice?.action === 'cancel') throw new HostHandoffCancelledError();
      // Every action, including an explicit interruption, gets a fresh observation.
      // Final identity/admission fencing is still the mutation adapter's responsibility.
      let observed: HostHandoffObservation<T>;
      try {
        observed = await input.observe(input.signal);
      } catch (error) {
        input.signal?.throwIfAborted();
        if (!view) throw error;
        // Lost observation is not permission to reuse the last mutation capability.
        // Keep this journey visible and retry without chaining a fatal dialog.
        observed = {
          kind: 'blocked',
          blocker: {
            identity: JSON.stringify(['unavailable', view.target]),
            target: view.target,
            reason: 'unavailable',
            mayExitNaturally: false,
            diagnostic: boundedDiagnostic(error),
          },
        };
      }
      if (observed.kind === 'ready') {
        if (
          input.signal?.aborted ||
          (choice as { action: HostHandoffAction } | undefined)?.action === 'cancel'
        ) {
          await observed.value.close();
          input.signal?.throwIfAborted();
          throw new HostHandoffCancelledError();
        }
        return observed.value;
      }
      input.signal?.throwIfAborted();
      // Cancellation belongs to the attempt, not to the observed Host. A new
      // epoch or newly idle snapshot must not erase a click made during observe.
      if ((choice as { action: HostHandoffAction } | undefined)?.action === 'cancel') {
        throw new HostHandoffCancelledError();
      }
      const blocker = observed.blocker;
      if (recovery?.identity !== blocker.identity) recovery = undefined;
      const nextSignature = blockerSignature(blocker);
      if (signature !== nextSignature) {
        signature = nextSignature;
        choice = undefined;
        publish(projectBlocker(blocker, randomUUID(), recovery?.diagnostic));
      }
      const current = view!;
      const selected = choice as { revision: string; action: HostHandoffAction } | undefined;
      choice = undefined;
      if (selected?.action === 'cancel') throw new HostHandoffCancelledError();
      const cooperative =
        blocker.target.location === 'local' &&
        blocker.activity?.cooperativeHandoff === true &&
        blocker.activity.connections === 0 &&
        blocker.activity.activeOperations === 0;
      const automatic =
        !recovery &&
        automaticAttempts < 3 &&
        !attempted.has(nextSignature) &&
        blocker.replacement?.canReplaceIdle &&
        blocker.activity &&
        (isHostActivityIdle(blocker.activity) || cooperative);
      const interrupt = selected?.revision === current.revision && selected.action === 'interrupt';
      const retry = selected?.revision === current.revision && selected.action === 'retry';
      if (
        (automatic || interrupt || (retry && blocker.replacement?.canReplaceIdle)) &&
        blocker.replacement
      ) {
        if (automatic) {
          attempted.add(nextSignature);
          automaticAttempts += 1;
        }
        attemptAbort = new AbortController();
        const operationSignal = input.signal
          ? AbortSignal.any([input.signal, attemptAbort.signal])
          : attemptAbort.signal;
        const progress = (phase: HostHandoffPhase) =>
          publish({
            ...current,
            revision: randomUUID(),
            state: 'progress',
            phase: cooperative && !interrupt && phase === 'retiring' ? 'pausing' : phase,
            actions: cancelled ? [] : ['cancel'],
          });
        if (input.openSurface) surface ??= input.openSurface(submit);
        progress(cooperative && !interrupt ? 'pausing' : 'checking');
        // Do not abandon an irreversible cutover when the Surface closes. Its
        // transaction settles (or persists recovery) before cancellation is observed.
        let result: HostHandoffReplacementResult;
        try {
          result = await blocker.replacement.execute(
            interrupt ? 'interrupt_active_work' : 'refuse_active_work',
            progress,
            automatic && !retry && !interrupt ? 'automatic' : 'explicit',
            operationSignal,
          );
        } catch (error) {
          result = { kind: 'recovery_required', diagnostic: boundedDiagnostic(error) };
        } finally {
          attemptAbort = undefined;
        }
        recovery =
          result.kind === 'recovery_required'
            ? { identity: blocker.identity, diagnostic: result.diagnostic.slice(0, 8_192) }
            : undefined;
        // A completed attempt is not proof of readiness; observe the successor.
        signature = undefined;
        continue;
      }
      if (selected?.action === 'retry') {
        // Explicit retry permits another safe probe, never an implicit interruption.
        attempted.delete(nextSignature);
        automaticAttempts = 0;
        recovery = undefined;
        signature = undefined;
        continue;
      }
      const attention = projectBlocker(blocker, current.revision, recovery?.diagnostic);
      if (!input.openSurface) throw new HostHandoffRequiredError(attention);
      surface ??= input.openSurface(submit);
      publish(attention);
      await new Promise<void>((resolve, reject) => {
        const finish = (error?: unknown) => {
          clearTimeout(timer);
          input.signal?.removeEventListener('abort', abort);
          wake = undefined;
          if (error !== undefined) reject(error);
          else resolve();
        };
        const abort = () => finish(input.signal?.reason);
        const timer = setTimeout(finish, interval);
        wake = () => finish();
        input.signal?.addEventListener('abort', abort, { once: true });
        if (input.signal?.aborted) abort();
        else if (choice) finish();
      });
    }
  } finally {
    surface?.close();
  }
}

function projectBlocker(
  blocker: HostHandoffBlocker,
  revision: string,
  recovery?: string,
): HostHandoffView {
  const replacement = blocker.replacement;
  return {
    revision,
    target: blocker.target,
    state: 'attention',
    reason:
      blocker.reason === 'unavailable'
        ? 'retry_required'
        : recovery || blocker.reason === 'repair'
          ? 'repair_required'
          : !replacement
            ? 'operator_required'
            : !blocker.activity
              ? 'activity_unknown'
              : isHostActivityIdle(blocker.activity)
                ? 'retry_required'
                : 'busy',
    ...(blocker.activity ? { activity: blocker.activity } : {}),
    mayExitNaturally: blocker.mayExitNaturally,
    ...(replacement ? { operation: replacement.kind } : {}),
    actions: replacement?.canInterrupt ? ['cancel', 'retry', 'interrupt'] : ['cancel', 'retry'],
    defaultAction: 'cancel',
    ...(blocker.operatorStep ? { operatorStep: blocker.operatorStep } : {}),
    ...((recovery ?? blocker.diagnostic)
      ? { diagnostic: redactSecrets((recovery ?? blocker.diagnostic)!).slice(0, 8_192) }
      : {}),
  };
}

function blockerSignature(blocker: HostHandoffBlocker): string {
  const { processUptimeSeconds: _uptime, ...activity } = blocker.activity ?? {};
  return JSON.stringify([
    blocker.identity,
    blocker.target,
    blocker.reason,
    activity,
    blocker.mayExitNaturally,
    blocker.replacement?.kind,
    blocker.replacement?.canReplaceIdle,
    blocker.replacement?.canInterrupt,
    blocker.operatorStep,
    blocker.diagnostic,
  ]);
}

function boundedDiagnostic(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 8_192);
}
