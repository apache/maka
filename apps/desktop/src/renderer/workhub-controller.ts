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

/**
 * WorkHub is a projection and routing surface over ordinary Sessions.
 * Session and Runtime remain authoritative for transcript, execution, state,
 * permissions, interactions, and recovery.
 */

import {
  createWorkHubRoutePolicy,
  type WorkHubRouteEvidence,
  workHubNewSessionName,
} from './workhub-route-policy.js';

export interface WorkHubSessionTarget {
  sessionId: string;
}

export type WorkHubSessionState =
  | 'active'
  | 'running'
  | 'waiting_for_user'
  | 'blocked'
  | 'aborted';

export interface WorkHubSessionFacts {
  target: WorkHubSessionTarget;
  projectName: string;
  sessionName: string;
  kind: 'ordinary' | 'internal' | 'subagent';
  archived: boolean;
  state: WorkHubSessionState;
  latestResult?: string;
  updatedAt: number;
}

export type WorkHubSessionSummary = Omit<WorkHubSessionFacts, 'kind'>;

export type WorkHubProjectedTurnState = 'running' | 'completed' | 'aborted' | 'failed';

export interface WorkHubProjectedTurn {
  messageId: string;
  target: WorkHubSessionTarget;
  turnId: string;
  text: string;
  state: WorkHubProjectedTurnState;
  result?: string;
  updatedAt: number;
}

const WORKHUB_TIMELINE_TEXT_LIMIT = 600;

export function boundedWorkHubTimelineText(value: string): string {
  const text = value.trim();
  const chars = Array.from(text);
  return chars.length <= WORKHUB_TIMELINE_TEXT_LIMIT
    ? text
    : `${chars.slice(0, WORKHUB_TIMELINE_TEXT_LIMIT - 1).join('')}…`;
}

export interface WorkHubProjection {
  sessions: WorkHubSessionSummary[];
  turns: WorkHubProjectedTurn[];
}

export interface WorkHubSubmitInput {
  requestId: string;
  text: string;
  explicitTarget?: WorkHubSessionTarget;
  correction?: {
    from: WorkHubSessionTarget;
    turnId: string;
    steered?: true;
  };
}

export const WORKHUB_ROUTING_STRATEGY_ID = 'wh-r2.3-session-core-evidence' as const;
export type WorkHubRoutingStrategyId = typeof WORKHUB_ROUTING_STRATEGY_ID;

export type WorkHubSubmission = (
  | {
      kind: 'submitted';
      requestId: string;
      target: WorkHubSessionTarget;
      turnId: string;
      steered?: true;
      evidence: WorkHubRouteEvidence | 'new_session';
      correctedFrom?: WorkHubSessionTarget;
    }
  | {
      kind: 'clarification';
      requestId: string;
      text: string;
      options: Array<Pick<WorkHubSessionSummary, 'target' | 'projectName' | 'sessionName'>>;
    }
  | {
      kind: 'discussion';
      requestId: string;
      text: string;
    }
  | {
      kind: 'waiting';
      requestId: string;
      text: string;
      target: WorkHubSessionTarget;
    }
) & { strategyId: WorkHubRoutingStrategyId };

/**
 * Internal seam. The renderer bridge is the production adapter; interface
 * tests use an in-memory adapter.
 */
export interface WorkHubSessionPort {
  list(): Promise<WorkHubSessionFacts[]>;
  /**
   * Rebuilds a bounded recent conversation from the authoritative Session
   * transcripts. Missing transcripts are omitted rather than copied elsewhere.
   */
  recentTurns(targets: readonly WorkHubSessionTarget[]): Promise<WorkHubProjectedTurn[]>;
  /**
   * Returns rebuildable routing evidence read from the authoritative Session
   * log. Implementations must not persist a second writable copy of it.
   */
  routingEvidence(
    targets: readonly WorkHubSessionTarget[],
  ): Promise<Array<{ target: WorkHubSessionTarget; originPrompt?: string }>>;
  create(input: { name: string }): Promise<WorkHubSessionFacts>;
  submit(
    target: WorkHubSessionTarget,
    text: string,
  ): Promise<{ turnId: string; steered?: true }>;
  stop(target: WorkHubSessionTarget, expectedTurnId: string): Promise<void>;
  subscribe(handler: () => void): () => void;
}

export interface WorkHubController {
  read(): Promise<WorkHubProjection>;
  submit(input: WorkHubSubmitInput): Promise<WorkHubSubmission>;
  subscribe(handler: () => void): () => void;
}

export function createWorkHubController(deps: {
  sessions: WorkHubSessionPort;
}): WorkHubController {
  const routePolicy = createWorkHubRoutePolicy();
  return {
    subscribe(handler) {
      return deps.sessions.subscribe(handler);
    },
    async read() {
      const facts = await deps.sessions.list();
      const ordinary = facts
        .filter((session) => session.kind === 'ordinary')
        .sort((left, right) => right.updatedAt - left.updatedAt);
      return {
        sessions: ordinary
          .map(({ kind: _kind, ...session }) => session),
        turns: await deps.sessions.recentTurns(ordinary.map((session) => session.target)),
      };
    },
    async submit(input) {
      const sessions = await deps.sessions.list();
      const ordinary = sessions.filter((session) => session.kind === 'ordinary');
      // Archived Sessions remain visible as historical work, but Runtime Host
      // rejects new root Turns for them. Never offer one as a routing target.
      const routable = ordinary.filter((session) => !session.archived);
      const routingEvidence = input.explicitTarget
        ? []
        : await deps.sessions.routingEvidence(routable.map((session) => session.target));
      const decision = routePolicy.resolve({
        text: input.text,
        sessions: routable,
        originPromptBySessionId: new Map(
          routingEvidence.map((entry) => [entry.target.sessionId, entry.originPrompt]),
        ),
        ...(input.explicitTarget ? { explicitTarget: input.explicitTarget } : {}),
      });
      if (decision.kind === 'clarification') {
        return {
          kind: 'clarification',
          strategyId: WORKHUB_ROUTING_STRATEGY_ID,
          requestId: input.requestId,
          text: input.text,
          options: decision.options.map((session) => ({
            target: session.target,
            projectName: session.projectName,
            sessionName: session.sessionName,
          })),
        };
      }
      if (decision.kind === 'discussion') {
        return {
          kind: 'discussion',
          strategyId: WORKHUB_ROUTING_STRATEGY_ID,
          requestId: input.requestId,
          text: input.text,
        };
      }
      let target: WorkHubSessionTarget;
      let evidence: Extract<WorkHubSubmission, { kind: 'submitted' }>['evidence'];
      if (decision.kind === 'new_session') {
        const created = await deps.sessions.create({ name: workHubNewSessionName(input.text) });
        if (created.kind !== 'ordinary') {
          throw new Error('WorkHub can only create ordinary Sessions');
        }
        target = created.target;
        evidence = 'new_session';
      } else {
        target = decision.target;
        evidence = input.correction ? 'route_correction' : decision.evidence;
      }
      const targetSession = routable.find(
        (session) => session.target.sessionId === target.sessionId,
      );
      if (!targetSession && evidence !== 'new_session') {
        throw new Error('WorkHub target Session is unavailable');
      }
      if (targetSession?.state === 'waiting_for_user') {
        return {
          kind: 'waiting',
          strategyId: WORKHUB_ROUTING_STRATEGY_ID,
          requestId: input.requestId,
          text: input.text,
          target,
        };
      }
      if (input.correction && !input.correction.steered) {
        await deps.sessions.stop(input.correction.from, input.correction.turnId);
      }
      const turn = await deps.sessions.submit(target, input.text);
      routePolicy.rememberTarget(target);
      if (input.correction) routePolicy.rememberCorrection(input.text, target);
      return {
        kind: 'submitted',
        strategyId: WORKHUB_ROUTING_STRATEGY_ID,
        requestId: input.requestId,
        target,
        turnId: turn.turnId,
        ...(turn.steered ? { steered: true as const } : {}),
        evidence,
        ...(input.correction ? { correctedFrom: input.correction.from } : {}),
      };
    },
  };
}
