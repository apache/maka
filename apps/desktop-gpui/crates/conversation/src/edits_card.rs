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

//! The card under a settled turn that edited files, as Codex shows it
//! under a turn's last reply, without its undo: an icon tile, "Edited 4
//! files" over the lines they added and deleted, a "View changes" button,
//! and under a divider one row per file (its folder muted, then its name,
//! then its lines, or "New file" or "Deleted" where the counts are not
//! known), the first three at first and a button that shows the rest in
//! place and folds them away again. The rows keep a deletions' lane only
//! while a row the card shows deletes lines, so counts that only add end
//! where the "View changes" button does.
//!
//! The rows come from the window's worked-out turn changes
//! ([`transcript_model::edits::EditedTurns`]); the buttons ask the view's
//! owner to open the changes panel on the turn
//! ([`crate::ConversationViewEvent::ShowTurnChanges`]), at a file for a
//! file's row.

use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::{Icon, Sizable as _, h_flex, v_flex};
use gpui_kit::{
    AnyElement, App, FontWeight, InteractiveElement as _, IntoElement, ParentElement as _,
    SharedString, StatefulInteractiveElement as _, Styled as _, TestSupportExt as _,
    Transformation, WeakEntity, Window, div, percentage, prelude::FluentBuilder as _,
};
use shared::copy::conversation as copy;
use shared::copy::review as review_copy;
use shared::copy::{self as shell_copy, Locale};
use shared::domain_element_id;
use shared::icons::MakaIcon;
use shared::theme::{ActiveMakaPalette as _, plate_radius, quiet_button, tabular_nums};
use transcript_model::edits::{ChangeKind, EditedFile};

use crate::rows::EditsRow;
use crate::style::{LABEL_SIZE, RADIUS_CONTROL, RADIUS_MODAL, SUPPORTING_SIZE, dp, dp_px};
use crate::view::ConversationView;

/// The files the card lists before its "Show n more files".
pub(crate) const FILES_SHOWN: usize = 3;
/// The icon tile's side: 32 px, as Codex's.
const TILE: f32 = 32.;
/// A file row's height: 32 px, the control size.
const FILE_ROW: f32 = 32.;
/// A count's lane, so the figures of every row line up: four digits and a
/// sign at 12 px.
const COUNT_LANE: f32 = 40.;
/// The rows' inset from the card's edge, and their own side padding: the
/// two together put their text on the header's 12 px edge, and a row's
/// hover fill stays inside the card's rounded corners (12 − 4 ≈ the
/// control radius).
const ROWS_INSET: f32 = 4.;
const ROW_PADDING: f32 = 8.;

/// The card for `row`.
pub(crate) fn render_edits(
    row: EditsRow,
    view: WeakEntity<ConversationView>,
    window: &Window,
    cx: &App,
) -> AnyElement {
    let maka = cx.maka();
    let locale = Locale::current(cx);
    let count = row.files.len();
    let (added, deleted) =
        row.files.iter().filter_map(|file| file.counts).fold((0u32, 0u32), |(a, d), (add, del)| {
            (a.saturating_add(add), d.saturating_add(del))
        });
    let known = row.files.iter().any(|file| file.counts.is_some());
    let title = copy::edited_files(locale, count);
    // The raised tile of the changes panel's bar and the header's pressed
    // changes button, the `selected` fill: `sunken` is a hole in dark.
    let tile = div()
        .flex_none()
        .size(dp(TILE))
        .rounded(plate_radius(dp_px(TILE, window)))
        .bg(maka.selected)
        .flex()
        .items_center()
        .justify_center()
        .child(
            Icon::new(MakaIcon::FileDiff).with_size(dp_px(16., window)).text_color(maka.ink_muted),
        );
    let view_changes = {
        let (view, turn_id) = (view.clone(), row.turn_id.clone());
        quiet_button(Button::new("turn-edits-view"), cx)
            .flex_none()
            .label(copy::VIEW_CHANGES.get(cx))
            .on_click(move |_, _, cx| {
                view.update(cx, |view, cx| view.show_turn_changes(&turn_id, None, cx)).ok();
            })
    };
    let header = h_flex()
        .w_full()
        .px(dp(12.))
        .py(dp(10.))
        .gap(dp(10.))
        .child(tile)
        .child(
            v_flex()
                .flex_1()
                .min_w_0()
                .child(
                    div()
                        .id("turn-edits-title")
                        .test_support()
                        .aria_label(title.clone())
                        .truncate()
                        .text_size(dp(LABEL_SIZE))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(maka.ink)
                        .child(title),
                )
                .when(known, |this| {
                    let label = shell_copy::parts(
                        locale,
                        &[
                            &review_copy::added_lines(locale, added as usize),
                            &review_copy::deleted_lines(locale, deleted as usize),
                        ],
                    );
                    this.child(
                        h_flex()
                            .id("turn-edits-counts")
                            .test_support()
                            .aria_label(label)
                            .gap(dp(6.))
                            .text_size(dp(SUPPORTING_SIZE))
                            .font_features(tabular_nums())
                            .child(div().text_color(maka.success).child(format!("+{added}")))
                            .child(
                                div()
                                    .text_color(maka.destructive)
                                    .child(format!("\u{2212}{deleted}")),
                            ),
                    )
                }),
        )
        .child(view_changes);
    let shown = if row.expanded { count } else { count.min(FILES_SHOWN) };
    let deletions = row
        .files
        .iter()
        .take(shown)
        .any(|file| matches!(counts_of(file, cx), Counts::Lines(_, deleted) if deleted > 0));
    let rows = row
        .files
        .iter()
        .take(shown)
        .map(|file| file_row(file, deletions, &row.turn_id, &view, window, cx));
    let more = (count > FILES_SHOWN).then(|| {
        let (view, key) = (view.clone(), row.expansion_key.clone());
        let label = if row.expanded {
            copy::SHOW_FEWER_FILES.get(cx).to_owned()
        } else {
            copy::show_more_files(locale, count - FILES_SHOWN)
        };
        let mut chevron = Icon::new(MakaIcon::ChevronDown)
            .with_size(dp_px(14., window))
            .text_color(maka.ink_muted);
        if row.expanded {
            chevron = chevron.transform(Transformation::rotate(percentage(0.5)));
        }
        Button::new("turn-edits-more")
            .ghost()
            .w_full()
            .h(dp(FILE_ROW))
            .px(dp(ROW_PADDING))
            .rounded(dp_px(RADIUS_CONTROL, window))
            .accessibility_label(label.clone())
            .on_click(move |_, _, cx| {
                view.update(cx, |view, cx| view.toggle_edits(&key, cx)).ok();
            })
            .child(
                h_flex()
                    .w_full()
                    .gap(dp(6.))
                    .text_size(dp(SUPPORTING_SIZE))
                    .text_color(maka.ink_muted)
                    .child(label)
                    .child(chevron),
            )
    });
    v_flex()
        .w_full()
        .bg(maka.plate)
        .border_1()
        .border_color(maka.border)
        .rounded(dp(RADIUS_MODAL))
        .child(header)
        .child(div().w_full().h_px().bg(maka.border_soft))
        .child(v_flex().w_full().p(dp(ROWS_INSET)).children(rows).children(more))
        .into_any_element()
}

/// What a file's row says of its size: its lines, or what the turn did to
/// it where there are none to count.
fn counts_of(file: &EditedFile, cx: &App) -> Counts {
    // A created or deleted file without lines to count says what the turn
    // did to it instead.
    match (file.counts, file.kind) {
        (Some((added, deleted)), _) if added > 0 || deleted > 0 => Counts::Lines(added, deleted),
        (_, ChangeKind::Created) => Counts::Word(copy::NEW_FILE.get(cx)),
        (_, ChangeKind::Deleted) => Counts::Word(copy::DELETED_FILE.get(cx)),
        (Some((added, deleted)), _) => Counts::Lines(added, deleted),
        (None, _) => Counts::None,
    }
}

/// A file's row: its folder muted and its name, then its lines (or what
/// the turn did to it where they are not known), the deletions' lane only
/// with `deletions`; a button that opens the changes panel at it.
fn file_row(
    file: &EditedFile,
    deletions: bool,
    turn_id: &SharedString,
    view: &WeakEntity<ConversationView>,
    window: &Window,
    cx: &App,
) -> AnyElement {
    let maka = cx.maka();
    let locale = Locale::current(cx);
    let (folder, name) = match file.path.rsplit_once('/') {
        Some((folder, name)) => (format!("{folder}/"), name.to_owned()),
        None => (String::new(), file.path.clone()),
    };
    let counts = counts_of(file, cx);
    let counts_label = match counts {
        Counts::Lines(added, deleted) => shell_copy::parts(
            locale,
            &[
                &review_copy::added_lines(locale, added as usize),
                &review_copy::deleted_lines(locale, deleted as usize),
            ],
        ),
        Counts::Word(word) => word.to_owned(),
        Counts::None => String::new(),
    };
    let label = shell_copy::parts(locale, &[&file.path, &counts_label]);
    let lane = |text: Option<String>| {
        div()
            .flex_none()
            .min_w(dp(COUNT_LANE))
            .text_right()
            .when_some(text, |this, text| this.child(text))
    };
    let (view, turn_id, path) =
        (view.clone(), turn_id.clone(), SharedString::from(file.path.clone()));
    Button::new(domain_element_id("turn-edits-file", &file.path))
        .ghost()
        .w_full()
        .h(dp(FILE_ROW))
        .px(dp(ROW_PADDING))
        .rounded(dp_px(RADIUS_CONTROL, window))
        .accessibility_label(label)
        .on_click(move |_, _, cx| {
            let path = Some(path.clone());
            view.update(cx, |view, cx| view.show_turn_changes(&turn_id, path, cx)).ok();
        })
        .child(
            h_flex()
                .w_full()
                .min_w_0()
                .gap(dp(12.))
                .child(
                    h_flex()
                        .flex_1()
                        .min_w_0()
                        .text_size(dp(SUPPORTING_SIZE))
                        .child(
                            div()
                                .min_w_0()
                                .flex_shrink(1.)
                                .truncate()
                                .text_color(maka.ink_muted)
                                .child(folder),
                        )
                        .child(
                            div()
                                .flex_none()
                                .max_w_full()
                                .truncate()
                                .text_color(maka.ink)
                                .child(name),
                        ),
                )
                .child(
                    h_flex()
                        .id(domain_element_id("turn-edits-file-counts", &file.path))
                        .test_support()
                        .flex_none()
                        .gap(dp(4.))
                        .text_size(dp(SUPPORTING_SIZE))
                        .font_features(tabular_nums())
                        .map(|this| match counts {
                            Counts::Lines(added, deleted) => this
                                .child(
                                    lane((added > 0).then(|| format!("+{added}")))
                                        .text_color(maka.success),
                                )
                                .when(deletions, |this| {
                                    this.child(
                                        lane((deleted > 0).then(|| format!("\u{2212}{deleted}")))
                                            .text_color(maka.destructive),
                                    )
                                }),
                            Counts::Word(word) => {
                                this.child(div().text_color(maka.ink_muted).child(word))
                            }
                            Counts::None => this,
                        }),
                ),
        )
        .into_any_element()
}

/// What a file row says of its size.
#[derive(Clone, Copy)]
enum Counts {
    Lines(u32, u32),
    Word(&'static str),
    None,
}
