import {
  INLINE_REFERENCE_LABEL_MAX_LENGTH,
  INLINE_REFERENCE_MAX_COUNT,
  isInlineReference,
  type InlineReference,
} from '@maka/core';
import { posix } from 'node:path';
import {
  skillInvocationInlineReferences,
  type SkillInvocationReceipt,
} from '@maka/runtime';

/**
 * Join the two authorities for sent inline tokens, then freeze their transcript
 * order. Renderer references are already restricted to workspace files by the
 * IPC guard; successful Runtime receipts are the sole Skill authority.
 */
export function mergeSentInlineReferences(input: {
  displayText: string;
  workspaceFileReferences?: ReadonlyArray<Pick<InlineReference, 'value' | 'start'>>;
  receipts: readonly SkillInvocationReceipt[];
}): InlineReference[] {
  const candidates: InlineReference[] = [
    ...(input.workspaceFileReferences ?? []).map((reference) => ({
      kind: 'workspace_file' as const,
      value: reference.value,
      label: posix.basename(reference.value.slice(1)),
      start: reference.start,
    })),
    ...skillInvocationInlineReferences(input.receipts, input.displayText),
  ].sort((left, right) => left.start - right.start || right.value.length - left.value.length);
  const references: InlineReference[] = [];
  let previousEnd = 0;
  for (const candidate of candidates) {
    if (references.length >= INLINE_REFERENCE_MAX_COUNT) break;
    const reference = {
      ...candidate,
      label: truncateWithoutSplittingSurrogate(
        candidate.label,
        INLINE_REFERENCE_LABEL_MAX_LENGTH,
      ),
    };
    if (
      !isInlineReference(reference) ||
      reference.start < previousEnd ||
      input.displayText.slice(reference.start, reference.start + reference.value.length) !==
        reference.value
    ) {
      continue;
    }
    references.push(reference);
    previousEnd = reference.start + reference.value.length;
  }
  return references;
}

function truncateWithoutSplittingSurrogate(value: string, maxCodeUnits: number): string {
  const truncated = value.slice(0, maxCodeUnits);
  const lastCodeUnit = truncated.charCodeAt(truncated.length - 1);
  return lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff ? truncated.slice(0, -1) : truncated;
}
