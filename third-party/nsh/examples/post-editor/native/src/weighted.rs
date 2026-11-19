//! The weighted length of a post's text, the rule the server and the web
//! editor share (`content-limit-rules.ts` of `@web/utils`, the single source
//! its `weighted-length.ts` re-exports).
//!
//! Each grapheme has a visual weight: in a Chinese locale a Han character,
//! Chinese punctuation or an emoji weighs 1 and ASCII letters, digits,
//! punctuation and spaces 0.5; in every other locale the weights double
//! (ASCII 1, the rest 2), so the capacity is the same in both: 1000 Han
//! characters or 2000 ASCII ones. The sum rounds up.
//!
//! The rule is ported as written, quirks included: the Chinese punctuation
//! class of the source holds the ASCII `"` and `'` (its curly quotes were
//! flattened), so those two weigh 1 in a Chinese locale, not 0.5.

use std::sync::LazyLock;

use regex::Regex;
use unicode_segmentation::UnicodeSegmentation;

/// The characters weighed as Chinese punctuation (the source's class, its
/// quotes ASCII).
const ZH_PUNCT: &str = "，。；：\"\"''（）【】、？";

static HAN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\p{Script=Han}").unwrap());
static PICTOGRAPHIC: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\p{Emoji_Presentation}|\p{Extended_Pictographic}").unwrap());
static REGIONAL_INDICATOR: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("[\u{1F1E6}-\u{1F1FF}]").unwrap());
static KEYCAP: LazyLock<Regex> = LazyLock::new(|| Regex::new("[#*0-9]\u{FE0F}?\u{20E3}").unwrap());

/// Whether `locale` is a Chinese one (`zh-CN`, `zh-HK`, `zh-TW`).
pub fn is_zh_locale(locale: &str) -> bool {
    matches!(locale, "zh-CN" | "zh-HK" | "zh-TW")
}

/// The most a post may weigh: 1000 in a Chinese locale, 2000 in any other.
pub fn content_max_length(locale: &str) -> u32 {
    if is_zh_locale(locale) { 1000 } else { 2000 }
}

fn is_ascii_punct(c: char) -> bool {
    c.is_ascii_punctuation()
}

/// The weight of one grapheme.
fn unit_weight(grapheme: &str, zh: bool) -> f64 {
    let (narrow, wide) = if zh { (0.5, 1.0) } else { (1.0, 2.0) };
    if grapheme.is_empty() {
        return 0.0;
    }
    if grapheme.contains(' ') {
        return narrow;
    }
    if PICTOGRAPHIC.is_match(grapheme)
        || REGIONAL_INDICATOR.is_match(grapheme)
        || KEYCAP.is_match(grapheme)
    {
        return wide;
    }
    if grapheme.chars().any(|c| ZH_PUNCT.contains(c)) || HAN.is_match(grapheme) {
        return wide;
    }
    if grapheme
        .chars()
        .any(|c| c.is_ascii_alphanumeric() || is_ascii_punct(c))
    {
        return narrow;
    }
    wide
}

/// The weighted length of `text` in `locale`.
pub fn weighted_length(text: &str, locale: &str) -> u32 {
    let zh = is_zh_locale(locale);
    let total: f64 = text.graphemes(true).map(|g| unit_weight(g, zh)).sum();
    total.ceil() as u32
}

/// The longest start of `text` whose weighted length is at most `limit`; the
/// whole text for a limit of 0.
pub fn trim_to_weighted_limit(text: &str, limit: u32, locale: &str) -> String {
    if text.is_empty() || limit == 0 {
        return text.to_owned();
    }
    let zh = is_zh_locale(locale);
    let mut total = 0.0;
    let mut out = String::new();
    for g in text.graphemes(true) {
        total += unit_weight(g, zh);
        if total.ceil() > f64::from(limit) {
            break;
        }
        out.push_str(g);
    }
    out
}

/// The text of `html` (`textContent`): tags dropped, the common entities
/// decoded. What the web editor counts: `extractPlainText(getHTML())`.
pub fn html_text(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    for c in html.chars() {
        match c {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            c if !in_tag => out.push(c),
            _ => {}
        }
    }
    out.replace("&nbsp;", "\u{a0}")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&amp;", "&")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn han_weighs_one_and_ascii_half_in_a_chinese_locale() {
        assert_eq!(weighted_length("", "zh-CN"), 0);
        assert_eq!(weighted_length("你好世界", "zh-CN"), 4);
        // 0.5 + 0.5 = 1, 1.5 rounds up to 2.
        assert_eq!(weighted_length("ab", "zh-CN"), 1);
        assert_eq!(weighted_length("abc", "zh-CN"), 2);
        assert_eq!(weighted_length("你a", "zh-CN"), 2);
        assert_eq!(weighted_length("你好ab", "zh-CN"), 3);
        assert_eq!(weighted_length(" ", "zh-CN"), 1);
        assert_eq!(weighted_length("  ", "zh-CN"), 1);
        assert_eq!(weighted_length("12", "zh-CN"), 1);
    }

    #[test]
    fn the_weights_double_outside_a_chinese_locale() {
        assert_eq!(weighted_length("abc", "en"), 3);
        assert_eq!(weighted_length("你好", "en"), 4);
        assert_eq!(weighted_length("你", "ja"), 2);
        assert_eq!(weighted_length(" ", "en"), 1);
    }

    #[test]
    fn emoji_are_whole_graphemes() {
        assert_eq!(weighted_length("😀", "zh-CN"), 1);
        assert_eq!(weighted_length("😀", "en"), 2);
        // A family is one grapheme of four emoji joined: one weight.
        assert_eq!(weighted_length("👨‍👩‍👧‍👦", "zh-CN"), 1);
        assert_eq!(weighted_length("🇨🇳", "zh-CN"), 1);
        assert_eq!(weighted_length("1\u{FE0F}\u{20E3}", "zh-CN"), 1);
    }

    #[test]
    fn chinese_punctuation_counts_as_han() {
        assert_eq!(weighted_length("，。？", "zh-CN"), 3);
        assert_eq!(weighted_length("，", "en"), 2);
        // The source's class holds the ASCII quotes: 1, not 0.5.
        assert_eq!(weighted_length("\"", "zh-CN"), 1);
        assert_eq!(weighted_length("'", "zh-CN"), 1);
        assert_eq!(weighted_length("!", "zh-CN"), 1);
        assert_eq!(weighted_length("!!", "zh-CN"), 1);
    }

    #[test]
    fn the_capacity_is_the_same_in_both_scenes() {
        assert_eq!(content_max_length("zh-CN"), 1000);
        assert_eq!(content_max_length("zh-HK"), 1000);
        assert_eq!(content_max_length("en"), 2000);
        assert_eq!(content_max_length("ja"), 2000);
        // Han: 1000 in zh and 2000 in en are both exactly the limit.
        assert_eq!(
            weighted_length(&"中".repeat(1000), "zh-CN"),
            content_max_length("zh-CN")
        );
        assert_eq!(
            weighted_length(&"中".repeat(1000), "en"),
            content_max_length("en")
        );
        assert_eq!(
            weighted_length(&"a".repeat(2000), "zh-CN"),
            content_max_length("zh-CN")
        );
        assert_eq!(
            weighted_length(&"a".repeat(2000), "en"),
            content_max_length("en")
        );
        assert!(weighted_length(&"中".repeat(1001), "zh-CN") > content_max_length("zh-CN"));
        assert!(weighted_length(&"a".repeat(2002), "en") > content_max_length("en"));
    }

    #[test]
    fn trimming_keeps_the_start_that_fits() {
        assert_eq!(trim_to_weighted_limit("", 5, "zh-CN"), "");
        assert_eq!(trim_to_weighted_limit("你好世界", 0, "zh-CN"), "你好世界");
        assert_eq!(trim_to_weighted_limit("你好", 10, "zh-CN"), "你好");
        assert_eq!(trim_to_weighted_limit("你好世界", 2, "zh-CN"), "你好");
        assert_eq!(trim_to_weighted_limit("abc你", 2, "zh-CN"), "abc");
        assert_eq!(trim_to_weighted_limit("abcde", 3, "en"), "abc");
        // A grapheme is never cut.
        assert_eq!(trim_to_weighted_limit("👨‍👩‍👧‍👦a", 1, "zh-CN"), "👨‍👩‍👧‍👦");
        assert_eq!(trim_to_weighted_limit("👨‍👩‍👧‍👦a", 2, "zh-CN"), "👨‍👩‍👧‍👦a");
    }

    #[test]
    fn html_text_is_the_text_content() {
        assert_eq!(html_text("<p>你好世界</p>"), "你好世界");
        assert_eq!(
            html_text("<p><span type=\"security-tag\">$TSLA</span> a &amp; b</p>"),
            "$TSLA a & b"
        );
        assert_eq!(html_text("<p>a</p><p>b</p>"), "ab");
    }
}
