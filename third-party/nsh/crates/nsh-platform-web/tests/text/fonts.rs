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
