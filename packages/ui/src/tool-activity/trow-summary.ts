/**
 * Pure helpers for the Codex-style tool "trow" summary (issue: streaming UI
 * rework). A trow groups a contiguous run of tool activity into one collapsed
 * row; when every tool in the group has settled, the summary line buckets them
 * by activity kind and prints a compact Chinese count phrase like
 * "读取 3 个文件，搜索 2 次". Modeled on pawwork's `contextTrowSummaryText`,
 * translated to maka's canonical tool names + inline Chinese strings (no i18n
 * catalog dependency).
 *
 * Kept pure + separately unit-tested; the React trow renders it and maps the
 * kind to an icon.
 */

import type { ToolActivityKind, UiLocale } from '@maka/core';
import type { ToolActivityItem } from '../materialize.js';
import { loadToolDisplayName } from '../tool-format.js';
import { getToolActivityCopy } from './copy.js';
import { isSandboxDeniedTool } from './sandbox-denial.js';

export type TrowActivityKind = ToolActivityKind;

// Connector-tool naming lives in this leaf module (rather than
// presentation.ts, which imports us) so the live processing summary below can
// reuse the same localized fallback without an import cycle. presentation.ts
// re-exports both for its existing consumers.
const CONNECTOR_TOOL_NAMES: ReadonlySet<string> = new Set(['load_tools', 'load_tool']);

export function isConnectorTool(name: string): boolean {
  return CONNECTOR_TOOL_NAMES.has(name);
}

export function resolveToolDisplayName(item: ToolActivityItem, locale: UiLocale): string {
  if (item.displayName) return item.displayName;
  if (isConnectorTool(item.toolName)) return loadToolDisplayName(locale);
  return item.toolName;
}

/**
 * Prefer a declared semantic category. Legacy rows fall back to the canonical
 * tool name (case-insensitive); unknown names use the generic `tool` bucket.
 */
const KNOWN_ACTIVITY_KINDS: ReadonlySet<string> = new Set<TrowActivityKind>([
  'read',
  'search',
  'websearch',
  'webfetch',
  'edit',
  'command',
  'explore',
  'browser',
  'tool',
]);

export function trowActivityKind(
  toolName: string,
  activityKind?: ToolActivityKind,
): TrowActivityKind {
  // Trust only known kinds — corrupted/future persisted values must not crash
  // KIND_CLAUSE[kind] during summarize.
  if (activityKind && KNOWN_ACTIVITY_KINDS.has(activityKind)) return activityKind;
  const name = toolName.toLowerCase();
  if (name.startsWith('browser_')) return 'browser';
  switch (name) {
    case 'read':
    case 'list':
      return 'read';
    case 'glob':
    case 'grep':
      return 'search';
    case 'websearch':
    case 'web_search':
      return 'websearch';
    case 'webfetch':
    case 'web_fetch':
      return 'webfetch';
    case 'write':
    case 'edit':
    case 'multiedit':
    case 'apply_patch':
      return 'edit';
    case 'bash':
    case 'shell':
    case 'stopbackgroundtask':
    case 'stop_background_task':
      return 'command';
    case 'exploreagent':
    case 'explore_agent':
      return 'explore';
    default:
      return 'tool';
  }
}

/** Count clause per bucket, e.g. read(3) -> "读取 3 个文件". */
function isFailed(item: ToolActivityItem): boolean {
  return item.status === 'errored' && !isSandboxDeniedTool(item);
}

/**
 * Build the summary line for a trow: one clause per distinct activity kind in
 * first-seen order, joined with "，". With `{ live: true }` (a multi-tool
 * running group) the line is prefixed with "正在". The "N 个失败" clause is
 * included whenever any tool errored — errored tools stay collapsed, so the
 * summary line is the failure signal and must carry the count live, not only
 * once settled. A failed tool still counts toward its type bucket (a failed
 * read is "读取 1 个文件" + "1 个失败").
 */
export function summarizeTrowTools(
  items: readonly ToolActivityItem[],
  options?: { live?: boolean; locale?: UiLocale },
): string {
  const copy = getToolActivityCopy(options?.locale ?? 'zh').summary;
  const order: TrowActivityKind[] = [];
  const counts = new Map<TrowActivityKind, number>();
  let failed = 0;
  let sandboxBlocked = 0;
  for (const item of items) {
    const kind = trowActivityKind(item.toolName, item.activityKind);
    if (!counts.has(kind)) order.push(kind);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
    if (isSandboxDeniedTool(item)) sandboxBlocked += 1;
    else if (isFailed(item)) failed += 1;
  }
  const clauses = order.map((kind) => copy.kind[kind](counts.get(kind) ?? 0));
  if (sandboxBlocked > 0) clauses.push(copy.sandboxBlocked(sandboxBlocked));
  if (failed > 0) clauses.push(copy.failed(failed));
  const base = copy.join(clauses);
  return options?.live ? copy.live(base) : base;
}

/** True when any tool in the group is still in flight. */
export function isTrowRunning(items: readonly ToolActivityItem[]): boolean {
  return items.some(
    (item) =>
      item.status === 'running' || item.status === 'pending' || item.status === 'waiting_permission',
  );
}

/**
 * True when the group must force itself open: a permission prompt is inside.
 * Errored tools stay collapsed; expand for detail.
 */
export function trowNeedsAttention(items: readonly ToolActivityItem[]): boolean {
  return items.some((item) => item.status === 'waiting_permission');
}
