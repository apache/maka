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
  INLINE_REFERENCE_LABEL_MAX_LENGTH,
  INLINE_REFERENCE_MAX_COUNT,
  type InlineReference,
} from '@maka/core/events';
import {
  SKILL_INVOCATION_ID_MAX_BYTES,
  SKILL_INVOCATION_NAME_MAX_BYTES,
  SKILL_INVOCATION_REF_MAX_BYTES,
  SKILL_INVOCATION_REQUEST_MAX_BYTES,
  type PerRequestSkillInvocationFailureReason,
  type SkillInvocationMode,
  type SkillInvocationReceipt,
} from '@maka/core/skill-invocation';
import { SKILL_INVOCATION_TOKEN_SOURCE } from '@maka/core/skill-invocation-token';
import type { LoadedSkillInstructions } from './skills.js';

export type {
  PerRequestSkillInvocationFailureReason,
  SkillInvocationFailureReason,
  SkillInvocationMode,
  SkillInvocationReceipt,
} from '@maka/core/skill-invocation';

export function loadedSkillInvocationReceipt(
  invocation: SkillInvocationMode,
  request: string,
  skill: LoadedSkillInstructions,
): SkillInvocationReceipt {
  return {
    invocation,
    request: boundSkillInvocationRequest(request),
    success: true,
    ref: truncateUtf8(skill.ref, SKILL_INVOCATION_REF_MAX_BYTES),
    id: truncateUtf8(skill.id, SKILL_INVOCATION_ID_MAX_BYTES),
    name: truncateUtf8(skill.name, SKILL_INVOCATION_NAME_MAX_BYTES),
    scope: skill.scope,
    source: skill.source,
    truncated: skill.truncated,
  };
}

export function skillInvocationLoadedEntry(skill: Pick<LoadedSkillInstructions, 'id' | 'name'>): {
  readonly id: string;
  readonly name: string;
} {
  return {
    id: truncateUtf8(skill.id, SKILL_INVOCATION_ID_MAX_BYTES),
    name: truncateUtf8(skill.name, SKILL_INVOCATION_NAME_MAX_BYTES),
  };
}

/** Freeze successful user-authored Skill tokens for transcript rendering. */
export function skillInvocationInlineReferences(
  receipts: readonly SkillInvocationReceipt[],
  displayText: string,
): InlineReference[] {
  const receiptByTokenName = new Map<string, Extract<SkillInvocationReceipt, { success: true }>>();
  for (const receipt of receipts) {
    if (!receipt.success || receipt.invocation !== 'explicit') continue;
    receiptByTokenName.set(receipt.request.toLowerCase(), receipt);
    receiptByTokenName.set(receipt.id.toLowerCase(), receipt);
  }
  const references: InlineReference[] = [];
  for (const match of displayText.matchAll(new RegExp(SKILL_INVOCATION_TOKEN_SOURCE, 'g'))) {
    if (references.length === INLINE_REFERENCE_MAX_COUNT) break;
    const receipt = receiptByTokenName.get(match[1].toLowerCase());
    if (!receipt) continue;
    references.push({
      kind: 'skill',
      value: match[0],
      label: truncateWithoutSplittingSurrogate(receipt.name, INLINE_REFERENCE_LABEL_MAX_LENGTH),
      start: match.index,
    });
  }
  return references;
}

function truncateWithoutSplittingSurrogate(value: string, maxCodeUnits: number): string {
  const truncated = value.slice(0, maxCodeUnits);
  const lastCodeUnit = truncated.charCodeAt(truncated.length - 1);
  return lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff ? truncated.slice(0, -1) : truncated;
}

export function failedSkillInvocationReceipt(
  invocation: SkillInvocationMode,
  request: string,
  reason: PerRequestSkillInvocationFailureReason,
): SkillInvocationReceipt {
  return {
    invocation,
    request: boundSkillInvocationRequest(request),
    success: false,
    reason,
  };
}

export function overflowSkillInvocationReceipt(requestLimit: number): SkillInvocationReceipt {
  return {
    invocation: 'explicit',
    success: false,
    reason: 'too_many_requests',
    requestLimit,
  };
}

/** Privacy-preserving trace projection shared by explicit and model loads. */
export function skillInvocationReceiptTraceData(
  receipt: SkillInvocationReceipt,
): Record<string, unknown> {
  if (!receipt.success) {
    if (receipt.reason === 'too_many_requests') {
      return {
        invocation: receipt.invocation,
        success: false,
        reason: receipt.reason,
        requestLimit: receipt.requestLimit,
      };
    }
    return {
      invocation: receipt.invocation,
      success: false,
      reason: receipt.reason,
      requestChars: receipt.request.length,
    };
  }
  return {
    invocation: receipt.invocation,
    success: true,
    skillRef: receipt.ref,
    skillId: receipt.id,
    skillName: receipt.name,
    skillScope: receipt.scope,
    skillSource: receipt.source,
    truncated: receipt.truncated,
  };
}

export function boundSkillInvocationRequest(request: string): string {
  // Invocation inputs are identifiers, not arbitrary prompts. Still bound and
  // strip controls so diagnostics cannot become an unbounded/log-injection
  // channel when an older client bypasses the normal IPC validator.
  // eslint-disable-next-line no-control-regex
  const cleaned = request.replace(/[\u0000-\u001F\u007F]/g, '');
  return truncateUtf8(cleaned || '[invalid]', SKILL_INVOCATION_REQUEST_MAX_BYTES);
}

function truncateUtf8(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maxBytes) return value;
  let result = '';
  let bytes = 0;
  for (const character of value) {
    const characterBytes = encoder.encode(character).byteLength;
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}
