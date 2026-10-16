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

//! `TextView.text_style({...})` — the parts of Base's `TextViewStyle` a
//! script may set.
//!
//! # How the object crosses
//!
//! A bridged argument is a primitive, so the prelude walks the object and
//! sends one `"path", value` pair per leaf: `{ headings: { 1: { text_size:
//! 18 } } }` arrives as `"headings.1.text_size", 18`. An empty object sends
//! its path with a trailing dot, `"code_block.", true`, so its key is checked
//! too; the prelude refuses a key that is empty or holds a dot, so no leaf
//! can be mistaken for one. The keys are checked here, once, when the call is
//! recorded; materialize applies the same pairs again to the style the theme
//! gives the view.
//!
//! # What a key means
//!
//! The top-level keys are `TextViewStyle`'s own fields. The nested objects —
//! a heading level, `code_block`, `table_head`, `table_cell` — are style
//! refinements, and their keys are the names of the style methods that set
//! the same thing on an element, with the same arguments: `text_size: 18` is
//! 18px, `line_height: 1.4` is a multiple of the text size, `px: 12` is the
//! padding on the left and right. Each nested object accepts only the methods
//! that do something on the part it styles.
//!
//! A key that is left out keeps the theme's value; a key that is given
//! replaces it. Each `text_style` call folds onto the ones before it.

use gpui::{AbsoluteLength, Hsla, Pixels, Refineable as _, SharedString, StyleRefinement};
use gpui_base::TextViewStyle;

use crate::{materialize::Behavior, spec::Component, style, value::Bridged};

/// The style methods a heading level accepts.
const HEADING_KEYS: &[&str] = &["text_size", "line_height", "font_weight", "text_color"];
/// The style methods `code_block` accepts.
const CODE_BLOCK_KEYS: &[&str] = &[
    "bg",
    "border_color",
    "rounded",
    "px",
    "py",
    "text_size",
    "line_height",
];
/// The style methods `table_head` accepts. No padding: the refinement styles
/// the header row as a whole, and padding there is not part of the column
/// measurement. Header cells take their padding from `table_cell`.
const TABLE_HEAD_KEYS: &[&str] = &[
    "bg",
    "text_color",
    "text_size",
    "line_height",
    "font_weight",
];
/// The style methods `table_cell` accepts.
const TABLE_CELL_KEYS: &[&str] = &[
    "bg",
    "text_color",
    "text_size",
    "line_height",
    "font_weight",
    "px",
    "py",
];
/// Every top-level key, in the order the declarations list them.
const TOP_LEVEL_KEYS: &[&str] = &[
    "headings",
    "paragraph_gap",
    "foreground",
    "muted_foreground",
    "link",
    "selection",
    "border",
    "code_background",
    "inline_code_background",
    "code_font_family",
    "code_font_size",
    "code_block",
    "table_head",
    "table_cell",
];

/// What a script's `text_style(...)` calls set, before it is folded onto a
/// theme-derived [`TextViewStyle`].
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct ScriptTextStyle {
    heading_default: StyleRefinement,
    headings: [StyleRefinement; 6],
    paragraph_gap: Option<AbsoluteLength>,
    foreground: Option<Hsla>,
    muted_foreground: Option<Hsla>,
    link: Option<Hsla>,
    selection: Option<Hsla>,
    border: Option<Hsla>,
    code_background: Option<Hsla>,
    inline_code_background: Option<Hsla>,
    code_font_family: Option<SharedString>,
    code_font_size: Option<AbsoluteLength>,
    code_block: StyleRefinement,
    table_head: StyleRefinement,
    table_cell: StyleRefinement,
}

impl ScriptTextStyle {
    /// Every key `text_style` takes, by the object it sits in, under the name
    /// the declarations give that object. The typings tests check the
    /// declarations against it.
    #[cfg(test)]
    pub(crate) const ACCEPTED_KEYS: &[(&str, &[&str])] = &[
        ("TextViewTextStyle", TOP_LEVEL_KEYS),
        ("TextViewHeadingStyle", HEADING_KEYS),
        ("TextViewCodeBlockStyle", CODE_BLOCK_KEYS),
        ("TextViewTableHeadStyle", TABLE_HEAD_KEYS),
        ("TextViewTableCellStyle", TABLE_CELL_KEYS),
    ];

    /// Applies one call's `path, value` pairs, in order.
    ///
    /// The error names the key and what it takes, without the method name;
    /// the caller adds that.
    pub(crate) fn apply(&mut self, pairs: &[Bridged]) -> Result<(), String> {
        if pairs.len() % 2 != 0 {
            return Err("the style arrived as an odd number of key/value arguments".into());
        }
        for pair in pairs.chunks_exact(2) {
            let Bridged::Str(path) = &pair[0] else {
                return Err(format!("a key arrived as {:?}, not a string", pair[0]));
            };
            // A path ending in a dot is an object the script gave with nothing
            // in it. It sets nothing, but its key is still checked, so that
            // `{ colour: {} }` is refused as `{ colour: "#fff" }` would be.
            match path.strip_suffix('.') {
                Some(object) => self.set(object, None)?,
                None => self.set(path, Some(&pair[1]))?,
            }
        }
        Ok(())
    }

    /// Sets the value at `path`; `None` is an empty object there.
    fn set(&mut self, path: &str, value: Option<&Bridged>) -> Result<(), String> {
        if matches!(value, Some(Bridged::Nil)) {
            return Err(format!(
                "`{path}` is null; leave the key out to keep the theme's value"
            ));
        }
        let (key, rest) = split(path);
        match key {
            "headings" => {
                let Some(rest) = rest else {
                    return match value {
                        None => Ok(()),
                        Some(_) => Err(
                            "`headings` takes an object keyed by level: default, or 1 to 6".into(),
                        ),
                    };
                };
                let (level, field) = split(rest);
                let target = match level {
                    "default" => &mut self.heading_default,
                    "1" => &mut self.headings[0],
                    "2" => &mut self.headings[1],
                    "3" => &mut self.headings[2],
                    "4" => &mut self.headings[3],
                    "5" => &mut self.headings[4],
                    "6" => &mut self.headings[5],
                    _ => {
                        return Err(format!(
                            "unknown key `headings.{level}`; headings takes default and the \
                             levels 1 to 6"
                        ));
                    }
                };
                let group = format!("headings.{level}");
                refine(target, &group, field, path, value, HEADING_KEYS)
            }
            "code_block" => refine(
                &mut self.code_block,
                key,
                rest,
                path,
                value,
                CODE_BLOCK_KEYS,
            ),
            "table_head" => refine(
                &mut self.table_head,
                key,
                rest,
                path,
                value,
                TABLE_HEAD_KEYS,
            ),
            "table_cell" => refine(
                &mut self.table_cell,
                key,
                rest,
                path,
                value,
                TABLE_CELL_KEYS,
            ),
            "paragraph_gap" | "code_font_size" => {
                let value = scalar(key, rest, value, "a length")?;
                let length = length(path, value)?;
                match key {
                    "paragraph_gap" => self.paragraph_gap = Some(length),
                    _ => self.code_font_size = Some(length),
                }
                Ok(())
            }
            "code_font_family" => match scalar(key, rest, value, "a font family name")? {
                Bridged::Str(family) if !family.trim().is_empty() => {
                    self.code_font_family = Some(family.clone().into());
                    Ok(())
                }
                other => Err(format!(
                    "`{path}` takes a non-empty font family name; got {other:?}"
                )),
            },
            "foreground"
            | "muted_foreground"
            | "link"
            | "selection"
            | "border"
            | "code_background"
            | "inline_code_background" => {
                let color = scalar(key, rest, value, "a color")?
                    .as_color()
                    .map_err(|error| format!("`{path}`: {}", error.message()))?;
                let slot = match key {
                    "foreground" => &mut self.foreground,
                    "muted_foreground" => &mut self.muted_foreground,
                    "link" => &mut self.link,
                    "selection" => &mut self.selection,
                    "border" => &mut self.border,
                    "code_background" => &mut self.code_background,
                    _ => &mut self.inline_code_background,
                };
                *slot = Some(color);
                Ok(())
            }
            _ => Err(format!(
                "unknown key `{key}`; text_style takes {}",
                TOP_LEVEL_KEYS.join(", ")
            )),
        }
    }

    /// `style` with every value this sets replaced, and every other value
    /// left as it was. `rem_size` converts the lengths Base keeps in another
    /// unit.
    pub(crate) fn fold(&self, mut style: TextViewStyle, rem_size: Pixels) -> TextViewStyle {
        let untouched = StyleRefinement::default();
        if self.heading_default != untouched
            || self.headings.iter().any(|level| *level != untouched)
        {
            // Resolved once, here, rather than in the closure: Base calls it
            // for every heading it lays out.
            let levels: [StyleRefinement; 6] = std::array::from_fn(|index| {
                let mut level = style.heading(index as u8 + 1);
                level.refine(&self.heading_default);
                level.refine(&self.headings[index]);
                level
            });
            style =
                style.with_heading(move |level| levels[usize::from(level.clamp(1, 6)) - 1].clone());
        }
        if let Some(gap) = self.paragraph_gap {
            style = style.with_paragraph_gap(gap.to_rems(rem_size));
        }
        if let Some(color) = self.foreground {
            style = style.with_foreground(color);
        }
        if let Some(color) = self.muted_foreground {
            style = style.with_muted_foreground(color);
        }
        if let Some(color) = self.link {
            style = style.with_link(color);
        }
        if let Some(color) = self.selection {
            style = style.with_selection(color);
        }
        if let Some(color) = self.border {
            style = style.with_border(color);
        }
        if let Some(color) = self.code_background {
            style = style.with_code_background(color);
        }
        if let Some(color) = self.inline_code_background {
            let mut highlight = style.inline_code();
            highlight.background_color = Some(color);
            style = style.with_inline_code(highlight);
        }
        if let Some(family) = &self.code_font_family {
            style = style.with_code_font_family(family.clone());
        }
        if let Some(size) = self.code_font_size {
            style = style.with_code_font_size(size.to_pixels(rem_size));
        }
        if self.code_block != untouched {
            let mut code_block = style.code_block().clone();
            code_block.refine(&self.code_block);
            style = style.with_code_block(code_block);
        }
        if self.table_head != untouched {
            let mut table_head = style.table_head().clone();
            table_head.refine(&self.table_head);
            style = style.with_table_head(table_head);
        }
        if self.table_cell != untouched {
            let mut table_cell = style.table_cell().clone();
            table_cell.refine(&self.table_cell);
            style = style.with_table_cell(table_cell);
        }
        style
    }
}

/// The first key of a path, and the rest of it.
fn split(path: &str) -> (&str, Option<&str>) {
    match path.split_once('.') {
        Some((key, rest)) => (key, Some(rest)),
        None => (path, None),
    }
}

/// The value of a top-level key that takes one, refusing an object there.
fn scalar<'a>(
    key: &str,
    rest: Option<&str>,
    value: Option<&'a Bridged>,
    takes: &str,
) -> Result<&'a Bridged, String> {
    match (rest, value) {
        (None, Some(value)) => Ok(value),
        _ => Err(format!("`{key}` takes {takes}, not an object")),
    }
}

/// Applies one key of a nested object through the style method of the same
/// name, so the value means what it means on an element. `value` is `None`
/// for an empty object at `path`.
fn refine(
    target: &mut StyleRefinement,
    group: &str,
    field: Option<&str>,
    path: &str,
    value: Option<&Bridged>,
    accepted: &[&str],
) -> Result<(), String> {
    let Some(field) = field else {
        return match value {
            None => Ok(()),
            Some(_) => Err(format!(
                "`{group}` takes an object with {}",
                accepted.join(", ")
            )),
        };
    };
    let (name, rest) = split(field);
    if !accepted.contains(&name) {
        return Err(format!(
            "unknown key `{group}.{name}`; {group} takes {}",
            accepted.join(", ")
        ));
    }
    let (None, Some(value)) = (rest, value) else {
        return Err(format!("`{group}.{name}` takes a value, not an object"));
    };
    non_negative(path, value)?;
    *target = style::apply_param(name, std::slice::from_ref(value), target.clone())
        .map_err(|error| format!("`{path}`: {}", error.message()))?;
    Ok(())
}

/// A length a script gave: a bare number is pixels, a string carries its unit.
fn length(path: &str, value: &Bridged) -> Result<AbsoluteLength, String> {
    non_negative(path, value)?;
    let length = style::absolute_length(value, path).map_err(|error| error.message().to_owned())?;
    let amount = match length {
        AbsoluteLength::Pixels(pixels) => pixels.as_f32(),
        AbsoluteLength::Rems(rems) => rems.0,
    };
    if amount.is_finite() && amount >= 0. {
        Ok(length)
    } else {
        Err(format!(
            "`{path}` must be a finite, non-negative length; got {value:?}"
        ))
    }
}

/// Sizes, gaps, weights and multipliers are never negative, and a NaN is a
/// value the script computed wrongly rather than one to draw.
fn non_negative(path: &str, value: &Bridged) -> Result<(), String> {
    match value {
        Bridged::Number(number) if !(number.is_finite() && *number >= 0.) => Err(format!(
            "`{path}` must be a finite, non-negative number; got {number}"
        )),
        _ => Ok(()),
    }
}

/// Reports a `text_style` on anything but a `TextView`.
///
/// Every element shares one prototype, so the method reaches every element,
/// and anywhere else it would do nothing. Called once from
/// [`materialize_node`](crate::materialize), as the tooltip check is.
pub(in crate::materialize) fn warn_unhonoured_text_style(
    component: &Component,
    behavior: &Behavior,
) {
    if behavior.text_style.is_none() || matches!(component, Component::TextView(_)) {
        return;
    }
    tracing::warn!(
        "`text_style` is not honoured on a {}: it styles the document of a \
         `TextView.markdown(...)` or `TextView.html(...)`",
        component.name()
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::{DefiniteLength, FontWeight, Rems, Styled as _, px, relative, rems};

    fn pairs(entries: &[(&str, Bridged)]) -> Vec<Bridged> {
        entries
            .iter()
            .flat_map(|(key, value)| [Bridged::Str((*key).into()), value.clone()])
            .collect()
    }

    fn parse(entries: &[(&str, Bridged)]) -> Result<ScriptTextStyle, String> {
        let mut style = ScriptTextStyle::default();
        style.apply(&pairs(entries))?;
        Ok(style)
    }

    fn number(value: f64) -> Bridged {
        Bridged::Number(value)
    }

    fn text(value: &str) -> Bridged {
        Bridged::Str(value.into())
    }

    fn color(value: &str) -> Hsla {
        text(value).as_color().unwrap()
    }

    #[test]
    fn every_documented_key_parses() {
        let style = parse(&[
            ("headings.default.font_weight", number(700.)),
            ("headings.1.text_size", number(18.)),
            ("headings.1.line_height", number(1.2)),
            ("headings.2.text_size", text("1rem")),
            ("headings.6.text_color", text("#112233")),
            ("paragraph_gap", number(8.)),
            ("foreground", text("#101010")),
            ("muted_foreground", text("#202020")),
            ("link", text("#3366ff")),
            ("selection", text("#3366ff40")),
            ("border", text("#303030")),
            ("code_background", text("#404040")),
            ("inline_code_background", text("#505050")),
            ("code_font_family", text("Menlo")),
            ("code_font_size", number(12.)),
            ("code_block.bg", text("#606060")),
            ("code_block.border_color", text("#707070")),
            ("code_block.rounded", number(6.)),
            ("code_block.px", number(10.)),
            ("code_block.py", number(4.)),
            ("code_block.text_size", number(13.)),
            ("code_block.line_height", text("20px")),
            ("table_head.bg", text("#808080")),
            ("table_head.text_color", text("#909090")),
            ("table_head.font_weight", number(600.)),
            ("table_cell.px", number(6.)),
            ("table_cell.py", number(2.)),
            ("table_cell.text_size", number(12.)),
        ])
        .expect("every documented key");
        assert_eq!(style.headings[0].text.font_size, Some(px(18.).into()));
        assert_eq!(style.headings[0].text.line_height, Some(relative(1.2)));
        assert_eq!(style.headings[1].text.font_size, Some(rems(1.).into()));
        assert_eq!(
            style.heading_default.text.font_weight,
            Some(FontWeight(700.))
        );
        assert_eq!(style.headings[5].text.color, Some(color("#112233")));
        assert_eq!(style.paragraph_gap, Some(px(8.).into()));
        assert_eq!(style.selection, Some(color("#3366ff40")));
        assert_eq!(style.code_font_family.as_deref(), Some("Menlo"));
        assert_eq!(style.code_block.padding.left, Some(px(10.).into()));
        assert_eq!(style.code_block.padding.top, Some(px(4.).into()));
        assert_eq!(
            style.code_block.text.line_height,
            Some(DefiniteLength::from(px(20.)))
        );
        assert_eq!(style.table_cell.padding.right, Some(px(6.).into()));
    }

    #[test]
    fn unknown_keys_name_the_key_and_what_is_accepted() {
        let error = parse(&[("colour", text("#ffffff"))]).unwrap_err();
        assert!(error.contains("unknown key `colour`"), "{error}");
        assert!(error.contains("paragraph_gap"), "{error}");

        let error = parse(&[("code_block.padding", number(4.))]).unwrap_err();
        assert!(
            error.contains("unknown key `code_block.padding`"),
            "{error}"
        );
        assert!(error.contains("px, py"), "{error}");

        let error = parse(&[("headings.7.text_size", number(4.))]).unwrap_err();
        assert!(error.contains("unknown key `headings.7`"), "{error}");

        let error = parse(&[("headings.1.size", number(4.))]).unwrap_err();
        assert!(error.contains("unknown key `headings.1.size`"), "{error}");
        assert!(error.contains("text_size"), "{error}");

        // A style method that exists, but does nothing useful on this part.
        let error = parse(&[("table_head.px", number(4.))]).unwrap_err();
        assert!(error.contains("unknown key `table_head.px`"), "{error}");
    }

    #[test]
    fn values_of_the_wrong_shape_are_refused() {
        for (entries, expected) in [
            (vec![("link", text("blue"))], "`link`"),
            (vec![("link", number(1.))], "`link`"),
            (
                vec![("link.light", text("#ffffff"))],
                "takes a color, not an object",
            ),
            (vec![("headings", number(18.))], "keyed by level"),
            (vec![("headings.1", number(18.))], "takes an object with"),
            (
                vec![("code_block", text("#ffffff"))],
                "takes an object with",
            ),
            (
                vec![("code_block.bg.dark", text("#ffffff"))],
                "takes a value, not an object",
            ),
            (vec![("paragraph_gap", text("50%"))], "absolute length"),
            (vec![("paragraph_gap", number(-1.))], "non-negative"),
            (vec![("code_block.px", number(f64::NAN))], "non-negative"),
            (
                vec![("headings.1.font_weight", number(1000.))],
                "between 100 and 900",
            ),
            (vec![("code_font_family", text("  "))], "non-empty"),
            (vec![("foreground", Bridged::Nil)], "leave the key out"),
        ] {
            let error = parse(&entries).unwrap_err();
            assert!(error.contains(expected), "{entries:?}: {error}");
        }
    }

    #[test]
    fn an_empty_object_sets_nothing_but_its_key_is_checked() {
        let empty = |path: &str| {
            let mut style = ScriptTextStyle::default();
            style
                .apply(&[text(path), Bridged::Bool(true)])
                .map(|()| style)
        };
        for path in [
            "headings.",
            "headings.1.",
            "headings.default.",
            "code_block.",
            "table_cell.",
        ] {
            assert_eq!(empty(path), Ok(ScriptTextStyle::default()), "{path}");
        }
        for (path, expected) in [
            ("colour.", "unknown key `colour`"),
            ("headings.9.", "unknown key `headings.9`"),
            ("code_block.padding.", "unknown key `code_block.padding`"),
            ("link.", "`link` takes a color, not an object"),
            (
                "paragraph_gap.",
                "`paragraph_gap` takes a length, not an object",
            ),
            (
                "code_block.px.",
                "`code_block.px` takes a value, not an object",
            ),
            (
                "headings.1.text_size.",
                "`headings.1.text_size` takes a value, not an object",
            ),
        ] {
            let error = empty(path).unwrap_err();
            assert!(error.contains(expected), "{path}: {error}");
        }
    }

    #[test]
    fn an_odd_pair_list_is_refused() {
        let mut style = ScriptTextStyle::default();
        assert!(style.apply(&[text("link")]).is_err());
    }

    #[test]
    fn fields_left_out_keep_the_theme_value() {
        let base = TextViewStyle::default()
            .with_code_block(StyleRefinement::default().rounded(px(3.)).py(px(9.)));
        let folded = parse(&[("link", text("#ff0000"))])
            .unwrap()
            .fold(base.clone(), px(16.));
        assert_eq!(folded.link(), color("#ff0000"));
        assert!(folded.foreground() == base.foreground());
        assert!(folded.code_background() == base.code_background());
        assert_eq!(folded.paragraph_gap(), base.paragraph_gap());
        assert_eq!(folded.code_block(), base.code_block());
        for level in 1..=6 {
            assert_eq!(folded.heading(level), base.heading(level));
        }
    }

    #[test]
    fn given_fields_fold_onto_the_theme_value() {
        let base = TextViewStyle::default()
            .with_heading(|level| StyleRefinement::default().pb(px(f32::from(level))))
            .with_code_block(StyleRefinement::default().rounded(px(3.)).py(px(9.)));
        let script = parse(&[
            ("headings.default.font_weight", number(700.)),
            ("headings.1.text_size", number(24.)),
            ("headings.1.font_weight", number(800.)),
            ("paragraph_gap", number(8.)),
            ("inline_code_background", text("#00ff00")),
            ("code_font_size", text("0.75rem")),
            ("code_block.px", number(5.)),
            ("table_cell.py", number(2.)),
        ])
        .unwrap();
        let folded = script.fold(base.clone(), px(16.));

        // The level's own entry wins over `default`, which wins over the
        // theme; what neither sets keeps the theme's value.
        let h1 = folded.heading(1);
        assert_eq!(h1.text.font_size, Some(px(24.).into()));
        assert_eq!(h1.text.font_weight, Some(FontWeight(800.)));
        assert_eq!(h1.padding.bottom, Some(px(1.).into()));
        let h3 = folded.heading(3);
        assert_eq!(h3.text.font_size, None);
        assert_eq!(h3.text.font_weight, Some(FontWeight(700.)));
        assert_eq!(h3.padding.bottom, Some(px(3.).into()));

        assert_eq!(folded.paragraph_gap(), Rems(0.5));
        assert_eq!(folded.code_font_size(), Some(px(12.)));
        assert_eq!(
            folded.inline_code().background_color,
            Some(color("#00ff00"))
        );
        let code_block = folded.code_block();
        assert_eq!(code_block.padding.left, Some(px(5.).into()));
        assert_eq!(code_block.padding.top, Some(px(9.).into()));
        assert_eq!(code_block.corner_radii.top_left, Some(px(3.).into()));
        assert_eq!(folded.table_cell().padding.top, Some(px(2.).into()));
        assert!(folded.foreground() == base.foreground());
    }

    #[test]
    fn later_calls_fold_onto_earlier_ones() {
        let mut style = ScriptTextStyle::default();
        style
            .apply(&pairs(&[
                ("link", text("#ff0000")),
                ("code_block.px", number(5.)),
            ]))
            .unwrap();
        style
            .apply(&pairs(&[
                ("link", text("#00ff00")),
                ("code_block.py", number(2.)),
            ]))
            .unwrap();
        assert_eq!(style.link, Some(color("#00ff00")));
        assert_eq!(style.code_block.padding.left, Some(px(5.).into()));
        assert_eq!(style.code_block.padding.top, Some(px(2.).into()));
    }
}
