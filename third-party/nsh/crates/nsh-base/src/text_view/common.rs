//! What the Markdown and HTML parsers share: declared patterns applied to
//! inline content, and headings' anchors.

use std::{cell::RefCell, collections::HashMap};

use regex::Regex;

use super::{
    MarkdownExtension,
    document::{CustomNode, Inline},
};

thread_local! {
    /// Compiled patterns by source: a document is read block by block, and
    /// the same extensions come back for every block and every document,
    /// so each pattern compiles once (an invalid one warns once).
    static PATTERNS: RefCell<HashMap<String, Option<Regex>>> = RefCell::new(HashMap::new());
}

/// Patterns this cache holds at most, so apps that make patterns on the
/// fly cannot grow it without bound.
const MAX_PATTERNS: usize = 256;

/// `inlines` with the matches of the `pattern` extensions among
/// `extensions` turned into custom nodes named by the extension (the match
/// their text, the groups their attributes: `"1"`, `"2"`, ... and by
/// name). Text inside code, links, keys, formulas and custom nodes is left
/// alone.
pub(crate) fn apply_patterns(
    extensions: &[MarkdownExtension],
    inlines: Vec<Inline>,
) -> Vec<Inline> {
    let patterns: Vec<(&str, Regex)> = extensions
        .iter()
        .filter_map(|ext| Some((ext.name.as_ref(), compile(ext.pattern.as_deref()?)?)))
        .collect();
    if patterns.is_empty() {
        return inlines;
    }
    apply(&patterns, inlines)
}

fn compile(pattern: &str) -> Option<Regex> {
    PATTERNS.with(|cache| {
        let mut cache = cache.borrow_mut();
        if let Some(regex) = cache.get(pattern) {
            return regex.clone();
        }
        let regex = match Regex::new(pattern) {
            Ok(regex) => Some(regex),
            Err(err) => {
                log::warn!("TextView: invalid pattern {pattern:?}: {err}");
                None
            }
        };
        if cache.len() >= MAX_PATTERNS {
            cache.clear();
        }
        cache.insert(pattern.to_owned(), regex.clone());
        regex
    })
}

fn apply(patterns: &[(&str, Regex)], inlines: Vec<Inline>) -> Vec<Inline> {
    let mut out = Vec::with_capacity(inlines.len());
    for inline in inlines {
        match inline {
            Inline::Text { text } => split(patterns, text, &mut out),
            Inline::Source { content, segments } => out.push(Inline::Source {
                content: apply(patterns, content),
                segments,
            }),
            Inline::Strong { content } => out.push(Inline::Strong {
                content: apply(patterns, content),
            }),
            Inline::Emphasis { content } => out.push(Inline::Emphasis {
                content: apply(patterns, content),
            }),
            Inline::Strikethrough { content } => out.push(Inline::Strikethrough {
                content: apply(patterns, content),
            }),
            Inline::Underline { content } => out.push(Inline::Underline {
                content: apply(patterns, content),
            }),
            Inline::Highlight { content, color } => out.push(Inline::Highlight {
                content: apply(patterns, content),
                color,
            }),
            Inline::Superscript { content } => out.push(Inline::Superscript {
                content: apply(patterns, content),
            }),
            Inline::Subscript { content } => out.push(Inline::Subscript {
                content: apply(patterns, content),
            }),
            Inline::Small { content } => out.push(Inline::Small {
                content: apply(patterns, content),
            }),
            other => out.push(other),
        }
    }
    out
}

/// Text `text` split at the patterns' matches into `out`: at each point the
/// earliest match wins, the first declared on a tie.
fn split(patterns: &[(&str, Regex)], text: String, out: &mut Vec<Inline>) {
    // The next match of each pattern at or after `pos`, kept between
    // rounds so a pattern is searched again only once passed: one scan of
    // the text per pattern, however many matches.
    let mut next: Vec<Option<(usize, usize)>> = vec![None; patterns.len()];
    let mut searched = vec![false; patterns.len()];
    let mut pos = 0;
    let mut start = 0;
    while pos <= text.len() {
        let mut best: Option<(usize, usize, usize)> = None;
        for (i, (_, regex)) in patterns.iter().enumerate() {
            let stale = match next[i] {
                Some((s, _)) => s < pos,
                None => !searched[i],
            };
            if stale {
                next[i] = find_non_empty(regex, &text, pos);
                searched[i] = true;
            }
            if let Some((s, e)) = next[i]
                && best.is_none_or(|(bs, _, _)| s < bs)
            {
                best = Some((s, e, i));
            }
        }
        let Some((s, e, i)) = best else { break };
        if s > start {
            out.push(Inline::text(&text[start..s]));
        }
        out.push(Inline::Custom(node(
            patterns[i].0,
            &patterns[i].1,
            &text,
            s,
        )));
        start = e;
        pos = e;
    }
    if start == 0 {
        out.push(Inline::Text { text });
    } else if start < text.len() {
        out.push(Inline::text(&text[start..]));
    }
}

/// The first non-empty match of `regex` in `text` at or after `pos`.
fn find_non_empty(regex: &Regex, text: &str, mut pos: usize) -> Option<(usize, usize)> {
    while pos <= text.len() {
        let m = regex.find_at(text, pos)?;
        if !m.is_empty() {
            return Some((m.start(), m.end()));
        }
        // An empty match matches nothing to show: look past it.
        pos = m.end() + text[m.end()..].chars().next().map_or(1, char::len_utf8);
    }
    None
}

fn node(name: &str, regex: &Regex, text: &str, at: usize) -> CustomNode {
    let mut node = CustomNode::new(name);
    let Some(caps) = regex.captures_at(text, at) else {
        return node;
    };
    node.text = caps[0].to_owned();
    let names: Vec<Option<&str>> = regex.capture_names().collect();
    for (i, group) in caps.iter().enumerate().skip(1) {
        let Some(group) = group else { continue };
        node.attributes
            .insert(i.to_string(), group.as_str().to_owned());
        if let Some(Some(name)) = names.get(i) {
            node.attributes
                .insert((*name).to_owned(), group.as_str().to_owned());
        }
    }
    node
}

/// GitHub's anchor of a heading of text `text`: lower case, punctuation
/// removed, spaces as hyphens (`"Getting started!"` → `getting-started`).
pub(crate) fn slug(text: &str) -> String {
    text.trim()
        .chars()
        .filter_map(|c| {
            if c == ' ' {
                Some('-')
            } else if c.is_alphanumeric() || c == '-' || c == '_' {
                Some(c)
            } else {
                None
            }
        })
        .flat_map(char::to_lowercase)
        .collect()
}

/// Anchors of the headings of one document, made unique as GitHub makes
/// them: the second `intro` is `intro-1`, the third `intro-2`.
#[derive(Default)]
pub(crate) struct Slugger {
    seen: HashMap<String, u32>,
}

impl Slugger {
    /// The anchor of the next heading of text `text`.
    pub(crate) fn slug(&mut self, text: &str) -> String {
        let base = slug(text);
        let mut candidate = base.clone();
        // As github-slugger: the base's count goes up until a free name.
        while self.seen.contains_key(&candidate) {
            let count = self.seen.entry(base.clone()).or_insert(0);
            *count += 1;
            candidate = format!("{base}-{count}");
        }
        self.seen.insert(candidate.clone(), 0);
        candidate
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn custom(name: &str, text: &str, attrs: &[(&str, &str)]) -> Inline {
        let mut node = CustomNode::new(name).with_text(text);
        for (k, v) in attrs {
            node = node.with_attribute(*k, *v);
        }
        Inline::Custom(node)
    }

    #[test]
    fn patterns_split_text() {
        let exts = [
            MarkdownExtension::pattern("mention", r"@(\w+)"),
            MarkdownExtension::pattern("tag", r"#(?<tag>\w+)"),
        ];
        let out = apply_patterns(
            &exts,
            vec![
                Inline::text("hi @ann and #rust!"),
                Inline::Code { code: "@no".into() },
                Inline::Strong {
                    content: vec![Inline::text("@bo")],
                },
            ],
        );
        assert_eq!(
            out,
            vec![
                Inline::text("hi "),
                custom("mention", "@ann", &[("1", "ann")]),
                Inline::text(" and "),
                custom("tag", "#rust", &[("1", "rust"), ("tag", "rust")]),
                Inline::text("!"),
                Inline::Code { code: "@no".into() },
                Inline::Strong {
                    content: vec![custom("mention", "@bo", &[("1", "bo")])]
                },
            ]
        );
    }

    #[test]
    fn invalid_and_empty_patterns_are_skipped() {
        let exts = [
            MarkdownExtension::pattern("bad", r"("),
            MarkdownExtension::pattern("empty", r"x*"),
        ];
        let out = apply_patterns(&exts, vec![Inline::text("axxb")]);
        assert_eq!(
            out,
            vec![
                Inline::text("a"),
                custom("empty", "xx", &[]),
                Inline::text("b")
            ]
        );
    }

    #[test]
    fn slugs() {
        assert_eq!(slug("Getting started!"), "getting-started");
        assert_eq!(slug("API: `fetch()` & more"), "api-fetch--more");
        assert_eq!(slug("中文 标题"), "中文-标题");
        let mut s = Slugger::default();
        assert_eq!(s.slug("Intro"), "intro");
        assert_eq!(s.slug("Intro"), "intro-1");
        assert_eq!(s.slug("Intro"), "intro-2");
        assert_eq!(s.slug("Intro 1"), "intro-1-1");
    }
}
