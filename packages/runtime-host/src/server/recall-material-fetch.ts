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

import type { ArtifactRecord } from '@maka/core/artifacts';
import { MAX_ATTACHMENT_BYTES } from '@maka/core/attachments';
import type { RecallMaterialFetch, RecallMaterialFetchResult } from '@maka/core/recall';
import type { ArtifactAttachmentResourceReader } from '@maka/storage/artifact-stores';

/** Declared structurally: this gate needs two reads, not an Artifact store. */
export interface RecallMaterialArtifacts {
  getInSession(
    sessionId: string,
    artifactId: string,
  ): Promise<{ readonly record: ArtifactRecord | null }>;
  copyConversationArtifacts(input: {
    readonly sourceSessionId: string;
    readonly targetSessionId: string;
    readonly turnIds: readonly string[];
    readonly includeArtifactIds: readonly string[];
    readonly existingTarget: 'reuse_verified';
  }): Promise<{ readonly artifactIds: ReadonlyMap<string, string> }>;
}

export interface RecallMaterialFetchDeps {
  readonly artifacts: RecallMaterialArtifacts;
  readonly attachments: ArtifactAttachmentResourceReader;
}

function refused(reason: 'not_found' | 'unsupported', message: string): RecallMaterialFetchResult {
  return { ok: false, reason, message };
}

/**
 * What a material must be before it is brought into the asking Session.
 *
 * Recall has already decided the Session may be seen; this decides the
 * artifact inside it may be taken. `material_id` is model-influenced input, so
 * this is the boundary that keeps a recalled name from becoming a way to read
 * any artifact in the workspace.
 *
 * Only a file a person attached: a tool result, a projection, or an archive is
 * not material a user shared, and copying one would spend storage on a file
 * the model was never offered. Only one `Read` can answer, since a copy it
 * cannot decode is a failed call bought at the price of storing the bytes
 * twice. A refusal reads as "not found" wherever the caller should not learn
 * the difference between an artifact that is not there and one it may not
 * have.
 */
export function createRecallMaterialFetch(deps: RecallMaterialFetchDeps): RecallMaterialFetch {
  return async ({ sourceSessionId, materialId, targetSessionId, abortSignal }) => {
    if (abortSignal?.aborted) return refused('not_found', 'Aborted.');
    const record = await deps.artifacts
      .getInSession(sourceSessionId, materialId)
      .then((entry) => entry.record)
      .catch(() => null);
    if (!record || record.source !== 'user_upload') {
      return refused('not_found', 'That material was not found.');
    }
    if (record.kind === 'pdf') {
      return refused('unsupported', 'PDF materials cannot be decoded.');
    }
    if (record.sizeBytes > MAX_ATTACHMENT_BYTES) {
      return refused('unsupported', 'That material is too large to bring into this Session.');
    }

    const signal = abortSignal ?? new AbortController().signal;
    // A store read or a copy can throw on state that changed under us — the
    // source purged between the check and the copy, a payload deleted after
    // ingest, an abort landing mid-write. The caller is a tool, so those have
    // to arrive as a refusal it can report rather than as an unhandled error.
    try {
      // Already here: answer it without making a second copy of itself.
      if (sourceSessionId === targetSessionId) {
        return {
          ok: true,
          content: await deps.attachments.readAttachmentResource(
            targetSessionId,
            materialId,
            signal,
          ),
        };
      }
      // The copy id is derived from the two Sessions and the source id, so
      // opening the same material again reuses the copy rather than adding
      // one. `reuse_verified` is what lets the second open succeed.
      const copied = await deps.artifacts.copyConversationArtifacts({
        sourceSessionId,
        targetSessionId,
        turnIds: [],
        includeArtifactIds: [materialId],
        existingTarget: 'reuse_verified',
      });
      const copiedId = copied.artifactIds.get(materialId);
      if (!copiedId) {
        return refused('not_found', 'That material could not be brought into this Session.');
      }
      return {
        ok: true,
        content: await deps.attachments.readAttachmentResource(targetSessionId, copiedId, signal),
      };
    } catch {
      return refused('not_found', 'That material could not be read.');
    }
  };
}
