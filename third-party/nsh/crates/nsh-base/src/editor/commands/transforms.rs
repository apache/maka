//! Commands that rewrite text in place: sorting lines, changing case,
//! trimming trailing whitespace and block comments.

use super::{
    super::buffer::{Bias, EditKind},
    Block, Editing, Outcome, Place, Plan,
};

/// The case [`super::Command::ChangeCase`] turns text to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum Case {
    /// `HELLO WORLD`.
    Upper,
    /// `hello world`.
    Lower,
    /// `Hello World`: each word's first letter upper case, the rest lower.
    Title,
}

impl Case {
    fn apply(self, text: &str) -> String {
        match self {
            Case::Upper => text.to_uppercase(),
            Case::Lower => text.to_lowercase(),
            Case::Title => title_case(text),
        }
    }
}

/// Each word's first letter upper case and the rest lower case; an
/// apostrophe inside a word (`don't`) does not start another one.
fn title_case(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_word = false;
    for c in text.chars() {
        if c.is_alphanumeric() {
            if in_word {
                out.extend(c.to_lowercase());
            } else {
                out.extend(c.to_uppercase());
            }
            in_word = true;
        } else {
            out.push(c);
            in_word = in_word && c == '\'';
        }
    }
    out
}

/// `at` moved back to a char boundary of `text`.
fn floor_boundary(text: &str, mut at: usize) -> usize {
    at = at.min(text.len());
    while !text.is_char_boundary(at) {
        at -= 1;
    }
    at
}

impl Editing<'_> {
    /// Sorts the lines of each run of selected lines (by code point, as
    /// written); a single caret sorts the whole text. A run of one line stays.
    pub(super) fn sort_lines(&mut self, descending: bool) -> Outcome {
        if self.options.read_only {
            return Outcome::Nothing;
        }
        let selections = self.selections.clone();
        let blocks = if selections.len() == 1 && selections.primary().is_empty() {
            vec![Block {
                first: 0,
                last: self.buffer.line_count() - 1,
                selections: selections.all().to_vec(),
            }]
        } else {
            self.blocks(&selections)
        };
        let mut plan = Plan::new(selections.primary_index());
        for block in blocks {
            let start = self.buffer.line_start(block.first);
            let end = self.buffer.line_end(block.last);
            let text = self.buffer.slice(start..end);
            let mut lines: Vec<&str> = text.split('\n').collect();
            lines.sort_unstable();
            if descending {
                lines.reverse();
            }
            let sorted = lines.join("\n");
            if block.first == block.last || sorted == text {
                for s in block.selections {
                    plan.follow(s);
                }
                continue;
            }
            let i = plan.edit(start..end, sorted.as_str());
            // The text keeps its length: offsets in the block keep their
            // place (on a char boundary of the new lines).
            let place = |offset: usize| {
                if (start..=end).contains(&offset) {
                    Place::New(i, floor_boundary(&sorted, offset - start))
                } else {
                    Place::Old(offset, Bias::Right)
                }
            };
            for s in block.selections {
                plan.select(place(s.anchor), place(s.head));
            }
        }
        self.commit(plan, EditKind::Other)
    }

    /// Changes the case of each selection (a caret: of its word), keeping
    /// it selected (a caret where it was, when the length stays).
    pub(super) fn change_case(&mut self, case: Case) -> Outcome {
        if self.options.read_only {
            return Outcome::Nothing;
        }
        let selections = self.selections.clone();
        let mut plan = Plan::new(selections.primary_index());
        for &s in selections.all() {
            let target = if s.is_empty() {
                self.word_at(s)
            } else {
                Some(s)
            };
            let Some(target) = target else {
                plan.follow(s);
                continue;
            };
            let text = self.buffer.slice(target.range());
            let changed = case.apply(&text);
            if changed == text {
                plan.follow(s);
                continue;
            }
            let len = changed.len();
            let same_length = len == text.len();
            let i = plan.edit(target.range(), changed.as_str());
            if s.is_empty() {
                let at = s.head - target.start();
                let at = if same_length && changed.is_char_boundary(at) {
                    at
                } else {
                    len
                };
                plan.caret(Place::New(i, at));
            } else {
                plan.select_inside(i, 0, len, s.is_reversed());
            }
        }
        self.commit(plan, EditKind::Other)
    }

    /// Removes the whitespace at the end of every line of the text.
    pub(super) fn trim_trailing_whitespace(&mut self) -> Outcome {
        if self.options.read_only {
            return Outcome::Nothing;
        }
        let selections = self.selections.clone();
        let mut plan = Plan::new(selections.primary_index());
        let text = self.buffer.text();
        let mut start = 0;
        for line in text.split('\n') {
            let kept = line.trim_end().len();
            if kept < line.len() {
                plan.edit(start + kept..start + line.len(), "");
            }
            start += line.len() + 1;
        }
        for &s in selections.all() {
            plan.follow(s);
        }
        self.commit(plan, EditKind::Other)
    }

    /// Wraps each selection (a caret: its line's text) in the language's
    /// block comment, or unwraps it; nothing for a language without one.
    pub(super) fn toggle_block_comments(&mut self) -> Outcome {
        if self.options.read_only {
            return Outcome::Nothing;
        }
        let Some((open, close)) = self.language.block_comment else {
            return Outcome::Nothing;
        };
        let selections = self.selections.clone();
        let mut plan = Plan::new(selections.primary_index());
        for &s in selections.all() {
            self.toggle_block_comment(&mut plan, s, open, close);
            plan.follow(s);
        }
        self.commit(plan, EditKind::Other)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn title_case_of_words() {
        assert_eq!(title_case("hello WORLD"), "Hello World");
        assert_eq!(title_case("foo_bar-baz"), "Foo_Bar-Baz");
        assert_eq!(title_case("it's 2nd"), "It's 2nd");
        assert_eq!(title_case("éCOLE"), "École");
        assert_eq!(title_case(""), "");
    }

    #[test]
    fn boundaries_floor() {
        assert_eq!(floor_boundary("日本", 4), 3);
        assert_eq!(floor_boundary("ab", 9), 2);
        assert_eq!(floor_boundary("ab", 1), 1);
    }
}
