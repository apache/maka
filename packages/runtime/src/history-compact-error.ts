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
 * Ways a summarizer's own output can be unusable. Owned here, in the
 * history-compaction domain that produces and repairs them.
 */
const MALFORMED_HISTORY_COMPACT_SUMMARY_REASONS = [
  'malformed_summary_missing_section',
  'malformed_summary_truncated',
  'malformed_summary_too_small_for_fold',
] as const;

export type MalformedHistoryCompactSummaryReason =
  (typeof MALFORMED_HISTORY_COMPACT_SUMMARY_REASONS)[number];

export type HistoryCompactSummarizerFailureReason =
  | 'output_length'
  | 'input_too_large'
  | 'provider_error'
  | 'invalid_provider_state'
  | MalformedHistoryCompactSummaryReason;

export function isMalformedHistoryCompactSummaryReason(
  reason: string,
): reason is MalformedHistoryCompactSummaryReason {
  return MALFORMED_HISTORY_COMPACT_SUMMARY_REASONS.includes(
    reason as MalformedHistoryCompactSummaryReason,
  );
}

export class HistoryCompactSummarizerError extends Error {
  constructor(
    readonly reason: HistoryCompactSummarizerFailureReason,
    options?: ErrorOptions,
  ) {
    super(`History compact summarizer failed: ${reason}`, options);
    this.name = 'HistoryCompactSummarizerError';
  }
}
