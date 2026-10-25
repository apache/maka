//! Commands that only select: the previous occurrence of the selected text,
//! and a selection split into its lines.

use super::{super::types::Selection, Editing, Outcome};

impl Editing<'_> {
    /// The mirror of `select_next_occurrence`: adds the occurrence before
    /// the primary selection (wrapping to the text's end) as the primary
    /// one; a caret selects its word first.
    pub(super) fn select_previous_occurrence(&mut self) -> Outcome {
        let primary = self.selections.primary();
        if primary.is_empty() {
            let Some(word) = self.word_at(primary) else {
                return Outcome::Nothing;
            };
            let mut all = self.selections.all().to_vec();
            all[self.selections.primary_index()] = word;
            return self.set_selections(all, self.selections.primary_index());
        }
        let needle = self.buffer.slice(primary.range());
        let text = self.buffer.text();
        let selected = |start: usize| {
            self.selections
                .all()
                .iter()
                .any(|s| s.start() == start && s.end() == start + needle.len())
        };
        let (start, end) = (primary.start(), primary.end());
        let before = text[..start]
            .rmatch_indices(needle.as_str())
            .map(|(i, _)| i);
        let wrapped = text[end..]
            .rmatch_indices(needle.as_str())
            .map(|(i, _)| end + i);
        let Some(found) = before.chain(wrapped).find(|&at| !selected(at)) else {
            return Outcome::Nothing;
        };
        let mut selections = self.selections.clone();
        selections.push(Selection::new(found, found + needle.len()));
        self.replace_selections(selections)
    }

    /// Each selection over several lines becomes one selection per line,
    /// of what it selected there (a caret on a line it covers only the line
    /// break of); a selection ending at a line's start leaves that line out.
    /// The primary one's last line is primary.
    pub(super) fn split_into_lines(&mut self) -> Outcome {
        let selections = self.selections.clone();
        let mut all = Vec::with_capacity(selections.len());
        let mut primary = 0;
        for (k, &s) in selections.all().iter().enumerate() {
            let first = self.buffer.line_of(s.start());
            let mut last = self.buffer.line_of(s.end());
            if last > first && s.end() == self.buffer.line_start(last) {
                last -= 1;
            }
            if first == last {
                all.push(s);
            } else {
                for line in first..=last {
                    let start = s.start().max(self.buffer.line_start(line));
                    let end = s.end().min(self.buffer.line_end(line));
                    all.push(Selection::new(start, end));
                }
            }
            if k == selections.primary_index() {
                primary = all.len() - 1;
            }
        }
        self.set_selections(all, primary)
    }
}
