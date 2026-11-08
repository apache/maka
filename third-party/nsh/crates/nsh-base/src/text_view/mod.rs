//! `TextView`: a document of Markdown, HTML or the app's own blocks,
//! shown with the primitives (texts, views, images), styled by the app
//! part by part.

mod common;
pub mod document;
mod extension;
mod formula;
mod highlight;
mod html;
mod markdown;
#[cfg(feature = "math")]
mod math;
mod parse;
mod parts;
mod selection;
mod tex_text;
mod view;

/// Makes formulas typeset in a web runtime: the gate of its side module
/// (`nsh_feature_math`), which holds what this reaches and nothing else does.
#[cfg(all(feature = "math", target_arch = "wasm32"))]
#[doc(hidden)]
pub use self::formula::install as install_math;
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
    selection::{TextSelectionFormat, TextSelectionOptions},
    view::{
        CodeHighlighter, TextView, TextViewApi, TextViewCodeAction, TextViewCodeActionEvent,
        TextViewElement, TextViewEvent, TextViewImageContext, TextViewImageFlow, TextViewLabels,
        TextViewLinkPressEvent, TextViewLinkTarget, TextViewLinks, TextViewMath, TextViewProps,
        TextViewSelectionEvent, text_view,
    },
};
