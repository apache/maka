//! The declarations of the style interfaces (`LayoutStyle`, `ViewStyle`,
//! `TextStyle`, `ImageStyle`) from the core's table of style properties,
//! each with the TypeScript type of what its parser takes.

use crate::style::{OBJECT_STYLE_TYPES, STYLE_TYPES, StyleGroup};

/// The value types the properties' types are written in.
const PRELUDE: &str = r#"/** A CSS-like color: `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()`,
 * `rgba()` or a named color (`black`, `white`, `transparent`, …). */
export type ColorValue = string;

/** Points, a percentage of the parent, or `"auto"`. */
export type DimensionValue = number | `${number}%` | "auto";

/** Points or a percentage of the parent. */
export type LengthValue = number | `${number}%`;

/** A length from a CSS environment variable, on padding and margin:
 * `env(safe-area-inset-top)` (`-right`, `-bottom`, `-left`: the insets of
 * the root view the element renders in), `env(keyboard-inset-height)` (the
 * software keyboard's height, 0 while hidden), with an optional fallback
 * (`env(name, 8px)`), or one of them plus a length (`calc(env(name) + 8px)`). */
export type EnvValue = `env(${string})` | `calc(${string})`;

/** One transform step; angles are degrees (`"45deg"`, `"0.5rad"` or a
 * number). Animated values (and nodes derived from them) animate a step
 * natively. */
export type TransformStep =
  | { translateX: number | AnimatedNode }
  | { translateY: number | AnimatedNode }
  | { scale: number | AnimatedNode }
  | { scaleX: number | AnimatedNode }
  | { scaleY: number | AnimatedNode }
  | { rotate: number | string | AnimatedNode }
  | { rotateZ: number | string | AnimatedNode }
  | { rotateX: number | string | AnimatedNode }
  | { rotateY: number | string | AnimatedNode }
  | { skewX: number | string }
  | { skewY: number | string }
  | { perspective: number };

/** `start` / `end` (and `self-start` / `self-end`, by the item's own
 * direction) follow the writing direction, as in CSS; `flex-start` /
 * `flex-end` follow the flex direction; `normal` is CSS's (`stretch` for
 * items without an aspect ratio). */
type Align = "flex-start" | "flex-end" | "center" | "stretch" | "baseline" | "start" | "end" | "self-start" | "self-end" | "normal";
/** `normal` is the default: `flex-start` in flex containers, while grid
 * tracks sized `auto` stretch to fill the container (CSS). */
type Distribute = "flex-start" | "flex-end" | "center" | "stretch" | "space-between" | "space-around" | "space-evenly" | "start" | "end" | "normal";
"#;

/// The interfaces, in the order they extend each other.
const INTERFACES: &[(StyleGroup, &str, &str)] = &[
    (
        StyleGroup::Layout,
        "LayoutStyle",
        "Layout (flexbox with React Native's defaults: `column`, no shrinking; CSS grid).",
    ),
    (
        StyleGroup::View,
        "ViewStyle extends LayoutStyle",
        "Styles of views (and of text, images and inputs, which are views).",
    ),
    (
        StyleGroup::Text,
        "TextStyle extends ViewStyle",
        "Styles of text (inherited by nested `<Text>` spans) and inputs.",
    ),
    (
        StyleGroup::Image,
        "ImageStyle extends ViewStyle",
        "Styles of images.",
    ),
];

/// The declarations of the style types.
pub fn declarations() -> String {
    use std::fmt::Write as _;
    let mut out = String::from(PRELUDE);
    for (group, head, doc) in INTERFACES {
        let _ = write!(out, "\n/** {doc} */\nexport interface {head} {{\n");
        for t in STYLE_TYPES.iter().chain(OBJECT_STYLE_TYPES) {
            if t.group != *group {
                continue;
            }
            if let Some(doc) = t.doc {
                let _ = writeln!(out, "  /** {doc} */");
            }
            let _ = writeln!(out, "  {}?: {};", t.name, t.ts);
        }
        out.push_str("}\n");
    }
    out
}
