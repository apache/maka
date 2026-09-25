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
//! Theme-independent code tokens. Only complete physical lines become checkpoints.
use ratatui::style::{Modifier, Style};
use std::{collections::HashMap, ops::Range, sync::LazyLock};
use syntect::{
    highlighting::ScopeSelectors,
    parsing::{ParseState, ScopeStack, SyntaxSet},
};

const MAX_BODY: usize = 64 * 1024;
const MAX_LINE: usize = 4096;
const MAX_CACHE: usize = 256 * 1024;
const MAX_ENTRIES: usize = 8;
static SYNTAXES: LazyLock<SyntaxSet> = LazyLock::new(SyntaxSet::load_defaults_newlines);

/// Host paths are labels, not permission to inspect the local filesystem.
pub fn language_for_path(path: &str) -> Option<&'static str> {
    let name = path.rsplit(['/', '\\']).next()?;
    let extension = name.rsplit_once('.').map_or(name, |(_, suffix)| suffix);
    SYNTAXES
        .find_syntax_by_extension(extension)
        .map(|syntax| syntax.name.as_str())
}

/// Resolve an untrusted display language to an existing, bounded syntax name.
pub fn language(info: &str) -> Option<&'static str> {
    let token = info.split_whitespace().next()?.to_ascii_lowercase();
    let token = match token.as_str() {
        "sh" | "shell" => "bash",
        "yml" => "yaml",
        value => value,
    };
    SYNTAXES
        .find_syntax_by_name(info)
        .or_else(|| SYNTAXES.find_syntax_by_token(token))
        .map(|syntax| syntax.name.as_str())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Text,
    Keyword,
    String,
    Comment,
    Number,
    Function,
    Type,
    Operator,
}

static RULES: LazyLock<Vec<(ScopeSelectors, Kind)>> = LazyLock::new(|| {
    [
        ("keyword, storage", Kind::Keyword),
        ("string", Kind::String),
        ("comment", Kind::Comment),
        ("constant.numeric, constant.language", Kind::Number),
        ("entity.name.function, support.function", Kind::Function),
        ("entity.name.type, support.type, support.class", Kind::Type),
        ("keyword.operator", Kind::Operator),
    ]
    .into_iter()
    .map(|(scope, kind)| (scope.parse().expect("built-in scope"), kind))
    .collect()
});

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Token {
    pub range: Range<usize>,
    kind: Kind,
}

impl Token {
    pub fn style(&self, colors: crate::theme::Palette) -> Style {
        let index = match self.kind {
            Kind::Text => return Style::default(),
            Kind::Keyword => 0,
            Kind::String => 1,
            Kind::Comment => 2,
            Kind::Number => 3,
            Kind::Function => 4,
            Kind::Type => 5,
            Kind::Operator => 6,
        };
        let style = Style::default().fg(colors.syntax[index]);
        if self.kind == Kind::Comment {
            style.add_modifier(Modifier::ITALIC)
        } else {
            style
        }
    }
}

struct Entry {
    source: String,
    tokens: Vec<Token>,
    parser: ParseState,
    scopes: ScopeStack,
}
impl Entry {
    fn bytes(&self) -> usize {
        self.source.capacity() + self.tokens.capacity() * std::mem::size_of::<Token>()
    }
}

#[derive(Default)]
pub struct Cache {
    entries: HashMap<(usize, String), Entry>,
    pub colors: crate::theme::Palette,
    #[cfg(test)]
    parsed: usize,
}
impl Cache {
    pub fn new(colors: crate::theme::Palette) -> Self {
        Self {
            colors,
            ..Self::default()
        }
    }
    pub fn clear(&mut self) {
        self.entries.clear();
    }
    pub fn bytes(&self) -> usize {
        self.entries.values().map(Entry::bytes).sum()
    }

    pub(super) fn highlight(&mut self, start: usize, info: &str, body: &str) -> Option<Vec<Token>> {
        // A skipped physical line can change the grammar state of every following line.
        // Fall back for the whole block, never resume from an invented parser state.
        if body.len() > MAX_BODY || body.split_inclusive('\n').any(|line| line.len() > MAX_LINE) {
            self.entries.retain(|(at, _), _| *at != start);
            return None;
        }
        let language = info.split_whitespace().next()?.to_ascii_lowercase();
        let language = match language.as_str() {
            "sh" | "shell" => "bash",
            "yml" => "yaml",
            token => token,
        };
        let syntax = SYNTAXES
            .find_syntax_by_name(info)
            .or_else(|| SYNTAXES.find_syntax_by_token(language))?;
        let key = (start, syntax.name.clone());
        let mut entry = self
            .entries
            .remove(&key)
            .filter(|entry| body.starts_with(&entry.source))
            .unwrap_or_else(|| Entry {
                source: String::new(),
                tokens: vec![],
                parser: ParseState::new(syntax),
                scopes: ScopeStack::new(),
            });
        let result = self.extend(&mut entry, body);
        // Fixed entry/body/token budgets; source ranges in cached tokens are body-relative.
        // Syntax state is bounded by the same input limits and is never persisted to disk.
        if result.is_some() {
            let bytes = entry.bytes();
            if self.entries.len() >= MAX_ENTRIES
                || self.entries.values().map(Entry::bytes).sum::<usize>() + bytes > MAX_CACHE
            {
                self.clear();
            }
            if bytes <= MAX_CACHE {
                self.entries.insert(key, entry);
            }
        }
        result
    }

    fn extend(&mut self, entry: &mut Entry, body: &str) -> Option<Vec<Token>> {
        let committed = body.rfind('\n').map_or(0, |at| at + 1);
        let mut offset = entry.source.len();
        for line in body[offset..committed].split_inclusive('\n') {
            #[cfg(test)]
            {
                self.parsed += line.len();
            }
            tokenize(
                &mut entry.parser,
                &mut entry.scopes,
                line,
                offset,
                &mut entry.tokens,
            )?;
            entry.source.push_str(line);
            offset += line.len();
        }
        let mut tokens = entry.tokens.clone();
        if committed < body.len() {
            #[cfg(test)]
            {
                self.parsed += body.len() - committed;
            }
            // An unfinished string/comment can be reinterpreted on the next append.
            tokenize(
                &mut entry.parser.clone(),
                &mut entry.scopes.clone(),
                &body[committed..],
                committed,
                &mut tokens,
            )?;
        }
        Some(tokens)
    }
}

fn kind(scopes: &ScopeStack) -> Kind {
    RULES
        .iter()
        .filter_map(|(selector, kind)| {
            selector
                .does_match(scopes.as_slice())
                .map(|power| (power, *kind))
        })
        .max_by(|a, b| a.0.cmp(&b.0))
        .map_or(Kind::Text, |(_, kind)| kind)
}
fn tokenize(
    parser: &mut ParseState,
    scopes: &mut ScopeStack,
    line: &str,
    offset: usize,
    tokens: &mut Vec<Token>,
) -> Option<()> {
    let ops = parser.parse_line(line, &SYNTAXES).ok()?;
    let mut previous = 0;
    for (at, op) in ops {
        push(tokens, offset + previous..offset + at, kind(scopes));
        scopes.apply(&op).ok()?;
        previous = at;
    }
    push(tokens, offset + previous..offset + line.len(), kind(scopes));
    Some(())
}
fn push(tokens: &mut Vec<Token>, range: Range<usize>, kind: Kind) {
    if range.is_empty() {
        return;
    }
    if let Some(last) = tokens
        .last_mut()
        .filter(|last| last.kind == kind && last.range.end == range.start)
    {
        last.range.end = range.end;
    } else {
        tokens.push(Token { range, kind });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn incremental_tokens_match_batch_across_multiline_edits_languages_and_limits() {
        let source = "/* 中文\n * comment */\nfn main() {\n  let s = \"hello\";\n  println!(\"{}\", 42);\n}\n";
        let mut cache = Cache::default();
        for end in source
            .char_indices()
            .map(|(at, _)| at)
            .chain([source.len()])
        {
            let text = &source[..end];
            assert_eq!(
                cache.highlight(0, "rust", text),
                Cache::default().highlight(0, "rust", text),
                "prefix {text:?}"
            );
        }
        let tokens = cache.highlight(0, "rust", source).unwrap();
        for (text, expected) in [
            ("fn", Kind::Keyword),
            ("main", Kind::Function),
            ("hello", Kind::String),
            ("comment", Kind::Comment),
            ("42", Kind::Number),
        ] {
            let at = source.find(text).unwrap();
            assert_eq!(
                tokens
                    .iter()
                    .find(|token| token.range.contains(&at))
                    .unwrap()
                    .kind,
                expected
            );
        }
        let changed = "fn changed() {}\n";
        assert_eq!(
            cache.highlight(0, "rust ignore", changed),
            Cache::default().highlight(0, "rust", changed)
        );
        assert!(cache.highlight(0, "no-such-language", source).is_none());
        assert!(
            cache
                .highlight(0, "rust", &"x".repeat(MAX_LINE + 1))
                .is_none()
        );
        assert!(
            cache
                .highlight(0, "rust", &"x\n".repeat(MAX_BODY))
                .is_none()
        );
        for start in 0..32 {
            cache.highlight(start, "rust", source);
        }
        assert!(cache.entries.len() <= MAX_ENTRIES);
        assert!(cache.entries.values().map(Entry::bytes).sum::<usize>() <= MAX_CACHE);

        let mut cache = Cache::default();
        let mut body = String::new();
        for _ in 0..100 {
            body.push_str("let value = 42;\n");
            cache.highlight(0, "rust", &body).unwrap();
        }
        assert_eq!(cache.parsed, body.len(), "complete lines are lexed once");
    }
}
