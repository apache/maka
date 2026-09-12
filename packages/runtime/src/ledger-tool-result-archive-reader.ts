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

import { createHash } from 'node:crypto';
import { decodeDurableToolResultProjection } from '@maka/core/durable-tool-result-projection';
import {
  durableToolResultProjectionDigest,
  type ModelProjectionTransition,
} from '@maka/core/model-projection-transition';
import type { ToolResultArchiveEvidenceReader } from '@maka/core/tool-result-archive-evidence';
import {
  decodeLedgerTransition,
  reduceEffectiveModelProjections,
} from './model-projection-transition-ledger.js';
import {
  isArchivedToolResultPlaceholder,
  type ToolResultArchiveReader,
} from './tool-result-archive.js';
import { serializeToolResultProjectionV1 } from './tool-result-archive-encoding.js';
import type { LedgerArchiveResourceIdentity } from './tool-result-archive-resource.js';
import type { ToolResultArchiveRecorder } from './tool-result-archive-capability.js';
import {
  TOOL_RESULT_ARCHIVE_EVIDENCE_MAX_BYTES,
  TOOL_RESULT_ARCHIVE_EVIDENCE_MAX_TRANSITIONS,
} from '@maka/core/tool-result-archive-evidence';

/**
 * Read-only v1 reconstruction. It never calls a live tool projector, reads an
 * Artifact, changes history, or authorizes access from a hash alone.
 * The evidence port is trusted to return the complete bounded target history.
 */
export function createLedgerToolResultArchiveReader(
  evidence: ToolResultArchiveEvidenceReader,
): ToolResultArchiveReader {
  return async (input) => {
    const request = { ...input };
    if (
      !isArchivedToolResultPlaceholder(request) ||
      !/^[a-f0-9]{64}$/.test(request.bodySha256) ||
      !Number.isSafeInteger(request.originalBytes) ||
      request.originalBytes < 1
    ) {
      return { ok: false, reason: 'corrupt' };
    }
    const maxBytes = request.maxBytes ?? request.originalBytes;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < request.originalBytes)
      return { ok: false, reason: 'too_large' };
    try {
      const loaded = await evidence.read({
        sessionId: request.sessionId,
        runtimeEventId: request.runtimeEventId,
      });
      if (!loaded.ok)
        return {
          ok: false,
          reason: loaded.reason === 'unavailable' ? 'read_failed' : loaded.reason,
        };
      const { event } = loaded;
      const content = event.content;
      if (event.sessionId !== request.sessionId) return { ok: false, reason: 'session_mismatch' };
      if (
        event.id !== request.runtimeEventId ||
        content?.kind !== 'function_response' ||
        content.id !== request.toolCallId ||
        content.name !== request.toolName ||
        content.providerExecuted ||
        !content.modelProjection
      )
        return { ok: false, reason: 'source_mismatch' };
      let source = decodeDurableToolResultProjection(content.modelProjection);
      const byId = new Map<string, ModelProjectionTransition>();
      for (const record of loaded.transitions) {
        const transition = decodeLedgerTransition(record, request.sessionId);
        if (
          !transition ||
          record.sessionId !== request.sessionId ||
          transition.target.runtimeEventId !== event.id
        )
          return { ok: false, reason: 'corrupt' };
        const previous = byId.get(transition.transitionId);
        if (
          previous &&
          JSON.stringify({ ...previous, createdAt: 0 }) !==
            JSON.stringify({ ...transition, createdAt: 0 })
        ) {
          return { ok: false, reason: 'corrupt' };
        }
        byId.set(transition.transitionId, transition);
      }
      const reduction = reduceEffectiveModelProjections([event], [...byId.values()]);
      for (const transition of reduction.applied) {
        const replacement = transition.replacement;
        const placeholder = replacement.kind === 'json' ? replacement.value : undefined;
        if (
          isArchivedToolResultPlaceholder(placeholder) &&
          ((placeholder.rewriteVersion === 1 &&
            request.rewriteVersion === 1 &&
            placeholder.artifactId === request.artifactId) ||
            (placeholder.rewriteVersion === 2 &&
              request.rewriteVersion === 2 &&
              placeholder.sourceProjectionDigest === request.sourceProjectionDigest &&
              placeholder.previousTransitionId === request.previousTransitionId))
        ) {
          if (
            placeholder.runtimeEventId !== request.runtimeEventId ||
            placeholder.toolCallId !== request.toolCallId ||
            placeholder.toolName !== request.toolName ||
            placeholder.bodySha256 !== request.bodySha256 ||
            placeholder.originalBytes !== request.originalBytes ||
            placeholder.rewriteVersion !== request.rewriteVersion
          )
            return { ok: false, reason: 'source_mismatch' };
          if (
            placeholder.rewriteVersion === 2 &&
            (placeholder.sourceProjectionDigest !== transition.sourceProjectionDigest ||
              placeholder.previousTransitionId !== transition.previousTransitionId)
          )
            return { ok: false, reason: 'corrupt' };
          const serializedResult = serializeToolResultProjectionV1(source);
          if (Buffer.byteLength(serializedResult, 'utf8') !== request.originalBytes)
            return { ok: false, reason: 'size_mismatch' };
          if (createHash('sha256').update(serializedResult).digest('hex') !== request.bodySha256)
            return { ok: false, reason: 'corrupt' };
          return { ok: true, serializedResult };
        }
        source = transition.replacement;
      }
      return { ok: false, reason: 'not_found' };
    } catch {
      return { ok: false, reason: 'corrupt' };
    }
  };
}

export function createLedgerArchiveResourceReader(evidence: ToolResultArchiveEvidenceReader) {
  const reader = createLedgerToolResultArchiveReader(evidence);
  return (input: LedgerArchiveResourceIdentity & { sessionId: string; maxBytes: number }) =>
    reader({
      ...input,
      kind: 'maka.archived_tool_result',
      rewriteVersion: 2,
      originalEstimatedTokens: 1,
      reason: 'stale_tool_result_pruned_before_compact',
    });
}

/** Verify reconstructibility before committing a replacement; does not write any payload. */
export function createLedgerArchivePreparer(
  evidence: ToolResultArchiveEvidenceReader,
): ToolResultArchiveRecorder {
  return async (input) => {
    const request = { ...input };
    const loaded = await evidence.read({
      sessionId: request.sessionId,
      runtimeEventId: request.runtimeEventId,
    });
    if (
      !loaded.ok ||
      loaded.transitions.length >= TOOL_RESULT_ARCHIVE_EVIDENCE_MAX_TRANSITIONS ||
      loaded.storedBytes === undefined ||
      loaded.storedBytes > TOOL_RESULT_ARCHIVE_EVIDENCE_MAX_BYTES - 64 * 1024
    )
      return;
    const content = loaded.event.content;
    if (
      loaded.event.sessionId !== request.sessionId ||
      loaded.event.id !== request.runtimeEventId ||
      content?.kind !== 'function_response' ||
      content.providerExecuted ||
      !content.modelProjection ||
      content.id !== request.toolCallId ||
      content.name !== request.toolName
    )
      return;
    const transitions: ModelProjectionTransition[] = [];
    for (const event of loaded.transitions) {
      const decoded = decodeLedgerTransition(event, request.sessionId);
      if (!decoded || decoded.target.runtimeEventId !== request.runtimeEventId) return;
      transitions.push(decoded);
    }
    const reduced = reduceEffectiveModelProjections([loaded.event], transitions);
    const previous = reduced.applied.at(-1);
    if (previous?.transitionId !== request.previousTransitionId) return;
    const source = previous?.replacement ?? content.modelProjection;
    if (source.kind === 'json' && isArchivedToolResultPlaceholder(source.value)) return;
    if (durableToolResultProjectionDigest(source) !== request.sourceProjectionDigest) return;
    const body = serializeToolResultProjectionV1(source);
    if (
      body !== request.serializedResult ||
      Buffer.byteLength(body) !== request.originalBytes ||
      createHash('sha256').update(body).digest('hex') !== request.bodySha256
    )
      return;
    return { ledger: true };
  };
}
