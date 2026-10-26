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
import { formatAttachmentResourceRef } from '@maka/core/attachments';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { ToolResultContent } from '@maka/core/events';
import type { InteractiveArtifactStoreWriter } from '@maka/storage/artifact-stores';
import type { ExecutionStoresWriter } from '@maka/storage/execution-stores';
import { markPersisted } from '@maka/core/persisted-value';
import { decodePersistedToolResultContent } from '@maka/core/tool-result-record-schema';
import { IMAGE_MARKDOWN_MAX_LENGTH } from '@maka/core/image-delivery';
import { chatImageSources } from './chat-image-markdown.js';
import type { ChatImageDeliveryService } from './chat-image-delivery.js';

/** Runs before interrupted invocations are sealed. Never reopens a terminal run. */
export async function recoverChatImagePublications(input: {
  sessionIds: readonly string[];
  events: Pick<
    ExecutionStoresWriter<'interactive'>['runtimeEventStore'],
    'listInvocationRecoveryInventory' | 'scanRuntimeEvents' | 'appendRuntimeEvent'
  >;
  artifacts: Pick<InteractiveArtifactStoreWriter, 'listTurnArtifacts'>;
  delivery: Pick<ChatImageDeliveryService, 'recoverReceived' | 'observe'>;
  onLimited?(sessionId: string, runId: string): void;
}): Promise<void> {
  // Only already-received bytes cross this barrier. Remote/local source reads
  // remain background work and cannot hold up Host startup.
  await input.delivery.recoverReceived();
  const inventory = await input.events.listInvocationRecoveryInventory(input.sessionIds);
  for (const { candidate: run } of inventory) {
    if (!run || run.terminalEvent) continue;
    const artifacts = (await input.artifacts.listTurnArtifacts(run.sessionId, run.turnId)).filter(
      (artifact) => artifact.imageDelivery?.publicationRunId === run.runId,
    );
    const targets = artifacts.map((artifact) => ({
      artifact,
      source: formatAttachmentResourceRef({
        kind: 'session_file',
        sessionId: run.sessionId,
        relativePath: artifact.id,
      })!,
      id:
        'recovered_image_' +
        createHash('sha256')
          .update(JSON.stringify([run.runId, artifact.id]))
          .digest('hex'),
    }));
    const texts: RuntimeEvent[] = [];
    const referenced = new Set<string>();
    const collect = (content: ToolResultContent): void => {
      if (
        content.kind === 'image' &&
        content.ref.kind === 'session_file' &&
        content.ref.sessionId === run.sessionId
      )
        referenced.add(content.ref.relativePath);
      if (content.kind === 'content') for (const part of content.parts) collect(part);
    };
    const scanned = await input.events.scanRuntimeEvents(
      run.sessionId,
      run.runId,
      {
        maxBatchBytes: 8 * 1024 * 1024,
        maxRecordBytes: 64 * 1024 * 1024,
        maxImmutableRecords: 1_000_000,
        maxImmutableBytes: Number.MAX_SAFE_INTEGER,
        maxPartialRecords: 65536,
        maxPartialBytes: 256 * 1024 * 1024,
      },
      (batch) => {
        for (const event of batch) {
          if (event.partial) continue;
          for (const target of targets) {
            if (
              event.id === target.id ||
              (event.role === 'model' &&
                event.content?.kind === 'text' &&
                event.content.text.includes(target.source))
            )
              referenced.add(target.artifact.id);
          }
          if (event.content?.kind === 'function_response') {
            try {
              collect(
                decodePersistedToolResultContent(
                  markPersisted<ToolResultContent>(event.content.result),
                ),
              );
            } catch {
              /* An opaque legacy result grants no image reference. */
            }
          }
          if (
            event.role === 'model' &&
            event.content?.kind === 'text' &&
            event.content.text.length <= IMAGE_MARKDOWN_MAX_LENGTH &&
            chatImageSources(event.content.text).length
          ) {
            texts.push(event);
            if (texts.length > 512) texts.shift();
          }
        }
      },
    );
    // An oversized individual record must not block unrelated Host recovery.
    // Do not infer a missing publication from incomplete evidence.
    if (scanned.status !== 'complete') {
      input.onLimited?.(run.sessionId, run.runId);
      continue;
    }
    for (const event of texts) {
      if (event.content?.kind !== 'text') continue;
      // Covers the crash window between canonical text commit and observation.
      await input.delivery.observe(run.sessionId, {
        type: 'text_complete',
        id: event.id,
        turnId: event.turnId,
        ts: event.ts,
        messageId: event.refs?.storedMessageId ?? event.refs?.providerEventId ?? event.id,
        text: event.content.text,
      });
    }
    for (const { artifact, source, id } of targets) {
      if (referenced.has(artifact.id)) continue;
      // A durable Artifact is also the publication receipt: it retains exact run
      // ownership after the spool is retired. Stable identity makes replay safe
      // if the process dies again after this event commits.
      const recovered: RuntimeEvent = {
        id,
        sessionId: run.sessionId,
        runId: run.runId,
        invocationId: run.invocationId,
        turnId: run.turnId,
        ts: artifact.createdAt,
        partial: false,
        role: 'model',
        author: 'host',
        modelVisibility: 'hidden',
        content: {
          kind: 'text',
          text: `Recovered image received before interruption.\n\n![Recovered image](${source})`,
        },
        refs: { artifactId: artifact.id, storedMessageId: id },
      };
      await input.events.appendRuntimeEvent(run.sessionId, run.runId, recovered, { durable: true });
    }
  }
}
