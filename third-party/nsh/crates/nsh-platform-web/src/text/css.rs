//! The CSS that text is measured and drawn with. It depends on nothing of
//! the browser, so its tests run off WebAssembly too (`tests/text`).

use nsh_core::{FontVariant, ResolvedTextStyle};

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

/// Whether text with a numeric variant is measured character by
/// character (each character's width measured once, then summed) rather
/// than whole: text of digits and the signs numbers are written with
/// (prices, times, percentages, counters), whose digits the variant draws
/// at fixed widths and which nothing kerns. It is what changes on every
/// update of a live figure; measuring it whole would lay the page out for
/// every new value (`ffi::measure_numeric_text`). Other text (with letters)
/// is measured whole, kerning included.
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

/// A `fontFamily` value as a CSS family list: one family or a
/// comma-separated stack. Generic families and the system font keywords
/// stay bare (quoted, `"monospace"` names a font called monospace, which
/// no system has, and the text falls back to the next family); other
/// names are quoted, and names the app quoted keep their quotes.
pub(crate) fn family_list(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    for family in split_families(value) {
        if !out.is_empty() {
            out.push_str(", ");
        }
        if well_quoted(family) || is_keyword(family) {
            out.push_str(family);
        } else {
            // A name, or a quoted one whose quotes do not close it: quoted
            // here, escaped, without control characters (a CSS string
            // cannot hold a line break).
            let name = family.trim_matches(['"', '\'']);
            out.push('"');
            for c in name.chars().filter(|c| !c.is_control()) {
                if c == '"' || c == '\\' {
                    out.push('\\');
                }
                out.push(c);
            }
            out.push('"');
        }
    }
    out
}

/// A name the app quoted that its quotes close: the same quote at both
/// ends, and none of it, a backslash or a control character inside, so it
/// is one CSS string as written.
fn well_quoted(family: &str) -> bool {
    let Some(quote) = family.chars().next().filter(|c| *c == '"' || *c == '\'') else {
        return false;
    };
    family.len() >= 2
        && family.ends_with(quote)
        && !family[1..family.len() - 1]
            .chars()
            .any(|c| c == quote || c == '\\' || c.is_control())
}

/// The families of a list, trimmed, without empty ones; commas inside
/// quotes do not separate.
fn split_families(value: &str) -> impl Iterator<Item = &str> {
    let mut rest = value;
    std::iter::from_fn(move || {
        loop {
            if rest.is_empty() {
                return None;
            }
            let mut quote = None;
            let mut end = rest.len();
            for (i, c) in rest.char_indices() {
                match quote {
                    Some(q) if c == q => quote = None,
                    Some(_) => {}
                    None if c == '"' || c == '\'' => quote = Some(c),
                    None if c == ',' => {
                        end = i;
                        break;
                    }
                    None => {}
                }
            }
            let family = rest[..end].trim();
            rest = rest.get(end + 1..).unwrap_or("");
            if !family.is_empty() {
                return Some(family);
            }
        }
    })
}

/// A CSS generic family (CSS Fonts 4) or a system font keyword: written
/// without quotes. CSS matches them ASCII case-insensitively.
fn is_keyword(family: &str) -> bool {
    const KEYWORDS: [&str; 15] = [
        "serif",
        "sans-serif",
        "monospace",
        "cursive",
        "fantasy",
        "system-ui",
        "ui-serif",
        "ui-sans-serif",
        "ui-monospace",
        "ui-rounded",
        "math",
        "emoji",
        "fangsong",
        "-apple-system",
        // Chrome's name for the system font on macOS: a family only unquoted.
        "BlinkMacSystemFont",
    ];
    KEYWORDS.iter().any(|k| k.eq_ignore_ascii_case(family))
}
