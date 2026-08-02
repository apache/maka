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
  | "automation-origin"
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
  "automation-origin": "maka-turn-automation-origin",
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
 * `TextShimmer` — a running "sweep of light" across short label text
 * (streaming UI rework). Used for the "深度思考" disclosure title while
 * reasoning streams and for a working trow's active-tool summary.
 *
 * Two overlaid layers on the same grid cell: an opaque `base` (keeps the text
 * readable at all times, and is all a snapshot / reduced-motion user sees) and
 * a `sweep` layer whose animated linear-gradient is clipped to the glyph shape
 * (`background-clip: text` + transparent fill) so a light band travels across
 * the letters. The band motion is the one declaration that can't be a leaf
 * literal — it rides the governed `@keyframes maka-text-shimmer` in
 * maka-tokens.css plus the literal
 * utilities here.
 *
 * `active={false}` (or reduced-motion) renders just the base text — callers
 * pass `active` false for settled/snap states so the sweep never runs in a
 * deterministic capture. Kept INTERNAL (off the package barrel, imported by
 * relative path) — its only consumers live in `@maka/ui`.
 *
 * `delayed` (#646 run→done seam) holds the sweep at its resting frame for
 * `--duration-emphasized` (~200ms) before it starts — a purely CSS de-flicker so
 * a sub-second tool row (which unmounts inside the window) never visibly sweeps,
 * while the base text is readable from frame 0. The keyframe rests at
 * `background-position:150% 0` (= the sweep's declared start), so the delay reads
 * as plain static muted text, matching `active={false}`.
 */
export function TextShimmer({
  children,
  active = true,
  delayed = false,
  className,
}: {
  children: React.ReactNode;
  active?: boolean;
  delayed?: boolean;
  className?: string;
}): React.ReactElement {
  if (!active) {
    return <span className={cn("maka-text-shimmer-static", className)}>{children}</span>;
  }
  return (
    <span data-slot="text-shimmer" className={cn("maka-text-shimmer", className)}>
      {/* Base: opaque, muted, always readable. */}
      <span className="maka-text-shimmer-base">{children}</span>
      {/* Sweep: a clipped light band that travels across the glyphs. The delay
          rides inside the `animation` shorthand (second <time> = animation-delay)
          so it can't be reset by the shorthand — the governance keyframe name is
          still `maka-text-shimmer`, the only token the scanner reads. */}
      <span
        aria-hidden="true"
        className="maka-text-shimmer-sweep"
        data-delayed={delayed ? "true" : undefined}
      >
        {children}
      </span>
    </span>
  );
}

/**
 * Tool-activity card shell (issue #332, PR3b).
 *
 * Retires the bespoke `ToolActivity` chrome — the inline section + count, the
 * `<details>` card (`.maka-tool` / `.toolItem`), the `<summary>` header row
 * (`.maka-tool-header` / `-name` / `-meta` / `-duration` / `-status-label` /
 * `-status-dot`), the body / intent, and the args `<pre>` override
 * (`.toolArgs`) — moving each onto this semantic class table. The selectors lived
 * across `maka-tokens.css`'s `@layer components` and `styles/tool-output.css`.
 *
 * Every value resolves to a stable package-owned class
 * (the cascade contract asserts the exact strings, no browser needed). Literals
 * over the semantic scale for the same reason as `markerVariants`:
 * the retired CSS hardcoded these pixels, so the literal is the faithful,
 * self-evidently-equal translation and is immune to later scale/token re-tuning
 * (the visual refresh, not this governance pass, owns adopting the scale).
 *
 * The running status dot's `[animation:maka-tool-pulse …]` breath escapes the
 * computed-style proof and stays as a small named residue keyed on
 * `[data-slot="tool"]` in maka-tokens.css. The shorthand rides in the `dot`
 * part here; only the `@keyframes maka-tool-pulse` global rule stays in CSS.
 * The dot's box-shadow ring is a leaf rest-state literal, so it stays here and
 * is diff-proven.
 * (The reduced-motion / e2e-fixture suppression both ride GLOBAL `*` rules in
 * maka-tokens.css / base.css, so the dot and card need no per-element motion
 * utilities; the same global rules cover them as before.)
 *
 * The single consumer (`ToolActivity`) renders an Astryx Collapsible and applies
 * these by `className`. `toolVariants` is kept OFF the package barrel for the
 * same reason as `markerVariants`: the only consumer imports
 * it by relative path, so the part set stays an internal, freely-removable
 * styling detail.
 *
 * NOTE: the args `<pre>` keeps the shared `.maka-code` inline-code base (used by
 * Markdown / artifact previews too — out of scope); the `args` part below is only
 * the `.toolArgs` override.
 */
type ToolPart =
  | "container"
  | "container-header"
  | "count"
  | "item"
  | "header"
  | "dot"
  | "name"
  | "meta"
  | "duration"
  | "status-label"
  | "body"
  | "intent"
  | "args";

const TOOL_CLASSES: Record<ToolPart, string> = {
      // `.toolInline` — the inline section measure column.
      container: "maka-tool-container",
      // `.toolInline > header` — the quiet "工具调用" caption row.
      "container-header":
        "maka-tool-container-header",
      // `.maka-tool-count` — the call-count pill.
      count:
        "maka-tool-count",
      // `.maka-tool` (effective: the later `padding: 0` rule wins over `8px 12px`)
      // + `.toolItem` + the `[data-status]` border / background / opacity swaps.
      // `[border: …]` / `[border-color: …]` are arbitrary so the status overrides
      // touch only the color, never width/style.
      item: "maka-tool-item",
      // The tool header's 8px · name · meta grid. Astryx owns the surrounding
      // disclosure button, focus ring, chevron, and open-state chrome.
      header:
        "maka-tool-header",
      // `.maka-tool-status-dot` (+ the `[data-status]` color swaps; running adds
      // the box-shadow ring + `maka-tool-pulse` breath — keyframe stays in CSS).
      dot: "maka-tool-status-dot",
      // `.maka-tool-name` — the mono tool name, ellipsized.
      name:
        "maka-tool-name",
      // `.maka-tool-meta` — duration + status-label cluster.
      meta:
        "maka-tool-meta",
      // `.maka-tool-duration`
      duration: "maka-tool-duration",
      // `.maka-tool-status-label`
      "status-label": "maka-tool-status-label",
      // `.maka-tool-body`
      body: "maka-tool-body",
      // `.maka-tool-intent`
      intent:
        "maka-tool-intent",
      // `.toolArgs` — the override layered over the shared `.maka-code` base
      // (`.maka-code` stays in CSS; the call site keeps the class).
      args: "maka-tool-args",
};

function toolVariants({ part }: { part: ToolPart }): string {
  return TOOL_CLASSES[part];
}

export { toolVariants };

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
