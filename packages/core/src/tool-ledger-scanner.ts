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
  | 'event_order_conflict'
  | 'parent_operation_missing'
  | 'parent_identity_conflict'
  | 'parent_dependency_cycle';

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
 * It deliberately does NOT cover a ledger dependency closure that is already
 * corrupt. That refusal rejects well-formed candidates because of damage in
 * the facts they depend on, so "the store is healthy for this run" is false and
 * the run must keep failing closed — see `ToolLedgerCorruptionError`, which is
 * a plain durability failure and is classified as one.
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
 * The selected tool dependency closure is already corrupt, so it refuses a
 * candidate that has nothing wrong with it. Unlike `ToolLedgerRejectionError`
 * this is not a producer bug. The affected run stays on the fail-closed path;
 * unrelated closures remain writable and explicit full-ledger audit owns
 * discovery outside the active closure.
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

/** Operation identities whose invocation closure must accompany these facts. */
export function referencedToolOperationIds(events: readonly RuntimeEvent[]): Set<string> {
  const operationIds = new Set<string>();
  for (const event of events) {
    const dispatchOperationId = event.actions?.toolDispatch?.operationId;
    const recoveryOperationId = event.actions?.toolRecovery?.payload.operationId;
    if (dispatchOperationId) operationIds.add(dispatchOperationId);
    if (recoveryOperationId) operationIds.add(recoveryOperationId);
    if (event.refs?.operationId) operationIds.add(event.refs.operationId);
    if (event.refs?.parentOperationId) operationIds.add(event.refs.parentOperationId);
  }
  return operationIds;
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

export type ToolLedgerTransitionFailure = Extract<ToolLedgerTransitionValidation, { ok: false }>;

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
  if (event.actions?.managedMutationTerminal !== undefined) {
    return { ok: false, code: 'reserved_tool_boundary_fact', eventId: event.id };
  }
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
}): { ok: true } | ({ source: 'existing' | 'candidate' } & ToolLedgerTransitionFailure) {
  const reducer = new ToolLedgerReducer(input.existingEvents);
  const existing = reducer.scan();
  if (existing.hasCorruption) {
    return { source: 'existing', ...issueValidation(existing.issues[0]!) };
  }

  const candidates: RuntimeEvent[] = [];
  for (const candidate of input.candidateEvents) {
    const prior = reducer.event(candidate.id);
    if (!prior) {
      candidates.push(candidate);
      continue;
    }
    if (!nodeUtil.isDeepStrictEqual(prior, candidate)) {
      return {
        ok: false,
        source: 'candidate',
        code: 'duplicate_event_id',
        eventId: candidate.id,
      };
    }
  }
  const shape = validateTransitionShape(candidates, input.expectedTransition);
  if (!shape.ok) return { source: 'candidate', ...shape };

  reducer.append(candidates);
  const issue = reducer.scan().issues[0];
  return issue ? { source: 'candidate', ...issueValidation(issue) } : { ok: true };
}

/**
 * Invocation-scoped interpretation shared by scans and prospective validation.
 * Each caller owns a fresh reducer; no state survives a validation call.
 */
class ToolLedgerReducer {
  private readonly operations: ToolLedgerScanOperation[] = [];
  private readonly issues: ToolLedgerIssue[] = [];
  private readonly eventsById = new Map<string, RuntimeEvent>();
  private readonly byToolCall = new Map<string, ToolLedgerScanOperation>();
  private readonly byOperation = new Map<string, ToolLedgerScanOperation>();
  private readonly invocationSpines = new Map<string, string>();

  constructor(events: readonly RuntimeEvent[]) {
    this.append(events);
  }

  scan(): ToolLedgerScanResult {
    const dependencyIssues = this.toolDependencyIssues();
    if (dependencyIssues.length === 0) {
      return {
        operations: this.operations,
        issues: this.issues,
        hasCorruption: this.issues.length > 0,
      };
    }
    const issuesByOperation = new Map<ToolLedgerScanOperation, ToolLedgerIssue[]>();
    for (const { operation, issue } of dependencyIssues) {
      const issues = issuesByOperation.get(operation);
      if (issues) issues.push(issue);
      else issuesByOperation.set(operation, [issue]);
    }
    return {
      operations: this.operations.map((operation) => {
        const dependency = issuesByOperation.get(operation);
        return dependency
          ? { ...operation, issues: [...operation.issues, ...dependency] }
          : operation;
      }),
      issues: [...this.issues, ...dependencyIssues.map(({ issue }) => issue)],
      hasCorruption: true,
    };
  }

  event(eventId: string): RuntimeEvent | undefined {
    return this.eventsById.get(eventId);
  }

  append(events: readonly RuntimeEvent[]): void {
    for (const event of events) this.consumeEvent(event);
  }

  private consumeEvent(event: RuntimeEvent): void {
    if (this.eventsById.has(event.id)) {
      this.addIssue(undefined, { code: 'duplicate_event_id', eventId: event.id });
      return;
    }
    this.eventsById.set(event.id, event);
    const spine = JSON.stringify([event.sessionId, event.runId, event.turnId]);
    const existingSpine = this.invocationSpines.get(event.invocationId);
    if (existingSpine !== undefined && existingSpine !== spine) {
      this.addIssue(undefined, {
        code: 'invocation_identity_conflict',
        eventId: event.id,
      });
    } else {
      this.invocationSpines.set(event.invocationId, spine);
    }
    const lane = validateToolLedgerEventLane(event);
    if (!lane.ok) {
      this.addIssue(undefined, { code: lane.code, eventId: lane.eventId });
      return;
    }
    if (event.partial) return;

    if (lane.lane === 'function_call') {
      const content = event.content;
      if (content?.kind !== 'function_call') return;
      const toolCallKey = toolCallIdentity(event.invocationId, content.id);
      const existing = this.byToolCall.get(toolCallKey);
      if (existing) {
        if (!existing.callEvent) {
          existing.callEvent = event;
          if (existing.toolName !== content.name) {
            this.addIssue(existing, {
              code: 'identity_conflict',
              eventId: event.id,
              toolCallId: content.id,
              ...(existing.operationId ? { operationId: existing.operationId } : {}),
            });
          }
          return;
        }
        this.addIssue(existing, {
          code: 'duplicate_call',
          eventId: event.id,
          toolCallId: content.id,
          ...(existing.operationId ? { operationId: existing.operationId } : {}),
        });
        return;
      }
      const operation: ToolLedgerScanOperation = {
        toolCallId: content.id,
        toolName: content.name,
        callEvent: event,
        reconcileEvents: [],
        decisionEvents: [],
        issues: [],
      };
      this.byToolCall.set(toolCallKey, operation);
      this.operations.push(operation);
      return;
    }

    if (lane.lane === 'tool_dispatch') {
      const dispatch = event.actions?.toolDispatch;
      if (!dispatch) return;
      const toolCallKey = toolCallIdentity(event.invocationId, dispatch.providerToolCallId);
      let operation = this.byToolCall.get(toolCallKey);
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
        this.byToolCall.set(toolCallKey, operation);
        this.operations.push(operation);
        this.addIssue(operation, {
          code: 'event_order_conflict',
          eventId: event.id,
          operationId: dispatch.operationId,
          toolCallId: dispatch.providerToolCallId,
        });
      } else if (operation.dispatchEvent) {
        this.addIssue(operation, {
          code: 'duplicate_dispatch',
          eventId: event.id,
          operationId: dispatch.operationId,
          toolCallId: dispatch.providerToolCallId,
        });
        return;
      }

      const existingOperation = this.byOperation.get(dispatch.operationId);
      if (existingOperation && existingOperation !== operation) {
        const issue: ToolLedgerIssue = {
          code: 'duplicate_operation',
          eventId: event.id,
          operationId: dispatch.operationId,
          toolCallId: dispatch.providerToolCallId,
        };
        this.issues.push(issue);
        existingOperation.issues.push(issue);
        operation.issues.push(issue);
        return;
      }

      operation.operationId = dispatch.operationId;
      operation.dispatchEvent = event;
      this.byOperation.set(dispatch.operationId, operation);
      if (
        operation.toolName !== dispatch.toolName ||
        event.refs?.operationId !== dispatch.operationId ||
        event.refs?.toolCallId !== dispatch.providerToolCallId ||
        (operation.callEvent !== undefined && !sameExecutionIdentity(operation.callEvent, event)) ||
        callRefsConflict(operation.callEvent, event)
      ) {
        this.addIssue(operation, {
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
          this.addIssue(operation, {
            code: 'canonical_args_hash_conflict',
            eventId: event.id,
            operationId: dispatch.operationId,
            toolCallId: dispatch.providerToolCallId,
          });
        }
      }
      if (operation.responseEvent) {
        this.addIssue(operation, {
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
          this.addIssue(operation, {
            code: 'identity_conflict',
            eventId: operation.responseEvent.id,
            operationId: dispatch.operationId,
            toolCallId: dispatch.providerToolCallId,
          });
        }
      }
      return;
    }

    if (lane.lane === 'function_response') {
      const content = event.content;
      if (content?.kind !== 'function_response') return;
      const toolCallKey = toolCallIdentity(event.invocationId, content.id);
      const operation = this.byToolCall.get(toolCallKey);
      if (!operation) {
        const orphan: ToolLedgerScanOperation = {
          toolCallId: content.id,
          toolName: content.name,
          responseEvent: event,
          reconcileEvents: [],
          decisionEvents: [],
          issues: [],
        };
        this.operations.push(orphan);
        this.byToolCall.set(toolCallKey, orphan);
        this.addIssue(orphan, {
          code: 'orphan_response',
          eventId: event.id,
          toolCallId: content.id,
        });
        return;
      }
      if (operation.responseEvent) {
        this.addIssue(operation, {
          code: 'duplicate_response',
          eventId: event.id,
          toolCallId: content.id,
          ...(operation.operationId ? { operationId: operation.operationId } : {}),
        });
        return;
      }
      operation.responseEvent = event;
      if (
        operation.toolName !== content.name ||
        !sameExecutionIdentity(operation.callEvent, event) ||
        (operation.operationId !== undefined &&
          (event.refs?.operationId !== operation.operationId ||
            event.refs.toolCallId !== operation.toolCallId))
      ) {
        this.addIssue(operation, {
          code: 'identity_conflict',
          eventId: event.id,
          toolCallId: content.id,
          ...(operation.operationId ? { operationId: operation.operationId } : {}),
        });
      }
      return;
    }

    if (lane.lane === 'reconcile_result' || lane.lane === 'recovery_decision') {
      const fact = event.actions?.toolRecovery;
      if (!fact) return;
      const operation = this.byOperation.get(fact.payload.operationId);
      if (!operation) {
        this.addIssue(undefined, {
          code: 'event_order_conflict',
          eventId: event.id,
          operationId: fact.payload.operationId,
          ...(event.refs?.toolCallId ? { toolCallId: event.refs.toolCallId } : {}),
        });
        return;
      }
      if (lane.lane === 'reconcile_result') operation.reconcileEvents.push(event);
      else operation.decisionEvents.push(event);
    }
  }

  private addIssue(operation: ToolLedgerScanOperation | undefined, issue: ToolLedgerIssue): void {
    this.issues.push(issue);
    if (operation) operation.issues.push(issue);
  }

  private toolDependencyIssues(): Array<{
    operation: ToolLedgerScanOperation;
    issue: ToolLedgerIssue;
  }> {
    const result: Array<{ operation: ToolLedgerScanOperation; issue: ToolLedgerIssue }> = [];
    const parents = new Map<ToolLedgerScanOperation, ToolLedgerScanOperation>();
    for (const operation of this.operations) {
      const dispatch = operation.dispatchEvent;
      const parentOperationId = dispatch?.refs?.parentOperationId;
      const parentToolCallId = dispatch?.refs?.parentToolCallId;
      if (!dispatch || !parentOperationId || !parentToolCallId) continue;
      const parent = this.byOperation.get(parentOperationId);
      if (!parent) {
        result.push({
          operation,
          issue: {
            code: 'parent_operation_missing',
            eventId: dispatch.id,
            ...(operation.operationId ? { operationId: operation.operationId } : {}),
            toolCallId: operation.toolCallId,
          },
        });
        continue;
      }
      if (parent.toolCallId !== parentToolCallId) {
        result.push({
          operation,
          issue: {
            code: 'parent_identity_conflict',
            eventId: dispatch.id,
            ...(operation.operationId ? { operationId: operation.operationId } : {}),
            toolCallId: operation.toolCallId,
          },
        });
        continue;
      }
      parents.set(operation, parent);
    }

    const state = new Map<ToolLedgerScanOperation, 'visiting' | 'visited'>();
    const stack: ToolLedgerScanOperation[] = [];
    const stackIndex = new Map<ToolLedgerScanOperation, number>();
    const cyclic = new Set<ToolLedgerScanOperation>();
    const visit = (operation: ToolLedgerScanOperation): void => {
      if (state.get(operation) === 'visited') return;
      state.set(operation, 'visiting');
      stackIndex.set(operation, stack.length);
      stack.push(operation);
      const parent = parents.get(operation);
      if (parent) {
        const parentState = state.get(parent);
        if (parentState === 'visiting') {
          const index = stackIndex.get(parent);
          if (index !== undefined) {
            for (let cursor = index; cursor < stack.length; cursor += 1) cyclic.add(stack[cursor]!);
          }
        } else if (parentState !== 'visited') {
          visit(parent);
        }
      }
      stack.pop();
      stackIndex.delete(operation);
      state.set(operation, 'visited');
    };
    for (const operation of parents.keys()) visit(operation);
    for (const operation of this.operations) {
      if (!cyclic.has(operation) || !operation.dispatchEvent) continue;
      result.push({
        operation,
        issue: {
          code: 'parent_dependency_cycle',
          eventId: operation.dispatchEvent.id,
          ...(operation.operationId ? { operationId: operation.operationId } : {}),
          toolCallId: operation.toolCallId,
        },
      });
    }
    return result;
  }
}

/**
 * Scans immutable RuntimeEvents once, in physical ledger order. Resolver,
 * projection rebuild and prospective writers all use the same reducer rules.
 */
export function scanToolLedger(events: readonly RuntimeEvent[]): ToolLedgerScanResult {
  return new ToolLedgerReducer(events).scan();
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

function issueValidation(issue: ToolLedgerIssue): ToolLedgerTransitionFailure {
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

function callRefsConflict(call: RuntimeEvent | undefined, dispatch: RuntimeEvent): boolean {
  if (!call?.refs) return false;
  const expected = dispatch.actions?.toolDispatch;
  if (!expected) return false;
  if (
    (call.refs.operationId !== undefined && call.refs.operationId !== expected.operationId) ||
    (call.refs.toolCallId !== undefined && call.refs.toolCallId !== expected.providerToolCallId)
  ) {
    return true;
  }
  const callHasParent =
    call.refs.parentOperationId !== undefined || call.refs.parentToolCallId !== undefined;
  return (
    callHasParent &&
    (call.refs.parentOperationId !== dispatch.refs?.parentOperationId ||
      call.refs.parentToolCallId !== dispatch.refs?.parentToolCallId)
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
  const keys = Object.keys(actions);
  if (
    keys.length === 0 ||
    keys.some((key) => key !== 'stateDelta' && key !== 'managedMutationTerminal')
  ) {
    return false;
  }
  const stateDelta = actions.stateDelta;
  return stateDelta === undefined
    ? actions.managedMutationTerminal !== undefined
    : hasOnlyKeys(stateDelta, ['durationMs']) &&
        typeof stateDelta.durationMs === 'number' &&
        Number.isFinite(stateDelta.durationMs);
}

function toolCallIdentity(invocationId: string, toolCallId: string): string {
  return JSON.stringify([invocationId, toolCallId]);
}
