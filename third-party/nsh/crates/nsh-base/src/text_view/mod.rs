//! `TextView`: a document of Markdown, HTML or the app's own blocks,
//! shown with the primitives (texts, views, images), styled by the app
//! part by part.

mod common;
pub mod document;
mod extension;
mod highlight;
mod html;
mod markdown;
mod parse;
mod parts;
mod view;

pub use self::{
    document::{
        Alert, Block, CodeBlock, ColumnAlign, CustomNode, Document, Footnote, Image, ImageLength,
        Inline, ListItem, Table, TableCell,
    },
    extension::{
        MarkdownExtension, MarkdownOptions, MarkdownPlugin, MarkdownPlugins, ParseContext, Parser,
        mdast,
    },
    parts::{PartStyle, TextViewClasses, TextViewPart, TextViewParts, TextViewStyles},
    view::{
        CodeHighlighter, TextView, TextViewCodeAction, TextViewCodeActionEvent, TextViewElement,
        TextViewEvent, TextViewImageContext, TextViewImageFlow, TextViewLabels,
        TextViewLinkPressEvent, TextViewLinkTarget, TextViewLinks, TextViewMath, TextViewProps,
        text_view,
    },
};
