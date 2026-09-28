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

interface TranscriptNode {
  readonly uuid: string;
  readonly parentUuid?: string;
  readonly isPrompt: boolean;
  readonly isSidechain: boolean;
}

export interface TranscriptLineageIndex {
  /** Records dropped as descending from a withdrawn prompt. */
  readonly abandoned: number;
  /** Prompts withdrawn by a later sibling. */
  readonly withdrawnPrompts: number;
  /** `uuid` repeats ignored after their first occurrence. */
  readonly duplicates: number;
  /** `compact_boundary` records in the de-duplicated source. */
  readonly compactBoundaries: number;
  createFilter(): TranscriptLineageFilter;
}

export interface TranscriptLineageFilter {
  keep(record: TranscriptRecord): boolean;
}

/**
 * Incremental lineage index used by large transcript imports.
 *
 * It retains only graph identity, never complete transcript records. Once the
 * first pass is complete, independent filters can replay the fixed source
 * snapshot while applying the same de-duplication and rewind selection as
 * {@link resolveTranscriptLineage}.
 */
export class TranscriptLineageIndexer {
  readonly #nodes = new Map<string, TranscriptNode>();
  #duplicates = 0;
  #compactBoundaries = 0;

  accept(record: TranscriptRecord): void {
    const uuid = stringField(record, 'uuid');
    if (uuid !== undefined && this.#nodes.has(uuid)) {
      this.#duplicates += 1;
      return;
    }
    if (record.subtype === 'compact_boundary') this.#compactBoundaries += 1;
    if (uuid === undefined) return;
    const parentUuid = transcriptParentUuid(record);
    this.#nodes.set(uuid, {
      uuid,
      ...(parentUuid !== undefined ? { parentUuid } : {}),
      isPrompt: isPromptRecord(record),
      isSidechain: record.isSidechain === true,
    });
  }

  finish(): TranscriptLineageIndex {
    const main = [...this.#nodes.values()].filter((node) => !node.isSidechain);
    const present = new Set(main.map((node) => node.uuid));
    const childrenOf = new Map<string, string[]>();
    const promptsOf = new Map<string, string[]>();
    for (const node of main) {
      const key =
        node.parentUuid !== undefined && present.has(node.parentUuid) ? node.parentUuid : ROOT_KEY;
      const children = childrenOf.get(key);
      if (children) children.push(node.uuid);
      else childrenOf.set(key, [node.uuid]);
      if (node.isPrompt) {
        const prompts = promptsOf.get(key);
        if (prompts) prompts.push(node.uuid);
        else promptsOf.set(key, [node.uuid]);
      }
    }

    const withdrawn: string[] = [];
    for (const prompts of promptsOf.values()) {
      if (prompts.length > 1) withdrawn.push(...prompts.slice(0, -1));
    }
    const dropped = new Set<string>();
    const stack = [...withdrawn];
    while (stack.length > 0) {
      const uuid = stack.pop() as string;
      if (dropped.has(uuid)) continue;
      dropped.add(uuid);
      for (const child of childrenOf.get(uuid) ?? []) stack.push(child);
    }

    return new FinishedTranscriptLineageIndex(
      dropped,
      withdrawn.length,
      this.#duplicates,
      this.#compactBoundaries,
    );
  }
}

class FinishedTranscriptLineageIndex implements TranscriptLineageIndex {
  readonly #dropped: ReadonlySet<string>;
  readonly abandoned: number;

  constructor(
    dropped: ReadonlySet<string>,
    readonly withdrawnPrompts: number,
    readonly duplicates: number,
    readonly compactBoundaries: number,
  ) {
    this.#dropped = dropped;
    this.abandoned = this.#dropped.size;
  }

  createFilter(): TranscriptLineageFilter {
    const seen = new Set<string>();
    return {
      keep: (record) => {
        const uuid = stringField(record, 'uuid');
        if (uuid === undefined) return true;
        if (seen.has(uuid)) return false;
        seen.add(uuid);
        return !this.#dropped.has(uuid);
      },
    };
  }
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

const ROOT_KEY = ' root';

export function resolveTranscriptLineage(
  rawRecords: readonly TranscriptRecord[],
): LineageResolution {
  const indexer = new TranscriptLineageIndexer();
  for (const record of rawRecords) indexer.accept(record);
  const index = indexer.finish();
  const filter = index.createFilter();
  const resolved = rawRecords.filter((record) => filter.keep(record));

  return {
    records: resolved,
    abandoned: index.abandoned,
    withdrawnPrompts: index.withdrawnPrompts,
    duplicates: index.duplicates,
    compactBoundaries: index.compactBoundaries,
  };
}
