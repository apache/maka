//! Adapters between documents and the formats apps store and exchange:
//! ProseMirror JSON ([`JsonFormat`]), plain text ([`PlainTextFormat`]) and
//! Markdown ([`MarkdownFormat`]), HTML ([`HtmlFormat`]: parse rules
//! through [`DomParser`], `to_dom` specs through [`DomSerializer`]), plus
//! the clipboard's text helpers.
//!
//! A format reads into the schema it is given and never assumes node
//! names of its own: Markdown maps its constructs to names an app can
//! change ([`MarkdownNames`], the starter schema's by default). Formats
//! other than JSON lose what they cannot express; [`DocFormat::is_lossless_for`]
//! tells whether a schema survives a round trip and
//! [`MarkdownFormat::losses`] lists what a given document would lose.

mod html;
mod html_out;
mod json;
mod markdown;
mod text;

use std::fmt;

pub use self::{
    html::{DomParser, ParseOptions},
    html_out::{DomSerializer, HtmlFormat, doc_to_html, fragment_to_html},
    json::{JsonFormat, RewrittenContent, rewrite_unknown_content},
    markdown::{MarkdownFormat, MarkdownNames},
    text::{PlainTextFormat, slice_from_text, slice_to_text},
};
use super::model::{Node, Schema};

/// A document format: reads text into a document of a schema and writes
/// documents back.
pub trait DocFormat {
    /// What reading or writing fails with.
    type Error;

    /// Reads `input` into a document of `schema`.
    fn parse(&self, schema: &Schema, input: &str) -> Result<Node, Self::Error>;

    /// Writes `doc` in this format.
    fn serialize(&self, doc: &Node) -> Result<String, Self::Error>;

    /// Whether every document of `schema` reads back equal after being
    /// written in this format.
    fn is_lossless_for(&self, schema: &Schema) -> bool;
}

/// Why a document could not be read or written.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum FormatError {
    /// The input is not valid JSON or not a document's JSON.
    Json(String),
    /// What was read does not fit the schema.
    Schema(String),
    /// The input could not be parsed as Markdown.
    Markdown(String),
}

impl fmt::Display for FormatError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Json(e) => write!(f, "invalid document JSON: {e}"),
            Self::Schema(e) => write!(f, "document does not fit the schema: {e}"),
            Self::Markdown(e) => write!(f, "invalid Markdown: {e}"),
        }
    }
}

impl std::error::Error for FormatError {}
