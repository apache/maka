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

//! One connection's detail, after Maka Desktop's (`ConnectionDetail` in
//! apps/desktop/src/renderer/settings/provider-connection-detail.tsx, with
//! use-connection-detail.ts): its header (the Default badge, or "Set as
//! default"), then Connection (name, key, service URL, status with "Test
//! connection"), Models (refresh, add by hand, a filter past eight, each
//! model's switch and parameters), Advanced request settings (custom
//! headers, extra body), and Delete connection.
//!
//! A settled value is a row that says what it is; its button turns the
//! row into an editor, one at a time. The key is written, never read: the
//! row says whether one is set.

use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputEvent, InputState, Textarea, TextareaState};
use gpui_kit::component::switch::Switch;
use gpui_kit::component::{Disableable as _, Icon, Sizable as _, WindowExt as _, h_flex, v_flex};
use gpui_kit::{
    AnyElement, App, AppContext as _, Context, Entity, EventEmitter, FontWeight, Hsla,
    InteractiveElement as _, IntoElement, ParentElement as _, Render, Role, SharedString,
    StatefulInteractiveElement as _, Styled as _, Subscription, Task, TestSupportExt as _, Window,
    div, prelude::FluentBuilder as _, rems,
};
use host_protocol::{
    ConnectionEffectFailureClass, ConnectionTestProjection, ConnectionTestStatus, ModelApiProtocol,
    ModelOverride, ProviderDefinition, RequestHeaderUpdate,
};
use shared::copy::models as copy;
use shared::copy::providers::provider_name;
use shared::copy::settings as settings_copy;
use shared::copy::{Locale, Text, failure, sentences};
use shared::dialog::{DialogHeader, DialogHeaderExt as _};
use shared::domain_element_id;
use shared::theme::FadedSwitch;
use shared::theme::FieldFill as _;
use shared::theme::{
    ActiveMakaPalette as _, HEADING_LINE_REMS, HEADING_TEXT_REMS, RADIUS_CONTROL, badge,
    control_button, floating_surface, quiet_button, route_header, tinted,
};
use workspace::{ConnectionCatalog, ConnectionEntry, HostRequester, HostSession};

use crate::add_connection::{
    MODEL_FILTER_THRESHOLD, ModelsTroubleshooting, make_default, models_fetch_message,
    request_url_preview,
};
use crate::connection_ops;
use crate::connections_pane::{connection_display_name, connection_mark, connection_subtitle};
use crate::model_parameters::{ModelFacts, ModelParameters, ParametersEvent, ParametersMode};
use crate::page_kit::status_dot;
use crate::request_customization::{HeadersEditor, format_body_overlay, parse_body_overlay};
use crate::rows::{
    ActionRow, FieldBlock, SettingsGroup, SettingsRow, StatusLine, destructive_button, filter_field,
};

/// What the detail asks of the pane that shows it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum ConnectionDetailEvent {
    /// Back to the connection list.
    Back,
    /// The connection was deleted.
    Removed,
}

/// A row being edited.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EditingRow {
    Name,
    Key,
    Endpoint,
    Headers,
    Body,
}

impl EditingRow {
    fn key(self) -> &'static str {
        match self {
            Self::Name => "connection-name",
            Self::Key => "model-key",
            Self::Endpoint => "endpoint",
            Self::Headers => "request-headers",
            Self::Body => "request-body",
        }
    }
}

/// What the detail is doing, while the Host answers.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Busy {
    Save(EditingRow),
    Test,
    Fetch,
    Models,
    Default,
    Parameters,
    Delete,
}

/// Whether the connection's key is set, as the vault answered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum KeyState {
    Loading,
    Set,
    Missing,
    Unknown,
}

/// A status line an action left under a row.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Note {
    row: &'static str,
    error: bool,
    message: SharedString,
}

/// What an action leaves behind: whether its value was saved (the editor
/// closes), the line to say, and what it learned of the key or the
/// headers.
#[derive(Debug, Default)]
struct Outcome {
    saved: bool,
    note: Option<(bool, SharedString)>,
    key: Option<KeyState>,
    header_names: Option<Vec<SharedString>>,
}

impl Outcome {
    /// Done, with nothing to say.
    fn done() -> Self {
        Self { saved: true, ..Self::default() }
    }

    /// Done, and `message` says what it found.
    fn said(message: impl Into<SharedString>) -> Self {
        Self { saved: true, note: Some((false, message.into())), ..Self::default() }
    }

    /// Refused: nothing was saved, and `message` says why.
    fn refused(message: impl Into<SharedString>) -> Self {
        Self { saved: false, note: Some((true, message.into())), ..Self::default() }
    }

    /// Saved, but what followed failed (`message`).
    fn saved_but(message: Option<SharedString>) -> Self {
        Self { saved: true, note: message.map(|message| (true, message)), ..Self::default() }
    }
}

impl From<Result<(), SharedString>> for Outcome {
    fn from(result: Result<(), SharedString>) -> Self {
        match result {
            Ok(()) => Self::done(),
            Err(message) => Self::refused(message),
        }
    }
}

/// How a connection's status reads beside it: the settings status tones.
pub(crate) use crate::page_kit::Tone;

/// Desktop's `connectionChipStatus`: retired first, then a lapsed sign-in,
/// then a disabled connection (with its last failure), then a failed last
/// test; a healthy or untested one has none.
pub(crate) fn connection_status(connection: &ConnectionEntry) -> Option<(Text, Tone)> {
    let retired =
        ProviderDefinition::find(&connection.provider_type).is_some_and(|p| p.is_retired());
    if retired {
        return Some((copy::STATUS_RETIRED, Tone::Error));
    }
    let status = connection.last_test.as_ref().map(|test| &test.status);
    if status == Some(&ConnectionTestStatus::NeedsReauth) {
        return Some((copy::STATUS_REAUTH, Tone::Attention));
    }
    if !connection.enabled {
        return Some(if status == Some(&ConnectionTestStatus::Error) {
            (copy::STATUS_DISABLED_FAILED, Tone::Error)
        } else {
            (copy::STATUS_DISABLED, Tone::Neutral)
        });
    }
    (status == Some(&ConnectionTestStatus::Error)).then_some((copy::STATUS_FAILED, Tone::Error))
}

/// A connection's status, in the one status recipe ([`status_dot`]).
pub(crate) fn status_badge(key: &str, label: &'static str, tone: Tone, cx: &App) -> AnyElement {
    status_dot(&format!("connection-{key}"), label, tone, cx)
}

/// The last test's failure in words (`lastTest`).
fn last_test_message(class: &ConnectionEffectFailureClass) -> Text {
    match class {
        ConnectionEffectFailureClass::Auth => copy::LAST_TEST_AUTH,
        ConnectionEffectFailureClass::Timeout => copy::LAST_TEST_TIMEOUT,
        ConnectionEffectFailureClass::ProviderUnavailable
        | ConnectionEffectFailureClass::InvalidResponse => copy::LAST_TEST_PROVIDER,
        ConnectionEffectFailureClass::Network => copy::LAST_TEST_NETWORK,
        _ => copy::LAST_TEST_UNKNOWN,
    }
}

/// Whether a saved endpoint embeds credentials (userinfo or any query),
/// so it stays masked (`endpointCarriesCredentials`).
fn endpoint_carries_credentials(url: &str) -> bool {
    let Some((_, rest)) = url.trim().split_once("://") else {
        return false;
    };
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    rest[..authority_end].contains('@') || rest.contains('?')
}

/// The endpoint as the row shows it: userinfo and query values masked
/// (`endpointForDisplay`).
fn endpoint_for_display(url: &str) -> String {
    let url = url.trim();
    let Some((scheme, rest)) = url.split_once("://") else {
        return url.to_owned();
    };
    let (rest, query) = rest.split_once('?').map_or((rest, None), |(r, q)| (r, Some(q)));
    let authority_end = rest.find('/').unwrap_or(rest.len());
    let mut shown = match rest[..authority_end].rsplit_once('@') {
        Some((_, host)) => format!("{scheme}://<redacted>@{host}{}", &rest[authority_end..]),
        None => format!("{scheme}://{rest}"),
    };
    if let Some(query) = query {
        let keys: Vec<String> = query
            .split('&')
            .filter(|pair| !pair.is_empty())
            .map(|pair| format!("{}=<redacted>", pair.split('=').next().unwrap_or_default()))
            .collect();
        shown.push('?');
        shown.push_str(&keys.join("&"));
    }
    shown
}

/// Behavior and presentation owner of one connection's detail.
///
/// It reads the key's status and the saved headers' names when it opens,
/// and the connection itself from the catalog it observes. One action runs
/// at a time; every button waits while one does. An action's outcome is a
/// status line under the row it came from; a refusal keeps the row's
/// editor open with what was typed. The key typed is cleared once the Host
/// has it.
///
/// Keyboard: Tab walks the header's buttons, each row's button (Enter or
/// Space opens its editor), each editor's field and its Save and Cancel,
/// the model search, each model's parameters button and switch, and Delete.
pub struct ConnectionDetail {
    host: Entity<HostSession>,
    catalog: Entity<ConnectionCatalog>,
    connection_id: SharedString,
    editing: Option<EditingRow>,
    name: Entity<InputState>,
    key: Entity<InputState>,
    endpoint: Entity<InputState>,
    body: Entity<TextareaState>,
    headers: Entity<HeadersEditor>,
    header_names: Option<Vec<SharedString>>,
    model_filter: Entity<InputState>,
    key_state: KeyState,
    busy: Option<Busy>,
    /// The enabled models as a switch left them, until the catalog agrees.
    pending_models: Option<Vec<String>>,
    note: Option<Note>,
    parameters: Option<(Entity<ModelParameters>, Subscription)>,
    /// The endpoint field's, made anew with the field (masked or not) at
    /// each edit.
    _endpoint_subscription: Option<Subscription>,
    _request: Option<Task<()>>,
    _load: Vec<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl std::fmt::Debug for ConnectionDetail {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ConnectionDetail")
            .field("connection_id", &self.connection_id)
            .field("editing", &self.editing)
            .field("busy", &self.busy)
            .field("note", &self.note)
            .finish_non_exhaustive()
    }
}

impl EventEmitter<ConnectionDetailEvent> for ConnectionDetail {}

impl ConnectionDetail {
    pub fn new(
        host: Entity<HostSession>,
        catalog: Entity<ConnectionCatalog>,
        connection_id: SharedString,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let name = cx.new(|cx| {
            InputState::new(window, cx).placeholder(copy::CONNECTION_NAME_PLACEHOLDER.get(cx))
        });
        let key = cx.new(|cx| {
            InputState::new(window, cx).masked(true).placeholder(copy::PASTE_MODEL_KEY.get(cx))
        });
        let endpoint = cx.new(|cx| InputState::new(window, cx));
        let body = cx.new(|cx| {
            TextareaState::new(window, cx)
                .auto_grow(6, 12)
                .placeholder("{\n  \"provider\": {\n    \"order\": [\"Anthropic\"]\n  }\n}")
        });
        let headers = cx.new(|_| HeadersEditor::new("detail-headers"));
        let model_filter =
            cx.new(|cx| InputState::new(window, cx).placeholder(copy::SEARCH_MODELS.get(cx)));
        let mut subscriptions = vec![
            cx.observe(&catalog, |this, _, cx| this.catalog_changed(cx)),
            cx.subscribe(&model_filter, |_, _, event: &InputEvent, cx| {
                if matches!(event, InputEvent::Change) {
                    cx.notify();
                }
            }),
        ];
        for (input, row) in [(&name, EditingRow::Name), (&key, EditingRow::Key)] {
            subscriptions.push(cx.subscribe_in(
                input,
                window,
                move |this, _, event: &InputEvent, window, cx| match event {
                    InputEvent::Change => cx.notify(),
                    InputEvent::PressEnter { .. } => this.save_row(row, window, cx),
                    _ => {}
                },
            ));
        }
        subscriptions.push(cx.subscribe(&body, |_, _, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change) {
                cx.notify();
            }
        }));
        let mut this = Self {
            host,
            catalog,
            connection_id,
            editing: None,
            name,
            key,
            endpoint,
            body,
            headers,
            header_names: None,
            model_filter,
            key_state: KeyState::Loading,
            busy: None,
            pending_models: None,
            note: None,
            parameters: None,
            _endpoint_subscription: None,
            _request: None,
            _load: Vec::new(),
            _subscriptions: subscriptions,
        };
        this.load(cx);
        this
    }

    /// The connection, as the catalog last read it.
    pub fn connection(&self, cx: &App) -> Option<ConnectionEntry> {
        self.catalog.read(cx).list()?.connection(&self.connection_id).cloned()
    }

    fn provider(&self, cx: &App) -> Option<&'static ProviderDefinition> {
        ProviderDefinition::find(&self.connection(cx)?.provider_type)
    }

    /// The connection's id.
    pub fn connection_id(&self) -> &SharedString {
        &self.connection_id
    }

    /// Whether an action is in flight.
    pub fn is_busy(&self) -> bool {
        self.busy.is_some()
    }

    /// The models' filter, while it shows: the connection's provider is
    /// not retired and it has more models than fit unfiltered.
    pub fn search_field(&self, cx: &App) -> Option<Entity<InputState>> {
        let connection = self.connection(cx)?;
        let provider = ProviderDefinition::find(&connection.provider_type);
        let retired = provider.is_some_and(ProviderDefinition::is_retired);
        let filtered = Self::model_rows(&connection).len() > MODEL_FILTER_THRESHOLD;
        (!retired && filtered).then(|| self.model_filter.clone())
    }

    /// The row being edited.
    pub fn editing(&self) -> Option<EditingRow> {
        self.editing
    }

    /// The outcome line an action left, if one did.
    pub fn note(&self) -> Option<&SharedString> {
        self.note.as_ref().map(|note| &note.message)
    }

    /// The parameters dialog's editor, while it shows.
    #[cfg(test)]
    pub(crate) fn parameters(&self) -> Option<&Entity<ModelParameters>> {
        self.parameters.as_ref().map(|(editor, _)| editor)
    }

    fn requester(&self, cx: &App) -> HostRequester {
        self.host.read(cx).requester()
    }

    /// Reads the key's status and the saved headers' names.
    fn load(&mut self, cx: &mut Context<Self>) {
        let Some(connection) = self.connection(cx) else {
            return;
        };
        let requester = self.requester(cx);
        let locale = Locale::current(cx);
        let probes = ProviderDefinition::find(&connection.provider_type)
            .is_some_and(|p| p.supports_api_key() || p.is_account());
        let (id, provider_type) = (connection.id.to_string(), connection.provider_type.to_string());
        if probes {
            self.key_state = KeyState::Loading;
            let requester = requester.clone();
            let id = id.clone();
            self._load.push(cx.spawn(async move |this, cx| {
                let status =
                    connection_ops::query_key(&requester, &id, &provider_type, locale).await;
                this.update(cx, |this, cx| {
                    this.key_state = match &status {
                        Ok(status) if status.configured => KeyState::Set,
                        Ok(_) => KeyState::Missing,
                        Err(reason) => {
                            log::warn!("credential.vault.query failed: {reason}");
                            KeyState::Unknown
                        }
                    };
                    if let Err(reason) = status {
                        let what = copy::CREDENTIAL_READ_FAILED.in_locale(locale);
                        this.note = Some(Note {
                            row: EditingRow::Key.key(),
                            error: true,
                            message: failure(locale, what, &reason).into(),
                        });
                    }
                    cx.notify();
                })
                .ok();
            }));
        } else {
            self.key_state = KeyState::Set;
        }
        self._load.push(cx.spawn(async move |this, cx| {
            let names = connection_ops::query_headers(&requester, &id, locale).await;
            this.update(cx, |this, cx| {
                match names {
                    Ok(names) => this.header_names = Some(names),
                    Err(reason) => {
                        let what = copy::HEADERS_READ_FAILED.in_locale(locale);
                        this.note = Some(Note {
                            row: EditingRow::Headers.key(),
                            error: true,
                            message: failure(locale, what, &reason).into(),
                        });
                    }
                }
                cx.notify();
            })
            .ok();
        }));
    }

    fn catalog_changed(&mut self, cx: &mut Context<Self>) {
        if let (Some(pending), Some(connection)) = (&self.pending_models, self.connection(cx))
            && self.busy.is_none()
            && connection.enabled_model_ids() == *pending
        {
            self.pending_models = None;
        }
        cx.notify();
    }

    /// Whether the connection can send a request: a provider without a
    /// required secret, or its key set.
    fn has_usable_credential(&self, cx: &App) -> bool {
        let requires = self.provider(cx).is_some_and(ProviderDefinition::requires_secret);
        !requires || self.key_state == KeyState::Set
    }

    /// Opens `row`'s editor on the saved value, closing any other.
    pub fn edit(&mut self, row: EditingRow, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy.is_some() {
            return;
        }
        let Some(connection) = self.connection(cx) else {
            return;
        };
        self.note = None;
        match row {
            EditingRow::Name => {
                let name = connection.name.clone();
                self.name.update(cx, |input, cx| {
                    input.set_value(name, window, cx);
                    input.focus(window, cx);
                });
            }
            EditingRow::Key => {
                self.key.update(cx, |input, cx| {
                    input.set_value("", window, cx);
                    input.focus(window, cx);
                });
            }
            EditingRow::Endpoint => {
                let saved = self.saved_endpoint(&connection);
                let masked = endpoint_carries_credentials(&saved);
                let placeholder = self.provider(cx).and_then(|p| p.base_url).unwrap_or("https://…");
                self.endpoint = cx.new(|cx| {
                    InputState::new(window, cx)
                        .masked(masked)
                        .placeholder(placeholder)
                        .default_value(saved)
                });
                self._endpoint_subscription = Some(cx.subscribe_in(
                    &self.endpoint,
                    window,
                    |this, _, event: &InputEvent, window, cx| match event {
                        InputEvent::Change => cx.notify(),
                        InputEvent::PressEnter { .. } => {
                            this.save_row(EditingRow::Endpoint, window, cx)
                        }
                        _ => {}
                    },
                ));
                self.endpoint.update(cx, |input, cx| input.focus(window, cx));
            }
            EditingRow::Headers => {
                let names = self.header_names.clone().unwrap_or_default();
                self.headers.update(cx, |headers, cx| headers.reset(&names, window, cx));
            }
            EditingRow::Body => {
                let text = format_body_overlay(connection.request_body_overlay.as_ref());
                self.body.update(cx, |input, cx| {
                    input.set_value(text, window, cx);
                    input.focus(window, cx);
                });
            }
        }
        self.editing = Some(row);
        cx.notify();
    }

    /// Closes the editor without saving.
    pub fn cancel_edit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy.is_some() {
            return;
        }
        if self.editing == Some(EditingRow::Key) {
            self.key.update(cx, |input, cx| input.set_value("", window, cx));
        }
        self.editing = None;
        cx.notify();
    }

    /// The endpoint the row shows and the editor starts from: the saved
    /// one, else the registry's.
    fn saved_endpoint(&self, connection: &ConnectionEntry) -> String {
        connection
            .base_url
            .as_ref()
            .map(ToString::to_string)
            .or_else(|| {
                ProviderDefinition::find(&connection.provider_type)
                    .and_then(|p| p.base_url)
                    .map(str::to_owned)
            })
            .unwrap_or_default()
    }

    /// Whether the row's editor holds something to save.
    fn can_save(&self, row: EditingRow, cx: &App) -> bool {
        let Some(connection) = self.connection(cx) else {
            return false;
        };
        match row {
            EditingRow::Name => {
                let name = self.name.read(cx).value();
                let name = name.trim();
                !name.is_empty() && name != connection.name.as_ref()
            }
            EditingRow::Key => !self.key.read(cx).value().is_empty(),
            EditingRow::Endpoint => {
                self.endpoint.read(cx).value().trim() != self.saved_endpoint(&connection)
            }
            EditingRow::Headers => self.headers.read(cx).has_changes(cx),
            EditingRow::Body => {
                self.body.read(cx).value().as_ref()
                    != format_body_overlay(connection.request_body_overlay.as_ref())
            }
        }
    }

    /// Saves `row`'s editor. A refusal keeps it open with what was typed.
    pub fn save_row(&mut self, row: EditingRow, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy.is_some() || self.editing != Some(row) || !self.can_save(row, cx) {
            return;
        }
        let Some(connection) = self.connection(cx) else {
            return;
        };
        let locale = Locale::current(cx);
        let requester = self.requester(cx);
        let id = connection.id.to_string();
        let provider_type = connection.provider_type.to_string();
        let provider = provider_name(locale, &connection.provider_type).to_owned();
        let discovers = self.provider(cx).is_some_and(ProviderDefinition::supports_model_discovery);
        self.note = None;
        match row {
            EditingRow::Name => {
                let name = self.name.read(cx).value().trim().to_owned();
                self.run(Busy::Save(row), window, cx, async move {
                    let change = |current: &ConnectionEntry| {
                        let mut update = connection_ops::unchanged(current);
                        update.name = name.clone();
                        Ok(update)
                    };
                    connection_ops::update_connection(&requester, &id, change, locale)
                        .await
                        .map_err(|reason| save_failed(&reason, locale))
                        .into()
                });
            }
            EditingRow::Key => {
                let secret = self.key.read(cx).value().to_string();
                self.run(Busy::Save(row), window, cx, async move {
                    let saved =
                        connection_ops::save_key(&requester, &id, &provider_type, secret, locale)
                            .await;
                    let saved = match saved {
                        Ok(saved) => saved,
                        Err(reason) => return Outcome::refused(save_failed(&reason, locale)),
                    };
                    // A new key changes what the catalog answers.
                    let troubleshooting = ModelsTroubleshooting::Key;
                    let refreshed = refresh_after_save(
                        &requester,
                        &id,
                        &provider,
                        discovers,
                        troubleshooting,
                        locale,
                    )
                    .await;
                    let mut outcome = Outcome::saved_but(refreshed.err());
                    outcome.key =
                        Some(if saved.configured { KeyState::Set } else { KeyState::Missing });
                    outcome
                });
            }
            EditingRow::Endpoint => {
                let url = self.endpoint.read(cx).value().trim().to_owned();
                self.run(Busy::Save(row), window, cx, async move {
                    let change = |current: &ConnectionEntry| {
                        let mut update = connection_ops::unchanged(current);
                        update.base_url = (!url.is_empty()).then(|| url.clone());
                        Ok(update)
                    };
                    if let Err(reason) =
                        connection_ops::update_connection(&requester, &id, change, locale).await
                    {
                        return Outcome::refused(save_failed(&reason, locale));
                    }
                    let troubleshooting = ModelsTroubleshooting::Endpoint;
                    let refreshed = refresh_after_save(
                        &requester,
                        &id,
                        &provider,
                        discovers,
                        troubleshooting,
                        locale,
                    )
                    .await;
                    Outcome::saved_but(refreshed.err())
                });
            }
            EditingRow::Headers => {
                let Ok(updates) = self.headers.read(cx).updates(cx) else {
                    self.fail_row(row, copy::REQUEST_HEADERS_INVALID, cx);
                    return;
                };
                self.save_headers(updates, window, cx);
            }
            EditingRow::Body => {
                let Ok(overlay) = parse_body_overlay(&self.body.read(cx).value()) else {
                    self.fail_row(row, copy::REQUEST_BODY_INVALID, cx);
                    return;
                };
                self.run(Busy::Save(row), window, cx, async move {
                    let change = |current: &ConnectionEntry| {
                        Ok(connection_ops::unchanged(current)
                            .with_request_body_overlay(overlay.clone()))
                    };
                    connection_ops::update_connection(&requester, &id, change, locale)
                        .await
                        .map_err(|reason| save_failed(&reason, locale))
                        .into()
                });
            }
        }
    }

    fn fail_row(&mut self, row: EditingRow, text: Text, cx: &mut Context<Self>) {
        self.note = Some(Note { row: row.key(), error: true, message: text.get(cx).into() });
        cx.notify();
    }

    fn save_headers(
        &mut self,
        updates: Vec<RequestHeaderUpdate>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let locale = Locale::current(cx);
        let requester = self.requester(cx);
        let id = self.connection_id.to_string();
        self.run(Busy::Save(EditingRow::Headers), window, cx, async move {
            match connection_ops::replace_headers(&requester, &id, updates, locale).await {
                Ok(names) => Outcome { header_names: Some(names), ..Outcome::done() },
                Err(reason) => Outcome::refused(save_failed(&reason, locale)),
            }
        });
    }

    /// Runs one action: `busy` until `action` resolves; then its outcome
    /// (the editor closed once saved, its line, what it learned), and the
    /// catalog read again.
    fn run(
        &mut self,
        busy: Busy,
        window: &mut Window,
        cx: &mut Context<Self>,
        action: impl Future<Output = Outcome> + 'static,
    ) {
        let row = match &busy {
            Busy::Save(row) => row.key(),
            Busy::Test => "status",
            Busy::Fetch | Busy::Models | Busy::Parameters => "models",
            Busy::Default => "header",
            Busy::Delete => "delete",
        };
        let closes = matches!(busy, Busy::Save(_));
        self.busy = Some(busy);
        self.headers.update(cx, |headers, cx| headers.set_disabled(true, cx));
        self._request = Some(cx.spawn_in(window, async move |this, cx| {
            let outcome = action.await;
            this.update_in(cx, |this, window, cx| {
                this._request = None;
                this.busy = None;
                this.headers.update(cx, |headers, cx| headers.set_disabled(false, cx));
                if outcome.saved && closes {
                    if this.editing == Some(EditingRow::Key) {
                        this.key.update(cx, |input, cx| input.set_value("", window, cx));
                    }
                    this.editing = None;
                }
                if !outcome.saved {
                    this.pending_models = None;
                }
                if let Some(key) = outcome.key {
                    this.key_state = key;
                }
                if let Some(names) = outcome.header_names {
                    this.header_names = Some(names);
                }
                this.note = outcome.note.map(|(error, message)| Note { row, error, message });
                this.catalog.update(cx, |catalog, cx| catalog.reload(cx));
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    /// Tests the connection with one request (`connection.test.run`).
    pub fn test(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy.is_some() || !self.has_usable_credential(cx) {
            return;
        }
        let Some(connection) = self.connection(cx) else {
            return;
        };
        let locale = Locale::current(cx);
        let requester = self.requester(cx);
        let provider = provider_name(locale, &connection.provider_type).to_owned();
        let troubleshooting = self.troubleshooting(cx);
        self.note = None;
        self.run(Busy::Test, window, cx, async move {
            let tested =
                connection_ops::test_connection(&requester, &connection.id, &provider, locale)
                    .await;
            match tested {
                Ok(tested) => match test_outcome(&tested, &connection, troubleshooting, locale) {
                    Ok(message) => Outcome::said(message),
                    Err(message) => Outcome::refused(message),
                },
                Err(reason) => {
                    let what = copy::CONNECTION_TEST_ERROR.in_locale(locale);
                    Outcome::refused(failure(locale, what, &reason))
                }
            }
        });
    }

    /// The settings a failure asks the person to check.
    fn troubleshooting(&self, cx: &App) -> ModelsTroubleshooting {
        match self.provider(cx) {
            Some(provider) if provider.is_account() => ModelsTroubleshooting::Account,
            Some(provider) if provider.supports_api_key() => ModelsTroubleshooting::Key,
            _ => ModelsTroubleshooting::Endpoint,
        }
    }

    /// Lists the connection's models again (`connection.models.fetch`).
    pub fn refresh_models(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy.is_some() || !self.has_usable_credential(cx) {
            return;
        }
        let Some(connection) = self.connection(cx) else {
            return;
        };
        let locale = Locale::current(cx);
        let requester = self.requester(cx);
        let provider = provider_name(locale, &connection.provider_type).to_owned();
        let troubleshooting = self.troubleshooting(cx);
        self.note = None;
        self.run(Busy::Fetch, window, cx, async move {
            match connection_ops::fetch_models(&requester, &connection.id, &provider, locale).await
            {
                Ok(count) => Outcome::said(copy::models_fetched(locale, count)),
                Err(error) => {
                    Outcome::refused(models_fetch_message(&error, troubleshooting, locale))
                }
            }
        });
    }

    /// Turns the model `model` on or off (`connection.catalog.update` with
    /// the enabled models as the catalog now has them, this one added or
    /// removed).
    pub fn set_model_enabled(
        &mut self,
        model: &str,
        enabled: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.busy.is_some() {
            return;
        }
        let Some(connection) = self.connection(cx) else {
            return;
        };
        let mut ids = self.pending_models.clone().unwrap_or_else(|| connection.enabled_model_ids());
        match (enabled, ids.iter().any(|id| id == model)) {
            (true, false) => ids.push(model.to_owned()),
            (false, true) => ids.retain(|id| id != model),
            _ => return,
        }
        self.pending_models = Some(ids);
        let locale = Locale::current(cx);
        let requester = self.requester(cx);
        let model = model.to_owned();
        self.note = None;
        self.run(Busy::Models, window, cx, async move {
            let change = |current: &ConnectionEntry| {
                let mut update = connection_ops::unchanged(current);
                update.enabled_model_ids.retain(|id| *id != model);
                if enabled {
                    update.enabled_model_ids.push(model.clone());
                }
                Ok(update)
            };
            connection_ops::update_connection(&requester, &connection.id, change, locale)
                .await
                .map_err(|reason| {
                    failure(locale, copy::SAVE_MODELS_FAILED.in_locale(locale), &reason).into()
                })
                .into()
        });
    }

    /// Makes the connection the default, on its first enabled model
    /// (`defaultTargetForConnection`).
    pub fn set_as_default(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy.is_some() {
            return;
        }
        let Some(connection) = self.connection(cx) else {
            return;
        };
        let Some(model) = connection.models.first().map(|model| model.id.to_string()) else {
            return;
        };
        let locale = Locale::current(cx);
        let requester = self.requester(cx);
        self.note = None;
        self.run(Busy::Default, window, cx, async move {
            make_default(&requester, &connection.id, &connection.slug, &model, locale)
                .await
                .map_err(|reason| {
                    let what = settings_copy::SET_DEFAULT_FAILED.in_locale(locale);
                    failure(locale, what, &reason).into()
                })
                .into()
        });
    }

    /// Opens a model's parameters, or "Add model" for `None`.
    pub fn open_parameters(
        &mut self,
        model: Option<SharedString>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        // The dialog's own Cancel closes it without telling the detail, so
        // the dialog layer, not `parameters`, says whether one shows.
        if self.busy.is_some() || window.has_active_dialog(cx) {
            return;
        }
        let Some(connection) = self.connection(cx) else {
            return;
        };
        let entry = model
            .as_ref()
            .and_then(|id| connection.catalog_entries.iter().find(|entry| entry.id == id.as_ref()));
        let facts = ModelFacts {
            default_context_window: entry.and_then(|entry| entry.default_context_window),
            default_input_limit: entry.and_then(|entry| entry.default_input_limit),
            default_vision: entry.and_then(|entry| entry.default_supports_vision),
            thinking_levels: entry.map(|entry| entry.thinking_levels.clone()).unwrap_or_default(),
            discovered_protocol: model.as_ref().and_then(|id| {
                connection
                    .stored_models
                    .iter()
                    .find(|stored| stored.id == *id)
                    .and_then(|stored| stored.api_protocol.clone())
            }),
        };
        let declared =
            model.as_ref().and_then(|id| connection.model_overrides.get(id.as_ref()).cloned());
        let existing: Vec<SharedString> = connection
            .catalog_entries
            .iter()
            .map(|entry| SharedString::from(entry.id.clone()))
            .chain(connection.models.iter().map(|model| model.id.clone()))
            .collect();
        let custom_protocol = connection
            .default_api_protocol
            .as_deref()
            .filter(|_| connection.provider_type == host_protocol::CUSTOM_PROVIDER_TYPE)
            .map(ModelApiProtocol::from_wire);
        let mode = match model {
            Some(id) => ParametersMode::Edit(id),
            None => ParametersMode::Add,
        };
        let provider_type = connection.provider_type.clone();
        let editor = cx.new(|cx| {
            ModelParameters::new(
                mode,
                provider_type,
                custom_protocol,
                facts,
                existing,
                declared,
                window,
                cx,
            )
        });
        let subscription =
            cx.subscribe_in(&editor, window, |this, _, event: &ParametersEvent, window, cx| {
                let ParametersEvent::Submit { model, declared, expected } = event;
                this.save_parameters(model.clone(), declared.clone(), expected.clone(), window, cx);
            });
        self.parameters = Some((editor.clone(), subscription));
        let detail = cx.weak_entity();
        let width = window.rem_size() * 32.;
        window.open_dialog(cx, move |dialog, _, cx| {
            let detail = detail.clone();
            let dialog = floating_surface(dialog, cx).w(width).on_close(move |_, _, cx| {
                detail.update(cx, |this, cx| this.parameters_closed(cx)).ok();
            });
            editor.update(cx, |editor, cx| editor.dialog(dialog, cx))
        });
        cx.notify();
    }

    fn parameters_closed(&mut self, cx: &mut Context<Self>) {
        self.parameters = None;
        cx.notify();
    }

    /// Saves `declared` as `model`'s parameters, adding and enabling the
    /// model when it is new; refused when the parameters changed since the
    /// dialog opened.
    fn save_parameters(
        &mut self,
        model: SharedString,
        declared: ModelOverride,
        expected: Option<ModelOverride>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.busy.is_some() {
            return;
        }
        let Some((editor, _)) = &self.parameters else {
            return;
        };
        let editor = editor.clone();
        editor.update(cx, |editor, cx| editor.set_saving(true, cx));
        let locale = Locale::current(cx);
        let requester = self.requester(cx);
        let id = self.connection_id.to_string();
        let adding = expected.is_none();
        self.busy = Some(Busy::Parameters);
        self._request = Some(cx.spawn_in(window, async move |this, cx| {
            let result = connection_ops::update_connection(
                &requester,
                &id,
                |current| {
                    let stored = current.model_overrides.get(model.as_ref());
                    let changed = match &expected {
                        Some(expected) => {
                            stored.map(ModelOverride::normalized).unwrap_or_default()
                                != expected.normalized()
                        }
                        None => {
                            stored.is_some()
                                || current
                                    .enabled_model_ids()
                                    .iter()
                                    .any(|id| *id == model.as_ref())
                        }
                    };
                    if changed {
                        return Err(copy::PARAMETERS_CHANGED.in_locale(locale).into());
                    }
                    let mut table = current.model_overrides.clone();
                    table.insert(model.to_string(), declared.clone());
                    let mut update = connection_ops::unchanged(current).with_model_overrides(table);
                    if adding {
                        update.enabled_model_ids.push(model.to_string());
                    }
                    Ok(update)
                },
                locale,
            )
            .await;
            this.update_in(cx, |this, window, cx| {
                this._request = None;
                this.busy = None;
                match result {
                    Ok(()) => {
                        window.close_dialog(cx);
                        this.parameters = None;
                    }
                    Err(reason) => {
                        let what = if adding {
                            copy::SAVE_MODELS_FAILED
                        } else {
                            copy::SAVE_CONNECTION_FAILED
                        };
                        let message = failure(locale, what.in_locale(locale), &reason);
                        editor.update(cx, |editor, cx| editor.fail(message, cx));
                    }
                }
                this.catalog.update(cx, |catalog, cx| catalog.reload(cx));
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    /// Asks before deleting the connection: an alert naming it and what
    /// goes with it; Delete deletes, Cancel and Escape keep it.
    pub fn confirm_delete(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy.is_some() || window.has_active_dialog(cx) {
            return;
        }
        let Some(connection) = self.connection(cx) else {
            return;
        };
        let locale = Locale::current(cx);
        let default =
            self.catalog.read(cx).list().is_some_and(|list| list.is_default(&connection.id));
        let title: SharedString = copy::delete_connection_title(locale, &connection.name).into();
        let description: SharedString = copy::delete_description(locale, default).into();
        let detail = cx.weak_entity();
        window.open_alert_dialog(cx, move |alert, _, cx| {
            let detail = detail.clone();
            floating_surface(alert, cx)
                .with_header(DialogHeader::new(title.clone()))
                .description(shared::dialog::confirmation_text(description.clone()))
                .footer(shared::dialog::confirmation_answers(
                    settings_copy::CANCEL.in_locale(locale),
                    shared::copy::DELETE.in_locale(locale),
                    true,
                    cx,
                ))
                .on_ok(move |_, window, cx| {
                    detail.update(cx, |this, cx| this.delete(window, cx)).ok();
                    true
                })
        });
    }

    /// Deletes the connection (asked first, [`Self::confirm_delete`]).
    pub fn delete(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy.is_some() {
            return;
        }
        let locale = Locale::current(cx);
        let requester = self.requester(cx);
        let id = self.connection_id.to_string();
        self.note = None;
        self.busy = Some(Busy::Delete);
        self._request = Some(cx.spawn_in(window, async move |this, cx| {
            let result = connection_ops::remove_connection(&requester, &id, locale).await;
            this.update(cx, |this, cx| {
                this._request = None;
                this.busy = None;
                match result {
                    Ok(()) => cx.emit(ConnectionDetailEvent::Removed),
                    Err(reason) => {
                        let what = copy::DELETE_FAILED.in_locale(locale);
                        this.note = Some(Note {
                            row: "delete",
                            error: true,
                            message: failure(locale, what, &reason).into(),
                        });
                    }
                }
                this.catalog.update(cx, |catalog, cx| catalog.reload(cx));
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    /// Back to the list, unless an action is in flight.
    pub fn back(&mut self, cx: &mut Context<Self>) {
        if self.busy.is_none() {
            cx.emit(ConnectionDetailEvent::Back);
        }
    }
}

/// A save that was refused, as its sentence.
fn save_failed(reason: &str, locale: Locale) -> SharedString {
    failure(locale, copy::SAVE_CONNECTION_FAILED.in_locale(locale), reason).into()
}

/// A saved key or endpoint changes what the catalog answers: list the
/// models again when the provider can, and say only a failure.
async fn refresh_after_save(
    requester: &HostRequester,
    connection_id: &str,
    provider: &str,
    discovers: bool,
    troubleshooting: ModelsTroubleshooting,
    locale: Locale,
) -> Result<Option<SharedString>, SharedString> {
    if !discovers {
        return Ok(None);
    }
    match connection_ops::fetch_models(requester, connection_id, provider, locale).await {
        Ok(_) => Ok(None),
        Err(error) => Err(models_fetch_message(&error, troubleshooting, locale)),
    }
}

/// What a test found, as the status row says it (Desktop's toasts): the
/// model that answered and how fast, a warning when it was not one the
/// person enabled, or why it failed.
fn test_outcome(
    tested: &ConnectionTestProjection,
    connection: &ConnectionEntry,
    troubleshooting: ModelsTroubleshooting,
    locale: Locale,
) -> Result<SharedString, SharedString> {
    let label = |id: &str| {
        connection
            .catalog_entries
            .iter()
            .find(|entry| entry.id == id)
            .map_or(id.to_owned(), |entry| entry.label().to_owned())
    };
    match tested {
        ConnectionTestProjection::Verified { model_id, latency_ms, .. } => {
            let enabled = connection.enabled_model_ids();
            if !enabled.is_empty() && !enabled.contains(model_id) {
                let selected: Vec<String> = enabled.iter().map(|id| label(id)).collect();
                let selected: Vec<&str> = selected.iter().map(String::as_str).collect();
                Ok(copy::connection_fallback(locale, &selected, &label(model_id)).into())
            } else {
                Ok(copy::connection_success(locale, model_id, *latency_ms).into())
            }
        }
        ConnectionTestProjection::Failed { status_code, error_class, .. } => {
            let check = match troubleshooting {
                ModelsTroubleshooting::Key => copy::KEY_TROUBLESHOOTING,
                ModelsTroubleshooting::Endpoint => copy::ENDPOINT_TROUBLESHOOTING,
                ModelsTroubleshooting::Account => copy::OAUTH_TROUBLESHOOTING,
            }
            .in_locale(locale);
            // `connectionTestFailureFallback`.
            let reason = if *status_code == Some(429) {
                copy::RATE_LIMITED.in_locale(locale).to_owned()
            } else if *error_class == ConnectionEffectFailureClass::Timeout {
                copy::TIMED_OUT.in_locale(locale).to_owned()
            } else if *error_class == ConnectionEffectFailureClass::Auth
                || matches!(status_code, Some(401 | 403))
            {
                copy::auth_troubleshooting(locale, check)
            } else if *error_class == ConnectionEffectFailureClass::ProviderUnavailable
                || status_code.is_some_and(|code| code >= 500)
            {
                copy::SERVICE_UNAVAILABLE.in_locale(locale).to_owned()
            } else if *error_class == ConnectionEffectFailureClass::Network {
                copy::NETWORK_ERROR.in_locale(locale).to_owned()
            } else {
                copy::recheck_troubleshooting(locale, check)
            };
            Err(sentences(locale, copy::CONNECTION_FAILED.in_locale(locale), &reason).into())
        }
        _ => Err(settings_copy::UNEXPECTED.in_locale(locale).into()),
    }
}

impl ConnectionDetail {
    fn note_for(&self, row: &'static str) -> Option<StatusLine> {
        let note = self.note.as_ref().filter(|note| note.row == row)?;
        Some(if note.error {
            StatusLine::error(row, note.message.clone())
        } else {
            StatusLine::info(row, note.message.clone())
        })
    }

    /// The header: back, the provider's mark, the name, the Default badge
    /// or "Set as default", and the provider · models · default line.
    fn render_header(&self, connection: &ConnectionEntry, cx: &mut Context<Self>) -> AnyElement {
        let maka = cx.maka();
        let locale = Locale::current(cx);
        let list = self.catalog.read(cx).list().cloned();
        let default = list.as_ref().is_some_and(|list| list.is_default(&connection.id));
        let retired =
            ProviderDefinition::find(&connection.provider_type).is_some_and(|p| p.is_retired());
        let busy = self.busy.is_some();
        let slot = if retired {
            None
        } else if default {
            Some(badge(settings_copy::DEFAULT_BADGE.get(cx), cx).into_any_element())
        } else {
            Some(
                quiet_button(Button::new("connection-set-default"), cx)
                    .label(settings_copy::SET_AS_DEFAULT.get(cx))
                    .tooltip(copy::SET_DEFAULT_TITLE.get(cx))
                    .loading(self.busy == Some(Busy::Default))
                    .disabled(busy || connection.models.is_empty())
                    .on_click(cx.listener(|this, _, window, cx| this.set_as_default(window, cx)))
                    .into_any_element(),
            )
        };
        let name = list.as_ref().map_or_else(
            || connection.name.to_string(),
            |list| connection_display_name(connection, list),
        );
        let subtitle = connection_subtitle(connection, list.as_ref(), locale);
        let back = Button::new("connections-back")
            .disabled(busy)
            .on_click(cx.listener(|this, _, _, cx| this.back(cx)));
        v_flex()
            .gap_3()
            .child(route_header(
                back,
                copy::BACK_TO_LIST.get(cx),
                h_flex().items_center().gap_3().child(connection_mark(connection, cx)).child(
                    v_flex()
                        .flex_1()
                        .min_w_0()
                        .gap_0p5()
                        .child(
                            h_flex()
                                .gap_2()
                                .child(
                                    div()
                                        .id("connection-detail-name")
                                        .test_support()
                                        .role(Role::Heading)
                                        .aria_label(SharedString::from(name.clone()))
                                        .truncate()
                                        .text_size(rems(HEADING_TEXT_REMS))
                                        .line_height(rems(HEADING_LINE_REMS))
                                        .font_weight(FontWeight::SEMIBOLD)
                                        .text_color(maka.ink)
                                        .child(name),
                                )
                                .children(slot),
                        )
                        .child(
                            div()
                                .id("connection-detail-subtitle")
                                .test_support()
                                .aria_label(SharedString::from(subtitle.clone()))
                                .truncate()
                                .text_xs()
                                .text_color(maka.ink_muted)
                                .child(subtitle),
                        ),
                ),
                cx,
            ))
            .children(self.note_for("header"))
            .into_any_element()
    }

    /// A settled row with its button, or, while it is edited, its editor
    /// with Save and Cancel.
    fn expandable_row(
        &self,
        row: EditingRow,
        title: &'static str,
        value: impl Into<SharedString>,
        action: Text,
        editor: impl FnOnce(&Self, &mut Context<Self>) -> AnyElement,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let key = row.key();
        let busy = self.busy.is_some();
        if self.editing == Some(row) {
            let saving = self.busy == Some(Busy::Save(row));
            let save = control_button(Button::new(domain_element_id("detail-save", key)).primary())
                .label(settings_copy::SAVE_CHANGE.get(cx))
                .loading(saving)
                .disabled(busy || !self.can_save(row, cx))
                .on_click(cx.listener(move |this, _, window, cx| this.save_row(row, window, cx)));
            let cancel = quiet_button(Button::new(domain_element_id("detail-cancel", key)), cx)
                .label(settings_copy::CANCEL.get(cx))
                .disabled(busy)
                .on_click(cx.listener(|this, _, window, cx| this.cancel_edit(window, cx)));
            return FieldBlock::new(key)
                .field(title, editor(self, cx))
                .status(self.note_for(key))
                .action(cancel)
                .action(save)
                .into_any_element();
        }
        let edit = quiet_button(Button::new(domain_element_id("detail-edit", key)), cx)
            .label(action.get(cx))
            .accessibility_label(format!("{}: {title}", action.get(cx)))
            .disabled(busy)
            .on_click(cx.listener(move |this, _, window, cx| this.edit(row, window, cx)));
        let value = value.into();
        // A URL is machine text: a mono value under the title.
        let settled = if row == EditingRow::Endpoint && value.contains("://") {
            SettingsRow::path(key, title, value)
        } else {
            SettingsRow::new(key, title).detail(value)
        };
        settled.end(edit).status(self.note_for(key)).into_any_element()
    }

    fn render_credentials(
        &self,
        connection: &ConnectionEntry,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let locale = Locale::current(cx);
        let provider = ProviderDefinition::find(&connection.provider_type);
        let supports_key = provider.is_some_and(ProviderDefinition::supports_api_key);
        let account = provider.is_some_and(ProviderDefinition::is_account);
        let editable = provider.is_some_and(ProviderDefinition::endpoint_editable);
        let mut rows: Vec<AnyElement> = Vec::new();
        rows.push(self.expandable_row(
            EditingRow::Name,
            settings_copy::NAME.get(cx),
            connection.name.clone(),
            copy::EDIT,
            |this, cx| {
                Input::new(&this.name)
                    .field_fill(cx)
                    .id("detail-name-field")
                    .aria_label(settings_copy::NAME.get(cx))
                    .disabled(this.busy.is_some())
                    .into_any_element()
            },
            cx,
        ));
        if supports_key {
            let value = match self.key_state {
                KeyState::Set => copy::CONFIGURED,
                KeyState::Loading => copy::KEY_READING,
                KeyState::Unknown => copy::CREDENTIAL_UNKNOWN,
                KeyState::Missing => copy::KEY_MISSING,
            };
            let action = if self.key_state == KeyState::Set { copy::CHANGE } else { copy::SET };
            let signup = provider.and_then(|provider| provider.signup_url);
            rows.push(self.expandable_row(
                EditingRow::Key,
                copy::MODEL_KEY.get(cx),
                value.get(cx),
                action,
                move |this, cx| {
                    v_flex()
                        .w_full()
                        .gap_1()
                        .child(
                            Input::new(&this.key)
                                .field_fill(cx)
                                .id("detail-key-field")
                                .aria_label(copy::MODEL_KEY.get(cx))
                                .mask_toggle()
                                .disabled(this.busy.is_some()),
                        )
                        .children(signup.map(|url| {
                            h_flex().child(
                                Button::new("detail-get-key")
                                    .link()
                                    .small()
                                    .label(copy::GET_MODEL_KEY.get(cx))
                                    .on_click(move |_, _, cx| cx.open_url(url)),
                            )
                        }))
                        .into_any_element()
                },
                cx,
            ));
        }
        let saved = self.saved_endpoint(connection);
        let shown: SharedString = if saved.is_empty() {
            if account { copy::ENDPOINT_MANAGED } else { copy::ENDPOINT_MISSING }.get(cx).into()
        } else {
            endpoint_for_display(&saved).into()
        };
        if editable {
            let masked = endpoint_carries_credentials(&saved);
            // A custom connection's requests go to this URL on its protocol.
            let protocol = (connection.provider_type == host_protocol::CUSTOM_PROVIDER_TYPE)
                .then(|| {
                    connection.default_api_protocol.as_deref().map(ModelApiProtocol::from_wire)
                })
                .flatten();
            rows.push(self.expandable_row(
                EditingRow::Endpoint,
                settings_copy::SERVICE_URL.get(cx),
                shown,
                copy::EDIT,
                move |this, cx| {
                    let typed = this.endpoint.read(cx).value();
                    let preview = protocol
                        .as_ref()
                        .and_then(|protocol| request_url_preview(&typed, protocol))
                        .filter(|_| !masked)
                        .map(|url| {
                            SharedString::from(copy::request_url(Locale::current(cx), &url))
                        });
                    v_flex()
                        .w_full()
                        .gap_1()
                        .child(
                            Input::new(&this.endpoint)
                                .field_fill(cx)
                                .id("detail-endpoint-field")
                                .aria_label(settings_copy::SERVICE_URL.get(cx))
                                .when(masked, |input| input.mask_toggle())
                                .disabled(this.busy.is_some()),
                        )
                        .when(masked, |this| {
                            this.child(
                                div()
                                    .text_xs()
                                    .text_color(cx.maka().ink_muted)
                                    .child(copy::ENDPOINT_CREDENTIALS_MASKED.get(cx)),
                            )
                        })
                        .children(preview.map(|preview| {
                            div()
                                .id("detail-request-url")
                                .test_support()
                                .aria_label(preview.clone())
                                .text_xs()
                                .text_color(cx.maka().ink_muted)
                                .child(preview)
                        }))
                        .into_any_element()
                },
                cx,
            ));
        } else {
            rows.push(
                SettingsRow::path("endpoint", settings_copy::SERVICE_URL.get(cx), shown)
                    .into_any_element(),
            );
        }
        rows.push(self.render_status(connection, locale, cx));
        let help = if supports_key {
            Some(copy::CREDENTIALS_HELP)
        } else if account {
            Some(copy::CREDENTIALS_HELP_ACCOUNT)
        } else {
            None
        };
        SettingsGroup::new("detail-credentials")
            .title(copy::CREDENTIALS.get(cx))
            .when_some(help, |group, help| group.description(help.get(cx)))
            .children(rows)
            .into_any_element()
    }

    /// Healthy, not tested, or what is wrong, with the last test's reason
    /// and time; "Test connection" at the end.
    fn render_status(
        &self,
        connection: &ConnectionEntry,
        locale: Locale,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let issue = connection_status(connection);
        let test = connection.last_test.as_ref();
        let label = match issue {
            Some((text, _)) => text,
            None if test.is_some_and(|test| test.status == ConnectionTestStatus::Verified) => {
                copy::STATUS_HEALTHY
            }
            None => copy::STATUS_UNTESTED,
        }
        .in_locale(locale);
        let mut parts = vec![label.to_owned()];
        if let Some(class) = test.and_then(|test| test.error_class.as_ref()) {
            let message = last_test_message(class).in_locale(locale);
            if message != label {
                parts.push(message.to_owned());
            }
        }
        if let Some(when) = test.and_then(|test| shared::time::parse_iso_time(&test.checked_at)) {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |elapsed| elapsed.as_millis() as u64);
            let offset = shared::time::local_utc_offset();
            parts.push(shared::time::relative_time(locale, when, now, offset));
        }
        let spoken = parts.join(" · ");
        let testing = self.busy == Some(Busy::Test);
        let button = quiet_button(Button::new("connection-test"), cx)
            .label(copy::TEST_CONNECTION.get(cx))
            .loading(testing)
            .disabled(self.busy.is_some() || !self.has_usable_credential(cx))
            .on_click(cx.listener(|this, _, window, cx| this.test(window, cx)));
        // Desktop's connection detail: the last test is a dated fact, not a
        // live signal, so it reads as the row's supporting line (12/20
        // muted, no dot), and only a problem takes colour, as a red token.
        let maka = cx.maka();
        let rest = parts.into_iter().skip(1).map(|part| format!("· {part}"));
        let line = h_flex()
            .id(domain_element_id("settings-state", "connection-detail-status"))
            .test_support()
            .aria_label(spoken)
            .flex_wrap()
            .items_center()
            .gap_1p5()
            .text_xs()
            .line_height(rems(1.25))
            .text_color(maka.ink_muted)
            .map(|this| match issue {
                Some(_) => this.child(
                    h_flex()
                        .flex_shrink_0()
                        .h_5()
                        .px_1p5()
                        .rounded(RADIUS_CONTROL)
                        .bg(tinted(maka.destructive))
                        .text_color(maka.ink)
                        .font_weight(FontWeight::MEDIUM)
                        .child(label.to_owned()),
                ),
                None => this.child(label.to_owned()),
            })
            .children(rest);
        SettingsRow::new("status", copy::STATUS.get(cx))
            .detail_element(line)
            .end(button)
            .status(self.note_for("status"))
            .into_any_element()
    }

    /// The rows: the chat-capable catalog entries, then enabled ids the
    /// catalog no longer lists, in the catalog's order.
    fn model_rows(connection: &ConnectionEntry) -> Vec<(SharedString, SharedString, bool)> {
        let mut rows: Vec<(SharedString, SharedString, bool)> = connection
            .catalog_entries
            .iter()
            .filter(|entry| entry.can_use_as_chat_default)
            .map(|entry| {
                let label = entry.display_name.as_deref().map(str::trim).filter(|n| !n.is_empty());
                (
                    entry.id.clone().into(),
                    label.unwrap_or(&entry.id).to_owned().into(),
                    entry.is_default,
                )
            })
            .collect();
        for model in &connection.models {
            if !rows.iter().any(|(id, _, _)| *id == model.id) {
                rows.push((model.id.clone(), model.label.clone(), false));
            }
        }
        rows
    }

    fn render_models(&self, connection: &ConnectionEntry, cx: &mut Context<Self>) -> AnyElement {
        let locale = Locale::current(cx);
        let busy = self.busy.is_some();
        let enabled = self.pending_models.clone().unwrap_or_else(|| connection.enabled_model_ids());
        let rows = Self::model_rows(connection);
        let total = rows.len();
        let enabled_count =
            rows.iter().filter(|(id, _, _)| enabled.iter().any(|e| e == id.as_ref())).count();
        let query = self.model_filter.read(cx).value().trim().to_lowercase();
        let visible: Vec<_> = rows
            .iter()
            .filter(|(id, label, _)| {
                query.is_empty()
                    || id.to_lowercase().contains(&query)
                    || label.to_lowercase().contains(&query)
            })
            .collect();
        let discovers = self.provider(cx).is_some_and(ProviderDefinition::supports_model_discovery);
        let usable = self.has_usable_credential(cx);
        let actions = h_flex()
            .gap_2()
            .when(discovers, |this| {
                this.child(
                    quiet_button(Button::new("connection-refresh-models"), cx)
                        .label(copy::UPDATE_MODELS.get(cx))
                        .loading(self.busy == Some(Busy::Fetch))
                        .disabled(busy || !usable)
                        .on_click(
                            cx.listener(|this, _, window, cx| this.refresh_models(window, cx)),
                        ),
                )
            })
            .child(
                control_button(Button::new("connection-add-model").primary())
                    .label(copy::ADD_MODEL.get(cx))
                    .disabled(busy)
                    .on_click(
                        cx.listener(|this, _, window, cx| this.open_parameters(None, window, cx)),
                    ),
            );
        let description = if total > 0 {
            copy::models_summary(locale, enabled_count, total)
                + " · "
                + copy::MODEL_MANAGEMENT_HELP.in_locale(locale)
        } else {
            copy::MODEL_MANAGEMENT_HELP.in_locale(locale).to_owned()
        };
        let mut children: Vec<AnyElement> = Vec::new();
        if total > MODEL_FILTER_THRESHOLD {
            children.push(
                div()
                    .w_full()
                    .py_2()
                    .child(filter_field(
                        &self.model_filter,
                        "connection-models-filter",
                        copy::SEARCH_MODELS.get(cx),
                        cx,
                    ))
                    .into_any_element(),
            );
        }
        if total == 0 {
            children
                .push(SettingsRow::new("no-models", copy::NO_MODELS.get(cx)).into_any_element());
        } else if visible.is_empty() {
            children.push(
                SettingsRow::new("no-models", copy::NO_MODELS_MATCH.get(cx)).into_any_element(),
            );
        }
        for (id, label, is_default) in visible {
            let on = enabled.iter().any(|e| e == id.as_ref());
            let (switch_id, parameters_id) = (id.clone(), id.clone());
            let title: SharedString = label.clone();
            let row = SettingsRow::new(format!("model-{id}"), title.clone())
                .when(*is_default, |row| row.end(badge(settings_copy::DEFAULT_BADGE.get(cx), cx)))
                .end(
                    // A 28px ghost icon button, as the rows' other icon
                    // actions.
                    Button::new(domain_element_id("model-parameters-open", id))
                        .ghost()
                        .small()
                        .size_7()
                        .icon(Icon::new(gpui_kit::assets::IconName::Wrench).size_4())
                        .tooltip(copy::SET_PARAMETERS.get(cx))
                        .accessibility_label(copy::set_parameters_for(locale, label))
                        .disabled(busy)
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.open_parameters(Some(parameters_id.clone()), window, cx)
                        })),
                )
                .end(FadedSwitch::new(
                    Switch::new(domain_element_id("model-enabled", id))
                        .checked(on)
                        .disabled(busy)
                        .accessibility_label(copy::enable_model(locale, label))
                        .on_change(cx.listener(move |this, on: &bool, window, cx| {
                            this.set_model_enabled(&switch_id, *on, window, cx)
                        })),
                    on,
                    busy,
                ));
            children.push(row.into_any_element());
        }
        let note = self.note_for("models");
        SettingsGroup::new("detail-models")
            .title(settings_copy::MODELS.get(cx))
            .description(description)
            .action(actions)
            .children(note.map(|note| div().py_1().child(note).into_any_element()))
            .children(children)
            .into_any_element()
    }

    fn render_advanced(&self, connection: &ConnectionEntry, cx: &mut Context<Self>) -> AnyElement {
        let locale = Locale::current(cx);
        let headers_value: SharedString = match &self.header_names {
            Some(names) if !names.is_empty() => copy::headers_count(locale, names.len()).into(),
            Some(_) => copy::NOT_CONFIGURED.get(cx).into(),
            None => copy::KEY_READING.get(cx).into(),
        };
        let headers = self.expandable_row(
            EditingRow::Headers,
            copy::REQUEST_HEADERS.get(cx),
            headers_value,
            copy::EDIT,
            |this, _| this.headers.clone().into_any_element(),
            cx,
        );
        let body_value = if connection.request_body_overlay.is_some() {
            copy::CONFIGURED
        } else {
            copy::NOT_CONFIGURED
        };
        let body = self.expandable_row(
            EditingRow::Body,
            copy::EXTRA_REQUEST_BODY.get(cx),
            body_value.get(cx),
            copy::EDIT,
            |this, cx| {
                v_flex()
                    .w_full()
                    .gap_1()
                    .child(
                        Textarea::new(&this.body)
                            .field_fill(cx)
                            .aria_label(copy::EXTRA_REQUEST_BODY.get(cx))
                            .disabled(this.busy.is_some()),
                    )
                    .child(
                        div()
                            .text_xs()
                            .text_color(cx.maka().ink_muted)
                            .child(copy::EXTRA_REQUEST_BODY_HELP.get(cx)),
                    )
                    .into_any_element()
            },
            cx,
        );
        SettingsGroup::new("detail-advanced")
            .title(copy::ADVANCED_REQUEST.get(cx))
            .description(copy::ADVANCED_REQUEST_HELP.get(cx))
            .child(headers)
            .child(body)
            .into_any_element()
    }

    fn render_delete(&self, cx: &mut Context<Self>) -> AnyElement {
        let deleting = self.busy == Some(Busy::Delete);
        SettingsGroup::new("detail-delete")
            .title(copy::DANGER_ZONE.get(cx))
            .description(copy::DELETE_ROW_HELP.get(cx))
            .child(
                ActionRow::new("detail-delete").child(
                    destructive_button("connection-delete", shared::copy::DELETE.get(cx), cx)
                        .loading(deleting)
                        .disabled(self.busy.is_some())
                        .on_click(
                            cx.listener(|this, _, window, cx| this.confirm_delete(window, cx)),
                        ),
                ),
            )
            .children(self.note_for("delete"))
            .into_any_element()
    }
}

impl Render for ConnectionDetail {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let Some(connection) = self.connection(cx) else {
            return div().id("connection-detail").test_support().into_any_element();
        };
        let provider = ProviderDefinition::find(&connection.provider_type);
        let retired = provider.is_some_and(ProviderDefinition::is_retired);
        let account = provider.is_some_and(ProviderDefinition::is_account);
        let maka = cx.maka();
        let banner = |key: &str, title: Text, detail: Option<Text>, ink: Hsla, cx: &App| {
            v_flex()
                .id(domain_element_id("connection-banner", key))
                .test_support()
                .aria_label(title.get(cx))
                .w_full()
                .gap_1()
                .p_3()
                .rounded(gpui_kit::component::ActiveTheme::theme(cx).radius_lg)
                .border_1()
                .border_color(cx.maka().border)
                .child(
                    div()
                        .text_sm()
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(ink)
                        .child(title.get(cx)),
                )
                .children(detail.map(|detail| {
                    div().text_xs().text_color(cx.maka().ink_muted).child(detail.get(cx))
                }))
        };
        v_flex()
            .id("connection-detail")
            .test_support()
            .w_full()
            .gap_8()
            .child(self.render_header(&connection, cx))
            .when(retired, |this| {
                this.child(banner(
                    "retired",
                    copy::PROVIDER_RETIRED,
                    Some(copy::PROVIDER_RETIRED_DETAIL),
                    maka.destructive,
                    cx,
                ))
            })
            .when(account && !retired, |this| {
                this.child(banner("account", copy::ACCOUNT_IN_DESKTOP, None, maka.ink, cx))
            })
            .when(self.key_state == KeyState::Unknown, |this| {
                this.child(banner(
                    "credential",
                    copy::CREDENTIAL_UNKNOWN_DETAIL,
                    None,
                    maka.warning,
                    cx,
                ))
            })
            .when(!retired, |this| {
                this.child(self.render_credentials(&connection, cx))
                    .child(self.render_models(&connection, cx))
                    .child(self.render_advanced(&connection, cx))
            })
            .child(self.render_delete(cx))
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_saved_endpoints_credentials_stay_masked() {
        assert!(!endpoint_carries_credentials("https://api.example.com/v1"));
        assert!(endpoint_carries_credentials("https://user:pw@relay.example/v1"));
        assert!(endpoint_carries_credentials("https://relay.example/v1?key=secret"));
        assert_eq!(
            endpoint_for_display("https://user:pw@relay.example/v1?key=secret&x=1"),
            "https://<redacted>@relay.example/v1?key=<redacted>&x=<redacted>"
        );
        assert_eq!(endpoint_for_display("http://127.0.0.1:11434/v1"), "http://127.0.0.1:11434/v1");
    }
}
