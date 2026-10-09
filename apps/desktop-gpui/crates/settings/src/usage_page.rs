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

//! The Usage page, after Maka Desktop's
//! (apps/desktop/src/renderer/features/usage/ui/usage-settings-view.tsx,
//! its scope in services-context.tsx): the range (24h, 7 days, 30 days,
//! all), the four headline figures, and the tabs Activity log (filtered by
//! model or tool and by status, fifty rows a page), Providers, Models,
//! Tools, and Pricing (read-only), from `usage.query`.
//!
//! One screen answers one fixed query: the range resolves to fixed bounds
//! when first chosen, and a filter or a return to the page keeps them, so
//! paging never shifts under the reader; Refresh resolves them again. The
//! activity pages after the first come from continuations of that screen;
//! when the data moves meanwhile the Host says so, the complete result
//! stays, and the page asks for a Refresh. The range, the tab, the status
//! filter and whether the detailed records show are the client's
//! preferences ([`UsageView`]).

use std::time::Duration;

use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::select::{Select, SelectEvent};
use gpui_kit::component::spinner::Spinner;
use gpui_kit::component::switch::Switch;
use gpui_kit::component::tab::{Tab, TabBar};
use gpui_kit::component::{ActiveTheme as _, Disableable as _, Icon, Sizable as _, h_flex, v_flex};
use gpui_kit::{
    AnyElement, App, AppContext as _, Context, Entity, EventEmitter, InteractiveElement as _,
    IntoElement, ParentElement as _, Render, SharedString, StatefulInteractiveElement as _,
    Styled as _, Subscription, Task, TestSupportExt as _, Window, div, prelude::FluentBuilder as _,
    px, rems,
};
use host_protocol::{
    UsageOutcome, UsageQuery, UsageQueryInput, UsageQueryResult, UsageRangeBounds, UsageRequestLog,
    UsageRowKind, UsageScreen, UsageScreenQuery, UsageStatusFilter,
};
use serde::{Deserialize, Serialize};
use shared::copy::health as health_copy;
use shared::copy::settings as settings_copy;
use shared::copy::usage as copy;
use shared::copy::{Locale, Text, failure};
use shared::domain_element_id;
use shared::icons::MakaIcon;
use shared::theme::FieldFill as _;
use shared::theme::{
    ActiveMakaPalette as _, RADIUS_SURFACE, quiet_button, segment_md, segmented_track_md,
    tabular_nums,
};
use shared::time::{local_utc_offset, locale_date_time, relative_time};
use workspace::{HostSession, HostSessionEvent};

use crate::policy::host_error_reason;
use crate::preferences::AppPreferences;
use crate::rows::{Choice, ChoiceSelect, StatusLine, settings_button, sync_choices};

/// Rows of the activity log a page shows (`USAGE_REQUESTS_PAGE_SIZE`).
pub const USAGE_PAGE_SIZE: usize = 50;

/// How long the filter waits after the typing stops
/// (`USAGE_SEARCH_DEBOUNCE_MS`).
const SEARCH_DEBOUNCE: Duration = Duration::from_millis(250);

const DAY_MS: u64 = 24 * 60 * 60 * 1000;

/// Supporting text: 12px on 20px lines.
const SUPPORTING_LINE_REMS: f32 = 1.25;

/// A headline figure: 20px semibold on 28px lines, Maka's heading-1 rung.
const FIGURE_TEXT_REMS: f32 = 1.25;
const FIGURE_LINE_REMS: f32 = 1.75;

/// The page's status line key.
const PAGE_KEY: &str = "usage";

/// `UsageRange`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[non_exhaustive]
pub enum UsageRange {
    #[default]
    #[serde(rename = "24h")]
    Day,
    #[serde(rename = "7d")]
    Week,
    #[serde(rename = "30d")]
    Month,
    #[serde(rename = "all")]
    All,
}

impl UsageRange {
    pub const ALL: [Self; 4] = [Self::Day, Self::Week, Self::Month, Self::All];

    pub fn label(self) -> Text {
        match self {
            Self::Day => copy::RANGE_24H,
            Self::Week => copy::RANGE_7D,
            Self::Month => copy::RANGE_30D,
            Self::All => copy::RANGE_ALL,
        }
    }

    pub fn key(self) -> &'static str {
        match self {
            Self::Day => "24h",
            Self::Week => "7d",
            Self::Month => "30d",
            Self::All => "all",
        }
    }

    /// `resolveUsageRange`: the bounds ending `now_ms`.
    pub fn bounds(self, now_ms: u64) -> UsageRangeBounds {
        let span = match self {
            Self::Day => DAY_MS,
            Self::Week => 7 * DAY_MS,
            Self::Month => 30 * DAY_MS,
            Self::All => return UsageRangeBounds::new(0, now_ms),
        };
        UsageRangeBounds::new(now_ms.saturating_sub(span), now_ms)
    }
}

/// `UsageTab`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub enum UsageTab {
    #[default]
    Requests,
    Providers,
    Models,
    Tools,
    Pricing,
}

impl UsageTab {
    pub const ALL: [Self; 5] =
        [Self::Requests, Self::Providers, Self::Models, Self::Tools, Self::Pricing];

    fn label(self) -> Text {
        match self {
            Self::Requests => copy::TAB_ACTIVITY,
            Self::Providers => copy::TAB_PROVIDERS,
            Self::Models => copy::TAB_MODELS,
            Self::Tools => copy::TAB_TOOLS,
            Self::Pricing => copy::TAB_PRICING,
        }
    }
}

/// `UsageStatus`: which activity rows the log lists.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub enum UsageStatus {
    #[default]
    All,
    Success,
    Error,
    Aborted,
}

impl UsageStatus {
    pub const ALL: [Self; 4] = [Self::All, Self::Success, Self::Error, Self::Aborted];

    fn label(self) -> Text {
        match self {
            Self::All => copy::STATUS_ALL,
            Self::Success => copy::OUTCOME_SUCCESS,
            Self::Error => copy::OUTCOME_ERROR,
            Self::Aborted => copy::OUTCOME_ABORTED,
        }
    }

    fn wire(self) -> UsageStatusFilter {
        match self {
            Self::All => UsageStatusFilter::All,
            Self::Success => UsageStatusFilter::Success,
            Self::Error => UsageStatusFilter::Error,
            Self::Aborted => UsageStatusFilter::Aborted,
        }
    }
}

/// The Usage page's display choices (Desktop's `UsageSettings`, less the
/// model filter's text, which lasts while the app runs): the range, the
/// tab, the status filter, and whether the detailed records show. Unknown
/// values read as the defaults.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
#[non_exhaustive]
pub struct UsageView {
    #[serde(deserialize_with = "lenient")]
    pub range: UsageRange,
    #[serde(deserialize_with = "lenient")]
    pub status: UsageStatus,
    #[serde(deserialize_with = "lenient")]
    pub show_details: bool,
    #[serde(deserialize_with = "lenient")]
    pub active_tab: UsageTab,
}

impl UsageView {
    pub fn is_default(&self) -> bool {
        *self == Self::default()
    }
}

/// A value this client does not know reads as the default.
fn lenient<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::de::DeserializeOwned + Default,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(serde_json::from_value(value).unwrap_or_default())
}

/// What the page asks of the settings surface.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum UsagePageEvent {
    /// A row's task was chosen: show it.
    OpenTask(SharedString),
}

/// Why the screen could not be read.
#[derive(Debug, Clone, PartialEq)]
enum Failure {
    /// The answer would outgrow the display capacity.
    Capacity,
    Error(SharedString),
}

/// Where the screen stands. The last complete screen stays in every state.
#[derive(Debug, Clone, PartialEq)]
enum ScreenState {
    Idle,
    Loading,
    Ready,
    /// The data moved since the screen: continuations stop until Refresh.
    Stale,
    Failed(Failure),
}

/// The query a screen was read for, to tell what changed.
#[derive(Debug, Clone, PartialEq)]
struct QueryKey {
    range: UsageRange,
    search: String,
    status: UsageStatus,
}

/// Behavior and presentation owner of the Usage page.
///
/// It reads the screen when the page shows, when the range or the status
/// changes, 250 ms after the filter's typing stops, on Refresh, and on a
/// new connection; a newer read supersedes one in flight (`ticket`). A
/// page past the ones read loads the continuations it needs first.
pub struct UsagePage {
    host: Entity<HostSession>,
    filter: Entity<InputState>,
    status: Entity<ChoiceSelect<UsageStatus>>,
    screen: Option<Box<UsageScreen>>,
    /// When the screen shown was read (ms since the epoch).
    read_at: Option<u64>,
    state: ScreenState,
    /// The range the bounds were resolved for, and the bounds.
    resolved: Option<(UsageRange, UsageRangeBounds)>,
    /// What the screen shown (or being read) answers.
    queried: Option<QueryKey>,
    ticket: u64,
    /// The page of the activity log shown, from 1.
    page: usize,
    /// While continuations load: the rows loaded and the rows wanted.
    paging: Option<(usize, usize)>,
    refreshing: bool,
    active: bool,
    _load: Option<Task<()>>,
    _paging: Option<Task<()>>,
    _search: Option<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl std::fmt::Debug for UsagePage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("UsagePage")
            .field("state", &self.state)
            .field("page", &self.page)
            .finish_non_exhaustive()
    }
}

impl EventEmitter<UsagePageEvent> for UsagePage {}

impl UsagePage {
    pub fn new(host: Entity<HostSession>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let filter =
            cx.new(|cx| InputState::new(window, cx).placeholder(copy::FILTER_PLACEHOLDER.get(cx)));
        let view = AppPreferences::current(cx).usage;
        let locale = Locale::current(cx);
        let status = cx.new(|cx| ChoiceSelect::new(Vec::new(), None, window, cx));
        sync_choices(&status, status_choices(locale), Some(&view.status), window, cx);
        let subscriptions = vec![
            cx.subscribe(&filter, |this, _, event: &InputEvent, cx| {
                if matches!(event, InputEvent::Change) {
                    this.filter_changed(cx);
                }
            }),
            cx.subscribe_in(
                &status,
                window,
                |this, _, event: &SelectEvent<Vec<Choice<UsageStatus>>>, _, cx| {
                    if let SelectEvent::Confirm(Some(status)) = event {
                        this.set_status(*status, cx);
                    }
                },
            ),
            cx.subscribe(&host, |this, _, event: &HostSessionEvent, cx| {
                if let HostSessionEvent::Connected { host_changed } = event
                    && this.active
                {
                    if *host_changed {
                        this.screen = None;
                        this.resolved = None;
                    }
                    this.reload(false, cx);
                }
            }),
            cx.observe_global_in::<Locale>(window, |this, window, cx| {
                let locale = Locale::current(cx);
                let placeholder = copy::FILTER_PLACEHOLDER.get(cx);
                this.filter
                    .update(cx, |filter, cx| filter.set_placeholder(placeholder, window, cx));
                let status = this.view(cx).status;
                sync_choices(&this.status, status_choices(locale), Some(&status), window, cx);
            }),
            cx.observe(&host, |_, _, cx| cx.notify()),
        ];
        Self {
            host,
            filter,
            status,
            screen: None,
            state: ScreenState::Idle,
            resolved: None,
            queried: None,
            ticket: 0,
            page: 1,
            paging: None,
            refreshing: false,
            read_at: None,
            active: false,
            _load: None,
            _paging: None,
            _search: None,
            _subscriptions: subscriptions,
        }
    }

    /// The page is shown: reads the screen, keeping the bounds the range
    /// resolved to before.
    pub fn activate(&mut self, cx: &mut Context<Self>) {
        self.active = true;
        self.reload(true, cx);
    }

    /// The screen shown.
    pub fn screen(&self) -> Option<&UsageScreen> {
        self.screen.as_deref()
    }

    /// The page of the activity log shown, from 1.
    pub fn page(&self) -> usize {
        self.page
    }

    fn view(&self, cx: &App) -> UsageView {
        AppPreferences::current(cx).usage
    }

    /// The activity log's filter, while it shows: on Requests, with the
    /// detailed records shown.
    pub fn search_field(&self, cx: &App) -> Option<Entity<InputState>> {
        let view = self.view(cx);
        (view.active_tab == UsageTab::Requests && view.show_details).then(|| self.filter.clone())
    }

    fn set_view(&mut self, change: impl FnOnce(&mut UsageView), cx: &mut Context<Self>) {
        let mut view = self.view(cx);
        change(&mut view);
        AppPreferences::global(cx).update(cx, |preferences, cx| preferences.set_usage(view, cx));
        cx.notify();
    }

    /// The filter as the Host takes it: trimmed and lowercased.
    fn search(&self, cx: &App) -> String {
        self.filter.read(cx).value().trim().to_lowercase()
    }

    fn query_key(&self, cx: &App) -> QueryKey {
        QueryKey {
            range: self.view(cx).range,
            search: self.search(cx),
            status: self.view(cx).status,
        }
    }

    /// Reads the screen for the page's query; `preserve_range` keeps the
    /// bounds the range resolved to before.
    fn reload(&mut self, preserve_range: bool, cx: &mut Context<Self>) {
        self._search = None;
        if !self.host.read(cx).is_connected() {
            return;
        }
        self.ticket += 1;
        let ticket = self.ticket;
        self.state = ScreenState::Loading;
        self.paging = None;
        self._paging = None;
        let key = self.query_key(cx);
        let bounds = match self.resolved {
            Some((range, bounds)) if preserve_range && range == key.range => bounds,
            _ => key.range.bounds(now_ms()),
        };
        self.resolved = Some((key.range, bounds));
        let query = UsageScreenQuery::new(bounds, key.search.clone(), key.status.wire());
        self.queried = Some(key);
        let request = self
            .host
            .read(cx)
            .requester()
            .request::<UsageQuery>(&UsageQueryInput::Screen { query });
        let locale = Locale::current(cx);
        self._load = Some(cx.spawn(async move |this, cx| {
            let result = request.await;
            this.update(cx, |this, cx| {
                if ticket != this.ticket {
                    return;
                }
                this._load = None;
                this.refreshing = false;
                this.state = match result {
                    Ok(UsageQueryResult::Screen { screen }) => {
                        this.screen = Some(screen);
                        this.read_at = Some(now_ms());
                        this.page = 1;
                        ScreenState::Ready
                    }
                    Ok(UsageQueryResult::ScreenResponseTooLarge { .. }) => {
                        ScreenState::Failed(Failure::Capacity)
                    }
                    Ok(_) => ScreenState::Failed(Failure::Error(
                        settings_copy::UNEXPECTED.in_locale(locale).into(),
                    )),
                    Err(error) => {
                        log::warn!("usage.query screen failed: {error}");
                        ScreenState::Failed(Failure::Error(
                            host_error_reason(&error, locale).into(),
                        ))
                    }
                };
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    /// Reads the screen again with the range resolved anew.
    pub fn refresh(&mut self, cx: &mut Context<Self>) {
        self.refreshing = true;
        self.reload(false, cx);
    }

    pub fn set_range(&mut self, range: UsageRange, cx: &mut Context<Self>) {
        if self.view(cx).range != range {
            self.set_view(|view| view.range = range, cx);
            self.reload(true, cx);
        }
    }

    fn set_status(&mut self, status: UsageStatus, cx: &mut Context<Self>) {
        if self.view(cx).status != status {
            self.set_view(|view| view.status = status, cx);
            self.reload(true, cx);
        }
    }

    pub fn set_tab(&mut self, tab: UsageTab, cx: &mut Context<Self>) {
        if self.view(cx).active_tab != tab {
            self.set_view(|view| view.active_tab = tab, cx);
        }
    }

    pub fn set_show_details(&mut self, on: bool, cx: &mut Context<Self>) {
        if self.view(cx).show_details != on {
            self.set_view(|view| view.show_details = on, cx);
        }
    }

    /// The filter's text changed: the screen is read again once the typing
    /// stops, unless the text reads the same to the Host.
    fn filter_changed(&mut self, cx: &mut Context<Self>) {
        cx.notify();
        if self.queried.as_ref().is_some_and(|key| key.search == self.search(cx)) {
            self._search = None;
            return;
        }
        self._search = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(SEARCH_DEBOUNCE).await;
            this.update(cx, |this, cx| this.reload(true, cx)).ok();
        }));
    }

    fn clear_filters(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.filter.update(cx, |filter, cx| filter.set_value("", window, cx));
        let locale = Locale::current(cx);
        sync_choices(&self.status, status_choices(locale), Some(&UsageStatus::All), window, cx);
        self.set_view(|view| view.status = UsageStatus::All, cx);
        self.reload(true, cx);
    }

    fn has_filters(&self, cx: &App) -> bool {
        self.view(cx).status != UsageStatus::All || !self.search(cx).is_empty()
    }

    /// The activity log's pages: every row the query matches, fifty a page.
    fn page_count(&self) -> usize {
        let total = self.screen.as_ref().map_or(0, |screen| screen.activity_total as usize);
        total.div_ceil(USAGE_PAGE_SIZE).max(1)
    }

    fn loaded_pages(&self) -> usize {
        self.screen.as_ref().map_or(0, |screen| screen.logs.len()).div_ceil(USAGE_PAGE_SIZE)
    }

    fn can_load_more(&self) -> bool {
        self.state == ScreenState::Ready
            && self.paging.is_none()
            && self.screen.as_ref().is_some_and(|screen| screen.next_cursor.is_some())
    }

    fn can_visit(&self, page: usize) -> bool {
        (1..=self.page_count()).contains(&page)
            && (page <= self.loaded_pages() || self.can_load_more())
    }

    /// Shows page `page`, loading the continuations it needs first.
    pub fn go_to_page(&mut self, page: usize, cx: &mut Context<Self>) {
        if !self.can_visit(page) {
            return;
        }
        if page <= self.loaded_pages() {
            self.page = page;
            cx.notify();
            return;
        }
        let Some(screen) = self.screen.as_ref() else {
            return;
        };
        let wanted = page * USAGE_PAGE_SIZE;
        let ticket = self.ticket;
        let requester = self.host.read(cx).requester();
        let (query, revision, identity) =
            (screen.query.clone(), screen.revision.clone(), screen.query_identity.clone());
        let mut cursor = screen.next_cursor.clone();
        let mut loaded = screen.logs.len();
        self.paging = Some((loaded, wanted));
        let locale = Locale::current(cx);
        self._paging = Some(cx.spawn(async move |this, cx| {
            let mut rows: Vec<UsageRequestLog> = Vec::new();
            let outcome = loop {
                let Some(from) = cursor.clone() else {
                    break Ok(());
                };
                if loaded >= wanted {
                    break Ok(());
                }
                let input = UsageQueryInput::Activity {
                    query: query.clone(),
                    revision: revision.clone(),
                    query_identity: identity.clone(),
                    cursor: from.clone(),
                };
                match requester.request::<UsageQuery>(&input).await {
                    Ok(UsageQueryResult::Activity { page })
                        if page.revision == revision
                            && page.query_identity == identity
                            && page.next_cursor.as_ref() != Some(&from) =>
                    {
                        loaded += page.logs.len();
                        rows.extend(page.logs);
                        cursor = page.next_cursor;
                        let progress = (loaded, wanted);
                        this.update(cx, |this, cx| {
                            if ticket == this.ticket {
                                this.paging = Some(progress);
                                cx.notify();
                            }
                        })
                        .ok();
                    }
                    Ok(UsageQueryResult::RevisionChanged) => break Err(ScreenState::Stale),
                    Ok(UsageQueryResult::ScreenResponseTooLarge { .. }) => {
                        break Err(ScreenState::Failed(Failure::Capacity));
                    }
                    Ok(_) => {
                        break Err(ScreenState::Failed(Failure::Error(
                            settings_copy::UNEXPECTED.in_locale(locale).into(),
                        )));
                    }
                    Err(error) => {
                        log::warn!("usage.query activity failed: {error}");
                        let reason = host_error_reason(&error, locale);
                        break Err(ScreenState::Failed(Failure::Error(reason.into())));
                    }
                }
            };
            this.update(cx, |this, cx| {
                if ticket != this.ticket {
                    return;
                }
                this.paging = None;
                this._paging = None;
                if let Some(screen) = this.screen.as_mut() {
                    screen.logs.extend(rows);
                    screen.next_cursor = cursor;
                }
                match outcome {
                    Ok(()) => this.page = page.min(this.loaded_pages().max(1)),
                    Err(state) => this.state = state,
                }
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    fn render_status(&self, cx: &mut Context<Self>) -> Vec<StatusLine> {
        let locale = Locale::current(cx);
        let mut lines = Vec::new();
        if !self.host.read(cx).is_connected() {
            lines.push(StatusLine::info(PAGE_KEY, copy::USAGE_OFFLINE.get(cx)));
        }
        match &self.state {
            ScreenState::Stale => {
                let refresh =
                    settings_button("usage-stale-refresh", copy::USAGE_REFRESH.get(cx), cx)
                        .loading(self.refreshing)
                        .on_click(cx.listener(|this, _, _, cx| this.refresh(cx)));
                let message = shared::copy::phrases(
                    locale,
                    copy::USAGE_STALE_TITLE.get(cx),
                    copy::USAGE_STALE_BODY.get(cx),
                );
                lines.push(StatusLine::info("usage-stale", message).action(refresh));
            }
            ScreenState::Failed(failed) => {
                // The Host's reason reads as a sentence of its own.
                let reason = match failed {
                    Failure::Capacity => copy::USAGE_CAPACITY.get(cx).to_owned(),
                    Failure::Error(message) => failure(locale, "", message).trim().to_owned(),
                };
                let title = copy::USAGE_LOAD_FAILED.get(cx);
                let mut message = shared::copy::phrases(locale, title, &reason);
                if self.screen.is_some() {
                    message =
                        shared::copy::sentences(locale, &message, copy::USAGE_RETAINED.get(cx));
                }
                lines.push(StatusLine::error("usage-failed", message));
            }
            _ => {}
        }
        if self.screen.as_ref().is_some_and(|screen| screen.provenance.has_unavailable_usage()) {
            let message = shared::copy::phrases(
                locale,
                copy::INCOMPLETE_TITLE.get(cx),
                copy::INCOMPLETE_BODY.get(cx),
            );
            lines.push(StatusLine::info("usage-incomplete", message));
        }
        lines
    }

    fn render_toolbar(&self, cx: &mut Context<Self>) -> AnyElement {
        let range = self.view(cx).range;
        let loading = self.refreshing || self.state == ScreenState::Loading;
        // Desktop's period control is the default (medium) segmented
        // control: 32 tall like Refresh, its labels 14/500.
        let track = segmented_track_md(cx)
            .id("usage-range")
            .test_support()
            .aria_label(copy::USAGE_RANGE.get(cx))
            .flex_shrink_0()
            .children(UsageRange::ALL.map(|choice| {
                let button = Button::new(domain_element_id("usage-range", choice.key()));
                segment_md(button, choice.label().get(cx), choice == range, cx)
                    .flex_none()
                    .px_3()
                    .on_click(cx.listener(move |this, _, _, cx| this.set_range(choice, cx)))
            }));
        // Health's recipe: when the figures were read, then a labelled
        // quiet Refresh.
        let locale = Locale::current(cx);
        let refresh = settings_button("usage-refresh", health_copy::HEALTH_REFRESH.get(cx), cx)
            .loading(loading)
            .accessibility_label(copy::USAGE_REFRESH.get(cx))
            .disabled(!self.host.read(cx).is_connected())
            .on_click(cx.listener(|this, _, _, cx| this.refresh(cx)));
        let read = self.read_at.map(|read_at| {
            let time = relative_time(locale, read_at, now_ms(), local_utc_offset());
            let line = health_copy::last_read(locale, &time);
            div()
                .id("usage-last-read")
                .test_support()
                .aria_label(line.clone())
                .text_xs()
                .text_color(cx.maka().ink_muted)
                .child(line)
        });
        h_flex()
            .w_full()
            .items_center()
            .justify_between()
            .gap_2()
            .child(track)
            .child(h_flex().gap_3().items_center().children(read).child(refresh))
            .into_any_element()
    }

    fn render_summary(&self, cx: &mut Context<Self>) -> AnyElement {
        let locale = Locale::current(cx);
        let screen = self.screen.as_deref();
        let dash = || "—".to_owned();
        let cost = match screen {
            Some(screen) => match screen.provenance.estimated_cost(screen.summary.total_cost_usd) {
                Some(cost) => format!("${cost:.2}"),
                None if screen.summary.total_requests == 0 => "$0.00".to_owned(),
                None => copy::COST_UNAVAILABLE.get(cx).to_owned(),
            },
            None => dash(),
        };
        let summary = screen.map(|screen| screen.summary);
        let tiles = [
            (
                "requests",
                copy::TOTAL_REQUESTS.get(cx),
                summary.map_or_else(dash, |s| compact_count(s.total_requests)),
                screen.map(|screen| copy::models_used(locale, screen.by_model.len() as u64)),
            ),
            ("cost", copy::TOTAL_COST.get(cx), cost, Some(copy::COST_HELP.get(cx).to_owned())),
            (
                "tokens",
                copy::TOTAL_TOKENS.get(cx),
                summary.map_or_else(dash, |s| compact_count(s.total_tokens)),
                summary.map(|s| {
                    copy::token_detail(
                        locale,
                        &compact_count(s.input_tokens),
                        &compact_count(s.output_tokens),
                    )
                }),
            ),
            (
                "cache",
                copy::CACHE_TOKENS.get(cx),
                summary.map_or_else(dash, |s| compact_count(s.cache_tokens)),
                summary.map(|s| {
                    copy::cache_detail(
                        locale,
                        &compact_count(s.cache_miss),
                        &compact_count(s.cache_read),
                        &compact_count(s.cache_creation),
                    )
                }),
            ),
        ];
        let maka = cx.maka();
        h_flex()
            .id("usage-summary")
            .test_support()
            .aria_label(copy::USAGE_SUMMARY.get(cx))
            .w_full()
            .flex_wrap()
            // Cards of one height, top-aligned, whatever lines each has;
            // Desktop's `.settingsUsageSummary` and `.settingsMetricCard`:
            // 6 apart, padding 6/10, 2 between the lines.
            .items_stretch()
            .gap_1p5()
            .children(tiles.into_iter().map(|(key, label, value, detail)| {
                let spoken = shared::copy::labeled(locale, label, &value);
                v_flex()
                    .id(domain_element_id("usage-figure", key))
                    .test_support()
                    .aria_label(spoken)
                    .flex_1()
                    .min_w(rems(7.5))
                    .gap_0p5()
                    .py_1p5()
                    .px_2p5()
                    .rounded(RADIUS_SURFACE)
                    .border_1()
                    .border_color(maka.border)
                    .child(
                        div()
                            .text_size(rems(FIGURE_TEXT_REMS))
                            .line_height(rems(FIGURE_LINE_REMS))
                            .font_weight(gpui_kit::FontWeight::SEMIBOLD)
                            .font_features(tabular_nums())
                            .text_color(maka.ink)
                            .child(value),
                    )
                    .child(supporting(label.to_owned(), maka.ink))
                    .children(detail.map(|detail| supporting(detail, maka.ink_muted)))
            }))
            .into_any_element()
    }

    fn render_tabs(&self, cx: &mut Context<Self>) -> AnyElement {
        let tab = self.view(cx).active_tab;
        let screen = self.screen.as_deref();
        let count = |tab: UsageTab| -> u64 {
            screen.map_or(0, |screen| match tab {
                UsageTab::Requests => screen.activity_total,
                UsageTab::Providers => screen.by_provider.len() as u64,
                UsageTab::Models => screen.by_model.len() as u64,
                UsageTab::Tools => screen.by_tool.len() as u64,
                UsageTab::Pricing => screen.pricing.len() as u64,
            })
        };
        let selected = UsageTab::ALL.iter().position(|each| *each == tab).unwrap_or(0);
        let maka = cx.maka();
        let locale = Locale::current(cx);
        TabBar::new("usage-tabs")
            .underline()
            .small()
            .selected_index(selected)
            .on_click(cx.listener(|this, ix: &usize, _, cx| {
                if let Some(tab) = UsageTab::ALL.get(*ix) {
                    this.set_tab(*tab, cx);
                }
            }))
            .children(UsageTab::ALL.map(|each| {
                let label = each.label().get(cx);
                let count = count(each);
                // A count reads with its tab: ink on the chosen one.
                let ink = if each == tab { maka.ink } else { maka.ink_muted };
                Tab::new()
                    .label(label)
                    .aria_label(shared::copy::parts(locale, &[label, &count.to_string()]))
                    .suffix(
                        div()
                            .ml_1()
                            .text_xs()
                            .font_features(tabular_nums())
                            .text_color(ink)
                            .child(count.to_string()),
                    )
            }))
            .into_any_element()
    }

    fn render_requests(&self, cx: &mut Context<Self>) -> AnyElement {
        let locale = Locale::current(cx);
        let view = self.view(cx);
        if !view.show_details {
            let show = settings_button("usage-show-details", copy::SHOW_DETAILS.get(cx), cx)
                .on_click(cx.listener(|this, _, _, cx| this.set_show_details(true, cx)));
            return StatusLine::info("usage-summary-only", copy::SUMMARY_ONLY.get(cx))
                .action(show)
                .centred()
                .into_any_element();
        }
        let filtered = self.has_filters(cx);
        let total = self.screen.as_ref().map_or(0, |screen| screen.activity_total);
        let this = cx.weak_entity();
        let details = Switch::new("usage-details")
            .checked(view.show_details)
            .accessibility_label(copy::DETAILS_LABEL.get(cx))
            .on_change(move |on, _, cx| {
                this.update(cx, |this, cx| this.set_show_details(*on, cx)).ok();
            });
        let clear = quiet_button(Button::new("usage-clear-filters"), cx)
            .label(copy::CLEAR_FILTERS.get(cx))
            .disabled(!filtered)
            .on_click(cx.listener(|this, _, window, cx| this.clear_filters(window, cx)));
        // Two fixed lines rather than one that wraps: a wrapped line's
        // height went uncounted and its last controls lay over the table.
        // The search and the status share the first; the switch, the count
        // and Clear filters the second.
        let filters = v_flex()
            .id("usage-filters")
            .test_support()
            .w_full()
            .gap_3()
            .child(
                h_flex()
                    .w_full()
                    .items_center()
                    .gap_3()
                    .child(
                        div().flex_1().min_w_0().child(
                            Input::new(&self.filter)
                                .field_fill(cx)
                                .id("usage-filter")
                                .aria_label(copy::FILTER_LABEL.get(cx))
                                .cleanable(true),
                        ),
                    )
                    .child(
                        div().flex_shrink_0().w(rems(12.)).child(
                            Select::new(&self.status)
                                .id("usage-status")
                                .accessibility_label(copy::STATUS_LABEL.get(cx)),
                        ),
                    ),
            )
            .child(
                h_flex()
                    .w_full()
                    .items_center()
                    .gap_3()
                    .child(
                        h_flex()
                            .gap_2()
                            .text_sm()
                            .text_color(cx.maka().ink)
                            .child(copy::DETAILS.get(cx))
                            .child(details),
                    )
                    .child(
                        div()
                            .id("usage-record-count")
                            .test_support()
                            .aria_label(copy::records(locale, total))
                            .text_xs()
                            .text_color(cx.maka().ink_muted)
                            .child(copy::records(locale, total)),
                    )
                    .child(div().flex_1())
                    .child(clear),
            );
        let logs = self.screen.as_ref().map_or(&[][..], |screen| &screen.logs[..]);
        let start = (self.page - 1) * USAGE_PAGE_SIZE;
        let shown: Vec<&UsageRequestLog> = logs.iter().skip(start).take(USAGE_PAGE_SIZE).collect();
        let offset = local_utc_offset();
        let columns = [
            Column::fixed(copy::HEADER_TIME, 12.),
            Column::fixed(copy::HEADER_TYPE, 5.),
            Column::grow(copy::HEADER_TARGET),
            Column::fixed(copy::HEADER_TASK, 12.),
            Column::numeric(copy::HEADER_TOKENS),
            Column::numeric(copy::HEADER_COST),
            Column::numeric(copy::HEADER_LATENCY),
            Column::fixed(copy::HEADER_STATUS, 5.),
        ];
        let rows: Vec<(SharedString, Vec<AnyElement>)> = shown
            .iter()
            .map(|row| {
                let cells = vec![
                    text_cell(locale_date_time(locale, row.ts as u64, offset)),
                    text_cell(kind_label(&row.kind).get(cx).to_owned()),
                    text_cell(request_target(row)),
                    self.session_cell(row, cx),
                    text_cell(compact_count(row.input_tokens + row.output_tokens)),
                    text_cell(match (&row.kind, row.cost_usd) {
                        (UsageRowKind::Model, Some(cost)) => format!("${cost:.2}"),
                        _ => "-".to_owned(),
                    }),
                    text_cell(
                        row.latency_ms.map_or("-".to_owned(), |ms| format!("{}ms", ms.round())),
                    ),
                    text_cell(outcome_label(&row.status).get(cx).to_owned()),
                ];
                (SharedString::from(row.id.clone()), cells)
            })
            .collect();
        let empty = if filtered {
            Empty::new(
                "usage-requests-empty",
                copy::FILTERED_EMPTY,
                Some(copy::FILTERED_EMPTY_HELP),
            )
        } else {
            Empty::new("usage-requests-empty", copy::REQUEST_EMPTY, None)
        };
        let table = table("usage-requests", copy::ACTIVITY_TABLE, &columns, rows, empty, cx);
        v_flex()
            .w_full()
            .gap_3()
            .child(filters)
            .child(table)
            .when(self.page_count() > 1, |this| this.child(self.render_pagination(cx)))
            .into_any_element()
    }

    /// The row's task: a button that shows it, named by the task's title
    /// (or "Untitled session" and the id's start); "Unknown" without one.
    fn session_cell(&self, row: &UsageRequestLog, cx: &mut Context<Self>) -> AnyElement {
        let Some(session) = row.session_id.clone() else {
            return text_cell(copy::UNKNOWN.get(cx).to_owned());
        };
        let label = match row.session_name.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
            Some(name) => name.to_owned(),
            None => {
                let short: String = session.chars().take(8).collect();
                format!("{} · {short}", copy::UNTITLED_SESSION.get(cx))
            }
        };
        let tooltip = copy::open_session(Locale::current(cx), &label);
        let id: SharedString = session.into();
        Button::new(domain_element_id("usage-open-task", &row.id))
            .ghost()
            .xsmall()
            .max_w_full()
            .child(div().truncate().text_sm().child(label))
            .accessibility_label(tooltip.clone())
            .tooltip(tooltip)
            .on_click(cx.listener(move |_, _, _, cx| cx.emit(UsagePageEvent::OpenTask(id.clone()))))
            .into_any_element()
    }

    fn render_pagination(&self, cx: &mut Context<Self>) -> AnyElement {
        let locale = Locale::current(cx);
        let (page, count) = (self.page, self.page_count());
        let mut pages: Vec<usize> = [1, page.saturating_sub(1), page, page + 1, count]
            .into_iter()
            .filter(|each| (1..=count).contains(each))
            .collect();
        pages.sort_unstable();
        pages.dedup();
        let mut items: Vec<AnyElement> = Vec::new();
        let arrow = |id: &'static str,
                     icon: MakaIcon,
                     label: Text,
                     target: usize,
                     cx: &mut Context<Self>| {
            Button::new(id)
                .ghost()
                .small()
                .size_7()
                .icon(Icon::new(icon).size_4())
                .accessibility_label(label.get(cx))
                .disabled(target == 0 || !self.can_visit(target))
                .on_click(cx.listener(move |this, _, _, cx| this.go_to_page(target, cx)))
                .into_any_element()
        };
        items.push(arrow(
            "usage-page-previous",
            MakaIcon::ChevronLeft,
            copy::PREVIOUS_PAGE,
            page - 1,
            cx,
        ));
        let mut previous = None;
        for each in pages {
            if previous.is_some_and(|previous| each - previous > 1) {
                items.push(
                    div()
                        .px_1()
                        .text_sm()
                        .text_color(cx.maka().ink_muted)
                        .child("…")
                        .into_any_element(),
                );
            }
            previous = Some(each);
            let button = Button::new(domain_element_id("usage-page", &each.to_string()))
                .small()
                .label(each.to_string())
                .accessibility_label(copy::go_to_page(locale, each))
                .disabled(!self.can_visit(each))
                .on_click(cx.listener(move |this, _, _, cx| this.go_to_page(each, cx)));
            let button = if each == page { button.outline() } else { button.ghost() };
            items.push(button.into_any_element());
        }
        items.push(arrow("usage-page-next", MakaIcon::ChevronRight, copy::NEXT_PAGE, page + 1, cx));
        let progress = self.paging.map(|(loaded, wanted)| {
            copy::page_progress(
                locale,
                loaded.div_ceil(USAGE_PAGE_SIZE),
                wanted.div_ceil(USAGE_PAGE_SIZE),
            )
        });
        v_flex()
            .w_full()
            .items_center()
            .gap_2()
            .children(progress.map(|progress| {
                h_flex()
                    .id("usage-page-progress")
                    .test_support()
                    .aria_label(progress.clone())
                    .gap_2()
                    .text_xs()
                    .text_color(cx.maka().ink_muted)
                    .child(Spinner::new().xsmall())
                    .child(progress)
            }))
            .child(
                h_flex()
                    .id("usage-pages")
                    .test_support()
                    .aria_label(copy::PAGINATION.get(cx))
                    .gap_1()
                    .children(items),
            )
            .into_any_element()
    }

    fn render_breakdown(&self, tab: UsageTab, cx: &mut Context<Self>) -> AnyElement {
        let screen = self.screen.as_deref();
        match tab {
            UsageTab::Providers => {
                let rows = screen.map_or(Vec::new(), |screen| {
                    screen
                        .by_provider
                        .iter()
                        .map(|row| {
                            (
                                SharedString::from(row.provider.clone()),
                                vec![
                                    text_cell(row.provider.clone()),
                                    text_cell(whole(row.requests)),
                                    text_cell(compact_count(row.tokens.round() as u64)),
                                    text_cell(format!("${:.2}", row.cost_usd)),
                                ],
                            )
                        })
                        .collect()
                });
                let columns = [
                    Column::grow(copy::HEADER_PROVIDER),
                    Column::numeric(copy::HEADER_CALLS),
                    Column::numeric(copy::HEADER_TOKENS),
                    Column::numeric(copy::HEADER_COST),
                ];
                let empty = Empty::new(
                    "usage-providers-empty",
                    copy::PROVIDER_EMPTY,
                    Some(copy::PROVIDER_EMPTY_HELP),
                );
                table("usage-providers", copy::PROVIDERS_TABLE, &columns, rows, empty, cx)
            }
            UsageTab::Models => {
                let rows = screen.map_or(Vec::new(), |screen| {
                    screen
                        .by_model
                        .iter()
                        .map(|row| {
                            (
                                SharedString::from(row.model.clone()),
                                vec![
                                    text_cell(row.model.clone()),
                                    text_cell(whole(row.requests)),
                                    text_cell(compact_count(row.tokens.round() as u64)),
                                    text_cell(format!("${:.2}", row.cost_usd)),
                                ],
                            )
                        })
                        .collect()
                });
                let columns = [
                    Column::grow(copy::HEADER_MODEL),
                    Column::numeric(copy::HEADER_CALLS),
                    Column::numeric(copy::HEADER_TOKENS),
                    Column::numeric(copy::HEADER_COST),
                ];
                let empty = Empty::new(
                    "usage-models-empty",
                    copy::MODEL_EMPTY,
                    Some(copy::MODEL_EMPTY_HELP),
                );
                table("usage-models", copy::MODELS_TABLE, &columns, rows, empty, cx)
            }
            UsageTab::Tools => {
                let rows = screen.map_or(Vec::new(), |screen| {
                    screen
                        .by_tool
                        .iter()
                        .map(|row| {
                            (
                                SharedString::from(row.tool.clone()),
                                vec![
                                    text_cell(row.tool.clone()),
                                    text_cell(whole(row.calls)),
                                    text_cell(whole(row.success)),
                                    text_cell(whole(row.errors)),
                                    text_cell(format!("{}ms", row.avg_duration_ms.round())),
                                ],
                            )
                        })
                        .collect()
                });
                let columns = [
                    Column::grow(copy::HEADER_TOOL),
                    Column::numeric(copy::HEADER_TOOL_CALLS),
                    Column::numeric(copy::HEADER_SUCCESS),
                    Column::numeric(copy::HEADER_ERRORS),
                    Column::numeric(copy::HEADER_AVERAGE),
                ];
                let empty =
                    Empty::new("usage-tools-empty", copy::TOOL_EMPTY, Some(copy::TOOL_EMPTY_HELP));
                table("usage-tools", copy::TOOLS_TABLE, &columns, rows, empty, cx)
            }
            _ => {
                let rows = screen.map_or(Vec::new(), |screen| {
                    screen
                        .pricing
                        .iter()
                        .map(|row| {
                            (
                                SharedString::from(format!("{}::{}", row.provider, row.model)),
                                vec![
                                    text_cell(row.provider.clone()),
                                    text_cell(row.model.clone()),
                                    text_cell(format!("${}", row.input_per_m_tok_usd)),
                                    text_cell(format!("${}", row.output_per_m_tok_usd)),
                                ],
                            )
                        })
                        .collect()
                });
                let columns = [
                    Column::grow(copy::HEADER_PROVIDER),
                    Column::grow(copy::HEADER_MODEL),
                    Column::numeric(copy::HEADER_INPUT_PRICE),
                    Column::numeric(copy::HEADER_OUTPUT_PRICE),
                ];
                let empty = Empty::new(
                    "usage-pricing-empty",
                    copy::NO_PRICING,
                    Some(copy::PRICING_EMPTY_HELP),
                );
                table("usage-pricing", copy::PRICING_TABLE, &columns, rows, empty, cx)
            }
        }
    }
}

impl Render for UsagePage {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let tab = self.view(cx).active_tab;
        let panel = match tab {
            UsageTab::Requests => self.render_requests(cx),
            other => self.render_breakdown(other, cx),
        };
        v_flex()
            .id("usage-page")
            .test_support()
            .w_full()
            .gap_6()
            .children(self.render_status(cx))
            .child(
                v_flex()
                    .w_full()
                    .gap_3()
                    .child(self.render_toolbar(cx))
                    .child(self.render_summary(cx)),
            )
            .child(v_flex().w_full().gap_3().child(self.render_tabs(cx)).child(panel))
    }
}

fn status_choices(locale: Locale) -> Vec<Choice<UsageStatus>> {
    UsageStatus::ALL.map(|status| Choice::new(status, status.label().in_locale(locale))).into()
}

fn kind_label(kind: &UsageRowKind) -> Text {
    match kind {
        UsageRowKind::Tool => copy::KIND_TOOL,
        _ => copy::KIND_MODEL,
    }
}

fn outcome_label(outcome: &UsageOutcome) -> Text {
    match outcome {
        UsageOutcome::Error => copy::OUTCOME_ERROR,
        UsageOutcome::Aborted => copy::OUTCOME_ABORTED,
        _ => copy::OUTCOME_SUCCESS,
    }
}

/// The row's target: the tool, else the model, else the provider.
fn request_target(row: &UsageRequestLog) -> String {
    let tool = row.tool_name.as_deref().filter(|name| !name.is_empty());
    let target = match row.kind {
        UsageRowKind::Tool => tool.or(Some(&row.model)).filter(|name| !name.is_empty()),
        _ => Some(row.model.as_str()).filter(|model| !model.is_empty()),
    };
    target
        .or(Some(row.provider.as_str()).filter(|provider| !provider.is_empty()))
        .unwrap_or("-")
        .to_owned()
}

/// `formatCompactTokenCount`: "999", "1.2K", "3M", "1.5B".
pub fn compact_count(value: u64) -> String {
    const UNITS: [(u64, &str); 3] = [(1_000, "K"), (1_000_000, "M"), (1_000_000_000, "B")];
    if value < 1_000 {
        return value.to_string();
    }
    let mut unit = UNITS.len() - 1;
    while unit > 0 && value < UNITS[unit].0 {
        unit -= 1;
    }
    let mut compact = (value as f64 / UNITS[unit].0 as f64 * 10.).round() / 10.;
    if compact >= 1_000. && unit < UNITS.len() - 1 {
        unit += 1;
        compact = 1.;
    }
    format!("{compact}{}", UNITS[unit].1)
}

/// A figure the Host sends as a number, shown whole.
fn whole(value: f64) -> String {
    format!("{}", value.round() as u64)
}

/// Now, in milliseconds since the Unix epoch.
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or_default()
}

fn supporting(text: impl Into<SharedString>, ink: gpui_kit::Hsla) -> gpui_kit::Div {
    div().text_xs().line_height(rems(SUPPORTING_LINE_REMS)).text_color(ink).child(text.into())
}

fn text_cell(text: impl Into<SharedString>) -> AnyElement {
    div().min_w_0().truncate().child(text.into()).into_any_element()
}

/// A table column: its header and how it takes the width.
#[derive(Clone, Copy)]
struct Column {
    header: Text,
    width: Option<f32>,
    numeric: bool,
}

impl Column {
    fn fixed(header: Text, width: f32) -> Self {
        Self { header, width: Some(width), numeric: false }
    }

    fn grow(header: Text) -> Self {
        Self { header, width: None, numeric: false }
    }

    fn numeric(header: Text) -> Self {
        Self { header, width: Some(5.5), numeric: true }
    }
}

/// What an empty table says instead.
struct Empty {
    key: &'static str,
    title: Text,
    body: Option<Text>,
}

impl Empty {
    fn new(key: &'static str, title: Text, body: Option<Text>) -> Self {
        Self { key, title, body }
    }
}

/// A read-only table (Desktop's `UsageStatsTable`): a header row of 12/500
/// muted labels, then one row per item under `border_soft` rules, numbers
/// right-aligned in tabular figures; `empty` when there are no rows.
fn table(
    key: &'static str,
    label: Text,
    columns: &[Column],
    rows: Vec<(SharedString, Vec<AnyElement>)>,
    empty: Empty,
    cx: &App,
) -> AnyElement {
    let maka = cx.maka();
    if rows.is_empty() {
        return v_flex()
            .id(empty.key)
            .test_support()
            .aria_label(empty.title.get(cx))
            .w_full()
            .items_center()
            .gap_1()
            .py_8()
            .rounded(RADIUS_SURFACE)
            .border_1()
            .border_color(maka.border_soft)
            .child(
                div()
                    .text_sm()
                    .font_weight(gpui_kit::FontWeight::MEDIUM)
                    .text_color(maka.ink)
                    .child(empty.title.get(cx)),
            )
            .children(empty.body.map(|body| supporting(body.get(cx), maka.ink_muted)))
            .into_any_element();
    }
    let lay_out = |cell: gpui_kit::Div, column: &Column| {
        let cell = match column.width {
            Some(width) => cell.w(rems(width)).flex_shrink_0(),
            None => cell.flex_1().min_w_0(),
        };
        if column.numeric { cell.justify_end().text_right() } else { cell }
    };
    let header = h_flex()
        .w_full()
        .gap_3()
        .py_1p5()
        .text_xs()
        .font_weight(gpui_kit::FontWeight::MEDIUM)
        .text_color(maka.ink_muted)
        .children(columns.iter().map(|column| {
            lay_out(h_flex(), column).child(div().truncate().child(column.header.get(cx)))
        }));
    let mut body = Vec::with_capacity(rows.len() * 2);
    for (id, cells) in rows {
        body.push(div().h_px().w_full().bg(maka.border_soft).into_any_element());
        body.push(
            h_flex()
                .id(domain_element_id(key, &id))
                .test_support()
                .w_full()
                .items_center()
                .gap_3()
                .min_h(px(36.))
                .text_sm()
                .text_color(maka.ink)
                .font_features(tabular_nums())
                .children(
                    cells
                        .into_iter()
                        .zip(columns.iter())
                        .map(|(cell, column)| lay_out(h_flex(), column).child(cell)),
                )
                .into_any_element(),
        );
    }
    v_flex()
        .id(key)
        .test_support()
        .aria_label(label.get(cx))
        .w_full()
        .overflow_hidden()
        .rounded(cx.theme().radius)
        .child(header)
        .children(body)
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_compact_as_desktop_writes_them() {
        for (value, expected) in [
            (0, "0"),
            (999, "999"),
            (1_000, "1K"),
            (1_234, "1.2K"),
            (999_960, "1M"),
            (12_345_678, "12.3M"),
            (1_500_000_000, "1.5B"),
        ] {
            assert_eq!(compact_count(value), expected, "{value}");
        }
    }

    #[test]
    fn a_range_resolves_to_bounds_ending_now() {
        let now = 40 * DAY_MS;
        assert_eq!(UsageRange::Day.bounds(now), UsageRangeBounds::new(39 * DAY_MS, now));
        assert_eq!(UsageRange::Month.bounds(now), UsageRangeBounds::new(10 * DAY_MS, now));
        assert_eq!(UsageRange::All.bounds(now), UsageRangeBounds::new(0, now));
    }

    #[test]
    fn the_view_reads_desktops_usage_settings_and_defaults_what_it_does_not_know() {
        let view: UsageView = serde_json::from_str(
            r#"{"range":"7d","status":"error","modelFilter":"gpt","showDetails":true,
                "activeTab":"tools"}"#,
        )
        .expect("decode");
        assert_eq!(
            view,
            UsageView {
                range: UsageRange::Week,
                status: UsageStatus::Error,
                show_details: true,
                active_tab: UsageTab::Tools,
            }
        );
        let odd: UsageView =
            serde_json::from_str(r#"{"range":"1y","activeTab":"charts"}"#).expect("decode");
        assert!(odd.is_default());
        assert_eq!(
            serde_json::to_string(&UsageView::default()).expect("encode"),
            r#"{"range":"24h","status":"all","showDetails":false,"activeTab":"requests"}"#
        );
    }
}
