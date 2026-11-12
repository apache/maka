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

import {
  isWorkHubCoordinationSessionId,
  userFacingText,
  type SessionHeader,
  type StoredMessage,
  type TurnRecord,
} from '@maka/core/session';
import type { SessionTodoItem } from '@maka/core/session-todo';
import { SIDE_CONVERSATION_SESSION_LABEL } from '@maka/core/side-conversation';
import {
  buildCheckinPrompt,
  CHECKIN_LOOKBACK_MS,
  decodeCheckinModelOutput,
  selectCheckinCandidates,
  validateCheckinCards,
  type CheckinLastTurn,
  type CheckinSessionState,
} from '@maka/runtime/session-checkin';
import { abortable } from '../client/wait-for-ready.js';
import type {
  OperationOutcome,
  SessionCatalogProjection,
  SessionCatalogQueryInput,
  SessionCheckinFailureClass,
  SessionCheckinGenerateInput,
  SessionCheckinGenerateResult,
} from '../protocol/index.js';
import type { CanonicalSessionProjection } from './canonical-session-projection.js';
import type { ConnectionContext, OperationHandlerMap } from './operation-dispatcher.js';

/** Sessions read in full per check-in; the rest of the catalog is judged by its row. */
const CHECKIN_DEEP_READ_MAX = 24;
const CHECKIN_TIMEOUT_MS = 60_000;
const CHECKIN_EFFECTS_RETAINED = 16;

const EXCLUDED_LABELS = new Set([
  SIDE_CONVERSATION_SESSION_LABEL,
  'mode:bot',
  'mode:deep_research',
  'scheduled-task',
]);

/** The connection and model a check-in runs on: the user's default. */
export type CheckinModelTarget = Pick<
  SessionHeader,
  'llmConnectionId' | 'llmConnectionSlug' | 'model' | 'thinkingLevel'
>;

export type HostCheckinModelResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly errorClass: SessionCheckinFailureClass };

export interface HostSessionCheckinPorts {
  /** False while privacy settings keep Session text out of background model calls. */
  readonly allowed: () => Promise<boolean>;
  readonly listSessions: (
    context: ConnectionContext,
  ) => Promise<readonly SessionCatalogProjection[]>;
  /** The recorded state of one Session, or undefined when it is gone; throws when unreadable. */
  readonly readSession: (
    session: SessionCatalogProjection,
  ) => Promise<CheckinSessionState | undefined>;
  /** The user's default model, or undefined when none is chosen: then nothing is read. */
  readonly readModelTarget: () => Promise<CheckinModelTarget | undefined>;
  /** One tool-free call on that model; no Session's own model is borrowed. */
  readonly generate: (input: {
    readonly target: CheckinModelTarget;
    readonly prompt: string;
    readonly abortSignal: AbortSignal;
  }) => Promise<HostCheckinModelResult>;
  readonly now?: () => number;
  readonly timeoutMs?: number;
}

interface CheckinEffect {
  readonly since: number | null;
  readonly task: Promise<OperationOutcome<'session.checkin.generate'>>;
}

/**
 * Runs one check-in per effect identity: a retry with the same identity gets
 * the same answer and never pays for a second model call while this Host runs.
 */
export class HostSessionCheckinCoordinator {
  readonly handlers: Pick<OperationHandlerMap, 'session.checkin.generate'> = {
    'session.checkin.generate': (input, context) => this.generate(input, context),
  };

  readonly #effects = new Map<string, CheckinEffect>();
  readonly #aborts = new Set<AbortController>();
  #closed = false;

  constructor(private readonly ports: HostSessionCheckinPorts) {}

  generate(
    input: SessionCheckinGenerateInput,
    context: ConnectionContext,
  ): Promise<OperationOutcome<'session.checkin.generate'>> {
    if (this.#closed) return Promise.resolve(draining());
    const existing = this.#effects.get(input.effectId);
    if (existing) {
      return existing.since === input.since
        ? existing.task
        : Promise.resolve({
            ok: false,
            error: {
              code: 'operation_conflict',
              message: 'Check-in effect identity is already in use',
            },
          });
    }
    const residency = context.acquireResidency();
    const abort = new AbortController();
    this.#aborts.add(abort);
    const signal = AbortSignal.any([
      abort.signal,
      AbortSignal.timeout(this.ports.timeoutMs ?? CHECKIN_TIMEOUT_MS),
    ]);
    const task = this.#run(input, context, signal)
      .then(
        (result): OperationOutcome<'session.checkin.generate'> => ({ ok: true, result }),
        (): OperationOutcome<'session.checkin.generate'> =>
          this.#closed
            ? draining()
            : { ok: false, error: { code: 'internal_failure', message: 'Check-in failed' } },
      )
      .finally(() => {
        this.#aborts.delete(abort);
        residency.release();
      });
    this.#effects.set(input.effectId, { since: input.since, task });
    while (this.#effects.size > CHECKIN_EFFECTS_RETAINED) {
      this.#effects.delete(this.#effects.keys().next().value!);
    }
    return task;
  }

  beginDrain(): void {
    this.#closed = true;
    for (const abort of this.#aborts) abort.abort();
  }

  async close(): Promise<void> {
    this.beginDrain();
    await Promise.allSettled([...this.#effects.values()].map((effect) => effect.task));
  }

  async #run(
    input: SessionCheckinGenerateInput,
    context: ConnectionContext,
    signal: AbortSignal,
  ): Promise<SessionCheckinGenerateResult> {
    const effectId = input.effectId;
    if (!(await abortable(() => this.ports.allowed(), signal))) return { kind: 'empty', effectId };
    const target = await abortable(() => this.ports.readModelTarget(), signal);
    if (!target) return { kind: 'failed', effectId, errorClass: 'configuration' };
    const now = this.ports.now?.() ?? Date.now();
    const sessions = await abortable(() => this.ports.listSessions(context), signal);
    const recent = sessions
      .filter((session) => checkinMayRead(session, now))
      .sort((a, b) => b.activityAt - a.activityAt)
      .slice(0, CHECKIN_DEEP_READ_MAX);
    const states: CheckinSessionState[] = [];
    let unreadable = 0;
    for (const session of recent) {
      const state = await abortable(() => this.ports.readSession(session), signal).catch(
        (error: unknown) => {
          if (signal.aborted) throw error;
          unreadable += 1;
          return undefined;
        },
      );
      if (state) states.push(state);
    }
    // One unreadable Session is skipped; reading none at all is a broken check-in, not a quiet one.
    if (unreadable > 0 && states.length === 0) {
      return { kind: 'failed', effectId, errorClass: 'unknown' };
    }
    const candidates = selectCheckinCandidates(states, { now, since: input.since });
    if (candidates.length === 0) return { kind: 'empty', effectId };

    const model = await this.ports.generate({
      target,
      prompt: buildCheckinPrompt(candidates),
      abortSignal: signal,
    });
    if (!model.ok) return { kind: 'failed', effectId, errorClass: model.errorClass };
    const decoded = decodeCheckinModelOutput(model.text);
    if (!decoded.ok) return { kind: 'failed', effectId, errorClass: 'invalid_response' };
    const validation = validateCheckinCards(decoded.cards, candidates);
    return {
      kind: 'generated',
      effectId,
      cards: validation.cards,
      dropped: validation.dropped.length,
    };
  }
}

const CATALOG_PAGES_MAX = 10;
const MESSAGES_KEPT = 20;

/** Reads catalog pages until they run out or the page budget does. */
export async function listCheckinCatalogSessions(
  query: (input: SessionCatalogQueryInput) => Promise<OperationOutcome<'session.catalog.query'>>,
): Promise<SessionCatalogProjection[]> {
  const sessions: SessionCatalogProjection[] = [];
  let next: SessionCatalogQueryInput = { kind: 'list_start' };
  for (let page = 0; page < CATALOG_PAGES_MAX; page += 1) {
    const outcome = await query(next);
    if (!outcome.ok || outcome.result.kind !== 'page') break;
    for (const item of outcome.result.sessions) {
      if (!('kind' in item)) sessions.push(item);
    }
    if (!outcome.result.nextCursor) break;
    next = {
      kind: 'list_continue',
      revision: outcome.result.revision,
      cursor: outcome.result.nextCursor,
    };
  }
  return sessions;
}

/** Maps what the Host recorded about one Session into the check-in's view of it. */
export function checkinSessionState(input: {
  readonly session: SessionCatalogProjection;
  readonly canonical: Pick<CanonicalSessionProjection, 'rootTurn' | 'goal' | 'interactions'>;
  readonly todos: readonly SessionTodoItem[];
  readonly messages: readonly StoredMessage[];
  /** The transcript's Turn records, consulted when this Host admitted no root Turn. */
  readonly turns: readonly TurnRecord[];
}): CheckinSessionState {
  const turn = input.canonical.rootTurn;
  const waitingForUser =
    input.session.status === 'waiting_for_user' ||
    input.canonical.interactions.pending.length > 0 ||
    turn?.status === 'waiting_for_user';
  let lastTurn: CheckinLastTurn | null = null;
  if (!turn && !waitingForUser) lastTurn = recordedLastTurn(input.turns);
  if (turn && !waitingForUser) {
    if (turn.status === 'completed') lastTurn = { status: 'completed' };
    else if (turn.status === 'failed') {
      lastTurn = {
        status: 'failed',
        failureClass: turn.failureClass,
        ...(turn.failureMessage ? { failureMessage: turn.failureMessage } : {}),
      };
    } else if (turn.status === 'cancelled') {
      lastTurn = { status: 'cancelled', abortSource: turn.abortSource };
    } else lastTurn = { status: 'in_progress' };
  }
  const goal = input.canonical.goal;
  const texts: { role: 'user' | 'assistant'; text: string }[] = [];
  for (const message of input.messages) {
    if (message.type === 'user' && !message.origin && typeof message.text === 'string') {
      texts.push({ role: 'user', text: userFacingText(message) });
    } else if (message.type === 'assistant' && typeof message.text === 'string') {
      texts.push({ role: 'assistant', text: message.text });
    }
  }
  const first = texts.find((message) => message.role === 'user');
  const recent = texts.slice(-MESSAGES_KEPT);
  return {
    sessionId: input.session.id,
    revision: input.session.revision,
    name: input.session.name,
    activityAt: input.session.activityAt,
    lastTurn,
    waitingForUser,
    goal: goal
      ? { status: goal.status, condition: goal.condition, lastReason: goal.lastReason }
      : null,
    todos: input.todos,
    messages: first && !recent.includes(first) ? [first, ...recent] : recent,
  };
}

/**
 * A Session written before Root Turn admissions, or imported, still carries
 * `turn_state` records. Only a recorded status counts; an inferred one is a
 * reading of old data, not evidence.
 */
function recordedLastTurn(turns: readonly TurnRecord[]): CheckinLastTurn | null {
  const turn = turns.at(-1);
  if (!turn || turn.statusSource !== 'recorded') return null;
  switch (turn.status) {
    case 'completed':
      return { status: 'completed' };
    case 'failed':
      return {
        status: 'failed',
        failureClass: turn.errorClass ?? 'unknown',
        ...(turn.failureMessage ? { failureMessage: turn.failureMessage } : {}),
      };
    case 'aborted':
      return { status: 'cancelled', abortSource: turn.abortSource ?? 'unknown' };
    case 'running':
      return { status: 'in_progress' };
  }
}

/** Judged from the catalog row alone, before any Session is read in full. */
export function checkinMayRead(session: SessionCatalogProjection, now: number): boolean {
  return (
    !session.isArchived &&
    !session.subagent &&
    !session.parentSessionId &&
    session.backend === 'ai-sdk' &&
    session.status !== 'running' &&
    !(session.liveRunState?.runningTurnIds.length ?? 0) &&
    !isWorkHubCoordinationSessionId(session.id) &&
    !session.labels.some((label) => EXCLUDED_LABELS.has(label)) &&
    session.activityAt >= now - CHECKIN_LOOKBACK_MS
  );
}

function draining(): OperationOutcome<'session.checkin.generate'> {
  return { ok: false, error: { code: 'host_draining', message: 'Runtime Host is draining' } };
}
