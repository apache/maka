//! The document model, a port of `prosemirror-model`: a [`Schema`] of node
//! and mark types, content expressions compiled to [`ContentMatch`]
//! automata, immutable [`Node`]s sharing their structure, [`Fragment`]s,
//! [`Slice`]s, the replace algorithm (`Node::replace`) and resolved
//! positions ([`ResolvedPos`], [`NodeRange`]).
//!
//! Positions count as ProseMirror's do, except that a text counts its UTF-16
//! code units (what JavaScript's string lengths count, so positions match
//! ProseMirror's and the platforms' text APIs): a leaf node is 1, a node with
//! content its content's size plus its two boundaries. Texts are stored as
//! UTF-8 (`Arc<str>`) with their UTF-16 length cached; [`utf16_to_byte`]
//! converts an offset.

use std::collections::BTreeMap;

use serde_json::Value;

mod content;
mod dom;
mod fragment;
mod mark;
mod node;
mod resolved;
mod schema;
mod slice;
mod to_dom;

pub use content::ContentMatch;
pub use dom::{ClearMark, DomElement, DomNode, GetAttrs, ParseRule, RuleInput, Whitespace};
pub use fragment::Fragment;
pub use mark::{Mark, marks_kept_on_split};
pub use node::{ChildInfo, Node, NodeVisitor, ReplaceError};
pub use resolved::{NodeRange, PosError, ResolvedPos};
pub use schema::{
    AttrSpec, AttrType, MarkSpec, MarkType, NodeSpec, NodeType, Schema, SchemaError, SchemaSpec,
};
pub use slice::Slice;
pub use to_dom::{
    AttrParse, AttrRender, DomAttrValue, DomOutputSpec, DomRender, DomSource, TextRender,
    attr_value_text,
};

/// The attributes of a node or a mark: JSON values by name.
pub type Attrs = BTreeMap<String, Value>;

/// The number of UTF-16 code units of `text`.
pub fn utf16_len(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

/// The byte offset in `text` of the UTF-16 offset `offset`. An offset past the
/// end gives `text.len()`; one inside a surrogate pair rounds down to the
/// start of its character, so the result is always a char boundary.
pub fn utf16_to_byte(text: &str, offset: usize) -> usize {
    let mut units = 0;
    for (byte, ch) in text.char_indices() {
        let next = units + ch.len_utf16();
        if next > offset {
            return byte;
        }
        units = next;
    }
    text.len()
}

/// The part of `text` between the UTF-16 offsets `from` and `to`.
pub(crate) fn utf16_slice(text: &str, from: usize, to: usize) -> &str {
    let start = utf16_to_byte(text, from);
    let end = utf16_to_byte(text, to.max(from));
    &text[start..end]
}

#[cfg(test)]
pub(crate) mod test_schema;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf16_offsets() {
        let s = "a😀中b";
        assert_eq!(utf16_len(s), 5);
        assert_eq!(utf16_to_byte(s, 0), 0);
        assert_eq!(utf16_to_byte(s, 1), 1);
        assert_eq!(utf16_to_byte(s, 2), 1, "inside the pair rounds down");
        assert_eq!(utf16_to_byte(s, 3), 5);
        assert_eq!(utf16_to_byte(s, 4), 8);
        assert_eq!(utf16_to_byte(s, 5), 9);
        assert_eq!(utf16_to_byte(s, 9), 9);
        assert_eq!(utf16_slice(s, 1, 4), "😀中");
    }
}
