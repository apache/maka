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

import { EXPLORE_AGENT_FALLBACK_TEXT_PATTERN } from '@maka/core/tool-result-record-schema';
import { TRANSCRIPT_TOOL_RESULT_SYNTHETIC_TEXT_PATTERN } from './runtime-event-read-model.js';

/**
 * Recall's candidate source over the two places a transcript can live.
 *
 * A Session the RuntimeEvent ledger owns is projected from `runtime_events`;
 * one written before the ledger keeps its rows in the Session transcript
 * tables until a read converts it. Each store scans only the corpus it holds,
 * and the union is a superset of the Sessions whose projected transcript
 * matches. Either store missing means part of the corpus cannot be vouched
 * for, so the whole fast path declines rather than answering for half of it.
 */
export interface RecallCandidateStores {
  readonly transcripts: {
    listLegacyTranscriptCandidateSessions?(
      sessionIds: readonly string[],
      terms: readonly string[],
    ): Promise<string[] | undefined>;
    countLegacyTranscriptMessages?(sessionIds: readonly string[]): Promise<number>;
  };
  readonly ledger?: {
    listSessionsWithRuntimeEventText?(
      sessionIds: readonly string[],
      terms: readonly string[],
    ): Promise<string[]>;
    countRuntimeEventMessages?(sessionIds: readonly string[]): Promise<number>;
  };
}

export async function listRecallCandidateSessions(
  stores: RecallCandidateStores,
  sessionIds: readonly string[],
  terms: readonly string[],
): Promise<string[] | undefined> {
  const ledger = stores.ledger?.listSessionsWithRuntimeEventText;
  const legacy = stores.transcripts.listLegacyTranscriptCandidateSessions;
  if (!ledger || !legacy) return undefined;
  const [fromLedger, fromLegacy] = await Promise.all([
    ledger.call(stores.ledger, sessionIds, terms),
    legacy.call(stores.transcripts, sessionIds, terms),
  ]);
  if (fromLegacy === undefined) return undefined;
  return [...new Set([...fromLedger, ...fromLegacy])];
}

export async function countRecallSearchableMessages(
  stores: RecallCandidateStores,
  sessionIds: readonly string[],
): Promise<number | undefined> {
  const ledger = stores.ledger?.countRuntimeEventMessages;
  const legacy = stores.transcripts.countLegacyTranscriptMessages;
  if (!ledger || !legacy) return undefined;
  const [fromLedger, fromLegacy] = await Promise.all([
    ledger.call(stores.ledger, sessionIds),
    legacy.call(stores.transcripts, sessionIds),
  ]);
  return fromLedger + fromLegacy;
}

/**
 * Text the transcript projection writes that no store holds. Recall matches
 * with it removed, so a scan of stored payloads stays a superset of the
 * matches; see `RecallDeps.syntheticTextPatterns`.
 */
export const RECALL_SYNTHETIC_TEXT_PATTERNS: readonly RegExp[] = [
  TRANSCRIPT_TOOL_RESULT_SYNTHETIC_TEXT_PATTERN,
  EXPLORE_AGENT_FALLBACK_TEXT_PATTERN,
];
