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

use std::{ops::Range, sync::LazyLock};

use nsh_core::input_tokens::{InputTokenRule, InputTokens};

use nsh_base::rich_editor::{
    model::{Fragment, Node, Schema, SchemaSpec, Slice},
    state::{EditorState, TextSelection, Transaction},
};
use serde_json::{Value, json};

pub(super) fn schema() -> Schema {
    SchemaSpec::from_json(&json!({
        "nodes": [
            ["doc", {"content":"paragraph+", "attrs":{"sourceId":{"default":null},"sourceOffset":{"default":0}}}],
            ["paragraph", {"content":"inline*", "group":"block", "attrs":{
                "ending":{"default":"\n"}
            }}],
            ["skill", {"inline":true, "group":"inline", "atom":true,
                "attrs":{"name":{"validate":"string"},"sourceId":{"default":null},"sourceOffset":{"default":0}}, "renderText":"/skill:{name}"}],
            ["text", {"group":"inline"}]
        ],
        "marks":[["source", {"attrs":{"id":{"validate":"string"},"offset":{"validate":"number"}}}]]
    }))
    .expect("the composer schema is valid")
}

fn skill(schema: &Schema, name: &str) -> Node {
    schema
        .node(
            "skill",
            Some([("name".to_owned(), json!(name))].into()),
            Fragment::empty(),
            vec![],
        )
        .expect("a skill node has its required name")
}

fn token_ranges(text: &str) -> Vec<Range<usize>> {
    static RULE: LazyLock<InputTokenRule> = LazyLock::new(|| {
        InputTokenRule::new(
            r"(?:^|[\t-\r \u{00a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}])(?P<token>/skill:[A-Za-z0-9._-]+)",
            Default::default(),
            true,
        ).expect("the skill invocation token pattern is valid")
    });
    let mut tokens = InputTokens::default();
    tokens.set_rules(std::slice::from_ref(&RULE), text);
    tokens
        .spans()
        .iter()
        .map(|span| span.range.clone())
        .collect()
}

fn inline(schema: &Schema, text: &str) -> Vec<Node> {
    let mut out = Vec::new();
    let mut at = 0;
    for range in token_ranges(text) {
        if at < range.start {
            out.push(schema.text(&text[at..range.start], vec![]));
        }
        out.push(skill(
            schema,
            &text[range.start + "/skill:".len()..range.end],
        ));
        at = range.end;
    }
    if at < text.len() {
        out.push(schema.text(&text[at..], vec![]));
    }
    out
}

pub(super) fn document(schema: &Schema, source: &str) -> Node {
    let mut paragraphs = Vec::new();
    let mut rest = source;
    loop {
        let split = rest.find(['\r', '\n']);
        let (text, ending, remaining) = match split {
            Some(at) => {
                let width = if rest[at..].starts_with("\r\n") { 2 } else { 1 };
                (
                    &rest[..at],
                    &rest[at..at + width],
                    Some(&rest[at + width..]),
                )
            }
            None => (rest, "\n", None),
        };
        paragraphs.push(
            schema
                .node(
                    "paragraph",
                    Some([("ending".to_owned(), json!(ending))].into()),
                    Fragment::from(inline(schema, text)),
                    vec![],
                )
                .expect("composer paragraphs contain only inline nodes"),
        );
        match remaining {
            Some(next) => rest = next,
            None => break,
        }
    }
    schema
        .node("doc", None, Fragment::from(paragraphs), vec![])
        .expect("a composer document contains at least one paragraph")
}

pub(super) fn slice(schema: &Schema, source: &str) -> Slice {
    let doc = document(schema, source);
    Slice::new(doc.content().clone(), 1, 1)
}

pub(super) fn node_source(node: &Node) -> String {
    if let Some(text) = node.text() {
        text.to_owned()
    } else if node.ty().name() == "skill" {
        format!(
            "/skill:{}",
            node.attrs()["name"].as_str().expect("a skill name is text")
        )
    } else {
        node.content().iter().map(node_source).collect()
    }
}

pub(super) fn fragment_source(fragment: &Fragment) -> String {
    let mut source = String::new();
    for (i, node) in fragment.iter().enumerate() {
        source.push_str(&node_source(node));
        if node.ty().name() == "paragraph" && i + 1 < fragment.child_count() {
            source.push_str(
                node.attrs()
                    .get("ending")
                    .and_then(Value::as_str)
                    .unwrap_or("\n"),
            );
        }
    }
    source
}

pub(super) fn source(doc: &Node) -> String {
    fragment_source(doc.content())
}

#[derive(Debug)]
struct Span<'doc> {
    source: Range<usize>,
    doc: Range<usize>,
    node: Option<&'doc Node>,
}

/// One action's conversion table. Source offsets remain UTF-16, including
/// the full invocation; an inline atom occupies one document position.
#[derive(Debug)]
pub(super) struct Projection<'doc> {
    pub source: String,
    spans: Vec<Span<'doc>>,
    end: usize,
}

impl<'doc> Projection<'doc> {
    pub fn new(doc: &'doc Node) -> Self {
        let mut source = String::new();
        let mut spans = Vec::new();
        let mut offset = 0;
        let mut end = 1;
        let mut block_at = 0;
        for (index, paragraph) in doc.content().iter().enumerate() {
            let mut inline_at = 0;
            for node in paragraph.content() {
                let text = node_source(node);
                let length = text.encode_utf16().count();
                let at = block_at + 1 + inline_at;
                spans.push(Span {
                    source: offset..offset + length,
                    doc: at..at + node.node_size(),
                    node: Some(node),
                });
                source.push_str(&text);
                offset += length;
                inline_at += node.node_size();
            }
            end = block_at + 1 + paragraph.content().size();
            if index + 1 < doc.child_count() {
                let ending = paragraph
                    .attrs()
                    .get("ending")
                    .and_then(Value::as_str)
                    .unwrap_or("\n");
                let length = ending.encode_utf16().count();
                spans.push(Span {
                    source: offset..offset + length,
                    doc: end..end + 2,
                    node: None,
                });
                source.push_str(ending);
                offset += length;
            }
            block_at += paragraph.node_size();
        }
        Self { source, spans, end }
    }

    pub fn source_at(&self, pos: usize) -> u32 {
        if let Some(span) = self
            .spans
            .get(self.spans.partition_point(|span| span.doc.end < pos))
        {
            if pos < span.doc.start {
                return span.source.start as u32;
            }
            if pos <= span.doc.end {
                return if span.node.is_none_or(|node| !node.is_text()) {
                    if pos == span.doc.start {
                        span.source.start
                    } else {
                        span.source.end
                    }
                } else {
                    span.source.start + pos - span.doc.start
                } as u32;
            }
        }
        self.spans.last().map_or(0, |span| span.source.end) as u32
    }

    pub fn doc_at(&self, offset: u32, end: bool) -> Option<usize> {
        let offset = offset as usize;
        if offset > self.spans.last().map_or(0, |span| span.source.end) {
            return None;
        }
        if let Some(span) = self
            .spans
            .get(self.spans.partition_point(|span| span.source.end < offset))
        {
            if offset < span.source.start {
                return Some(span.doc.start);
            }
            if offset <= span.source.end {
                return Some(if offset == span.source.start {
                    span.doc.start
                } else if offset == span.source.end {
                    span.doc.end
                } else if span.node.is_none_or(|node| !node.is_text()) {
                    if end { span.doc.end } else { span.doc.start }
                } else {
                    span.doc.start + offset - span.source.start
                });
            }
        }
        Some(self.end)
    }
}

fn byte_at(source: &str, offset: u32) -> Option<usize> {
    let mut units = 0;
    for (at, ch) in source.char_indices() {
        if units == offset {
            return Some(at);
        }
        units += ch.len_utf16() as u32;
        if units > offset {
            return None;
        }
    }
    (units == offset).then_some(source.len())
}

pub(super) fn tokenize(state: &EditorState) -> Option<Transaction> {
    let projection = Projection::new(state.doc());
    let mut byte = 0;
    let mut offset = 0;
    let tokens: Vec<_> = token_ranges(&projection.source)
        .into_iter()
        .map(|range| {
            offset += projection.source[byte..range.start].encode_utf16().count() as u32;
            let from = projection
                .doc_at(offset, false)
                .expect("a token starts at a character boundary");
            offset += projection.source[range.clone()].encode_utf16().count() as u32;
            let to = projection
                .doc_at(offset, true)
                .expect("a token ends at a character boundary");
            byte = range.end;
            (from..to, &projection.source[range])
        })
        .collect();
    let mut replacements = Vec::new();
    for span in &projection.spans {
        let Some(node) = span.node.filter(|node| node.ty().name() == "skill") else {
            continue;
        };
        let next = tokens.partition_point(|(range, _)| range.end <= span.doc.start);
        if tokens
            .get(next)
            .is_none_or(|(range, _)| range.start >= span.doc.end)
        {
            replacements.push((
                span.doc.clone(),
                state.schema().text(&node_source(node), vec![]),
            ));
        }
    }
    for (range, raw) in tokens {
        let existing = projection
            .spans
            .partition_point(|span| span.doc.end <= range.start);
        if projection.spans.get(existing).is_some_and(|span| {
            span.doc == range && span.node.is_some_and(|node| node.ty().name() == "skill")
        }) {
            continue;
        }
        if state.selection().from() >= range.start && state.selection().to() <= range.end {
            continue;
        }
        replacements.push((range, skill(state.schema(), &raw[7..])));
    }
    if replacements.is_empty() {
        return None;
    }
    replacements.sort_unstable_by_key(|(range, _)| range.start);
    let mut tr = state.tr();
    for (range, node) in replacements.into_iter().rev() {
        tr.replace_with(range.start, range.end, Fragment::from(vec![node]))
            .expect("a token replaces its source range");
    }
    Some(tr)
}

pub(super) fn replace(
    state: &EditorState,
    start: u32,
    end: u32,
    text: &str,
) -> Option<Transaction> {
    if start > end {
        return None;
    }
    let projection = Projection::new(state.doc());
    byte_at(&projection.source, start)?;
    byte_at(&projection.source, end)?;
    let from = projection.doc_at(start, false)?;
    let to = projection.doc_at(end, true)?;
    let start = projection.source_at(from);
    let end = projection.source_at(to);
    let first = byte_at(&projection.source, start)?;
    let last = byte_at(&projection.source, end)?;
    let mut raw = String::with_capacity(projection.source.len() + text.len());
    raw.push_str(&projection.source[..first]);
    raw.push_str(text);
    raw.push_str(&projection.source[last..]);
    let doc = document(state.schema(), &raw);
    let next = Projection::new(&doc);
    let caret = next.doc_at(start + text.encode_utf16().count() as u32, true)?;
    let mut tr = state.tr();
    tr.replace_with(0, state.doc().content().size(), doc.content().clone())
        .ok()?;
    let selected = TextSelection::create(tr.doc(), caret, None);
    tr.set_selection(selected);
    nsh_base::rich_editor::extensions::history::close_history(&mut tr);
    Some(tr)
}

pub(super) fn delete_atom(state: &EditorState, forward: bool) -> Option<Transaction> {
    if !state.selection().empty() {
        return None;
    }
    let caret = state.selection().head();
    let at = if forward {
        caret
    } else {
        caret.checked_sub(1)?
    };
    let node = state.doc().node_at(at)?;
    if node.ty().name() != "skill" {
        return None;
    }
    let mut tr = state.tr();
    tr.delete(at, at + node.node_size()).ok()?;
    nsh_base::rich_editor::extensions::history::close_history(&mut tr);
    Some(tr)
}

#[cfg(test)]
mod tests {
    use super::*;
    use nsh_base::rich_editor::{
        extensions::history::{history, undo},
        state::EditorStateConfig,
    };

    #[test]
    fn replacement_preserves_source_boundaries_and_undo() {
        let schema = schema();
        let doc = document(&schema, "前😀 后");
        let state = EditorState::create(
            EditorStateConfig::new(schema)
                .doc(doc)
                .plugins(vec![history(Default::default())]),
        )
        .unwrap();
        assert!(replace(&state, 2, 2, "x").is_none());
        let state = state
            .apply(replace(&state, 4, 4, "/skill:review\r\n下一行").unwrap())
            .unwrap();
        assert_eq!(source(state.doc()), "前😀 /skill:review\r\n下一行后");
        let mut restored = None;
        assert!(undo(
            &state,
            Some(&mut |tr| restored = Some(state.apply(tr).unwrap()))
        ));
        assert_eq!(source(restored.unwrap().doc()), "前😀 后");
    }

    #[test]
    fn deleting_a_skill_boundary_makes_its_text_editable_again() {
        let schema = schema();
        let state = EditorState::create(
            EditorStateConfig::new(schema.clone()).doc(document(&schema, "a /skill:review")),
        )
        .unwrap();
        let mut tr = state.tr();
        tr.delete(2, 3).unwrap();
        let mut state = state.apply(tr).unwrap();
        if let Some(tr) = tokenize(&state) {
            state = state.apply(tr).unwrap();
        }
        let state = state.apply(replace(&state, 3, 4, "X").unwrap()).unwrap();
        assert_eq!(source(state.doc()), "a/sXill:review");
    }
}
