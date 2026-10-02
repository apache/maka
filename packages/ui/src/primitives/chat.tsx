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

"use client";

import type React from "react";
import { cn } from "../utils.js";

/**
 * `Marker` — the per-turn lineage / footer chrome (issue #332, PR2).
 *
 * Retires the bespoke `.maka-turn-summary*`, `.maka-turn-lineage-*`, and
 * `.maka-turn-footer*` shell
 * CSS (spread across `maka-tokens.css`, `styles/settings/models.css`, and the
 * re-anchored measure-column block in `styles/tool-output.css`), moving each
 * onto package-owned semantic classes.
 *
 * The measure-column geometry the old `tool-output.css` re-anchor applied to
 * the summary / lineage rows / footer is gone rather than moved: `.maka-turn`
 * is the column, and every `Marker` renders inside one, so a second cap on the
 * chrome could only ever be the same edge stated twice.
 *
 * `markerVariants` is exported from THIS module as a local variant recipe
 * so the turn footer — which renders as `ChatMessageMetadata` and can't be
 * wrapped by a `Marker` — applies the shell via `className`.
 * It is intentionally kept OFF the `@maka/ui` package barrel (see `index.ts`):
 * the only consumers import it by relative path, so the variant table stays an
 * internal, freely-removable styling detail rather than public API.
 *
 * The Buttons living inside these markers (lineage badges, footer actions)
 * carry no marker class of their own: product CSS reaches them through the
 * published `.astryx-button` theme target scoped by the row, and shape/focus
 * deltas go through the component's own derived tokens (`--_button-radius`,
 * `--focus-outline-offset`) rather than a parallel product hook (#5793 P3.1).
 */
export type MarkerVariant =
  | "host-origin"
  | "lineage-row"
  | "lineage-row-reverse"
  | "footer";

const MARKER_CLASSES: Record<MarkerVariant, string> = {
  "host-origin": "maka-turn-host-origin",
  "lineage-row": "maka-turn-lineage-row",
  "lineage-row-reverse": "maka-turn-lineage-row maka-turn-lineage-row-reverse",
  footer: "maka-turn-footer",
};

function markerVariants({ variant }: { variant: MarkerVariant }): string {
  return MARKER_CLASSES[variant];
}

export { markerVariants };

export interface MarkerProps extends React.ComponentPropsWithoutRef<"div"> {
  variant: MarkerVariant;
  // The summary chips were authored as inline `<span>`s; the containers /
  // markers as `<div>`s. Keep the original tag so the semantic-class
  // conversion is structurally identical (zero behavioral change).
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
 * Tool-result preview surfaces (issue #332, PR4) — the semantic classes
 * `DiffCodePreview` and the load-tool result card style through.
 */
const PREVIEW_PART_CLASSES = {
      // `.maka-tool-diff-body` — the scrolling mono `<pre>`.
      "diff-body":
        "maka-tool-diff-body",
      // `.maka-tool-diff-line` (+ the `[data-line]` add/del/hunk/meta/ctx tints).
      "diff-line":
        "maka-tool-diff-line",

      // `.maka-load-tool-preview` (+ its `p` margin reset).
      "load-tool":
        "maka-load-tool-preview",
      // `.maka-load-tool-title`
      "load-tool-title": "maka-load-tool-title",
      // `.maka-load-tool-count`
      "load-tool-count": "maka-load-tool-count",
} as const;

type PreviewPart = keyof typeof PREVIEW_PART_CLASSES;
const previewVariants = ({ part }: { part: PreviewPart }): string => PREVIEW_PART_CLASSES[part];

export { previewVariants };
