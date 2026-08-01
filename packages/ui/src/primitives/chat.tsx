"use client";

import { cn } from "../utils.js";
import { cva, type VariantProps } from "class-variance-authority";
import type React from "react";

/**
 * `Marker` — the per-turn status / lineage / footer chrome (issue #332, PR2).
 *
 * Retires the bespoke `.maka-turn-summary*`, `.maka-turn-aborted-marker`,
 * `.maka-turn-failed-*`, `.maka-turn-lineage-*`, and `.maka-turn-footer*` shell
 * CSS (spread across `maka-tokens.css`, `styles/settings/models.css`, and the
 * re-anchored measure-column block in `styles/tool-output.css`), moving each
 * onto this one Tailwind substrate.
 *
 * Every value is a LITERAL arbitrary utility (`gap-1.5`, `rounded-[var(--radius-pill)]`,
 * `bg-[oklch(from_var(--foreground)_l_c_h_/_0.06)]`, `data-[kind=model]:…`);
 * radius values now reference `--radius-*` tokens per #406 gap 4. Each
 * leaf variant compiles 1:1 to the declarations it replaces, so the cva source
 * string IS the computed-style proof — the cascade contract asserts the exact
 * strings, no browser needed.
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
 * `cn`/tailwind-merge last, so it wins over the button's own variant utilities.
 * It is intentionally kept OFF the `@maka/ui` package barrel (see `index.ts`):
 * the only consumers import it by relative path, so the variant table stays an
 * internal, freely-removable styling detail rather than public API.
 *
 */
const markerVariants = cva("", {
  variants: {
    variant: {
      // `.maka-turn-aborted-marker` (+ its italic `em`) — dormant, muted.
      aborted:
        "inline-flex w-fit items-center gap-1 mx-0 mt-0.5 mb-1 px-1.5 py-0.5 rounded-[var(--radius-control)] bg-[var(--foreground-5)] text-[color:var(--foreground-secondary)] text-xs italic [&_em]:italic",
      // `.maka-turn-automation-origin` — quiet provenance chip above a user
      // bubble whose turn was fired by an automation, not hand-typed. Sits on
      // the user side (self-end) so it reads as the bubble's byline.
      "automation-origin":
        "inline-flex w-fit items-center gap-1 self-end mx-0 mb-1 px-1.5 py-0.5 rounded-[var(--radius-control)] bg-[var(--foreground-5)] text-[color:var(--muted-foreground)] text-xs",
      // `.maka-turn-failed-banner` — fault state, destructive tone.
      "failed-banner":
        "inline-flex w-fit flex-wrap items-center gap-1.5 mx-0 mt-0.5 mb-1.5 px-2 py-1 rounded-[var(--radius-control)] border border-[oklch(from_var(--destructive)_l_c_h_/_0.28)] bg-[oklch(from_var(--destructive)_l_c_h_/_0.10)] text-[color:var(--destructive)] text-xs",
      // `.maka-turn-failed-icon`
      "failed-icon": "inline-flex items-center",
      // `.maka-turn-failed-recovery` (+ `::before` middot separator).
      "failed-recovery":
        "text-[color:var(--text-muted)] before:content-['·'] before:mr-1.5 before:text-[color:var(--border-strong)]",
      // `.maka-turn-lineage-row` + the measure-column re-anchor (forward row).
      "lineage-row":
        "flex w-full max-w-[var(--maka-chat-measure,680px)] flex-wrap items-center justify-start gap-0.5 mt-0.5 mb-1 ml-0 mr-auto opacity-[0.82]",
      // `.maka-turn-lineage-row.maka-turn-lineage-row-reverse` — same, but the
      // `-reverse` class bumps margin-top 2px → 4px.
      "lineage-row-reverse":
        "flex w-full max-w-[var(--maka-chat-measure,680px)] flex-wrap items-center justify-start gap-0.5 mt-1 mb-1 ml-0 mr-auto opacity-[0.82]",
      // `.maka-turn-lineage-badge` (UiButton) — tiny pill, `[data-direction]`
      // recolors it forward (info) / reverse (brand-deep).
      "lineage-badge":
        "rounded-[var(--radius-pill)] [border:0] bg-[oklch(from_var(--foreground)_l_c_h_/_0.05)] text-[color:var(--muted-foreground)]"
        + " data-[direction=forward]:bg-[oklch(from_var(--info)_l_c_h_/_0.06)] data-[direction=forward]:text-[oklch(from_var(--info-text)_calc(l_-_0.06)_c_h)]"
        + " data-[direction=reverse]:bg-[oklch(from_var(--brand-deep)_l_c_h_/_0.06)] data-[direction=reverse]:text-[oklch(from_var(--brand-deep)_calc(l_-_0.04)_c_h)]",
      // `.maka-turn-footer` (+ measure-column re-anchor) — hidden by default,
      // revealed when the answer block is hovered or keyboard focus lands
      // inside it (#642). `group-hover/answer` keys off the `group/answer` on
      // the assistant `Message`; `focus-within` keeps it reachable without a
      // pointer. Opacity-only (layout stays reserved) so live→settled is
      // height-neutral. Sole consumer is the assistant turn footer.
      footer:
        "flex w-full max-w-[var(--maka-chat-measure,680px)] flex-wrap items-center justify-start gap-0.5 mt-0.5 ml-0 mr-auto p-0 opacity-0 [transition:opacity_var(--duration-quick)_var(--ease-out-strong)] group-hover/answer:opacity-100 focus-within:opacity-100",
      // `.maka-turn-footer-action` (UiButton) — borderless ghost action. Also
      // reused by the user-message copy (`MessageCopyButton`), so
      // it carries only the button look, never the footer's measure column.
      "footer-action":
        "rounded-[var(--radius-surface)] [border:0] text-[color:var(--muted-foreground)]"
        + " data-[pending=true]:opacity-[0.78] data-[pending=true]:cursor-progress"
        // Copy-in-progress sets `aria-disabled` and `data-pending` together.
        // `aria-disabled:opacity-[0.45]` and `data-[pending=true]:opacity-[0.78]`
        // have equal specificity (0,2,0), so pending would only win on source
        // order. This combined modifier raises pending to (0,3,0) so it beats
        // the disabled dim by specificity, not order — keeping the in-progress
        // 0.78 stable regardless of emit sequence.
        + " aria-disabled:data-[pending=true]:opacity-[0.78]"
        + " data-[copy-feedback=copied]:text-[color:var(--link)] data-[copy-feedback=failed]:text-[color:var(--destructive)]",
    },
  },
});

export type MarkerVariant = NonNullable<
  VariantProps<typeof markerVariants>["variant"]
>;

export { markerVariants };

export interface MarkerProps extends React.ComponentPropsWithoutRef<"div"> {
  variant: MarkerVariant;
  // The summary chips and the failed-banner sub-spans were authored as inline
  // `<span>`s; the containers/markers as `<div>`s. Keep the original tag so the
  // migration is structurally identical (zero behavioral change).
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
    return <span className={cn("inline-block", className)}>{children}</span>;
  }
  return (
    <span data-slot="text-shimmer" className={cn("relative inline-grid", className)}>
      {/* Base: opaque, muted, always readable. */}
      <span className="[grid-area:1/1] text-[color:var(--muted-foreground)]">{children}</span>
      {/* Sweep: a clipped light band that travels across the glyphs. The delay
          rides inside the `animation` shorthand (second <time> = animation-delay)
          so it can't be reset by the shorthand — the governance keyframe name is
          still `maka-text-shimmer`, the only token the scanner reads. */}
      <span
        aria-hidden="true"
        className={cn(
          "[grid-area:1/1] bg-clip-text [-webkit-text-fill-color:transparent] text-transparent",
          "bg-[linear-gradient(100deg,transparent_30%,oklch(from_var(--foreground)_l_c_h_/_0.95)_50%,transparent_70%)]",
          "[background-size:200%_100%] [background-position:150%_0]",
          delayed
            ? "[animation:maka-text-shimmer_1.8s_linear_var(--duration-emphasized)_infinite]"
            : "[animation:maka-text-shimmer_1.8s_linear_infinite]",
          "motion-reduce:[animation:none] motion-reduce:opacity-0",
        )}
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
 * (`.toolArgs`) — moving each onto this Tailwind substrate. The selectors lived
 * across `maka-tokens.css`'s `@layer components` and `styles/tool-output.css`.
 *
 * Every value is a LITERAL arbitrary utility that compiles 1:1 to the
 * declaration it replaces, so the cva source string IS the computed-style proof
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
// `waiting_permission` carries a literal underscore, which Tailwind reads as a
// SPACE in an arbitrary value (`[data-status="waiting permission"]` — never
// matches). The escape is `\_`, but a plain string literal makes the SCANNED
// source (`\\_`) disagree with cva's RUNTIME output (`\_`), so the emitted
// selector misses the class. `String.raw` keeps both at a single `\_`.
const WP_CARD_BORDER = String.raw`data-[status=waiting\_permission]:[border-color:oklch(from_var(--info)_l_c_h_/_0.4)]`;
const WP_DOT_BG = String.raw`data-[status=waiting\_permission]:bg-[var(--info)]`;

const toolVariants = cva("", {
  variants: {
    part: {
      // `.toolInline` — the inline section measure column.
      container: "w-[min(680px,100%)] mx-auto mt-0.5 mb-0 px-4 py-0",
      // `.toolInline > header` — the quiet "工具调用" caption row.
      "container-header":
        "flex items-center justify-between mb-0.5 text-[color:var(--muted-foreground)] text-xs",
      // `.maka-tool-count` — the call-count pill.
      count:
        "inline-flex items-center justify-center min-w-[22px] h-[18px] px-1.5 py-0 rounded-[var(--radius-pill)] bg-[var(--foreground-5)] text-[color:var(--foreground-secondary)] text-xs [font-variant-numeric:tabular-nums]",
      // `.maka-tool` (effective: the later `padding: 0` rule wins over `8px 12px`)
      // + `.toolItem` + the `[data-status]` border / background / opacity swaps.
      // `[border: …]` / `[border-color: …]` are arbitrary so the status overrides
      // touch only the color, never width/style.
      item:
        "[border:1px_solid_var(--border)] rounded-[var(--radius-surface)] bg-[var(--foreground-2)] p-0 mt-2 [font-family:var(--font-mono)] text-xs text-[color:var(--foreground-secondary)] overflow-hidden [box-shadow:var(--shadow-minimal-flat)]"
        // `waiting_permission` border tint — see `WP_CARD_BORDER` above (String.raw).
        + " " + WP_CARD_BORDER
        + " data-[status=running]:[border-color:oklch(from_var(--status-running)_l_c_h_/_0.4)]"
        + " data-[status=completed]:[border-color:var(--border)]"
        + " data-[status=blocked]:[border-color:oklch(from_var(--warning)_l_c_h_/_0.4)] data-[status=blocked]:bg-[oklch(from_var(--warning)_l_c_h_/_0.04)]"
        + " data-[status=errored]:[border-color:oklch(from_var(--destructive)_l_c_h_/_0.4)] data-[status=errored]:bg-[oklch(from_var(--destructive)_l_c_h_/_0.04)]"
        + " data-[status=interrupted]:[border-color:var(--border)] data-[status=interrupted]:bg-[var(--foreground-3)] data-[status=interrupted]:opacity-[0.7]",
      // The tool header's 8px · name · meta grid. Astryx owns the surrounding
      // disclosure button, focus ring, chevron, and open-state chrome.
      header:
        "list-none grid grid-cols-[8px_minmax(0,1fr)_auto] items-center gap-2.5 px-3 py-2 text-[color:var(--foreground-secondary)]",
      // `.maka-tool-status-dot` (+ the `[data-status]` color swaps; running adds
      // the box-shadow ring + `maka-tool-pulse` breath — keyframe stays in CSS).
      dot:
        "w-[8px] h-[8px] rounded-[var(--radius-pill)] bg-[var(--muted-foreground)] [flex:0_0_auto]"
        // `waiting_permission` dot tint — see `WP_DOT_BG` above (String.raw).
        + " " + WP_DOT_BG
        + " data-[status=running]:bg-[var(--status-running)] data-[status=running]:[box-shadow:0_0_0_3px_oklch(from_var(--status-running)_l_c_h_/_0.15)] data-[status=running]:[animation:maka-tool-pulse_1.5s_ease-in-out_infinite]"
        + " data-[status=completed]:bg-[var(--success)]"
        + " data-[status=blocked]:bg-[var(--warning)]"
        + " data-[status=errored]:bg-[var(--destructive)]"
        + " data-[status=interrupted]:bg-[var(--muted-foreground)]",
      // `.maka-tool-name` — the mono tool name, ellipsized.
      name:
        "min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[color:var(--foreground)] font-medium [font-family:var(--font-mono)]",
      // `.maka-tool-meta` — duration + status-label cluster.
      meta:
        "inline-flex items-center gap-2 text-[color:var(--muted-foreground)] text-xs",
      // `.maka-tool-duration`
      duration: "[font-variant-numeric:tabular-nums]",
      // `.maka-tool-status-label`
      "status-label": "text-[color:var(--foreground-secondary)]",
      // `.maka-tool-body`
      body: "px-3 pt-2.5 pb-3",
      // `.maka-tool-intent`
      intent:
        "mx-0 mt-0 mb-2 text-[color:var(--foreground-secondary)] [font-family:var(--font-default)] text-xs leading-snug",
      // `.toolArgs` — the override layered over the shared `.maka-code` base
      // (`.maka-code` stays in CSS; the call site keeps the class).
      args: "m-0 max-h-[110px] overflow-auto",
    },
  },
});

export { toolVariants };

/**
 * Tool-result preview surfaces (issue #332, PR4).
 *
 * Retires the bespoke `OverlayPreview` family shell CSS — the shared
 * height-bounded `.maka-overlay-preview` base + `.maka-overlay-close`, the
 * structured cards (`.maka-tool-diff*`, `.maka-tool-terminal*`,
 * `.maka-explore-agent-*` / `.maka-subagent-preview`,
 * `.maka-web-search-*`), and the separate `.maka-load-tool-*` result card —
 * moving each onto this one Tailwind substrate. The selectors lived across
 * `styles/tool-output.css` and `styles/tool-stream.css` (`@layer components`).
 *
 * Every value is a LITERAL arbitrary utility that compiles 1:1 to the
 * declaration it replaces, so the cva source string IS the computed-style proof
 * (the e2e-fixture renders the `file_diff` + `terminal` cards; the PR4
 * cascade contract pins the absence
 * of the retired selectors + the escape literals). Literals over the semantic
 * scale for the same reason as
 * `markerVariants` / `toolVariants`: the retired CSS hardcoded
 * these pixels, so the literal is the faithful, self-evidently-equal translation
 * and is immune to later scale/token re-tuning (the visual refresh, not this
 * governance pass, owns adopting the scale).
 *
 * Two structural notes:
 *   1. The chat structured cards carry BOTH the shared `overlay` base AND a kind
 *      part (the retired DOM had `class="maka-overlay-preview maka-tool-diff"`),
 *      applied as `cn(previewVariants({part:'overlay'}), previewVariants({part:'diff'}))`.
 *      The base's `white-space` / `font-family` are written as ARBITRARY props
 *      (`[white-space:pre-wrap]`, `[font-family:var(--font-mono)]`) so a kind part
 *      that overrides them (`[white-space:normal]`, `[font-family:var(--font-sans)]`)
 *      wins by tailwind-merge last-occurrence — reproducing the retired two-class
 *      source-order cascade without depending on stylesheet emit order.
 *   2. Leaf rules authored as descendant selectors on bare tags (e.g.
 *      `.maka-explore-agent-section li`, `.maka-web-search-preview > header strong`)
 *      are folded into their container part via `[&_tag]:` / `[&>tag]:` arbitrary
 *      variants, so the call sites swap ONLY the container className and the
 *      children stay bare — matching the original descendant cascade exactly.
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
const previewVariants = cva("", {
  variants: {
    part: {
      // ── shared base ──────────────────────────────────────────────────────
      // `.maka-overlay-preview` — the height-bounded mono container every
      // overlay preview shares. `white-space` / `font-family` are arbitrary so
      // the structured-card kind parts override them by tailwind-merge (note 1).
      overlay:
        "mt-1 mx-0 mb-0 max-h-[180px] overflow-auto [font-family:var(--font-mono)] [font-variant-ligatures:none] text-xs [white-space:pre-wrap] [word-break:break-word]",
      // Overlay placement only; Button owns the dismiss action's proportions.
      close: "justify-self-end",

      // ── file diff (shared with apps/desktop artifact-preview) ─────────────
      // `.maka-tool-diff` — the card shell. `[white-space:normal]` overrides the
      // overlay base's pre-wrap on the chat consumer.
      diff:
        "grid gap-0 p-0 rounded-[var(--radius-surface)] bg-[var(--background)] [white-space:normal] [box-shadow:var(--shadow-minimal-flat)]",
      // `.maka-tool-diff-paths` (+ its bare `code` children).
      "diff-paths":
        "flex flex-wrap gap-1.5 px-2 py-1 [border-bottom:1px_solid_var(--border)] bg-[var(--foreground-2)] [font-family:var(--font-mono)] text-xs"
        + " [&_code]:text-[color:var(--foreground-secondary)] [&_code]:bg-transparent",
      // `.maka-tool-diff-body` — the scrolling mono `<pre>`.
      "diff-body":
        "m-0 px-0 py-1 max-h-80 overflow-auto [font-family:var(--font-mono)] [font-variant-ligatures:none] text-xs leading-snug [white-space:pre] [word-break:normal]",
      // `.maka-tool-diff-line` (+ the `[data-line]` add/del/hunk/meta/ctx tints).
      "diff-line":
        "block px-2 py-0 [white-space:pre]"
        + " data-[line=add]:bg-[oklch(from_var(--success)_l_c_h_/_0.10)] data-[line=add]:text-[color:var(--success-text)]"
        + " data-[line=del]:bg-[oklch(from_var(--destructive)_l_c_h_/_0.10)] data-[line=del]:text-[color:var(--destructive)]"
        + " data-[line=hunk]:bg-[oklch(from_var(--link)_l_c_h_/_0.08)] data-[line=hunk]:text-[color:var(--foreground-secondary)] data-[line=hunk]:font-semibold"
        + " data-[line=meta]:text-[color:var(--muted-foreground)]"
        + " data-[line=ctx]:text-[color:var(--foreground-secondary)]",

      // ── terminal ──────────────────────────────────────────────────────────
      // `.maka-tool-terminal` — same card shell as diff.
      terminal:
        "grid gap-0 p-0 rounded-[var(--radius-surface)] bg-[var(--background)] [white-space:normal] [box-shadow:var(--shadow-minimal-flat)]",
      // `.maka-tool-terminal-head`
      "terminal-head":
        "flex flex-wrap items-center gap-1.5 px-2 py-1 [border-bottom:1px_solid_var(--border)] bg-[var(--foreground-2)] [font-family:var(--font-mono)] [font-variant-ligatures:none] text-xs",
      // `.maka-tool-terminal-cwd`
      "terminal-cwd": "text-[color:var(--muted-foreground)] bg-transparent",
      // `.maka-tool-terminal-cmd` — the ellipsized command line.
      "terminal-cmd":
        "[flex:1_1_auto] min-w-0 text-[color:var(--foreground)] bg-transparent font-semibold whitespace-nowrap overflow-hidden text-ellipsis",
      // `.maka-tool-terminal-exit` (+ the `[data-ok]` success/failure badge).
      "terminal-exit":
        "px-1.5 py-[1px] rounded-[var(--radius-pill)] text-xs font-bold tracking-[0.04em] bg-[var(--foreground-5)] text-[color:var(--foreground-secondary)]"
        + " data-[ok=true]:bg-[oklch(from_var(--success)_l_c_h_/_0.14)] data-[ok=true]:text-[color:var(--success)]"
        + " data-[ok=false]:bg-[oklch(from_var(--destructive)_l_c_h_/_0.14)] data-[ok=false]:text-[color:var(--destructive)]",
      // `.maka-tool-terminal-empty`
      "terminal-empty":
        "m-0 p-2 text-[color:var(--muted-foreground)] [font-family:var(--font-mono)] text-xs italic",
      // `.maka-tool-terminal-stream` (+ the `[data-stream]` stdout/stderr tone).
      "terminal-stream":
        "m-0 px-2 py-1.5 max-h-[180px] overflow-auto [font-family:var(--font-mono)] [font-variant-ligatures:none] text-xs [white-space:pre-wrap] [word-break:break-word]"
        + " data-[stream=stdout]:text-[color:var(--foreground)]"
        + " data-[stream=stderr]:[border-top:1px_solid_var(--border)] data-[stream=stderr]:bg-[oklch(from_var(--destructive)_l_c_h_/_0.04)] data-[stream=stderr]:text-[color:var(--destructive)]",
      // `.maka-tool-terminal-truncated-note` (+ its `> span` min-width reset).
      "terminal-truncated-note":
        "flex items-center justify-between gap-2 px-2 py-1.5 [border-top:1px_solid_var(--border)] bg-[oklch(from_var(--warning)_l_c_h_/_0.06)] text-[color:var(--foreground-secondary)] text-xs leading-normal [&>span]:min-w-0",
      // `.maka-tool-terminal-copy` (UiButton) + the shared copy-state tints.
      "terminal-copy":
        "[flex:0_0_auto] data-[pending=true]:cursor-progress data-[copy-error=true]:text-[color:var(--destructive)] data-[copy-error=true]:[border-color:oklch(from_var(--destructive)_l_c_h_/_0.35)]",

      // ── explore agent / subagent (shared shell) ───────────────────────────
      // `.maka-explore-agent-preview, .maka-subagent-preview` (+ the fault
      // border, keyed on explore's `[data-ok=false]` or subagent's failed /
      // cancelled `[data-status]`).
      agent:
        "grid gap-2.5 px-3 py-2.5 [border:1px_solid_var(--foreground-10)] rounded-[var(--radius-surface)] bg-[var(--foreground-3)] [font-family:var(--font-sans)] [white-space:normal]"
        + " data-[ok=false]:[border-color:oklch(from_var(--destructive)_l_c_h_/_0.22)]"
        + " data-[status=failed]:[border-color:oklch(from_var(--destructive)_l_c_h_/_0.22)]"
        + " data-[status=cancelled]:[border-color:oklch(from_var(--destructive)_l_c_h_/_0.22)]",
      // `.maka-explore-agent-head` (+ its `strong` title and `small` caption,
      // the latter shared with the nested summary-line small).
      "agent-head":
        "grid gap-0.5 pb-1.5 [border-bottom:1px_solid_var(--foreground-10)]"
        + " [&_strong]:min-w-0 [&_strong]:overflow-hidden [&_strong]:text-ellipsis [&_strong]:whitespace-nowrap [&_strong]:text-sm [&_strong]:text-[color:var(--foreground)]"
        + " [&_small]:text-xs [&_small]:text-[color:var(--muted-foreground)] [&_small]:uppercase [&_small]:tracking-[0.04em]",
      // `.maka-explore-agent-summary-line` (+ its `small` ellipsis, layered over
      // the head's caption styling above).
      "agent-summary-line":
        "flex items-center justify-between gap-2 min-w-0 [&_small]:min-w-0 [&_small]:overflow-hidden [&_small]:text-ellipsis [&_small]:whitespace-nowrap",
      // `.maka-explore-agent-actions`
      "agent-actions": "flex items-center justify-end gap-1.5 mt-1",
      // `.maka-explore-agent-message`
      "agent-message":
        "px-2.5 py-2 rounded-[var(--radius-control)] bg-[oklch(from_var(--destructive)_l_c_h_/_0.07)] text-[color:var(--destructive)] text-xs",
      // `.maka-explore-agent-meta` (+ its `div` cells, `dt` labels, `dd` values).
      "agent-meta":
        "grid grid-cols-[repeat(2,minmax(0,1fr))] gap-2 m-0"
        + " [&>div]:min-w-0 [&>div]:grid [&>div]:gap-0.5"
        + " [&_dt]:text-xs [&_dt]:text-[color:var(--muted-foreground)] [&_dt]:uppercase [&_dt]:tracking-[0.04em]"
        + " [&_dd]:min-w-0 [&_dd]:m-0 [&_dd]:overflow-hidden [&_dd]:text-ellipsis [&_dd]:whitespace-nowrap [&_dd]:text-[color:var(--foreground-secondary)] [&_dd]:text-xs",
      // `.maka-explore-agent-section` (+ its direct `> strong`, list `ul`/`li`
      // rows, leading `li` reset, `code` / `small` / `p` / `span` leaves).
      "agent-section":
        "grid gap-1.5"
        + " [&>strong]:text-xs [&>strong]:text-[color:var(--foreground)]"
        + " [&_small]:text-xs [&_small]:text-[color:var(--muted-foreground)] [&_small]:uppercase [&_small]:tracking-[0.04em]"
        + " [&_ul]:list-none [&_ul]:m-0 [&_ul]:p-0 [&_ul]:grid [&_ul]:gap-1.5"
        + " [&_li]:min-w-0 [&_li]:grid [&_li]:gap-0.5 [&_li]:py-1.5 [&_li]:[border-top:1px_solid_var(--foreground-5)]"
        + " [&_li:first-child]:border-t-0 [&_li:first-child]:pt-0"
        + " [&_code]:min-w-0 [&_code]:overflow-hidden [&_code]:text-ellipsis [&_code]:whitespace-nowrap [&_code]:text-[color:var(--foreground)] [&_code]:bg-transparent [&_code]:[font-family:var(--font-mono)] [&_code]:text-xs"
        + " [&_p]:m-0 [&_p]:text-[color:var(--foreground-secondary)] [&_p]:text-xs [&_p]:leading-snug [&_p]:[white-space:pre-wrap] [&_p]:[word-break:break-word]"
        + " [&_span]:m-0 [&_span]:text-[color:var(--foreground-secondary)] [&_span]:text-xs [&_span]:leading-snug [&_span]:[white-space:pre-wrap] [&_span]:[word-break:break-word]",
      // `.maka-explore-agent-section-head` (+ its `> strong`).
      "agent-section-head":
        "flex items-center justify-between gap-2 min-w-0 [&>strong]:min-w-0 [&>strong]:text-xs [&>strong]:text-[color:var(--foreground)]",
      // `.maka-explore-agent-copy` (UiButton) + the copied / shared copy-state tints.
      "agent-copy":
        "[flex:0_0_auto]"
        + " data-[copied=true]:text-[color:var(--link)] data-[copied=true]:[border-color:oklch(from_var(--link)_l_c_h_/_0.35)]"
        + " data-[pending=true]:cursor-progress"
        + " data-[copy-error=true]:text-[color:var(--destructive)] data-[copy-error=true]:[border-color:oklch(from_var(--destructive)_l_c_h_/_0.35)]",

      // ── web search ────────────────────────────────────────────────────────
      // `.maka-web-search-preview` (+ its bare `> header` / list leaves; the
      // container inherits the overlay base's mono font, never resetting it).
      "web-search":
        "grid gap-2 px-3 py-2.5 [border:1px_solid_var(--foreground-10)] rounded-[var(--radius-surface)] bg-[var(--foreground-3)]"
        + " [&>header]:flex [&>header]:flex-col [&>header]:gap-0.5 [&>header]:pb-1.5 [&>header]:[border-bottom:1px_solid_var(--foreground-10)]"
        + " [&>header_strong]:text-sm [&>header_strong]:text-[color:var(--foreground)] [&>header_strong]:font-semibold"
        + " [&>header_small]:text-xs [&>header_small]:text-[color:var(--muted-foreground)] [&>header_small]:uppercase [&>header_small]:tracking-[0.04em]"
        + " [&_ul]:list-none [&_ul]:m-0 [&_ul]:p-0 [&_ul]:grid [&_ul]:gap-2"
        + " [&_li]:grid [&_li]:gap-0.5 [&_li]:py-2 [&_li]:[border-top:1px_solid_var(--foreground-5)]"
        + " [&_li:first-child]:border-t-0 [&_li:first-child]:pt-0"
        + " [&_a]:font-semibold [&_a]:text-[color:var(--foreground)] [&_a]:no-underline [&_a:hover]:underline"
        + " [&_li_small]:text-xs [&_li_small]:text-[color:var(--muted-foreground)] [&_li_small]:uppercase [&_li_small]:tracking-[0.04em]"
        + " [&_li_p]:m-0 [&_li_p]:text-xs [&_li_p]:text-[color:var(--foreground-secondary)] [&_li_p]:leading-snug [&_li_p]:[white-space:pre-wrap] [&_li_p]:[word-break:break-word]",
      // `.maka-web-search-error` — the destructive container tint, layered over
      // the `web-search` part via `cn`. It MUST restate the FULL `[border: …]`
      // shorthand + `bg-[ …]` util — NOT a bare `[border-color: …]`/`[background: …]`
      // longhand. tailwind-merge only collapses utilities of the SAME property
      // form, so matching the base part's forms lets the error (last in `cn`)
      // collapse the base and win deterministically. A bare longhand survives
      // un-collapsed and then loses to the base shorthand by Tailwind's emission
      // order (the neutral border/bg is emitted later), silently dropping the
      // destructive tint. `color-mix` kept verbatim as an arbitrary value.
      "web-search-error":
        "[border:1px_solid_color-mix(in_oklab,var(--destructive-text)_32%,var(--foreground-10))] bg-[color-mix(in_oklab,var(--destructive-text)_8%,var(--foreground-3))]",
      // `.maka-web-search-error-message`
      "web-search-error-message":
        "m-0 text-xs leading-snug [white-space:pre-wrap] [word-break:break-word] text-[color:var(--destructive-text)]",
      // `.maka-web-search-error-repair`
      "web-search-error-repair":
        "m-0 text-xs leading-snug [white-space:pre-wrap] [word-break:break-word] text-[color:var(--foreground-secondary)]",

      // ── load-tool result card (separate base; not an overlay) ─────────────
      // `.maka-load-tool-preview` (+ its `p` margin reset).
      "load-tool":
        "mt-1 mx-0 mb-0 px-2 py-1 grid gap-0.5 rounded-[var(--radius-control)] bg-[var(--background)] text-xs [box-shadow:var(--shadow-minimal-flat)] [&_p]:m-0",
      // `.maka-load-tool-title`
      "load-tool-title": "font-semibold",
      // `.maka-load-tool-count`
      "load-tool-count": "text-[color:var(--muted-foreground)]",
      // `.maka-load-tool-tools`
      "load-tool-tools": "[font-family:var(--font-mono)] [word-break:break-word]",
      // `.maka-load-tool-footer`
      "load-tool-footer": "text-[color:var(--muted-foreground)] text-xs",
    },
  },
});

export { previewVariants };
