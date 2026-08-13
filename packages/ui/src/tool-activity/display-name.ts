/**
 * The name a tool row shows. A tool carries its own `displayName` when the
 * backend named it; the group-activation connector gets a localized label
 * (its raw name reads as an implementation detail); everything else falls back
 * to the canonical tool name.
 */

import type { UiLocale } from '@maka/core/ui-locale';
import type { ToolActivityItem } from '../materialize.js';
import { loadToolDisplayName } from '../tool-format.js';

const CONNECTOR_TOOL_NAMES: ReadonlySet<string> = new Set(['load_tools', 'load_tool']);

export function isConnectorTool(name: string): boolean {
  return CONNECTOR_TOOL_NAMES.has(name);
}

export function resolveToolDisplayName(item: ToolActivityItem, locale: UiLocale): string {
  if (item.displayName) return item.displayName;
  if (isConnectorTool(item.toolName)) return loadToolDisplayName(locale);
  return item.toolName;
}
