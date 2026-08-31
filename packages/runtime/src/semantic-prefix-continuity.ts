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

import type {
  ModelCallAttempt,
  PreparedRequestObservation,
  PreparedRequestObservationSegment,
} from '@maka/core/model-call-attempt';
import { decodeModelCallAttempt } from '@maka/core/model-call-attempt';
import { isSessionInlineRun, type AgentRunHeader, type AgentRunStore } from '@maka/core/agent-run';

export type SemanticPrefixContinuity =
  | {
      status: 'no_predecessor' | 'unavailable';
      previousSegmentCount: 0;
      preservedSegmentCount: 0;
    }
  | {
      status: 'preserved' | 'unknown';
      previousSegmentCount: number;
      preservedSegmentCount: number;
    }
  | {
      status: 'diverged';
      previousSegmentCount: number;
      preservedSegmentCount: number;
      firstDivergentSegment: SemanticPrefixSegmentRef;
    };

export type SemanticPrefixSegmentRef = Pick<
  PreparedRequestObservationSegment,
  'kind' | 'index' | 'role' | 'label'
>;

type PrefixStore = Pick<AgentRunStore, 'listSessionRuns' | 'readEvents'>;

interface RootAdmissionReader {
  readRootTurnAdmission?(
    sessionId: string,
    turnId: string,
  ): Promise<{ runId: string; previousRootTurnId?: string | null } | undefined>;
}

interface AttemptContinuityInput {
  current: ModelCallAttempt;
  currentProviderStateIdentity?: `sha256:${string}`;
  currentSessionInline: boolean;
  lineage: {
    parentRunId?: string;
    parentTurnId?: string;
    retriedFromTurnId?: string;
    regeneratedFromTurnId?: string;
    branchOfTurnId?: string;
    parentSessionId?: string;
  };
  store: PrefixStore;
}

export async function deriveAttemptSemanticPrefixContinuity(
  input: AttemptContinuityInput,
): Promise<SemanticPrefixContinuity> {
  const { current } = input;
  if (!input.currentSessionInline || current.callKind !== 'main' || !current.requestObservation) {
    return unavailable();
  }

  const predecessor = await predecessorAttempt(input);
  if (predecessor === null) {
    return { status: 'no_predecessor', previousSegmentCount: 0, preservedSegmentCount: 0 };
  }
  if (!predecessor || !sameDomain(input, predecessor)) return unavailable();
  return deriveSemanticPrefixContinuity(
    current.requestObservation,
    predecessor.attempt.requestObservation!,
  );
}

export function deriveSemanticPrefixContinuity(
  currentObservation: PreparedRequestObservation,
  previousObservation: PreparedRequestObservation,
): SemanticPrefixContinuity {
  const current = currentObservation.segments.filter((segment) => segment.cacheable);
  const previous = previousObservation.segments.filter((segment) => segment.cacheable);
  const previousSegmentCount = representedCount(previous);

  for (let index = 0; index < previous.length; index += 1) {
    const before = previous[index]!;
    const after = current[index];
    if (!after || !sameIdentity(before, after)) {
      return {
        status: 'diverged',
        previousSegmentCount,
        preservedSegmentCount: representedCount(previous.slice(0, index)),
        firstDivergentSegment: segmentRef(after ?? before),
      };
    }
    if (before.comparison === 'opaque' || after.comparison === 'opaque') {
      return {
        status: 'unknown',
        previousSegmentCount,
        preservedSegmentCount: representedCount(previous.slice(0, index)),
      };
    }
    if (before.digest !== after.digest) {
      return {
        status: 'diverged',
        previousSegmentCount,
        preservedSegmentCount: representedCount(previous.slice(0, index)),
        firstDivergentSegment: segmentRef(after),
      };
    }
  }

  return {
    status: 'preserved',
    previousSegmentCount,
    preservedSegmentCount: previousSegmentCount,
  };
}

function sameIdentity(
  left: PreparedRequestObservationSegment,
  right: PreparedRequestObservationSegment,
): boolean {
  return (
    left.kind === right.kind &&
    left.index === right.index &&
    left.role === right.role &&
    left.label === right.label
  );
}

function representedCount(segments: readonly PreparedRequestObservationSegment[]): number {
  return segments.reduce((count, segment) => count + (segment.representedSegments ?? 1), 0);
}

function segmentRef(segment: PreparedRequestObservationSegment): SemanticPrefixSegmentRef {
  return {
    kind: segment.kind,
    index: segment.index,
    ...(segment.role === undefined ? {} : { role: segment.role }),
    ...(segment.label === undefined ? {} : { label: segment.label }),
  };
}

async function predecessorAttempt(
  input: AttemptContinuityInput,
): Promise<{ attempt: ModelCallAttempt; run: AgentRunHeader } | null | undefined> {
  const { current, lineage, store } = input;
  const runs = await store.listSessionRuns(current.sessionId);
  const currentRun = runs.find((run) => run.runId === current.runId);
  if (!currentRun) return undefined;

  if (current.attempt > 0) {
    return uniqueAttempt(
      currentRun,
      await attemptsFor(store, currentRun),
      (candidate) =>
        candidate.logicalCallId === current.logicalCallId &&
        candidate.attempt === current.attempt - 1,
    );
  }
  if (current.step > 0) {
    return latestAttempt(
      currentRun,
      (await attemptsFor(store, currentRun)).filter(
        (candidate) => candidate.turnId === current.turnId && candidate.step === current.step - 1,
      ),
    );
  }
  if (lineage.parentRunId) {
    const parent = runs.find((run) => run.runId === lineage.parentRunId);
    return parent ? latestAttempt(parent, await attemptsFor(store, parent)) : undefined;
  }
  if (
    lineage.parentSessionId ||
    lineage.parentTurnId ||
    lineage.retriedFromTurnId ||
    lineage.regeneratedFromTurnId ||
    lineage.branchOfTurnId
  ) {
    return undefined;
  }

  const admission = await (store as PrefixStore & RootAdmissionReader).readRootTurnAdmission?.(
    current.sessionId,
    current.turnId,
  );
  if (
    !admission ||
    admission.runId !== current.runId ||
    admission.previousRootTurnId === undefined
  ) {
    return undefined;
  }
  if (admission.previousRootTurnId === null) {
    return runs.some((run) => run.runId !== current.runId && isSessionInlineRun(run))
      ? undefined
      : null;
  }
  const previousRuns = runs.filter(
    (run) => run.turnId === admission.previousRootTurnId && isSessionInlineRun(run),
  );
  const previous = uniqueDurableRunTip(previousRuns);
  return previous ? latestAttempt(previous, await attemptsFor(store, previous)) : undefined;
}

function uniqueDurableRunTip(runs: readonly AgentRunHeader[]): AgentRunHeader | undefined {
  const byId = new Map(runs.map((run) => [run.runId, run]));
  if (byId.size !== runs.length) return undefined;
  const childByParent = new Map<string, string>();
  for (const run of runs) {
    if (!run.parentRunId || !byId.has(run.parentRunId)) continue;
    if (childByParent.has(run.parentRunId)) return undefined;
    childByParent.set(run.parentRunId, run.runId);
  }
  const tips = runs.filter((run) => !childByParent.has(run.runId));
  if (tips.length !== 1) return undefined;

  const visited = new Set<string>();
  let cursor: AgentRunHeader | undefined = tips[0];
  while (cursor) {
    if (visited.has(cursor.runId)) return undefined;
    visited.add(cursor.runId);
    cursor = cursor.parentRunId ? byId.get(cursor.parentRunId) : undefined;
  }
  return visited.size === runs.length ? tips[0] : undefined;
}

async function attemptsFor(store: PrefixStore, run: AgentRunHeader): Promise<ModelCallAttempt[]> {
  const attempts: ModelCallAttempt[] = [];
  for (const event of await store.readEvents(run.sessionId, run.runId)) {
    if (event.type !== 'model_call_attempt_recorded') continue;
    try {
      const attempt = decodeModelCallAttempt(event.data);
      if (
        attempt.callKind === 'main' &&
        attempt.sessionId === run.sessionId &&
        attempt.runId === run.runId &&
        attempt.turnId === run.turnId &&
        event.turnId === run.turnId &&
        attempt.attemptId === event.id
      ) {
        attempts.push(attempt);
      }
    } catch {
      // An unreadable attempt cannot become a guessed baseline.
    }
  }
  return attempts;
}

function latestAttempt(
  run: AgentRunHeader,
  attempts: readonly ModelCallAttempt[],
): { attempt: ModelCallAttempt; run: AgentRunHeader } | undefined {
  if (attempts.length === 0) return undefined;
  const step = Math.max(...attempts.map((attempt) => attempt.step));
  const onStep = attempts.filter((attempt) => attempt.step === step);
  const physical = Math.max(...onStep.map((attempt) => attempt.attempt));
  return uniqueAttempt(run, onStep, (attempt) => attempt.attempt === physical);
}

function uniqueAttempt(
  run: AgentRunHeader,
  attempts: readonly ModelCallAttempt[],
  predicate: (attempt: ModelCallAttempt) => boolean,
): { attempt: ModelCallAttempt; run: AgentRunHeader } | undefined {
  const matches = attempts.filter(predicate);
  return matches.length === 1 ? { attempt: matches[0]!, run } : undefined;
}

function sameDomain(
  input: {
    current: ModelCallAttempt;
    currentProviderStateIdentity?: `sha256:${string}`;
  },
  previous: { attempt: ModelCallAttempt; run: AgentRunHeader },
): boolean {
  const current = input.current;
  const before = previous.attempt;
  if (!before.requestObservation) return false;
  const currentPartition = exactProviderPartition(current.requestObservation!);
  const previousPartition = exactProviderPartition(before.requestObservation);
  return (
    input.currentProviderStateIdentity !== undefined &&
    input.currentProviderStateIdentity === previous.run.providerStateIdentity &&
    current.sessionId === before.sessionId &&
    current.connectionSlug !== undefined &&
    current.connectionSlug === before.connectionSlug &&
    current.providerId === before.providerId &&
    current.modelId === before.modelId &&
    currentPartition !== undefined &&
    currentPartition === previousPartition
  );
}

function exactProviderPartition(observation: PreparedRequestObservation): string | undefined {
  const segments = observation.segments.filter((segment) => segment.kind === 'provider_options');
  if (segments.some((segment) => segment.comparison === 'opaque')) return undefined;
  return segments.map((segment) => `${segment.index}:${segment.digest}`).join('|');
}

function unavailable(): SemanticPrefixContinuity {
  return { status: 'unavailable', previousSegmentCount: 0, preservedSegmentCount: 0 };
}

export function isSemanticPrefixContinuity(value: unknown): value is SemanticPrefixContinuity {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as {
    status?: unknown;
    previousSegmentCount?: unknown;
    preservedSegmentCount?: unknown;
    firstDivergentSegment?: unknown;
  };
  if (
    !hasOnlyKeys(candidate, [
      'status',
      'previousSegmentCount',
      'preservedSegmentCount',
      'firstDivergentSegment',
    ])
  ) {
    return false;
  }
  if (
    typeof candidate.previousSegmentCount !== 'number' ||
    typeof candidate.preservedSegmentCount !== 'number' ||
    !Number.isSafeInteger(candidate.previousSegmentCount) ||
    !Number.isSafeInteger(candidate.preservedSegmentCount) ||
    candidate.previousSegmentCount < 0 ||
    candidate.preservedSegmentCount < 0 ||
    candidate.preservedSegmentCount > candidate.previousSegmentCount
  ) {
    return false;
  }
  if (candidate.status === 'no_predecessor' || candidate.status === 'unavailable') {
    return (
      candidate.firstDivergentSegment === undefined &&
      candidate.previousSegmentCount === 0 &&
      candidate.preservedSegmentCount === 0
    );
  }
  if (candidate.status === 'preserved') {
    return (
      candidate.firstDivergentSegment === undefined &&
      candidate.preservedSegmentCount === candidate.previousSegmentCount
    );
  }
  if (candidate.status === 'unknown') return candidate.firstDivergentSegment === undefined;
  if (candidate.status !== 'diverged') return false;
  const segment = candidate.firstDivergentSegment as
    | { kind?: unknown; index?: unknown; role?: unknown; label?: unknown }
    | undefined;
  return Boolean(
    segment &&
      hasOnlyKeys(segment, ['kind', 'index', 'role', 'label']) &&
      (segment.kind === 'tool_schema' ||
        segment.kind === 'system_prompt' ||
        segment.kind === 'message' ||
        segment.kind === 'provider_options') &&
      typeof segment.index === 'number' &&
      Number.isSafeInteger(segment.index) &&
      segment.index >= 0 &&
      (segment.role === undefined || isBoundedText(segment.role)) &&
      (segment.label === undefined || isBoundedText(segment.label)),
  );
}

function hasOnlyKeys(value: object, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isBoundedText(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 256;
}
