//! ProseMirror's JSON shape (`{type, attrs, content, marks, text}`), which
//! is also Tiptap's: missing or null `attrs`, `content` and `marks` read as
//! none, and unknown types can be dropped on the way in
//! ([`rewrite_unknown_content`]).

use serde_json::{Map, Value};

use super::{DocFormat, FormatError};
use crate::rich_editor::model::{Node, Schema};

/// Documents as ProseMirror JSON: lossless for every schema.
#[derive(Debug, Clone, Copy, Default)]
#[non_exhaustive]
pub struct JsonFormat {
    /// Whether [`DocFormat::serialize`] indents its output.
    pub pretty: bool,
    /// Whether [`DocFormat::parse`] drops node and mark types the schema
    /// lacks instead of failing (Tiptap's `rewriteUnknownContent`); see
    /// [`JsonFormat::parse_lenient`] for what was dropped.
    pub rewrite_unknown_content: bool,
}

impl JsonFormat {
    /// Reads `input` with unknown node and mark types rewritten as
    /// [`rewrite_unknown_content`] does (unknown nodes with content become
    /// paragraphs), returning what was rewritten.
    pub fn parse_lenient(
        &self,
        schema: &Schema,
        input: &str,
    ) -> Result<(Node, Vec<RewrittenContent>), FormatError> {
        let value: Value =
            serde_json::from_str(input).map_err(|e| FormatError::Json(e.to_string()))?;
        let (value, rewritten) = rewrite_unknown_content(&value, schema, true);
        let value =
            value.ok_or_else(|| FormatError::Json("the document's type is unknown".into()))?;
        Ok((read(schema, &value)?, rewritten))
    }
}

/// A node or mark [`rewrite_unknown_content`] rewrote.
#[derive(Debug, Clone, Default, PartialEq)]
#[non_exhaustive]
pub struct RewrittenContent {
    /// Its JSON as it was.
    pub original: Value,
    /// The unknown type's name.
    pub unsupported: String,
}

/// `json` (a node's JSON) without the node and mark types `schema` lacks
/// (Tiptap's `rewriteUnknownContent`): unknown marks are dropped, unknown
/// nodes with content become paragraphs when `fallback_to_paragraph` (their
/// children lifted in their place when they hold blocks) and are dropped
/// otherwise; null entries are dropped and marks given as
/// names (`"bold"`) become `{"type": "bold"}`. None when `json` itself is
/// dropped.
pub fn rewrite_unknown_content(
    json: &Value,
    schema: &Schema,
    fallback_to_paragraph: bool,
) -> (Option<Value>, Vec<RewrittenContent>) {
    let mut rewritten = Vec::new();
    let mut out = rewrite(json.clone(), schema, fallback_to_paragraph, &mut rewritten);
    // The top node is kept or dropped, never lifted out of.
    let out = (out.len() == 1).then(|| out.remove(0));
    (out, rewritten)
}

/// `json` rewritten: none, itself, or the children of an unknown node
/// lifted in its place.
fn rewrite(
    mut json: Value,
    schema: &Schema,
    fallback: bool,
    rewritten: &mut Vec<RewrittenContent>,
) -> Vec<Value> {
    let Some(obj) = json.as_object_mut() else {
        return vec![json];
    };
    let name = obj.get("type").and_then(Value::as_str).map(str::to_owned);
    // An unknown node is reported as it came, before its children change.
    let unknown = name
        .filter(|n| schema.node_type(n).is_none())
        .map(|n| (n, Value::Object(obj.clone())));
    if let Some(Value::Array(marks)) = obj.get_mut("marks") {
        let kept: Vec<Value> = std::mem::take(marks)
            .into_iter()
            .filter_map(|mark| {
                let mark = match mark {
                    Value::Null => return None,
                    Value::String(name) => {
                        let mut m = Map::new();
                        m.insert("type".into(), Value::String(name));
                        Value::Object(m)
                    }
                    m => m,
                };
                let name = mark.get("type").and_then(Value::as_str).unwrap_or_default();
                if schema.mark_type(name).is_some() {
                    return Some(mark);
                }
                rewritten.push(RewrittenContent {
                    original: mark.clone(),
                    unsupported: name.to_owned(),
                });
                None
            })
            .collect();
        *marks = kept;
    }
    if let Some(Value::Array(content)) = obj.get_mut("content") {
        let kept: Vec<Value> = std::mem::take(content)
            .into_iter()
            .filter(|v| !v.is_null())
            .flat_map(|child| rewrite(child, schema, fallback, rewritten))
            .collect();
        *content = kept;
    }
    let Some((name, original)) = unknown else {
        return vec![json];
    };
    rewritten.push(RewrittenContent {
        original,
        unsupported: name,
    });
    let Some(Value::Array(content)) = obj.get_mut("content") else {
        return Vec::new();
    };
    if !fallback {
        return Vec::new();
    }
    // Blocks cannot go in a paragraph: they take the unknown node's place.
    let holds_blocks = content.iter().any(|child| {
        child
            .get("type")
            .and_then(Value::as_str)
            .and_then(|n| schema.node_type(n))
            .is_some_and(|t| t.is_block())
    });
    if holds_blocks {
        return std::mem::take(content);
    }
    obj.insert("type".into(), Value::from("paragraph"));
    vec![json]
}

fn read(schema: &Schema, value: &Value) -> Result<Node, FormatError> {
    let doc = Node::from_json(schema, value).map_err(|e| FormatError::Json(e.to_string()))?;
    // `from_json` builds nodes one by one; the whole tree is only
    // known valid once checked against the schema's content rules.
    doc.check()
        .map_err(|e| FormatError::Schema(e.to_string()))?;
    Ok(doc)
}

impl DocFormat for JsonFormat {
    type Error = FormatError;

    fn parse(&self, schema: &Schema, input: &str) -> Result<Node, FormatError> {
        if self.rewrite_unknown_content {
            return self.parse_lenient(schema, input).map(|(doc, _)| doc);
        }
        let value: Value =
            serde_json::from_str(input).map_err(|e| FormatError::Json(e.to_string()))?;
        read(schema, &value)
    }

    fn serialize(&self, doc: &Node) -> Result<String, FormatError> {
        let value = doc.to_json();
        let out = if self.pretty {
            serde_json::to_string_pretty(&value)
        } else {
            serde_json::to_string(&value)
        };
        out.map_err(|e| FormatError::Json(e.to_string()))
    }

    fn is_lossless_for(&self, _schema: &Schema) -> bool {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rich_editor::extensions::starter;

    #[test]
    fn json_round_trips() {
        let schema = starter::schema();
        let input = r#"{"type":"doc","content":[{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Hi "},{"type":"text","marks":[{"type":"bold"}],"text":"there"}]},{"type":"paragraph"}]}"#;
        let f = JsonFormat::default();
        let doc = f.parse(&schema, input).unwrap();
        let out = f.serialize(&doc).unwrap();
        let again = f.parse(&schema, &out).unwrap();
        assert!(doc.eq(&again));
        assert!(f.is_lossless_for(&schema));
    }

    #[test]
    fn invalid_json_is_an_error() {
        let schema = starter::schema();
        let f = JsonFormat::default();
        assert!(matches!(f.parse(&schema, "{"), Err(FormatError::Json(_))));
        assert!(f.parse(&schema, r#"{"type":"nope"}"#).is_err());
    }

    /// Tiptap's documents leave out or null `attrs`, `content` and `marks`.
    #[test]
    fn tiptap_json_reads() {
        let schema = starter::schema();
        let input = r#"{"type":"doc","attrs":null,"content":[{"type":"paragraph","attrs":null,"marks":null,"content":[{"type":"text","text":"a","marks":[{"type":"bold","attrs":null}]}]},{"type":"paragraph","content":null}]}"#;
        let doc = JsonFormat::default().parse(&schema, input).unwrap();
        assert_eq!(doc.child_count(), 2);
        assert_eq!(doc.child(0).child(0).marks().len(), 1);
    }

    #[test]
    fn unknown_content_is_rewritten() {
        let schema = starter::schema();
        let input = r#"{"type":"doc","content":[{"type":"callout","content":[{"type":"text","text":"x","marks":[{"type":"glow"},"bold",null]}]},{"type":"widget"},null,{"type":"paragraph"}]}"#;
        let strict = JsonFormat::default();
        assert!(strict.parse(&schema, input).is_err());
        let (doc, rewritten) = strict.parse_lenient(&schema, input).unwrap();
        let names: Vec<&str> = rewritten.iter().map(|r| r.unsupported.as_str()).collect();
        assert_eq!(names, ["glow", "callout", "widget"]);
        assert_eq!(doc.child_count(), 2);
        assert_eq!(doc.child(0).ty().name(), "paragraph");
        assert_eq!(doc.child(0).child(0).marks().len(), 1);
        let lenient = JsonFormat {
            rewrite_unknown_content: true,
            ..Default::default()
        };
        assert!(lenient.parse(&schema, input).unwrap().eq(&doc));
        let (none, _) = rewrite_unknown_content(&serde_json::json!({"type": "x"}), &schema, true);
        assert!(none.is_none());
        // An unknown wrapper of blocks gives way to them.
        let input = r#"{"type":"doc","content":[{"type":"box","content":[{"type":"paragraph","content":[{"type":"text","text":"in"}]},{"type":"paragraph"}]}]}"#;
        let (doc, rewritten) = strict.parse_lenient(&schema, input).unwrap();
        assert_eq!(doc.child_count(), 2);
        assert_eq!(
            rewritten[0].original["content"].as_array().unwrap().len(),
            2
        );
    }
}
