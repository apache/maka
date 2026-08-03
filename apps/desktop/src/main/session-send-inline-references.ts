import type { InlineReference } from '@maka/core';
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
  rendererReferences?: readonly InlineReference[];
  receipts: readonly SkillInvocationReceipt[];
}): InlineReference[] {
  const byValue = new Map<string, InlineReference>();
  for (const reference of [
    ...(input.rendererReferences ?? []),
    ...skillInvocationInlineReferences(input.receipts),
  ]) {
    if (!input.displayText.includes(reference.value) || byValue.has(reference.value)) continue;
    byValue.set(reference.value, reference);
  }
  return [...byValue.values()].sort((left, right) => {
    const position = input.displayText.indexOf(left.value) - input.displayText.indexOf(right.value);
    return position || right.value.length - left.value.length;
  });
}
