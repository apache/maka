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

import type { NormalizedUsage } from './result.js';
import type {
  WorkHubIntentAssessment,
  WorkHubRecallAssessment,
  WorkHubRoutingCandidate,
  WorkHubRoutingEvaluationArm,
  WorkHubRoutingObservation,
} from './workhub-routing-evaluation.js';
import { applyWorkHubRoutingPolicy } from './workhub-routing-evaluation.js';

const MAX_USER_TEXT_CHARS = 2_000;
const MAX_TRANSCRIPT_MESSAGES = 8;
const MAX_SUMMARY_CHARS = 600;

export type WorkHubRoutingModelRequest =
  | {
      readonly stage: 'intent';
      readonly userText: string;
      readonly transcript: readonly {
        readonly role: 'user' | 'assistant';
        readonly text: string;
      }[];
    }
  | {
      readonly stage: 'recall';
      readonly userText: string;
      readonly intent: WorkHubIntentAssessment;
      readonly candidates: readonly WorkHubRoutingCandidate[];
    };

export interface WorkHubRoutingModelResponse {
  readonly value: unknown;
  readonly usage?: NormalizedUsage;
  readonly costUsd?: number;
}

/** Model transport adapter. It receives bounded data and exposes no tools. */
export interface WorkHubRoutingModelPort {
  decide(input: WorkHubRoutingModelRequest): Promise<WorkHubRoutingModelResponse>;
}

/**
 * Compose a split Intent/Recall model arm. The deterministic policy is local,
 * side-effect free, and cannot turn recall failure into implicit creation.
 */
export function createSplitWorkHubRoutingModelArm(input: {
  readonly id: string;
  readonly intentModel: WorkHubRoutingModelPort;
  readonly recallModel: WorkHubRoutingModelPort;
}): WorkHubRoutingEvaluationArm {
  return {
    id: input.id,
    async evaluate(request): Promise<WorkHubRoutingObservation> {
      const intentResponse = await input.intentModel.decide({
        stage: 'intent',
        userText: bounded(request.userText, MAX_USER_TEXT_CHARS),
        transcript: request.transcript.slice(-MAX_TRANSCRIPT_MESSAGES).map((message) => ({
          ...message,
          text: bounded(message.text, MAX_SUMMARY_CHARS),
        })),
      });
      const intent = decodeIntent(intentResponse.value);
      if (!requiresSessionRecall(intent)) {
        return {
          intent,
          recall: { kind: 'not_applicable' },
          outcome: applyWorkHubRoutingPolicy(intent, { kind: 'not_applicable' }),
          ...combinedAccounting(intentResponse),
        };
      }
      const boundedCandidates = request.candidates.slice(0, 32).map((candidate) => ({
        ...candidate,
        sessionName: bounded(candidate.sessionName, MAX_SUMMARY_CHARS),
        workspaceName: bounded(candidate.workspaceName, MAX_SUMMARY_CHARS),
        ...(candidate.objective === undefined
          ? {}
          : { objective: bounded(candidate.objective, MAX_SUMMARY_CHARS) }),
        ...(candidate.recentOutcome === undefined
          ? {}
          : { recentOutcome: bounded(candidate.recentOutcome, MAX_SUMMARY_CHARS) }),
      }));
      const recallResponse = await input.recallModel.decide({
        stage: 'recall',
        userText: bounded(request.userText, MAX_USER_TEXT_CHARS),
        intent,
        candidates: boundedCandidates,
      });
      const recall = decodeRecall(
        recallResponse.value,
        new Set(boundedCandidates.map(({ candidateRef }) => candidateRef)),
      );
      return {
        intent,
        recall,
        outcome: applyWorkHubRoutingPolicy(intent, recall),
        ...combinedAccounting(intentResponse, recallResponse),
      };
    },
  };
}

export function decodeIntent(value: unknown): WorkHubIntentAssessment {
  const record = exactRecord(value, 'intent');
  if (record.kind === 'unclear' && Object.keys(record).length === 1) return { kind: 'unclear' };
  if (
    record.kind === 'routing' &&
    Object.keys(record).length === 2 &&
    ['discuss', 'execute', 'create', 'continue'].includes(String(record.mode))
  ) {
    return { kind: 'routing', mode: record.mode as 'discuss' | 'execute' | 'create' | 'continue' };
  }
  if (
    record.kind === 'linked' &&
    Object.keys(record).length === 2 &&
    ['correct', 'stop', 'resume'].includes(String(record.operation))
  ) {
    return { kind: 'linked', operation: record.operation as 'correct' | 'stop' | 'resume' };
  }
  throw new Error('Invalid WorkHub model intent');
}

export function decodeRecall(
  value: unknown,
  allowedCandidateRefs: ReadonlySet<string>,
): WorkHubRecallAssessment {
  const record = exactRecord(value, 'recall');
  if (record.kind === 'none' && Object.keys(record).length === 1) return { kind: 'none' };
  if (
    (record.kind === 'ranked' || record.kind === 'ambiguous') &&
    Object.keys(record).length === 2 &&
    Array.isArray(record.candidateRefs) &&
    record.candidateRefs.length <= allowedCandidateRefs.size &&
    record.candidateRefs.every((ref) => typeof ref === 'string' && allowedCandidateRefs.has(ref)) &&
    new Set(record.candidateRefs).size === record.candidateRefs.length &&
    (record.kind === 'ranked' ? record.candidateRefs.length > 0 : record.candidateRefs.length > 1)
  ) {
    return { kind: record.kind, candidateRefs: record.candidateRefs as string[] };
  }
  throw new Error('Invalid WorkHub model recall');
}

function requiresSessionRecall(intent: WorkHubIntentAssessment): boolean {
  return intent.kind === 'routing' && (intent.mode === 'execute' || intent.mode === 'continue');
}

function combinedAccounting(
  ...responses: readonly WorkHubRoutingModelResponse[]
): Pick<WorkHubRoutingObservation, 'usage' | 'costUsd'> {
  const usages = responses.flatMap(({ usage }) => (usage ? [usage] : []));
  const costs = responses.flatMap(({ costUsd }) => (costUsd === undefined ? [] : [costUsd]));
  return {
    ...(usages.length === 0
      ? {}
      : {
          usage: {
            inputTokens: sum(usages.map(({ inputTokens }) => inputTokens ?? 0)),
            outputTokens: sum(usages.map(({ outputTokens }) => outputTokens ?? 0)),
            cacheReadTokens: sum(usages.map(({ cacheReadTokens }) => cacheReadTokens ?? 0)),
            cacheWriteTokens: sum(usages.map(({ cacheWriteTokens }) => cacheWriteTokens ?? 0)),
            reasoningTokens: sum(usages.map(({ reasoningTokens }) => reasoningTokens ?? 0)),
            totalTokens: sum(usages.map(({ totalTokens }) => totalTokens ?? 0)),
          },
        }),
    ...(costs.length === 0 ? {} : { costUsd: sum(costs) }),
  };
}

function bounded(value: string, maxChars: number): string {
  const chars = Array.from(value.trim());
  return chars.length <= maxChars ? chars.join('') : `${chars.slice(0, maxChars - 1).join('')}…`;
}

function exactRecord(value: unknown, stage: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid WorkHub model ${stage}`);
  }
  return value as Record<string, unknown>;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
