/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import type { MalformedHistoryCompactSummaryReason } from './history-compact-error.js';

// The single authority on what a history-compact checkpoint summary must look
// like (#3029). The summarization prompt is built from the same constants and
// the load side can consume the same predicate, so the mandated format and
// every validation site share one contract that cannot drift.

/**
 * Durable identity of the sectioned summary contract. Stamped on newly built
 * text checkpoints so record, load/repair, and copy can hold them to the
 * complete predicate, while unmarked legacy V2 free-form summaries stay
 * loadable under the truncation-only compatibility policy.
 */
export const SECTIONED_SUMMARY_FORMAT = 'sections_v1' as const;
export type SectionedSummaryFormat = typeof SECTIONED_SUMMARY_FORMAT;

export type CheckpointSummaryDefect = MalformedHistoryCompactSummaryReason;

// The exact format the prompt mandates. REQUIRED_SUMMARY_SECTIONS is the
// ordered subsequence of its headings a completion must carry to be allowed
// to REPLACE folded history; Critical Context is required because it is
// exactly what the #3029 incident lost (files, commands, errors), and the
// template gives it an explicit "(none)" escape hatch.
export const SUMMARY_FORMAT_TEMPLATE = [
  '## Goal',
  '[What the user is trying to accomplish]',
  '',
  '## Progress',
  '### Done',
  '- [Completed work and changes]',
  '### In Progress',
  '- [Current work]',
  '',
  '## Key Decisions',
  '- **[Decision]**: [Brief rationale]',
  '',
  '## Next Steps',
  '1. [Ordered list of what should happen next]',
  '',
  '## Critical Context',
  '- [Files, commands/results, errors, anything needed to continue; or "(none)"]',
] as const;

export const REQUIRED_SUMMARY_SECTIONS = [
  '## Goal',
  '## Progress',
  '## Next Steps',
  '## Critical Context',
] as const;

// A verbatim echo of the mandated template carries no information: template
// lines never count as section content, fenced or not, so a degraded model
// parroting the format back cannot pass as a checkpoint.
const TEMPLATE_PLACEHOLDER_LINES: ReadonlySet<string> = new Set(
  SUMMARY_FORMAT_TEMPLATE.map((line) => line.trim()).filter((line) => line.length > 0),
);

// Floors for the incident's shape: folding a large span into a paragraph
// cannot be a faithful checkpoint. Folds whose summarizer request the provider
// counted above ~10k input tokens require at least ~200 output tokens of
// summary. Both sides are the summarizer call's REAL usage, so the floor holds
// in the provider's own tokenizer and needs no chars-per-token guess (#4559);
// a producer that reports no usage is not floored.
const LARGE_FOLD_INPUT_TOKENS = 10_000;
const LARGE_FOLD_SUMMARY_TOKENS_FLOOR = 200;

// Best-effort signals that a provider stopped mid-thought. Fence state is
// derived by the structural scanner below, so write admission and legacy-load
// quarantine cannot disagree about Markdown fence semantics. A trailing
// backtick is deliberately absent: it can be the end of a complete fence.
const TRUNCATED_TAIL_PATTERN = /(?:\.{3}|[:：,，、;；…(（—])\s*$/u;

export interface CheckpointSummaryFoldContext {
  /**
   * The summarizer call's real usage for an INITIAL fold, as its provider
   * counted it: input is the covered span, output is the summary. Absent when
   * the producer reports none or the fold rolls a previous checkpoint
   * forward (its input is then the increment, not the span); the size floor
   * is not applied in either case.
   */
  summarizerUsage?: { inputTokens: number; outputTokens: number };
}

// #3029: a degraded provider completion — a 138-token free-form fragment
// ending mid-sentence, delivered with a stop finish reason — was accepted as
// the checkpoint for ~235k estimated tokens of history, and the continuation
// confabulated around the missing context. Anything that does not look like
// the checkpoint the prompt mandates is a defect the caller fails open on
// (history kept, compaction retried). Returns undefined for an EMPTY summary:
// the compaction layer's empty_summary gate owns that case.
export function findCheckpointSummaryDefect(
  summary: string,
  foldContext?: CheckpointSummaryFoldContext,
): CheckpointSummaryDefect | undefined {
  const trimmed = summary.trim();
  if (trimmed.length === 0) return undefined;
  const scan = scanSummaryStructure(trimmed);
  if (!scan.orderedSectionsPresent) {
    return 'malformed_summary_missing_section';
  }
  const truncationDefect = findTruncationDefect(trimmed, scan);
  if (truncationDefect !== undefined) return truncationDefect;
  const usage = foldContext?.summarizerUsage;
  if (
    usage !== undefined &&
    usage.outputTokens < LARGE_FOLD_SUMMARY_TOKENS_FLOOR &&
    usage.inputTokens > LARGE_FOLD_INPUT_TOKENS
  ) {
    return 'malformed_summary_too_small_for_fold';
  }
  return undefined;
}

// Legacy checkpoints predate the section contract, so load recovery may only
// quarantine writer-agnostic truncation. It still uses the exact same scan and
// tail predicate as strict write admission above.
export function findCheckpointSummaryTruncationDefect(
  summary: string,
): Extract<CheckpointSummaryDefect, 'malformed_summary_truncated'> | undefined {
  const trimmed = summary.trim();
  if (trimmed.length === 0) return undefined;
  return findTruncationDefect(trimmed, scanSummaryStructure(trimmed));
}

function findTruncationDefect(
  text: string,
  scan: SummaryStructureScan,
): Extract<CheckpointSummaryDefect, 'malformed_summary_truncated'> | undefined {
  return scan.endsInsideOpenFence || TRUNCATED_TAIL_PATTERN.test(text)
    ? 'malformed_summary_truncated'
    : undefined;
}

// One line scan holding a single interpretation of the document for both
// checks: the mandated sections must appear in order, each with non-empty
// content. Section HEADINGS are recognized only OUTSIDE fenced code blocks —
// a degraded model quoting the template inside a fence must not count as
// structure — while fenced lines are literal content of their enclosing
// section (preserved commands and errors are exactly what a checkpoint must
// carry; only template placeholders and bare marker runs are excluded).
// Fences follow the
// Markdown closing rule: same character family AND a run at least as long as
// the opener (a shorter run stays fenced content), tracked line-opening only
// so a verbatim ``` inside a preserved error message stays content. The scan
// also reports whether the document ends inside an open fence.
interface SummaryStructureScan {
  orderedSectionsPresent: boolean;
  endsInsideOpenFence: boolean;
}

function scanSummaryStructure(text: string): SummaryStructureScan {
  let openFence: { family: string; width: number } | undefined;
  let matchedSections = 0;
  // Content attribution target: content lines satisfy the most recently
  // matched REQUIRED section, but an intervening unmatched H2 (e.g. the
  // template's "## Key Decisions") opens its own section — its content must
  // not satisfy the previous required section's non-empty requirement.
  let attributesToRequiredSection = false;
  const sectionHasContent: boolean[] = REQUIRED_SUMMARY_SECTIONS.map(() => false);
  const countContent = (line: string) => {
    if (matchedSections === 0 || !attributesToRequiredSection) return;
    const trimmedLine = line.trim();
    if (trimmedLine.length === 0) return;
    if (TEMPLATE_PLACEHOLDER_LINES.has(trimmedLine)) return;
    // A bare fence-marker run carries no checkpoint information, so nested
    // fence delimiters cannot satisfy a section's non-empty requirement.
    if (/^(`{3,}|~{3,})$/.test(trimmedLine)) return;
    sectionHasContent[matchedSections - 1] = true;
  };
  // Normalized so CRLF input cannot smuggle a trailing \r past any line check.
  for (const line of text.split(/\r?\n/)) {
    // Markdown allows a fence delimiter at most three leading spaces of
    // indentation; four or more is indented code, never a delimiter — so an
    // indented marker run cannot falsely close (or open) a fence.
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      const family = fence[1]![0]!;
      const width = fence[1]!.length;
      if (openFence === undefined) {
        openFence = { family, width };
      } else if (
        openFence.family === family &&
        width >= openFence.width &&
        line.trim() === fence[1]
      ) {
        // A closer must be a bare run of the same family, at least as long
        // as the opener (an opener may carry an info string; a closer may
        // not).
        openFence = undefined;
      } else {
        // Anything else — a shorter run, a different family, or trailing
        // text — is fenced content of the enclosing section.
        countContent(line);
      }
      continue;
    }
    if (openFence !== undefined) {
      // Fenced lines are content of the enclosing section, never headings.
      countContent(line);
      continue;
    }
    // CommonMark ATX headings tolerate up to three leading spaces; four or
    // more is indented code (which the template-placeholder and bare-marker
    // exclusions still keep information-free).
    if (
      matchedSections < REQUIRED_SUMMARY_SECTIONS.length &&
      /^ {0,3}#/.test(line) &&
      line.trim() === REQUIRED_SUMMARY_SECTIONS[matchedSections]
    ) {
      matchedSections += 1;
      attributesToRequiredSection = true;
      continue;
    }
    // Any other H2 (the marker run may also end the line) opens its own
    // (non-required) section; deeper headings organize within the current
    // one.
    if (/^ {0,3}##(?!#)(?:\s|$)/.test(line)) {
      attributesToRequiredSection = false;
      continue;
    }
    // Anything non-blank that is not itself an ATX heading of any level —
    // including bare marker runs and headings indented up to three spaces —
    // a thematic break, or a verbatim template line counts as content for
    // the most recently matched section (subheadings organize, lists carry,
    // horizontal rules separate).
    if (!/^ {0,3}#{1,6}(?:\s|$)/.test(line) && !/^\s*([-*_])\s*(?:\1\s*){2,}$/.test(line)) {
      countContent(line);
    }
  }
  return {
    orderedSectionsPresent:
      matchedSections === REQUIRED_SUMMARY_SECTIONS.length && sectionHasContent.every(Boolean),
    endsInsideOpenFence: openFence !== undefined,
  };
}
