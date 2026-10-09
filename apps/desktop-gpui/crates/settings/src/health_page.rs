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

//! The Health page, after Maka Desktop's
//! (apps/desktop/src/renderer/settings/health-center-page.tsx, the snapshot
//! the main process builds in runtime-host-permissions-ipc-main.ts from
//! packages/core/src/health.ts): the layers this client can fill honestly,
//! each model connection's configuration or validation, and the Runtime
//! probe of the default connection's last real run (`usage.query` logs),
//! with a status filter, the count of signals that block sending, and
//! Refresh.
//!
//! Desktop's other layers describe what only Desktop has: the system
//! permissions and feature switches of Computer Use, the Activity Recorder
//! and the chat bots, and a static note about memory writes. They are left
//! out, not shown as unknown.

use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::spinner::Spinner;
use gpui_kit::component::{Disableable as _, Sizable as _, h_flex, v_flex};
use gpui_kit::{
    AnyElement, App, Context, Entity, InteractiveElement as _, IntoElement, ParentElement as _,
    Render, Role, SharedString, StatefulInteractiveElement as _, Styled as _, Subscription, Task,
    TestSupportExt as _, Window, div, prelude::FluentBuilder as _, rems,
};
use host_protocol::{
    ConnectionEffectFailureClass, ConnectionTestStatus, LlmUsageLog, LlmUsageQuery, UsageOutcome,
    UsageQuery, UsageQueryInput, UsageQueryResult,
};
use shared::copy::health as copy;
use shared::copy::{Locale, Text, failure};
use shared::domain_element_id;
use shared::theme::{ActiveMakaPalette as _, tabular_nums};
use shared::time::{local_utc_offset, relative_time};
use workspace::{
    ConnectionEntry, ConnectionList, HostRequestError, HostRequester, HostSession,
    HostSessionEvent, read_connections,
};

use crate::page_kit::{Tone, status_dot};
use crate::policy::host_error_reason;
use crate::rows::{SettingsGroup, StatusLine, settings_button};

/// Supporting text: 12px on 20px lines.
const SUPPORTING_LINE_REMS: f32 = 1.25;

/// A signal's severity (`HealthSignalStatus`), in Desktop's order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum HealthStatus {
    Ok,
    Info,
    Warning,
    Error,
    Unknown,
}

impl HealthStatus {
    pub const ALL: [Self; 5] = [Self::Ok, Self::Info, Self::Warning, Self::Error, Self::Unknown];

    fn label(self) -> Text {
        match self {
            Self::Ok => copy::STATUS_OK,
            Self::Info => copy::STATUS_INFO,
            Self::Warning => copy::STATUS_WARNING,
            Self::Error => copy::STATUS_ERROR,
            Self::Unknown => copy::STATUS_UNKNOWN,
        }
    }

    fn key(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Info => "info",
            Self::Warning => "warning",
            Self::Error => "error",
            Self::Unknown => "unknown",
        }
    }
}

/// The layers this client fills (`HealthSignalLayer`), in Desktop's order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum HealthLayer {
    Configuration,
    Validation,
    RuntimeProbe,
}

impl HealthLayer {
    pub const ALL: [Self; 3] = [Self::Configuration, Self::Validation, Self::RuntimeProbe];

    fn label(self) -> Text {
        match self {
            Self::Configuration => copy::LAYER_CONFIGURATION,
            Self::Validation => copy::LAYER_VALIDATION,
            Self::RuntimeProbe => copy::LAYER_RUNTIME,
        }
    }

    fn description(self) -> Text {
        match self {
            Self::Configuration => copy::LAYER_CONFIGURATION_HELP,
            Self::Validation => copy::LAYER_VALIDATION_HELP,
            Self::RuntimeProbe => copy::LAYER_RUNTIME_HELP,
        }
    }

    fn key(self) -> &'static str {
        match self {
            Self::Configuration => "configuration",
            Self::Validation => "validation",
            Self::RuntimeProbe => "runtime-probe",
        }
    }
}

/// Where a signal's reading came from (`HealthSignalSource`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Source {
    ConnectionTest,
    RuntimeProbe,
    Settings,
}

/// What a signal says (`HealthSignalMessageCode`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Message {
    Disabled,
    AwaitingDefaultModel,
    ValidationPassed,
    NeedsReauth,
    ValidationFailed,
    NoModelsEnabled,
    NotDefaultSource,
    AwaitingValidation,
    ProbePending,
    SendCompleted,
    SendAborted,
    SendFailed,
}

/// The line under a signal's message (`HealthSignalDetail`).
#[derive(Debug, Clone, PartialEq)]
enum Detail {
    ValidationScope,
    NoModelsHint,
    NotDefaultHint,
    ProbeLayers,
    ProbeResult { model: String, latency_ms: f64, error_class: Option<String> },
    TestError(ConnectionEffectFailureClass),
    TestMessage,
}

/// One health signal (`HealthSignal`).
#[derive(Debug, Clone, PartialEq)]
pub struct HealthSignal {
    id: String,
    /// The connection's name.
    label: String,
    runtime: bool,
    layer: HealthLayer,
    status: HealthStatus,
    source: Source,
    message: Message,
    detail: Option<Detail>,
    blocks_send: bool,
}

impl HealthSignal {
    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn status(&self) -> HealthStatus {
        self.status
    }

    pub fn layer(&self) -> HealthLayer {
        self.layer
    }

    pub fn blocks_send(&self) -> bool {
        self.blocks_send
    }
}

/// `healthSignalFromConnection`: a connection's configuration or, once it
/// is configured, its last validation.
fn connection_signal(
    connection: &ConnectionEntry,
    list: &ConnectionList,
    workspace_has_default: bool,
) -> HealthSignal {
    let signal = |layer, status, source, message, detail, blocks_send| HealthSignal {
        id: format!("connection:{}", connection.slug),
        label: connection.name.to_string(),
        runtime: false,
        layer,
        status,
        source,
        message,
        detail,
        blocks_send,
    };
    use HealthLayer::{Configuration, Validation};
    let configured = list.is_default(&connection.id);
    if !connection.enabled {
        return signal(
            Configuration,
            HealthStatus::Info,
            Source::Settings,
            Message::Disabled,
            None,
            false,
        );
    }
    if !configured && !workspace_has_default {
        let (status, message) = (HealthStatus::Warning, Message::AwaitingDefaultModel);
        return signal(Configuration, status, Source::Settings, message, None, true);
    }
    let test_detail = || {
        connection.last_test.as_ref().and_then(|test| test.error_class.clone()).map(|class| {
            match class {
                ConnectionEffectFailureClass::Auth
                | ConnectionEffectFailureClass::Timeout
                | ConnectionEffectFailureClass::ProviderUnavailable
                | ConnectionEffectFailureClass::Network
                | ConnectionEffectFailureClass::Unknown => Detail::TestError(class),
                _ => Detail::TestMessage,
            }
        })
    };
    let source = Source::ConnectionTest;
    match connection.last_test.as_ref().map(|test| &test.status) {
        Some(ConnectionTestStatus::Verified) => {
            let (status, message) = (HealthStatus::Ok, Message::ValidationPassed);
            return signal(
                Validation,
                status,
                source,
                message,
                Some(Detail::ValidationScope),
                false,
            );
        }
        Some(ConnectionTestStatus::NeedsReauth) => {
            let (status, message) = (HealthStatus::Error, Message::NeedsReauth);
            return signal(Validation, status, source, message, test_detail(), true);
        }
        Some(ConnectionTestStatus::Error) => {
            let (status, message) = (HealthStatus::Warning, Message::ValidationFailed);
            return signal(Validation, status, source, message, test_detail(), true);
        }
        _ => {}
    }
    if !configured {
        if connection.models.is_empty() {
            let (status, message) = (HealthStatus::Warning, Message::NoModelsEnabled);
            let detail = Some(Detail::NoModelsHint);
            return signal(Configuration, status, Source::Settings, message, detail, false);
        }
        let (status, message) = (HealthStatus::Info, Message::NotDefaultSource);
        let detail = Some(Detail::NotDefaultHint);
        return signal(Configuration, status, Source::Settings, message, detail, false);
    }
    signal(Validation, HealthStatus::Unknown, source, Message::AwaitingValidation, None, false)
}

/// `healthSignalFromConnectionRuntime`: the default connection's last real
/// run, when it is enabled.
fn runtime_signal(
    connection: &ConnectionEntry,
    list: &ConnectionList,
    probe: Option<&LlmUsageLog>,
) -> Option<HealthSignal> {
    if !connection.enabled || !list.is_default(&connection.id) {
        return None;
    }
    let (status, message, detail) = match probe {
        None => (HealthStatus::Unknown, Message::ProbePending, Detail::ProbeLayers),
        Some(row) => {
            let (status, message) = match row.status {
                UsageOutcome::Success => (HealthStatus::Ok, Message::SendCompleted),
                UsageOutcome::Aborted => (HealthStatus::Info, Message::SendAborted),
                _ => (HealthStatus::Warning, Message::SendFailed),
            };
            let detail = Detail::ProbeResult {
                model: row.model_id.clone(),
                latency_ms: row.latency_ms,
                error_class: row.error_class.clone(),
            };
            (status, message, detail)
        }
    };
    Some(HealthSignal {
        id: format!("connection:{}:runtime", connection.slug),
        label: connection.name.to_string(),
        runtime: true,
        layer: HealthLayer::RuntimeProbe,
        status,
        source: Source::RuntimeProbe,
        message,
        detail: Some(detail),
        // Historical probe failures inform, but never gate the next send.
        blocks_send: false,
    })
}

/// The signals of `list`, each connection's, then its runtime probe's, as
/// the main process lists them. `probe` is the default connection's last
/// model call.
fn signals(list: &ConnectionList, probe: Option<&LlmUsageLog>) -> Vec<HealthSignal> {
    // `workspaceHasDefaultModelTarget`: an enabled connection holds it.
    let has_default = list.enabled().any(|connection| list.is_default(&connection.id));
    list.connections
        .iter()
        .flat_map(|connection| {
            [
                Some(connection_signal(connection, list, has_default)),
                runtime_signal(connection, list, probe),
            ]
        })
        .flatten()
        .collect()
}

/// A snapshot: when it was read and its signals.
#[derive(Debug, Clone, PartialEq)]
struct Snapshot {
    checked_at: u64,
    signals: Vec<HealthSignal>,
}

#[derive(Debug, Clone, PartialEq)]
enum HealthState {
    Idle,
    Loading,
    Loaded(Snapshot),
    Failed(SharedString),
}

/// Behavior and presentation owner of the Health page. It reads a snapshot
/// when the page shows, on Refresh and on a new connection; the last one
/// stays while another is read.
pub struct HealthPage {
    host: Entity<HostSession>,
    state: HealthState,
    /// The last snapshot, kept while a new one is read or fails.
    snapshot: Option<Snapshot>,
    filter: Option<HealthStatus>,
    active: bool,
    generation: u64,
    _load: Option<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl std::fmt::Debug for HealthPage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HealthPage").field("state", &self.state).finish_non_exhaustive()
    }
}

impl HealthPage {
    pub fn new(host: Entity<HostSession>, cx: &mut Context<Self>) -> Self {
        let subscriptions = vec![
            cx.subscribe(&host, |this, _, event: &HostSessionEvent, cx| {
                if matches!(event, HostSessionEvent::Connected { .. }) && this.active {
                    this.reload(cx);
                }
            }),
            cx.observe(&host, |_, _, cx| cx.notify()),
        ];
        Self {
            host,
            state: HealthState::Idle,
            snapshot: None,
            filter: None,
            active: false,
            generation: 0,
            _load: None,
            _subscriptions: subscriptions,
        }
    }

    /// The page is shown: reads a snapshot.
    pub fn activate(&mut self, cx: &mut Context<Self>) {
        self.active = true;
        self.reload(cx);
    }

    /// The signals of the last snapshot.
    pub fn signals(&self) -> &[HealthSignal] {
        self.snapshot.as_ref().map_or(&[], |snapshot| &snapshot.signals)
    }

    /// Reads a snapshot: the connections, then the default connection's
    /// last model call.
    pub fn reload(&mut self, cx: &mut Context<Self>) {
        if !self.host.read(cx).is_connected() {
            return;
        }
        self.generation += 1;
        let generation = self.generation;
        self.state = HealthState::Loading;
        let requester = self.host.read(cx).requester();
        let locale = Locale::current(cx);
        self._load = Some(cx.spawn(async move |this, cx| {
            let result = read_snapshot(&requester).await;
            this.update(cx, |this, cx| {
                if generation != this.generation {
                    return;
                }
                this._load = None;
                match result {
                    Ok(snapshot) => {
                        // A filter whose status no longer occurs is dropped.
                        let present = this.filter.is_some_and(|filter| {
                            snapshot.signals.iter().any(|signal| signal.status == filter)
                        });
                        if !present {
                            this.filter = None;
                        }
                        this.snapshot = Some(snapshot.clone());
                        this.state = HealthState::Loaded(snapshot);
                    }
                    Err(error) => {
                        log::warn!("the health snapshot failed: {error}");
                        this.state = HealthState::Failed(host_error_reason(&error, locale).into());
                    }
                }
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    fn set_filter(&mut self, status: HealthStatus, cx: &mut Context<Self>) {
        self.filter = if self.filter == Some(status) { None } else { Some(status) };
        cx.notify();
    }

    fn render_summary(&self, snapshot: &Snapshot, cx: &mut Context<Self>) -> AnyElement {
        let locale = Locale::current(cx);
        let maka = cx.maka();
        let offset = local_utc_offset();
        let read = relative_time(locale, snapshot.checked_at, now_ms(), offset);
        let loading = self.state == HealthState::Loading;
        let refresh = settings_button("health-refresh", copy::HEALTH_REFRESH.get(cx), cx)
            .loading(loading)
            .disabled(!self.host.read(cx).is_connected())
            .on_click(cx.listener(|this, _, _, cx| this.reload(cx)));
        let action = h_flex()
            .gap_3()
            .items_center()
            .child(
                div()
                    .id("health-last-read")
                    .test_support()
                    .aria_label(copy::last_read(locale, &read))
                    .text_xs()
                    .text_color(maka.ink_muted)
                    .child(copy::last_read(locale, &read)),
            )
            .child(refresh);
        // Desktop's `SettingsStatusSummaryFilter`: ghost sm buttons with no
        // dot, the label and count 14/20 muted in equal-width figures. A
        // zero count is disabled and in the disabled ink; only a warning or
        // an error above zero takes its colour (`data-tone`).
        let filters = h_flex()
            .id("health-filter")
            .test_support()
            .aria_label(copy::HEALTH_SUMMARY.get(cx))
            // The first label on the column's edge; the buttons' wash reaches
            // past it, as a back link's does.
            .ml(gpui_kit::px(-8.))
            .flex_wrap()
            .gap_1()
            .children(HealthStatus::ALL.map(|status| {
                let count = snapshot.signals.iter().filter(|s| s.status == status).count();
                let selected = self.filter == Some(status);
                let label = status.label().get(cx);
                let ink = match status {
                    _ if count == 0 => maka.ink_disabled,
                    HealthStatus::Warning => maka.warning,
                    HealthStatus::Error => maka.destructive,
                    _ => maka.ink_muted,
                };
                let text = format!("{label} {count}");
                Button::new(domain_element_id("health-filter", status.key()))
                    .ghost()
                    .small()
                    .toggled(selected)
                    .disabled(count == 0)
                    .accessibility_label(copy::filter_label(locale, label, count, selected))
                    .child(
                        div()
                            .id(domain_element_id("health-count", status.key()))
                            .test_support()
                            .aria_label(text.clone())
                            .text_sm()
                            .line_height(rems(1.25))
                            .font_weight(gpui_kit::FontWeight::NORMAL)
                            .font_features(tabular_nums())
                            .text_color(ink)
                            .child(text),
                    )
                    .on_click(cx.listener(move |this, _, _, cx| this.set_filter(status, cx)))
            }));
        // Desktop's Health section: no title, its line as the group's
        // description, the rule, then the summary.
        SettingsGroup::new("health-summary")
            .description(copy::HEALTH_SUBTITLE.get(cx))
            .action(action)
            .bare()
            .child(filters)
            .into_any_element()
    }

    fn render_signal(&self, signal: &HealthSignal, cx: &App) -> AnyElement {
        let locale = Locale::current(cx);
        let maka = cx.maka();
        let label = if signal.runtime {
            copy::runtime_label(locale, &signal.label)
        } else {
            signal.label.clone()
        };
        let message = message_text(signal.message).get(cx);
        let detail = signal.detail.as_ref().map(|detail| detail_text(detail, locale));
        let mut meta: Vec<(String, Option<gpui_kit::Hsla>)> = Vec::new();
        // Every reading here is its own source; Desktop leaves out only its
        // capability snapshot's, which this client has none of.
        meta.push((copy::source(locale, source_text(signal.source).get(cx)), None));
        if signal.blocks_send {
            meta.push((copy::BLOCKS_SEND.get(cx).to_owned(), Some(maka.destructive)));
        }
        let status = signal.status.label().get(cx);
        let tone = match signal.status {
            HealthStatus::Ok => Tone::Success,
            HealthStatus::Warning => Tone::Attention,
            HealthStatus::Error => Tone::Error,
            _ => Tone::Neutral,
        };
        let spoken = [label.as_str(), message, status].join(", ");
        h_flex()
            .id(domain_element_id("health-signal", &signal.id))
            .test_support()
            .aria_label(spoken)
            .w_full()
            .items_start()
            .gap_4()
            .py_2()
            .child(
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .gap_0p5()
                    .child(
                        h_flex()
                            .gap_2()
                            .items_baseline()
                            .child(
                                div()
                                    .text_sm()
                                    .font_weight(gpui_kit::FontWeight::MEDIUM)
                                    .text_color(maka.ink)
                                    .child(label),
                            )
                            .child(supporting(copy::SCOPE_CONNECTION.get(cx), maka.ink_muted)),
                    )
                    .child(supporting(message, maka.ink_muted))
                    .children(detail.map(|detail| supporting(detail, maka.ink_muted)))
                    .child(
                        h_flex()
                            .gap_2()
                            .children(meta.into_iter().map(|(text, ink)| {
                                supporting(text, ink.unwrap_or(maka.ink_muted))
                            })),
                    ),
            )
            .child(status_dot(&format!("health-signal-{}", signal.id), status, tone, cx))
            .into_any_element()
    }
}

impl Render for HealthPage {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let locale = Locale::current(cx);
        let maka = cx.maka();
        let mut lines: Vec<AnyElement> = Vec::new();
        if !self.host.read(cx).is_connected() {
            lines.push(StatusLine::info("health", copy::HEALTH_OFFLINE.get(cx)).into_any_element());
        }
        if let HealthState::Failed(reason) = &self.state {
            let reason = failure(locale, "", reason).trim().to_owned();
            let message = shared::copy::phrases(locale, copy::HEALTH_READ_FAILED.get(cx), &reason);
            let retry = settings_button("health-retry", copy::HEALTH_READ_AGAIN.get(cx), cx)
                .on_click(cx.listener(|this, _, _, cx| this.reload(cx)));
            lines.push(StatusLine::error("health", message).action(retry).into_any_element());
        }
        let Some(snapshot) = self.snapshot.clone() else {
            let loading = matches!(self.state, HealthState::Idle | HealthState::Loading)
                && self.host.read(cx).is_connected();
            return v_flex().w_full().gap_6().children(lines).when(loading, |this| {
                this.child(
                    h_flex()
                        .id("health-loading")
                        .test_support()
                        .gap_2()
                        .text_sm()
                        .text_color(maka.ink_muted)
                        .child(Spinner::new().small())
                        .child(copy::HEALTH_LOADING.get(cx)),
                )
            });
        };
        let total = snapshot.signals.len();
        let blocking = snapshot.signals.iter().filter(|signal| signal.blocks_send).count();
        if blocking > 0 {
            let line =
                StatusLine::error("health-blockers", copy::blocks_send(locale, blocking, total));
            lines.push(line.into_any_element());
        }
        let visible: Vec<&HealthSignal> = snapshot
            .signals
            .iter()
            .filter(|signal| self.filter.is_none_or(|filter| signal.status == filter))
            .collect();
        // One section of rows, each layer under its own quiet sub-header
        // (Desktop's `settingsRowsSubheading`): the layers group the
        // signals, they are not sections of the page.
        let rows: Vec<AnyElement> = HealthLayer::ALL
            .into_iter()
            .flat_map(|layer| {
                let rows: Vec<AnyElement> = visible
                    .iter()
                    .filter(|signal| signal.layer == layer)
                    .map(|signal| self.render_signal(signal, cx))
                    .collect();
                let head = (!rows.is_empty()).then(|| layer_heading(layer, cx));
                head.into_iter().chain(rows)
            })
            .collect();
        let body = if snapshot.signals.is_empty() {
            StatusLine::info("health-empty", copy::HEALTH_EMPTY.get(cx)).into_any_element()
        } else {
            div()
                .id("health-signals")
                .w_full()
                .child(SettingsGroup::new("health-signals").children(rows))
                .into_any_element()
        };
        v_flex()
            .w_full()
            .gap_8()
            .child(self.render_summary(&snapshot, cx))
            .children(lines)
            .child(body)
            .child(supporting(copy::HEALTH_FOOTNOTE.get(cx), maka.ink_muted))
    }
}

fn message_text(message: Message) -> Text {
    match message {
        Message::Disabled => copy::MESSAGE_DISABLED,
        Message::AwaitingDefaultModel => copy::MESSAGE_AWAITING_DEFAULT,
        Message::ValidationPassed => copy::MESSAGE_VALIDATION_PASSED,
        Message::NeedsReauth => copy::MESSAGE_NEEDS_REAUTH,
        Message::ValidationFailed => copy::MESSAGE_VALIDATION_FAILED,
        Message::NoModelsEnabled => copy::MESSAGE_NO_MODELS,
        Message::NotDefaultSource => copy::MESSAGE_NOT_DEFAULT,
        Message::AwaitingValidation => copy::MESSAGE_AWAITING_VALIDATION,
        Message::ProbePending => copy::MESSAGE_PROBE_PENDING,
        Message::SendCompleted => copy::MESSAGE_SEND_COMPLETED,
        Message::SendAborted => copy::MESSAGE_SEND_ABORTED,
        Message::SendFailed => copy::MESSAGE_SEND_FAILED,
    }
}

fn source_text(source: Source) -> Text {
    match source {
        Source::ConnectionTest => copy::SOURCE_CONNECTION_TEST,
        Source::RuntimeProbe => copy::SOURCE_RUNTIME_PROBE,
        Source::Settings => copy::SOURCE_SETTINGS,
    }
}

fn test_error_text(class: &ConnectionEffectFailureClass) -> Option<Text> {
    Some(match class {
        ConnectionEffectFailureClass::Auth => copy::TEST_AUTH,
        ConnectionEffectFailureClass::Timeout => copy::TEST_TIMEOUT,
        ConnectionEffectFailureClass::ProviderUnavailable => copy::TEST_PROVIDER,
        ConnectionEffectFailureClass::Network => copy::TEST_NETWORK,
        ConnectionEffectFailureClass::Unknown => copy::TEST_UNKNOWN,
        _ => return None,
    })
}

fn detail_text(detail: &Detail, locale: Locale) -> String {
    let text = match detail {
        Detail::ValidationScope => copy::DETAIL_VALIDATION_SCOPE,
        Detail::NoModelsHint => copy::DETAIL_NO_MODELS,
        Detail::NotDefaultHint => copy::DETAIL_NOT_DEFAULT,
        Detail::ProbeLayers => copy::DETAIL_PROBE_LAYERS,
        Detail::TestMessage => copy::DETAIL_TEST_MESSAGE,
        Detail::TestError(class) => test_error_text(class).unwrap_or(copy::DETAIL_TEST_MESSAGE),
        Detail::ProbeResult { model, latency_ms, error_class } => {
            // `localizedRuntimeErrorClass`: a connection test's class in
            // words, "unknown" as such, any other class as it is.
            let error = error_class.as_deref().map(|class| {
                let normalized = class.to_lowercase();
                if normalized == "unknown" {
                    return copy::RUNTIME_UNKNOWN_ERROR.in_locale(locale).to_owned();
                }
                test_error_text(&ConnectionEffectFailureClass::from_wire(&normalized))
                    .map_or_else(|| class.to_owned(), |text| text.in_locale(locale).to_owned())
            });
            let latency = format!("{}", latency_ms.round());
            return copy::probe_result(locale, model, &latency, error.as_deref());
        }
    };
    text.in_locale(locale).to_owned()
}

/// Supporting text, 12/20 at weight 400 (a row's body never takes its
/// title's weight).
fn supporting(text: impl Into<SharedString>, ink: gpui_kit::Hsla) -> gpui_kit::Div {
    div()
        .text_xs()
        .line_height(rems(SUPPORTING_LINE_REMS))
        .font_weight(gpui_kit::FontWeight::NORMAL)
        .text_color(ink)
        .child(text.into())
}

/// A layer's sub-header among the signal rows (Desktop's
/// `settingsRowsSubheading`): its name 12/500 in ink over its line 12/20
/// muted, 12 above and 4 below, so it binds to the rows under it. Its
/// element is `domain_element_id("health-layer", key)`, a heading named by
/// the layer.
fn layer_heading(layer: HealthLayer, cx: &App) -> AnyElement {
    let maka = cx.maka();
    v_flex()
        .id(domain_element_id("health-layer", layer.key()))
        .test_support()
        .role(Role::Heading)
        .aria_label(layer.label().get(cx))
        .w_full()
        .pt_3()
        .pb_1()
        .child(
            div()
                .text_xs()
                .line_height(rems(SUPPORTING_LINE_REMS))
                .font_weight(gpui_kit::FontWeight::MEDIUM)
                .text_color(maka.ink)
                .child(layer.label().get(cx)),
        )
        .child(supporting(layer.description().get(cx), maka.ink_muted))
        .into_any_element()
}

/// Now, in milliseconds since the Unix epoch.
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or_default()
}

/// Reads the connections, then the default connection's last model call
/// (`latestRuntimeProbe`).
async fn read_snapshot(requester: &HostRequester) -> Result<Snapshot, HostRequestError> {
    let list = read_connections(requester).await?;
    let default = list.default_target.clone().and_then(|target| {
        let connection = list.connection(&target.connection_id)?;
        connection.enabled.then(|| (connection.slug.to_string(), target.model_id))
    });
    let probe = match default {
        Some((slug, model)) => {
            let query = LlmUsageQuery::connection(slug, Some(model));
            match requester.request::<UsageQuery>(&UsageQueryInput::latest_llm_log(query)).await? {
                UsageQueryResult::Logs { mut rows, .. } => {
                    (!rows.is_empty()).then(|| rows.swap_remove(0))
                }
                _ => None,
            }
        }
        None => None,
    };
    Ok(Snapshot { checked_at: now_ms(), signals: signals(&list, probe.as_ref()) })
}

#[cfg(test)]
mod tests {
    use host_protocol::{ConnectionTarget, ConnectionTestSummary};
    use workspace::ConnectionModel;

    use super::*;

    fn connection(id: &str, enabled: bool, models: &[&str]) -> ConnectionEntry {
        let models = models.iter().map(|id| ConnectionModel::new(*id, *id)).collect();
        ConnectionEntry::new(id, format!("{id}-slug"), format!("{id} name"), 1, models)
            .with_enabled(enabled)
    }

    fn tested(mut connection: ConnectionEntry, status: ConnectionTestStatus) -> ConnectionEntry {
        let mut test = ConnectionTestSummary::new(status, "2026-09-28T10:00:00.000Z");
        test.error_class = Some(ConnectionEffectFailureClass::Timeout);
        connection = connection.with_state(None, Some(test), None);
        connection
    }

    fn target(connection: &str, model: &str) -> Option<ConnectionTarget> {
        serde_json::from_value(serde_json::json!({"connectionId": connection, "modelId": model}))
            .ok()
    }

    fn summary(signals: &[HealthSignal]) -> Vec<(String, HealthLayer, HealthStatus, bool)> {
        signals
            .iter()
            .map(|signal| (signal.id.clone(), signal.layer, signal.status, signal.blocks_send))
            .collect()
    }

    #[test]
    fn signals_follow_desktops_ladder() {
        use HealthLayer::*;
        use HealthStatus::*;
        let list = ConnectionList::new(
            1,
            target("a", "m1"),
            vec![
                tested(connection("a", true, &["m1"]), ConnectionTestStatus::Verified),
                connection("off", false, &["m1"]),
                connection("b", true, &["m2"]),
                connection("c", true, &[]),
                tested(connection("d", true, &["m3"]), ConnectionTestStatus::Error),
            ],
        );
        let probe: LlmUsageLog = serde_json::from_value(serde_json::json!({
            "source": "llm", "id": "p", "ts": 1.0, "providerId": "x", "modelId": "m1",
            "inputTokens": 1, "outputTokens": 1, "cacheMissTokens": 1, "cacheReadTokens": 0,
            "cacheWriteTokens": 0, "reasoningTokens": 0, "totalTokens": 2, "latencyMs": 820.0,
            "status": "error", "errorClass": "timeout"
        }))
        .expect("probe");
        let listed = signals(&list, Some(&probe));
        assert_eq!(
            summary(&listed),
            [
                ("connection:a-slug".to_owned(), Validation, Ok, false),
                ("connection:a-slug:runtime".to_owned(), RuntimeProbe, Warning, false),
                ("connection:off-slug".to_owned(), Configuration, Info, false),
                ("connection:b-slug".to_owned(), Configuration, Info, false),
                ("connection:c-slug".to_owned(), Configuration, Warning, false),
                ("connection:d-slug".to_owned(), Validation, Warning, true),
            ]
        );
        let en = Locale::English;
        assert_eq!(
            detail_text(listed[1].detail.as_ref().expect("detail"), en),
            "Model=m1 · Latency=820ms · Error type=Request timed out"
        );
        assert_eq!(
            detail_text(listed[5].detail.as_ref().expect("detail"), en),
            "Request timed out"
        );

        // With no default anywhere, an enabled connection waits for one and
        // blocks sending; there is no runtime probe to read.
        let list = ConnectionList::new(1, None, vec![connection("b", true, &["m2"])]);
        assert_eq!(
            summary(&signals(&list, None)),
            [("connection:b-slug".to_owned(), Configuration, Warning, true)]
        );
        // The default connection, untested and never run.
        let list = ConnectionList::new(1, target("b", "m2"), vec![connection("b", true, &["m2"])]);
        assert_eq!(
            summary(&signals(&list, None)),
            [
                ("connection:b-slug".to_owned(), Validation, Unknown, false),
                ("connection:b-slug:runtime".to_owned(), RuntimeProbe, Unknown, false),
            ]
        );
    }
}
