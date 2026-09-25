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

/** Public semantic records, shared by native and external terminal transcripts. */
import type { Json, Registration } from './host.js';

export type TranscriptKey = {
  turn: string;
  message: string;
  part: 'text' | 'thinking' | 'tool';
};
/** Half-open UTF-8 byte offsets, on character boundaries. */
export type TranscriptRange = {
  start: number;
  end: number;
};
export type TranscriptContent = {
  text: string;
  diff?: {
    source: TranscriptRange;
    kind: 'removed' | 'added' | 'context' | 'content';
    language?: string | null;
  }[];
  /** A copyable path; it grants no access to the host filesystem. */
  link?: { source: TranscriptRange; path: string } | null;
  emphasis?: TranscriptRange | null;
};
export type TranscriptToolState =
  | 'pending'
  | 'waiting'
  | 'returned'
  | 'attention'
  | 'failed'
  | 'timed_out'
  | 'cancelled'
  | 'completed'
  | 'missing';
export type TranscriptBlock = {
  key: TranscriptKey;
  /** Changes whenever the semantic record changes; independent of the stream fence. */
  revision: string;
  kind: 'user' | 'assistant' | 'thinking' | 'tool' | 'failure' | 'other' | 'meta';
  /** Required exactly for tool records. */
  state?: TranscriptToolState | null;
  content: TranscriptContent;
  timestamp_ms?: number | null;
  /** Only tool records have group affinity. */
  affinity?: 'read' | 'search' | null;
};
export type TranscriptTiming = {
  turn: string;
  start_ms: number;
  end?: { at_ms: number; outcome: 'completed' | 'failed' | 'aborted' } | null;
  active?: boolean;
};
export type TranscriptResource = {
  id: string;
  read: string;
  stream: string;
  route?: Json;
};
export type TranscriptOpen = {
  /** Reader UUID scoped to this caller and stable document. */
  mount: string;
  resource: string;
  route: Json;
  locale: string;
};
export type TranscriptRead = {
  /** Must match the UUID supplied when opening this reader. */
  mount: string;
  resource: string;
  fence: number;
  direction: 'tail' | 'older' | 'newer' | 'continue';
  cursor?: string | null;
};
export type TranscriptRecord =
  | { kind: 'block'; block: TranscriptBlock }
  | {
      kind: 'fragment';
      key: TranscriptKey;
      revision: string;
      /** Offsets and total count UTF-8 bytes of the complete Block JSON. */
      offset: number;
      total: number;
      json: string;
    };
export type TranscriptPage = {
  fence: number;
  records: TranscriptRecord[];
  timings?: TranscriptTiming[];
  older?: string | null;
  newer?: string | null;
  continuation?: string | null;
};
export type TranscriptEvent =
  | { kind: 'ready'; fence: number }
  | { kind: 'replace'; base: number; revision: number; append: boolean; record: TranscriptRecord }
  | {
      kind: 'append';
      base: number;
      revision: number;
      key: TranscriptKey;
      block_base: string;
      block_revision: string;
      offset: number;
      text: string;
    }
  | { kind: 'remove'; base: number; revision: number; key: TranscriptKey }
  | { kind: 'timing'; base: number; revision: number; timing: TranscriptTiming }
  | { kind: 'invalidated' };

export interface TranscriptInitial {
  blocks?: readonly TranscriptBlock[];
  timings?: readonly TranscriptTiming[];
}
export interface TranscriptStats {
  active: number;
  opened: number;
  closed: number;
  invalidated: number;
  pageReads: number;
  /** Logical updates, independent of transport fragments. */
  updates: number;
}
/** A bounded, SDK-managed source. Mutations are synchronous and clone their input.
 * Each open document mount captures its own immutable snapshot before subscribing.
 * Pages contain at most 256 records / 4 MiB, allowing one larger record; encoded
 * records are capped at 16 MiB. The source holds at most 4096 blocks / 32 MiB,
 * 4096 timings, and four concurrent mounts. Slow readers get Invalidated on queue overflow.
 * Close the store during plugin cleanup. Local reading never changes the View.
 */
export interface TranscriptStore extends Registration {
  readonly resource: Readonly<TranscriptResource>;
  /** A fresh counters snapshot; useful for lifecycle diagnostics. */
  readonly stats: Readonly<TranscriptStats>;
  /** Replace in place, or append a new identity. Changed data needs a new revision. */
  replace(block: TranscriptBlock): void;
  /** Append text to an existing record using its exact current revision/byte offset.
   * Large appends become one fragmented Replace so the revision remains atomic.
   */
  append(key: TranscriptKey, text: string, revision: string): void;
  remove(key: TranscriptKey): void;
  timing(timing: TranscriptTiming): void;
}
