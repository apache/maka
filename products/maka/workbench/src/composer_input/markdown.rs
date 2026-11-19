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

//! Draw a Markdown document over the composer’s existing source coordinates.

use std::{collections::HashMap, ops::Range, sync::Arc};

use nsh_base::{
    rich_editor::{
        model::Node,
        state::{
            ClickEvent, Decoration, DecorationSet, EditorState, EditorStateConfig, PluginSpec,
            PluginState, Transaction,
        },
    },
    text_view::{MarkdownOptions, Parser, mdast},
};
use nsh_core::{Color, prelude::Prop};
use serde_json::Value;

use super::model::Projection;

pub(super) struct Formatting {
    read_only: Prop<bool>,
    link_color: Prop<Color>,
    file_focused: Option<nsh_core::prelude::ReadSignal<bool>>,
}

impl Formatting {
    pub fn new(read_only: Prop<bool>, link_color: Prop<Color>) -> Self {
        Self {
            read_only,
            link_color,
            file_focused: None,
        }
    }

    pub fn file(link_color: Prop<Color>, focused: nsh_core::prelude::ReadSignal<bool>) -> Self {
        Self {
            read_only: false.into(),
            link_color,
            file_focused: Some(focused),
        }
    }

    fn presentation(&self, state: &EditorState) -> Option<Arc<Presentation>> {
        state.plugin_state(&self.key())?.downcast().ok()
    }
}

impl PluginSpec for Formatting {
    fn init_state(&self, _: &EditorStateConfig, state: &EditorState) -> Option<PluginState> {
        Some(Arc::new(Presentation::new(state.doc())))
    }

    fn apply_state(
        &self,
        tr: &Transaction,
        value: &PluginState,
        _: &EditorState,
        new: &EditorState,
    ) -> PluginState {
        if tr.doc_changed() {
            Arc::new(Presentation::new(new.doc()))
        } else {
            value.clone()
        }
    }

    fn decorations(&self, state: &EditorState) -> Option<DecorationSet> {
        let presentation = self.presentation(state)?;
        let cursor = (!self.read_only.get_untracked()
            && self.file_focused.is_none_or(|focus| focus.get_untracked()))
        .then(|| state.selection().head());
        let mut decorations = presentation.decorations(cursor, self.link_color.get_untracked());
        if let Some(focused) = self.file_focused {
            let active = focused.get_untracked().then_some(state.selection().head());
            for (span, code) in &presentation.diagrams {
                if active.is_some_and(|pos| span.contains(&pos) || pos == span.end) {
                    continue;
                }
                let doc = state.doc();
                let first = doc.resolve(span.start).ok()?;
                let last = doc.resolve(span.end).ok()?;
                let mut at = first.before(1);
                for index in first.index(0)..=last.index(0) {
                    let end = at + doc.child(index).node_size();
                    let deco = if index == first.index(0) {
                        Decoration::node(at, end, Default::default())
                            .with_spec([("diagram".into(), Value::from(code.clone()))].into())
                    } else {
                        Decoration::node(at, end, [("class".into(), Value::from("hidden"))].into())
                    };
                    decorations.push(deco);
                    at = end;
                }
            }
        }
        (!decorations.is_empty()).then(|| DecorationSet::create(state.doc(), decorations))
    }

    fn handle_click(
        &self,
        state: &EditorState,
        pos: usize,
        event: &ClickEvent,
        _: &mut dyn FnMut(Transaction),
    ) -> bool {
        if event.button != 0 || (!event.mod_key && !event.read_only) {
            return false;
        }
        let Some(presentation) = self.presentation(state) else {
            return false;
        };
        let Some(link) = presentation.links.iter().find_map(|link| {
            link.text
                .contains(&pos)
                .then_some(link.url.as_ref())
                .flatten()
        }) else {
            return false;
        };
        drop(nsh_core::element::open_url(link.clone()));
        true
    }
}

#[derive(Default)]
struct Presentation {
    styles: Vec<Decoration>,
    syntax: Vec<(Range<usize>, Decoration)>,
    links: Vec<Link>,
    diagrams: Vec<(Range<usize>, String)>,
}

struct Link {
    text: Range<usize>,
    url: Option<String>,
}

impl Presentation {
    fn new(doc: &Node) -> Self {
        let source = Projection::new(doc);
        let tree = Parser::new()
            .options(MarkdownOptions {
                math: false,
                ..MarkdownOptions::default()
            })
            .markdown_syntax(&source.source);
        let mut utf16 = 0;
        let offsets = source
            .source
            .char_indices()
            .map(|(byte, character)| {
                let entry = (byte, utf16);
                utf16 += character.len_utf16() as u32;
                entry
            })
            .collect::<Vec<_>>();
        let mut reader = Reader {
            source: &source,
            offsets,
            end: utf16,
            destinations: HashMap::new(),
            result: Self::default(),
        };
        reader.collect_destinations(&tree);
        reader.visit(&tree);
        reader.result
    }

    fn decorations(&self, cursor: Option<usize>, link_color: Color) -> Vec<Decoration> {
        let mut result = self.styles.clone();
        let link_class = format!("underline text-[#{:08x}]", link_color.0);
        result.extend(self.links.iter().map(|link| {
            Decoration::inline(
                link.text.start,
                link.text.end,
                [("class".into(), Value::from(link_class.as_str()))].into(),
            )
        }));
        result.extend(
            self.syntax
                .iter()
                .filter(|(owner, _)| cursor.is_none_or(|pos| !owner.contains(&pos)))
                .map(|(_, decoration)| decoration.clone()),
        );
        result
    }
}

struct Reader<'a, 'doc, 'tree> {
    source: &'a Projection<'doc>,
    offsets: Vec<(usize, u32)>,
    end: u32,
    destinations: HashMap<&'tree str, &'tree str>,
    result: Presentation,
}

impl<'tree> Reader<'_, '_, 'tree> {
    fn collect_destinations(&mut self, node: &'tree mdast::Node) {
        if let mdast::Node::Definition(definition) = node {
            self.destinations
                .entry(&definition.identifier)
                .or_insert(&definition.url);
        }
        if let Some(children) = node.children() {
            for child in children {
                self.collect_destinations(child);
            }
        }
    }

    fn span(&self, range: Range<usize>) -> Option<Range<usize>> {
        let pos = |byte: usize, end: bool| {
            let coordinate = if byte == self.source.source.len() {
                self.end
            } else {
                self.offsets[self
                    .offsets
                    .binary_search_by_key(&byte, |&(at, _)| at)
                    .ok()?]
                .1
            };
            self.source.doc_at(coordinate, end)
        };
        let start = pos(range.start, false)?;
        let end = pos(range.end, true)?;
        (start < end).then_some(start..end)
    }

    fn style(&mut self, range: Range<usize>, class: &str) {
        if let Some(span) = self.span(range) {
            self.result.styles.push(Decoration::inline(
                span.start,
                span.end,
                [("class".to_owned(), Value::from(class))].into(),
            ));
        }
    }

    fn conceal(&mut self, owner: Range<usize>, syntax: Range<usize>) {
        if syntax.is_empty() {
            return;
        }
        if let (Some(owner), Some(syntax)) = (self.span(owner), self.span(syntax)) {
            self.result
                .syntax
                .push((owner, Decoration::conceal(syntax.start, syntax.end)));
        }
    }

    fn list_marker(&mut self, start: usize) {
        let source = self.source.source.as_bytes();
        if matches!(source[start], b'-' | b'+' | b'*')
            && matches!(source.get(start + 1), Some(b' ' | b'\t'))
            && let Some(marker) = self.span(start..start + 1)
        {
            let bullet = Decoration::replace_char(marker.start, '•');
            self.result
                .syntax
                .push((marker.start..marker.end + 1, bullet));
        }
    }

    fn format(&mut self, owner: Range<usize>, inner: Range<usize>, class: &str) {
        self.style(inner.clone(), class);
        self.conceal(owner.clone(), owner.start..inner.start);
        self.conceal(owner.clone(), inner.end..owner.end);
    }

    fn link(&mut self, owner: Range<usize>, text: Range<usize>, destination: &str) {
        // Session references already draw and navigate as native composer tokens.
        if destination.starts_with("maka://session/")
            && self.source.source[text.clone()].starts_with(['@', '#'])
        {
            return;
        }
        let url = url::Url::parse(destination)
            .ok()
            .filter(|url| matches!(url.scheme(), "http" | "https") && url.has_host())
            .map(Into::into);
        if let Some(span) = self.span(text.clone()) {
            self.conceal(owner.clone(), owner.start..text.start);
            self.conceal(owner.clone(), text.end..owner.end);
            self.result.links.push(Link { text: span, url });
        }
    }

    fn code_block(&mut self, range: Range<usize>) {
        let source = &self.source.source[range.clone()];
        self.style(range.clone(), "font-mono");
        let first_line = source.split(['\r', '\n']).next().unwrap_or("");
        let mut prefix = first_line.trim_start().chars();
        let Some(marker @ ('`' | '~')) = prefix.next() else {
            return;
        };
        let fence_len = 1 + prefix.take_while(|&ch| ch == marker).count();
        if fence_len < 3 {
            return;
        }
        self.conceal(range.clone(), range.start..range.start + first_line.len());
        if let Some(last_break) = source.rfind(['\r', '\n']) {
            let last_line = &source[last_break + 1..];
            let fence = last_line.trim();
            if fence.len() >= fence_len && fence.chars().all(|ch| ch == marker) {
                self.conceal(range.clone(), range.start + last_break + 1..range.end);
            }
        }
    }

    fn quote(&mut self, range: Range<usize>) {
        self.style(range.clone(), "text-muted-foreground italic");
        let source = &self.source.source[range.clone()];
        let mut offset = range.start;
        for line in source.split_inclusive('\n') {
            let trimmed = line.trim_start_matches([' ', '\t']);
            if let Some(tail) = trimmed.strip_prefix('>') {
                let marker_end =
                    offset + (line.len() - tail.len()) + usize::from(tail.starts_with(' '));
                self.conceal(range.clone(), offset..marker_end);
            }
            offset += line.len();
        }
    }

    fn visit(&mut self, node: &mdast::Node) {
        use mdast::Node::*;
        let children = node.children();
        if let Some(range) = bounds(node) {
            let content = children.and_then(|children| {
                Some(bounds(children.first()?)?.start..bounds(children.last()?)?.end)
            });
            match node {
                Strong(_) => {
                    if let Some(content) = content {
                        self.format(range, content, "font-semibold");
                    }
                }
                Emphasis(_) => {
                    if let Some(content) = content {
                        self.format(range, content, "italic");
                    }
                }
                Delete(_) => {
                    if let Some(content) = content {
                        self.format(range, content, "line-through");
                    }
                }
                Heading(heading) => {
                    if let Some(content) = content {
                        let class = match heading.depth {
                            1 => "font-semibold text-lg",
                            2 => "font-semibold text-base",
                            _ => "font-semibold",
                        };
                        self.format(range, content, class);
                    }
                }
                Link(link) => {
                    if let Some(content) = content {
                        self.link(range, content, &link.url);
                    }
                }
                LinkReference(link) => {
                    if let Some(content) = content {
                        if let Some(&url) = self.destinations.get(link.identifier.as_str()) {
                            self.link(range, content, url);
                        }
                    }
                }
                InlineCode(_) => {
                    let delimiter = self.source.source[range.clone()]
                        .bytes()
                        .take_while(|byte| *byte == b'`')
                        .count();
                    let inner = range.start + delimiter..range.end - delimiter;
                    self.format(range, inner, "font-mono");
                }
                Blockquote(_) => self.quote(range),
                Code(code) => {
                    if code
                        .lang
                        .as_deref()
                        .is_some_and(|lang| lang.eq_ignore_ascii_case("mermaid"))
                        && let Some(span) = self.span(range.clone())
                    {
                        self.result.diagrams.push((span, code.value.clone()));
                    }
                    self.code_block(range);
                }
                ListItem(_) => self.list_marker(range.start),
                _ => {}
            }
        }
        if let Some(children) = children {
            for child in children {
                self.visit(child);
            }
        }
    }
}

fn bounds(node: &mdast::Node) -> Option<Range<usize>> {
    let position = node.position()?;
    Some(position.start.offset..position.end.offset)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::composer_input::model;
    use nsh_base::rich_editor::state::DecorationKind;

    #[test]
    fn previews_markdown_at_source_positions_through_cjk_and_emoji() {
        let raw = "👋看**结论：**继续 [文档](https://example.org/doc) 和 https://example.org。\n";
        let doc = model::document(&model::schema(), raw);
        let projection = Projection::new(&doc);
        let presentation = Presentation::new(&doc);
        let text = |range: Range<usize>| {
            String::from_utf16(
                &raw.encode_utf16().collect::<Vec<_>>()[projection.source_at(range.start) as usize
                    ..projection.source_at(range.end) as usize],
            )
            .unwrap()
        };
        let hidden = |cursor| {
            presentation
                .decorations(cursor, Color(0x8ab8_f8ff))
                .into_iter()
                .filter(|deco| matches!(deco.kind, DecorationKind::Replacement(None)))
                .map(|deco| text(deco.from..deco.to))
                .collect::<Vec<_>>()
        };
        assert_eq!(
            hidden(None),
            ["**", "**", "[", "](https://example.org/doc)"]
        );
        let [named, bare] = presentation.links.as_slice() else {
            panic!("expected both the named link and the bare URL");
        };
        assert_eq!(text(named.text.clone()), "文档");
        assert_eq!(text(bare.text.clone()), "https://example.org");
        assert_eq!(bare.url.as_deref(), Some("https://example.org/"));
        assert_eq!(hidden(Some(named.text.start + 1)), ["**", "**"]);
        assert_eq!(model::source(&doc), raw);
    }

    #[test]
    fn list_bullets_keep_their_source_editable() {
        let raw = "- 检查构建\n  + 👋子项\n* 提交结果\n\n-紧挨着\n\n```\n- 代码\n```";
        let doc = model::document(&model::schema(), raw);
        let projection = Projection::new(&doc);
        let presentation = Presentation::new(&doc);
        let bullets = |cursor| {
            presentation
                .decorations(cursor, Color(0x8ab8_f8ff))
                .iter()
                .filter(|d| matches!(d.kind, DecorationKind::Replacement(Some('•'))))
                .map(|d| projection.source_at(d.from))
                .collect::<Vec<_>>()
        };
        assert_eq!(bullets(None), [0, 9, 16]);
        let before_plus = projection.doc_at(9, false).unwrap();
        assert_eq!(bullets(Some(before_plus)), [0, 16]);
        assert_eq!(bullets(Some(before_plus + 1)), [0, 16]);
        assert_eq!(bullets(Some(before_plus + 2)), [0, 9, 16]);
        assert_eq!(model::source(&doc), raw);
    }
}
