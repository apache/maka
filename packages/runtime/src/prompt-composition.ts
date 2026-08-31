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

import type {
  ContextDiagnosticsComposition,
  ContextDiagnosticsSegment,
} from './context-diagnostics.js';
import type { PreparedRequestObservationSegmentKind } from '@maka/core/model-call-attempt';

/**
 * The three fields a fold needs, and no more.
 *
 * A current observation segment satisfies this structurally, while the legacy
 * event decoder does not have to invent fields the fold never reads.
 */
export interface SizedRequestSegment {
  kind: PreparedRequestObservationSegmentKind;
  bytes: number;
  representedSegments?: number;
  label?: string;
}

/**
 * Folds one request's observed segments into "what was this prompt made of"
 * (#2323).
 *
 * The bar above this in the Inspector answers how full the context is, from
 * provider-reported tokens. This answers what filled it, and the two are not
 * views of one number: composition is measured in **bytes of the observed
 * semantic segments** and never sums to the reported `inputTokens`. Nothing
 * here estimates tokens — a byte count is the fact this layer holds, and
 * turning it into a token figure is a display decision that has to be labelled
 * as an estimate where it is made (#1679).
 *
 * `tool_schema` folds per tool rather than into one total, because that is the
 * only breakdown a reader can act on: "tool definitions are 40%" names nothing
 * to remove. Every other kind folds whole — one system prompt, one history, one
 * options blob — and splitting `message` by what produced it is not knowable
 * here, where messages arrive already serialized.
 */
export function foldPromptComposition(
  segments: readonly SizedRequestSegment[],
): ContextDiagnosticsComposition | undefined {
  if (segments.length === 0) return undefined;

  const byKind = new Map<PreparedRequestObservationSegmentKind, number>();
  const byTool = new Map<string, number>();
  let unlabelledToolBytes = 0;
  let boundedToolCount = 0;
  let boundedToolBytes = 0;

  for (const segment of segments) {
    byKind.set(segment.kind, (byKind.get(segment.kind) ?? 0) + segment.bytes);
    if (segment.kind !== 'tool_schema') continue;
    if (segment.label !== undefined) {
      byTool.set(segment.label, (byTool.get(segment.label) ?? 0) + segment.bytes);
    } else if (segment.representedSegments !== undefined) {
      boundedToolCount += segment.representedSegments;
      boundedToolBytes += segment.bytes;
    } else {
      unlabelledToolBytes += segment.bytes;
    }
  }

  // A zero-byte kind is dropped rather than shown as `≈0`, the same way
  // `/context` folds it — a part nothing contributed to is not a part.
  const folded: ContextDiagnosticsSegment[] = KIND_ORDER.flatMap((kind) => {
    const bytes = byKind.get(kind) ?? 0;
    return bytes > 0 ? [{ kind: PART_KINDS[kind], bytes }] : [];
  });
  if (folded.length === 0) return undefined;

  // Sorted by size because the question the list answers is "what is big
  // enough to be worth removing", and ties by name so a reader comparing two
  // reads of the same session sees the same order.
  const ranked = [...byTool.entries()]
    .map(([name, bytes]) => ({ name, bytes }))
    .sort((left, right) => right.bytes - left.bytes || left.name.localeCompare(right.name));
  // Bounded HERE, at the owner that decides what the list means — not at the
  // wire decoder. A single MCP server may advertise up to 1000 tools, so a cap
  // downstream only moves the cliff: the 257th tool would fail the whole query
  // instead of being summarised. What falls below the cut is carried as a
  // remainder, so the rows still account for every tool byte.
  const tools = ranked.slice(0, MAX_TOOL_ROWS);
  const remainder = ranked.slice(MAX_TOOL_ROWS);
  const remainingToolCount = remainder.length + boundedToolCount;
  const remainingToolBytes =
    remainder.reduce((carry, tool) => carry + tool.bytes, 0) + boundedToolBytes;

  return {
    segments: folded,
    ...(tools.length > 0 ? { tools } : {}),
    ...(remainingToolCount > 0
      ? { remainingTools: { count: remainingToolCount, bytes: remainingToolBytes } }
      : {}),
    ...(unlabelledToolBytes > 0 ? { unlabelledToolBytes } : {}),
  };
}

/** Historical provider-attempt event retained only for pre-canonical ledgers. */
export const PROVIDER_REQUEST_ATTEMPT_EVENT_TYPE = 'provider_request_attempt_recorded';

/**
 * Reads one run event into the composition of the request it describes.
 *
 * Returns undefined for every event that is not a decodable historical
 * provider attempt. Current writers put the observation on the canonical
 * ModelCallAttempt instead. Absence is the honest outcome: an unreadable legacy
 * record is a composition the reader does not have, not a prompt made of nothing.
 */
export function readPromptCompositionEvent(event: {
  readonly type: string;
  readonly data?: unknown;
}): { attemptId: string; composition: ContextDiagnosticsComposition } | undefined {
  if (event.type !== PROVIDER_REQUEST_ATTEMPT_EVENT_TYPE) return undefined;
  const data = event.data;
  if (!isRecord(data)) return undefined;
  const attemptId = data.attemptId;
  if (typeof attemptId !== 'string' || attemptId.length === 0) return undefined;
  if (!Array.isArray(data.segments)) return undefined;

  const segments: SizedRequestSegment[] = [];
  for (const value of data.segments) {
    const segment = readSegment(value);
    // One unreadable segment makes every share of this request wrong, so the
    // whole composition is dropped rather than silently under-counted.
    if (!segment) return undefined;
    segments.push(segment);
  }

  const composition = foldPromptComposition(segments);
  return composition ? { attemptId, composition } : undefined;
}

function readSegment(value: unknown): SizedRequestSegment | undefined {
  if (!isRecord(value)) return undefined;
  const kind = value.kind;
  if (!KIND_ORDER.includes(kind as PreparedRequestObservationSegmentKind)) return undefined;
  if (!isNonNegativeInteger(value.bytes)) return undefined;
  if (
    value.representedSegments !== undefined &&
    (!isNonNegativeInteger(value.representedSegments) || value.representedSegments === 0)
  ) {
    return undefined;
  }
  if (value.label !== undefined && typeof value.label !== 'string') return undefined;
  return {
    kind: kind as PreparedRequestObservationSegmentKind,
    bytes: value.bytes,
    ...(typeof value.representedSegments === 'number'
      ? { representedSegments: value.representedSegments }
      : {}),
    ...(typeof value.label === 'string' ? { label: value.label } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/**
 * How many tools the fold names individually.
 *
 * Generous enough that a normal registry is listed whole, small enough that a
 * pathological one cannot make this record unbounded. The panel shows fewer
 * still; this is the bound on what crosses a wire and sits in a projection.
 */
const MAX_TOOL_ROWS = 64;

const KIND_ORDER: readonly PreparedRequestObservationSegmentKind[] = [
  'system_prompt',
  'tool_schema',
  'message',
  'provider_options',
];

/**
 * The CLI's `/context` vocabulary, reused rather than re-invented: the same
 * four buckets already fold the same segments for `readLatestContextDiagnostics`
 * (#1580), and two names for one fact is how two surfaces start disagreeing.
 */
const PART_KINDS: Record<PreparedRequestObservationSegmentKind, ContextDiagnosticsSegment['kind']> =
  {
    system_prompt: 'system_instructions',
    tool_schema: 'tool_definitions',
    message: 'messages',
    provider_options: 'other',
  };
