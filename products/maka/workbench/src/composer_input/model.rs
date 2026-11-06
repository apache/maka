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

pub(super) fn skill(schema: &Schema, name: &str) -> Node {
    schema
        .node(
            "skill",
            Some([("name".to_owned(), json!(name))].into()),
            Fragment::empty(),
            vec![],
        )
        .expect("a skill node has its required name")
}

pub(super) fn token_ranges(text: &str) -> Vec<Range<usize>> {
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

fn inline(schema: &Schema, text: &str, atoms: bool) -> Vec<Node> {
    let mut out = Vec::new();
    let mut at = 0;
    if atoms {
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
    }
    if at < text.len() {
        out.push(schema.text(&text[at..], vec![]));
    }
    out
}

pub(super) fn document(schema: &Schema, source: &str, atoms: bool) -> Node {
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
                    Fragment::from(inline(schema, text, atoms)),
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
    let doc = document(schema, source, true);
    Slice::new(doc.content().clone(), 1, 1)
}

fn node_source(node: &Node) -> String {
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
struct Span {
    source: Range<usize>,
    doc: Range<usize>,
    atom: bool,
}

/// One action's conversion table. Source offsets remain UTF-16, including
/// the full invocation; an inline atom occupies one document position.
#[derive(Debug)]
pub(super) struct Projection {
    pub source: String,
    spans: Vec<Span>,
    end: usize,
}

impl Projection {
    pub fn new(doc: &Node) -> Self {
        let mut source = String::new();
        let mut spans = Vec::new();
        let mut offset = 0;
        let mut end = 1;
        doc.for_each(&mut |paragraph, block_at, index| {
            paragraph.for_each(&mut |node, inline_at, _| {
                let text = node_source(node);
                let length = text.encode_utf16().count();
                let at = block_at + 1 + inline_at;
                spans.push(Span {
                    source: offset..offset + length,
                    doc: at..at + node.node_size(),
                    atom: !node.is_text(),
                });
                source.push_str(&text);
                offset += length;
            });
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
                    atom: true,
                });
                source.push_str(ending);
                offset += length;
            }
        });
        Self { source, spans, end }
    }

    pub fn source_at(&self, pos: usize) -> u32 {
        for span in &self.spans {
            if pos < span.doc.start {
                return span.source.start as u32;
            }
            if pos <= span.doc.end {
                return if span.atom {
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
        self.source.encode_utf16().count() as u32
    }

    pub fn doc_at(&self, offset: u32, end: bool) -> Option<usize> {
        byte_at(&self.source, offset)?;
        let offset = offset as usize;
        for span in &self.spans {
            if offset < span.source.start {
                return Some(span.doc.start);
            }
            if offset <= span.source.end {
                return Some(if offset == span.source.start {
                    span.doc.start
                } else if offset == span.source.end {
                    span.doc.end
                } else if span.atom {
                    if end { span.doc.end } else { span.doc.start }
                } else {
                    span.doc.start + offset - span.source.start
                });
            }
        }
        Some(self.end)
    }
}

pub(super) fn byte_at(source: &str, offset: u32) -> Option<usize> {
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

pub(super) fn tokenize(state: &EditorState, force: bool) -> Option<Transaction> {
    let projection = Projection::new(state.doc());
    let caret = projection.source_at(state.selection().head()) as usize;
    let anchor = projection.source_at(state.selection().anchor()) as usize;
    let mut replacements = Vec::new();
    for range in token_ranges(&projection.source) {
        let start = projection.source[..range.start].encode_utf16().count();
        let end = projection.source[..range.end].encode_utf16().count();
        let from = projection
            .doc_at(start as u32, false)
            .expect("token starts at a character boundary");
        let to = projection
            .doc_at(end as u32, true)
            .expect("token ends at a character boundary");
        if state.doc().node_at(from).is_some_and(|node| {
            node.ty().name() == "skill"
                && from + node.node_size() == to
                && node_source(&node) == projection.source[range.clone()]
        }) {
            continue;
        }
        if !force && anchor >= start && anchor <= end && caret >= start && caret <= end {
            continue;
        }
        replacements.push((
            from,
            to,
            skill(
                state.schema(),
                &projection.source[range.start + 7..range.end],
            ),
        ));
    }
    if replacements.is_empty() {
        return None;
    }
    let mut tr = state.tr();
    for (start, end, node) in replacements.into_iter().rev() {
        tr.replace_with(start, end, Fragment::from(vec![node]))
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
    let doc = document(state.schema(), &raw, true);
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
        extensions::history::{history, redo, undo},
        state::EditorStateConfig,
    };

    #[test]
    fn source_round_trips_skills_unicode_and_line_endings() {
        let schema = schema();
        let raw = "🦀 /skill:review, /skill:fix\r\n\n尾部\r";
        let doc = document(&schema, raw, true);
        assert_eq!(source(&doc), raw);
        let p = Projection::new(&doc);
        assert_eq!(p.source_at(p.doc_at(4, false).unwrap()), 3);
        assert_eq!(p.source_at(p.doc_at(4, true).unwrap()), 16);
        assert_eq!(p.source_at(p.doc_at(33, true).unwrap()), 33);
        assert!(p.doc_at(1, false).is_none(), "a surrogate cannot be split");
    }

    #[test]
    fn typed_skill_remains_editable_until_the_caret_leaves() {
        let schema = schema();
        let doc = document(&schema, "a /skill:review", false);
        let selection = TextSelection::create(&doc, 16, None);
        let state =
            EditorState::create(EditorStateConfig::new(schema).doc(doc).selection(selection))
                .unwrap();
        assert!(tokenize(&state, false).is_none());
        let mut tr = state.tr();
        tr.set_selection(TextSelection::create(state.doc(), 1, None));
        let state = state.apply(tr).unwrap();
        let state = state.apply(tokenize(&state, false).unwrap()).unwrap();
        assert_eq!(state.doc().child(0).child(1).ty().name(), "skill");
        assert_eq!(source(state.doc()), "a /skill:review");
    }

    #[test]
    fn typing_a_delimiter_confirms_the_skill_without_changing_its_source() {
        let schema = schema();
        let doc = document(&schema, "/skill:review", false);
        let selection = TextSelection::create(&doc, 14, None);
        let state =
            EditorState::create(EditorStateConfig::new(schema).doc(doc).selection(selection))
                .unwrap();
        let mut tr = state.tr();
        tr.insert_text(" ", None, None);
        let state = state.apply(tr).unwrap();
        let state = state.apply(tokenize(&state, false).unwrap()).unwrap();
        assert_eq!(source(state.doc()), "/skill:review ");
        assert_eq!(state.doc().child(0).child(0).ty().name(), "skill");
        assert_eq!(state.doc().child(0).child(1).text(), Some(" "));
    }

    #[test]
    fn explicit_replace_and_atomic_delete_are_separate_undoable_actions() {
        let schema = schema();
        let doc = document(&schema, "🦀 ", true);
        let state = EditorState::create(
            EditorStateConfig::new(schema)
                .doc(doc)
                .plugins(vec![history(Default::default())]),
        )
        .unwrap();
        let state = state
            .apply(replace(&state, 3, 3, "/skill:review ").unwrap())
            .unwrap();
        assert_eq!(source(state.doc()), "🦀 /skill:review ");
        assert_eq!(state.doc().child(0).child(1).ty().name(), "skill");
        let projection = Projection::new(state.doc());
        let caret = projection.doc_at(16, true).unwrap();
        let mut tr = state.tr();
        tr.set_selection(TextSelection::create(state.doc(), caret, None));
        let state = state.apply(tr).unwrap();
        let deleted = state.apply(delete_atom(&state, false).unwrap()).unwrap();
        assert_eq!(source(deleted.doc()), "🦀  ");
        let mut restored = None;
        assert!(undo(
            &deleted,
            Some(&mut |tr| restored = Some(deleted.apply(tr).unwrap()))
        ));
        let restored = restored.unwrap();
        assert_eq!(source(restored.doc()), "🦀 /skill:review ");
        let mut redone = None;
        assert!(redo(
            &restored,
            Some(&mut |tr| redone = Some(restored.apply(tr).unwrap()))
        ));
        assert_eq!(source(redone.unwrap().doc()), "🦀  ");
        let mut initial = None;
        assert!(undo(
            &restored,
            Some(&mut |tr| initial = Some(restored.apply(tr).unwrap()))
        ));
        assert_eq!(source(initial.unwrap().doc()), "🦀 ");
    }

    #[test]
    fn grammar_uses_js_whitespace_and_the_full_surrounding_source() {
        assert_eq!(token_ranges("\u{feff}/skill:one"), vec![3..13]);
        assert!(token_ranges("\u{85}/skill:one").is_empty());
        let schema = schema();
        let doc = document(&schema, "/skill:one", true);
        let state = EditorState::create(EditorStateConfig::new(schema).doc(doc)).unwrap();
        let state = state
            .apply(replace(&state, 10, 10, "/skill:two").unwrap())
            .unwrap();
        assert_eq!(source(state.doc()), "/skill:one/skill:two");
        assert_eq!(state.doc().child(0).child_count(), 2);
        assert_eq!(state.doc().child(0).child(1).text(), Some("/skill:two"));
    }
    #[test]
    fn skill_chips_never_separate_a_unicode_grapheme() {
        let schema = schema();
        let accented = document(&schema, "/skill:e\u{301}", true);
        assert_eq!(accented.child(0).child_count(), 1);
        assert_eq!(accented.child(0).child(0).text(), Some("/skill:e\u{301}"));
        let joined = document(&schema, "/skill:review\u{200d}👩\u{200d}💻", true);
        assert_eq!(joined.child(0).child_count(), 1);
        assert_eq!(source(&joined), "/skill:review\u{200d}👩\u{200d}💻");
        let separate = document(&schema, "/skill:review 👩\u{200d}💻", true);
        assert_eq!(separate.child(0).child(0).ty().name(), "skill");
        assert_eq!(separate.child(0).child(1).text(), Some(" 👩\u{200d}💻"));
    }
}
