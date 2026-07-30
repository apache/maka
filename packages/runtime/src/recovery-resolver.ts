import {
  TOOL_BOUNDARY_PROTOCOL_V1,
  type RuntimeEvent,
  type ToolBoundaryProtocol,
} from '@maka/core/runtime-event';
import {
  scanToolLedger,
  type ToolLedgerIssueCode,
  type ToolLedgerScanOperation,
} from '@maka/core/tool-ledger-scanner';
import { interpretScannedToolRecovery } from '@maka/core/tool-recovery-bundle';

export type ToolRecoveryDecisionStatus =
  | 'completed'
  | 'parked'
  | 'definitely_not_dispatched'
  | 'indeterminate'
  | 'corruption';

export type ToolRecoveryDecisionReason =
  | 'matching_response'
  | 'recovery_bundle_completed'
  | 'dispatch_without_response'
  | 'new_protocol_before_dispatch'
  | 'legacy_dispatch_unknown'
  | 'orphan_dispatch'
  | 'orphan_response'
  | 'duplicate_call'
  | 'duplicate_operation'
  | 'duplicate_dispatch'
  | 'duplicate_response'
  | 'canonical_args_hash_conflict'
  | 'identity_conflict'
  | 'event_order_conflict'
  | 'protocol_marker_invalid'
  | 'recovery_fact_corruption'
  | 'reconcile_matches_prior_state'
  | 'reconcile_diverged'
  | 'reconcile_unreadable';

export type ToolSettlementOrigin = 'normal_t2' | 'pre_t1_synthetic' | 'recovery_bundle';

export interface ToolRecoveryDecision {
  toolCallId: string;
  toolName?: string;
  operationId?: string;
  status: ToolRecoveryDecisionStatus;
  reason: ToolRecoveryDecisionReason;
  settlementOrigin?: ToolSettlementOrigin;
  callRuntimeEventId?: string;
  dispatchRuntimeEventId?: string;
  responseRuntimeEventId?: string;
  responseIsError?: boolean;
}

export type RuntimeRecoveryIssueCode = 'protocol_marker_invalid' | ToolLedgerIssueCode;

export interface RuntimeRecoveryResolution {
  toolBoundaryProtocol?: ToolBoundaryProtocol;
  decisions: ToolRecoveryDecision[];
  issues: Array<{
    code: RuntimeRecoveryIssueCode;
    eventId: string;
  }>;
  hasCorruption: boolean;
  requiresReconciliation: boolean;
}

export function resolveRuntimeRecovery(events: readonly RuntimeEvent[]): RuntimeRecoveryResolution {
  const firstProtocol = events[0]?.actions?.runtimeProtocol;
  const toolBoundaryProtocol =
    firstProtocol?.toolBoundary === TOOL_BOUNDARY_PROTOCOL_V1
      ? TOOL_BOUNDARY_PROTOCOL_V1
      : undefined;
  const issues: RuntimeRecoveryResolution['issues'] = [];
  if (firstProtocol !== undefined && toolBoundaryProtocol === undefined && events[0]) {
    issues.push({ code: 'protocol_marker_invalid', eventId: events[0].id });
  }
  issues.push(
    ...events
      .slice(1)
      .filter((event) => event.actions?.runtimeProtocol !== undefined)
      .map((event) => ({ code: 'protocol_marker_invalid' as const, eventId: event.id })),
  );

  const scan = scanToolLedger(events);
  issues.push(...scan.issues.map(({ code, eventId }) => ({ code, eventId })));
  const eventOrder = new Map(events.map((event, index) => [event.id, index] as const));
  const decisions = scan.operations.map((operation) =>
    decisionFromOperation(operation, toolBoundaryProtocol, eventOrder),
  );

  const hasCorruption =
    issues.length > 0 || decisions.some((decision) => decision.status === 'corruption');
  return {
    ...(toolBoundaryProtocol ? { toolBoundaryProtocol } : {}),
    decisions,
    issues,
    hasCorruption,
    requiresReconciliation:
      !hasCorruption && decisions.some((decision) => decision.status === 'indeterminate'),
  };
}

function decisionFromOperation(
  operation: ToolLedgerScanOperation,
  toolBoundaryProtocol: ToolBoundaryProtocol | undefined,
  eventOrder: ReadonlyMap<string, number>,
): ToolRecoveryDecision {
  const decision: ToolRecoveryDecision = {
    toolCallId: operation.toolCallId,
    ...(operation.toolName ? { toolName: operation.toolName } : {}),
    ...(operation.operationId ? { operationId: operation.operationId } : {}),
    status: toolBoundaryProtocol ? 'definitely_not_dispatched' : 'indeterminate',
    reason: toolBoundaryProtocol ? 'new_protocol_before_dispatch' : 'legacy_dispatch_unknown',
    ...(operation.callEvent ? { callRuntimeEventId: operation.callEvent.id } : {}),
    ...(operation.dispatchEvent ? { dispatchRuntimeEventId: operation.dispatchEvent.id } : {}),
    ...(operation.responseEvent
      ? {
          responseRuntimeEventId: operation.responseEvent.id,
          responseIsError:
            operation.responseEvent.content?.kind === 'function_response'
              ? operation.responseEvent.content.isError === true
              : false,
        }
      : {}),
  };

  if (!operation.callEvent && operation.dispatchEvent) {
    decision.status = 'corruption';
    decision.reason = 'orphan_dispatch';
    return decision;
  }
  if (!operation.callEvent && operation.responseEvent) {
    decision.status = 'corruption';
    decision.reason = 'orphan_response';
    return decision;
  }
  const corruption = operationCorruptionReason(operation);
  if (corruption) {
    decision.status = 'corruption';
    decision.reason = corruption;
    return decision;
  }

  if (operation.responseEvent) {
    decision.status = 'completed';
    decision.reason = 'matching_response';
    decision.settlementOrigin = operation.dispatchEvent ? 'normal_t2' : 'pre_t1_synthetic';
  } else if (operation.dispatchEvent) {
    decision.status = 'indeterminate';
    decision.reason = 'dispatch_without_response';
  }

  if (operation.reconcileEvents.length === 0 && operation.decisionEvents.length === 0) {
    return decision;
  }
  const recovery = interpretScannedToolRecovery(operation, eventOrder);
  if (recovery.kind !== 'valid') {
    decision.status = 'corruption';
    decision.reason = 'recovery_fact_corruption';
    delete decision.settlementOrigin;
    return decision;
  }

  decision.settlementOrigin = 'recovery_bundle';
  if (recovery.decision.disposition === 'completed') {
    decision.status = 'completed';
    decision.reason = 'recovery_bundle_completed';
  } else {
    decision.status = 'parked';
    decision.reason = recovery.decision.reasonCode;
  }
  return decision;
}

function operationCorruptionReason(
  operation: ToolLedgerScanOperation,
): ToolRecoveryDecisionReason | undefined {
  const priority: Array<[ToolLedgerIssueCode, ToolRecoveryDecisionReason]> = [
    ['duplicate_call', 'duplicate_call'],
    ['duplicate_operation', 'duplicate_operation'],
    ['duplicate_dispatch', 'duplicate_dispatch'],
    ['duplicate_response', 'duplicate_response'],
    ['orphan_response', 'orphan_response'],
    ['canonical_args_hash_conflict', 'canonical_args_hash_conflict'],
    ['identity_conflict', 'identity_conflict'],
    ['event_order_conflict', 'event_order_conflict'],
  ];
  for (const [code, reason] of priority) {
    if (operation.issues.some((issue) => issue.code === code)) return reason;
  }
  return undefined;
}
