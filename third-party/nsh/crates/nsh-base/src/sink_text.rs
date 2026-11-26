//! The text editors' sink: the invisible native input at the caret that
//! takes typed text and input methods for `Editor` and `RichEditor`. Its
//! changes are replayed at the editor's caret, which stands at a place in
//! the sink's text: its end, unless the platform moved the sink's own caret
//! (an input method that types a pair of brackets and puts its caret
//! between them).

/// What a change of the sink's text does at the editor's caret.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SinkEdit {
    /// Characters deleted before the caret.
    pub backspaces: usize,
    /// Characters deleted after it.
    pub deletes: usize,
    /// The text typed in their place.
    pub inserted: String,
    /// Where the editor's caret is in the new text afterwards (bytes).
    pub caret: usize,
}

/// The change from `old` to `new` with the editor's caret at byte `caret`
/// of `old`: what the two have in common at their start (up to the caret)
/// and at their end (from the caret on) stays, the rest is replaced. Text
/// that reads the same either way is kept on the caret's side, so a
/// character typed at the caret is inserted there, not where a prefix-only
/// comparison would put it.
pub(crate) fn sink_edit(old: &str, caret: usize, new: &str) -> SinkEdit {
    let caret = floor_char(old, caret.min(old.len()));
    let prefix = common_prefix(old, new).min(caret);
    let room = old.len() - caret;
    let suffix = common_suffix(&old[prefix..], &new[prefix..]).min(room);
    let (deleted, inserted) = (
        &old[prefix..old.len() - suffix],
        &new[prefix..new.len() - suffix],
    );
    let before = caret - prefix;
    SinkEdit {
        backspaces: deleted[..before].chars().count(),
        deletes: deleted[before..].chars().count(),
        inserted: inserted.to_owned(),
        caret: prefix + inserted.len(),
    }
}

/// The byte offset of UTF-16 offset `units` in `text`, or `None` past its
/// end or inside a character.
pub(crate) fn utf16_to_byte(text: &str, units: usize) -> Option<usize> {
    let mut at = 0;
    for (i, c) in text.char_indices() {
        if at == units {
            return Some(i);
        }
        at += c.len_utf16();
        if at > units {
            return None;
        }
    }
    (at == units).then_some(text.len())
}

/// The length in bytes of the common start of `a` and `b`, on a character
/// boundary.
pub(crate) fn common_prefix(a: &str, b: &str) -> usize {
    a.char_indices()
        .zip(b.chars())
        .find(|((_, x), y)| x != y)
        .map(|((i, _), _)| i)
        .unwrap_or_else(|| a.len().min(b.len()))
}

/// The length in bytes of the common end of `a` and `b`, on a character
/// boundary.
fn common_suffix(a: &str, b: &str) -> usize {
    a.chars()
        .rev()
        .zip(b.chars().rev())
        .take_while(|(x, y)| x == y)
        .map(|(x, _)| x.len_utf8())
        .sum()
}

fn floor_char(text: &str, mut at: usize) -> usize {
    while !text.is_char_boundary(at) {
        at -= 1;
    }
    at
}

#[cfg(test)]
mod tests {
    use super::*;

    fn edit(backspaces: usize, deletes: usize, inserted: &str, caret: usize) -> SinkEdit {
        SinkEdit {
            backspaces,
            deletes,
            inserted: inserted.to_owned(),
            caret,
        }
    }

    #[test]
    fn typing_at_the_end() {
        assert_eq!(sink_edit("ab", 2, "abc"), edit(0, 0, "c", 3));
        assert_eq!(sink_edit("", 0, "（）"), edit(0, 0, "（）", 6));
        assert_eq!(sink_edit("abc", 3, "ab"), edit(1, 0, "", 2));
        // Autocorrection replaces the word before the caret.
        assert_eq!(sink_edit("teh", 3, "the"), edit(2, 0, "he", 3));
    }

    #[test]
    fn typing_where_the_sink_caret_was_moved() {
        // An input method typed "（）" and put its caret between them.
        assert_eq!(sink_edit("（）", 3, "（中）"), edit(0, 0, "中", 6));
        assert_eq!(sink_edit("（中）", 6, "（中文）"), edit(0, 0, "文", 9));
        // A character equal to the closing one goes in at the caret too.
        assert_eq!(sink_edit("（）", 3, "（））"), edit(0, 0, "）", 6));
        // Backspace between them.
        assert_eq!(sink_edit("（中）", 6, "（）"), edit(1, 0, "", 3));
    }

    #[test]
    fn deleting_after_the_caret() {
        // The sink's caret moved left before its text lost the end.
        assert_eq!(sink_edit("abc", 2, "ab"), edit(0, 1, "", 2));
        assert_eq!(sink_edit("abc", 1, "axc"), edit(0, 1, "x", 2));
    }

    #[test]
    fn utf16_offsets() {
        assert_eq!(utf16_to_byte("（中）", 1), Some(3));
        assert_eq!(utf16_to_byte("（中）", 3), Some(9));
        assert_eq!(utf16_to_byte("（中）", 4), None);
        assert_eq!(utf16_to_byte("a😀b", 2), None);
        assert_eq!(utf16_to_byte("a😀b", 3), Some(5));
        assert_eq!(utf16_to_byte("", 0), Some(0));
    }

    #[test]
    fn common_prefixes_stop_on_char_boundaries() {
        assert_eq!(common_prefix("abc", "abd"), 2);
        assert_eq!(common_prefix("ab", "abc"), 2);
        assert_eq!(common_prefix("中a", "中b"), 3);
        assert_eq!(common_prefix("", "x"), 0);
    }
}
