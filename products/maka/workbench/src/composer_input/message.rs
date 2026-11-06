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

//! Canonical history addresses for the readonly rendering of a message.

use std::sync::Arc;

use nsh_base::rich_editor::{
    model::{Fragment, Mark, Node, Schema},
    state::ViewFactory,
    view::MarkView,
};
use nsh_core::{TextSource, TextSourceKind, TextSourceSegment, prelude::*};
use serde_json::{Value, json};

#[derive(Clone, Default)]
pub(super) struct Source {
    pub id: Option<SharedString>,
    pub offset: u64,
}

impl Source {
    pub fn matches(&self, doc: &Node) -> bool {
        doc.attrs().get("sourceId").and_then(Value::as_str) == self.id.as_deref()
            && doc
                .attrs()
                .get("sourceOffset")
                .and_then(Value::as_u64)
                .unwrap_or(0)
                == self.offset
    }

    pub fn annotate(&self, schema: &Schema, doc: Node) -> Node {
        let Some(id) = &self.id else {
            return doc;
        };
        let mut offset = self.offset;
        let mut paragraphs = Vec::new();
        for (paragraph_index, paragraph) in doc.content().iter().enumerate() {
            let mut nodes = Vec::new();
            for (node_index, original) in paragraph.content().iter().enumerate() {
                let raw = if original.ty().name() == "skill" {
                    format!(
                        "/skill:{}",
                        original.attrs()["name"]
                            .as_str()
                            .expect("a skill name is text")
                    )
                } else {
                    original
                        .text()
                        .expect("composer inline nodes are text or skills")
                        .to_owned()
                };
                // A loaded suffix cannot prove the boundary before its first
                // character. Never turn it into a new invocation at the gap.
                let node = if self.offset > 0
                    && paragraph_index == 0
                    && node_index == 0
                    && original.ty().name() == "skill"
                {
                    schema.text(&raw, vec![])
                } else {
                    original.clone()
                };
                if node.is_text() {
                    let mark = schema
                        .mark(
                            "source",
                            Some(
                                [
                                    ("id".to_owned(), json!(id.as_ref())),
                                    ("offset".to_owned(), json!(offset)),
                                ]
                                .into(),
                            ),
                        )
                        .expect("a source mark has an identity and byte offset");
                    nodes.push(node.mark(vec![mark]));
                } else {
                    let mut attrs = node.attrs().clone();
                    attrs.insert("sourceId".to_owned(), json!(id.as_ref()));
                    attrs.insert("sourceOffset".to_owned(), json!(offset));
                    nodes.push(
                        schema
                            .node("skill", Some(attrs), Fragment::empty(), vec![])
                            .expect("source metadata preserves a skill node"),
                    );
                }
                offset += raw.len() as u64;
            }
            paragraphs.push(paragraph.copy(Fragment::from(nodes)));
            if paragraph_index + 1 < doc.child_count() {
                offset += paragraph
                    .attrs()
                    .get("ending")
                    .and_then(Value::as_str)
                    .unwrap_or("\n")
                    .len() as u64;
            }
        }
        let mut attrs = doc.attrs().clone();
        attrs.insert("sourceId".to_owned(), json!(id.as_ref()));
        attrs.insert("sourceOffset".to_owned(), json!(self.offset));
        schema
            .node("doc", Some(attrs), Fragment::from(paragraphs), vec![])
            .expect("source annotations preserve the composer schema")
    }
}

struct SourceMark;

impl MarkView for SourceMark {
    fn create(&self, mark: &Mark, value: &str) -> AnyElement {
        text(value.to_owned())
            .text_source(Some(Arc::new(TextSource::Literal {
                id: Arc::from(
                    mark.attrs()["id"]
                        .as_str()
                        .expect("a source mark has an id"),
                ),
                offset: mark.attrs()["offset"]
                    .as_u64()
                    .expect("a source mark has a byte offset"),
            })))
            .into_element()
    }
}

pub(super) fn mark_views() -> Vec<(String, ViewFactory)> {
    let view: Arc<dyn MarkView> = Arc::new(SourceMark);
    vec![("source".to_owned(), Arc::new(view))]
}

pub(super) fn attachment(node: &Node, chip: AnyElement) -> AnyElement {
    let Some(id) = node.attrs().get("sourceId").and_then(Value::as_str) else {
        return chip;
    };
    let offset = node.attrs()["sourceOffset"]
        .as_u64()
        .expect("skill source offset is a byte offset");
    let length = 7 + node.attrs()["name"]
        .as_str()
        .expect("a skill name is text")
        .len() as u64;
    text("")
        .text_source(Some(Arc::new(TextSource::Mapped {
            id: Arc::from(id),
            segments: vec![TextSourceSegment {
                start: 0,
                end: 1,
                source_start: offset,
                source_end: offset + length,
                kind: TextSourceKind::Replacement,
            }],
        })))
        .child(chip)
        .into_element()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::composer_input::model;

    #[test]
    fn history_annotations_preserve_utf8_addresses_and_plain_copy_text() {
        let schema = model::schema();
        let doc = model::document(&schema, "🦀 /skill:review\r\n尾部", true);
        let source = Source {
            id: Some("message".into()),
            offset: 100,
        };
        let doc = source.annotate(&schema, doc);
        assert_eq!(model::source(&doc), "🦀 /skill:review\r\n尾部");
        assert!(source.matches(&doc));
        assert_eq!(
            doc.child(0).child(0).marks()[0].attrs()["offset"],
            json!(100)
        );
        assert_eq!(doc.child(0).child(1).attrs()["sourceOffset"], json!(105));
        assert_eq!(
            doc.child(1).child(0).marks()[0].attrs()["offset"],
            json!(120)
        );
    }

    #[test]
    fn a_loaded_suffix_does_not_invent_a_skill_boundary_at_its_start() {
        let schema = model::schema();
        let doc = model::document(&schema, "/skill:partial /skill:valid", true);
        let doc = Source {
            id: Some("message".into()),
            offset: 20,
        }
        .annotate(&schema, doc);
        assert_eq!(doc.child(0).child(0).text(), Some("/skill:partial"));
        assert_eq!(doc.child(0).child(2).ty().name(), "skill");
        assert_eq!(model::source(&doc), "/skill:partial /skill:valid");
    }
}
