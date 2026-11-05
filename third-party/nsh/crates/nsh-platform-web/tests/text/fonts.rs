//! The CSS `font` of text styles (`css::css_font`).

use nsh_core::{FontFamily, Points, ResolvedTextStyle};

use crate::css::{css_font, family_list};

fn style(family: Option<&str>) -> ResolvedTextStyle {
    ResolvedTextStyle {
        font_family: family.map(FontFamily::new),
        font_size: Points(14.0),
        font_weight: 400,
        ..ResolvedTextStyle::default()
    }
}

#[test]
fn generic_families_stay_unquoted() {
    for generic in [
        "monospace",
        "ui-monospace",
        "serif",
        "sans-serif",
        "system-ui",
        "cursive",
    ] {
        assert_eq!(family_list(generic), generic);
    }
    // CSS matches them ASCII case-insensitively.
    assert_eq!(family_list("Monospace"), "Monospace");
    assert_eq!(family_list("-apple-system"), "-apple-system");
    // Chrome's system font keyword is only one unquoted.
    assert_eq!(family_list("BlinkMacSystemFont"), "BlinkMacSystemFont");
}

#[test]
fn font_names_are_quoted() {
    assert_eq!(family_list("Fira Code"), "\"Fira Code\"");
    assert_eq!(family_list("Pacifico"), "\"Pacifico\"");
    // A name that happens to contain a keyword is still a name.
    assert_eq!(family_list("monospace2"), "\"monospace2\"");
    assert_eq!(family_list("a\"b"), "\"a\\\"b\"");
}

#[test]
fn stacks_keep_each_family_as_written() {
    assert_eq!(
        family_list("\"Fira Code\", ui-monospace,monospace"),
        "\"Fira Code\", ui-monospace, monospace"
    );
    assert_eq!(
        family_list("Menlo, 'DejaVu Sans Mono', monospace"),
        "\"Menlo\", 'DejaVu Sans Mono', monospace"
    );
    // A comma inside quotes is part of the name.
    assert_eq!(family_list("\"A, B\", serif"), "\"A, B\", serif");
    assert_eq!(family_list(" , "), "");
}

#[test]
fn the_shorthand_puts_the_family_before_the_system_stack() {
    let mono = css_font(&style(Some("monospace")));
    assert!(
        mono.starts_with("400 14px monospace, -apple-system, "),
        "{mono}"
    );
    assert!(!mono.contains("\"monospace\""), "{mono}");
    let named = css_font(&style(Some("Fira Code")));
    assert!(
        named.starts_with("400 14px \"Fira Code\", -apple-system, "),
        "{named}"
    );
    let system = css_font(&style(None));
    assert!(system.starts_with("400 14px -apple-system, "), "{system}");
    assert!(system.ends_with(", sans-serif"), "{system}");
    let italic = ResolvedTextStyle {
        italic: true,
        font_weight: 700,
        ..style(None)
    };
    assert!(css_font(&italic).starts_with("italic 700 14px "));
    assert_eq!(css_font(&style(Some(" "))), system);
}

#[test]
fn numeric_variants_name_their_css() {
    use nsh_core::FontVariant;

    use crate::css::font_variant_numeric;

    assert_eq!(font_variant_numeric(FontVariant(0)), None);
    // Small caps are not numeric (canvas `font` takes them).
    assert_eq!(
        font_variant_numeric(FontVariant(FontVariant::SMALL_CAPS)),
        None
    );
    assert_eq!(
        font_variant_numeric(FontVariant(FontVariant::TABULAR_NUMS)).as_deref(),
        Some("tabular-nums")
    );
    assert_eq!(
        font_variant_numeric(FontVariant(
            FontVariant::OLDSTYLE_NUMS | FontVariant::TABULAR_NUMS | FontVariant::SMALL_CAPS
        ))
        .as_deref(),
        Some("oldstyle-nums tabular-nums")
    );
    assert_eq!(
        font_variant_numeric(FontVariant::parse("lining-nums proportional-nums").unwrap())
            .as_deref(),
        Some("lining-nums proportional-nums")
    );
}

#[test]
fn quotes_that_do_not_close_a_name_are_quoted_again() {
    // As written when the quotes close it.
    assert_eq!(family_list("'DejaVu Sans Mono'"), "'DejaVu Sans Mono'");
    assert_eq!(family_list("\"Fira Code\""), "\"Fira Code\"");
    // Otherwise the name is quoted here, escaped, so the class's rule
    // stays one CSS declaration.
    assert_eq!(family_list("\"Fira Code"), "\"Fira Code\"");
    assert_eq!(family_list("'a'b'"), "\"a'b\"");
    assert_eq!(family_list("\"a\\\""), "\"a\\\\\"");
    assert_eq!(family_list("Line\nBreak"), "\"LineBreak\"");
}

#[test]
fn figures_are_measured_character_by_character() {
    use crate::css::measured_by_char;

    for figure in [
        "530.92",
        "1,234.56",
        "-0.5%",
        "+12.3%",
        "$1,111.11",
        "12:30",
        "(42)",
        "1 234",
    ] {
        assert!(measured_by_char(figure), "{figure}");
    }
    // Text with letters is measured whole, its kerning with it.
    for text in ["Price 12", "12 shares", "AAPL", ""] {
        assert!(!measured_by_char(text), "{text}");
    }
}

#[test]
fn figures_are_measured_with_the_kerning_of_their_pairs() {
    use crate::css::figure_width;

    // Arial at 20px as Chrome 156 measures it: no `tnum`, and `11` kerned
    // by -152/2048 em (Liberation Sans 2.x, Linux Chrome's Arial, too).
    let measure = |text: &str| -> f32 {
        let chars: f32 = text
            .chars()
            .map(|c| match c {
                '.' | ',' | ':' => 5.5625,
                '-' => 6.65625,
                '%' => 17.78125,
                _ => 11.125,
            })
            .sum();
        let kerned = text
            .as_bytes()
            .windows(2)
            .filter(|pair| pair == b"11")
            .count();
        chars - 1.484375 * kerned as f32
    };
    for figure in ["$1,111.11", "111.11", "530.92", "-0.5%", "12:30"] {
        let mut asked = Vec::new();
        let width = figure_width(figure, |part| {
            asked.push(part.to_owned());
            measure(part)
        });
        assert!(
            (width - measure(figure)).abs() < 1e-3,
            "{figure}: {width} != {}",
            measure(figure)
        );
        // Only characters and pairs: a new value is never measured whole.
        assert!(
            asked.iter().all(|part| part.chars().count() <= 2),
            "{figure}: {asked:?}"
        );
    }
    assert!((figure_width("$1,111.11", measure) - 84.546_875).abs() < 1e-3);
}

#[test]
fn emoji_are_told_from_text() {
    use crate::css::is_emoji;

    // What the color emoji font may draw: emoji, text by default or not
    // (☝ ✌ ✍ ⛹ have no glyph in macOS's text fonts), modifiers, regional
    // indicators, the emoji variation selector and the keycap.
    for c in [
        '🤩', '👍', '🏻', '🇨', '🀄', '⌚', '⭐', '✅', '☝', '✌', '✍', '⛹', '❤', '©', '\u{fe0f}',
        '\u{20e3}',
    ] {
        assert!(is_emoji(c), "{c}");
    }
    // Text: letters, CJK, digits, `#` and `*` (text without U+FE0F),
    // symbols without the `Emoji` property, the joiner.
    for c in ['a', '中', 'ไ', '1', '#', '*', '★', '✓', '\u{200d}'] {
        assert!(!is_emoji(c), "{c}");
    }
}

#[test]
fn emoji_excess_adds_each_emoji_cluster_once() {
    use crate::css::emoji_excess;

    let clusters = |text: &str| {
        let mut seen = Vec::new();
        emoji_excess(text, |c| {
            seen.push(c.to_owned());
            0.0
        });
        seen
    };
    // 22 emoji, 4 points each too wide on canvas: the line is 88 narrower.
    assert_eq!(emoji_excess(&"🤩".repeat(22), |_| 4.0), 88.0);
    // Sequences are one cluster each: ZWJ, skin tone, flags, a subdivision
    // flag's tags, a keycap, U+FE0F; text around them is no cluster.
    assert_eq!(
        clusters("a👨‍👩‍👧‍👦b 👍🏽🇨🇳🇺🇸 🏴󠁧󠁢󠁥󠁮󠁧󠁿 #️⃣ ❤️ ☝✌ 中"),
        ["👨‍👩‍👧‍👦", "👍🏽", "🇨🇳", "🇺🇸", "🏴󠁧󠁢󠁥󠁮󠁧󠁿", "#️⃣", "❤️", "☝", "✌"]
    );
    // Text without emoji is not split at all.
    assert!(clusters("Hello 世界 ไทย 123 #*").is_empty());
}
