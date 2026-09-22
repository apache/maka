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

import { z } from 'zod';
import {
  WORKHUB_COORDINATION_SESSION_ID,
  type WorkHubDelegationAssignedMessage,
} from '@maka/core/session';
import type { SessionManager } from '@maka/runtime/session-manager';
import type { MakaTool } from '@maka/runtime/tool-runtime';
import { isSessionNotFoundError, type ExecutionStoresWriter } from '@maka/storage/execution-stores';
import type { RootTurnCoordinator } from './root-turn-coordinator.js';
import type { HostMessageCoordinator } from './message-coordinator.js';
import type { HostInteractionCoordinator } from './interaction-coordinator.js';
import type { SessionAdmissionGate, SessionAdmissionLease } from './session-admission-gate.js';
import { projectSessionInteractions } from './interaction-projection.js';
import {
  HostWorkHubResultCoordinator,
  type WorkHubResultObservation,
} from './workhub-result-coordinator.js';

export function createWorkHubResultRuntime(options: {
  stores: ExecutionStoresWriter<'interactive'>;
  executions: RootTurnCoordinator;
  messages: HostMessageCoordinator;
  interactions: HostInteractionCoordinator;
  admission: SessionAdmissionGate;
  manager: Pick<SessionManager, 'getMessages'>;
  acquireResidency(): { release(): void };
  onError(error: unknown): void;
}) {
  const { stores, executions, messages, admission, manager } = options;
  async function listAssignments() {
    const targets = (await stores.sessionStore.listHeaders())
      .filter((h) => h.id !== WORKHUB_COORDINATION_SESSION_ID && !h.isArchived)
      .map((h) => h.id);
    const result: WorkHubDelegationAssignedMessage[] = [];
    for (let i = 0; i < targets.length; i += 256)
      result.push(
        ...(await stores.sessionStore.readActiveWorkHubAssignmentsByTarget(
          targets.slice(i, i + 256),
        )),
      );
    return result.filter((a) => a.returnResults);
  }
  async function pending(sessionId: string) {
    return projectSessionInteractions(
      await stores.interactionStore.listSessionPending(sessionId),
      await stores.sessionStore.listPendingSandboxBoundaryRequests(sessionId),
    ).pending;
  }
  async function isActive(assignment: WorkHubDelegationAssignedMessage): Promise<boolean> {
    try {
      const header = await stores.sessionStore.readHeaderSnapshot(assignment.targetSessionId);
      if (header.isArchived) return false;
      const active = await stores.sessionStore.readActiveWorkHubAssignmentsByTarget([
        assignment.targetSessionId,
      ]);
      if (!active.some((a) => a.delegationId === assignment.delegationId && a.returnResults))
        return false;
      // Retirement intent takes precedence even before its final receipt exists.
      if (await stores.sessionStore.readWorkHubReplacement(assignment.delegationId)) return false;
      if (await stores.sessionStore.readWorkHubStopRequest(assignment.delegationId)) {
        const resolution = await stores.sessionStore.readWorkHubStopResolution(
          assignment.delegationId,
        );
        if (resolution?.outcome !== 'not_owned') return false;
      }
      return true;
    } catch (error) {
      if (isSessionNotFoundError(error)) return false;
      throw error;
    }
  }
  async function inspectLocked(
    assignment: WorkHubDelegationAssignedMessage,
    lease: SessionAdmissionLease,
  ): Promise<WorkHubResultObservation | undefined> {
    try {
      if (!(await isActive(assignment))) return undefined;
      const disposition = await messages.readMessageExecutionDispositionAdmitted(
        assignment.targetSessionId,
        assignment.targetMessageId,
        lease,
      );
      if (disposition.kind !== 'owned_root' && disposition.kind !== 'shared_turn') return undefined;
      const identity = await executions.readLatestRootTurnLineage({
        sessionId: assignment.targetSessionId,
        turnId: disposition.turnId,
        runId: disposition.runId,
      });
      const snapshot = await executions.read(identity);
      const sharedTurn = disposition.kind === 'shared_turn';
      if (snapshot.status === 'waiting_for_user' || snapshot.status === 'running') {
        const requests = (await pending(assignment.targetSessionId)).filter(
          (p) => p.turnId === identity.turnId,
        );
        if (!requests.length) return undefined;
        return {
          turnId: identity.turnId,
          runId: identity.runId,
          eventKey:
            'interaction:' +
            requests
              .map((p) => p.interactionId)
              .sort()
              .join(','),
          status: 'waiting_for_user',
          result:
            'The delegated task needs user input. Questions may be presented in WorkHub with WorkHubResult; approvals must be handled at the original task.',
          details: requests.map((p) => ({ interactionId: p.interactionId, request: p.request })),
          sharedTurn,
        };
      }
      if (
        snapshot.status !== 'completed' &&
        snapshot.status !== 'failed' &&
        snapshot.status !== 'cancelled'
      )
        return undefined;
      const transcript = await manager.getMessages(assignment.targetSessionId);
      const answer = [...transcript]
        .reverse()
        .find((m) => m.type === 'assistant' && m.turnId === identity.turnId && m.text.trim());
      return {
        turnId: identity.turnId,
        runId: identity.runId,
        eventKey: snapshot.terminalEventId,
        status: snapshot.status,
        result: answer?.type === 'assistant' ? answer.text : '',
        details:
          snapshot.status === 'failed'
            ? {
                failureClass: snapshot.failureClass ?? null,
                message: snapshot.failureMessage ?? null,
              }
            : snapshot.status === 'cancelled'
              ? { abortSource: snapshot.abortSource ?? null }
              : null,
        sharedTurn,
      };
    } catch (error) {
      if (isSessionNotFoundError(error)) return undefined;
      throw error;
    }
  }
  async function inspect(
    assignment: WorkHubDelegationAssignedMessage,
    lease?: SessionAdmissionLease,
  ) {
    return lease
      ? inspectLocked(assignment, lease)
      : admission.runMany([WORKHUB_COORDINATION_SESSION_ID, assignment.targetSessionId], (lane) =>
          inspectLocked(assignment, lane),
        );
  }
  const coordinator = new HostWorkHubResultCoordinator({
    listAssignments,
    inspect,
    deliver: (origin, prepare) => executions.startWorkHubResult(origin, prepare),
    acquireResidency: options.acquireResidency,
    onError: options.onError,
  });
  const parameters = z
    .object({
      actionId: z.string().min(1),
      operation: z.enum(['read', 'ask_question']).default('read'),
      interactionId: z.string().optional(),
      offset: z.number().int().nonnegative().default(0),
    })
    .strict();
  const tool: MakaTool<z.infer<typeof parameters>> = {
    name: 'WorkHubResult',
    description:
      'Read a delegated task result in pages, or present its exact pending question to the user here and forward their actual answer. Use actionId from a Host result notification. Never use this tool to approve permissions. The read operation returns Unicode character offsets.',
    parameters,
    categoryHint: 'read',
    recoveryMode: 'never_auto_retry',
    async impl(raw, ctx) {
      const input = parameters.parse(raw);
      if (ctx.sessionId !== WORKHUB_COORDINATION_SESSION_ID)
        throw new Error('WorkHub result access requires the coordination Session');
      const assignment = await stores.sessionStore.readWorkHubAssignment(input.actionId);
      if (!assignment?.returnResults) throw new Error('Unknown WorkHub result assignment');
      const observation = await inspect(assignment);
      if (!observation) {
        if (input.operation !== 'read') throw new Error('No pending delegated question');
        const active = await admission.runMany(
          [WORKHUB_COORDINATION_SESSION_ID, assignment.targetSessionId],
          () => isActive(assignment),
        );
        return active
          ? {
              status: 'pending',
              targetSessionId: assignment.targetSessionId,
              message:
                'No result is ready yet. The Host will automatically notify WorkHub when a result or user question is available. Acknowledge the delegation and end this response; do not poll tools to wait.',
            }
          : { status: 'obsolete', targetSessionId: assignment.targetSessionId };
      }
      if (input.operation === 'read') {
        const chars = Array.from(observation.result),
          end = input.offset + 16000;
        return {
          ...observation,
          result: chars.slice(input.offset, end).join(''),
          nextOffset: end < chars.length ? end : null,
        };
      }
      if (!input.interactionId || !ctx.askUserQuestion)
        throw new Error('A pending question and interactive WorkHub are required');
      const request = await admission.run(assignment.targetSessionId, async () =>
        (await pending(assignment.targetSessionId)).find(
          (p) => p.interactionId === input.interactionId && p.turnId === observation.turnId,
        ),
      );
      if (!request || request.request.kind !== 'question')
        throw new Error('Only pending user questions can be relayed');
      const answer = await ctx.askUserQuestion(
        request.request.questions.map((q) => ({
          question: q.question,
          options: q.options.map((o) => ({ ...o })),
        })),
      );
      ctx.abortSignal.throwIfAborted();
      // Recheck the original delegation after the human responds. A late answer
      // must not revive a cancelled/replaced task or answer another interaction.
      const outcome = await admission.runMany(
        [WORKHUB_COORDINATION_SESSION_ID, assignment.targetSessionId],
        async (lease) => {
          const current = await inspectLocked(assignment, lease);
          if (!current || current.turnId !== request.turnId) return undefined;
          return options.interactions.answerDelegatedQuestion(
            {
              sessionId: assignment.targetSessionId,
              interactionId: request.interactionId,
              answer: { kind: 'question', answers: answer.answers.map((a) => a.answer) },
            },
            lease,
          );
        },
      );
      if (!outcome) return { status: 'obsolete' };
      if (!outcome.ok) throw new Error(outcome.error.message);
      coordinator.notify(assignment.targetSessionId);
      return { status: outcome.result.status, targetSessionId: assignment.targetSessionId };
    },
  };
  return { coordinator, tool };
}
