"use client";

import type React from "react";
import { cn } from "../utils.js";

/**
 * `Marker` — the per-turn status / lineage / footer chrome (issue #332, PR2).
 *
 * Retires the bespoke `.maka-turn-summary*`, `.maka-turn-aborted-marker`,
 * `.maka-turn-failed-*`, `.maka-turn-lineage-*`, and `.maka-turn-footer*` shell
 * CSS (spread across `maka-tokens.css`, `styles/settings/models.css`, and the
 * re-anchored measure-column block in `styles/tool-output.css`), moving each
 * onto package-owned semantic classes.
 *
 * The measure-column geometry the old `tool-output.css` re-anchor applied to
 * the summary / lineage rows / footer (`max-width:var(--maka-chat-measure)`,
 * `margin-right:auto`) is folded directly into those container variants here,
 * so the layout is location-independent instead of coupled to a
 * `[data-role="assistant"]` descendant selector.
 *
 * `markerVariants` is exported from THIS module as a local variant recipe
 * so the lineage badge + footer action — which render as `UiButton` and can't
 * be wrapped — apply the shell via `className`; `Button` runs it through
 * `cn` last so consumers can append their own product hook.
 * It is intentionally kept OFF the `@maka/ui` package barrel (see `index.ts`):
 * the only consumers import it by relative path, so the variant table stays an
 * internal, freely-removable styling detail rather than public API.
 *
 */
export type MarkerVariant =
  | "aborted"
  | "host-origin"
  | "failed-banner"
  | "failed-icon"
  | "failed-recovery"
  | "lineage-row"
  | "lineage-row-reverse"
  | "lineage-badge"
  | "footer"
  | "footer-action";

const MARKER_CLASSES: Record<MarkerVariant, string> = {
  aborted: "maka-turn-aborted-marker",
  "host-origin": "maka-turn-host-origin",
  "failed-banner": "maka-turn-failed-banner",
  "failed-icon": "maka-turn-failed-icon",
  "failed-recovery": "maka-turn-failed-recovery",
  "lineage-row": "maka-turn-lineage-row",
  "lineage-row-reverse": "maka-turn-lineage-row maka-turn-lineage-row-reverse",
  "lineage-badge": "maka-turn-lineage-badge",
  footer: "maka-turn-footer",
  "footer-action": "maka-turn-footer-action",
};

function markerVariants({ variant }: { variant: MarkerVariant }): string {
  return MARKER_CLASSES[variant];
}

export { markerVariants };

export interface MarkerProps extends React.ComponentPropsWithoutRef<"div"> {
  variant: MarkerVariant;
  // The summary chips and the failed-banner sub-spans were authored as inline
  // `<span>`s; the containers/markers as `<div>`s. Keep the original tag so the
  // semantic-class conversion is structurally identical (zero behavioral change).
  as?: "div" | "span";
}

export function Marker({
  className,
  variant,
  as: Tag = "div",
  ...props
}: MarkerProps): React.ReactElement {
  return (
    // `{...props}` first so the `data-slot` / `data-variant` hooks land last and
    // can't be clobbered by a consumer (mirrors Message / Bubble). The styling
    // `data-kind` / `data-state` / `data-direction` etc. flow through `...props`
    // and are read by the literalized `data-[…]:` variants above.
    <Tag
      {...props}
      data-slot="marker"
      data-variant={variant}
      className={cn(markerVariants({ variant }), className)}
    />
  );
}

/**
 * Tool-result preview surfaces (issue #332, PR4).
 *
 * Retires the bespoke `OverlayPreview` family shell CSS — the shared
 * height-bounded `.maka-overlay-preview` base + `.maka-overlay-close`, the
 * structured cards (`.maka-tool-diff*`, `.maka-tool-terminal*`,
 * `.maka-explore-agent-*` / `.maka-subagent-preview`,
 * `.maka-web-search-*`), and the separate `.maka-load-tool-*` result card —
 * represented by package-owned semantic classes in `styles.css`.
 *
 * Two structural notes:
 *   1. The chat structured cards carry BOTH the shared `overlay` base AND a kind
 *      part (the retired DOM had `class="maka-overlay-preview maka-tool-diff"`),
 *      applied as `cn(previewVariants({part:'overlay'}), previewVariants({part:'diff'}))`.
 *      The kind class follows the shared base and may refine it by normal CSS
 *      source order.
 *   2. Leaf rules authored as descendant selectors on bare tags (e.g.
 *      `.maka-explore-agent-section li`, `.maka-web-search-preview > header strong`)
 *      remain descendants of the stable semantic container class.
 *
 * Unlike the other tables, `previewVariants` IS exported on the `@maka/ui` barrel
 * (`index.ts`): the file-diff `diff` / `diff-body` / `diff-line` parts have a
 * SECOND, cross-package consumer — `apps/desktop`'s `artifact-preview.tsx`, whose
 * non-chat diff pane shared the retired `.maka-tool-diff*` shell and co-migrates
 * here. That second consumer is exactly the condition the off-barrel convention
 * named for promotion, so the export is the rule, not an exception.
 *
 * Preview card shells use the shared shadow-ring recipe instead of hard visual
 * borders. Dividers inside the cards remain real borders because they separate
 * rows and headers.
 */
const PREVIEW_PART_CLASSES = {
      // ── shared base ──────────────────────────────────────────────────────
      // `.maka-overlay-preview` — the height-bounded mono container every
      // overlay preview shares.
      overlay:
        "maka-overlay-preview",
      // Overlay placement only; Button owns the dismiss action's proportions.
      close: "maka-overlay-close",

      // ── file diff (shared with apps/desktop artifact-preview) ─────────────
      // `.maka-tool-diff` — the card shell. `[white-space:normal]` overrides the
      // overlay base's pre-wrap on the chat consumer.
      diff:
        "maka-tool-diff",
      // `.maka-tool-diff-paths` (+ its bare `code` children).
      "diff-paths":
        "maka-tool-diff-paths",
      // `.maka-tool-diff-body` — the scrolling mono `<pre>`.
      "diff-body":
        "maka-tool-diff-body",
      // `.maka-tool-diff-line` (+ the `[data-line]` add/del/hunk/meta/ctx tints).
      "diff-line":
        "maka-tool-diff-line",

      // ── terminal ──────────────────────────────────────────────────────────
      // `.maka-tool-terminal` — same card shell as diff.
      terminal:
        "maka-tool-terminal",
      // `.maka-tool-terminal-head`
      "terminal-head":
        "maka-tool-terminal-head",
      // `.maka-tool-terminal-cwd`
      "terminal-cwd": "maka-tool-terminal-cwd",
      // `.maka-tool-terminal-cmd` — the ellipsized command line.
      "terminal-cmd":
        "maka-tool-terminal-cmd",
      // `.maka-tool-terminal-exit` (+ the `[data-ok]` success/failure badge).
      "terminal-exit":
        "maka-tool-terminal-exit",
      // `.maka-tool-terminal-empty`
      "terminal-empty":
        "maka-tool-terminal-empty",
      // `.maka-tool-terminal-stream` (+ the `[data-stream]` stdout/stderr tone).
      "terminal-stream":
        "maka-tool-terminal-stream",
      // `.maka-tool-terminal-truncated-note` (+ its `> span` min-width reset).
      "terminal-truncated-note":
        "maka-tool-terminal-truncated-note",
      // `.maka-tool-terminal-copy` (UiButton) + the shared copy-state tints.
      "terminal-copy":
        "maka-tool-terminal-copy",

      // ── explore agent / subagent (shared shell) ───────────────────────────
      // `.maka-explore-agent-preview, .maka-subagent-preview` (+ the fault
      // border, keyed on explore's `[data-ok=false]` or subagent's failed /
      // cancelled `[data-status]`).
      agent:
        "maka-agent-preview",
      // `.maka-explore-agent-head` (+ its `strong` title and `small` caption,
      // the latter shared with the nested summary-line small).
      "agent-head":
        "maka-agent-preview-head",
      // `.maka-explore-agent-summary-line` (+ its `small` ellipsis, layered over
      // the head's caption styling above).
      "agent-summary-line":
        "maka-agent-preview-summary-line",
      // `.maka-explore-agent-actions`
      "agent-actions": "maka-agent-preview-actions",
      // `.maka-explore-agent-message`
      "agent-message":
        "maka-agent-preview-message",
      // `.maka-explore-agent-meta` (+ its `div` cells, `dt` labels, `dd` values).
      "agent-meta":
        "maka-agent-preview-meta",
      // `.maka-explore-agent-section` (+ its direct `> strong`, list `ul`/`li`
      // rows, leading `li` reset, `code` / `small` / `p` / `span` leaves).
      "agent-section":
        "maka-agent-preview-section",
      // `.maka-explore-agent-section-head` (+ its `> strong`).
      "agent-section-head":
        "maka-agent-preview-section-head",
      // `.maka-explore-agent-copy` (UiButton) + the copied / shared copy-state tints.
      "agent-copy":
        "maka-agent-preview-copy",

      // ── web search ────────────────────────────────────────────────────────
      // `.maka-web-search-preview` (+ its bare `> header` / list leaves; the
      // container inherits the overlay base's mono font, never resetting it).
      "web-search":
        "maka-web-search-preview",
      // `.maka-web-search-error` — the destructive container tint.
      "web-search-error":
        "maka-web-search-error",
      // `.maka-web-search-error-message`
      "web-search-error-message":
        "maka-web-search-error-message",
      // `.maka-web-search-error-repair`
      "web-search-error-repair":
        "maka-web-search-error-repair",

      // ── load-tool result card (separate base; not an overlay) ─────────────
      // `.maka-load-tool-preview` (+ its `p` margin reset).
      "load-tool":
        "maka-load-tool-preview",
      // `.maka-load-tool-title`
      "load-tool-title": "maka-load-tool-title",
      // `.maka-load-tool-count`
      "load-tool-count": "maka-load-tool-count",
      // `.maka-load-tool-tools`
      "load-tool-tools": "maka-load-tool-tools",
      // `.maka-load-tool-footer`
      "load-tool-footer": "maka-load-tool-footer",
} as const;

type PreviewPart = keyof typeof PREVIEW_PART_CLASSES;
const previewVariants = ({ part }: { part: PreviewPart }): string => PREVIEW_PART_CLASSES[part];

export { previewVariants };
