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
import type { MakaTool } from '@maka/runtime/tool-runtime';
import { isSessionNotFoundError, type ExecutionStoresWriter } from '@maka/storage/execution-stores';
import type { RootTurnCoordinator } from './root-turn-coordinator.js';
import type { HostMessageCoordinator } from './message-coordinator.js';
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
  admission: SessionAdmissionGate;
  readTurnResult(sessionId: string, turnId: string): Promise<string>;
  acquireResidency(): { release(): void };
  onError(error: unknown): void;
}) {
  const { stores, executions, messages, admission, readTurnResult } = options;
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
    includeResult = true,
  ): Promise<WorkHubResultObservation | undefined> {
    try {
      // The lightweight sweep receives active assignments from listAssignments.
      // Delivery and tool reads still revalidate under both Session admissions.
      if (includeResult && !(await isActive(assignment))) return undefined;
      const disposition = await messages.readMessageExecutionDispositionAdmitted(
        assignment.targetSessionId,
        assignment.targetMessageId,
        lease,
      );
      if (disposition.kind === 'cancelled') {
        return {
          turnId: assignment.targetTurnId,
          runId: `message:${assignment.targetMessageId}`,
          eventKey: 'message_cancelled_before_execution',
          status: 'cancelled',
          result: 'The delegated message was cancelled before execution.',
          details: { abortSource: 'message_cancelled_before_execution' },
          sharedTurn: false,
        };
      }
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
            'The delegated task needs user input. This existing execution is waiting for an interaction in the original task. Handle it there before sending another instruction.',
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
      const answer = includeResult
        ? await readTurnResult(assignment.targetSessionId, identity.turnId)
        : '';
      return {
        turnId: identity.turnId,
        runId: identity.runId,
        eventKey: snapshot.terminalEventId,
        status: snapshot.status,
        result: answer,
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
    includeResult = true,
  ) {
    return lease
      ? inspectLocked(assignment, lease, includeResult)
      : admission.runMany([WORKHUB_COORDINATION_SESSION_ID, assignment.targetSessionId], (lane) =>
          inspectLocked(assignment, lane, includeResult),
        );
  }
  const coordinator = new HostWorkHubResultCoordinator({
    listAssignments,
    inspect,
    deliver: (origin, prepare) => executions.startWorkHubResult(origin, prepare),
    acquireResidency: options.acquireResidency,
    onError: options.onError,
  });
  function notify(sessionId: string): void {
    coordinator.notify(sessionId);
  }
  const parameters = z
    .object({
      actionId: z.string().min(1),
      operation: z.literal('read').default('read'),
      offset: z.number().int().nonnegative().default(0),
    })
    .strict();
  const tool: MakaTool<z.infer<typeof parameters>> = {
    name: 'WorkHubResult',
    description:
      'Read a delegated task result in pages. For missing information, ask in WorkHub and send the answer to the target as a subsequent instruction. Use actionId from a Host result notification. Never use this tool to approve permissions. The read operation returns Unicode character offsets.',
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
    },
  };
  // Exposed for the archive guard: the receipt read needs the same observation
  // (and therefore the same event identity) delivery itself is keyed on.
  return { coordinator, tool, notify, inspect };
}
