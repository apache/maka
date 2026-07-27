import type { RuntimeEvent } from './runtime-event.js';

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
  | 'identity_conflict'
  | 'event_order_conflict';

export interface ToolLedgerIssue {
  code: ToolLedgerIssueCode;
  eventId: string;
  operationId?: string;
  toolCallId?: string;
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
    if (event.partial) continue;

    const lane = validateToolLedgerEventLane(event);
    if (!lane.ok) {
      addIssue(undefined, lane);
      continue;
    }

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
  if (event.partial || event.status !== undefined) return false;
  switch (lane) {
    case 'function_call':
      return (
        event.role === 'model' &&
        event.author === 'agent' &&
        hasNoAuthoritativeToolActions(event.actions)
      );
    case 'function_response':
      return (
        event.role === 'tool' &&
        event.author === 'tool' &&
        hasNoAuthoritativeToolActions(event.actions)
      );
    case 'tool_dispatch':
      return (
        event.content === undefined &&
        event.role === 'system' &&
        event.author === 'system' &&
        hasOnlyKeys(event.actions, ['toolDispatch']) &&
        hasOnlyKeys(event.refs, ['operationId', 'toolCallId'])
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

function hasNoAuthoritativeToolActions(actions: RuntimeEvent['actions']): boolean {
  if (!actions) return true;
  return Object.keys(actions).every((key) =>
    ['stateDelta', 'artifactDelta', 'tokenUsage'].includes(key),
  );
}

function toolCallIdentity(invocationId: string, toolCallId: string): string {
  return `${invocationId}\0${toolCallId}`;
}
