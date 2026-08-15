/**
 * Structural contract for history-compact checkpoint summaries.
 *
 * A checkpoint summary is the only survivor of a history fold: once written,
 * the covered RuntimeEvents are replaced by this text alone. The summarizer
 * prompt (history-compact-summarizer.ts) declares a sectioned contract, but a
 * degraded provider can return anything non-empty — a single word, raw tool
 * markup, or a fragment ending mid-sentence — and before this gate existed the
 * pipeline persisted all of it (see #3029). Both checkpoint write paths call
 * `validateHistoryCompactSummary` and fail open on a rejection, so a bad
 * summary never replaces folded history.
 *
 * The section names are the single source of truth: the summarizer prompt is
 * built from them, and validation reuses the same constants.
 */

/** Every section the summarization prompt asks for, in order. */
export const HISTORY_COMPACT_SUMMARY_SECTIONS = [
  '## Goal',
  '## Progress',
  '## Key Decisions',
  '## Next Steps',
  '## Critical Context',
] as const;

/**
 * Sections without which a continuation cannot recover the task: what is being
 * done, how far it got, and what happens next. `## Key Decisions` and
 * `## Critical Context` are valuable but not load-bearing, so a summary that
 * omits them is thin rather than malformed.
 */
export const HISTORY_COMPACT_REQUIRED_SECTIONS = [
  '## Goal',
  '## Progress',
  '## Next Steps',
] as const satisfies readonly (typeof HISTORY_COMPACT_SUMMARY_SECTIONS)[number][];

/**
 * Line-anchored heading matchers: a required section must appear as its own
 * heading line. A substring match would also accept `## Goals` or a prose
 * mention of `## Goal`, neither of which follows the summarizer contract.
 */
const REQUIRED_SECTION_HEADING_PATTERNS = HISTORY_COMPACT_REQUIRED_SECTIONS.map(
  (section) => new RegExp(`^${escapeRegExp(section)}\\b`, 'm'),
);

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Terminal punctuation that indicates the output was cut off mid-thought.
 * Best-effort by construction: a fragment ending mid-word (no punctuation) is
 * undetectable, and code fences are handled separately by the fence count in
 * `isHistoryCompactSummaryTruncated`. A trailing backtick is deliberately NOT
 * here — it would also match a closed ``` fence, which is completion, not
 * truncation.
 */
const TRUNCATED_TAIL_PATTERN = /[:：,，、;；…(（—]\s*$/u;

/** Why a summary failed validation, for diagnostics and tests. */
export type HistoryCompactSummaryRejection = 'missing_sections' | 'truncated';

/**
 * Writer-agnostic truncation detection: an odd number of code fences means the
 * output stops inside a code block, and terminal dangling punctuation means it
 * stops mid-thought. A complete summary that ends with a closed ``` fence is
 * NOT truncated (the even fence count already proves the block closed), so the
 * tail punctuation deliberately excludes a trailing backtick. Legacy
 * checkpoints (written before the sectioned summarizer prompt) never followed
 * the section contract, but a truncated fragment is unusable regardless of
 * writer era, so the load path applies this check to every checkpoint summary
 * (#3041).
 */
export function isHistoryCompactSummaryTruncated(summary: string): boolean {
  // An odd number of fences means the output stops inside a code block.
  const fenceCount = (summary.match(/^```/gm) ?? []).length;
  if (fenceCount % 2 === 1) return true;
  return TRUNCATED_TAIL_PATTERN.test(summary);
}

/**
 * Returns why the summary is malformed, or undefined when it satisfies the
 * contract. Callers map any rejection to `malformed_summary` and fail open.
 */
export function validateHistoryCompactSummary(
  summary: string,
): HistoryCompactSummaryRejection | undefined {
  if (REQUIRED_SECTION_HEADING_PATTERNS.some((pattern) => !pattern.test(summary))) {
    return 'missing_sections';
  }
  if (isHistoryCompactSummaryTruncated(summary)) return 'truncated';
  return undefined;
}
