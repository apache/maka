/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

//! The scopes section under the tree: what the panel can show, one row
//! each, in a list that draws only the rows in view. Where Git works, All
//! changes and Uncommitted changes; then the turns of the task that edited
//! files, newest first, under their group's heading, and while the task's
//! earlier history is read, a quiet line under them that says so; then the
//! branch's commits under Claude Code's "Commits 126" heading. Where Git
//! does not work, the turns alone. The scope shown is filled; choosing a
//! row shows its changes. One Tab stop, ↑ and ↓ choose.

use gpui_kit::component::spinner::Spinner;

use super::*;

/// A group of the scopes list, by its heading.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Group {
    Turns,
    Commits,
}

/// One row of the scopes list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum ScopeRow {
    /// All changes, or Uncommitted changes.
    Git(ReviewScope),
    Heading(Group),
    /// A turn, by its place in the turn list (oldest first).
    Turn(usize),
    /// Under the turns: earlier turns are being read.
    ReadingTurns,
    /// A commit, by its place in the read's commits (newest first).
    Commit(usize),
}

impl ScopeRow {
    fn height(&self) -> f32 {
        match self {
            Self::Git(_) => ROW_REMS,
            Self::Heading(_) | Self::ReadingTurns => SCOPES_HEADING_REMS,
            Self::Turn(_) | Self::Commit(_) => COMMIT_ROW_REMS,
        }
    }
}

/// What the list's rows are: whether Git's scopes show, how many turns,
/// whether earlier turns are being read, and how many commits. The rows,
/// their order and their heights follow from it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct Layout {
    git: bool,
    turns: usize,
    reading: bool,
    commits: usize,
}

impl Layout {
    fn len(self) -> usize {
        let git = if self.git { 3 + self.commits } else { 0 };
        git + self.turn_rows()
    }

    /// The turns group's rows: its heading, the turns, and the reading line.
    fn turn_rows(self) -> usize {
        if self.turns == 0 && !self.reading {
            return 0;
        }
        1 + self.turns + usize::from(self.reading)
    }

    /// The row at `ix`.
    fn row(self, mut ix: usize) -> Option<ScopeRow> {
        if self.git {
            match ix {
                0 => return Some(ScopeRow::Git(ReviewScope::All)),
                1 => return Some(ScopeRow::Git(ReviewScope::Uncommitted)),
                _ => ix -= 2,
            }
        }
        if self.turn_rows() > 0 {
            if ix == 0 {
                return Some(ScopeRow::Heading(Group::Turns));
            }
            if ix <= self.turns {
                return Some(ScopeRow::Turn(self.turns - ix));
            }
            if self.reading && ix == self.turns + 1 {
                return Some(ScopeRow::ReadingTurns);
            }
            ix -= self.turn_rows();
        }
        if self.git {
            if ix == 0 {
                return Some(ScopeRow::Heading(Group::Commits));
            }
            if ix <= self.commits {
                return Some(ScopeRow::Commit(ix - 1));
            }
        }
        None
    }

    /// The place of `row`.
    fn ix_of(self, row: &ScopeRow) -> Option<usize> {
        let git = if self.git { 2 } else { 0 };
        let turns = self.turn_rows();
        Some(match row {
            ScopeRow::Git(ReviewScope::All) if self.git => 0,
            ScopeRow::Git(ReviewScope::Uncommitted) if self.git => 1,
            ScopeRow::Heading(Group::Turns) if turns > 0 => git,
            ScopeRow::Turn(turn) if *turn < self.turns => git + self.turns - turn,
            ScopeRow::ReadingTurns if self.reading => git + 1 + self.turns,
            ScopeRow::Heading(Group::Commits) if self.git => git + turns,
            ScopeRow::Commit(commit) if self.git && *commit < self.commits => {
                git + turns + 1 + commit
            }
            _ => return None,
        })
    }
}

impl ReviewPanel {
    pub(super) fn scope_layout(&self) -> Layout {
        let snapshot = self.snapshot();
        Layout {
            git: snapshot.is_some(),
            turns: self.turn_list.len(),
            reading: self.reading_turns,
            commits: snapshot.map_or(0, |snapshot| snapshot.commits.len()),
        }
    }

    /// The row of the scope shown: the shown turn's, else the Git scope's.
    fn shown_row(&self) -> Option<ScopeRow> {
        if let Some(turn) = self.turn_shown() {
            let ix = self.turn_list.iter().position(|listed| listed.turn_id() == turn.turn_id())?;
            return Some(ScopeRow::Turn(ix));
        }
        match &self.scope {
            ReviewScope::Commit(sha) => {
                let commits = &self.snapshot()?.commits;
                commits.iter().position(|commit| &commit.sha == sha).map(ScopeRow::Commit)
            }
            scope => Some(ScopeRow::Git(scope.clone())),
        }
    }

    /// Whether `row` is the scope shown, without searching the commits:
    /// what each row asks as it draws.
    fn is_shown(&self, row: &ScopeRow) -> bool {
        let turn = self.turn_shown().map(TurnChange::turn_id);
        match row {
            ScopeRow::Turn(ix) => {
                turn.is_some() && self.turn_list.get(*ix).map(TurnChange::turn_id) == turn
            }
            _ if turn.is_some() => false,
            ScopeRow::Git(scope) => self.scope == *scope,
            ScopeRow::Commit(ix) => match &self.scope {
                ReviewScope::Commit(sha) => self
                    .snapshot()
                    .and_then(|snapshot| snapshot.commits.get(*ix))
                    .is_some_and(|commit| &commit.sha == sha),
                _ => false,
            },
            ScopeRow::Heading(_) | ScopeRow::ReadingTurns => false,
        }
    }

    /// The section's own height in rems: its rows and the space under them.
    pub(super) fn scopes_height(&self) -> f32 {
        let layout = self.scope_layout();
        if layout.len() == 0 {
            return 0.;
        }
        (0..layout.len()).filter_map(|ix| layout.row(ix)).map(|row| row.height()).sum::<f32>() + 0.5
    }

    /// Shows the scope `step` choosable rows after the one shown (before,
    /// for a negative step), stopping at either end.
    pub(super) fn move_scope(&mut self, step: isize, window: &mut Window, cx: &mut Context<Self>) {
        let layout = self.scope_layout();
        let choosable: Vec<usize> = (0..layout.len())
            .filter(|ix| {
                !matches!(
                    layout.row(*ix),
                    Some(ScopeRow::Heading(_) | ScopeRow::ReadingTurns) | None
                )
            })
            .collect();
        let Some(last) = choosable.len().checked_sub(1) else { return };
        let shown = self.shown_row().and_then(|row| layout.ix_of(&row));
        let at = shown.and_then(|shown| choosable.iter().position(|ix| *ix == shown)).unwrap_or(0);
        let next = at.saturating_add_signed(step).min(last);
        if next == at && shown.is_some() {
            return;
        }
        let ix = choosable[next];
        self.scopes_scroll.scroll_to_item(ix, ScrollStrategy::Nearest);
        if let Some(row) = layout.row(ix) {
            self.choose_row(row, window, cx);
        }
    }

    /// Scrolls the list to the row of the scope shown.
    pub(super) fn reveal_scope(&self, _: &mut Context<Self>) {
        let layout = self.scope_layout();
        if let Some(ix) = self.shown_row().and_then(|row| layout.ix_of(&row)) {
            self.scopes_scroll.scroll_to_item(ix, ScrollStrategy::Nearest);
        }
    }

    fn choose_row(&mut self, row: ScopeRow, window: &mut Window, cx: &mut Context<Self>) {
        match row {
            ScopeRow::Git(scope) => self.choose_scope(scope, window, cx),
            ScopeRow::Commit(ix) => {
                let Some(commit) = self.snapshot().and_then(|snapshot| snapshot.commits.get(ix))
                else {
                    return;
                };
                let scope = ReviewScope::Commit(commit.sha.clone());
                self.choose_scope(scope, window, cx);
            }
            ScopeRow::Turn(ix) => {
                let Some(turn) = self.turn_list.get(ix) else { return };
                let id = turn.turn_id().clone();
                self.show_turn(id, None, cx);
            }
            ScopeRow::Heading(_) | ScopeRow::ReadingTurns => {}
        }
    }

    /// The section: its rows in a list that draws only those in view.
    pub(super) fn render_scopes(&self, cx: &mut Context<Self>) -> AnyElement {
        let maka = cx.maka();
        let sizes = self.scope_sizes.as_ref().map_or_else(Rc::default, |(_, sizes)| sizes.clone());
        v_flex()
            .flex_none()
            .w_full()
            .h(rems(self.scopes_height()))
            .max_h(relative(SCOPES_SHARE))
            .border_t_1()
            .border_color(maka.border_soft)
            .child(
                div()
                    .relative()
                    .flex_1()
                    .min_h_0()
                    .child(
                        div()
                            .id("review-scopes")
                            .test_support()
                            .role(Role::List)
                            .aria_label(copy::SCOPES.get(cx))
                            .track_focus(&self.scopes_focus)
                            .key_context(SCOPES_CONTEXT)
                            .on_action(cx.listener(|this, _: &NextScope, window, cx| {
                                this.move_scope(1, window, cx);
                            }))
                            .on_action(cx.listener(|this, _: &PreviousScope, window, cx| {
                                this.move_scope(-1, window, cx);
                            }))
                            .size_full()
                            .child(
                                v_virtual_list(
                                    cx.entity(),
                                    "review-scope-rows",
                                    sizes,
                                    |this, range, window, cx| {
                                        range
                                            .map(|ix| this.render_scope_row(ix, window, cx))
                                            .collect::<Vec<_>>()
                                    },
                                )
                                .track_scroll(&self.scopes_scroll)
                                // The rows' fills 8 px in from the plate's
                                // sides, their text on its 16 px line.
                                .px_2()
                                .pb_1(),
                            ),
                    )
                    .child(Scrollbar::vertical(&self.scopes_scroll)),
            )
            .into_any_element()
    }

    /// A group's heading row: its name and how many rows it holds; the
    /// turns' heading has no count while none is listed yet.
    fn render_heading(&self, group: Group, cx: &mut Context<Self>) -> AnyElement {
        let maka = cx.maka();
        let (id, label, count) = match group {
            Group::Turns => ("review-turns-heading", copy::EDITS_BY_TURN, self.turn_list.len()),
            Group::Commits => (
                "review-commits-heading",
                copy::COMMITS,
                self.snapshot().map_or(0, |snapshot| snapshot.commits.len()),
            ),
        };
        let label = label.get(cx);
        let count = (group == Group::Commits || count > 0).then_some(count);
        h_flex()
            .id(id)
            .test_support()
            .aria_label(match count {
                Some(count) => format!("{label} {count}"),
                None => label.to_owned(),
            })
            .flex_none()
            .w_full()
            .h(rems(SCOPES_HEADING_REMS))
            .px_2()
            .gap_2()
            .text_xs()
            .font_medium()
            .text_color(maka.ink_muted)
            .child(label)
            .when_some(count, |this, count| {
                this.child(
                    div().font_features(shared::theme::tabular_nums()).child(count.to_string()),
                )
            })
            .into_any_element()
    }

    /// The quiet line under the turns while earlier turns are read: a
    /// spinner and what it waits for, in the heading's muted small type.
    fn render_reading_turns(&self, cx: &mut Context<Self>) -> AnyElement {
        let maka = cx.maka();
        let label = copy::READING_EARLIER_TURNS.get(cx);
        h_flex()
            .id("review-turns-reading")
            .test_support()
            .role(Role::Status)
            .aria_label(label)
            .flex_none()
            .w_full()
            .h(rems(SCOPES_HEADING_REMS))
            .px_2()
            .gap_2()
            .text_xs()
            .text_color(maka.ink_muted)
            .child(Spinner::new().xsmall().color(maka.ink_muted))
            .child(label)
            .into_any_element()
    }

    /// The list's row `ix`: All changes, Uncommitted changes, a group's
    /// heading, a turn (its prompt over its files, lines and time) or a
    /// commit (its subject over its hash, author and time); filled while it
    /// is the scope shown.
    fn render_scope_row(&self, ix: usize, window: &Window, cx: &mut Context<Self>) -> AnyElement {
        let maka = cx.maka();
        let locale = Locale::current(cx);
        let Some(row) = self.scope_layout().row(ix) else { return div().into_any_element() };
        let selected = self.is_shown(&row);
        let line = |text: SharedString| {
            div()
                .min_w_0()
                .truncate()
                .text_sm()
                .text_color(maka.ink)
                .when(selected, |this| this.font_medium())
                .child(text)
                .into_any_element()
        };
        let meta = || h_flex().min_w_0().gap_1().text_xs().text_color(maka.ink_muted);
        let (id, label, content) = match &row {
            ScopeRow::Heading(group) => return self.render_heading(*group, cx),
            ScopeRow::ReadingTurns => return self.render_reading_turns(cx),
            ScopeRow::Git(scope) => {
                let (key, label) = match scope {
                    ReviewScope::Uncommitted => ("uncommitted", copy::UNCOMMITTED_CHANGES),
                    _ => ("all", copy::ALL_CHANGES),
                };
                let label = label.get(cx);
                (domain_element_id("review-scope", key), label.to_owned(), line(label.into()))
            }
            ScopeRow::Turn(turn_ix) => {
                let Some(turn) = self.turn_list.get(*turn_ix) else {
                    return div().into_any_element();
                };
                let (now, offset) = self.turns_at;
                let when = shared::time::compact_timestamp(locale, turn.started_at(), now, offset);
                let files = copy::turn_files(locale, turn.files().len());
                let (added, deleted) = turn.totals();
                let prompt: SharedString = if turn.prompt().is_empty() {
                    copy::UNTITLED_TURN.get(cx).into()
                } else {
                    turn.prompt().clone()
                };
                let counts = shared::copy::parts(
                    locale,
                    &[
                        &copy::added_lines(locale, added as usize),
                        &copy::deleted_lines(locale, deleted as usize),
                    ],
                );
                let label = shared::copy::parts(locale, &[&prompt, &files, &counts, &when]);
                let content = v_flex()
                    .min_w_0()
                    .child(line(prompt))
                    .child(
                        meta()
                            .child(div().flex_none().child(files))
                            .child(div().flex_none().child("·"))
                            .when(added > 0, |this| {
                                this.child(
                                    div()
                                        .flex_none()
                                        .font_features(shared::theme::tabular_nums())
                                        .text_color(maka.success)
                                        .child(format!("+{added}")),
                                )
                            })
                            .when(deleted > 0, |this| {
                                this.child(
                                    div()
                                        .flex_none()
                                        .font_features(shared::theme::tabular_nums())
                                        .text_color(maka.destructive)
                                        .child(format!("\u{2212}{deleted}")),
                                )
                            })
                            .when(added > 0 || deleted > 0, |this| {
                                this.child(div().flex_none().child("·"))
                            })
                            .child(div().min_w_0().truncate().child(when)),
                    )
                    .into_any_element();
                (domain_element_id("review-turn", turn.turn_id()), label, content)
            }
            ScopeRow::Commit(commit_ix) => {
                let commits = self.snapshot().map_or(&[][..], |snapshot| &snapshot.commits);
                let Some(commit) = commits.get(*commit_ix) else {
                    return div().into_any_element();
                };
                let (now, offset) = self.read_at;
                let when =
                    shared::time::compact_timestamp(locale, commit.timestamp_ms, now, offset);
                let meta_text = copy::commit_meta(&commit.short_sha, &commit.author, &when);
                let label = shared::copy::parts(locale, &[&commit.subject, &meta_text]);
                let content = v_flex()
                    .min_w_0()
                    .child(line(commit.subject.clone().into()))
                    .child(meta().child(div().min_w_0().truncate().child(meta_text)))
                    .into_any_element();
                (domain_element_id("review-commit", &commit.sha), label, content)
            }
        };
        let keyboard = self.scopes_focus.is_focused(window) && window.last_input_was_keyboard();
        let focus = self.scopes_focus.clone();
        div()
            .id(id)
            .test_support()
            .role(Role::ListItem)
            .aria_label(label)
            .aria_selected(selected)
            .flex_none()
            .w_full()
            .h(rems(row.height()))
            .px_2()
            .flex()
            .flex_col()
            .justify_center()
            .rounded(shared::theme::RADIUS_CONTROL)
            .map(|this| selectable_row(this, selected, cx))
            .when(selected && keyboard, |this| this.focus_ring_style(window, cx))
            .on_mouse_down(MouseButton::Left, move |_: &MouseDownEvent, window, cx| {
                window.prevent_default();
                focus.focus(window, cx);
            })
            .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
                this.choose_row(row.clone(), window, cx);
            }))
            .child(content)
            .into_any_element()
    }

    /// The list's row heights at `rem`, kept while neither the rem nor the
    /// rows change.
    pub(super) fn sync_scope_sizes(&mut self, rem: Pixels) {
        let layout = self.scope_layout();
        let key = (rem, layout);
        if self.scope_sizes.as_ref().is_some_and(|(at, _)| *at == key) {
            return;
        }
        let sizes = (0..layout.len())
            .filter_map(|ix| layout.row(ix))
            .map(|row| size(px(0.), rems(row.height()).to_pixels(rem)))
            .collect();
        self.scope_sizes = Some((key, Rc::new(sizes)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every row's place gives it back, headings and all.
    #[test]
    fn rows_and_places_agree() {
        for layout in [
            Layout { git: true, turns: 0, reading: false, commits: 3 },
            Layout { git: true, turns: 2, reading: false, commits: 0 },
            Layout { git: false, turns: 3, reading: false, commits: 0 },
            Layout { git: false, turns: 0, reading: false, commits: 0 },
            Layout { git: true, turns: 2, reading: true, commits: 2 },
            Layout { git: false, turns: 0, reading: true, commits: 0 },
        ] {
            let rows: Vec<ScopeRow> = (0..layout.len()).filter_map(|ix| layout.row(ix)).collect();
            assert_eq!(rows.len(), layout.len());
            for (ix, row) in rows.iter().enumerate() {
                assert_eq!(layout.ix_of(row), Some(ix), "{layout:?} {row:?}");
            }
        }
        let layout = Layout { git: true, turns: 2, reading: false, commits: 1 };
        let rows: Vec<ScopeRow> = (0..layout.len()).filter_map(|ix| layout.row(ix)).collect();
        assert_eq!(
            rows,
            [
                ScopeRow::Git(ReviewScope::All),
                ScopeRow::Git(ReviewScope::Uncommitted),
                ScopeRow::Heading(Group::Turns),
                ScopeRow::Turn(1),
                ScopeRow::Turn(0),
                ScopeRow::Heading(Group::Commits),
                ScopeRow::Commit(0),
            ]
        );
        // Earlier turns being read: the line goes under the oldest turn
        // listed, or under the heading alone.
        let layout = Layout { git: false, turns: 1, reading: true, commits: 0 };
        let rows: Vec<ScopeRow> = (0..layout.len()).filter_map(|ix| layout.row(ix)).collect();
        assert_eq!(
            rows,
            [ScopeRow::Heading(Group::Turns), ScopeRow::Turn(0), ScopeRow::ReadingTurns]
        );
        let layout = Layout { git: true, turns: 0, reading: true, commits: 0 };
        let rows: Vec<ScopeRow> = (0..layout.len()).filter_map(|ix| layout.row(ix)).collect();
        assert_eq!(
            rows,
            [
                ScopeRow::Git(ReviewScope::All),
                ScopeRow::Git(ReviewScope::Uncommitted),
                ScopeRow::Heading(Group::Turns),
                ScopeRow::ReadingTurns,
                ScopeRow::Heading(Group::Commits),
            ]
        );
    }
}
