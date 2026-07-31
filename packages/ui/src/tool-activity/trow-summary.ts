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
import type { FoldedTimelineChild } from '../timeline-fold.js';
import { loadToolDisplayName } from '../tool-format.js';
import { getToolActivityCopy } from './copy.js';
import { formatUserVisibleToolText } from './preview-utils.js';
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
 * A prompt is actionable content that a collapsed summary line would hide. An
 * errored tool no longer force-opens the group — the settled summary line
 * keeps the failure signal (「N 个失败」 in destructive color), and the error
 * banner + output stay one click away behind the disclosure.
 */
export function trowNeedsAttention(items: readonly ToolActivityItem[]): boolean {
  return items.some((item) => item.status === 'waiting_permission');
}

// ── Processing block (#1307) ────────────────────────────────────────────────
// A processing block folds a maximal run of reasoning + tool groups between two
// answer texts (a run folds only when it contains tool activity — see
// foldTimeline in timeline-fold.ts). Its summary reuses the trow bucket
// clauses; folded
// reasoning stays inside the block but is not counted in the summary line. The
// failed count stays visible (errored tools remain collapsed, so the summary
// line is the failure signal, matching the trow).

/** All tool items across the block's tool groups, in order. */
function processingTools(children: readonly FoldedTimelineChild[]): ToolActivityItem[] {
  return children.flatMap((child) => (child.kind === 'tools' ? child.items : []));
}

/** The first tool bucket represented by a processing block's summary and icon. */
export function processingActivityKind(
  children: readonly FoldedTimelineChild[],
): TrowActivityKind {
  const firstTool = processingTools(children)[0];
  return firstTool ? trowActivityKind(firstTool.toolName, firstTool.activityKind) : 'tool';
}

/** True while any tool is in flight or any reasoning block is still streaming. */
export function isProcessingRunning(children: readonly FoldedTimelineChild[]): boolean {
  return children.some((child) =>
    child.kind === 'thinking' ? child.live === true : isTrowRunning(child.items),
  );
}

/**
 * True when the block must force itself open: a permission prompt sits inside.
 * Mirrors `trowNeedsAttention` — an errored tool does NOT force-open; the
 * settled summary carries the failure count (「N 个失败」 in destructive color).
 */
export function processingNeedsAttention(children: readonly FoldedTimelineChild[]): boolean {
  return children.some((child) => child.kind === 'tools' && trowNeedsAttention(child.items));
}

/**
 * Summary line for a processing block. Settled: the tool-activity roll-up only
 * (per-bucket clauses + failed count, exactly the trow summary) — folded
 * reasoning is not counted. Live (`{ live: true }`): the current activity —
 * the LAST live entry in timeline order (a running tool's intent, or the
 * reasoning label when a later thinking block is still streaming), prefixed
 * with "正在" — plus the failed clause whenever the block already holds an
 * errored tool, so the failure signal is never deferred to settle.
 */
export function summarizeProcessing(
  children: readonly FoldedTimelineChild[],
  options?: { live?: boolean; locale?: UiLocale },
): string {
  const locale = options?.locale ?? 'zh';
  if (options?.live) return processingLiveSummary(children, locale);
  return summarizeTrowTools(processingTools(children), { locale });
}

/** Current-activity line for a running processing block. */
function processingLiveSummary(
  children: readonly FoldedTimelineChild[],
  locale: UiLocale,
): string {
  const copy = getToolActivityCopy(locale).summary;
  const line = copy.live(currentProcessingActivity(children, locale) ?? copy.thinkingActivity);
  const tools = processingTools(children);
  const sandboxBlocked = tools.filter(isSandboxDeniedTool).length;
  const failed = tools.filter(isFailed).length;
  const clauses = [line];
  if (sandboxBlocked > 0) clauses.push(copy.sandboxBlocked(sandboxBlocked));
  if (failed > 0) clauses.push(copy.failed(failed));
  return copy.join(clauses);
}

/**
 * The block's current activity: walk the children in reverse timeline order
 * and return the first live entry found — a still-streaming thinking block
 * (reasoning label) or a tool group's active tool (intent, falling back to the
 * localized display name via resolveToolDisplayName so connector tools read as
 * 「加载工具组」, not `load_tools`).
 */
function currentProcessingActivity(
  children: readonly FoldedTimelineChild[],
  locale: UiLocale,
): string | undefined {
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const child = children[index]!;
    if (child.kind === 'thinking') {
      if (child.live === true) return getToolActivityCopy(locale).summary.thinkingActivity;
      continue;
    }
    const activeTool = [...child.items]
      .reverse()
      .find(
        (tool) =>
          tool.status === 'running' || tool.status === 'pending' || tool.status === 'waiting_permission',
      );
    if (activeTool) {
      return formatUserVisibleToolText(activeTool.intent ?? '', locale)
        || resolveToolDisplayName(activeTool, locale);
    }
  }
  return undefined;
}
