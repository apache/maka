"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cn } from "../utils.js";
import { cva, type VariantProps } from "class-variance-authority";
import type React from "react";

// Chip is the squared, compact status label for dense information rows
// (settings connection status, capability chips, default markers). It is the
// squared counterpart to the pill Badge primitive:
//   - Badge = emphasis marker (pill, radius-pill) — health/permission center
//   - Chip  = status label (squared, radius-control) — settings rows
// The status variants mirror StatusTone so settings callers pass the tone
// straight through with no mapping function; `accent` is a separate
// brand-accent marker (default-connection flags) outside the status scale.
// Visual values reproduce the retired .settingsConnectionBadge oklch alphas
// (success /12, info /14, warning /18, destructive /15) and the .settingsBadge
// neutral (foreground-5) base.
export const chipVariants = cva(
  "inline-flex items-center whitespace-nowrap rounded-[var(--radius-control)] text-xs outline-none [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    defaultVariants: {
      size: "default",
      variant: "neutral",
    },
    variants: {
      size: {
        default:
          "min-h-5 px-[var(--space-2)] py-[var(--space-0-5)] font-semibold",
        sm: "min-h-4.5 px-[var(--space-1-5)] py-0 font-normal",
      },
      variant: {
        neutral: "bg-secondary text-[var(--foreground-secondary)]",
        info: "bg-info/14 text-info-foreground",
        success: "bg-success/12 text-success",
        warning: "bg-warning/18 text-warning-foreground font-bold",
        destructive: "bg-destructive/15 text-destructive font-bold",
        // Brand-accent marker for "default connection" style flags — the
        // nav-active /14 wash carries the brand tone, not a status tone.
        // Text is foreground-secondary, NOT raw nav-active: the
        // design-system-governance-406 contract records raw --nav-active
        // text at 2.66:1 on white (fails WCAG AA 4.5:1); the readable-accent
        // precedent (permission-mode chip) keeps the tone on the background
        // and uses --foreground-secondary (~8:1 light / ~7.5:1 dark) for
        // the label.
        accent: "bg-nav-active/14 text-[var(--foreground-secondary)] font-semibold",
      },
    },
  },
);

export interface ChipProps extends useRender.ComponentProps<"span"> {
  variant?: VariantProps<typeof chipVariants>["variant"];
  size?: VariantProps<typeof chipVariants>["size"];
  // Render a leading 6px round status dot (currentColor at 70% alpha) before
  // the label — the "● 已连接" affordance from the retired .settingsBotStatusPill.
  // The dot inherits the chip's tone via currentColor, so it stays in sync
  // with the variant with no extra tone plumbing.
  dot?: boolean;
}

export function Chip({
  className,
  variant,
  size,
  dot,
  children,
  render,
  ...props
}: ChipProps): React.ReactElement {
  const defaultProps = {
    className: cn(chipVariants({ className, size, variant }), dot && "gap-[var(--space-1)]"),
    "data-slot": "chip",
    children: (
      <>
        {dot ? (
          <span
            aria-hidden="true"
            data-slot="chip-dot"
            className="size-1.5 shrink-0 rounded-full bg-current opacity-70"
          />
        ) : null}
        {children}
      </>
    ),
  };

  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(defaultProps, props),
    render,
  });
}