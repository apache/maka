//! What steps name views with, in Playwright's manner: a matcher, then
//! more after ` >> ` that look inside what the one before matched, and
//! `nth=<n>` picking one of the matches.
//!
//! | Matcher | Matches |
//! |---|---|
//! | `id:<testID>` | the view with that `testID` |
//! | `label:<label>`, `label:/<regex>/<flags>` | the view with that accessibility label |
//! | `text:<text>`, `text:/<regex>/<flags>` | a text that reads it (spaces around it aside), an input holding it or, while empty, with that placeholder |
//! | `role:<role>`, `role:<role>[<name>]` | a view with that `role`, its name (its label, else the texts in it) `<name>` (or `/<regex>/`) |
//! | `view:<id>` | the view with that node id (as `--trace` prints it) |
//! | anything else | a test id, else a label, else a text, as written |
//!
//! A regex is JavaScript's: its flags `i`, `m`, `s` and `u` apply, `g` and
//! `y` mean nothing for a match.

use nsh_core::NodeId;
use regex::Regex;

/// A parsed selector: its parts, in order, and how it was written.
#[derive(Debug, Clone)]
pub(crate) struct Selector {
    pub(crate) parts: Vec<Part>,
    source: String,
}

/// One part of a selector: what it matches, and which match it keeps.
#[derive(Debug, Clone)]
pub(crate) struct Part {
    pub(crate) matcher: Matcher,
    pub(crate) nth: Option<usize>,
}

#[derive(Debug, Clone)]
pub(crate) enum Matcher {
    TestId(String),
    Label(TextMatch),
    Text(TextMatch),
    Role {
        role: String,
        name: Option<TextMatch>,
    },
    View(NodeId),
    Any(String),
}

/// A text a matcher wants: exactly (spaces around either aside), or a
/// regex's match.
#[derive(Debug, Clone)]
pub(crate) enum TextMatch {
    Exact(String),
    Regex(Regex),
}

impl TextMatch {
    fn parse(s: &str, whole: &str) -> Result<Self, String> {
        let Some(rest) = s.strip_prefix('/') else {
            return Ok(Self::Exact(s.trim().to_owned()));
        };
        let Some(end) = rest.rfind('/') else {
            return Ok(Self::Exact(s.trim().to_owned()));
        };
        let (pattern, flags) = (&rest[..end], &rest[end + 1..]);
        let mut inline = String::new();
        for flag in flags.chars() {
            match flag {
                'i' | 'm' | 's' => inline.push(flag),
                'u' | 'g' | 'y' | 'd' => {}
                other => return Err(format!("`{whole}`: not a regex flag: {other}")),
            }
        }
        let pattern = if inline.is_empty() {
            pattern.to_owned()
        } else {
            format!("(?{inline}){pattern}")
        };
        Regex::new(&pattern)
            .map(Self::Regex)
            .map_err(|e| format!("`{whole}`: {e}"))
    }

    pub(crate) fn matches(&self, text: &str) -> bool {
        match self {
            Self::Exact(want) => text.trim() == want,
            Self::Regex(re) => re.is_match(text),
        }
    }
}

impl Selector {
    pub(crate) fn parse(s: &str) -> Result<Self, String> {
        let mut parts: Vec<Part> = Vec::new();
        for piece in s.split(" >> ") {
            let piece = piece.trim();
            if let Some(n) = piece.strip_prefix("nth=") {
                let n = n
                    .parse()
                    .map_err(|e| format!("`{s}`: `{piece}`: not an index: {e}"))?;
                let last = parts
                    .last_mut()
                    .ok_or_else(|| format!("`{s}`: `nth=` follows what it picks from"))?;
                last.nth = Some(n);
                continue;
            }
            parts.push(Part {
                matcher: Matcher::parse(piece, s)?,
                nth: None,
            });
        }
        if parts.is_empty() {
            return Err(format!("`{s}`: an empty selector"));
        }
        Ok(Self {
            parts,
            source: s.to_owned(),
        })
    }

    /// Every part but the last, which names a span inside those views.
    pub(crate) fn scope(&self) -> Option<Selector> {
        if self.parts.len() < 2 {
            return None;
        }
        Some(Selector {
            parts: self.parts[..self.parts.len() - 1].to_vec(),
            source: self.source.clone(),
        })
    }
}

impl Matcher {
    fn parse(s: &str, whole: &str) -> Result<Self, String> {
        Ok(match s.split_once(':') {
            Some(("id", v)) => Self::TestId(v.to_owned()),
            Some(("label", v)) => Self::Label(TextMatch::parse(v, whole)?),
            Some(("text", v)) => Self::Text(TextMatch::parse(v, whole)?),
            Some(("role", v)) => match v.split_once('[') {
                Some((role, name)) => {
                    let name = name
                        .strip_suffix(']')
                        .ok_or_else(|| format!("`{whole}`: `[` without its `]`"))?;
                    Self::Role {
                        role: role.to_owned(),
                        name: Some(TextMatch::parse(name, whole)?),
                    }
                }
                None => Self::Role {
                    role: v.to_owned(),
                    name: None,
                },
            },
            Some(("view", v)) => Self::View(
                v.parse()
                    .map_err(|e| format!("`{whole}`: not a view id: {e}"))?,
            ),
            _ => Self::Any(s.to_owned()),
        })
    }
}

impl std::fmt::Display for Selector {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.source)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn matcher(s: &str) -> Matcher {
        let mut selector = Selector::parse(s).unwrap();
        assert_eq!(selector.parts.len(), 1);
        selector.parts.remove(0).matcher
    }

    #[test]
    fn selectors_parse() {
        assert!(matches!(matcher("id:save"), Matcher::TestId(v) if v == "save"));
        assert!(
            matches!(matcher("label:Close"), Matcher::Label(TextMatch::Exact(v)) if v == "Close")
        );
        assert!(matches!(matcher("text:+1"), Matcher::Text(TextMatch::Exact(v)) if v == "+1"));
        assert!(matches!(matcher("view:20"), Matcher::View(20)));
        assert!(matches!(matcher("a:b"), Matcher::Any(v) if v == "a:b"));
        assert!(matches!(
            matcher("role:button[Save]"),
            Matcher::Role { role, name: Some(TextMatch::Exact(name)) } if role == "button" && name == "Save"
        ));
        assert!(matches!(
            matcher("role:switch"),
            Matcher::Role { name: None, .. }
        ));
        let Matcher::Text(re) = matcher("text:/^buy/i") else {
            panic!("a regex");
        };
        assert!(re.matches("Buy milk") && !re.matches("To buy"));
        let chain = Selector::parse("id:card >> text:Save >> nth=1").unwrap();
        assert_eq!(chain.parts.len(), 2);
        assert_eq!(chain.parts[1].nth, Some(1));
        assert_eq!(chain.to_string(), "id:card >> text:Save >> nth=1");
        assert_eq!(
            Selector::parse("view:x").unwrap_err(),
            "`view:x`: not a view id: invalid digit found in string"
        );
        assert!(Selector::parse("nth=0").unwrap_err().contains("follows"));
        assert!(
            Selector::parse("text:/a/x")
                .unwrap_err()
                .contains("not a regex flag")
        );
    }
}
