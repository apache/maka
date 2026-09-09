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

import type { WorkHubCoordinationActInput } from '@maka/runtime-host/protocol';
import { createWorkHubController as createGatedWorkHubController, type WorkHubSessionFacts, type WorkHubSessionPort, type WorkHubCoordinationTurn, type WorkHubSubmission } from '../../renderer/workhub-controller.js';
import { createWorkHubR24RoutingStrategy, createWorkHubR3ARoutingStrategy, createWorkHubR3BRoutingStrategy, type WorkHubRoutingModelPort, type WorkHubRoutingStrategy } from '../../renderer/features/workhub/index.js';

export function session(
  sessionId: string,
  overrides: Partial<WorkHubSessionFacts> = {},
): WorkHubSessionFacts {
  return {
    target: { sessionId },
    projectName: 'maka',
    sessionName: sessionId,
    kind: 'ordinary',
    archived: false,
    state: 'active',
    updatedAt: 1,
    ...overrides,
  };
}

export interface TestSessionPort extends WorkHubSessionPort {
  create(input: { name: string }): Promise<WorkHubSessionFacts>;
  submit(
    target: { sessionId: string },
    text: string,
    turnId: string,
  ): Promise<{ turnId: string; steered?: true }>;
}

export function port(sessions: WorkHubSessionFacts[]): TestSessionPort {
  let nextTurnId = 0;
  return {
    list: async () => sessions,
    recentTurns: async () => [],
    delegationFeedback: async (references) =>
      references.map(({ delegationId }) => ({ delegationId, state: 'accepted' })),
    routingEvidence: async () => [],
    create: async () => {
      throw new Error('create is not used by this read test');
    },
    submit: async (_target, _text, turnId) => ({
      turnId: turnId || `reserved-turn-${++nextTurnId}`,
    }),
    subscribe: () => () => {},
  };
}

export function createWorkHubController({
  sessions,
  routingStrategy,
  transcript = [],
  candidateSetId = `sha256:${"a".repeat(64)}`,
  onAct,
}: {
  sessions: TestSessionPort;
  routingStrategy?: WorkHubRoutingStrategy;
  transcript?: readonly WorkHubCoordinationTurn[];
  candidateSetId?: string;
  onAct?: (input: WorkHubCoordinationActInput) => void;
}) {
  let candidateByRef = new Map<string, WorkHubSessionFacts>();
  return createGatedWorkHubController({
    sessions,
    ...(routingStrategy ? { routingStrategy } : {}),
    coordination: {
      open: async (handler) => { handler(transcript); return { close: async () => undefined }; },
      record: async (input) => ({ turnId: input.turnId }),
      candidates: async () => {
        const candidates = (await sessions.list())
          .filter((entry) => entry.kind === 'ordinary' && !entry.archived)
          .map((entry) => ({
            candidateRef: `candidate-${entry.target.sessionId}`,
            sessionId: entry.target.sessionId,
            sessionName: entry.sessionName,
            workspace: {
              target: { kind: 'host_path' as const, path: `/workspace/${entry.target.sessionId}` },
              hostCwd: `/workspace/${entry.target.sessionId}`,
            },
            state: entry.state,
            updatedAt: entry.updatedAt,
          }));
        const byId = new Map(
          (await sessions.list()).map((entry) => [entry.target.sessionId, entry]),
        );
        candidateByRef = new Map(candidates.flatMap((candidate) => {
          const entry = byId.get(candidate.sessionId);
          return entry ? [[candidate.candidateRef, entry] as const] : [];
        }));
        return {
          candidateSetId,
          candidates,
        };
      },
      act: async (input) => {
        onAct?.(input);
        if (input.proposal.disposition === 'answer_here') {
          return {
            disposition: 'answer_here',
            coordinationTurnId: input.actionId,
          };
        }
        if (input.proposal.disposition === 'clarify') {
          return {
            disposition: 'clarify',
            coordinationTurnId: input.actionId,
          };
        }
        if (input.proposal.disposition === 'create_new') {
          const created = await sessions.create({ name: input.proposal.title });
          const admitted = await sessions.submit(created.target, input.userText, input.actionId);
          return {
            disposition: 'create_new',
            targetSessionId: created.target.sessionId,
            targetTurnId: admitted.turnId,
            ...(admitted.steered ? { steered: true as const } : {}),
          };
        }
        if (input.proposal.disposition === 'replace') {
          if (input.proposal.target.disposition === 'create_new') {
            const created = await sessions.create({ name: input.proposal.target.title });
            const admitted = await sessions.submit(created.target, input.userText, input.actionId);
            return {
              disposition: 'replace',
              replacementDisposition: 'create_new',
              targetSessionId: created.target.sessionId,
              targetTurnId: admitted.turnId,
              ...(admitted.steered ? { steered: true as const } : {}),
            };
          }
          const replacementTarget = candidateByRef.get(input.proposal.target.candidateRef);
          if (!replacementTarget) throw new Error('unknown test replacement candidate');
          const admitted = await sessions.submit(
            replacementTarget.target,
            input.userText,
            input.actionId,
          );
          return {
            disposition: 'replace',
            replacementDisposition: 'delegate_existing',
            targetSessionId: replacementTarget.target.sessionId,
            targetTurnId: admitted.turnId,
            ...(admitted.steered ? { steered: true as const } : {}),
          };
        }
        if (input.proposal.disposition === 'stop_work') {
          return {
            disposition: 'stop_work',
            outcome: 'cancelled_pending',
            targetSessionId: input.proposal.expects.targetSessionId,
          };
        }
        if (input.proposal.disposition === 'resume_work') {
          return {
            disposition: 'resume_work',
            outcome: 'resume_started',
            targetSessionId: input.proposal.expects.targetSessionId,
            targetTurnId: 'resumed-turn',
          };
        }
        const target = candidateByRef.get(input.proposal.candidateRef);
        if (!target) throw new Error('unknown test candidate');
        const admitted = await sessions.submit(target.target, input.userText, input.actionId);
        return {
          disposition: 'delegate_existing',
          targetSessionId: target.target.sessionId,
          targetTurnId: admitted.turnId,
          ...(admitted.steered ? { steered: true as const } : {}),
        };
      },
    },
  });
}


/** Repeatable comparison through the real controller; only Host execution is stubbed. */
export async function runRoutingComparison(input: {
  repetitions: number;
  sessions: readonly WorkHubSessionFacts[];
  transcript: readonly WorkHubCoordinationTurn[];
  candidateSetId: string;
  cases: readonly { caseId: string; text: string }[];
  model: WorkHubRoutingModelPort;
}) {
  if (!Number.isSafeInteger(input.repetitions) || input.repetitions < 1) {
    throw new Error('repetitions must be a positive integer');
  }
  const observations: Array<{ repetition: number; caseId: string; result: WorkHubSubmission; proposals: WorkHubCoordinationActInput[] }> = [];
  for (let repetition = 0; repetition < input.repetitions; repetition += 1) {
    for (const routingStrategy of [createWorkHubR24RoutingStrategy(), createWorkHubR3ARoutingStrategy({ model: input.model }), createWorkHubR3BRoutingStrategy({ model: input.model })]) {
      const facts = structuredClone([...input.sessions]);
      const sessions = port(facts);
      sessions.create = async ({ name }) => {
        const created = session(`created-${facts.length}`, { sessionName: name });
        facts.push(created);
        return created;
      };
      const proposals: WorkHubCoordinationActInput[] = [];
      const controller = createWorkHubController({ sessions, routingStrategy,
        transcript: structuredClone([...input.transcript]), candidateSetId: input.candidateSetId,
        onAct: (proposal) => proposals.push(proposal),
      });
      const conversation = await controller.openConversation(() => {}, (error) => { throw error; });
      try {
        for (const entry of input.cases) {
          const start = proposals.length;
          const result = await controller.submit({ newSessionFallbackTitle: 'New work', requestId: `${repetition}:${routingStrategy.strategyId}:${entry.caseId}`, text: entry.text });
          observations.push({ repetition, caseId: entry.caseId, result, proposals: proposals.slice(start) });
        }
      } finally { await conversation.close(); }
    }
  }
  return observations;
}
