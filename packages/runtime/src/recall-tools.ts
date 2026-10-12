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

import {
  expandRecallPassage,
  fetchRecallMaterial,
  RECALL_EXPAND_MAX_NEIGHBOURS,
  RECALL_ID_MAX_CHARS,
  RECALL_DEFAULT_LIMIT,
  RECALL_MAX_LIMIT,
  RECALL_MAX_TERMS,
  runRecall,
  type RecallDeps,
  type RecallFailure,
  type RecallPassage,
} from '@maka/core/recall';
import { SEARCH_QUERY_MAX_CHARS } from '@maka/core/search';
import { z } from 'zod';
import type { MakaTool } from './tool-runtime.js';

export const RECALL_TOOL_NAME = 'Recall';
export const RECALL_MORE_TOOL_NAME = 'RecallMore';
export const RECALL_MATERIAL_TOOL_NAME = 'RecallMaterial';

export type RecallToolDeps = RecallDeps;

/**
 * Builds the read-only recall surface: one call that answers "what do I
 * already know about this", and an expansion for the passage that needs more
 * of its exchange than the envelope carried.
 */
export function buildRecallTools(deps: RecallToolDeps): readonly MakaTool[] {
  const tools = [buildRecallTool(deps), buildRecallMoreTool(deps)];
  // A host with no artifact store cannot fetch anything, and a tool that can
  // only refuse is worse than one the model never sees.
  return deps.fetchMaterial ? [...tools, buildRecallMaterialTool(deps)] : tools;
}

export function buildRecallTool(deps: RecallToolDeps): MakaTool {
  return {
    name: RECALL_TOOL_NAME,
    displayName: 'Recall from past conversations',
    activityKind: 'read',
    categoryHint: 'read',
    description:
      'Recall what this workspace already knows about a topic, across every Maka Session including the current one. ' +
      'Supply a few distinct literal terms rather than a sentence: matching is case-insensitive substring, OR-combined, ' +
      'and results rank higher when they contain more of the terms. Returns distilled facts, ranked transcript passages ' +
      'that already carry the surrounding exchange, and a note on what the search did not reach. ' +
      'A message that carried files lists them under materials, matched by file name. A material carrying a resource ' +
      'address can be opened with Read, which answers an image with the image and any other file with its text; a ' +
      'material without one carries source_session_id and material_id instead: pass those to RecallMaterial to ' +
      'bring the file here. A material with neither cannot be retrieved at all. ' +
      'One Recall call usually suffices; use RecallMore only when a passage is cut short.',
    parameters: z
      .object({
        terms: z
          .array(z.string().trim().min(1).max(SEARCH_QUERY_MAX_CHARS))
          .min(1)
          .max(RECALL_MAX_TERMS)
          .describe('Literal terms to look for. Distinct words work better than a phrase.'),
        question: z
          .string()
          .trim()
          .min(1)
          .max(SEARCH_QUERY_MAX_CHARS)
          .optional()
          .describe('Why you are searching. Never matched; recorded with the call.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(RECALL_MAX_LIMIT)
          .optional()
          .describe(`Maximum passages; defaults to ${RECALL_DEFAULT_LIMIT}.`),
        session_id: z
          .string()
          .trim()
          .min(1)
          .max(RECALL_ID_MAX_CHARS)
          .optional()
          .describe('Restrict recall to one Session.'),
        since: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Epoch milliseconds; ignore messages older than this.'),
        until: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Epoch milliseconds; ignore messages newer than this.'),
      })
      .strict(),
    impl: async ({ terms, question, limit, session_id: sessionId, since, until }, context) => {
      const result = await runRecall(
        {
          terms,
          ...(question ? { question } : {}),
          ...(limit !== undefined ? { limit } : {}),
          ...(sessionId ? { sessionId } : {}),
          ...(since !== undefined ? { since } : {}),
          ...(until !== undefined ? { until } : {}),
        },
        deps,
        {
          activeSessionId: context.sessionId,
          // Recall must not surface the turn it is running inside: the model
          // already has that text, and echoing it back reads as corroboration.
          excludeTurnIds: new Set([context.turnId]),
          includeArchived: true,
          abortSignal: context.abortSignal,
        },
      );
      if (!result.ok) return recallError(result);
      return {
        kind: 'recall' as const,
        facts: result.facts.map((fact) => ({
          content: fact.content,
          kind: fact.kind,
          observed_at: fact.observedAt,
        })),
        passages: result.passages.map((passage) => projectPassage(passage, context.sessionId)),
        gaps: result.gaps,
        // Whether every Session was read or a narrowing chose them: an empty
        // envelope means different things under the two, and only the caller
        // can decide whether to widen its terms.
        searched_every_session: result.scannedFully,
      };
    },
  };
}

export function buildRecallMaterialTool(deps: RecallToolDeps): MakaTool {
  return {
    name: RECALL_MATERIAL_TOOL_NAME,
    displayName: 'Open a recalled file',
    activityKind: 'read',
    categoryHint: 'read',
    description:
      'Open a file a Recall passage named but could not hand you directly, using its source_session_id ' +
      'and material_id. The file is copied into this Session and returned the way Read returns one ' +
      'stored here, so it stays readable afterwards; opening the same material again reuses that copy. ' +
      'Only files a person attached are retrievable, and only from Sessions Recall can already see. ' +
      'A material that came back with a resource address needs no retrieval — read that address instead.',
    parameters: z
      .object({
        session_id: z
          .string()
          .trim()
          .min(1)
          .max(RECALL_ID_MAX_CHARS)
          .describe('The material source_session_id from a Recall passage.'),
        material_id: z
          .string()
          .trim()
          .min(1)
          .max(RECALL_ID_MAX_CHARS)
          .describe('The material_id from a Recall passage.'),
      })
      .strict(),
    impl: async ({ session_id: sessionId, material_id: materialId }, context) => {
      const result = await fetchRecallMaterial({ sessionId, materialId }, deps, {
        activeSessionId: context.sessionId,
        includeArchived: true,
        abortSignal: context.abortSignal,
      });
      if (!result.ok) return recallError(result);
      return result.content;
    },
  };
}

export function buildRecallMoreTool(deps: RecallToolDeps): MakaTool {
  return {
    name: RECALL_MORE_TOOL_NAME,
    displayName: 'Widen a recalled passage',
    activityKind: 'read',
    categoryHint: 'read',
    description:
      'Widen one passage that Recall returned, when its exchange was cut short. ' +
      'Pass the passage session_id and anchor_message_id. ' +
      'Hidden reasoning, permission records, and raw tool arguments are never returned.',
    parameters: z
      .object({
        session_id: z
          .string()
          .trim()
          .min(1)
          .max(RECALL_ID_MAX_CHARS)
          .describe('From a Recall passage.'),
        anchor_message_id: z
          .string()
          .trim()
          .min(1)
          .max(RECALL_ID_MAX_CHARS)
          .describe('The passage anchor id from Recall.'),
        before: z
          .number()
          .int()
          .min(0)
          .max(RECALL_EXPAND_MAX_NEIGHBOURS)
          .optional()
          .describe(
            `Visible messages before the anchor; defaults to ${RECALL_EXPAND_MAX_NEIGHBOURS}.`,
          ),
        after: z
          .number()
          .int()
          .min(0)
          .max(RECALL_EXPAND_MAX_NEIGHBOURS)
          .optional()
          .describe(
            `Visible messages after the anchor; defaults to ${RECALL_EXPAND_MAX_NEIGHBOURS}.`,
          ),
      })
      .strict(),
    impl: async (
      { session_id: sessionId, anchor_message_id: anchorMessageId, before, after },
      context,
    ) => {
      const result = await expandRecallPassage(
        {
          sessionId,
          anchorMessageId,
          ...(before !== undefined ? { before } : {}),
          ...(after !== undefined ? { after } : {}),
        },
        deps,
        {
          activeSessionId: context.sessionId,
          excludeTurnIds: new Set([context.turnId]),
          includeArchived: true,
          abortSignal: context.abortSignal,
        },
      );
      if (!result.ok) return recallError(result);
      return {
        kind: 'recall_expand' as const,
        passage: projectPassage(result.passage, context.sessionId),
      };
    },
  };
}

function projectPassage(passage: RecallPassage, activeSessionId: string) {
  return {
    session_id: passage.sessionId,
    title: passage.sessionTitle,
    ...(passage.turnId ? { turn_id: passage.turnId } : {}),
    anchor_message_id: passage.anchorMessageId,
    // The anchor's index in its Session transcript. Carried for the same
    // reason a UI needs it: a caller that wants to point at the passage in a
    // transcript scrolls by sequence, and this spares it a second lookup.
    sequence: passage.sequence,
    is_current_session: passage.sessionId === activeSessionId,
    ...(passage.lastMessageAt !== undefined ? { last_message_at: passage.lastMessageAt } : {}),
    matched_terms: passage.matchedTerms,
    score: passage.score,
    has_more_before: passage.hasMoreBefore,
    has_more_after: passage.hasMoreAfter,
    ...(passage.truncated ? { truncated: true } : {}),
    messages: passage.messages.map((message) => ({
      message_id: message.messageId,
      role: message.role,
      match_kind: message.matchKind,
      timestamp: message.timestamp,
      ...(message.isAnchor ? { is_anchor: true } : {}),
      text: message.text,
      // Metadata only. `resource` is present exactly when the file is
      // readable from the Session asking; elsewhere the material is named
      // but has no address, because an attachment read resolves against the
      // calling Session and would refuse one stored in another.
      ...(message.materials
        ? {
            materials: message.materials.map((material) => ({
              name: material.name,
              kind: material.kind,
              mime_type: material.mimeType,
              bytes: material.bytes,
              ...(material.resource ? { resource: material.resource } : {}),
              ...(material.sourceSessionId && material.materialId
                ? {
                    source_session_id: material.sourceSessionId,
                    material_id: material.materialId,
                  }
                : {}),
            })),
          }
        : {}),
    })),
  };
}

function recallError(failure: RecallFailure) {
  return {
    kind: 'recall_error' as const,
    ok: false as const,
    reason: failure.reason,
    message: failure.message,
  };
}
