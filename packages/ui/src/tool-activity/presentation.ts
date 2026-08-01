import type { UiLocale } from '@maka/core';
import type { ToolActivityItem } from '../materialize.js';
import { formatUserVisibleToolText } from './preview-utils.js';
import { resolveToolDisplayName, trowActivityKind, type TrowActivityKind } from './trow-summary.js';

// Definitions moved into trow-summary.ts (the leaf module) so the live
// processing summary can use the localized display-name fallback without an
// import cycle; re-exported here for existing consumers.
export { isConnectorTool, resolveToolDisplayName } from './trow-summary.js';

export interface ToolActivityPresentation {
  kind: TrowActivityKind;
  summary: string;
  needsAttention: boolean;
}

export interface ToolDisclosureState {
  open: boolean;
  manuallySet: boolean;
}

export function deriveToolActivityPresentation(
  item: ToolActivityItem,
  locale: UiLocale,
): ToolActivityPresentation {
  return {
    kind: trowActivityKind(item.toolName, item.activityKind),
    summary: formatUserVisibleToolText(item.intent ?? '', locale) || resolveToolDisplayName(item, locale),
    // Only permission prompts force-open; ordinary failures stay collapsed.
    needsAttention: item.status === 'waiting_permission',
  };
}

export function createToolDisclosureState(presentation: ToolActivityPresentation): ToolDisclosureState {
  return { open: presentation.needsAttention, manuallySet: false };
}

export function syncToolDisclosureState(
  current: ToolDisclosureState,
  presentation: ToolActivityPresentation,
): ToolDisclosureState {
  if (presentation.needsAttention) {
    return current.open ? current : createToolDisclosureState(presentation);
  }
  if (current.manuallySet) return current;
  return createToolDisclosureState(presentation);
}

export function setToolDisclosureOpen(
  current: ToolDisclosureState,
  open: boolean,
): ToolDisclosureState {
  return { ...current, open, manuallySet: true };
}
