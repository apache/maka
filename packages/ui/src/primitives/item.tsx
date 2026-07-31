"use client";

// Item — a media + content + actions row primitive (shadcn `Item`,
// rewritten onto Base UI `useRender` + our `cn`). Use it anywhere a
// surface lists "icon, title, description, trailing affordance" rows:
// onboarding provider tiles, settings provider/connection cards, skill
// rows, etc.
//
// Why this exists: hand-written list rows kept re-declaring the icon
// column width independently of the icon's real size (e.g. a 32px
// provider logo dropped into an 18px grid track), which clipped the
// logo and overlapped the title. `ItemMedia` is `shrink-0` with NO
// fixed width — it sizes to whatever icon it wraps — and `ItemContent`
// is `min-w-0 flex-1`, so that class of size mismatch cannot recur.

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cn } from "../utils.js";
import { cva, type VariantProps } from "class-variance-authority";
import type React from "react";

export const itemVariants = cva(
  // Clickable affordances (`hover`, `cursor`, `:active`) only light up
  // when the row is rendered as a button/anchor via `render` AND the row
  // is interactive; a plain div Item, or an `interactive={false}` row,
  // stays inert.
  // Row hover stays NEUTRAL (a faint foreground wash), not the brand
  // `accent` — in this theme `accent` maps to the brand color, and the
  // app reserves it for active/selected rows, keeping plain hover quiet.
  // hover 4% (--state-hover-bg) / pressed 8% / selected 6.5%
  // (--state-selected-bg) — the same governed foreground-alpha state
  // tiers the CSS list rows use, so a migrated row keeps its exact fills.
  "group/item relative flex w-full items-center rounded-md border border-transparent text-left text-sm outline-none transition-colors data-selected:bg-[var(--state-selected-bg)] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-64",
  {
    defaultVariants: {
      variant: "default",
      size: "default",
      interactive: true,
    },
    variants: {
      variant: {
        default: "",
        outline: "border-border",
        muted: "bg-muted/40",
      },
      size: {
        default: "gap-3 px-2 py-1.5",
        sm: "gap-2 px-2 py-1",
      },
      // `interactive` gates the hover/pressed washes. Default rows light up
      // only when rendered as a button/anchor. `interactive={false}` is for
      // inert geometry-only rows (e.g. a skills-library row whose click
      // targets live outside the row): they borrow Item's media/content/
      // actions layout without ever painting a hover fill.
      interactive: {
        true: "[a&,button&]:cursor-pointer [a&,button&]:hover:bg-foreground/4 [a&,button&]:data-pressed:bg-foreground/8",
        false: "",
      },
    },
  },
);

export interface ItemProps extends useRender.ComponentProps<"div"> {
  variant?: VariantProps<typeof itemVariants>["variant"];
  size?: VariantProps<typeof itemVariants>["size"];
  /**
   * Selected/active row — paints the 6.5% `--state-selected-bg` wash and
   * exposes `data-selected` for CSS/contract hooks. Independent of hover:
   * a selected row still lights hover when interactive.
   */
  selected?: boolean;
  /**
   * Inert geometry-only row — suppresses the hover/pressed washes even when
   * rendered as a button/anchor. Use for rows whose surface must not react
   * (skills library row, catalog gated row). Equivalent to
   * `interactive={false}`.
   */
  interactive?: VariantProps<typeof itemVariants>["interactive"];
}

export function Item({
  className,
  variant,
  size,
  selected,
  interactive,
  render,
  ...props
}: ItemProps): React.ReactElement {
  const defaultProps = {
    className: cn(itemVariants({ className, size, variant, interactive })),
    "data-slot": "item",
    ...(selected ? { "data-selected": "" } : {}),
  };
  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(defaultProps, props),
    render,
  });
}

export const itemMediaVariants = cva(
  // No fixed width on the default variant: the slot sizes to the icon
  // it wraps (a self-sized ProviderLogo, an avatar, etc.) and never
  // forces a track narrower than its content. `icon` is for raw lucide
  // glyphs that need a framed, fixed box.
  "flex shrink-0 items-center justify-center",
  {
    defaultVariants: { variant: "default" },
    variants: {
      variant: {
        default: "",
        icon: "size-8 rounded-md border bg-muted/40 [&_svg:not([class*='size-'])]:size-4",
      },
    },
  },
);

// Sub-slots default to `span`, not `div`/`p`: an Item is routinely rendered
// as a `<button>` (provider rows, OAuth cards, connection rows), and a button
// may only contain phrasing content. A `<div>`/`<p>` child is invalid there
// and trips React DOM-nesting checks. A `span` with the same flex/line-clamp
// classes lays out identically and is valid inside both a button and a div, so
// call sites never have to remember `render={<span />}`.
export interface ItemMediaProps extends useRender.ComponentProps<"span"> {
  variant?: VariantProps<typeof itemMediaVariants>["variant"];
}

export function ItemMedia({
  className,
  variant,
  render,
  ...props
}: ItemMediaProps): React.ReactElement {
  const defaultProps = {
    className: cn(itemMediaVariants({ className, variant })),
    "data-slot": "item-media",
  };
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(defaultProps, props),
    render,
  });
}

export function ItemContent({
  className,
  render,
  ...props
}: useRender.ComponentProps<"span">): React.ReactElement {
  const defaultProps = {
    className: cn("flex min-w-0 flex-1 flex-col gap-0.5", className),
    "data-slot": "item-content",
  };
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(defaultProps, props),
    render,
  });
}

export function ItemTitle({
  className,
  render,
  ...props
}: useRender.ComponentProps<"span">): React.ReactElement {
  const defaultProps = {
    className: cn(
      "flex w-full items-center gap-2 text-sm font-medium leading-snug",
      className,
    ),
    "data-slot": "item-title",
  };
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(defaultProps, props),
    render,
  });
}

export function ItemDescription({
  className,
  render,
  ...props
}: useRender.ComponentProps<"span">): React.ReactElement {
  const defaultProps = {
    className: cn(
      "line-clamp-2 text-xs leading-snug text-foreground-secondary",
      className,
    ),
    "data-slot": "item-description",
  };
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(defaultProps, props),
    render,
  });
}

export function ItemActions({
  className,
  render,
  ...props
}: useRender.ComponentProps<"span">): React.ReactElement {
  const defaultProps = {
    className: cn("flex shrink-0 items-center gap-1 text-foreground-secondary", className),
    "data-slot": "item-actions",
  };
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(defaultProps, props),
    render,
  });
}
