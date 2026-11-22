//! The CSS that text is measured and drawn with. It depends on nothing of
//! the browser, so its tests run off WebAssembly too (`tests/text`).

use nsh_core::{FontVariant, ResolvedTextStyle, text_edit::next_cluster};
use unicode_properties::UnicodeEmoji;

/// The system font stack (what `fontFamily` unset means).
const SYSTEM_FONT: &str = "-apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, \
                                      \"Helvetica Neue\", Arial, \"PingFang SC\", \
                                      \"Noto Sans SC\", \"Microsoft YaHei\", sans-serif";

/// The CSS `font` shorthand of a style.
pub(crate) fn css_font(style: &ResolvedTextStyle) -> String {
    let family = match style.font_family.map(|f| family_list(&f.name())) {
        Some(list) if !list.is_empty() => format!("{list}, {SYSTEM_FONT}"),
        _ => SYSTEM_FONT.to_owned(),
    };
    format!(
        "{}{} {}px {family}",
        if style.italic { "italic " } else { "" },
        style.font_weight,
        style.font_size.0
    )
}

/// The CSS `font-variant-numeric` of a style's variant (`None`: normal).
/// Canvas text has no numeric variants, so text with one is measured in
/// the DOM (`ffi::measure_numeric_text`).
pub(crate) fn font_variant_numeric(variant: FontVariant) -> Option<String> {
    let names = [
        (FontVariant::OLDSTYLE_NUMS, "oldstyle-nums"),
        (FontVariant::LINING_NUMS, "lining-nums"),
        (FontVariant::TABULAR_NUMS, "tabular-nums"),
        (FontVariant::PROPORTIONAL_NUMS, "proportional-nums"),
    ];
    let mut css = String::new();
    for (bit, name) in names {
        if variant.0 & bit != 0 {
            if !css.is_empty() {
                css.push(' ');
            }
            css.push_str(name);
        }
    }
    (!css.is_empty()).then_some(css)
}

/// Whether `c` may have its cluster drawn by the color emoji font: a
/// character with Unicode's `Emoji` property outside ASCII (digits, `#`
/// and `*` are text), the emoji variation selector and the keycap. Its
/// default presentation does not tell: ☝ ✌ ✍ ⛹ are text by default, yet
/// macOS's text fonts have no glyph for them. A symbol a text font draws
/// costs one measurement in the DOM, no error.
pub(crate) fn is_emoji(c: char) -> bool {
    !c.is_ascii() && (c.is_emoji_char() || matches!(c, '\u{FE0F}' | '\u{20E3}'))
}

/// How much wider the DOM draws `text`'s emoji than canvas measures them:
/// `excess` of each of its clusters with an emoji ([`is_emoji`]), summed.
/// The DOM draws them at the screen's pixel ratio, canvas measures them at
/// 1x (14 against 18 px at 14px on a 2x screen).
pub(crate) fn emoji_excess(text: &str, mut excess: impl FnMut(&str) -> f32) -> f32 {
    if !text.chars().any(is_emoji) {
        return 0.0;
    }
    let mut sum = 0.0;
    let mut at = 0;
    while at < text.len() {
        let end = next_cluster(text, at);
        if text[at..end].chars().any(is_emoji) {
            sum += excess(&text[at..end]);
        }
        at = end;
    }
    sum
}

/// Whether text with a numeric variant is measured character by
/// character (each character and each adjacent pair measured once, the
/// characters summed with the pairs' kerning) rather than whole: text of
/// digits and the signs numbers are written with (prices, times,
/// percentages, counters), which no font shapes beyond pairs. It is what
/// changes on every update of a live figure; measuring it whole would lay
/// the page out for every new value (`ffi::measure_numeric_text`). Other
/// text (with letters) is measured whole.
pub(crate) fn measured_by_char(text: &str) -> bool {
    !text.is_empty()
        && text.chars().all(|c| {
            c.is_ascii_digit()
                || matches!(
                    c,
                    '.' | ','
                        | ':'
                        | '/'
                        | '+'
                        | '-'
                        | '−'
                        | '%'
                        | '‰'
                        | '$'
                        | '€'
                        | '£'
                        | '¥'
                        | '¢'
                        | '₩'
                        | '₹'
                        | '#'
                        | '('
                        | ')'
                        | ' '
                        | '\u{a0}'
                        | '\u{202f}'
                        | '\u{2009}'
                )
        })
}

/// The width of a figure (`measured_by_char`) from `measure`, which is
/// only asked for its characters and adjacent pairs: each character's
/// width plus the kerning of each pair (the pair whole, less its two
/// characters). Fonts without `tnum` still kern digits (Arial and
/// Liberation Sans: `11`).
pub(crate) fn figure_width(text: &str, mut measure: impl FnMut(&str) -> f32) -> f32 {
    let mut sum = 0.0;
    let mut prev: Option<(usize, f32)> = None;
    for (i, c) in text.char_indices() {
        let end = i + c.len_utf8();
        let w = measure(&text[i..end]);
        sum += match prev {
            Some((start, before)) => measure(&text[start..end]) - before,
            None => w,
        };
        prev = Some((i, w));
    }
    sum
}

/// A `fontFamily` value as a CSS family list: one family or a
/// comma-separated stack. Generic families and the system font keywords
/// stay bare (quoted, `"monospace"` names a font called monospace, which
/// no system has, and the text falls back to the next family); other
/// names are quoted and CSS-escaped via [`nsh_core::css_font_families`].
pub(crate) fn family_list(value: &str) -> String {
    nsh_core::css_font_families(value)
}
