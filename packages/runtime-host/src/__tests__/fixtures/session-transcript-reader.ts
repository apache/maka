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
import type { SessionTurnContribution, SessionTurnLandmark } from '@maka/storage/execution-stores';
import { foldTurnContribution } from '@maka/storage/session-message-projection';
import type { SessionTranscriptReader } from '../../server/session-transcript-reader.js';

export function transcriptReader(
  durable: readonly StoredMessage[],
  overlay: readonly StoredMessage[] = [],
  sequenceStride = 1,
): SessionTranscriptReader {
  const durableRecords = () =>
    durable.map((message, index) => ({ sequence: index * sequenceStride, message }));
  const durableHighWater = () =>
    durable.length === 0 ? null : (durable.length - 1) * sequenceStride + sequenceStride - 1;
  return {
    readDurableHighWater: async () => durableHighWater(),
    readDurablePage: async (_sessionId, request) => {
      const throughSequence =
        request.throughSequence === undefined ? durableHighWater() : request.throughSequence;
      if (throughSequence === null) {
        return { throughSequence: null, fragments: [], rawBytes: 0, next: null };
      }
      const position = request.position ?? (request.direction === 'older' ? throughSequence : 0);
      const candidates = durableRecords()
        .map(({ sequence, message }) => ({
          sequence,
          data: Buffer.from(JSON.stringify(message), 'utf8'),
        }))
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
        if (fragments.length >= request.maxMessages || rawBytes >= request.maxBytes) break;
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
      return { throughSequence, fragments, rawBytes, next };
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
    readDurableMessagesById: async (_sessionId, request) =>
      request.throughSequence === null
        ? []
        : durableRecords().flatMap(({ sequence, message }) =>
            sequence <= request.throughSequence! && request.messageIds.includes(message.id)
              ? [message]
              : [],
          ),
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
    readDurableTurnLandmarks: async (_sessionId, maxLandmarks) => {
      const watermark = durableHighWater();
      if (watermark === null) return { throughSequence: null, landmarks: [] };
      const seen = new Set<string>();
      const landmarks: SessionTurnLandmark[] = [];
      for (const { sequence, message } of durableRecords()) {
        if (landmarks.length >= maxLandmarks) break;
        const turnId = message.turnId;
        if (message.type !== 'user' || turnId === undefined || seen.has(turnId)) continue;
        seen.add(turnId);
        landmarks.push({ turnId, sequence, label: message.displayText ?? message.text });
      }
      return { throughSequence: watermark, landmarks };
    },
    readActiveOverlay: async () => overlay,
  };
}
