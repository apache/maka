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

//! The Daily review tab, after Desktop's `DailyReviewPanel`
//! (packages/ui/src/daily-review-panel.tsx, its view state in
//! daily-review-view-state.ts and helpers in daily-review-helpers.ts) and
//! the page bridge behind it (`createDailyReviewBridge` and
//! `useDailyReviewController` in
//! apps/desktop/src/renderer/features/module-hub/controller/use-daily-review-controller.ts):
//! the activity of a day or the last 7 or 30 days, a generated report for
//! it (Generate analysis, View analysis), and the report's export: copy,
//! add to the composer's draft, save as a Markdown file.

use std::path::PathBuf;

use chrono::{DateTime, FixedOffset, Local, Offset as _, TimeZone};
use gpui_kit::assets::IconName as AssetIcon;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::notification::Notification;
use gpui_kit::component::skeleton::Skeleton;
use gpui_kit::component::text::{TextView, TextViewStyle};
use gpui_kit::component::{
    Disableable as _, Icon, IconName, Sizable as _, StyledExt as _, WindowExt as _, h_flex, v_flex,
};
use gpui_kit::{
    AnyElement, App, ClickEvent, ClipboardItem, Context, Entity, EventEmitter,
    InteractiveElement as _, IntoElement, ParentElement as _, SharedString,
    StatefulInteractiveElement as _, Styled as _, Subscription, Task, TestSupportExt as _, Window,
    div, prelude::FluentBuilder as _, relative, rems,
};
use host_protocol::{
    DAILY_REVIEW_PAGE_MAX_ITEMS, DailyReviewArchive, DailyReviewArchiveStatus,
    DailyReviewArchiveSummary, DailyReviewMutate, DailyReviewMutateInput, DailyReviewMutateResult,
    DailyReviewQuery, DailyReviewQueryInput, DailyReviewQueryResult, DailyReviewRange,
    DailyReviewSummary,
};
use shared::copy::automations as copy;
use shared::copy::{self as shell_copy, Locale, Text};
use shared::domain_element_id;
use shared::rows::{EmptyRow, list_row};
use shared::theme::{
    ActiveMakaPalette as _, HEADING_LINE_REMS, HEADING_TEXT_REMS, RADIUS_SURFACE, back_link,
    control_button, quiet_button, segment, segmented_track, tabular_nums,
};
use shared::time::relative_time;
use workspace::{HostRequester, HostSession, HostSessionEvent};

use crate::widgets::{empty_state, failure_text, heading, rows_with_rules};

/// The longest file written by Save (Desktop refuses larger exports).
const EXPORT_MAX_BYTES: usize = 1_000_000;

/// What the tab asks of the window it is in.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum DailyReviewEvent {
    /// Show this task (a row of the active tasks).
    OpenTask(SharedString),
    /// Add this text to the composer's draft.
    AppendToComposer(String),
    /// Show Settings at Daily review.
    OpenSettings,
}

/// A day or a range, and how far back it ends (`DailyReviewScope`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Scope {
    pub range: DailyReviewRange,
    /// 0 ends today, -1 yesterday; never ahead.
    pub offset_days: i64,
}

impl Scope {
    /// `shiftDailyReviewScope`: a day earlier or later, never past today.
    fn shift(self, direction: i64) -> Self {
        Self { offset_days: (self.offset_days + direction).min(0), ..self }
    }

    /// `formatScopeLabel`: "Today", "Yesterday", "3 days ago", "Last 7
    /// days (2 days earlier)".
    pub fn label(self, locale: Locale) -> String {
        if self.range == DailyReviewRange::Day {
            return match self.offset_days {
                0 => copy::DATE_TODAY.in_locale(locale).to_owned(),
                -1 => copy::DATE_YESTERDAY.in_locale(locale).to_owned(),
                offset => copy::days_ago(locale, offset.unsigned_abs()),
            };
        }
        let base = if self.range == DailyReviewRange::Week {
            copy::DATE_RECENT_7
        } else {
            copy::DATE_RECENT_30
        }
        .in_locale(locale);
        match self.offset_days {
            0 => base.to_owned(),
            offset => copy::shifted_range(locale, base, offset.unsigned_abs()),
        }
    }
}

/// The report list's state (`DailyReviewArchiveState`).
#[derive(Debug, Clone, PartialEq)]
enum Archives {
    Loading,
    Ready(Vec<DailyReviewArchiveSummary>),
    Failed,
}

/// The action in flight: one at a time, as in Desktop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Pending {
    Open,
    Generate,
    Copy,
    Append,
    Save,
}

/// Behavior and presentation owner of the Daily review tab: the scope
/// chosen, the summary last resolved (kept on screen while another scope
/// loads), the report list, the report shown, and the one action in
/// flight. Reads start the first time the tab shows, and again when the
/// scope changes, on Retry, and on every new connection while it has
/// shown.
pub struct DailyReviewView {
    host: Entity<HostSession>,
    selection: Scope,
    /// The scope and summary last read (`resolvedView`).
    resolved: Option<(Scope, Box<DailyReviewSummary>)>,
    /// The scope being read (`pendingScopeKey`).
    pending_scope: Option<Scope>,
    error: bool,
    archives: Archives,
    /// The report shown instead of the activity.
    report: Option<Box<DailyReviewArchive>>,
    pending: Option<Pending>,
    /// Why the last action failed, until the next one.
    action_error: bool,
    active: bool,
    summary_generation: u64,
    archives_generation: u64,
    _summary: Option<Task<()>>,
    _archives: Option<Task<()>>,
    _action: Option<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<DailyReviewEvent> for DailyReviewView {}

impl std::fmt::Debug for DailyReviewView {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DailyReviewView")
            .field("selection", &self.selection)
            .field("pending", &self.pending)
            .finish_non_exhaustive()
    }
}

impl DailyReviewView {
    pub fn new(host: Entity<HostSession>, cx: &mut Context<Self>) -> Self {
        let subscriptions = vec![cx.subscribe(&host, |this, _, event: &HostSessionEvent, cx| {
            if matches!(event, HostSessionEvent::Connected { .. }) && this.active {
                this.read_summary(cx);
                this.read_archives(cx);
            }
        })];
        Self {
            host,
            selection: Scope { range: DailyReviewRange::Day, offset_days: 0 },
            resolved: None,
            pending_scope: None,
            error: false,
            archives: Archives::Loading,
            report: None,
            pending: None,
            action_error: false,
            active: false,
            summary_generation: 0,
            archives_generation: 0,
            _summary: None,
            _archives: None,
            _action: None,
            _subscriptions: subscriptions,
        }
    }

    /// The tab shows: its reads start the first time.
    pub fn activate(&mut self, cx: &mut Context<Self>) {
        if !self.active {
            self.active = true;
            self.read_summary(cx);
            self.read_archives(cx);
        }
    }

    pub fn selection(&self) -> Scope {
        self.selection
    }

    /// The report shown, if one is.
    pub fn report(&self) -> Option<&DailyReviewArchive> {
        self.report.as_deref()
    }

    /// The summary of the chosen scope, once read.
    fn visible_summary(&self) -> Option<&DailyReviewSummary> {
        self.resolved
            .as_ref()
            .filter(|(scope, _)| *scope == self.selection)
            .map(|(_, summary)| summary.as_ref())
    }

    fn requester(&self, cx: &App) -> HostRequester {
        self.host.read(cx).requester()
    }

    /// Chooses a scope (`selectScope`): the activity shows again and the
    /// scope is read.
    pub fn select(&mut self, scope: Scope, cx: &mut Context<Self>) {
        self.action_error = false;
        self.report = None;
        if scope != self.selection {
            self.selection = scope;
            self.read_summary(cx);
        }
        cx.notify();
    }

    fn read_summary(&mut self, cx: &mut Context<Self>) {
        if !self.host.read(cx).is_connected() {
            return;
        }
        self.summary_generation += 1;
        let generation = self.summary_generation;
        let scope = self.selection;
        self.pending_scope = Some(scope);
        self.error = false;
        let requester = self.requester(cx);
        let input = DailyReviewQueryInput::Summary {
            day_span: scope.range.days(),
            offset_days: scope.offset_days,
        };
        cx.notify();
        self._summary = Some(cx.spawn(async move |this, cx| {
            let result = requester.request::<DailyReviewQuery>(&input).await;
            this.update(cx, |this, cx| {
                if this.summary_generation != generation {
                    return;
                }
                this.pending_scope = None;
                match result {
                    Ok(DailyReviewQueryResult::Summary { summary }) => {
                        this.resolved = Some((scope, summary));
                    }
                    other => {
                        log::warn!("daily-review.query summary failed: {other:?}");
                        this.error = true;
                    }
                }
                cx.notify();
            })
            .ok();
        }));
    }

    fn read_archives(&mut self, cx: &mut Context<Self>) {
        if !self.host.read(cx).is_connected() {
            return;
        }
        self.archives_generation += 1;
        let generation = self.archives_generation;
        self.archives = Archives::Loading;
        let requester = self.requester(cx);
        cx.notify();
        self._archives = Some(cx.spawn(async move |this, cx| {
            let result = list_archives(&requester).await;
            this.update(cx, |this, cx| {
                if this.archives_generation != generation {
                    return;
                }
                this.archives = match result {
                    Some(archives) => Archives::Ready(archives),
                    None => Archives::Failed,
                };
                cx.notify();
            })
            .ok();
        }));
    }

    /// Retry on the failure banner: every read again.
    pub fn retry(&mut self, cx: &mut Context<Self>) {
        self.action_error = false;
        self.read_summary(cx);
        self.read_archives(cx);
    }

    /// The report of the chosen scope, when the list has one
    /// (`currentArchive`).
    fn current_archive(&self) -> Option<&DailyReviewArchiveSummary> {
        let summary = self.visible_summary()?;
        let Archives::Ready(archives) = &self.archives else {
            return None;
        };
        archives
            .iter()
            .find(|archive| archive.range == self.selection.range && archive.day == summary.day)
    }

    fn run(
        &mut self,
        pending: Pending,
        action: Task<Option<Box<DailyReviewArchive>>>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.pending.is_some() {
            return;
        }
        self.pending = Some(pending);
        self.action_error = false;
        cx.notify();
        let generated = pending == Pending::Generate;
        self._action = Some(cx.spawn_in(window, async move |this, cx| {
            let archive = action.await;
            this.update(cx, |this, cx| {
                this.pending = None;
                match archive {
                    Some(archive) => {
                        if generated {
                            this.read_archives(cx);
                        }
                        this.report = Some(archive);
                    }
                    None => this.action_error = true,
                }
                cx.notify();
            })
            .ok();
        }));
    }

    /// View analysis: the report the list has for the scope.
    pub fn open_archive(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(id) = self.current_archive().map(|archive| archive.id.clone()) else {
            return;
        };
        let requester = self.requester(cx);
        let read = cx.spawn(async move |_, _| get_archive(&requester, id).await);
        self.run(Pending::Open, read, window, cx);
    }

    /// Generate analysis (`runOnce`, then `getArchive`): a report of the
    /// scope with the configured model; the list is read again after it.
    pub fn generate(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let scope = self.selection;
        let requester = self.requester(cx);
        let run = cx.spawn(async move |_, _| {
            let input = DailyReviewMutateInput::run(scope.range, scope.offset_days);
            match requester.request::<DailyReviewMutate>(&input).await {
                Ok(DailyReviewMutateResult::Archive { archive }) => {
                    get_archive(&requester, archive.id).await
                }
                other => {
                    log::warn!("daily-review.mutate run failed: {other:?}");
                    None
                }
            }
        });
        self.run(Pending::Generate, run, window, cx);
    }

    /// Back to activity.
    pub fn close_report(&mut self, cx: &mut Context<Self>) {
        self.report = None;
        self.action_error = false;
        cx.notify();
    }

    /// The report shown, as Desktop exports it (`formatArchiveMarkdown`),
    /// with its title.
    pub fn report_markdown(
        &self,
        locale: Locale,
        zone: &impl TimeZone,
    ) -> Option<(String, String)> {
        let archive = self.report.as_deref()?;
        let title = archive_title(archive.day.from_ms, archive.range, zone, locale);
        let mut lines = vec![format!("# {title}")];
        for (label, content) in sections(archive) {
            lines.push(String::new());
            lines.push(format!("## {}", label.in_locale(locale)));
            lines.push(content.to_owned());
        }
        Some((title, lines.join("\n")))
    }

    /// Copy: the report's Markdown on the clipboard.
    pub fn copy_report(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let locale = Locale::current(cx);
        let Some((title, markdown)) = self.report_markdown(locale, &Local) else {
            return;
        };
        cx.write_to_clipboard(ClipboardItem::new_string(markdown));
        self.announce(copy::review_copied(locale, &title), window, cx);
    }

    /// Add to composer: the report's Markdown added to the draft
    /// (`appendMarkdown`).
    pub fn append_report(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let locale = Locale::current(cx);
        let Some((title, markdown)) = self.report_markdown(locale, &Local) else {
            return;
        };
        cx.emit(DailyReviewEvent::AppendToComposer(markdown));
        self.announce(copy::review_pasted(locale, &title), window, cx);
    }

    /// Save: the platform's save dialog, then the file (`saveMarkdownToFile`).
    /// A cancelled dialog says nothing.
    pub fn save_report(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let locale = Locale::current(cx);
        let Some((title, markdown)) = self.report_markdown(locale, &Local) else {
            return;
        };
        let Some(archive) = self.report.as_deref() else {
            return;
        };
        if self.pending.is_some() {
            return;
        }
        let name = format!("maka-daily-review-{}.md", archive.id).replace(['/', '\\'], "_");
        let directory = dirs::document_dir().or_else(dirs::home_dir).unwrap_or_default();
        let path = cx.prompt_for_new_path(&directory, Some(&name));
        self.pending = Some(Pending::Save);
        cx.notify();
        self._action = Some(cx.spawn_in(window, async move |this, cx| {
            let chosen = match path.await {
                Ok(Ok(Some(path))) => Some(path),
                Ok(Err(error)) => {
                    log::warn!("the save dialog failed: {error:#}");
                    None
                }
                _ => None,
            };
            let written = match chosen {
                Some(path) => Some(write_markdown(path, markdown).await),
                None => None,
            };
            this.update_in(cx, |this, window, cx| {
                this.pending = None;
                match written {
                    Some(Ok(())) => {
                        this.announce(copy::review_saved(locale, &title), window, cx);
                    }
                    Some(Err(error)) => {
                        log::warn!("could not save the daily review: {error}");
                        let failure = Notification::error(copy::WRITE_FAILED.get(cx))
                            .title(copy::SAVE_FAILED_TITLE.get(cx));
                        window.push_notification(failure, cx);
                    }
                    None => {}
                }
                cx.notify();
            })
            .ok();
        }));
    }

    /// An export's confirmation, as Desktop's toast: what was done, and
    /// the report's counts.
    fn announce(&self, title: String, window: &mut Window, cx: &mut Context<Self>) {
        let Some(archive) = self.report.as_deref() else {
            return;
        };
        let locale = Locale::current(cx);
        let summary = copy::review_summary(
            locale,
            archive.totals.session_count,
            archive.totals.request_count,
        );
        window.push_notification(Notification::success(summary).title(title), cx);
    }

    /// The header's controls for the tab: the primary action and the way
    /// to the settings.
    pub fn render_header_actions(&mut self, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let mut actions = Vec::new();
        if self.report.is_none() {
            let busy = self.pending.is_some();
            let primary = match self.current_archive() {
                Some(archive) if archive.status == DailyReviewArchiveStatus::Ok => Some(
                    control_button(Button::new("daily-review-view").primary())
                        .label(copy::VIEW_ANALYSIS.get(cx))
                        .loading(self.pending == Some(Pending::Open))
                        .disabled(busy)
                        .on_click(cx.listener(|this, _: &ClickEvent, window, cx| {
                            this.open_archive(window, cx)
                        })),
                ),
                current => {
                    let has_activity = self.visible_summary().is_some_and(|summary| {
                        summary.totals.session_count + summary.totals.request_count > 0
                    });
                    let label = if current.is_some() {
                        copy::RETRY_ANALYSIS
                    } else {
                        copy::GENERATE_ANALYSIS
                    };
                    // Desktop's primaryAction: primary always, faded while
                    // disabled (nothing to analyse yet).
                    Some(
                        control_button(Button::new("daily-review-generate").primary())
                            .label(label.get(cx))
                            .loading(self.pending == Some(Pending::Generate))
                            .disabled(
                                busy || !matches!(self.archives, Archives::Ready(_))
                                    || !has_activity,
                            )
                            .on_click(cx.listener(|this, _: &ClickEvent, window, cx| {
                                this.generate(window, cx)
                            })),
                    )
                }
            };
            actions.extend(primary.map(IntoElement::into_any_element));
        }
        let maka = cx.maka();
        actions.push(
            // 32px, the height of the action beside it (review round 13).
            Button::new("daily-review-settings")
                .ghost()
                .small()
                .size_8()
                .icon(Icon::new(IconName::Settings).size_4().text_color(maka.ink_muted))
                .accessibility_label(copy::REVIEW_SETTINGS.get(cx))
                .tooltip(copy::REVIEW_SETTINGS.get(cx))
                .on_click(
                    cx.listener(|_, _: &ClickEvent, _, cx| cx.emit(DailyReviewEvent::OpenSettings)),
                )
                .into_any_element(),
        );
        actions
    }

    /// The page's meta beside its title: the scope's tasks, as Desktop's
    /// `archive.sessionCount` ("{n} 任务"); `reviewSummary` is only the
    /// export toast's body.
    pub fn meta(&self, cx: &App) -> Option<String> {
        let (_, summary) = self.resolved.as_ref()?;
        let count = summary.totals.session_count;
        (self.report.is_none()).then(|| copy::task_count(Locale::current(cx), count))
    }

    /// The range switch and the day stepper, for the end of the page's bar.
    pub fn render_toolbar(&mut self, cx: &mut Context<Self>) -> Option<AnyElement> {
        if self.report.is_some() {
            return None;
        }
        let locale = Locale::current(cx);
        let selection = self.selection;
        let ranges = [
            (DailyReviewRange::Day, copy::REVIEW_RANGE_DAY),
            (DailyReviewRange::Week, copy::REVIEW_RANGE_WEEK),
            (DailyReviewRange::Month, copy::REVIEW_RANGE_MONTH),
        ];
        let track = segmented_track(cx)
            .id("daily-review-range")
            .test_support()
            .aria_label(copy::REVIEW_RANGE.get(cx))
            .w(rems(20.))
            .children(ranges.map(|(range, label)| {
                let button =
                    Button::new(domain_element_id("daily-review-range", &range.days().to_string()))
                        .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                            this.select(Scope { range, offset_days: 0 }, cx)
                        }));
                segment(button, label.get(cx), selection.range == range, cx)
            }));
        let maka = cx.maka();
        let step =
            |id: &'static str, icon: IconName, label: Text, disabled: bool, direction: i64| {
                Button::new(id)
                    .ghost()
                    .small()
                    .size_7()
                    .icon(Icon::new(icon).size_4().text_color(if disabled {
                        maka.ink_disabled
                    } else {
                        maka.ink_muted
                    }))
                    .accessibility_label(label.get(cx))
                    .tooltip(label.get(cx))
                    .disabled(disabled)
                    .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                        let scope = this.selection.shift(direction);
                        this.select(scope, cx)
                    }))
            };
        let label = selection.label(locale);
        Some(
            h_flex()
                .id("daily-review-toolbar")
                .test_support()
                .flex_wrap()
                .justify_end()
                .gap_2()
                .child(track)
                .child(step(
                    "daily-review-earlier",
                    IconName::ChevronLeft,
                    copy::DATE_EARLIER,
                    false,
                    -1,
                ))
                .child(
                    h_flex()
                        .id("daily-review-scope")
                        .test_support()
                        .aria_label(label.clone())
                        // Desktop's 9rem, centred, so the stepper keeps
                        // its place as the label changes; Desktop's
                        // `Text type="label" weight="semibold"`, 14/600,
                        // centred on the toolbar's 28.
                        .min_w(rems(9.))
                        .h_7()
                        .justify_center()
                        .text_sm()
                        .line_height(rems(1.25))
                        .font_semibold()
                        .child(label),
                )
                .child(step(
                    "daily-review-later",
                    IconName::ChevronRight,
                    copy::DATE_LATER,
                    selection.offset_days >= 0,
                    1,
                ))
                .into_any_element(),
        )
    }

    /// The tab's body: the activity, or the report. `now` is the page's
    /// clock, in the local zone.
    pub fn render_body(
        &mut self,
        now: &DateTime<FixedOffset>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        if let Some(report) = self.report.clone() {
            return self.render_report(&report, now, window, cx);
        }
        let locale = Locale::current(cx);
        let mut children = Vec::new();
        if self.error || self.action_error || self.archives == Archives::Failed {
            children.push(self.render_banner(cx));
        }
        match &self.resolved {
            None if self.pending_scope.is_some() => children.push(render_skeleton()),
            None => {}
            Some((scope, summary)) => {
                let scope = *scope;
                let summary = summary.clone();
                // The strip carries its own space below it.
                children.push(
                    v_flex()
                        .w_full()
                        .child(render_metrics(scope, &summary, locale, cx))
                        .child(self.render_sessions(scope, &summary, now, cx))
                        .into_any_element(),
                );
            }
        }
        v_flex()
            .id("daily-review")
            .test_support()
            .w_full()
            .gap_6()
            .children(children)
            .into_any_element()
    }

    /// `overview.refreshFailed` with Retry.
    fn render_banner(&self, cx: &mut Context<Self>) -> AnyElement {
        let locale = Locale::current(cx);
        let reason = copy::REVIEW_ERROR_FALLBACK.in_locale(locale);
        let retry = quiet_button(Button::new("daily-review-retry"), cx)
            .label(shell_copy::RETRY.get(cx))
            .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.retry(cx)));
        h_flex()
            .items_start()
            .gap_2()
            .child(failure_text(
                "daily-review-failed",
                &copy::review_refresh_failed(locale, reason),
                reason,
                cx,
            ))
            .child(retry)
            .into_any_element()
    }

    /// Active tasks: one row each (name, last message, how long ago); a row
    /// opens its task.
    fn render_sessions(
        &self,
        scope: Scope,
        summary: &DailyReviewSummary,
        now: &DateTime<FixedOffset>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let locale = Locale::current(cx);
        let title = copy::ACTIVE_TASKS.get(cx);
        if summary.sessions.is_empty() {
            // The section's own absence: one supporting line, no icon.
            let empty = if scope == (Scope { range: DailyReviewRange::Day, offset_days: 0 }) {
                copy::EMPTY_TODAY.get(cx).to_owned()
            } else {
                copy::empty_range(locale, &scope.label(locale))
            };
            return v_flex()
                .id("daily-review-sessions")
                .test_support()
                .gap_2()
                .child(heading("daily-review-sessions-title", title, cx))
                .child(EmptyRow::new("daily-review", empty))
                .into_any_element();
        }
        let maka = cx.maka();
        let now_ms = u64::try_from(now.timestamp_millis()).unwrap_or(0);
        let offset = now.offset().fix().local_minus_utc();
        let len = summary.sessions.len();
        let rows = summary
            .sessions
            .iter()
            .enumerate()
            .map(|(ix, session)| {
                let id: SharedString = session.id.clone().into();
                let name = shell_copy::task_title(locale, &session.name).to_owned();
                let age = relative_time(locale, session.last_message_at, now_ms, offset);
                Button::new(domain_element_id("daily-review-session", &session.id))
                    .ghost()
                    .w_full()
                    .h_auto()
                    .px_0()
                    .py_2()
                    .map(|this| list_row(this, ix, len))
                    .accessibility_label(shell_copy::parts(locale, &[&name, &age]))
                    .child(
                        h_flex()
                            .w_full()
                            .min_w_0()
                            .gap_3()
                            .child(
                                v_flex()
                                    .flex_1()
                                    .min_w_0()
                                    .items_start()
                                    .child(
                                        div()
                                            .w_full()
                                            .truncate()
                                            .text_sm()
                                            .font_medium()
                                            .child(name),
                                    )
                                    .when_some(
                                        session.last_message_preview.clone(),
                                        |this, preview| {
                                            this.child(
                                                div()
                                                    .w_full()
                                                    .truncate()
                                                    .text_xs()
                                                    .text_color(maka.ink_muted)
                                                    .child(preview),
                                            )
                                        },
                                    ),
                            )
                            .child(
                                div()
                                    .flex_shrink_0()
                                    .text_xs()
                                    .text_color(maka.ink_muted)
                                    .font_features(tabular_nums())
                                    .child(age),
                            ),
                    )
                    .on_click(cx.listener(move |_, _: &ClickEvent, _, cx| {
                        cx.emit(DailyReviewEvent::OpenTask(id.clone()))
                    }))
                    .into_any_element()
            })
            .collect();
        v_flex()
            .id("daily-review-sessions")
            .test_support()
            .gap_2()
            .child(heading("daily-review-sessions-title", title, cx))
            .child(rows_with_rules("daily-review-session-list", title, rows, cx))
            .into_any_element()
    }

    /// A report: Back, the exports, its title and when it was generated,
    /// its status when it is not a finished report, and its sections.
    fn render_report(
        &mut self,
        archive: &DailyReviewArchive,
        now: &DateTime<FixedOffset>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let maka = cx.maka();
        let locale = Locale::current(cx);
        let zone = now.timezone();
        let title = archive_title(archive.day.from_ms, archive.range, &zone, locale);
        let model = if archive.model_key.is_empty() {
            copy::DEFAULT_MODEL.in_locale(locale).to_owned()
        } else {
            model_label(&archive.model_key).to_owned()
        };
        let meta = crate::model::dotted(&[
            &crate::model::task_time(archive.generated_at, &zone, locale),
            &model,
        ]);
        let busy = self.pending.is_some();
        let export = |id: &'static str, label: Text, busy_label: Text, pending: Pending| {
            let running = self.pending == Some(pending);
            quiet_button(Button::new(id), cx)
                .label(if running { busy_label.get(cx) } else { label.get(cx) })
                .disabled(busy)
        };
        let actions = h_flex()
            .id("daily-review-report-actions")
            .test_support()
            .w_full()
            .flex_wrap()
            .gap_2()
            .child(back_link(
                Button::new("daily-review-back")
                    .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.close_report(cx))),
                copy::BACK_TO_ACTIVITY.get(cx),
                cx,
            ))
            .child(div().flex_1())
            .child(
                export("daily-review-copy", copy::EXPORT_COPY, copy::EXPORT_COPYING, Pending::Copy)
                    .on_click(
                        cx.listener(|this, _: &ClickEvent, window, cx| {
                            this.copy_report(window, cx)
                        }),
                    ),
            )
            .child(
                export(
                    "daily-review-append",
                    copy::EXPORT_APPEND,
                    copy::EXPORT_APPENDING,
                    Pending::Append,
                )
                .on_click(
                    cx.listener(|this, _: &ClickEvent, window, cx| this.append_report(window, cx)),
                ),
            )
            .child(
                export("daily-review-save", copy::EXPORT_SAVE, copy::EXPORT_SAVING, Pending::Save)
                    .on_click(
                        cx.listener(|this, _: &ClickEvent, window, cx| {
                            this.save_report(window, cx)
                        }),
                    ),
            );
        let status = (archive.status != DailyReviewArchiveStatus::Ok).then(|| {
            let failed = matches!(
                archive.status,
                DailyReviewArchiveStatus::Failed | DailyReviewArchiveStatus::NoModel
            );
            let label = archive_status(&archive.status).in_locale(locale);
            v_flex()
                .id("daily-review-report-status")
                .test_support()
                .aria_label(label.to_owned())
                .w_full()
                .px_3()
                .py_2()
                .rounded(RADIUS_SURFACE)
                .border_1()
                .border_color(maka.border_soft)
                .child(
                    div()
                        .text_sm()
                        .font_medium()
                        .text_color(if failed { maka.destructive } else { maka.ink })
                        .child(label.to_owned()),
                )
                .children(
                    archive
                        .error_message
                        .clone()
                        .map(|message| div().text_xs().text_color(maka.ink_muted).child(message)),
                )
        });
        let sections: Vec<AnyElement> = sections(archive)
            .into_iter()
            .map(|(label, content)| {
                v_flex()
                    .id(domain_element_id("daily-review-section", label.en()))
                    .test_support()
                    .gap_2()
                    .child(heading(
                        domain_element_id("daily-review-section-title", label.en()),
                        label.in_locale(locale),
                        cx,
                    ))
                    .child(
                        div().child(
                            TextView::markdown(
                                domain_element_id("daily-review-section-text", label.en()),
                                content.to_owned(),
                            )
                            // gpui-kit's TextView defaults to a 0.75rem
                            // paragraph gap; the review keeps 1rem.
                            .style(TextViewStyle::default().paragraph_gap(rems(1.)))
                            .selectable(true)
                            .w_full()
                            .text_sm()
                            .line_height(relative(22. / 14.))
                            .text_color(maka.ink),
                        ),
                    )
                    .into_any_element()
            })
            .collect();
        let body = if sections.is_empty() {
            empty_state(
                "daily-review-report-empty",
                Icon::new(AssetIcon::CalendarDays),
                copy::NO_CONTENT.get(cx),
                Some(copy::NO_CONTENT_HELP.get(cx)),
                None,
                cx,
            )
        } else {
            v_flex().gap_6().children(sections).into_any_element()
        };
        let _ = window;
        v_flex()
            .id("daily-review-report")
            .test_support()
            .w_full()
            .gap_5()
            .child(actions)
            .child(
                v_flex()
                    .gap_1()
                    .child(heading("daily-review-report-title", &title, cx))
                    .child(div().text_xs().text_color(maka.ink_muted).child(meta)),
            )
            .children(status)
            .child(crate::widgets::divider(cx))
            .child(body)
            .into_any_element()
    }
}

/// The four metrics of the scope (`DailyReviewMetric`).
fn render_metrics(
    scope: Scope,
    summary: &DailyReviewSummary,
    locale: Locale,
    cx: &App,
) -> AnyElement {
    let maka = cx.maka();
    let totals = &summary.totals;
    let metrics = [
        ("tasks", copy::METRIC_TASKS, totals.session_count.to_string()),
        ("requests", copy::METRIC_REQUESTS, totals.request_count.to_string()),
        ("tokens", copy::METRIC_TOKENS, grouped(totals.total_tokens)),
        ("cost", copy::METRIC_COST, format!("${:.2}", totals.cost_usd)),
    ];
    // Desktop's strip: four labelled numbers on a fixed 4-up grid, 24
    // between the columns, 8 above and 20 below, with no rules in or around
    // it (`daily-review.css`).
    h_flex()
        .id("daily-review-metrics")
        .test_support()
        .aria_label(copy::overview(locale, &scope.label(locale)))
        .w_full()
        .gap_6()
        .pt_2()
        .pb_5()
        .children(metrics.map(|(key, label, value)| {
            let label = label.in_locale(locale);
            v_flex()
                .id(domain_element_id("daily-review-metric", key))
                .test_support()
                .aria_label(shell_copy::labeled(locale, label, &value))
                .flex_1()
                .min_w_0()
                .child(
                    div()
                        .truncate()
                        .text_xs()
                        .line_height(rems(1.25))
                        .text_color(maka.ink_muted)
                        .child(label.to_owned()),
                )
                .child(
                    div()
                        .truncate()
                        .text_size(rems(HEADING_TEXT_REMS))
                        .line_height(rems(HEADING_LINE_REMS))
                        .font_semibold()
                        .font_features(tabular_nums())
                        .child(value),
                )
        }))
        .into_any_element()
}

fn render_skeleton() -> AnyElement {
    v_flex()
        .id("daily-review-loading")
        .test_support()
        .gap_3()
        .children([4., 3., 3.].into_iter().enumerate().map(|(ix, height)| {
            div().id(("daily-review-skeleton", ix)).child(Skeleton::new().h(rems(height)).w_full())
        }))
        .into_any_element()
}

/// `toLocaleString` in every locale here: thousands grouped by commas.
fn grouped(value: u64) -> String {
    let digits = value.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (ix, digit) in digits.chars().enumerate() {
        if ix > 0 && (digits.len() - ix).is_multiple_of(3) {
            out.push(',');
        }
        out.push(digit);
    }
    out
}

/// The sections a report has written, in Desktop's order, trimmed.
fn sections(archive: &DailyReviewArchive) -> Vec<(Text, &str)> {
    let sections = &archive.sections;
    [
        (copy::SECTION_SUMMARY, &sections.summary),
        (copy::SECTION_GAPS, &sections.gaps),
        (copy::SECTION_USAGE, &sections.usage),
        (copy::SECTION_CODE, &sections.code),
    ]
    .into_iter()
    .filter_map(|(label, content)| {
        let content = content.as_deref()?.trim();
        (!content.is_empty()).then_some((label, content))
    })
    .collect()
}

pub fn archive_status(status: &DailyReviewArchiveStatus) -> Text {
    match status {
        DailyReviewArchiveStatus::Ok => copy::ARCHIVE_OK,
        DailyReviewArchiveStatus::NoModel => copy::ARCHIVE_NO_MODEL,
        DailyReviewArchiveStatus::NoData => copy::ARCHIVE_NO_DATA,
        DailyReviewArchiveStatus::Skipped => copy::ARCHIVE_SKIPPED,
        _ => copy::ARCHIVE_FAILED,
    }
}

/// `formatDailyReviewArchiveTitle`: "08/03 · 1 day".
pub fn archive_title(
    from_ms: u64,
    range: DailyReviewRange,
    zone: &impl TimeZone,
    locale: Locale,
) -> String {
    use chrono::Datelike as _;
    let date = i64::try_from(from_ms)
        .ok()
        .and_then(|ms| zone.timestamp_millis_opt(ms).earliest())
        .map(|day| format!("{:02}/{:02}", day.month(), day.day()))
        .unwrap_or_default();
    let range = match range {
        DailyReviewRange::Week => copy::ARCHIVE_RANGE_WEEK,
        DailyReviewRange::Month => copy::ARCHIVE_RANGE_MONTH,
        _ => copy::ARCHIVE_RANGE_DAY,
    };
    crate::model::dotted(&[&date, range.in_locale(locale)])
}

/// `formatDailyReviewModelLabel`: the model id of `connection::model`.
fn model_label(key: &str) -> &str {
    match key.rfind("::") {
        Some(ix) if !key[ix + 2..].trim().is_empty() => key[ix + 2..].trim(),
        _ => key,
    }
}

/// Every report, newest first (`listDailyReviewArchives`); `None` when a
/// page cannot be read.
async fn list_archives(requester: &HostRequester) -> Option<Vec<DailyReviewArchiveSummary>> {
    let mut archives = Vec::new();
    let mut before = None;
    loop {
        let input = DailyReviewQueryInput::Archives {
            before_archive_id: before.clone(),
            limit: DAILY_REVIEW_PAGE_MAX_ITEMS,
        };
        match requester.request::<DailyReviewQuery>(&input).await {
            Ok(DailyReviewQueryResult::Archives {
                archives: page, next_before_archive_id, ..
            }) => {
                archives.extend(page);
                // A cursor that does not move would read the same page again.
                if next_before_archive_id.is_none() || next_before_archive_id == before {
                    return Some(archives);
                }
                before = next_before_archive_id;
            }
            other => {
                log::warn!("daily-review.query archives failed: {other:?}");
                return None;
            }
        }
    }
}

async fn get_archive(requester: &HostRequester, id: String) -> Option<Box<DailyReviewArchive>> {
    let input = DailyReviewQueryInput::Archive { archive_id: id };
    match requester.request::<DailyReviewQuery>(&input).await {
        Ok(DailyReviewQueryResult::Archive { archive: Some(archive) }) => Some(archive),
        other => {
            log::warn!("daily-review.query archive failed: {other:?}");
            None
        }
    }
}

/// Writes the export (async-fs runs it on its blocking pool, never on the
/// UI thread).
async fn write_markdown(path: PathBuf, markdown: String) -> std::io::Result<()> {
    if markdown.len() > EXPORT_MAX_BYTES {
        return Err(std::io::Error::other("the export is too large"));
    }
    async_fs::write(path, markdown).await
}

#[cfg(test)]
mod tests {
    use chrono::FixedOffset;

    use super::*;

    #[test]
    fn a_scope_reads_as_desktop_labels_it() {
        let en = Locale::English;
        let day = |offset_days| Scope { range: DailyReviewRange::Day, offset_days };
        assert_eq!(day(0).label(en), "Today");
        assert_eq!(day(-1).label(en), "Yesterday");
        assert_eq!(day(-3).label(en), "3 days ago");
        let week = Scope { range: DailyReviewRange::Week, offset_days: -2 };
        assert_eq!(week.label(en), "Last 7 days (2 days earlier)");
        assert_eq!(week.label(Locale::SimplifiedChinese), "最近 7 天（往前 2 天）");
        assert_eq!(day(0).shift(1), day(0), "never past today");
        assert_eq!(day(0).shift(-1), day(-1));
    }

    #[test]
    fn an_archive_title_is_its_date_and_range() {
        let zone = FixedOffset::east_opt(8 * 3600).expect("zone");
        // 2026-08-03 00:00 in UTC+8.
        assert_eq!(
            archive_title(1_785_686_400_000, DailyReviewRange::Day, &zone, Locale::English),
            "08/03 · 1 day"
        );
        assert_eq!(
            archive_title(
                1_785_686_400_000,
                DailyReviewRange::Week,
                &zone,
                Locale::SimplifiedChinese
            ),
            "08/03 · 7 天"
        );
        assert_eq!(model_label("openrouter::openrouter/free"), "openrouter/free");
        assert_eq!(model_label("plain"), "plain");
        assert_eq!(grouped(1_234_567), "1,234,567");
        assert_eq!(grouped(12), "12");
    }
}
