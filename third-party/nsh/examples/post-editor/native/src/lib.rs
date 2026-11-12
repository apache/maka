//! The short post editor's crate (`examples/post-editor`): the three inline
//! atoms a post holds beside its text (`securityTag`, `mention`, `hashtag`:
//! [`tags`]) as rich editor extensions `App.tsx` gets with
//! `richExtension("securityTag")`, and the weighted length of the text
//! ([`weighted`]) as the module `PostLength`.

mod tags;
mod weighted;

use nsh_base::rich_editor::extensions::RichExtensionRegistry;
use nsh_core::prelude::*;

pub use crate::{
    tags::{hashtag, mention, security_tag, suggestions},
    weighted::{
        content_max_length, html_text, is_zh_locale, trim_to_weighted_limit, weighted_length,
    },
};

/// How long a post's text is, by the rule the server enforces.
#[module]
pub struct PostLength;

#[module]
impl PostLength {
    /// The weighted length of `text`: in a Chinese locale a Han character,
    /// Chinese punctuation or an emoji weighs 1 and ASCII 0.5, in any other
    /// locale 1 and 2; the sum rounds up.
    pub fn of_text(text: String, locale: String) -> u32 {
        weighted_length(&text, &locale)
    }

    /// The weighted length of the text of `html`, as the web editor counts
    /// the post it is about to send.
    pub fn of_html(html: String, locale: String) -> u32 {
        weighted_length(&html_text(&html), &locale)
    }

    /// The most a post may weigh in `locale`: 1000 in a Chinese one, 2000 in
    /// any other.
    pub fn max(locale: String) -> u32 {
        content_max_length(&locale)
    }

    /// The start of `text` that weighs at most `limit`.
    pub fn trim(text: String, limit: u32, locale: String) -> String {
        trim_to_weighted_limit(&text, limit, &locale)
    }
}

/// The crate's UI set: what `App.tsx` imports from `post-editor/native`.
#[native_module("post-editor/native")]
fn native(registry: &mut Registry) {
    registry
        .module::<PostLength>()
        .rich_extension("securityTag", security_tag)
        .rich_extension("mention", mention)
        .rich_extension("hashtag", hashtag)
        .rich_extension("postSuggestions", suggestions);
}
