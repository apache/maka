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

export interface InspectorCopy {
  ariaLabel: string;
  /** Copy action and success copy for an unpriced model call's exact Pricing key. */
  copyPricingKey: string;
  pricingKeyCopied: string;
  unpricedPricingKey: string;
  /** Toast title when the clipboard write is denied or unavailable. */
  copyFailed: string;
  copyFailedDetail: string;
  loadFailed: string;
  retry: string;
  empty: string;
  /** The panel-empty (tier 2) sentence under `empty`. */
  emptyHelp: string;
  costUnavailable: string;
  costEstimateHelp: string;
  loadEarlier: string;
  hideEarlier: string;
  loadingEarlier: string;
  loadingTrace: string;
  loadingSummary: string;
  summaryUnavailable: string;
  /** Label for the complete Session cost estimate. */
  totals: {
    cost: string;
  };
  /**
   * The session-wide metered-token split, read like a bill: what the
   * provider's cache served, what was paid as uncached input, what was paid
   * as output. Names the bands of the token track, in the track's order.
   */
  tokenUsage: {
    title: string;
    segment: { cacheRead: string; cacheMiss: string; output: string };
  };
  /**
   * Where the session's recorded time went. Names the bands of the duration
   * track; each row also states how many times its kind ran.
   */
  durationUsage: {
    title: string;
    /** Label under the ring's total figure. */
    center: string;
    segment: {
      model: (count: number) => string;
      tool: (count: number) => string;
    };
  };
  /**
   * The coverage notice, composed with its own breakdown: the separators
   * belong to the language, not to the layout, so a Chinese sentence gets
   * `：` and `、` where an English one gets `:` and `,`.
   */
  coveragePartial: (parts: readonly string[]) => string;
  coverageAbsent: (parts: readonly string[]) => string;
  /** Each states its own count, so English can say "1 turn" and not "1 turns". */
  unreadable: (count: number) => string;
  oversizedRuns: (count: number) => string;
  turnsMissing: (count: number) => string;
  turnsShort: (count: number) => string;
  /**
   * Names a step whose kind IS its identity — a compaction, an error, a
   * permission prompt with no tool attached. Rows that carry a real
   * identifier (a model id, a tool name) print that instead.
   */
  stepKind: { permission: string; compaction: string; error: string };
  /** Why a model was called, when the reason was not the turn itself. */
  callKind: (kind: string) => string;
  /** How a permission request was answered. */
  permissionDecision: (decision: string) => string;
  /** What a tool that failed was recovered as. */
  recoveredAs: (disposition: string) => string;
  /** Attempts beyond the first, in words rather than as `×N`. */
  retries: (count: number) => string;
  /**
   * What ended the turn badly, in words. The trace's codes are engineering
   * vocabulary (`tool_failed`, `turn_aborted`); this is the sentence a
   * reader gets, with a plain fallback for a code nobody has named yet.
   */
  turnFailure: (code: string) => string;
  /** Stable display name of one turn, qualified by its recorded start time. */
  turnLabel: (startedAt: string) => string;
  /** Summary above the raw timeline. */
  overview: {
    context: string;
    /** Names the bands of the context bar, in the bar's own order. */
    segment: {
      cacheRead: string;
      fresh: string;
      used: string;
      free: string;
    };
    /** The three figures a reader opens this tab for, as headline stats. */
    cacheHit: string;
    /** Heading over the causal record. */
    timelineTab: string;
    /**
     * What filled the context, under the bar that says how full it is.
     *
     * Kept verbally separate from the bar on purpose: these are estimates
     * over serialized bytes and do not sum to the provider-reported prompt
     * (#2323), so the heading says estimate and every figure carries a `≈`.
     */
    composition: {
      title: string;
      /** States the unit and its authority, once, under the heading. */
      basis: string;
      part: {
        system_instructions: string;
        tool_definitions: string;
        messages: string;
        other: string;
      };
      /** Heading over the per-tool rows. */
      tools: string;
      /** The tools below the visible rows, folded into one. */
      remainingTools: (count: number) => string;
      /** Tool schemas the payload never named. */
      unlabelled: string;
      /** The metered call carried no capture — a gap, not an empty prompt. */
      unrecorded: string;
    };
  };
}

/**
 * The name a step falls back to when it has no identifier of its own. A model
 * call and a tool call always carry one, so they never reach here.
 *
 * It lives beside the words rather than in the panel so fallback labels stay
 * part of the locale's vocabulary instead of being reconstructed by the view.
 */
export function inspectorStepKindLabel(copy: InspectorCopy, kind: string): string {
  if (kind === 'permission') return copy.stepKind.permission;
  if (kind === 'compaction') return copy.stepKind.compaction;
  if (kind === 'error') return copy.stepKind.error;
  return kind;
}
