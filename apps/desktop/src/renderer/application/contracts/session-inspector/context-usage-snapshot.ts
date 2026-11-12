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
 * One context-usage observation: either a settled measurement or a compaction
 * boundary, each carrying the event time that lets an arbitrator rank it
 * against a parallel source.
 *
 * Both producers of this union answer the same question — "what fills the
 * model's window right now" — at different granularities. The live snapshot
 * refreshes per settled provider request, so its tokens row counts the
 * request's prompt alone (inputTokens). The transcript anchor seals at turn
 * settlement, so its tokens row counts prompt plus generation (input+output)
 * — the number the per-turn gauge always showed. Displayed the same way;
 * what differs is which request the number describes, and the producers
 * document their own choice.
 */
export type ContextUsageSnapshot =
  | {
      readonly kind: 'tokens';
      readonly tokens: number;
      /**
       * When the metered request settled, on the Host's clock — the same
       * clock transcript rows carry, so a reader can tell whether this
       * snapshot predates a compaction boundary it already knows about.
       * Without it, a snapshot that a compaction has replaced is
       * indistinguishable from one taken after it.
       */
      readonly at?: number;
      /**
       * The window the request was metered against, frozen at call time. Only
       * sources that capture the window alongside the tokens carry this; it
       * must never be filled from another row's ceiling.
       */
      readonly contextWindow?: number;
    }
  | {
      /**
       * A compaction boundary: every measurement that completed before it
       * counts context that no longer exists.
       */
      readonly kind: 'compacted';
      /**
       * When the boundary was applied. Rows that carry no time cannot order
       * themselves against a measurement, so arbitration treats them as
       * losing to it.
       */
      readonly at?: number;
    };

/** The measured variant, when a producer needs to name it. */
export type ContextUsageTokens = Extract<ContextUsageSnapshot, { kind: 'tokens' }>;
