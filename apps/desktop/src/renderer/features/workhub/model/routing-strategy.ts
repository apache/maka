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

import { boundedWorkHubText } from './route-policy.js';
import {
  createExactNameSessionResolver,
  readWorkHubRequestIntent,
} from '../../../application/contracts/workhub-request-intent.js';

export interface WorkHubRoutingTarget {
  readonly sessionId: string;
}
export interface WorkHubRoutingSessionFacts {
  readonly target: WorkHubRoutingTarget;
  readonly projectName: string;
  readonly sessionName: string;
  readonly state: 'active' | 'running' | 'waiting_for_user' | 'blocked' | 'aborted';
  readonly latestResult?: string;
  readonly updatedAt: number;
}
export const WORKHUB_R24_ROUTING_STRATEGY_ID = 'wh-r2.4-session-context-continuity' as const;
export const WORKHUB_R3A_ROUTING_STRATEGY_ID = 'wh-r3.a-model-intent-model-resolver' as const;
export const WORKHUB_R3B_ROUTING_STRATEGY_ID =
  'wh-r3.b-model-intent-deterministic-resolver' as const;
export type WorkHubRoutingStrategyId =
  | typeof WORKHUB_R24_ROUTING_STRATEGY_ID
  | typeof WORKHUB_R3A_ROUTING_STRATEGY_ID
  | typeof WORKHUB_R3B_ROUTING_STRATEGY_ID;
export interface WorkHubRoutingTranscriptTurn {
  readonly userText: string;
  readonly assistantText?: string;
}
export interface WorkHubRoutingInput {
  readonly text: string;
  readonly sessions: readonly WorkHubRoutingSessionFacts[];
  readonly originPromptBySessionId: ReadonlyMap<string, string | undefined>;
  readonly candidateRefBySessionId: ReadonlyMap<string, string>;
  readonly coordinationTranscript: readonly WorkHubRoutingTranscriptTurn[];
  readonly explicitTarget?: WorkHubRoutingTarget;
}

/** Interpretations carry no target and cannot grant execution authority. */
export type WorkHubIntentClassification = 'work' | 'discussion' | 'uncertain';
export interface WorkHubIntentInput {
  readonly text: string;
  readonly coordinationTranscript: readonly WorkHubRoutingTranscriptTurn[];
}
export interface WorkHubIntentClassifier {
  classify(input: WorkHubIntentInput): Promise<WorkHubIntentClassification>;
}
export interface WorkHubRecallCandidate {
  readonly candidateRef: string;
  readonly projectName: string;
  readonly sessionName: string;
  readonly state: WorkHubRoutingSessionFacts['state'];
  readonly updatedAt: number;
  readonly latestResult?: string;
  readonly originPrompt?: string;
}
export interface WorkHubResolverInput {
  readonly text: string;
  readonly candidates: readonly WorkHubRecallCandidate[];
}
/** Retrieval only. Neither a final target nor creation is a resolver result. */
export type WorkHubRoutingResolution =
  | { readonly kind: 'none' }
  | { readonly kind: 'ranked' | 'ambiguous'; readonly candidateRefs: readonly string[] };
export interface WorkHubRoutingResolver {
  resolve(input: WorkHubResolverInput): Promise<WorkHubRoutingResolution>;
}
/** A named component combination, not another proposal owner. */
export interface WorkHubRoutingStrategy {
  readonly strategyId: WorkHubRoutingStrategyId;
  readonly intent: WorkHubIntentClassifier;
  readonly resolver: WorkHubRoutingResolver;
}
export type WorkHubModelRoutingRequest =
  | ({ readonly stage: 'intent' } & WorkHubIntentInput)
  | ({ readonly stage: 'resolver' } & WorkHubResolverInput);
/** Adapter output is untrusted; each component validates its own closed schema. */
export interface WorkHubRoutingModelPort {
  decide(input: WorkHubModelRoutingRequest): Promise<unknown>;
}

export function createWorkHubDeterministicIntent(): WorkHubIntentClassifier {
  return {
    async classify({ text }) {
      const execution = readWorkHubRequestIntent(text).execution;
      return execution === 'imperative'
        ? 'work'
        : execution === 'ambiguous'
          ? 'uncertain'
          : 'discussion';
    },
  };
}
export function createWorkHubDeterministicResolver(): WorkHubRoutingResolver {
  const resolver = createExactNameSessionResolver();
  return {
    async resolve({ text, candidates }) {
      const resolution = resolver.resolve({
        reference: { text },
        sessions: candidates.map((candidate) => ({ ...candidate, ref: candidate.candidateRef })),
      });
      return resolution.kind === 'none'
        ? resolution
        : {
            kind: resolution.kind,
            candidateRefs: resolution.candidates.map(({ ref }) => ref),
          };
    },
  };
}
export function createWorkHubModelIntent(model: WorkHubRoutingModelPort): WorkHubIntentClassifier {
  return {
    async classify(input) {
      const value = await model.decide({ stage: 'intent', ...input, text: boundedWorkHubText(input.text, MAX_MODEL_INPUT_CHARS) });
      if (
        !isRecord(value) ||
        Object.keys(value).length !== 1 ||
        !['work', 'discussion', 'uncertain'].includes(String(value.intent))
      ) {
        throw new Error('Invalid WorkHub intent classification');
      }
      return value.intent as WorkHubIntentClassification;
    },
  };
}
export function createWorkHubModelResolver(model: WorkHubRoutingModelPort): WorkHubRoutingResolver {
  return {
    async resolve(input) {
      const value = await model.decide({ stage: 'resolver', ...input, text: boundedWorkHubText(input.text, MAX_MODEL_INPUT_CHARS) });
      if (!validResolution(value, input.candidates)) throw new Error('Invalid WorkHub recall');
      return value;
    },
  };
}
export function createWorkHubR24RoutingStrategy(): WorkHubRoutingStrategy {
  return {
    strategyId: WORKHUB_R24_ROUTING_STRATEGY_ID,
    intent: createWorkHubDeterministicIntent(),
    resolver: createWorkHubDeterministicResolver(),
  };
}
export function createWorkHubR3ARoutingStrategy({
  model,
}: {
  readonly model: WorkHubRoutingModelPort;
}): WorkHubRoutingStrategy {
  return {
    strategyId: WORKHUB_R3A_ROUTING_STRATEGY_ID,
    intent: createWorkHubModelIntent(model),
    resolver: createWorkHubModelResolver(model),
  };
}
export function createWorkHubR3BRoutingStrategy({
  model,
}: {
  readonly model: WorkHubRoutingModelPort;
}): WorkHubRoutingStrategy {
  return {
    strategyId: WORKHUB_R3B_ROUTING_STRATEGY_ID,
    intent: createWorkHubModelIntent(model),
    resolver: createWorkHubDeterministicResolver(),
  };
}

/** Bound once at the shared controller boundary, before either component runs. */
export async function readWorkHubRoutingEvidence(
  strategy: WorkHubRoutingStrategy,
  input: WorkHubRoutingInput,
): Promise<{
  readonly classification: WorkHubIntentClassification;
  readonly resolution: WorkHubRoutingResolution;
}> {
  const candidates = input.sessions.flatMap((session) => {
    const candidateRef = input.candidateRefBySessionId.get(session.target.sessionId);
    return candidateRef
      ? [
          {
            candidateRef,
            projectName: session.projectName,
            sessionName: session.sessionName,
            state: session.state,
            updatedAt: session.updatedAt,
            latestResult: session.latestResult,
            originPrompt: input.originPromptBySessionId.get(session.target.sessionId),
          },
        ]
      : [];
  });
  try {
    const classification = await strategy.intent.classify({
      text: input.text,
      coordinationTranscript: input.coordinationTranscript,
    });
    if (!['work', 'discussion', 'uncertain'].includes(classification))
      throw new Error('Invalid WorkHub intent');
    const resolution = await strategy.resolver.resolve({ text: input.text, candidates });
    if (!validResolution(resolution, candidates)) throw new Error('Invalid WorkHub recall');
    return { classification, resolution };
  } catch {
    return { classification: 'uncertain', resolution: { kind: 'ambiguous', candidateRefs: [] } };
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function validResolution(
  value: unknown,
  candidates: readonly WorkHubRecallCandidate[],
): value is WorkHubRoutingResolution {
  if (!isRecord(value)) return false;
  if (value.kind === 'none') return Object.keys(value).length === 1;
  if (
    (value.kind !== 'ranked' && value.kind !== 'ambiguous') ||
    Object.keys(value).some((key) => key !== 'kind' && key !== 'candidateRefs') ||
    !Array.isArray(value.candidateRefs) ||
    value.candidateRefs.length > candidates.length ||
    (value.kind === 'ranked' && value.candidateRefs.length === 0)
  )
    return false;
  const allowed = new Set(candidates.map(({ candidateRef }) => candidateRef));
  return (
    new Set(value.candidateRefs).size === value.candidateRefs.length &&
    value.candidateRefs.every((ref) => typeof ref === 'string' && allowed.has(ref))
  );
}
const MAX_ROUTING_CANDIDATES = 12;
const MAX_MODEL_TRANSCRIPT_TURNS = 12;
const MAX_MODEL_INPUT_CHARS = 2_000;
const MAX_MODEL_SUMMARY_CHARS = 600;

export function boundedRoutingInput(input: WorkHubRoutingInput): WorkHubRoutingInput {
  const sessions = [...input.sessions]
    .filter((session) => input.candidateRefBySessionId.has(session.target.sessionId))
    .sort(
      (left, right) =>
        right.updatedAt - left.updatedAt ||
        left.target.sessionId.localeCompare(right.target.sessionId),
    )
    .slice(0, MAX_ROUTING_CANDIDATES)
    .map((session) => ({
      ...session,
      projectName: boundedWorkHubText(session.projectName, MAX_MODEL_SUMMARY_CHARS),
      sessionName: boundedWorkHubText(session.sessionName, MAX_MODEL_SUMMARY_CHARS),
      ...(session.latestResult === undefined
        ? {}
        : {
            latestResult: boundedWorkHubText(session.latestResult, MAX_MODEL_SUMMARY_CHARS),
          }),
    }));
  return {
    text: input.text,
    sessions,
    originPromptBySessionId: new Map(
      sessions.map((session) => {
        const originPrompt = input.originPromptBySessionId.get(session.target.sessionId);
        return [
          session.target.sessionId,
          originPrompt === undefined
            ? undefined
            : boundedWorkHubText(originPrompt, MAX_MODEL_SUMMARY_CHARS),
        ] as const;
      }),
    ),
    candidateRefBySessionId: new Map(
      sessions.map((session) => [
        session.target.sessionId,
        input.candidateRefBySessionId.get(session.target.sessionId)!,
      ]),
    ),
    coordinationTranscript: input.coordinationTranscript
      .slice(-MAX_MODEL_TRANSCRIPT_TURNS)
      .map((turn) => ({
        userText: boundedWorkHubText(turn.userText, MAX_MODEL_SUMMARY_CHARS),
        ...(turn.assistantText === undefined
          ? {}
          : {
              assistantText: boundedWorkHubText(turn.assistantText, MAX_MODEL_SUMMARY_CHARS),
            }),
      })),
    ...(input.explicitTarget ? { explicitTarget: input.explicitTarget } : {}),
  };
}
