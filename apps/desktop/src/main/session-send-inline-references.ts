import type { InlineReference } from '@maka/core';
import { skillInvocationInlineReferences, type SkillInvocationReceipt } from '@maka/runtime';
import {
  mergeSessionInlineReferences,
  workspaceFileInlineReferenceCandidates,
} from './session-workspace-inline-references.js';

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
  return mergeSessionInlineReferences(input.displayText, [
    ...workspaceFileInlineReferenceCandidates(input),
    ...skillInvocationInlineReferences(input.receipts, input.displayText),
  ]);
}
