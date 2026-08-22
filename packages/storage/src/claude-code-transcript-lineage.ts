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
 * Source resolution for a Claude Code transcript, ahead of any conversion.
 *
 * A `.jsonl` transcript is an append-only log of a `uuid` / `parentUuid`
 * graph, and the graph is not a path. Reading it as one is the mistake this
 * module exists to avoid — in both directions:
 *
 * **It branches for ordinary reasons.** Of 358 forked parents across 1130
 * local transcripts, 281 are one shape: an assistant record carrying a
 * `tool_use` has two children, the next fragment of that same response and
 * the `tool_result` of the call it just made. Nothing was abandoned; a
 * response and a completion simply share a parent. Selecting "the active
 * lineage" by walking parents back from the newest record treats all of that
 * as dead — measured on this corpus, such a walk strands 6535 tool results
 * and 18815 other records.
 *
 * **It branches for one real reason.** 72 forked parents have two or more
 * *user prompt* children. Those are rewinds — the user edited a prompt and
 * resubmitted — and the transcript keeps both. Importing both presents a
 * question the user withdrew, and its answer, as conversation:
 *
 * ```
 * StreamVByte 是什么类型？我忘了     ← withdrawn
 * StreamVByte 是什么方式？我忘了     ← asked
 * ```
 *
 * So resolution is exactly that narrow: among sibling prompts the last one
 * written wins, and a withdrawn prompt takes its subtree with it. Every other
 * branch is kept, because nothing in the records says it was abandoned.
 *
 * **Compaction is not a branch.** The boundary record carries
 * `parentUuid: null` and starts a new root, because after a compaction the
 * model's context no longer holds what came before. Both sides are
 * conversation that happened and both are kept — keeping only the newest root
 * would discard 24,695 records here. Its `logicalParentUuid` is *not* the
 * backward link it resembles: it equals
 * `compactMetadata.preservedSegment.tailUuid`, a record written after the
 * boundary, so following it as a parent points forward and closes a cycle.
 *
 * Every rule above is read off fields the transcript states outright. Where
 * the records are silent the record is kept: dropping history is the failure
 * that cannot be undone once it is persisted as canonical.
 */

export type TranscriptRecord = Record<string, unknown>;

export interface LineageResolution {
  /** The selected records, in the order the file wrote them. */
  readonly records: readonly TranscriptRecord[];
  /** Records dropped as descending from a withdrawn prompt. */
  readonly abandoned: number;
  /** Prompts withdrawn by a later sibling. */
  readonly withdrawnPrompts: number;
  /** Records dropped as a repeat of a `uuid` already seen. */
  readonly duplicates: number;
  /** `compact_boundary` records the file carries. */
  readonly compactBoundaries: number;
}

function stringField(record: TranscriptRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * The parent a record hangs from: `parentUuid`, and nothing else.
 *
 * `logicalParentUuid` is deliberately not consulted. On a compaction boundary
 * it holds `preservedSegment.tailUuid` — a record written after the boundary,
 * not before it — so reading it as a parent points forward and closes a cycle
 * back through the summary.
 */
export function transcriptParentUuid(record: TranscriptRecord): string | undefined {
  return stringField(record, 'parentUuid');
}

/**
 * A record that is a human prompt rather than the harness speaking.
 *
 * Tool results are written as `user` records — the harness answering the
 * model — so a response's completions are not prompts, and two of them
 * sharing a parent is not a rewind. That distinction is the whole of the
 * difference between the 281 ordinary forks and the 72 real ones.
 */
export function isPromptRecord(record: TranscriptRecord): boolean {
  if (record.type !== 'user') return false;
  const message = record.message;
  if (typeof message !== 'object' || message === null) return true;
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) return true;
  return !content.some(
    (block) =>
      typeof block === 'object' &&
      block !== null &&
      (block as Record<string, unknown>).type === 'tool_result',
  );
}

/**
 * Drop repeats of a `uuid` already seen, keeping the first.
 *
 * A record written twice replays whatever identity it carries — a prompt, a
 * turn boundary, a tool call. Measured: 3 repeats across 1130 local
 * transcripts. Rare enough to be invisible in testing, permanent once it is
 * persisted as canonical history.
 */
function deduplicate(records: readonly TranscriptRecord[]): {
  readonly kept: readonly TranscriptRecord[];
  readonly duplicates: number;
} {
  const seen = new Set<string>();
  const kept: TranscriptRecord[] = [];
  let duplicates = 0;
  for (const record of records) {
    const uuid = stringField(record, 'uuid');
    if (uuid !== undefined) {
      if (seen.has(uuid)) {
        duplicates += 1;
        continue;
      }
      seen.add(uuid);
    }
    kept.push(record);
  }
  return { kept, duplicates };
}

const ROOT_KEY = ' root';

export function resolveTranscriptLineage(
  rawRecords: readonly TranscriptRecord[],
): LineageResolution {
  const { kept: records, duplicates } = deduplicate(rawRecords);
  const compactBoundaries = records.filter((r) => r.subtype === 'compact_boundary').length;

  const main = records.filter(
    (r) => r.isSidechain !== true && stringField(r, 'uuid') !== undefined,
  );
  if (main.length === 0) {
    return { records, abandoned: 0, withdrawnPrompts: 0, duplicates, compactBoundaries };
  }

  const present = new Set(main.map((r) => stringField(r, 'uuid') as string));
  const childrenOf = new Map<string, TranscriptRecord[]>();
  for (const record of main) {
    const parent = transcriptParentUuid(record);
    // A parent outside this file is no parent: the record roots its own
    // segment rather than being orphaned into nothing.
    const key = parent !== undefined && present.has(parent) ? parent : ROOT_KEY;
    const siblings = childrenOf.get(key);
    if (siblings) siblings.push(record);
    else childrenOf.set(key, [record]);
  }

  // Among sibling prompts the last written is the one that was asked; the
  // earlier ones were withdrawn by the edit that replaced them.
  const withdrawn: TranscriptRecord[] = [];
  for (const [, siblings] of childrenOf) {
    const prompts = siblings.filter(isPromptRecord);
    if (prompts.length < 2) continue;
    withdrawn.push(...prompts.slice(0, -1));
  }
  if (withdrawn.length === 0) {
    return { records, abandoned: 0, withdrawnPrompts: 0, duplicates, compactBoundaries };
  }

  // A withdrawn prompt takes its subtree: the answer to a question that was
  // never asked is not conversation either.
  const dropped = new Set<string>();
  const stack = [...withdrawn];
  while (stack.length > 0) {
    const record = stack.pop() as TranscriptRecord;
    const uuid = stringField(record, 'uuid') as string;
    if (dropped.has(uuid)) continue;
    dropped.add(uuid);
    for (const child of childrenOf.get(uuid) ?? []) stack.push(child);
  }

  const resolved = records.filter((record) => {
    const uuid = stringField(record, 'uuid');
    return uuid === undefined || !dropped.has(uuid);
  });

  return {
    records: resolved,
    abandoned: dropped.size,
    withdrawnPrompts: withdrawn.length,
    duplicates,
    compactBoundaries,
  };
}
