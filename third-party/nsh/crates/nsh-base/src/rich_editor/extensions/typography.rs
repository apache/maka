//! Tiptap's `Typography`: input rules turning typed ASCII into typographic
//! characters (dashes, ellipses, quotes, arrows, signs, fractions), each
//! one switchable. Ported from `@tiptap/extension-typography`.

use regex::Regex;

use super::input_rules::InputRule;

/// The replacement of each rule; `None` turns a rule off. The defaults are
/// Tiptap's.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct TypographyOptions {
    /// `--` (`—`).
    pub em_dash: Option<String>,
    /// `...` (`…`).
    pub ellipsis: Option<String>,
    /// `"` after white space or an opening bracket (`“`).
    pub open_double_quote: Option<String>,
    /// `"` elsewhere (`”`).
    pub close_double_quote: Option<String>,
    /// `'` after white space or an opening bracket (`‘`).
    pub open_single_quote: Option<String>,
    /// `'` elsewhere (`’`).
    pub close_single_quote: Option<String>,
    /// `<-` (`←`).
    pub left_arrow: Option<String>,
    /// `->` (`→`).
    pub right_arrow: Option<String>,
    /// `(c)` (`©`).
    pub copyright: Option<String>,
    /// `(tm)` (`™`).
    pub trademark: Option<String>,
    /// `(sm)` (`℠`).
    pub servicemark: Option<String>,
    /// `(r)` (`®`).
    pub registered_trademark: Option<String>,
    /// `1/2 ` (`½`).
    pub one_half: Option<String>,
    /// `+/-` (`±`).
    pub plus_minus: Option<String>,
    /// `!=` (`≠`).
    pub not_equal: Option<String>,
    /// `<<` (`«`).
    pub laquo: Option<String>,
    /// `>>` (`»`).
    pub raquo: Option<String>,
    /// `*` or `x` between numbers (`×`).
    pub multiplication: Option<String>,
    /// `^2` (`²`).
    pub superscript_two: Option<String>,
    /// `^3` (`³`).
    pub superscript_three: Option<String>,
    /// `1/4 ` (`¼`).
    pub one_quarter: Option<String>,
    /// `3/4 ` (`¾`).
    pub three_quarters: Option<String>,
    /// Opening and closing double quotes for right-to-left text, used
    /// instead of the two above when set.
    pub double_quotes_rtl: Option<(String, String)>,
    /// Opening and closing single quotes for right-to-left text.
    pub single_quotes_rtl: Option<(String, String)>,
}

impl Default for TypographyOptions {
    fn default() -> Self {
        let s = |s: &str| Some(s.to_owned());
        Self {
            em_dash: s("\u{2014}"),
            ellipsis: s("\u{2026}"),
            open_double_quote: s("\u{201C}"),
            close_double_quote: s("\u{201D}"),
            open_single_quote: s("\u{2018}"),
            close_single_quote: s("\u{2019}"),
            left_arrow: s("\u{2190}"),
            right_arrow: s("\u{2192}"),
            copyright: s("\u{00A9}"),
            trademark: s("\u{2122}"),
            servicemark: s("\u{2120}"),
            registered_trademark: s("\u{00AE}"),
            one_half: s("\u{00BD}"),
            plus_minus: s("\u{00B1}"),
            not_equal: s("\u{2260}"),
            laquo: s("\u{00AB}"),
            raquo: s("\u{00BB}"),
            multiplication: s("\u{00D7}"),
            superscript_two: s("\u{00B2}"),
            superscript_three: s("\u{00B3}"),
            one_quarter: s("\u{00BC}"),
            three_quarters: s("\u{00BE}"),
            double_quotes_rtl: None,
            single_quotes_rtl: None,
        }
    }
}

fn rule(pattern: &str, replace: &str) -> InputRule {
    InputRule::text(Regex::new(pattern).expect("a valid expression"), replace)
}

const OPEN_DOUBLE: &str = r#"(?:^|[\s{\[(<'"\u{2018}\u{201C}])(")$"#;
const OPEN_SINGLE: &str = r#"(?:^|[\s{\[(<'"\u{2018}\u{201C}])(')$"#;

/// The typography rules `options` turns on, in Tiptap's order.
pub fn typography(options: &TypographyOptions) -> Vec<InputRule> {
    let o = options;
    let mut rules = Vec::new();
    let mut add = |pattern: &str, replace: &Option<String>| {
        if let Some(replace) = replace {
            rules.push(rule(pattern, replace));
        }
    };
    add("--$", &o.em_dash);
    add(r"\.\.\.$", &o.ellipsis);
    match &o.double_quotes_rtl {
        Some((open, close)) => {
            add(OPEN_DOUBLE, &Some(open.clone()));
            add(r#""$"#, &Some(close.clone()));
        }
        None => {
            add(OPEN_DOUBLE, &o.open_double_quote);
            add(r#""$"#, &o.close_double_quote);
        }
    }
    match &o.single_quotes_rtl {
        Some((open, close)) => {
            add(OPEN_SINGLE, &Some(open.clone()));
            add("'$", &Some(close.clone()));
        }
        None => {
            add(OPEN_SINGLE, &o.open_single_quote);
            add("'$", &o.close_single_quote);
        }
    }
    add("<-$", &o.left_arrow);
    add("->$", &o.right_arrow);
    add(r"\(c\)$", &o.copyright);
    add(r"\(tm\)$", &o.trademark);
    add(r"\(sm\)$", &o.servicemark);
    add(r"\(r\)$", &o.registered_trademark);
    add(r"(?:^|\s)(1/2)\s$", &o.one_half);
    add(r"\+/-$", &o.plus_minus);
    add("!=$", &o.not_equal);
    add("<<$", &o.laquo);
    add(">>$", &o.raquo);
    add(r"\d+\s?([*x])\s?\d+$", &o.multiplication);
    add(r"\^2$", &o.superscript_two);
    add(r"\^3$", &o.superscript_three);
    add(r"(?:^|\s)(1/4)\s$", &o.one_quarter);
    add(r"(?:^|\s)(3/4)\s$", &o.three_quarters);
    rules
}
