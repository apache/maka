/**
 * Re-export the shared quiet-panel formatting from `@maka/core` (#1065).
 *
 * `formatToolInvocationLine` and `formatQuietJsonValue` are pure functions
 * extracted from this module into `@maka/core` so the CLI/TUI can consume
 * the same path. Desktop passes the resolved locale from `LocaleProvider`.
 *
 * The desktop `ToolActivityItem`-typed signature is adapted here so existing
 * call sites (`tool-activity.tsx`, `tool-result-preview.tsx`) keep their
 * `Pick<ToolActivityItem, ...>` parameter without depending on the core
 * `ToolInvocationInput` type.
 */
import {
  formatQuietJsonValue as coreFormatQuietJsonValue,
  formatToolInvocationLine as coreFormatToolInvocationLine,
} from '@maka/core/tool-quiet-preview';
import { type UiLocale } from '@maka/core/ui-locale';
import type { ToolActivityItem } from '../materialize.js';

export type { QuietPreview } from '@maka/core/tool-quiet-preview';

/** Desktop-adapted wrapper with an explicit resolved locale. */
export function formatToolInvocationLine(
  item: Pick<ToolActivityItem, 'toolName' | 'args' | 'activityKind'>,
  locale: UiLocale,
): string | undefined {
  return coreFormatToolInvocationLine(
    { toolName: item.toolName, args: item.args },
    locale,
  );
}

/** Desktop-adapted wrapper with an explicit resolved locale. */
export function formatQuietJsonValue(
  value: unknown,
  locale: UiLocale,
): import('@maka/core/tool-quiet-preview').QuietPreview {
  return coreFormatQuietJsonValue(value, locale);
}
