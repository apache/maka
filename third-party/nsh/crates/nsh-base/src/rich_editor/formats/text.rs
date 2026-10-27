//! Plain text: one textblock per line, and the clipboard's text. Types
//! with a `render_text` (Tiptap's `renderText`) count as its text.

use super::{DocFormat, FormatError};
use crate::rich_editor::model::{Fragment, Node, ResolvedPos, Schema, Slice};

/// Documents as plain text: each textblock is a line, read back as a
/// block of [`PlainTextFormat::block`]'s type. Structure and marks are
/// lost, so it is lossless for no schema with more than text in blocks.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct PlainTextFormat {
    /// The node type lines are read into (`paragraph`).
    pub block: String,
}

impl Default for PlainTextFormat {
    fn default() -> Self {
        Self {
            block: "paragraph".into(),
        }
    }
}

impl DocFormat for PlainTextFormat {
    type Error = FormatError;

    fn parse(&self, schema: &Schema, input: &str) -> Result<Node, FormatError> {
        let normalized = input.replace("\r\n", "\n");
        let mut blocks = Vec::new();
        for line in normalized.split('\n') {
            blocks.push(text_block(schema, &self.block, line, Vec::new())?);
        }
        let top = schema.top_node_type();
        schema
            .node(top.name(), None, Fragment::from(blocks), Vec::new())
            .map_err(|e| FormatError::Schema(e.to_string()))
    }

    fn serialize(&self, doc: &Node) -> Result<String, FormatError> {
        Ok(fragment_text(doc.content()))
    }

    fn is_lossless_for(&self, _schema: &Schema) -> bool {
        // Even a schema of paragraphs alone loses marks and attributes,
        // which no starting point of the kernel can rule out.
        false
    }
}

/// A textblock of type `name` holding `text`, empty when `text` is (text
/// nodes are never empty).
fn text_block(
    schema: &Schema,
    name: &str,
    text: &str,
    marks: Vec<crate::rich_editor::model::Mark>,
) -> Result<Node, FormatError> {
    let content = if text.is_empty() {
        Fragment::empty()
    } else {
        Fragment::from(vec![schema.text(text, marks)])
    };
    schema
        .node(name, None, content, Vec::new())
        .map_err(|e| FormatError::Schema(e.to_string()))
}

/// The text of a fragment's blocks, one line per textblock.
fn fragment_text(fragment: &Fragment) -> String {
    let mut lines = Vec::new();
    collect_lines(fragment, &mut lines, &mut None);
    lines.join("\n")
}

fn collect_lines(fragment: &Fragment, lines: &mut Vec<String>, inline: &mut Option<String>) {
    for i in 0..fragment.child_count() {
        let child = fragment.child(i);
        if let Some(render) = &child.ty().spec().render_text {
            // A type's own text (Tiptap's `renderText`) stands for the
            // node and its content.
            let text = render.text(child);
            if child.is_inline() {
                inline.get_or_insert_with(String::new).push_str(&text);
            } else {
                flush(lines, inline);
                lines.push(text);
            }
        } else if let Some(text) = child.text() {
            inline.get_or_insert_with(String::new).push_str(text);
        } else if child.is_inline() {
            // Inline leaves without `render_text`: a line break (any type
            // named `*break*`) keeps its meaning, others (images,
            // mentions) have no text.
            let line = inline.get_or_insert_with(String::new);
            if child.ty().name().contains("break") {
                line.push('\n');
            }
        } else if child.is_textblock() {
            flush(lines, inline);
            let mut line = Some(String::new());
            collect_lines(child.content(), lines, &mut line);
            lines.push(line.unwrap_or_default());
        } else {
            flush(lines, inline);
            collect_lines(child.content(), lines, inline);
        }
    }
}

fn flush(lines: &mut Vec<String>, inline: &mut Option<String>) {
    if let Some(line) = inline.take() {
        lines.push(line);
    }
}

/// The plain text of a slice, as the clipboard's `text/plain`: one line
/// per textblock.
pub fn slice_to_text(slice: &Slice) -> String {
    fragment_text(&slice.content)
}

/// A slice to paste `text` into the position `context`: in a code block
/// the text as is; otherwise a single line is text with the marks at
/// `context`, and several lines are open blocks of `context`'s textblock
/// type (or the schema's `paragraph`), so the first and last join the
/// blocks around the paste.
pub fn slice_from_text(schema: &Schema, text: &str, context: &ResolvedPos) -> Slice {
    let text = text.replace("\r\n", "\n");
    let parent = context.parent();
    let marks = context.marks().to_vec();
    if parent.ty().spec().code || !text.contains('\n') {
        if text.is_empty() {
            return Slice::empty();
        }
        let marks = if parent.ty().spec().code {
            Vec::new()
        } else {
            marks
        };
        return Slice {
            content: Fragment::from(vec![schema.text(&text, marks)]),
            open_start: 0,
            open_end: 0,
        };
    }
    let block = if parent.is_textblock() {
        parent.ty().name().to_string()
    } else {
        "paragraph".into()
    };
    let mut blocks = Vec::new();
    for line in text.split('\n') {
        match text_block(schema, &block, line, marks.clone()) {
            Ok(node) => blocks.push(node),
            Err(_) => return Slice::empty(),
        }
    }
    Slice {
        content: Fragment::from(blocks),
        open_start: 1,
        open_end: 1,
    }
}

#[cfg(test)]
#[allow(clippy::field_reassign_with_default)]
mod tests {
    use super::*;
    use crate::rich_editor::extensions::starter;

    #[test]
    fn plain_text_round_trips_lines() {
        let schema = starter::schema();
        let f = PlainTextFormat::default();
        let doc = f.parse(&schema, "one\n\nthree").unwrap();
        assert_eq!(doc.child_count(), 3);
        assert_eq!(f.serialize(&doc).unwrap(), "one\n\nthree");
        assert!(!f.is_lossless_for(&schema));
    }

    #[test]
    fn nested_blocks_are_lines() {
        let schema = starter::schema();
        let md = crate::rich_editor::formats::MarkdownFormat::default();
        let doc = md
            .parse(&schema, "# Title\n\n> quoted\n\n- a\n- b")
            .unwrap();
        let text = PlainTextFormat::default().serialize(&doc).unwrap();
        assert_eq!(text, "Title\nquoted\na\nb");
    }

    #[test]
    fn render_text_replaces_a_node() {
        use crate::rich_editor::model::{NodeSpec, Schema, SchemaSpec, TextRender};
        let mut spec = SchemaSpec::default();
        spec.nodes = vec![
            (
                "doc".into(),
                NodeSpec {
                    content: Some("block+".into()),
                    ..Default::default()
                },
            ),
            (
                "paragraph".into(),
                NodeSpec {
                    content: Some("inline*".into()),
                    group: Some("block".into()),
                    ..Default::default()
                },
            ),
            (
                "mention".into(),
                NodeSpec {
                    inline: true,
                    group: Some("inline".into()),
                    attrs: vec![("id".into(), Default::default())],
                    render_text: Some(TextRender::Template("@{id} {{x}}".into())),
                    ..Default::default()
                },
            ),
            (
                "rule".into(),
                NodeSpec {
                    group: Some("block".into()),
                    render_text: Some(TextRender::new(|_| "---".into())),
                    ..Default::default()
                },
            ),
            (
                "text".into(),
                NodeSpec {
                    group: Some("inline".into()),
                    ..Default::default()
                },
            ),
        ];
        let schema = Schema::new(spec).unwrap();
        let mut attrs = crate::rich_editor::model::Attrs::new();
        attrs.insert("id".into(), "ann".into());
        let mention = schema
            .node("mention", Some(attrs), Fragment::empty(), vec![])
            .unwrap();
        let p = schema
            .node(
                "paragraph",
                None,
                Fragment::from(vec![schema.text("hi ", vec![]), mention]),
                vec![],
            )
            .unwrap();
        let rule = schema
            .node("rule", None, Fragment::empty(), vec![])
            .unwrap();
        let doc = schema
            .node("doc", None, Fragment::from(vec![p, rule]), vec![])
            .unwrap();
        let text = PlainTextFormat::default().serialize(&doc).unwrap();
        assert_eq!(text, "hi @ann {x}\n---");
    }

    #[test]
    fn pasting_lines_makes_open_blocks() {
        let schema = starter::schema();
        let doc = PlainTextFormat::default().parse(&schema, "x").unwrap();
        let pos = doc.resolve(1).unwrap();
        let slice = slice_from_text(&schema, "a\nb", &pos);
        assert_eq!(slice.content.child_count(), 2);
        assert_eq!((slice.open_start, slice.open_end), (1, 1));
        assert_eq!(slice_to_text(&slice), "a\nb");
        let one = slice_from_text(&schema, "word", &pos);
        assert_eq!(one.content.child_count(), 1);
        assert!(one.content.child(0).is_text());
    }
}
