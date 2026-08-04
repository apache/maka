import {
  INLINE_REFERENCE_LABEL_MAX_LENGTH,
  INLINE_REFERENCE_MAX_COUNT,
  SKILL_INVOCATION_TOKEN_SOURCE,
  type InlineReference,
} from '@maka/core';
import type { LoadedSkillInstructions, LoadSkillInstructionsResult } from './skills.js';

export type SkillInvocationMode = 'explicit' | 'model_tool';
export type SkillInvocationFailureReason =
  | Exclude<LoadSkillInstructionsResult, { ok: true }>['reason']
  | 'resolution_failed'
  | 'too_many_requests';

export type PerRequestSkillInvocationFailureReason = Exclude<
  SkillInvocationFailureReason,
  'too_many_requests'
>;

/**
 * Bounded, instruction-free record of one Skill load attempt.
 *
 * The receipt is safe to return to clients and project into run traces: it
 * never contains the user prompt, search query, or SKILL.md body.
 */
export type SkillInvocationReceipt =
  | {
      invocation: SkillInvocationMode;
      request: string;
      success: true;
      ref: string;
      id: string;
      name: string;
      scope: LoadedSkillInstructions['scope'];
      source: LoadedSkillInstructions['source'];
      truncated: boolean;
    }
  | {
      invocation: SkillInvocationMode;
      request: string;
      success: false;
      reason: PerRequestSkillInvocationFailureReason;
    }
  | {
      invocation: 'explicit';
      success: false;
      reason: 'too_many_requests';
      requestLimit: number;
    };

export function loadedSkillInvocationReceipt(
  invocation: SkillInvocationMode,
  request: string,
  skill: LoadedSkillInstructions,
): SkillInvocationReceipt {
  return {
    invocation,
    request: boundSkillInvocationRequest(request),
    success: true,
    ref: skill.ref,
    id: skill.id,
    name: skill.name,
    scope: skill.scope,
    source: skill.source,
    truncated: skill.truncated,
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
  return request.replace(/[\u0000-\u001F\u007F]/g, '').slice(0, 512);
}
