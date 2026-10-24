//! The document [`super::TextView`] shows: blocks of inline content, the
//! same whatever it was written in (Markdown, HTML, or built by the app).
//!
//! It is plain data, in JS the objects the `document` prop takes and the
//! render functions get: `{ type: "paragraph", content: [...] }`, each
//! node tagged by its `type` (camel case), its fields in camel case.

use std::collections::BTreeMap;

use nsh_core::{
    JsonValue,
    geometry::{DefiniteLength, Percentage, Points},
    ui::{JsHost, JsIn, JsOwned, JsValue, PropError, TsTypes},
};
use serde::{Deserialize, Serialize};

/// A document: its blocks, then its footnotes.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct Document {
    /// The blocks, in order.
    #[serde(default)]
    pub blocks: Vec<Block>,
    /// The footnotes the blocks refer to, in the order of their first
    /// reference.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub footnotes: Vec<Footnote>,
}

impl Document {
    /// A document of `blocks`.
    pub fn new(blocks: Vec<Block>) -> Self {
        Self {
            blocks,
            footnotes: Vec::new(),
        }
    }

    /// Its text without markup: blocks separated by blank lines, list
    /// items and table rows by line breaks, table cells by tabs (what a
    /// copy of the whole document gives).
    pub fn plain_text(&self) -> String {
        let mut out = String::new();
        let notes = self.footnotes.iter().flat_map(|f| f.children.iter());
        for block in self.blocks.iter().chain(notes) {
            if !out.is_empty() {
                out.push_str("\n\n");
            }
            block.write_text(&mut out);
        }
        out
    }
}

/// A block of a [`Document`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[non_exhaustive]
pub enum Block {
    /// A paragraph.
    Paragraph {
        /// Its content.
        #[serde(serialize_with = "serialize_inlines")]
        content: Vec<Inline>,
    },
    /// A heading of level 1 to 6.
    Heading {
        /// 1 (the largest) to 6.
        level: u8,
        /// Its content.
        #[serde(serialize_with = "serialize_inlines")]
        content: Vec<Inline>,
        /// Its anchor (`#getting-started`), GitHub's slug of its text:
        /// what links in the document name it by.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        anchor: Option<String>,
    },
    /// A quotation, or an alert (GitHub's `> [!NOTE]`).
    Blockquote {
        /// Its blocks.
        children: Vec<Block>,
        /// The kind of alert it is, if it is one.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        alert: Option<Alert>,
    },
    /// A list.
    List {
        /// Numbered.
        #[serde(default)]
        ordered: bool,
        /// The number of the first item (ordered lists).
        #[serde(default = "one")]
        start: u32,
        /// Its items are separated by blank lines (Markdown's loose list:
        /// their paragraphs are spaced as paragraphs).
        #[serde(default)]
        loose: bool,
        /// Its items.
        items: Vec<ListItem>,
    },
    /// Code, shown as written.
    CodeBlock(CodeBlock),
    /// A display formula (`$$ … $$`), in TeX.
    Math {
        /// The formula.
        tex: String,
        /// Native canonical mappings for the displayed formula text.
        #[serde(skip)]
        source: Vec<nsh_core::TextSourceSegment>,
    },
    /// A table.
    Table(Table),
    /// A thematic break (`---`, `<hr>`).
    Rule,
    /// A disclosure (`<details>`): its summary always, its blocks while
    /// open (a press on the summary toggles it).
    Details {
        /// Shown open at first.
        #[serde(default)]
        open: bool,
        /// What it says closed.
        #[serde(serialize_with = "serialize_inlines")]
        summary: Vec<Inline>,
        /// Its blocks.
        children: Vec<Block>,
    },
    /// A node of an extension ([`super::MarkdownExtension`],
    /// [`super::MarkdownPlugin`]) or of the app.
    Custom(CustomNode),
}

fn one() -> u32 {
    1
}

impl Block {
    /// A paragraph of `content`.
    pub fn paragraph(content: Vec<Inline>) -> Self {
        Block::Paragraph { content }
    }

    /// The name of its kind (`paragraph`, `codeBlock`; a custom node's
    /// own name).
    pub fn kind(&self) -> &str {
        match self {
            Block::Paragraph { .. } => "paragraph",
            Block::Heading { .. } => "heading",
            Block::Blockquote { .. } => "blockquote",
            Block::List { .. } => "list",
            Block::CodeBlock(_) => "codeBlock",
            Block::Math { .. } => "math",
            Block::Table(_) => "table",
            Block::Rule => "rule",
            Block::Details { .. } => "details",
            Block::Custom(node) => &node.name,
        }
    }

    /// Its text without markup ([`Document::plain_text`]).
    pub fn plain_text(&self) -> String {
        let mut out = String::new();
        self.write_text(&mut out);
        out
    }

    fn write_text(&self, out: &mut String) {
        let blocks = |out: &mut String, blocks: &[Block], sep: &str| {
            for (i, b) in blocks.iter().enumerate() {
                if i > 0 {
                    out.push_str(sep);
                }
                b.write_text(out);
            }
        };
        match self {
            Block::Paragraph { content } | Block::Heading { content, .. } => {
                inline_text(content, out)
            }
            Block::Blockquote { children, .. } => blocks(out, children, "\n\n"),
            Block::List { items, .. } => {
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        out.push('\n');
                    }
                    blocks(out, &item.children, "\n");
                }
            }
            Block::CodeBlock(code) => out.push_str(code.code.trim_end_matches('\n')),
            Block::Math { tex, .. } => out.push_str(tex),
            Block::Table(table) => {
                for (i, row) in std::iter::once(&table.head)
                    .chain(table.rows.iter())
                    .enumerate()
                {
                    if i > 0 {
                        out.push('\n');
                    }
                    for (j, cell) in row.iter().enumerate() {
                        if j > 0 {
                            out.push('\t');
                        }
                        inline_text(&cell.content, out);
                    }
                }
            }
            Block::Rule => {}
            Block::Details {
                summary, children, ..
            } => {
                inline_text(summary, out);
                if !children.is_empty() {
                    out.push_str("\n\n");
                    blocks(out, children, "\n\n");
                }
            }
            Block::Custom(node) => node.write_text(out),
        }
    }
}

/// Inline content of a block.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[non_exhaustive]
pub enum Inline {
    /// Native source provenance for this inline content. Rewrites and
    /// parser syntax are projected onto the text's UTF-16 coordinates.
    #[serde(skip)]
    Source {
        /// The rendered content (source wrappers do not add characters).
        #[serde(serialize_with = "serialize_inlines")]
        content: Vec<Inline>,
        /// Canonical UTF-8 mappings, kept native rather than sent through JS.
        #[serde(skip)]
        segments: Vec<nsh_core::TextSourceSegment>,
    },

    /// Text.
    Text {
        /// The text.
        text: String,
    },
    /// Strong importance (`**bold**`, `<strong>`, `<b>`).
    Strong {
        /// Its content.
        #[serde(serialize_with = "serialize_inlines")]
        content: Vec<Inline>,
    },
    /// Emphasis (`*italic*`, `<em>`, `<i>`).
    Emphasis {
        /// Its content.
        #[serde(serialize_with = "serialize_inlines")]
        content: Vec<Inline>,
    },
    /// Struck through (`~~deleted~~`, `<del>`, `<s>`).
    Strikethrough {
        /// Its content.
        #[serde(serialize_with = "serialize_inlines")]
        content: Vec<Inline>,
    },
    /// Underlined (`<u>`, `<ins>`).
    Underline {
        /// Its content.
        #[serde(serialize_with = "serialize_inlines")]
        content: Vec<Inline>,
    },
    /// Highlighted (`<mark>`).
    Highlight {
        /// Its content.
        #[serde(serialize_with = "serialize_inlines")]
        content: Vec<Inline>,
        /// Its background, a CSS color (`<mark color="…">`, `<mark
        /// style="background-color: …">`); the view's own when not given.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        color: Option<String>,
    },
    /// Superscript (`<sup>`).
    Superscript {
        /// Its content.
        #[serde(serialize_with = "serialize_inlines")]
        content: Vec<Inline>,
    },
    /// Smaller text (`<small>`).
    Small {
        /// Its content.
        #[serde(serialize_with = "serialize_inlines")]
        content: Vec<Inline>,
    },
    /// Subscript (`<sub>`).
    Subscript {
        /// Its content.
        #[serde(serialize_with = "serialize_inlines")]
        content: Vec<Inline>,
    },
    /// Code (`` `code` ``, `<code>`).
    Code {
        /// The code.
        code: String,
    },
    /// A key or a key combination (`<kbd>`).
    Keyboard {
        /// The keys.
        text: String,
    },
    /// A link.
    Link {
        /// Where it goes (`#anchor` for a heading of the document).
        url: String,
        /// Its title.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        /// Its content.
        #[serde(serialize_with = "serialize_inlines")]
        content: Vec<Inline>,
    },
    /// An image.
    Image(Image),
    /// A formula in the text (`$ … $`), in TeX.
    Math {
        /// The formula.
        tex: String,
    },
    /// A line break.
    Break,
    /// A reference to a footnote (`[^1]`).
    FootnoteReference {
        /// Its label (`1`, `note`).
        label: String,
        /// Its number, from 1, in the order of first references.
        index: u32,
    },
    /// A node of an extension or of the app.
    Custom(CustomNode),
}

impl Inline {
    /// Text `text`.
    pub fn text(text: impl Into<String>) -> Self {
        Inline::Text { text: text.into() }
    }

    /// Its text without markup.
    pub fn plain_text(&self) -> String {
        let mut out = String::new();
        inline_text(std::slice::from_ref(self), &mut out);
        out
    }
}

/// Writes the text of `inlines` into `out`.
pub(crate) fn inline_text(inlines: &[Inline], out: &mut String) {
    for inline in inlines {
        match inline {
            Inline::Text { text } | Inline::Keyboard { text } => out.push_str(text),
            Inline::Code { code } => out.push_str(code),
            Inline::Math { tex } => out.push_str(tex),
            Inline::Source { content, .. }
            | Inline::Strong { content }
            | Inline::Emphasis { content }
            | Inline::Strikethrough { content }
            | Inline::Underline { content }
            | Inline::Highlight { content, .. }
            | Inline::Superscript { content }
            | Inline::Subscript { content }
            | Inline::Small { content }
            | Inline::Link { content, .. } => inline_text(content, out),
            Inline::Image(image) => out.push_str(&image.alt),
            Inline::Break => out.push('\n'),
            Inline::FootnoteReference { index, .. } => {
                out.push('[');
                out.push_str(&index.to_string());
                out.push(']');
            }
            Inline::Custom(node) => node.write_text(out),
        }
    }
}

/// A block of code.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct CodeBlock {
    /// Its language (the info string's first word: `rust`), if named.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    /// The rest of the info string (```` ```rust title="main.rs" ````).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meta: Option<String>,
    /// The code, without a final line break.
    pub code: String,
    /// Canonical source mappings for the actual code Text.
    #[serde(skip)]
    pub source: Vec<nsh_core::TextSourceSegment>,
}

impl CodeBlock {
    /// Code `code` in `language`.
    pub fn new(language: Option<String>, code: impl Into<String>) -> Self {
        Self {
            language,
            meta: None,
            code: code.into(),
            source: Vec::new(),
        }
    }
}

/// A table.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct Table {
    /// The alignment of each column.
    #[serde(default)]
    pub align: Vec<ColumnAlign>,
    /// The header row's cells.
    pub head: Vec<TableCell>,
    /// The body's rows, each as many cells as the header (Markdown fills
    /// or cuts them to its width).
    #[serde(default)]
    pub rows: Vec<Vec<TableCell>>,
}

impl Table {
    /// The number of columns.
    pub fn columns(&self) -> usize {
        let width = |row: &Vec<TableCell>| row.iter().map(TableCell::span).sum::<usize>();
        self.rows
            .iter()
            .map(width)
            .chain([width(&self.head), self.align.len()])
            .max()
            .unwrap_or(0)
    }
}

/// A cell of a [`Table`].
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct TableCell {
    /// Its content.
    #[serde(serialize_with = "serialize_inlines")]
    pub content: Vec<Inline>,
    /// The columns it spans (HTML's `colspan`), when more than one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub colspan: Option<u32>,
}

impl TableCell {
    /// A cell of `content`.
    pub fn new(content: Vec<Inline>) -> Self {
        Self {
            content,
            colspan: None,
        }
    }

    /// The columns it spans (at least one).
    pub fn span(&self) -> usize {
        self.colspan.map_or(1, |n| n.max(1) as usize)
    }
}

/// How a column of a [`Table`] aligns its cells.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ColumnAlign {
    /// As the text's direction does.
    #[default]
    None,
    /// To the left.
    Left,
    /// In the middle.
    Center,
    /// To the right.
    Right,
}

/// An item of a list.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ListItem {
    /// A task's state (`- [x]`), for a task item.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checked: Option<bool>,
    /// Its blocks.
    pub children: Vec<Block>,
}

impl ListItem {
    /// An item of `children`.
    pub fn new(children: Vec<Block>) -> Self {
        Self {
            checked: None,
            children,
        }
    }
}

/// An image.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct Image {
    /// Its URL.
    pub src: String,
    /// What it shows, for screen readers and where it cannot load.
    #[serde(default)]
    pub alt: String,
    /// Its title.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// The width it is shown at (`<img width>`, `style="width: …"`): with
    /// no height, the height follows its aspect ratio.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<ImageLength>,
    /// The height it is shown at (`<img height>`, `style="height: …"`):
    /// with no width, the width follows its aspect ratio.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<ImageLength>,
}

impl Image {
    /// An image of `src`.
    pub fn new(src: impl Into<String>) -> Self {
        Self {
            src: src.into(),
            ..Self::default()
        }
    }
}

/// The width or height of an [`Image`], as HTML writes it: points (`32`,
/// `32px`; a CSS pixel is a point), or a fraction of the text's width
/// (`50%`). In JS a number of points, or a string of a percentage
/// (`"50%"`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ImageLength {
    /// Points.
    Points(Points),
    /// A fraction of the width of the text it is in (`0.5` is 50%).
    Fraction(Percentage),
}

impl ImageLength {
    /// A length as an `<img>`'s `width` / `height` attribute or its style
    /// writes it: `32`, `32px`, `50%`; `None` for anything else (`auto`,
    /// `2em`, a negative length).
    pub fn parse(value: &str) -> Option<Self> {
        let value = value.trim();
        let (number, percent) = match value.strip_suffix('%') {
            Some(number) => (number, true),
            None => (value.strip_suffix("px").unwrap_or(value), false),
        };
        let number: f32 = number.trim_end().parse().ok()?;
        if !number.is_finite() || number < 0.0 {
            return None;
        }
        Some(if percent {
            Self::Fraction(Percentage(number / 100.0))
        } else {
            Self::Points(Points(number))
        })
    }
}

impl From<ImageLength> for DefiniteLength {
    fn from(length: ImageLength) -> Self {
        match length {
            ImageLength::Points(points) => points.into(),
            ImageLength::Fraction(fraction) => fraction.into(),
        }
    }
}

impl Serialize for ImageLength {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Points(points) => serializer.serialize_f32(points.0),
            Self::Fraction(fraction) => {
                serializer.collect_str(&format_args!("{}%", fraction.0 * 100.0))
            }
        }
    }
}

impl<'de> Deserialize<'de> for ImageLength {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Written {
            Number(f32),
            Text(String),
        }
        let length = match Written::deserialize(deserializer)? {
            Written::Number(points) => ImageLength::parse(&points.to_string()),
            Written::Text(text) => ImageLength::parse(&text),
        };
        length.ok_or_else(|| {
            serde::de::Error::custom("an image length is points or a percentage (\"50%\")")
        })
    }
}

/// A footnote.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct Footnote {
    /// Its label (`1`, `note`).
    pub label: String,
    /// Its number, from 1.
    pub index: u32,
    /// Its blocks.
    pub children: Vec<Block>,
}

/// The kind of an alert (GitHub's `> [!NOTE]`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Alert {
    /// `[!NOTE]`: useful information.
    Note,
    /// `[!TIP]`: advice.
    Tip,
    /// `[!IMPORTANT]`: what must not be missed.
    Important,
    /// `[!WARNING]`: what needs attention at once.
    Warning,
    /// `[!CAUTION]`: risks of an action.
    Caution,
}

/// A node an extension made ([`super::MarkdownExtension`],
/// [`super::MarkdownPlugin`]), or the app (the `document` prop): shown by
/// the app's render function for it, else as its content.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct CustomNode {
    /// Native canonical mappings for this node's fallback text.
    #[serde(skip)]
    pub source: Vec<nsh_core::TextSourceSegment>,

    /// Its name: the extension's (`mention`, `chart`).
    pub name: String,
    /// Its attributes: an element's (`<Callout kind="tip">`), a
    /// container's (`:::note{kind=tip}`), a pattern's groups (`"1"`, or
    /// by name), a fence's `meta`.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub attributes: BTreeMap<String, String>,
    /// Its text: a pattern's match, a fence's code, an element's text.
    #[serde(default)]
    pub text: String,
    /// Data of the extension's own (a plugin's).
    #[serde(default, skip_serializing_if = "JsonValue::is_null")]
    pub data: JsonValue,
    /// Its blocks (a container's, a block element's).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<Block>,
    /// Its inline content (an inline element's).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[serde(serialize_with = "serialize_inlines")]
    pub content: Vec<Inline>,
}

impl CustomNode {
    /// A node named `name`.
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            ..Self::default()
        }
    }

    /// With text `text`.
    pub fn with_text(mut self, text: impl Into<String>) -> Self {
        self.text = text.into();
        self
    }

    /// With attribute `name` set to `value`.
    pub fn with_attribute(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.attributes.insert(name.into(), value.into());
        self
    }

    /// With data `data`.
    pub fn with_data(mut self, data: JsonValue) -> Self {
        self.data = data;
        self
    }

    /// With blocks `children`.
    pub fn with_children(mut self, children: Vec<Block>) -> Self {
        self.children = children;
        self
    }

    /// With inline content `content`.
    pub fn with_content(mut self, content: Vec<Inline>) -> Self {
        self.content = content;
        self
    }

    fn write_text(&self, out: &mut String) {
        if !self.content.is_empty() {
            inline_text(&self.content, out);
        } else if !self.children.is_empty() {
            for (i, b) in self.children.iter().enumerate() {
                if i > 0 {
                    out.push_str("\n\n");
                }
                b.write_text(out);
            }
        } else {
            out.push_str(&self.text);
        }
    }
}

/// Serialize only the document's content, keeping native provenance out of
/// JS renderer payloads and the public document format.
fn serialize_inlines<S: serde::Serializer>(
    inlines: &[Inline],
    serializer: S,
) -> Result<S::Ok, S::Error> {
    use serde::ser::SerializeSeq;
    fn entries<S: SerializeSeq>(inlines: &[Inline], seq: &mut S) -> Result<(), S::Error> {
        for inline in inlines {
            match inline {
                Inline::Source { content, .. } => entries(content, seq)?,
                inline => seq.serialize_element(inline)?,
            }
        }
        Ok(())
    }
    let mut seq = serializer.serialize_seq(None)?;
    entries(inlines, &mut seq)?;
    seq.end()
}

// --- JS ---------------------------------------------------------------------
//
// The nodes cross as JSON (serde's form is the JS one); their TypeScript
// types are declared here, next to the types they describe.

/// Declares the document's types in `types`; returns `name`'s.
fn declare(types: &mut TsTypes, name: &'static str) -> String {
    types.declare("TextViewInline", |types| {
        types.declare("TextViewImage", |_| IMAGE.into());
        types.declare("TextViewCustomNode", |_| CUSTOM.into());
        INLINE.into()
    });
    types.declare("TextViewBlock", |types| {
        types.declare("TextViewCodeBlock", |_| CODE_BLOCK.into());
        types.declare("TextViewTable", |_| TABLE.into());
        types.declare("TextViewListItem", |_| LIST_ITEM.into());
        types.declare("TextViewAlert", |_| ALERT.into());
        BLOCK.into()
    });
    types.declare("TextViewDocument", |types| {
        types.declare("TextViewFootnote", |_| FOOTNOTE.into());
        DOCUMENT.into()
    });
    name.to_owned()
}

const DOCUMENT: &str = "/** A document `TextView` shows: its blocks, then its footnotes. */
export interface TextViewDocument {
  /** The blocks, in order. */
  blocks: TextViewBlock[];
  /** The footnotes the blocks refer to, in the order of their first reference. */
  footnotes?: TextViewFootnote[];
}";

const FOOTNOTE: &str = "/** A footnote of a `TextViewDocument`. */
export interface TextViewFootnote {
  /** Its label (`1`, `note`). */
  label: string;
  /** Its number, from 1. */
  index: number;
  /** Its blocks. */
  children: TextViewBlock[];
}";

const BLOCK: &str = "/** A block of a `TextViewDocument`, by its `type`. */
export type TextViewBlock =
  | { type: \"paragraph\"; content: TextViewInline[] }
  | { type: \"heading\"; level: 1 | 2 | 3 | 4 | 5 | 6; content: TextViewInline[]; anchor?: string }
  | { type: \"blockquote\"; children: TextViewBlock[]; alert?: TextViewAlert }
  | { type: \"list\"; ordered?: boolean; start?: number; loose?: boolean; items: TextViewListItem[] }
  | ({ type: \"codeBlock\" } & TextViewCodeBlock)
  | { type: \"math\"; tex: string }
  | ({ type: \"table\" } & TextViewTable)
  | { type: \"rule\" }
  | { type: \"details\"; open?: boolean; summary: TextViewInline[]; children: TextViewBlock[] }
  | ({ type: \"custom\" } & TextViewCustomNode);";

const INLINE: &str = "/** Inline content of a `TextViewBlock`, by its `type`. */
export type TextViewInline =
  | { type: \"text\"; text: string }
  | { type: \"strong\" | \"emphasis\" | \"strikethrough\" | \"underline\" | \"superscript\" | \"subscript\" | \"small\"; content: TextViewInline[] }
  | { type: \"highlight\"; content: TextViewInline[]; color?: string }
  | { type: \"code\"; code: string }
  | { type: \"keyboard\"; text: string }
  | { type: \"link\"; url: string; title?: string; content: TextViewInline[] }
  | ({ type: \"image\" } & TextViewImage)
  | { type: \"math\"; tex: string }
  | { type: \"break\" }
  | { type: \"footnoteReference\"; label: string; index: number }
  | ({ type: \"custom\" } & TextViewCustomNode);";

const CODE_BLOCK: &str = "/** A block of code. */
export interface TextViewCodeBlock {
  /** Its language (the info string's first word: `rust`), if named. */
  language?: string;
  /** The rest of the info string. */
  meta?: string;
  /** The code, without a final line break. */
  code: string;
}";

const TABLE: &str = "/** A table. */
export interface TextViewTable {
  /** The alignment of each column. */
  align?: (\"none\" | \"left\" | \"center\" | \"right\")[];
  /** The header row's cells. */
  head: { content: TextViewInline[]; colspan?: number }[];
  /** The body's rows. */
  rows?: { content: TextViewInline[]; colspan?: number }[][];
}";

const LIST_ITEM: &str = "/** An item of a list. */
export interface TextViewListItem {
  /** A task's state (`- [x]`), for a task item. */
  checked?: boolean;
  /** Its blocks. */
  children: TextViewBlock[];
}";

const ALERT: &str = "/** The kind of an alert (GitHub's `> [!NOTE]`). */
export type TextViewAlert = \"note\" | \"tip\" | \"important\" | \"warning\" | \"caution\";";

const IMAGE: &str = "/** An image. */
export interface TextViewImage {
  /** Its URL. */
  src: string;
  /** What it shows, for screen readers and where it cannot load. */
  alt?: string;
  /** Its title. */
  title?: string;
  /** The width it is shown at: points, or a percentage of the text's width (`\"50%\"`); with no height, the height follows its aspect ratio. */
  width?: number | `${number}%`;
  /** The height it is shown at, as `width`; with no width, the width follows its aspect ratio. */
  height?: number | `${number}%`;
}";

const CUSTOM: &str = "/** A node an extension or the app made: shown by the app's `renderCustom`, else as its content. */
export interface TextViewCustomNode {
  /** Its name: the extension's (`mention`, `chart`). */
  name: string;
  /** Its attributes: an element's, a container's, a pattern's groups (`\"1\"`, or by name), a fence's `meta`. */
  attributes?: Record<string, string>;
  /** Its text: a pattern's match, a fence's code, an element's text. */
  text?: string;
  /** Data of the extension's own. */
  data?: unknown;
  /** Its blocks (a container's, a block element's). */
  children?: TextViewBlock[];
  /** Its inline content (an inline element's). */
  content?: TextViewInline[];
}";

/// A value crossing as JSON, declared as TypeScript type `name`.
macro_rules! json_value {
    ($ty:ty, $name:literal) => {
        impl JsValue for $ty {
            fn ts_type(types: &mut TsTypes) -> String {
                declare(types, $name)
            }

            fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
                let json = value.to_json()?;
                serde_json::from_value(json).map_err(|e| PropError(format!("{}: {e}", $name)))
            }

            fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
                let json = serde_json::to_value(self).map_err(|e| PropError(e.to_string()))?;
                Ok(JsOwned::new(host, host.json(&json)?))
            }
        }
    };
}

json_value!(Document, "TextViewDocument");
json_value!(Block, "TextViewBlock");
json_value!(Inline, "TextViewInline");
json_value!(CodeBlock, "TextViewCodeBlock");
json_value!(Table, "TextViewTable");
json_value!(Image, "TextViewImage");
json_value!(CustomNode, "TextViewCustomNode");

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nodes_are_tagged_in_camel_case() {
        let doc = Document::new(vec![
            Block::Heading {
                level: 2,
                content: vec![Inline::text("Hi")],
                anchor: Some("hi".into()),
            },
            Block::CodeBlock(CodeBlock::new(Some("rust".into()), "fn main() {}")),
            Block::Custom(CustomNode::new("chart").with_text("1,2")),
        ]);
        let json = serde_json::to_value(&doc).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "blocks": [
                    { "type": "heading", "level": 2, "content": [{ "type": "text", "text": "Hi" }], "anchor": "hi" },
                    { "type": "codeBlock", "language": "rust", "code": "fn main() {}" },
                    { "type": "custom", "name": "chart", "text": "1,2" },
                ]
            })
        );
        let back: Document = serde_json::from_value(json).unwrap();
        assert_eq!(back, doc);
    }

    #[test]
    fn plain_text_joins_blocks() {
        let doc = Document::new(vec![
            Block::paragraph(vec![
                Inline::text("a "),
                Inline::Strong {
                    content: vec![Inline::text("b")],
                },
            ]),
            Block::List {
                ordered: false,
                start: 1,
                loose: false,
                items: vec![
                    ListItem::new(vec![Block::paragraph(vec![Inline::text("x")])]),
                    ListItem::new(vec![Block::paragraph(vec![Inline::text("y")])]),
                ],
            },
        ]);
        assert_eq!(doc.plain_text(), "a b\n\nx\ny");
    }

    #[test]
    fn image_sizes_cross_as_numbers_and_percentages() {
        let image = Image {
            width: Some(ImageLength::Points(Points(32.0))),
            height: Some(ImageLength::Fraction(Percentage(0.5))),
            ..Image::new("a.png")
        };
        let json = serde_json::to_value(Inline::Image(image.clone())).unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "type": "image", "src": "a.png", "alt": "", "width": 32.0, "height": "50%" })
        );
        assert_eq!(
            serde_json::from_value::<Inline>(json).unwrap(),
            Inline::Image(image)
        );
        // Strings as HTML writes them are read too; other values are not.
        let read = |v: serde_json::Value| serde_json::from_value::<ImageLength>(v).ok();
        assert_eq!(
            read(serde_json::json!("24px")),
            Some(ImageLength::Points(Points(24.0)))
        );
        assert_eq!(
            read(serde_json::json!("24")),
            Some(ImageLength::Points(Points(24.0)))
        );
        assert_eq!(read(serde_json::json!(-1)), None);
        assert_eq!(read(serde_json::json!("auto")), None);
        // No size is left out.
        assert_eq!(
            serde_json::to_value(Image::new("a.png")).unwrap(),
            serde_json::json!({ "src": "a.png", "alt": "" })
        );
    }

    #[test]
    fn highlight_colors_are_optional() {
        let marked: Inline = serde_json::from_value(serde_json::json!({
            "type": "highlight", "content": [{ "type": "text", "text": "x" }]
        }))
        .unwrap();
        assert_eq!(
            marked,
            Inline::Highlight {
                content: vec![Inline::text("x")],
                color: None
            }
        );
        let json = serde_json::to_value(Inline::Highlight {
            content: vec![],
            color: Some("#336699".into()),
        })
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "type": "highlight", "content": [], "color": "#336699" })
        );
    }
}
