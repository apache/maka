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

import { runRecall, type RecallDeps, type RecallPassage } from '@maka/core/recall';
import type {
  OperationOutcome,
  RecallQueryInput,
  RecallQueryPassage,
  RecallQueryResult,
} from '../protocol/index.js';
import type { RecallOperationHandlerMap } from './operation-dispatcher.js';

/**
 * Serves `recall.query` from the same dependency graph the model's `Recall`
 * tool uses.
 *
 * The point of this coordinator is that it owns no retrieval logic: it hands
 * the request to `runRecall` and projects the answer. Whatever recall can see —
 * privacy gating, archived Sessions, the distilled-fact store — a Client
 * asking over the wire sees the same thing, because there is one implementation
 * and this is not a second one.
 *
 * Unlike the model's tool, no turn is excluded. A tool call runs inside a turn
 * and must not surface that turn's own text back as corroboration; a Client
 * search is not inside any turn, so there is nothing to exclude.
 */
export class HostRecallCoordinator {
  readonly handlers: RecallOperationHandlerMap = {
    'recall.query': (input) => this.#query(input),
  };

  constructor(private readonly deps: RecallDeps) {}

  async #query(input: RecallQueryInput): Promise<OperationOutcome<'recall.query'>> {
    try {
      const result = await runRecall(input, this.deps, { includeArchived: true });
      return { ok: true, result: projectRecallResult(result) };
    } catch {
      return {
        ok: false,
        error: { code: 'internal_failure', message: 'Recall query failed' },
      };
    }
  }
}

/**
 * `RecallQueryResult` is the core result with the Host's field vocabulary.
 *
 * Recall already returns exactly these fields; the projection exists to drop
 * core-internal detail and to make the boundary explicit, so a change to the
 * core shape shows up here rather than silently widening the wire.
 */
export function projectRecallResult(
  result: Awaited<ReturnType<typeof runRecall>>,
): RecallQueryResult {
  if (!result.ok) {
    return { ok: false, reason: result.reason, message: result.message };
  }
  return {
    ok: true,
    facts: result.facts.map((fact) => ({
      content: fact.content,
      kind: fact.kind,
      observedAt: fact.observedAt,
    })),
    passages: result.passages.map((passage) => projectPassage(passage)),
    gaps: result.gaps,
    searchedEverySession: result.scannedFully,
  };
}

function projectPassage(passage: RecallPassage): RecallQueryPassage {
  return {
    sessionId: passage.sessionId,
    sessionTitle: passage.sessionTitle,
    ...(passage.turnId ? { turnId: passage.turnId } : {}),
    anchorMessageId: passage.anchorMessageId,
    sequence: passage.sequence,
    messages: passage.messages.map((message) => ({
      messageId: message.messageId,
      role: message.role,
      matchKind: message.matchKind,
      text: message.text,
      timestamp: message.timestamp,
      isAnchor: message.isAnchor,
      ...(message.materials
        ? {
            materials: message.materials.map((material) => ({
              name: material.name,
              kind: material.kind,
              mimeType: material.mimeType,
              bytes: material.bytes,
              ...(material.resource ? { resource: material.resource } : {}),
              ...(material.sourceSessionId && material.materialId
                ? {
                    sourceSessionId: material.sourceSessionId,
                    materialId: material.materialId,
                  }
                : {}),
            })),
          }
        : {}),
    })),
    matchedTerms: passage.matchedTerms,
    score: passage.score,
    ...(passage.lastMessageAt !== undefined ? { lastMessageAt: passage.lastMessageAt } : {}),
    hasMoreBefore: passage.hasMoreBefore,
    hasMoreAfter: passage.hasMoreAfter,
    ...(passage.truncated ? { truncated: true } : {}),
  };
}
