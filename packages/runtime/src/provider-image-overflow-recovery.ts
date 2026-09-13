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

import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { ModelMessage } from './model-protocol.js';
import {
  decodeEffectiveToolResultProjection,
  effectiveToolResultMedia,
} from './durable-tool-result-projection.js';

export interface HistoricalImageToolResult {
  toolName: string;
  artifactLabel: string;
}

export interface HistoricalImageOmissionResult {
  messages: ModelMessage[];
  omittedParts: number;
  omittedToolCallIds: Set<string>;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object';
}

/**
 * The image Tool Results a rejected request can give back, read through the
 * same decode the budget measures — not from the raw execution fact, which the
 * durable projection may already have bounded or redacted.
 */
export function collectHistoricalImageToolResults(
  events: readonly RuntimeEvent[],
): Map<string, HistoricalImageToolResult> {
  const collected = new Map<string, HistoricalImageToolResult>();
  for (const event of events) {
    const content = event.content;
    if (content?.kind !== 'function_response' || content.isError === true) continue;
    const effective = decodeEffectiveToolResultProjection(content, event.sessionId);
    const [media] = effectiveToolResultMedia(effective, event.sessionId);
    if (!media || media.label.length === 0) continue;
    collected.set(content.id, { toolName: content.name, artifactLabel: media.label });
  }
  return collected;
}

/** A `file` part carrying inline image bytes, not a URL the provider fetches. */
export function isInlineImageFilePart(
  value: unknown,
): value is { type: 'file'; mediaType: string; data: object } {
  if (
    !isRecord(value) ||
    value.type !== 'file' ||
    typeof value.mediaType !== 'string' ||
    !value.mediaType.toLowerCase().startsWith('image/') ||
    !isRecord(value.data)
  ) {
    return false;
  }
  return value.data.type === 'data';
}

function omissionText(image: HistoricalImageToolResult): UnknownRecord {
  return {
    type: 'text',
    text: `[Image artifact ${JSON.stringify(image.artifactLabel)} omitted after provider context overflow. Repeat the preceding ${image.toolName} tool call if visual context is required.]`,
  };
}

function rewriteToolResultPart(
  part: unknown,
  eligible: ReadonlyMap<string, HistoricalImageToolResult>,
  omittedToolCallIds: Set<string>,
): { part: unknown; omittedParts: number } {
  if (
    !isRecord(part) ||
    part.type !== 'tool-result' ||
    typeof part.toolCallId !== 'string' ||
    !isRecord(part.output) ||
    part.output.type !== 'content' ||
    !Array.isArray(part.output.value)
  ) {
    return { part, omittedParts: 0 };
  }
  const image = eligible.get(part.toolCallId);
  if (!image) return { part, omittedParts: 0 };

  let omittedParts = 0;
  const value = part.output.value.map((contentPart) => {
    if (!isInlineImageFilePart(contentPart)) return contentPart;
    omittedParts += 1;
    return omissionText(image);
  });
  if (omittedParts === 0) return { part, omittedParts: 0 };
  omittedToolCallIds.add(part.toolCallId);
  return { part: { ...part, output: { ...part.output, value } }, omittedParts };
}

export function omitHistoricalImageToolResults(
  messages: readonly ModelMessage[],
  eligible: ReadonlyMap<string, HistoricalImageToolResult>,
): HistoricalImageOmissionResult {
  const omittedToolCallIds = new Set<string>();
  let omittedParts = 0;
  const rewritten = messages.map((message) => {
    if (!Array.isArray(message.content)) return message;
    let changed = false;
    const content = (message.content as unknown[]).map((part) => {
      const result = rewriteToolResultPart(part, eligible, omittedToolCallIds);
      if (result.part !== part) changed = true;
      omittedParts += result.omittedParts;
      return result.part;
    });
    return changed ? ({ ...message, content } as ModelMessage) : message;
  });
  return { messages: rewritten, omittedParts, omittedToolCallIds };
}
