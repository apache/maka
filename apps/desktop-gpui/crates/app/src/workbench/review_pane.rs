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

//! The changes panel beside the plate: Maka Desktop's right Workbar with
//! its `review` tool (`features/workbar`), for the selected task.
//!
//! Like Desktop's Workbar it is open or closed per task, remembered with
//! its width in the preferences; it follows the selected task, and a draft
//! (no task) has nothing to review. On a window with room it is its own
//! plate on the right, `width` wide (Desktop's 480 at first, from 340,
//! scaling with the UI font as the sidebar does), with a handle on its
//! edge that drags it as wide as leaves the conversation its least width,
//! Desktop's 400 px (`--maka-conversation-min-width`), which keeps the
//! composer's controls on one row and the transcript readable. When the
//! window cannot keep the composer's whole column beside the panel's
//! narrowest width, the panel goes below the plate, as Desktop's Workbar
//! goes below the conversation on a narrow window, 42% of the window's
//! height up to 360 px, with no handle. The sidebar's own rules (F13) are
//! untouched: it collapses at its breakpoint as before.
//!
//! Maximized (its bar's button, or ⇧Esc), the panel fills the plate below
//! the plate's header in the conversation's and the composer's place, which
//! keep their state, not drawn; the button, ⇧Esc or Esc in the panel give
//! them their place back. Each task remembers it with the panel's other
//! state.

use std::collections::BTreeSet;
use std::sync::Arc;

use conversation::ConversationEvent;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::{Icon, Selectable as _, Sizable as _, ThemeStyled as _};
use gpui_kit::{
    AnyElement, App, AppContext as _, ClickEvent, Context, DragMoveEvent, Empty, Entity,
    FocusHandle, InteractiveElement as _, IntoElement, ParentElement as _, Render, Role,
    StatefulInteractiveElement as _, Styled as _, Task, TestSupportExt as _, Window, div,
    prelude::FluentBuilder as _, px, rems,
};
use review::git::{ReviewScope, SystemGit};
use review::{ReviewPanel, ReviewPanelEvent, ReviewTarget, ToggleMaximized};
use session::LoadState;
use settings::{AppPreferences, DEFAULT_REVIEW_WIDTH, REVIEW_WIDTHS, clamp_review_width};
use shared::copy::review as copy;
use shared::icons::MakaIcon;
use shared::theme::{ActiveMakaPalette as _, RADIUS_MODAL};
use workspace::actions::ToggleReview;

use super::{
    DESIGN_PX_PER_REM, PLATE_INSET_REMS, PLATE_MIN_REMS, RESIZE_HANDLE_WIDTH, RESIZE_LARGE_STEP,
    RESIZE_STEP, WIDTH_SAVE_DELAY, Workbench,
};

/// Key context of the panel's edge while it has focus.
pub const REVIEW_RESIZE_CONTEXT: &str = "ReviewResize";

gpui_kit::actions!(
    maka_review,
    [
        /// Move the changes panel's edge 10 px toward the plate.
        WidenReviewStep,
        /// Move the changes panel's edge 10 px away from the plate.
        NarrowReviewStep,
        /// Move the changes panel's edge 50 px toward the plate.
        WidenReviewLargeStep,
        /// Move the changes panel's edge 50 px away from the plate.
        NarrowReviewLargeStep,
        /// Give the changes panel its default width.
        ResetReviewWidth,
    ]
);

/// The least the plate keeps beside the panel when the panel is dragged
/// wide: Desktop's `--maka-conversation-min-width`, 400 px, and the canvas
/// margin on either side of the plate (as in `PLATE_MIN_REMS`).
const PLATE_LEAST_REMS: f32 = 400. / DESIGN_PX_PER_REM + 2. * PLATE_INSET_REMS;

/// The height of the panel below the plate: Desktop's `min(42dvh, 360px)`.
const BELOW_HEIGHT_SHARE: f32 = 0.42;
const BELOW_MAX_HEIGHT_REMS: f32 = 360. / DESIGN_PX_PER_REM;

/// Where the panel goes.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum ReviewPlacement {
    /// On the right of the plate, this many rems wide.
    Beside(f32),
    /// Below the plate, the plate's width.
    Below,
}

impl ReviewPlacement {
    /// For a window `window_rems` wide whose sidebar column takes
    /// `column_rems`, a panel `width` wide (the preferences' pixels): beside
    /// the plate when its narrowest width leaves the plate the composer's
    /// whole column, at its width up to what leaves the conversation its
    /// least; else below.
    pub(crate) fn of(window_rems: f32, column_rems: f32, width: u16) -> Self {
        let beside = window_rems - column_rems - PLATE_INSET_REMS;
        let narrowest = f32::from(*REVIEW_WIDTHS.start()) / DESIGN_PX_PER_REM;
        if beside - PLATE_MIN_REMS < narrowest {
            return Self::Below;
        }
        Self::Beside((f32::from(width) / DESIGN_PX_PER_REM).min(beside - PLATE_LEAST_REMS))
    }
}

/// What a drag of the panel's edge carries: nothing; its moves set the
/// width.
#[derive(Debug, Clone, Copy)]
pub(crate) struct ReviewResize;

impl Render for ReviewResize {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        Empty
    }
}

/// The panel and what the window keeps about it.
pub(crate) struct ReviewPane {
    panel: Entity<ReviewPanel>,
    /// The width in the preferences' pixels, as dragged.
    width: u16,
    resizing: bool,
    /// The edge's handle, a Tab stop.
    resize_focus: FocusHandle,
    /// Whether a turn of the selected task ran at the last commit.
    turn_running: bool,
    _save_width: Option<Task<()>>,
}

impl ReviewPane {
    pub(crate) fn new(window: &mut Window, cx: &mut Context<Workbench>) -> Self {
        Self {
            panel: cx.new(|cx| ReviewPanel::new(Arc::new(SystemGit), window, cx)),
            width: AppPreferences::current(cx).review_width,
            resizing: false,
            resize_focus: cx.focus_handle().tab_stop(true).tab_index(1),
            turn_running: false,
            _save_width: None,
        }
    }
}

impl Workbench {
    /// Follows the panel's requests and what should read it again: the
    /// selected task's turn ending, and the window coming back to the
    /// front.
    pub(super) fn watch_review(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let panel = self.review.panel.clone();
        let subscriptions = [
            cx.subscribe_in(&panel, window, |this, _, event: &ReviewPanelEvent, window, cx| {
                match event {
                    ReviewPanelEvent::BaseBranchChanged { session_id, base_branch } => {
                        let (id, branch) = (session_id.to_string(), base_branch.clone());
                        AppPreferences::global(cx).update(cx, |preferences, cx| {
                            preferences.set_review_base_branch(&id, branch.clone(), cx);
                        });
                        // The strip counts against the same base: from the
                        // panel's next read of All changes, or its own.
                        let summary = this.strip.summary.clone();
                        summary.update(cx, |summary, _| summary.set_base_branch(branch));
                        if !this.review_feeds_strip(cx) {
                            summary.update(cx, |summary, cx| summary.refresh(cx));
                        }
                    }
                    ReviewPanelEvent::ChangesRead { session_id, totals } => {
                        let (id, totals) = (session_id.clone(), totals.clone());
                        this.strip
                            .summary
                            .update(cx, |summary, cx| summary.accept(&id, totals, cx));
                    }
                    ReviewPanelEvent::CloseRequested => this.set_review_open(false, window, cx),
                    ReviewPanelEvent::MaximizeRequested(maximized) => {
                        this.set_review_maximized(*maximized, window, cx);
                    }
                    _ => {}
                }
            }),
            cx.subscribe_in(
                &self.state.clone(),
                window,
                |this, state, _: &ConversationEvent, window, cx| {
                    let running = !matches!(
                        state.read(cx).turn_activity(),
                        conversation::TurnActivity::Idle | conversation::TurnActivity::Unavailable
                    );
                    let ended =
                        std::mem::replace(&mut this.review.turn_running, running) && !running;
                    if ended {
                        this.refresh_review(window, cx);
                    }
                },
            ),
            cx.observe(&self.strip.summary.clone(), |_, _, cx| cx.notify()),
            cx.observe_window_activation(window, |this, window, cx| {
                if window.is_window_active() {
                    this.refresh_review(window, cx);
                }
            }),
            // Desktop's `retain-sessions`: once the catalog is read, the
            // panel state of tasks it no longer lists goes.
            cx.observe(&self.catalog.clone(), |_, catalog, cx| {
                let catalog = catalog.read(cx);
                if *catalog.load_state() != LoadState::Loaded {
                    return;
                }
                let ids: BTreeSet<String> =
                    catalog.rows().iter().map(|row| row.id.to_string()).collect();
                AppPreferences::global(cx)
                    .update(cx, |preferences, cx| preferences.retain_review_tasks(&ids, cx));
            }),
        ];
        self._subscriptions.extend(subscriptions);
        self.sync_review_target(window, cx);
    }

    /// The changes panel.
    pub fn review_panel(&self) -> &Entity<ReviewPanel> {
        &self.review.panel
    }

    /// Whether the selected task's changes panel is open.
    pub fn review_open(&self, cx: &App) -> bool {
        self.catalog
            .read(cx)
            .selected_id()
            .is_some_and(|id| AppPreferences::global(cx).read(cx).is_review_open(id))
    }

    /// Whether the panel shows: open, beside the task view (not settings,
    /// a page, or a blocked Host's screen).
    pub(super) fn review_shown(&self, cx: &App) -> bool {
        self.settings.is_none()
            && self.page.is_none()
            && self.host.read(cx).blocker().is_none()
            && self.review_open(cx)
    }

    /// The panel's width in the preferences' pixels.
    pub fn review_width(&self) -> u16 {
        self.review.width
    }

    /// Where the panel goes in this window.
    pub(super) fn review_placement(&self, cx: &App) -> ReviewPlacement {
        let column = self.form_rems(self.shown_form, cx);
        ReviewPlacement::of(self.window_rems, column, self.review.width)
    }

    /// Opens the selected task's changes panel, or closes it (the header
    /// button, ⌃⇧G, Desktop's `toggleTool('review')`). With no task, or
    /// while settings cover the window, it does nothing, as Desktop's
    /// shortcut does without an active Session or behind the settings.
    pub(crate) fn toggle_review(
        &mut self,
        _: &ToggleReview,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.settings.is_some() || self.catalog.read(cx).selected_id().is_none() {
            return;
        }
        let open = !self.review_open(cx);
        if open && self.page.is_some() {
            let selected = self.catalog.read(cx).selected_id().cloned();
            self.leave_page(selected, window, cx);
        }
        self.set_review_open(open, window, cx);
    }

    /// Opens or closes the selected task's panel, remembering it for the
    /// task; opening reads its changes.
    pub(super) fn set_review_open(
        &mut self,
        open: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(id) = self.catalog.read(cx).selected_id().cloned() else { return };
        AppPreferences::global(cx)
            .update(cx, |preferences, cx| preferences.set_review_open(&id, open, cx));
        if open {
            self.sync_review_target(window, cx);
            self.refresh_review(window, cx);
        }
        cx.notify();
    }

    /// Points the panel and the context strip at the selected task (its
    /// folder, or a Host elsewhere), with the base branch remembered for
    /// it, and reads it if it is a different task (the panel only while it
    /// shows).
    pub(super) fn sync_review_target(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let remote = self.host.read(cx).is_remote();
        let target = self.catalog.read(cx).selected_row().map(|row| {
            if remote {
                ReviewTarget::remote(row.id.clone())
            } else {
                ReviewTarget::local(row.id.clone(), row.workspace_path.as_ref())
            }
        });
        let panel = self.review.panel.clone();
        self.sync_review_maximized(cx);
        if panel.read(cx).target() == target.as_ref() {
            return;
        }
        let base = target.as_ref().and_then(|target| {
            AppPreferences::global(cx).read(cx).review_base_branch(target.session_id())
        });
        self.strip.summary.update(cx, |summary, cx| {
            summary.set_target(target.clone(), base.clone(), cx);
        });
        panel.update(cx, |panel, cx| panel.set_target(target, base, window, cx));
        self.refresh_review(window, cx);
    }

    /// Whether the selected task's panel shows filling the plate, in the
    /// conversation's place: open, shown, and maximized for the task.
    pub fn review_maximized(&self, cx: &App) -> bool {
        self.review_shown(cx) && self.review_maximized_for_task(cx)
    }

    /// Whether the selected task's panel is maximized when it shows.
    fn review_maximized_for_task(&self, cx: &App) -> bool {
        self.catalog
            .read(cx)
            .selected_id()
            .is_some_and(|id| AppPreferences::global(cx).read(cx).is_review_maximized(id))
    }

    /// ⇧Esc: the shown panel fills the plate, or gives the conversation its
    /// place back. With the panel closed it does nothing.
    pub(crate) fn toggle_review_maximized(
        &mut self,
        _: &ToggleMaximized,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.review_shown(cx) {
            let maximized = !self.review_maximized(cx);
            self.set_review_maximized(maximized, window, cx);
        }
    }

    /// Maximizes the selected task's panel or restores it, remembering it
    /// for the task. Maximizing moves focus into the panel's file list, as
    /// the conversation and the composer leave the window (their state
    /// stays: they are only not drawn).
    pub(crate) fn set_review_maximized(
        &mut self,
        maximized: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(id) = self.catalog.read(cx).selected_id().cloned() else { return };
        AppPreferences::global(cx)
            .update(cx, |preferences, cx| preferences.set_review_maximized(&id, maximized, cx));
        self.sync_review_maximized(cx);
        if maximized {
            self.review.panel.update(cx, |panel, cx| panel.focus_files(window, cx));
        }
        cx.notify();
    }

    /// Tells the panel whether it is maximized, for its button.
    fn sync_review_maximized(&mut self, cx: &mut Context<Self>) {
        let maximized = self.review_maximized_for_task(cx);
        self.review.panel.update(cx, |panel, cx| panel.set_maximized(maximized, cx));
    }

    /// Gives the conversation its place back, for a command that needs the
    /// composer.
    pub(super) fn restore_review(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.review_maximized(cx) {
            self.set_review_maximized(false, window, cx);
        }
    }

    /// The panel filling the plate below its header, in the conversation's
    /// and the composer's place.
    pub(super) fn render_review_maximized(&self) -> AnyElement {
        div()
            .id("review-pane")
            .test_support()
            .flex_1()
            .min_h_0()
            .w_full()
            .child(self.review.panel.clone())
            .into_any_element()
    }

    /// Reads the panel's changes again while it shows, and the context
    /// strip's, unless the panel's read of All changes gives them.
    fn refresh_review(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.review_shown(cx) {
            self.review.panel.update(cx, |panel, cx| panel.refresh(window, cx));
        }
        if !self.review_feeds_strip(cx) {
            self.strip.summary.update(cx, |summary, cx| summary.refresh(cx));
        }
    }

    /// Whether the panel's reads tell the context strip its counts: while
    /// it shows All changes.
    fn review_feeds_strip(&self, cx: &App) -> bool {
        self.review_shown(cx) && *self.review.panel.read(cx).scope() == ReviewScope::All
    }

    /// The header's button for the panel: Desktop's `file-diff` glyph,
    /// pressed while the panel is open, named and tipped with its shortcut.
    pub(super) fn render_review_button(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        self.catalog.read(cx).selected_id()?;
        let label = copy::CHANGES.get(cx);
        let open = self.review_open(cx);
        Some(
            Button::new("review-toggle")
                .ghost()
                .small()
                .size_7()
                .flex_shrink_0()
                .icon(Icon::new(MakaIcon::FileDiff).size_4().text_color(cx.maka().ink_muted))
                .accessibility_label(label)
                .tooltip_with_action(label, &ToggleReview, None)
                .selected(open)
                .on_click(cx.listener(|this, _, window, cx| {
                    this.toggle_review(&ToggleReview, window, cx);
                }))
                .into_any_element(),
        )
    }

    /// The panel's own plate.
    pub(super) fn render_review_plate(&self, cx: &App) -> AnyElement {
        div()
            .id("review-pane")
            .test_support()
            .size_full()
            .min_w_0()
            .bg(cx.maka().plate)
            .rounded(RADIUS_MODAL)
            .child(self.review.panel.clone())
            .into_any_element()
    }

    /// `main` (the plate) with the panel beside it or below it.
    pub(super) fn with_review(
        &self,
        main: AnyElement,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let gap = rems(PLATE_INSET_REMS);
        match self.review_placement(cx) {
            ReviewPlacement::Beside(width) => gpui_kit::component::h_flex()
                .size_full()
                .items_stretch()
                .child(div().flex_1().min_w_0().h_full().child(main))
                .child(
                    div()
                        .w(gap)
                        .h_full()
                        .flex_shrink_0()
                        .relative()
                        .child(self.render_review_handle(window, cx)),
                )
                .child(
                    div()
                        .w(rems(width))
                        .h_full()
                        .flex_shrink_0()
                        .child(self.render_review_plate(cx)),
                )
                .into_any_element(),
            ReviewPlacement::Below => {
                let rem = window.rem_size();
                let height = (window.viewport_size().height / rem * BELOW_HEIGHT_SHARE)
                    .min(BELOW_MAX_HEIGHT_REMS);
                gpui_kit::component::v_flex()
                    .size_full()
                    .child(div().flex_1().min_h_0().w_full().child(main))
                    .child(div().h(gap).flex_shrink_0())
                    .child(
                        div()
                            .h(rems(height))
                            .w_full()
                            .flex_shrink_0()
                            .child(self.render_review_plate(cx)),
                    )
                    .into_any_element()
            }
        }
    }

    /// The handle on the panel's edge, in the gap between the plates, as
    /// the sidebar's: a 6 px hit area below the chrome band with the
    /// column-resize cursor, Desktop's grip on hover, focus or drag. A drag
    /// moves the edge from the narrowest width to what leaves the
    /// conversation its least; a double-click restores the default.
    /// Focused, Left and Right move the edge by 10 (Shift: 50), Enter
    /// restores it.
    fn render_review_handle(&self, window: &Window, cx: &mut Context<Self>) -> AnyElement {
        let maka = cx.maka();
        let dragging = self.review.resizing && cx.has_active_drag();
        let keyboard =
            self.review.resize_focus.is_focused(window) && window.last_input_was_keyboard();
        let pill = div()
            .w(px(3.))
            .h(rems(2.))
            .rounded_full()
            .bg(if dragging { maka.border_strong } else { maka.border })
            .when(!dragging && !keyboard, |this| {
                this.invisible().group_hover("review-resize", |this| this.visible())
            });
        div()
            .id("review-resize")
            .test_support()
            .role(Role::Splitter)
            .aria_label(copy::RESIZE_PANEL.get(cx))
            .track_focus(&self.review.resize_focus)
            .key_context(REVIEW_RESIZE_CONTEXT)
            .on_action(cx.listener(|this, _: &WidenReviewStep, window, cx| {
                this.step_review_width(RESIZE_STEP, window, cx);
            }))
            .on_action(cx.listener(|this, _: &NarrowReviewStep, window, cx| {
                this.step_review_width(-RESIZE_STEP, window, cx);
            }))
            .on_action(cx.listener(|this, _: &WidenReviewLargeStep, window, cx| {
                this.step_review_width(RESIZE_LARGE_STEP, window, cx);
            }))
            .on_action(cx.listener(|this, _: &NarrowReviewLargeStep, window, cx| {
                this.step_review_width(-RESIZE_LARGE_STEP, window, cx);
            }))
            .on_action(cx.listener(|this, _: &ResetReviewWidth, window, cx| {
                this.set_review_width(DEFAULT_REVIEW_WIDTH, window, cx);
            }))
            .absolute()
            .top(rems(super::CHROME_HEIGHT_REMS))
            .bottom_0()
            .left(window.rem_size() * (PLATE_INSET_REMS / 2.) - px(RESIZE_HANDLE_WIDTH / 2.))
            .w(px(RESIZE_HANDLE_WIDTH))
            .flex()
            .items_center()
            .justify_center()
            .group("review-resize")
            .cursor_col_resize()
            .when(keyboard, |this| this.focus_ring_style(window, cx))
            .on_drag(ReviewResize, |drag, _, _, cx| cx.new(|_| *drag))
            .on_click(cx.listener(|this, event: &ClickEvent, window, cx| {
                if event.click_count() >= 2 {
                    this.set_review_width(DEFAULT_REVIEW_WIDTH, window, cx);
                }
            }))
            .child(pill)
            .into_any_element()
    }

    /// A drag of the panel's edge to the pointer, which holds the handle in
    /// the middle of the gap between the plates.
    pub(super) fn drag_review_edge(
        &mut self,
        event: &DragMoveEvent<ReviewResize>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let rem = window.rem_size();
        let right = window.viewport_size().width - rem * PLATE_INSET_REMS;
        let edge = event.event.position.x + rem * (PLATE_INSET_REMS / 2.);
        let width = ((right - edge) / rem * DESIGN_PX_PER_REM).round().max(0.);
        self.review.resizing = true;
        // Within u16 once clamped.
        let width = width.min(f32::from(u16::MAX)) as u16;
        self.set_review_width(width, window, cx);
        cx.notify();
    }

    /// A drag of the edge ended.
    pub(super) fn end_review_drag(&mut self, cx: &mut Context<Self>) {
        if std::mem::take(&mut self.review.resizing) {
            cx.notify();
        }
    }

    /// Moves the edge by `step` of the preferences' pixels; a positive
    /// step widens the panel.
    fn step_review_width(&mut self, step: i32, window: &Window, cx: &mut Context<Self>) {
        let width = (i32::from(self.review.width) + step).clamp(0, i32::from(u16::MAX));
        // Within u16 once clamped.
        self.set_review_width(width as u16, window, cx);
    }

    /// Sets the panel's width, from its narrowest to what leaves the
    /// conversation its least width beside it, and saves it once it has
    /// stayed a moment.
    pub fn set_review_width(&mut self, width: u16, window: &Window, cx: &mut Context<Self>) {
        let rem = window.rem_size();
        let column = self.form_rems(self.shown_form, cx);
        let room =
            window.viewport_size().width / rem - column - PLATE_LEAST_REMS - PLATE_INSET_REMS;
        let room = (room * DESIGN_PX_PER_REM).floor().clamp(0., f32::from(u16::MAX));
        // Within u16 once clamped.
        let width = clamp_review_width(width.min(room as u16));
        if width == self.review.width {
            return;
        }
        self.review.width = width;
        cx.notify();
        self.review._save_width = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(WIDTH_SAVE_DELAY).await;
            this.update(cx, |this, cx| {
                let width = this.review.width;
                AppPreferences::global(cx)
                    .update(cx, |preferences, cx| preferences.set_review_width(width, cx));
            })
            .ok();
        }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// At the default font: the plate with the composer's column takes 49
    /// rems (784 px), with the least conversation 26 (400 px), the gap
    /// 0.5; both count the plate's margins.
    #[test]
    fn the_panel_goes_below_when_the_plate_would_lose_the_composers_width() {
        // A 1440 px window beside a 256 px sidebar: the panel takes its
        // 30 rems, up to the 47.5 that leave a 400 px conversation.
        assert_eq!(ReviewPlacement::of(90., 16., 480), ReviewPlacement::Beside(30.));
        assert_eq!(ReviewPlacement::of(90., 16., 1200), ReviewPlacement::Beside(47.5));
        assert_eq!(ReviewPlacement::of(120., 16., 1200), ReviewPlacement::Beside(75.));
        // Less room than the narrowest 340 px (21.25 rems) beside the
        // composer's column: below.
        assert_eq!(ReviewPlacement::of(85., 16., 480), ReviewPlacement::Below);
        // A collapsed sidebar gives the panel its room back.
        assert_eq!(ReviewPlacement::of(85., 0., 480), ReviewPlacement::Beside(30.));
    }
}
