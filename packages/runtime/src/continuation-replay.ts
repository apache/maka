import { createHash } from 'node:crypto';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import { stableJsonStringify } from '@maka/core/tool-args-identity';
import {
  createRuntimeBoundaryCursor,
  runtimePrefixSegment,
  type ImmutableRuntimePrefixV1,
  type RuntimeBoundaryCursorV1,
  type RuntimeBoundaryDigest,
  type RuntimePrefixSegmentV1,
} from '@maka/core/runtime-boundary';
import type { RuntimeEventModelReplayItem, RuntimeEventReplayDiagnostic } from './model-history.js';
import {
  buildRuntimeEventModelReplayPlan,
  PROVIDER_REPLAY_PROJECTION_VERSION,
} from './model-history.js';
import { resolveRuntimeRecovery } from './recovery-resolver.js';

export interface ContinuationReplaySegmentV1 {
  boundary: RuntimePrefixSegmentV1;
  replayRuntimeEvents: readonly RuntimeEvent[];
  trimmedSuffixEventIds: readonly string[];
}

export interface ContinuationReplaySegmentPlanV1 {
  protocol: 'continuation_replay_segment_plan_v1';
  providerProjectionVersion: typeof PROVIDER_REPLAY_PROJECTION_VERSION;
  providerReplayDigest: RuntimeBoundaryDigest;
  segment: ContinuationReplaySegmentV1;
  providerItems: readonly RuntimeEventModelReplayItem[];
}

export type ContinuationReplayBlockReason =
  | 'tool_recovery_unsettled'
  | 'tool_recovery_corruption'
  | 'provider_replay_non_suffix_gap'
  | 'provider_replay_unsupported';

export type ContinuationReplaySegmentResult =
  | { kind: 'replayable'; plan: ContinuationReplaySegmentPlanV1 }
  | {
      kind: 'blocked';
      reason: ContinuationReplayBlockReason;
      diagnostics: readonly RuntimeEventReplayDiagnostic[];
    };

export interface ContinuationReplayPlanV1 {
  protocol: 'continuation_replay_plan_v1';
  providerProjectionVersion: typeof PROVIDER_REPLAY_PROJECTION_VERSION;
  boundary: RuntimeBoundaryCursorV1;
  providerReplayDigest: RuntimeBoundaryDigest;
  segments: readonly ContinuationReplaySegmentV1[];
  runtimeContext: readonly RuntimeEvent[];
  providerItems: readonly RuntimeEventModelReplayItem[];
}

export type ContinuationReplayPlanResult =
  | { kind: 'replayable'; plan: ContinuationReplayPlanV1 }
  | {
      kind: 'blocked';
      reason: ContinuationReplayBlockReason;
      segmentIndex: number;
      diagnostics: readonly RuntimeEventReplayDiagnostic[];
    };

export function buildContinuationReplayPlan(input: {
  prefixes: readonly [ImmutableRuntimePrefixV1, ...ImmutableRuntimePrefixV1[]];
  providerProjectionVersion: typeof PROVIDER_REPLAY_PROJECTION_VERSION;
}): ContinuationReplayPlanResult {
  const segmentPlans: ContinuationReplaySegmentPlanV1[] = [];
  for (const [segmentIndex, prefix] of input.prefixes.entries()) {
    const result = buildContinuationReplaySegment({
      prefix,
      providerProjectionVersion: input.providerProjectionVersion,
    });
    if (result.kind === 'blocked') {
      return { ...result, segmentIndex };
    }
    segmentPlans.push(result.plan);
  }
  const boundaries = segmentPlans.map((plan) => plan.segment.boundary) as [
    RuntimePrefixSegmentV1,
    ...RuntimePrefixSegmentV1[],
  ];
  const segments = segmentPlans.map((plan) => plan.segment);
  const providerItems = segmentPlans.flatMap((plan) => plan.providerItems);
  return {
    kind: 'replayable',
    plan: {
      protocol: 'continuation_replay_plan_v1',
      providerProjectionVersion: input.providerProjectionVersion,
      boundary: createRuntimeBoundaryCursor(boundaries),
      providerReplayDigest: digestProviderReplay(input.providerProjectionVersion, providerItems),
      segments,
      runtimeContext: segments.flatMap((segment) => segment.replayRuntimeEvents),
      providerItems,
    },
  };
}

export function buildContinuationReplaySegment(input: {
  prefix: ImmutableRuntimePrefixV1;
  providerProjectionVersion: typeof PROVIDER_REPLAY_PROJECTION_VERSION;
}): ContinuationReplaySegmentResult {
  const recovery = resolveRuntimeRecovery(input.prefix.events);
  if (
    recovery.hasCorruption ||
    recovery.decisions.some((decision) => decision.status === 'corruption')
  ) {
    return blocked(
      'tool_recovery_corruption',
      'immutable RuntimeEvent segment contains corrupt tool recovery facts',
    );
  }
  if (
    recovery.decisions.some(
      (decision) => decision.status === 'indeterminate' || decision.status === 'parked',
    )
  ) {
    return blocked(
      'tool_recovery_unsettled',
      'immutable RuntimeEvent segment contains unsettled tool recovery facts',
    );
  }
  if (input.providerProjectionVersion !== PROVIDER_REPLAY_PROJECTION_VERSION) {
    return blocked(
      'provider_replay_unsupported',
      `provider replay projection ${input.providerProjectionVersion} is unsupported`,
    );
  }

  const modelPlan = buildRuntimeEventModelReplayPlan(input.prefix.events);
  const eventIndexes = new Map(
    input.prefix.events.map((event, index) => [event.id, index] as const),
  );
  const hardDiagnostic = modelPlan.diagnostics.find((diagnostic) =>
    isBlockingProjectionDiagnostic(diagnostic),
  );
  if (hardDiagnostic) {
    return {
      kind: 'blocked',
      reason: 'provider_replay_unsupported',
      diagnostics: [hardDiagnostic],
    };
  }

  const unmatchedCalls = modelPlan.diagnostics.filter(
    (diagnostic) => diagnostic.code === 'unmatched_tool_call' && diagnostic.eventId,
  );
  for (const diagnostic of unmatchedCalls) {
    const callIndex = eventIndexes.get(diagnostic.eventId!);
    if (
      callIndex === undefined ||
      modelPlan.items.some(
        (item) => (eventIndexes.get(item.eventId) ?? Number.POSITIVE_INFINITY) > callIndex,
      )
    ) {
      return {
        kind: 'blocked',
        reason: 'provider_replay_non_suffix_gap',
        diagnostics: [diagnostic],
      };
    }
  }

  const stableItemIndex = findLastStableProviderItem(modelPlan.items);
  const trimmedIds = new Set<string>();
  if (stableItemIndex >= 0) {
    for (const item of modelPlan.items.slice(stableItemIndex + 1)) {
      trimmedIds.add(item.eventId);
    }
    const stableEventIndex = eventIndexes.get(modelPlan.items[stableItemIndex]!.eventId)!;
    for (const diagnostic of unmatchedCalls) {
      const eventIndex = eventIndexes.get(diagnostic.eventId!);
      if (eventIndex !== undefined && eventIndex > stableEventIndex) {
        trimmedIds.add(diagnostic.eventId!);
      }
    }
  } else {
    // A continuation run does not synthesize another user event. If it crashes
    // before producing a tool result, the whole model-visible segment is an
    // interrupted suffix rather than a new replay anchor.
    for (const item of modelPlan.items) {
      trimmedIds.add(item.eventId);
    }
    for (const diagnostic of unmatchedCalls) {
      trimmedIds.add(diagnostic.eventId!);
    }
  }
  const trimmedSuffixEventIds = input.prefix.events
    .filter((event) => trimmedIds.has(event.id))
    .map((event) => event.id);
  const replayRuntimeEvents = input.prefix.events.filter(
    (event) => event.modelVisibility !== 'hidden' && !trimmedIds.has(event.id),
  );
  const providerItems = modelPlan.items.filter((item) => !trimmedIds.has(item.eventId));

  return {
    kind: 'replayable',
    plan: {
      protocol: 'continuation_replay_segment_plan_v1',
      providerProjectionVersion: input.providerProjectionVersion,
      providerReplayDigest: digestProviderReplay(input.providerProjectionVersion, providerItems),
      segment: {
        boundary: runtimePrefixSegment(input.prefix),
        replayRuntimeEvents,
        trimmedSuffixEventIds,
      },
      providerItems,
    },
  };
}

function findLastStableProviderItem(items: readonly RuntimeEventModelReplayItem[]): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (item.kind === 'tool_result' || (item.kind === 'text' && item.role === 'user')) {
      return index;
    }
  }
  return -1;
}

function isBlockingProjectionDiagnostic(diagnostic: RuntimeEventReplayDiagnostic): boolean {
  return (
    diagnostic.code === 'partial_skipped' ||
    diagnostic.code === 'unmatched_tool_result' ||
    diagnostic.code === 'tool_id_mismatch' ||
    diagnostic.code === 'unsupported_role' ||
    diagnostic.code === 'unsupported_content'
  );
}

export function digestProviderReplay(
  providerProjectionVersion: number,
  items: readonly RuntimeEventModelReplayItem[],
): RuntimeBoundaryDigest {
  const json = stableJsonStringify({
    protocol: 'provider_replay_plan_v1',
    providerProjectionVersion,
    items,
  });
  return `sha256:${createHash('sha256').update(json, 'utf8').digest('hex')}`;
}

function blocked(
  reason: ContinuationReplayBlockReason,
  message: string,
): ContinuationReplaySegmentResult {
  return {
    kind: 'blocked',
    reason,
    diagnostics: [{ code: 'unsupported_content', message }],
  };
}
