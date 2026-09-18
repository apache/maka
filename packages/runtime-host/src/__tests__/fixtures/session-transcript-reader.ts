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

import type { StoredMessage } from '@maka/core/session';
import type { SessionTurnContribution } from '@maka/storage/execution-stores';
import { foldTurnContribution } from '@maka/storage/session-message-projection';
import type { SessionTurnLandmark } from '../../protocol/index.js';
import type { SessionTranscriptReader } from '../../server/session-transcript-reader.js';

export function transcriptReader(
  durable: readonly StoredMessage[],
  sequenceStride = 1,
): SessionTranscriptReader {
  // Here Turns do not interleave, so a run of rows with one turnId is a whole
  // Turn and a page is between Turns wherever that run changes.
  const durableRecords = () => {
    let cluster = 0;
    let owner: string | undefined;
    return durable.map((message, index) => {
      const turnId = 'turnId' in message ? message.turnId : undefined;
      if (index === 0 || turnId !== owner) cluster += 1;
      owner = turnId;
      return { sequence: index * sequenceStride, message, cluster };
    });
  };
  const durableHighWater = () =>
    durable.length === 0 ? null : (durable.length - 1) * sequenceStride + sequenceStride - 1;
  return {
    readDurableHighWater: async () => durableHighWater(),
    // Cuts pages more simply than the ledger reader does — what it shares is
    // the contract the pager depends on: rows the projection hides take up no
    // room on the page, and the page resumes past them.
    readDurablePage: async (_sessionId, request, project) => {
      const throughSequence =
        request.throughSequence === undefined ? durableHighWater() : request.throughSequence;
      if (throughSequence === null) {
        return {
          throughSequence: null,
          fragments: [],
          rawBytes: 0,
          next: null,
          endsAtTurnBoundary: true,
        };
      }
      const position = request.position ?? (request.direction === 'older' ? throughSequence : 0);
      const candidates = durableRecords()
        .flatMap(({ sequence, message, cluster }) => {
          const projected = project ? project(message) : message;
          return projected === null
            ? []
            : [{ sequence, cluster, data: Buffer.from(JSON.stringify(projected), 'utf8') }];
        })
        .filter(
          ({ sequence }) =>
            sequence <= throughSequence &&
            (request.direction === 'older' ? sequence <= position : sequence >= position),
        )
        .sort((left, right) =>
          request.direction === 'older'
            ? right.sequence - left.sequence
            : left.sequence - right.sequence,
        );
      let endsAtTurnBoundary = true;
      const fragments = [] as Array<{
        sequence: number;
        byteOffset: number;
        totalBytes: number;
        payloadDigest: null;
        data: Buffer;
      }>;
      let rawBytes = 0;
      let next: { position: number; byteOffset: number | null } | null = null;
      for (const candidate of candidates) {
        if (fragments.length >= request.maxMessages || rawBytes >= request.maxBytes) {
          endsAtTurnBoundary = candidate.cluster !== candidates[fragments.length - 1]?.cluster;
          break;
        }
        const continued = candidate.sequence === position && request.byteOffset !== undefined;
        const edge = continued
          ? request.byteOffset!
          : request.direction === 'older'
            ? candidate.data.byteLength
            : 0;
        const available = request.maxBytes - rawBytes;
        const byteOffset = request.direction === 'older' ? Math.max(0, edge - available) : edge;
        const end =
          request.direction === 'older'
            ? edge
            : Math.min(candidate.data.byteLength, edge + available);
        fragments.push({
          sequence: candidate.sequence,
          byteOffset,
          totalBytes: candidate.data.byteLength,
          payloadDigest: null,
          data: candidate.data.subarray(byteOffset, end),
        });
        rawBytes += end - byteOffset;
        const complete =
          request.direction === 'older' ? byteOffset === 0 : end === candidate.data.byteLength;
        if (!complete) {
          endsAtTurnBoundary = false;
          next = {
            position: candidate.sequence,
            byteOffset: request.direction === 'older' ? byteOffset : end,
          };
          break;
        }
      }
      if (next === null && fragments.length > 0 && fragments.length < candidates.length) {
        next = {
          position: candidates[fragments.length]!.sequence,
          byteOffset: null,
        };
      }
      return { throughSequence, fragments, rawBytes, next, endsAtTurnBoundary };
    },
    readDurableRecords: async (_sessionId, request) => {
      const throughSequence =
        request.throughSequence === undefined ? durableHighWater() : request.throughSequence;
      if (throughSequence === null) {
        return { throughSequence: null, records: [], nextPosition: null };
      }
      const position = request.position ?? (request.direction === 'older' ? throughSequence : 0);
      const candidates = durableRecords()
        .filter(
          ({ sequence }) =>
            sequence <= throughSequence &&
            (request.direction === 'older' ? sequence <= position : sequence >= position),
        )
        .sort((left, right) =>
          request.direction === 'older'
            ? right.sequence - left.sequence
            : left.sequence - right.sequence,
        );
      const records: ReturnType<typeof durableRecords> = [];
      let storedBytes = 0;
      for (const candidate of candidates) {
        if (records.length >= request.maxMessages || storedBytes >= request.maxStoredBytes) break;
        records.push(candidate);
        storedBytes += Buffer.byteLength(JSON.stringify(candidate.message), 'utf8');
      }
      return {
        throughSequence,
        records,
        nextPosition:
          records.length < candidates.length ? candidates[records.length]!.sequence : null,
      };
    },
    readDurableTurnContributions: async (
      _sessionId,
      throughSequence,
      position,
      maxContributions,
    ) => {
      const watermark = throughSequence ?? durableHighWater();
      if (watermark === null)
        return { throughSequence: null, contributions: [], nextPosition: null };
      const folded = new Map<string, SessionTurnContribution>();
      for (const { sequence, message } of durableRecords()) {
        const turnId = message.turnId;
        if (turnId === undefined || sequence < position || sequence > watermark) continue;
        if (!folded.has(turnId) && folded.size >= maxContributions) {
          return {
            throughSequence: watermark,
            contributions: [...folded.values()],
            nextPosition: sequence,
          };
        }
        folded.set(turnId, foldTurnContribution(folded.get(turnId), turnId, sequence, message));
      }
      return {
        throughSequence: watermark,
        contributions: [...folded.values()],
        nextPosition: null,
      };
    },
    readDurableTurnLandmarks: async (_sessionId, request) => {
      const watermark = durableHighWater();
      if (watermark === null) return { throughSequence: null, landmarks: [] };
      const seen = new Set<string>();
      const landmarks: SessionTurnLandmark[] = [];
      for (const { sequence, message } of durableRecords()) {
        if (landmarks.length >= request.maxLandmarks) break;
        const turnId = message.turnId;
        if (message.type !== 'user' || turnId === undefined || seen.has(turnId)) continue;
        if (request.turnId !== null && turnId !== request.turnId) continue;
        seen.add(turnId);
        const lastSequence = Math.max(
          ...durableRecords()
            .filter((record) => record.message.turnId === turnId)
            .map((record) => record.sequence),
        );
        landmarks.push({
          turnId,
          sequence,
          lastSequence,
          label: message.displayText ?? message.text,
        });
      }
      return { throughSequence: watermark, landmarks };
    },
  };
}
