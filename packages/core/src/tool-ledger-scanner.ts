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

import * as nodeUtil from 'node:util';
import type { RuntimeEvent } from './runtime-event.js';
import { canonicalToolArgsHash } from './tool-args-identity.js';

export type ToolLedgerLane =
  | 'ordinary'
  | 'function_call'
  | 'tool_dispatch'
  | 'function_response'
  | 'reconcile_result'
  | 'recovery_decision';

export type ToolLedgerIssueCode =
  | 'duplicate_event_id'
  | 'semantic_lane_conflict'
  | 'duplicate_call'
  | 'duplicate_operation'
  | 'duplicate_dispatch'
  | 'duplicate_response'
  | 'orphan_dispatch'
  | 'orphan_response'
  | 'canonical_args_hash_conflict'
  | 'invocation_identity_conflict'
  | 'identity_conflict'
  | 'event_order_conflict';

export interface ToolLedgerIssue {
  code: ToolLedgerIssueCode;
  eventId: string;
  operationId?: string;
  toolCallId?: string;
}

/**
 * The ledger refused a CANDIDATE event because that event was wrong — the store
 * itself is healthy and still readable. The distinction decides what a run may
 * do next: when the ledger can no longer be trusted the run latches its store
 * unavailable and fails closed, but latching it for a bad candidate costs the
 * run its own terminal write, which is how one refused append left a run stuck
 * at `running` with no terminal event at all (#2234). This error is always a
 * producer bug: something emitted a fact the ledger's invariants forbid.
 *
 * It deliberately does NOT cover a ledger that is already corrupt. That refusal
 * rejects well-formed candidates because of damage elsewhere in the workspace,
 * so "the store is healthy" is false and the run must keep failing closed —
 * see `ToolLedgerCorruptionError`, which is a plain durability failure and is
 * classified as one.
 */
export class ToolLedgerRejectionError extends Error {
  readonly name = 'ToolLedgerRejectionError';

  constructor(
    readonly code: ToolLedgerRejectionCode,
    readonly eventId: string,
  ) {
    super(`Tool ledger transition rejected: ${code} at ${eventId}`);
  }
}

/**
 * The ledger the store already holds is corrupt, so it refuses writes that have
 * nothing wrong with them. Unlike `ToolLedgerRejectionError` this is not a
 * producer bug and the store is not usable: nothing the run emits next can be
 * trusted to land, so it stays on the fail-closed path.
 */
export class ToolLedgerCorruptionError extends Error {
  readonly name = 'ToolLedgerCorruptionError';

  constructor(
    readonly code: ToolLedgerRejectionCode,
    readonly eventId: string,
  ) {
    super(`Tool ledger is corrupt: ${code} at ${eventId}`);
  }
}

export interface ToolLedgerScanOperation {
  toolCallId: string;
  toolName?: string;
  operationId?: string;
  callEvent?: RuntimeEvent;
  dispatchEvent?: RuntimeEvent;
  responseEvent?: RuntimeEvent;
  reconcileEvents: RuntimeEvent[];
  decisionEvents: RuntimeEvent[];
  issues: ToolLedgerIssue[];
}

export interface ToolLedgerScanResult {
  operations: ToolLedgerScanOperation[];
  issues: ToolLedgerIssue[];
  hasCorruption: boolean;
}

export type ToolLedgerLaneValidation =
  | { ok: true; lane: ToolLedgerLane }
  | { ok: false; code: 'semantic_lane_conflict'; eventId: string };

export type GenericToolLedgerAppendValidation =
  | { ok: true }
  | {
      ok: false;
      code: 'semantic_lane_conflict' | 'reserved_tool_boundary_fact' | 'reserved_recovery_fact';
      eventId: string;
    };

export type ToolLedgerTransitionKind =
  | 'generic_append'
  | 't1_prepare'
  | 't2_outcome'
  | 'recovery_bundle';

/** Every reason the ledger has for refusing a candidate event. */
export type ToolLedgerRejectionCode =
  | ToolLedgerIssueCode
  | 'semantic_lane_conflict'
  | 'reserved_tool_boundary_fact'
  | 'reserved_recovery_fact'
  | 'transition_shape_conflict';

export type ToolLedgerTransitionValidation =
  | { ok: true }
  | {
      ok: false;
      code: ToolLedgerRejectionCode;
      eventId: string;
      operationId?: string;
      toolCallId?: string;
    };

/**
 * Enforces the semantic boundary for durable tool-ledger facts.
 *
 * RuntimeEvent's structural schema intentionally permits content and actions
 * to coexist. Tool persistence is narrower: call, dispatch, response and each
 * recovery fact are distinct facts so one physical row cannot be interpreted
 * differently by online projection, rebuild, and recovery.
 */
export function validateToolLedgerEventLane(event: RuntimeEvent): ToolLedgerLaneValidation {
  const recoveryKind = event.actions?.toolRecovery?.kind;
  const lanes = [
    event.content?.kind === 'function_call' ? 'function_call' : undefined,
    event.actions?.toolDispatch ? 'tool_dispatch' : undefined,
    event.content?.kind === 'function_response' ? 'function_response' : undefined,
    recoveryKind === 'maka.tool.reconcile_result' ? 'reconcile_result' : undefined,
    recoveryKind === 'maka.tool.recovery_decision' ? 'recovery_decision' : undefined,
  ].filter((lane): lane is Exclude<ToolLedgerLane, 'ordinary'> => lane !== undefined);

  if (lanes.length === 0) return { ok: true, lane: 'ordinary' };
  if (lanes.length !== 1 || !matchesLaneEnvelope(event, lanes[0])) {
    return { ok: false, code: 'semantic_lane_conflict', eventId: event.id };
  }
  return { ok: true, lane: lanes[0] };
}

/**
 * Generic RuntimeEvent append/import APIs may carry ordinary conversation
 * events and unbound provider calls/responses. They are not an alternate
 * authority for T1 dispatch, operation-bound T2 outcome, or recovery facts.
 */
export function validateGenericToolLedgerAppend(
  event: RuntimeEvent,
): GenericToolLedgerAppendValidation {
  const lane = validateToolLedgerEventLane(event);
  if (!lane.ok) return lane;
  if (lane.lane === 'reconcile_result' || lane.lane === 'recovery_decision') {
    return { ok: false, code: 'reserved_recovery_fact', eventId: event.id };
  }
  if (
    lane.lane === 'tool_dispatch' ||
    (lane.lane === 'function_response' && event.refs?.operationId !== undefined)
  ) {
    return { ok: false, code: 'reserved_tool_boundary_fact', eventId: event.id };
  }
  return { ok: true };
}

/**
 * Validates the ledger that would exist after one writer transaction.
 *
 * Event-local lane checks cannot detect duplicate calls, a response that
 * becomes invalid when a later dispatch binds the operation, or other
 * prefix-dependent corruption. Every tool-bearing writer uses this function
 * before committing its candidate events.
 */
export function validateToolLedgerTransition(input: {
  existingEvents: readonly RuntimeEvent[];
  candidateEvents: readonly RuntimeEvent[];
  expectedTransition: ToolLedgerTransitionKind;
}): ToolLedgerTransitionValidation {
  const existing = scanToolLedger(input.existingEvents);
  if (existing.hasCorruption) return issueValidation(existing.issues[0]!);

  const existingById = new Map(input.existingEvents.map((event) => [event.id, event]));
  const candidates: RuntimeEvent[] = [];
  for (const candidate of input.candidateEvents) {
    const prior = existingById.get(candidate.id);
    if (!prior) {
      candidates.push(candidate);
      continue;
    }
    if (!nodeUtil.isDeepStrictEqual(prior, candidate)) {
      return { ok: false, code: 'duplicate_event_id', eventId: candidate.id };
    }
  }
  const shape = validateTransitionShape(candidates, input.expectedTransition);
  if (!shape.ok) return shape;

  const prospective = scanToolLedger([...input.existingEvents, ...candidates]);
  if (prospective.hasCorruption) return issueValidation(prospective.issues[0]!);
  return { ok: true };
}

/**
 * Scans immutable RuntimeEvents once, in physical ledger order. It owns the
 * duplicate/order/identity interpretation shared by Resolver and projection
 * rebuild; neither consumer may rebuild these maps independently.
 */
export function scanToolLedger(events: readonly RuntimeEvent[]): ToolLedgerScanResult {
  const operations: ToolLedgerScanOperation[] = [];
  const issues: ToolLedgerIssue[] = [];
  const seenEventIds = new Set<string>();
  const byToolCall = new Map<string, ToolLedgerScanOperation>();
  const byOperation = new Map<string, ToolLedgerScanOperation>();
  const invocationSpines = new Map<string, string>();

  const addIssue = (operation: ToolLedgerScanOperation | undefined, issue: ToolLedgerIssue) => {
    issues.push(issue);
    operation?.issues.push(issue);
  };

  for (const event of events) {
    if (seenEventIds.has(event.id)) {
      addIssue(undefined, { code: 'duplicate_event_id', eventId: event.id });
      continue;
    }
    seenEventIds.add(event.id);
    const spine = JSON.stringify([event.sessionId, event.runId, event.turnId]);
    const existingSpine = invocationSpines.get(event.invocationId);
    if (existingSpine !== undefined && existingSpine !== spine) {
      addIssue(undefined, {
        code: 'invocation_identity_conflict',
        eventId: event.id,
      });
    } else {
      invocationSpines.set(event.invocationId, spine);
    }
    const lane = validateToolLedgerEventLane(event);
    if (!lane.ok) {
      addIssue(undefined, { code: lane.code, eventId: lane.eventId });
      continue;
    }
    if (event.partial) continue;

    if (lane.lane === 'function_call') {
      const content = event.content;
      if (content?.kind !== 'function_call') continue;
      const toolCallKey = toolCallIdentity(event.invocationId, content.id);
      const existing = byToolCall.get(toolCallKey);
      if (existing) {
        if (!existing.callEvent) {
          existing.callEvent = event;
          if (existing.toolName !== content.name) {
            addIssue(existing, {
              code: 'identity_conflict',
              eventId: event.id,
              toolCallId: content.id,
              ...(existing.operationId ? { operationId: existing.operationId } : {}),
            });
          }
          continue;
        }
        addIssue(existing, {
          code: 'duplicate_call',
          eventId: event.id,
          toolCallId: content.id,
          ...(existing.operationId ? { operationId: existing.operationId } : {}),
        });
        continue;
      }
      const operation: ToolLedgerScanOperation = {
        toolCallId: content.id,
        toolName: content.name,
        callEvent: event,
        reconcileEvents: [],
        decisionEvents: [],
        issues: [],
      };
      byToolCall.set(toolCallKey, operation);
      operations.push(operation);
      continue;
    }

    if (lane.lane === 'tool_dispatch') {
      const dispatch = event.actions?.toolDispatch;
      if (!dispatch) continue;
      const toolCallKey = toolCallIdentity(event.invocationId, dispatch.providerToolCallId);
      let operation = byToolCall.get(toolCallKey);
      if (!operation) {
        operation = {
          toolCallId: dispatch.providerToolCallId,
          toolName: dispatch.toolName,
          operationId: dispatch.operationId,
          dispatchEvent: event,
          reconcileEvents: [],
          decisionEvents: [],
          issues: [],
        };
        byToolCall.set(toolCallKey, operation);
        operations.push(operation);
        addIssue(operation, {
          code: 'event_order_conflict',
          eventId: event.id,
          operationId: dispatch.operationId,
          toolCallId: dispatch.providerToolCallId,
        });
      } else if (operation.dispatchEvent) {
        addIssue(operation, {
          code: 'duplicate_dispatch',
          eventId: event.id,
          operationId: dispatch.operationId,
          toolCallId: dispatch.providerToolCallId,
        });
        continue;
      }

      const existingOperation = byOperation.get(dispatch.operationId);
      if (existingOperation && existingOperation !== operation) {
        const issue: ToolLedgerIssue = {
          code: 'duplicate_operation',
          eventId: event.id,
          operationId: dispatch.operationId,
          toolCallId: dispatch.providerToolCallId,
        };
        issues.push(issue);
        existingOperation.issues.push(issue);
        operation.issues.push(issue);
        continue;
      }

      operation.operationId = dispatch.operationId;
      operation.dispatchEvent = event;
      byOperation.set(dispatch.operationId, operation);
      if (
        operation.toolName !== dispatch.toolName ||
        event.refs?.operationId !== dispatch.operationId ||
        event.refs?.toolCallId !== dispatch.providerToolCallId ||
        (operation.callEvent !== undefined && !sameExecutionIdentity(operation.callEvent, event))
      ) {
        addIssue(operation, {
          code: 'identity_conflict',
          eventId: event.id,
          operationId: dispatch.operationId,
          toolCallId: dispatch.providerToolCallId,
        });
      }
      const callContent = operation.callEvent?.content;
      if (callContent?.kind === 'function_call') {
        let canonicalArgsHash: string | undefined;
        try {
          canonicalArgsHash = canonicalToolArgsHash(callContent.name, callContent.args);
        } catch {
          // A provider call that is not strict JSON cannot authenticate T1.
        }
        if (canonicalArgsHash !== dispatch.canonicalArgsHash) {
          addIssue(operation, {
            code: 'canonical_args_hash_conflict',
            eventId: event.id,
            operationId: dispatch.operationId,
            toolCallId: dispatch.providerToolCallId,
          });
        }
      }
      if (operation.responseEvent) {
        addIssue(operation, {
          code: 'event_order_conflict',
          eventId: event.id,
          operationId: dispatch.operationId,
          toolCallId: dispatch.providerToolCallId,
        });
        if (
          operation.responseEvent.refs?.operationId !== dispatch.operationId ||
          operation.responseEvent.refs?.toolCallId !== dispatch.providerToolCallId ||
          !sameExecutionIdentity(event, operation.responseEvent)
        ) {
          addIssue(operation, {
            code: 'identity_conflict',
            eventId: operation.responseEvent.id,
            operationId: dispatch.operationId,
            toolCallId: dispatch.providerToolCallId,
          });
        }
      }
      continue;
    }

    if (lane.lane === 'function_response') {
      const content = event.content;
      if (content?.kind !== 'function_response') continue;
      const toolCallKey = toolCallIdentity(event.invocationId, content.id);
      const operation = byToolCall.get(toolCallKey);
      if (!operation) {
        const orphan: ToolLedgerScanOperation = {
          toolCallId: content.id,
          toolName: content.name,
          responseEvent: event,
          reconcileEvents: [],
          decisionEvents: [],
          issues: [],
        };
        operations.push(orphan);
        byToolCall.set(toolCallKey, orphan);
        addIssue(orphan, {
          code: 'orphan_response',
          eventId: event.id,
          toolCallId: content.id,
        });
        continue;
      }
      if (operation.responseEvent) {
        addIssue(operation, {
          code: 'duplicate_response',
          eventId: event.id,
          toolCallId: content.id,
          ...(operation.operationId ? { operationId: operation.operationId } : {}),
        });
        continue;
      }
      operation.responseEvent = event;
      if (
        operation.toolName !== content.name ||
        !sameExecutionIdentity(operation.callEvent, event) ||
        (operation.operationId !== undefined &&
          (event.refs?.operationId !== operation.operationId ||
            event.refs.toolCallId !== operation.toolCallId))
      ) {
        addIssue(operation, {
          code: 'identity_conflict',
          eventId: event.id,
          toolCallId: content.id,
          ...(operation.operationId ? { operationId: operation.operationId } : {}),
        });
      }
      continue;
    }

    if (lane.lane === 'reconcile_result' || lane.lane === 'recovery_decision') {
      const fact = event.actions?.toolRecovery;
      if (!fact) continue;
      const operation = byOperation.get(fact.payload.operationId);
      if (!operation) {
        addIssue(undefined, {
          code: 'event_order_conflict',
          eventId: event.id,
          operationId: fact.payload.operationId,
          ...(event.refs?.toolCallId ? { toolCallId: event.refs.toolCallId } : {}),
        });
        continue;
      }
      if (lane.lane === 'reconcile_result') operation.reconcileEvents.push(event);
      else operation.decisionEvents.push(event);
    }
  }

  return { operations, issues, hasCorruption: issues.length > 0 };
}

function matchesLaneEnvelope(
  event: RuntimeEvent,
  lane: Exclude<ToolLedgerLane, 'ordinary'>,
): boolean {
  if (event.partial || event.status !== undefined || event.branch !== undefined) return false;
  switch (lane) {
    case 'function_call':
      return (
        event.role === 'model' &&
        event.author === 'agent' &&
        matchesFunctionCallActions(event.actions)
      );
    case 'function_response':
      return (
        event.role === 'tool' &&
        event.author === 'tool' &&
        matchesFunctionResponseActions(event.actions)
      );
    case 'tool_dispatch':
      return (
        event.content === undefined &&
        event.role === 'system' &&
        event.author === 'system' &&
        hasOnlyKeys(event.actions, ['toolDispatch']) &&
        (hasOnlyKeys(event.refs, ['operationId', 'toolCallId']) ||
          hasOnlyKeys(event.refs, [
            'operationId',
            'toolCallId',
            'parentToolCallId',
            'parentOperationId',
          ]))
      );
    case 'reconcile_result':
    case 'recovery_decision':
      return (
        event.content === undefined &&
        event.role === 'system' &&
        event.author === 'system' &&
        hasOnlyKeys(event.actions, ['toolRecovery']) &&
        hasOnlyKeys(event.refs, ['operationId', 'toolCallId'])
      );
  }
}

function validateTransitionShape(
  events: readonly RuntimeEvent[],
  expectedTransition: ToolLedgerTransitionKind,
): ToolLedgerTransitionValidation {
  if (events.length === 0) return { ok: true };
  const lanes = events.map((event) => validateToolLedgerEventLane(event));
  const invalid = lanes.find((lane) => !lane.ok);
  if (invalid && !invalid.ok) return invalid;

  if (expectedTransition === 'generic_append') {
    for (const event of events) {
      const validation = validateGenericToolLedgerAppend(event);
      if (!validation.ok) return validation;
    }
    return { ok: true };
  }

  const actual = lanes.map((lane) => (lane.ok ? lane.lane : 'ordinary'));
  const valid =
    (expectedTransition === 't1_prepare' &&
      ((actual.length === 2 && actual[0] === 'function_call' && actual[1] === 'tool_dispatch') ||
        (actual.length === 1 && actual[0] === 'tool_dispatch'))) ||
    (expectedTransition === 't2_outcome' &&
      actual.length === 1 &&
      actual[0] === 'function_response' &&
      events[0]?.refs?.operationId !== undefined) ||
    (expectedTransition === 'recovery_bundle' &&
      ((actual.length === 2 &&
        actual[0] === 'reconcile_result' &&
        actual[1] === 'recovery_decision') ||
        (actual.length === 3 &&
          actual[0] === 'reconcile_result' &&
          actual[1] === 'function_response' &&
          actual[2] === 'recovery_decision')));
  if (valid) return { ok: true };
  return {
    ok: false,
    code: 'transition_shape_conflict',
    eventId: events[0]?.id ?? 'unknown',
  };
}

function issueValidation(issue: ToolLedgerIssue): ToolLedgerTransitionValidation {
  return {
    ok: false,
    code: issue.code,
    eventId: issue.eventId,
    ...(issue.operationId ? { operationId: issue.operationId } : {}),
    ...(issue.toolCallId ? { toolCallId: issue.toolCallId } : {}),
  };
}

function sameExecutionIdentity(first: RuntimeEvent | undefined, second: RuntimeEvent): boolean {
  return (
    first !== undefined &&
    first.sessionId === second.sessionId &&
    first.invocationId === second.invocationId &&
    first.runId === second.runId &&
    first.turnId === second.turnId
  );
}

function hasOnlyKeys(value: object | undefined, expected: readonly string[]): boolean {
  if (!value) return false;
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function matchesFunctionCallActions(actions: RuntimeEvent['actions']): boolean {
  if (!actions) return true;
  if (!hasOnlyKeys(actions, ['stateDelta'])) return false;
  const stateDelta = actions.stateDelta;
  if (!stateDelta) return false;
  const keys = Object.keys(stateDelta);
  return (
    keys.length > 0 &&
    keys.every(
      (key) =>
        ['activityKind', 'displayName', 'intent'].includes(key) &&
        typeof stateDelta[key] === 'string',
    )
  );
}

function matchesFunctionResponseActions(actions: RuntimeEvent['actions']): boolean {
  if (!actions) return true;
  if (!hasOnlyKeys(actions, ['stateDelta'])) return false;
  const stateDelta = actions.stateDelta;
  return (
    stateDelta !== undefined &&
    hasOnlyKeys(stateDelta, ['durationMs']) &&
    typeof stateDelta.durationMs === 'number' &&
    Number.isFinite(stateDelta.durationMs)
  );
}

function toolCallIdentity(invocationId: string, toolCallId: string): string {
  return JSON.stringify([invocationId, toolCallId]);
}
