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

//! The context strip over the composer, as Claude Code's: a line the
//! composer's width directly above it, in an existing task (the new task's
//! draft keeps its project picker in the composer instead), with no fill
//! of its own. On the left the task's folder, a chip that hugs its folder
//! glyph, its name and a chevron and opens the project menu above it (the
//! header's folder button's entries), its glyph over the composer's "+"
//! glyph; then the current branch, muted, in mono; on the right the lines
//! all the task's changes add and delete, "+N −M" in the diff colours, in
//! a chip that opens the changes panel, or focuses it while open.
//!
//! The counts are the changes panel's All changes against its base: the
//! window's [`ChangeSummary`] reads them as the panel does, off the main
//! thread, when the panel would read (the task changing, a turn ending,
//! the window coming back to the front), and takes the panel's own reads
//! while it shows All changes. The last values stay while it reads. Not a
//! repository, no `git`, or a Host elsewhere: the name alone. No changes:
//! the name and the branch, no chip.
//!
//! The strip takes its one line's height whatever it knows yet, so the
//! transcript above it does not move as the counts arrive.
//!
//! The window reads nothing for it until the app gives it Git
//! ([`Workbench::read_changes_with`]); previews and tests without it show
//! the name alone.

use std::sync::Arc;

use gpui_kit::component::button::{Button, ButtonCustomVariant, ButtonVariants as _};
use gpui_kit::component::{ActiveTheme as _, Icon, Selectable as _, StyledExt as _, h_flex};
use gpui_kit::{
    AnyElement, AppContext as _, ClickEvent, Context, Entity, InteractiveElement as _, IntoElement,
    ParentElement as _, StatefulInteractiveElement as _, Styled as _, TestSupportExt as _, Window,
    div, prelude::FluentBuilder as _, relative, rems,
};
use review::git::GitRunner;
use review::{ChangeSummary, ChangeTotals};
use shared::copy::review as review_copy;
use shared::copy::{self, Locale};
use shared::icons::MakaIcon;
use shared::layout::COLUMN_MAX_WIDTH_REMS;
use shared::menu::{MenuPlacement, MenuSlot};
use shared::theme::{ActiveMakaPalette as _, tabular_nums, tinted_button};
use workspace::actions::ToggleReview;

use super::{PROJECT_MENU_MIN_WIDTH_REMS, Workbench};

/// The composer's padding (the conversation's dock, 12 px): the strip's
/// chips start and end where the composer's controls do.
const COMPOSER_INSET_REMS: f32 = 0.75;
/// The composer's "+": a 28 px button, its glyph 16 px in its middle. The
/// folder chip's glyph sits in a 16 px slot as far into the chip as the
/// "+" glyph is into its button, so the two glyphs share a centre line.
const ATTACH_GLYPH_INSET_REMS: f32 = (1.75 - 1.) / 2.;

/// The strip's state in the window.
pub(crate) struct ContextStrip {
    /// What the strip says of the selected task's repository.
    pub(super) summary: Entity<ChangeSummary>,
    /// The project menu, opened from the folder's name, above it.
    menu: MenuSlot,
}

impl ContextStrip {
    pub(crate) fn new(cx: &mut Context<Workbench>) -> Self {
        Self {
            summary: cx.new(|_| ChangeSummary::new()),
            menu: MenuSlot::new(MenuPlacement::Above),
        }
    }
}

impl Workbench {
    /// What the context strip says of the selected task's repository.
    pub fn change_summary(&self) -> &Entity<ChangeSummary> {
        &self.strip.summary
    }

    /// Reads the strip's counts with `git` from now on (the system's in the
    /// app, a fake in tests), starting now.
    pub fn read_changes_with(&mut self, git: Arc<dyn GitRunner>, cx: &mut Context<Self>) {
        self.strip.summary.update(cx, |summary, cx| {
            summary.set_git_runner(git);
            summary.refresh(cx);
        });
    }

    /// The project menu opened from the strip, while it is open.
    pub fn strip_menu_open(&self) -> bool {
        self.strip.menu.is_open()
    }

    /// The strip's chip: shows the selected task's changes in the workbar
    /// and gives them the focus.
    fn open_changes_from_strip(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.show_changes(window, cx);
        self.review_panel().update(cx, |panel, cx| panel.focus_files(window, cx));
        cx.notify();
    }

    /// The strip above the composer, in the composer's column, for an
    /// existing task; `None` in the new task's draft.
    pub(super) fn render_context_strip(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        self.catalog.read(cx).selected_id()?;
        let maka = cx.maka();
        let locale = Locale::current(cx);
        let totals = self.strip.summary.read(cx).totals().cloned();
        let name = self.task_folder(cx).map(|folder| folder.name);
        let branch = totals.as_ref().and_then(|totals| totals.current_branch.clone());
        let chip = totals.filter(ChangeTotals::has_changes);
        let strip = h_flex()
            .id("context-strip")
            .test_support()
            .w_full()
            .max_w(rems(COLUMN_MAX_WIDTH_REMS))
            .mx_auto()
            .h_8()
            .px(rems(COMPOSER_INSET_REMS))
            .gap_1()
            .text_xs()
            .children(name.map(|name| self.render_strip_name(name, cx)))
            .when_some(branch, |this, branch| {
                this.child(
                    div()
                        .id("context-strip-branch")
                        .test_support()
                        .aria_label(branch.clone())
                        .flex_shrink_0()
                        .max_w(relative(0.45))
                        .px_1()
                        .truncate()
                        .font_family(cx.theme().mono_font_family.clone())
                        .text_color(maka.ink_muted)
                        .child(branch),
                )
            })
            .child(div().flex_1().min_w_0())
            .when_some(chip, |this, totals| {
                let label = copy::parts(
                    locale,
                    &[
                        review_copy::OPEN_CHANGES.get(cx),
                        &review_copy::added_lines(locale, totals.additions as usize),
                        &review_copy::deleted_lines(locale, totals.deletions as usize),
                    ],
                );
                let count = |count: u32| copy::memory::grouped(count as usize);
                this.child(
                    tinted_button(Button::new("context-strip-changes"), maka.ink, maka.badge, cx)
                        .flex_shrink_0()
                        .h_6()
                        .px_2()
                        .rounded_full()
                        .font_features(tabular_nums())
                        .accessibility_label(label)
                        .tooltip_with_action(review_copy::CHANGES.get(cx), &ToggleReview, None)
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.open_changes_from_strip(window, cx);
                        }))
                        .child(
                            h_flex()
                                .gap_1p5()
                                .text_xs()
                                .child(
                                    div()
                                        .text_color(maka.success)
                                        .child(format!("+{}", count(totals.additions))),
                                )
                                .child(
                                    div()
                                        .text_color(maka.destructive)
                                        .child(format!("−{}", count(totals.deletions))),
                                ),
                        ),
                )
            });
        Some(
            div()
                .id("context-strip-row")
                .flex_shrink_0()
                .w_full()
                .px_6()
                .child(strip)
                .into_any_element(),
        )
    }

    /// The task's folder, the first thing the strip gives up width for: a
    /// 28 px chip that hugs the folder glyph, the name and a chevron and
    /// opens the project menu above it. It sits on the composer's surface
    /// sunk a step, as the segmented track is: in dark the ink wash, not
    /// the sunken tier, which would be the darkest surface on screen.
    fn render_strip_name(
        &self,
        name: gpui_kit::SharedString,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let maka = cx.maka();
        let tip = copy::PROJECT_INFO.get(cx);
        let (fill, hover, press) = if cx.theme().is_dark() {
            let fill = maka.wash;
            (fill, maka.ink.opacity(fill.a + 0.05), maka.ink.opacity(fill.a + 0.1))
        } else {
            (maka.sunken, maka.sunken.blend(maka.hover), maka.sunken.blend(maka.selected))
        };
        div()
            .relative()
            .min_w_0()
            .flex_shrink(1.)
            .child(
                Button::new("context-strip-project")
                    .custom(
                        ButtonCustomVariant::new(cx)
                            .color(fill)
                            .foreground(maka.ink)
                            .hover(hover)
                            .active(press)
                            .shadow(false),
                    )
                    .bg(fill)
                    .h_7()
                    .pl(rems(ATTACH_GLYPH_INSET_REMS))
                    .pr_2()
                    .min_w_0()
                    .max_w_full()
                    .rounded_full()
                    .accessibility_label(name.clone())
                    .tooltip(tip)
                    .selected(self.strip.menu.is_open())
                    .on_click(cx.listener(|this, event: &ClickEvent, window, cx| {
                        let width = window.rem_size() * PROJECT_MENU_MIN_WIDTH_REMS;
                        MenuSlot::toggle(
                            this,
                            |this| &mut this.strip.menu,
                            event,
                            |this, cx| this.project_menu_entries(cx),
                            width,
                            window,
                            cx,
                        );
                    }))
                    .child(
                        h_flex()
                            .min_w_0()
                            .gap_1p5()
                            .child(
                                h_flex()
                                    .id("context-strip-folder")
                                    .test_support()
                                    .flex_none()
                                    .size_4()
                                    .justify_center()
                                    .child(
                                        Icon::new(MakaIcon::Folder)
                                            .size_3p5()
                                            .text_color(maka.ink_muted),
                                    ),
                            )
                            .child(
                                div()
                                    .min_w_0()
                                    .truncate()
                                    .text_xs()
                                    .font_medium()
                                    .text_color(maka.ink)
                                    .child(name),
                            )
                            .child(
                                Icon::new(MakaIcon::ChevronDown)
                                    .size_3p5()
                                    .flex_none()
                                    .text_color(maka.ink_muted),
                            ),
                    ),
            )
            .children(self.strip.menu.layer())
            .into_any_element()
    }
}
