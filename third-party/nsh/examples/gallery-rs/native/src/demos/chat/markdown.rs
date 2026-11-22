//! A reply's Markdown, shown by `nsh/base`'s `TextView` at a chat's scale
//! (as the TSX gallery's `demos/chat/markdown.tsx`), code blocks with
//! `TextView`'s built-in copy action.
//!
//! While a reply streams, the view reads it as streaming Markdown (open
//! emphasis shows as closed) and makes again only the block being written;
//! the caret ends its last block. Every block is selectable: a long press
//! highlights it and offers Copy.

use nsh_base::{MarkdownOptions, TextViewCodeAction, TextViewPart, TextViewParts, text_view};
use nsh_core::{element::StyleRefinement, prelude::*};

use super::parts::caret;
use crate::ui::colors;

/// The parts at a chat's scale (tighter headings than a document's) and
/// in the gallery's code and link colors; the rest is `TextView`'s default
/// typography in the theme's colors. Text styles the reply's root sets (15
/// pt on 22, the text color) pass to every part.
fn parts() -> TextViewParts {
    use TextViewPart as P;
    let heading = |size: f32, line: f32| {
        move |s: StyleRefinement| s.text_size(px(size)).line_height(px(line))
    };
    TextViewParts::new()
        .part(P::Heading1, heading(20.0, 26.0))
        .part(P::Heading2, heading(17.0, 22.0))
        .part(P::Heading3, heading(15.0, 22.0))
        .part(P::Code, |s| s.text_color(colors::CODE))
        .part(P::CodeBlockCode, |s| s.text_color(colors::CODE))
}

/// The reply `md` gives. While `streaming` holds the Markdown is read as
/// still arriving and the caret ends it.
pub(crate) fn markdown(
    md: impl Fn() -> String + 'static,
    streaming: impl Fn() -> bool + 'static,
) -> impl IntoElement {
    provide_context(parts());
    let streaming = computed(streaming);
    text_view()
        .markdown(move || Some(SharedString::from(md())))
        .options(move || MarkdownOptions {
            streaming: streaming.get(),
            ..MarkdownOptions::default()
        })
        .selectable(true)
        .code_block_scrollbar(false)
        .code_block_actions(vec![
            TextViewCodeAction::new("copy").with_label("Copy code"),
        ])
        .streaming_caret(when(streaming, caret))
        .gap_3()
        .text_size(px(15.0))
        .line_height(px(22.0))
        .text_color(colors::TEXT)
}
