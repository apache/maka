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

//! The form that connects one provider, which the Models page shows once a
//! provider is picked from the catalog (Maka Desktop's `AddProviderForm`,
//! apps/desktop/src/renderer/settings/provider-add-form.tsx, with
//! provider-add-submission.ts).
//!
//! A provider that takes a key and has a fixed endpoint asks for the key
//! alone (Desktop's quick form); any other provider asks, as Desktop does,
//! for its key (when it keeps one), the connection identifier, a display
//! name, the Cloudflare account id or the service URL, the default request
//! protocol of a custom connection, and, when it will be saved without
//! verification, a default model. Both keep advanced request settings
//! behind a toggle.
//!
//! A provider that keeps a key, with no advanced request settings, is
//! added the way this client added connections before: the Host verifies
//! the key by listing the provider's models (`connection.onboarding.verify`),
//! the person picks the models, and the Host saves the connection
//! (`connection.onboarding.save`). Desktop does this for the quick form
//! only and saves the full form first; here the full form verifies too,
//! so nothing is saved that cannot list a model. A provider without a key
//! slot (Ollama, LM Studio), or a connection with custom headers or body,
//! takes Desktop's create path instead ([`crate::connection_ops::create_connection`]).

use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::checkbox::Checkbox;
use gpui_kit::component::input::{Input, InputEvent, InputState, Textarea, TextareaState};
use gpui_kit::component::select::{Select, SelectEvent};
use gpui_kit::component::{ActiveTheme as _, Disableable as _, Icon, Sizable as _, h_flex, v_flex};
use gpui_kit::{
    App, AppContext as _, Context, Entity, EventEmitter, FontWeight, InteractiveElement as _,
    IntoElement, ParentElement as _, Render, SharedString, StatefulInteractiveElement as _,
    Styled as _, Subscription, Task, TestSupportExt as _, Window, div, prelude::FluentBuilder as _,
};
use host_protocol::{
    ConnectionCatalogEntryDraft, ConnectionCatalogSetDefaultTarget,
    ConnectionCatalogSetDefaultTargetInput, ConnectionEffectFailureClass,
    ConnectionOnboardingRejection, ConnectionOnboardingSave, ConnectionOnboardingSaveResult,
    ConnectionOnboardingTarget, ConnectionOnboardingVerify, ConnectionOnboardingVerifyInput,
    ConnectionOnboardingVerifyResult, ConnectionTarget, DiscoveredModel, HostOperationErrorCode,
    ModelApiProtocol, ProviderDefinition, RequestHeaderUpdate, SetDefaultConnectionTargetResult,
};
use serde_json::{Map, Value};
use shared::copy::models as copy;
use shared::copy::providers::provider_name;
use shared::copy::settings as settings_copy;
use shared::copy::{Locale, Text, failure, sentences};
use shared::domain_element_id;
use shared::icons::MakaIcon;
use shared::theme::FieldFill as _;
use shared::theme::{ActiveMakaPalette as _, control_button, disclosure, quiet_button};
use workspace::{
    ConnectionCatalog, HostRequestError, HostRequester, HostSession, read_connections,
};

use crate::connection_ops::{self, CreateFailure, ModelsFetchFailure};
use crate::policy::host_error_reason;
use crate::request_customization::{HeadersEditor, parse_body_overlay};
use crate::rows::{Choice, ChoiceSelect, FieldBlock, sync_choices};

/// Past this many verified models the list needs a filter to be usable.
pub(crate) const MODEL_FILTER_THRESHOLD: usize = 8;

/// What the form reports to the pane that shows it.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum AddConnectionEvent {
    /// A connection was added: the pane opens its detail. `models_error`
    /// says why its models could not be listed afterwards.
    Added { connection_id: SharedString, models_error: Option<SharedString> },
    /// Cancel: nothing was saved.
    Cancelled,
    /// A save's outcome is unknown: the pane shows the list, read again.
    ShowList,
}

/// Where adding the connection stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum AddConnectionPhase {
    /// The fields.
    Input,
    /// `connection.onboarding.verify` is in flight.
    Verifying,
    /// The models the key unlocked, to choose from.
    Models,
    /// `connection.onboarding.save` is in flight.
    Saving,
    /// The create path is in flight.
    Creating,
    /// The Host could not confirm whether the save committed.
    OutcomeUnknown,
}

impl AddConnectionPhase {
    fn is_busy(self) -> bool {
        matches!(self, Self::Verifying | Self::Saving | Self::Creating)
    }
}

/// The field an error is about.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FormField {
    ApiKey,
    Slug,
    AccountId,
    BaseUrl,
    Advanced,
    Form,
}

/// A model verification found.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ModelChoice {
    id: SharedString,
    label: SharedString,
}

/// How the form will write the connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Route {
    /// Verify, choose models, save (`connection.onboarding.*`).
    Onboarding,
    /// Desktop's create path.
    Create,
}

/// Adds a connection for one provider.
///
/// Behavior and presentation owner of the form. One step runs at a time;
/// a second click while it runs sends nothing. Editing a field drops what
/// was verified for the old one. Every refusal shows as a sentence under
/// the field it is about, or above the buttons, and the inputs stay as
/// typed; the key is cleared once the Host has it and is never logged.
///
/// Keyboard: Tab walks the fields, the advanced toggle, and the buttons;
/// Enter in a text field takes the primary step. In the models step Tab
/// walks the search, the checkboxes (Space toggles), the default model, and
/// the buttons.
pub struct AddConnectionForm {
    host: Entity<HostSession>,
    connections: Entity<ConnectionCatalog>,
    provider: &'static ProviderDefinition,
    existing_slugs: Vec<SharedString>,
    api_key: Entity<InputState>,
    slug: Entity<InputState>,
    name: Entity<InputState>,
    account_id: Entity<InputState>,
    base_url: Entity<InputState>,
    protocol: Entity<ChoiceSelect<ModelApiProtocol>>,
    default_model: Entity<InputState>,
    advanced_open: bool,
    headers: Entity<HeadersEditor>,
    body: Entity<TextareaState>,
    phase: AddConnectionPhase,
    models: Vec<ModelChoice>,
    selected: Vec<SharedString>,
    /// The model new chats start on: always a selected one.
    default_id: Option<SharedString>,
    default_choice: Entity<ChoiceSelect<SharedString>>,
    model_filter: Entity<InputState>,
    error: Option<(FormField, SharedString)>,
    /// Incremented by every edit; a verification of an older one is dropped.
    generation: u64,
    _request: Option<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl std::fmt::Debug for AddConnectionForm {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AddConnectionForm")
            .field("provider", &self.provider.provider_type)
            .field("phase", &self.phase)
            .field("models", &self.models)
            .field("error", &self.error)
            .finish_non_exhaustive()
    }
}

/// `deriveConnectionSlug`: the provider type in lowercase with other
/// characters as hyphens, numbered from 2 while taken.
pub(crate) fn derive_slug(provider_type: &str, existing: &[SharedString]) -> String {
    let base: String = provider_type
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' { c } else { '-' })
        .collect();
    let taken = |slug: &str| existing.iter().any(|existing| existing == slug);
    if !taken(&base) {
        return base;
    }
    (2..).map(|n| format!("{base}-{n}")).find(|slug| !taken(slug)).unwrap_or(base)
}

/// Why an identifier is refused (`validateSlug`), as the sentence.
fn slug_issue(slug: &str) -> Option<Text> {
    if slug.trim().is_empty() {
        return Some(copy::SLUG_REQUIRED);
    }
    let bytes = slug.as_bytes();
    let edge = |byte: &u8| byte.is_ascii_lowercase() || byte.is_ascii_digit();
    let shaped = bytes.len() >= 2
        && bytes.first().is_some_and(edge)
        && bytes.last().is_some_and(edge)
        && bytes.iter().all(|byte| edge(byte) || *byte == b'-');
    if !shaped {
        return Some(copy::SLUG_FORMAT);
    }
    (slug.len() > 64).then_some(copy::SLUG_TOO_LONG)
}

fn protocol_choices() -> Vec<Choice<ModelApiProtocol>> {
    ModelApiProtocol::ALL
        .into_iter()
        .map(|protocol| {
            let label = protocol.label().to_owned();
            Choice::new(protocol, label)
        })
        .collect()
}

impl AddConnectionForm {
    pub fn new(
        host: Entity<HostSession>,
        connections: Entity<ConnectionCatalog>,
        provider: &'static ProviderDefinition,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let locale = Locale::current(cx);
        let existing_slugs: Vec<SharedString> = connections
            .read(cx)
            .list()
            .map(|list| list.connections.iter().map(|c| c.slug.clone()).collect())
            .unwrap_or_default();
        let display = provider_name(locale, provider.provider_type).to_owned();
        let api_key = cx.new(|cx| {
            InputState::new(window, cx)
                .masked(true)
                .placeholder(settings_copy::API_KEY_PLACEHOLDER.get(cx))
        });
        let slug = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("my-provider")
                .default_value(derive_slug(provider.provider_type, &existing_slugs))
        });
        let name = cx.new(|cx| {
            InputState::new(window, cx).placeholder(display.clone()).default_value(display.clone())
        });
        let account_id = cx.new(|cx| {
            InputState::new(window, cx).placeholder(copy::ACCOUNT_ID_PLACEHOLDER.get(cx))
        });
        let base_url = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder(provider.base_url.unwrap_or("https://…"))
                .default_value(provider.base_url.unwrap_or_default())
        });
        let protocol = cx.new(|cx| ChoiceSelect::new(protocol_choices(), None, window, cx));
        let default_model = cx.new(|cx| {
            InputState::new(window, cx).placeholder(copy::DEFAULT_MODEL_PLACEHOLDER.get(cx))
        });
        let headers = cx.new(|_| HeadersEditor::new("add-connection-headers"));
        let body = cx.new(|cx| {
            TextareaState::new(window, cx)
                .auto_grow(6, 12)
                .placeholder("{\n  \"provider\": {\n    \"order\": [\"Anthropic\"]\n  }\n}")
        });
        let default_choice = cx.new(|cx| ChoiceSelect::new(Vec::new(), None, window, cx));
        let model_filter =
            cx.new(|cx| InputState::new(window, cx).placeholder(copy::SEARCH_MODELS.get(cx)));
        let mut subscriptions = vec![
            cx.observe_global_in::<Locale>(window, |this, window, cx| this.relocalize(window, cx)),
            cx.subscribe(&model_filter, |_, _, event: &InputEvent, cx| {
                if matches!(event, InputEvent::Change) {
                    cx.notify();
                }
            }),
            cx.subscribe_in(
                &default_choice,
                window,
                |this, _, event: &SelectEvent<Vec<Choice<SharedString>>>, _, cx| {
                    if let SelectEvent::Confirm(Some(id)) = event {
                        this.set_default_model(id, cx);
                    }
                },
            ),
        ];
        for (input, field) in [
            (&api_key, FormField::ApiKey),
            (&slug, FormField::Slug),
            (&name, FormField::Form),
            (&account_id, FormField::AccountId),
            (&base_url, FormField::BaseUrl),
            (&default_model, FormField::Form),
        ] {
            subscriptions.push(cx.subscribe_in(
                input,
                window,
                move |this, _, event: &InputEvent, window, cx| match event {
                    InputEvent::Change => this.edited(field, cx),
                    InputEvent::PressEnter { .. } => this.submit(window, cx),
                    _ => {}
                },
            ));
        }
        subscriptions.push(cx.subscribe(&body, |this, _, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change) {
                this.edited(FormField::Advanced, cx);
            }
        }));
        let openai_chat = ModelApiProtocol::OpenaiChat;
        protocol.update(cx, |select, cx| select.set_selected_value(&openai_chat, window, cx));
        Self {
            host,
            connections,
            provider,
            existing_slugs,
            api_key,
            slug,
            name,
            account_id,
            base_url,
            protocol,
            default_model,
            advanced_open: false,
            headers,
            body,
            phase: AddConnectionPhase::Input,
            models: Vec::new(),
            selected: Vec::new(),
            default_id: None,
            default_choice,
            model_filter,
            error: None,
            generation: 0,
            _request: None,
            _subscriptions: subscriptions,
        }
    }

    /// The provider being connected.
    pub fn provider(&self) -> &'static ProviderDefinition {
        self.provider
    }

    /// Where adding the connection stands.
    pub fn phase(&self) -> AddConnectionPhase {
        self.phase
    }

    /// Whether a step is in flight: leaving now would hide its outcome.
    pub fn is_busy(&self) -> bool {
        self.phase.is_busy()
    }

    /// The models' filter, while it can be typed in: choosing from more
    /// models than fit unfiltered, not while they are saved.
    pub fn search_field(&self) -> Option<Entity<InputState>> {
        let filtered = self.models.len() > MODEL_FILTER_THRESHOLD;
        (self.phase == AddConnectionPhase::Models && filtered).then(|| self.model_filter.clone())
    }

    /// Why the last step failed, if it did.
    pub fn error(&self) -> Option<&SharedString> {
        self.error.as_ref().map(|(_, message)| message)
    }

    /// The verified models in the list's order, each with whether it is
    /// selected.
    pub fn models(&self) -> Vec<(SharedString, bool)> {
        let selected = |id: &SharedString| self.selected.contains(id);
        self.models.iter().map(|model| (model.id.clone(), selected(&model.id))).collect()
    }

    /// The model new chats start on.
    pub fn default_model(&self) -> Option<&SharedString> {
        self.default_id.as_ref()
    }

    fn relocalize(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let key = settings_copy::API_KEY_PLACEHOLDER.get(cx);
        self.api_key.update(cx, |input, cx| input.set_placeholder(key, window, cx));
        let account = copy::ACCOUNT_ID_PLACEHOLDER.get(cx);
        self.account_id.update(cx, |input, cx| input.set_placeholder(account, window, cx));
        let model = copy::DEFAULT_MODEL_PLACEHOLDER.get(cx);
        self.default_model.update(cx, |input, cx| input.set_placeholder(model, window, cx));
        let search = copy::SEARCH_MODELS.get(cx);
        self.model_filter.update(cx, |input, cx| input.set_placeholder(search, window, cx));
    }

    /// Moves focus to the first field.
    pub fn focus_first_field(&self, window: &mut Window, cx: &mut Context<Self>) {
        let first = if self.provider.supports_api_key() { &self.api_key } else { &self.slug };
        first.update(cx, |input, cx| input.focus(window, cx));
    }

    /// Fills the text fields, as typing does: `None` leaves a field as it is.
    pub fn fill(&mut self, fields: FormFields<'_>, window: &mut Window, cx: &mut Context<Self>) {
        for (input, value) in [
            (&self.api_key, fields.api_key),
            (&self.slug, fields.slug),
            (&self.name, fields.name),
            (&self.base_url, fields.base_url),
            (&self.account_id, fields.account_id),
            (&self.default_model, fields.default_model),
        ] {
            if let Some(value) = value {
                input.update(cx, |input, cx| input.set_value(value.to_owned(), window, cx));
            }
        }
        // `set_value` emits no change event.
        self.edited(FormField::Form, cx);
    }

    /// Types `text` into the extra request body, as typing does.
    pub fn fill_body(&mut self, text: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.body.update(cx, |input, cx| input.set_value(text.to_owned(), window, cx));
        self.edited(FormField::Advanced, cx);
    }

    /// Types a header into the advanced request settings' row `index`.
    pub fn fill_header(
        &mut self,
        index: usize,
        name: &str,
        value: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.advanced_open = true;
        self.headers.update(cx, |headers, cx| headers.fill(index, name, value, window, cx));
        self.edited(FormField::Advanced, cx);
    }

    /// Chooses the default request protocol of a custom connection.
    pub fn set_protocol(
        &mut self,
        protocol: ModelApiProtocol,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.protocol.update(cx, |select, cx| select.set_selected_value(&protocol, window, cx));
        self.edited(FormField::Form, cx);
    }

    /// The default request protocol chosen.
    pub fn protocol(&self, cx: &App) -> ModelApiProtocol {
        self.protocol.read(cx).selected_value().cloned().unwrap_or(ModelApiProtocol::OpenaiChat)
    }

    /// Shows or hides the advanced request settings.
    pub fn toggle_advanced(&mut self, cx: &mut Context<Self>) {
        self.advanced_open = !self.advanced_open;
        cx.notify();
    }

    /// A field changed: what was verified no longer holds, and the field's
    /// error is answered.
    fn edited(&mut self, field: FormField, cx: &mut Context<Self>) {
        if matches!(self.phase, AddConnectionPhase::Saving | AddConnectionPhase::Creating) {
            return;
        }
        self.generation += 1;
        if matches!(self.phase, AddConnectionPhase::Verifying | AddConnectionPhase::Models) {
            self.phase = AddConnectionPhase::Input;
            self._request = None;
        }
        if self.error.as_ref().is_some_and(|(errored, _)| {
            *errored == field || *errored == FormField::Form || field == FormField::Form
        }) {
            self.error = None;
        }
        cx.notify();
    }

    fn text(&self, input: &Entity<InputState>, cx: &App) -> String {
        input.read(cx).value().trim().to_owned()
    }

    /// The name a person reads the provider by.
    fn display_name(&self, cx: &App) -> String {
        provider_name(Locale::current(cx), self.provider.provider_type).to_owned()
    }

    /// How the form will write the connection, as the fields now stand.
    fn route(&self, cx: &App) -> Route {
        let customized =
            !self.headers.read(cx).is_empty() || !self.body.read(cx).value().trim().is_empty();
        if self.provider.supports_api_key() && !customized {
            Route::Onboarding
        } else {
            Route::Create
        }
    }

    /// Whether the form asks for more than the key.
    fn full(&self) -> bool {
        !self.provider.takes_only_a_key()
    }

    fn fail(&mut self, field: FormField, message: impl Into<SharedString>, cx: &mut Context<Self>) {
        self.error = Some((field, message.into()));
        cx.notify();
    }

    /// The service URL the connection is added with: the Cloudflare URL
    /// built from the account id, the typed one, or `None` for the
    /// registry's.
    fn resolved_base_url(&self, cx: &App) -> Option<String> {
        if self.provider.builds_endpoint_from_account() {
            return self.provider.endpoint_for_account(&self.text(&self.account_id, cx));
        }
        if !self.full() {
            return None;
        }
        let typed = self.text(&self.base_url, cx);
        (!typed.is_empty() && Some(typed.as_str()) != self.provider.base_url).then_some(typed)
    }

    /// The field checks, first issue first (`validateAddProviderDraft`),
    /// for the full form; the key alone for the quick form.
    fn check_fields(&mut self, cx: &mut Context<Self>) -> bool {
        let locale = Locale::current(cx);
        let key_missing = self.provider.requires_secret()
            && self.provider.supports_api_key()
            && self.text(&self.api_key, cx).is_empty();
        let key_message = settings_copy::api_key_missing(locale, &self.display_name(cx));
        if !self.full() {
            if key_missing {
                self.fail(FormField::ApiKey, key_message, cx);
                return false;
            }
            return true;
        }
        let slug = self.text(&self.slug, cx);
        if let Some(issue) = slug_issue(&slug) {
            self.fail(FormField::Slug, issue.get(cx), cx);
            return false;
        }
        if self.existing_slugs.iter().any(|existing| *existing == slug) {
            self.fail(FormField::Slug, copy::SLUG_DUPLICATE.get(cx), cx);
            return false;
        }
        if key_missing {
            self.fail(FormField::ApiKey, key_message, cx);
            return false;
        }
        if self.provider.builds_endpoint_from_account()
            && self.text(&self.account_id, cx).is_empty()
        {
            self.fail(FormField::AccountId, copy::ACCOUNT_ID_REQUIRED.get(cx), cx);
            return false;
        }
        if self.provider.requires_base_url() && self.text(&self.base_url, cx).is_empty() {
            self.fail(FormField::BaseUrl, settings_copy::SERVICE_URL_MISSING.get(cx), cx);
            return false;
        }
        true
    }

    /// Enter in a field, or the primary button: verify, save the chosen
    /// models, or run the create path.
    pub fn submit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.phase.is_busy() || self.phase == AddConnectionPhase::OutcomeUnknown {
            return;
        }
        if self.phase == AddConnectionPhase::Models {
            self.save(window, cx);
            return;
        }
        self.error = None;
        let headers = self.headers.read(cx).new_headers(cx);
        let body = parse_body_overlay(&self.body.read(cx).value());
        let (Ok(headers), Ok(body)) = (headers, body) else {
            self.advanced_open = true;
            self.fail(FormField::Advanced, copy::REQUEST_CUSTOMIZATION_INVALID.get(cx), cx);
            return;
        };
        if !self.check_fields(cx) {
            return;
        }
        match self.route(cx) {
            Route::Onboarding => self.verify(window, cx),
            Route::Create => self.create(headers, body, window, cx),
        }
    }

    fn requester(&self, cx: &App) -> HostRequester {
        self.host.read(cx).requester()
    }

    /// What the Host is asked to verify: the provider alone for the quick
    /// form (the Host derives the identity), the identity, the protocol,
    /// and the endpoint for the full one.
    fn onboarding_input(&self, cx: &App) -> ConnectionOnboardingVerifyInput {
        let key = self.text(&self.api_key, cx);
        let api_key = (!key.is_empty()).then_some(key);
        if !self.full() {
            let target = ConnectionOnboardingTarget::Create {
                provider_type: self.provider.provider_type.to_owned(),
                slug: None,
                name: None,
                default_api_protocol: None,
            };
            return ConnectionOnboardingVerifyInput::new(target, api_key, None);
        }
        let name = self.text(&self.name, cx);
        let target = ConnectionOnboardingTarget::Create {
            provider_type: self.provider.provider_type.to_owned(),
            slug: Some(self.text(&self.slug, cx)),
            name: Some(if name.is_empty() { self.display_name(cx) } else { name }),
            default_api_protocol: self.provider.is_custom().then(|| self.protocol(cx)),
        };
        ConnectionOnboardingVerifyInput::new(target, api_key, self.resolved_base_url(cx))
    }

    /// Asks the Host to verify the key and list the provider's models.
    fn verify(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let input = self.onboarding_input(cx);
        log::info!("connection.onboarding.verify for {}", describe(&input));
        let request = self.requester(cx).request::<ConnectionOnboardingVerify>(&input);
        let generation = self.generation;
        self.phase = AddConnectionPhase::Verifying;
        self._request = Some(cx.spawn_in(window, async move |this, cx| {
            let result = request.await;
            this.update_in(cx, |this, window, cx| {
                if this.generation != generation || this.phase != AddConnectionPhase::Verifying {
                    return;
                }
                this._request = None;
                this.finish_verify(result, window, cx);
            })
            .ok();
        }));
        cx.notify();
    }

    fn finish_verify(
        &mut self,
        result: Result<ConnectionOnboardingVerifyResult, HostRequestError>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.phase = AddConnectionPhase::Input;
        let locale = Locale::current(cx);
        let provider = self.display_name(cx);
        match result {
            Ok(ConnectionOnboardingVerifyResult::Verified { models }) => {
                log::info!("connection.onboarding.verify found {} models", models.len());
                self.show_models(&models, window, cx);
            }
            Ok(ConnectionOnboardingVerifyResult::Rejected { reason }) => {
                log::info!("connection.onboarding.verify rejected: {reason}");
                let field = match reason {
                    ConnectionOnboardingRejection::CredentialNotConfigured => FormField::ApiKey,
                    ConnectionOnboardingRejection::SlugTaken => FormField::Slug,
                    ConnectionOnboardingRejection::BaseUrlNotConfigured => FormField::BaseUrl,
                    _ => FormField::Form,
                };
                self.fail(field, rejection_message(&reason, &provider, locale), cx);
            }
            Ok(ConnectionOnboardingVerifyResult::Failed { error_class }) => {
                log::info!("connection.onboarding.verify failed: {error_class}");
                let field = if error_class == ConnectionEffectFailureClass::Auth {
                    FormField::ApiKey
                } else {
                    FormField::Form
                };
                self.fail(field, failure_message(&error_class, locale), cx);
            }
            Ok(_) => self.fail(FormField::Form, settings_copy::UNEXPECTED.get(cx), cx),
            Err(error) => {
                log::warn!("connection.onboarding.verify failed: {error}");
                let what = settings_copy::VERIFY_FAILED.in_locale(locale);
                let reason = host_error_reason(&error, locale);
                self.fail(FormField::Form, failure(locale, what, &reason), cx);
            }
        }
    }

    /// The models step: the models by name (`stableOnboardingModels`), the
    /// recommended one selected, else the first (`initialOnboardingModelIds`).
    fn show_models(
        &mut self,
        models: &[DiscoveredModel],
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let mut models: Vec<ModelChoice> = models
            .iter()
            .map(|model| {
                let name = model.display_name.as_deref().map(str::trim);
                let label = name.filter(|name| !name.is_empty()).unwrap_or(&model.id);
                ModelChoice { id: model.id.clone().into(), label: label.to_owned().into() }
            })
            .collect();
        // By name without regard to case, as `localeCompare` orders them.
        models.sort_by(|left, right| {
            let (a, b) = (left.label.to_lowercase(), right.label.to_lowercase());
            a.cmp(&b).then(left.label.cmp(&right.label)).then(left.id.cmp(&right.id))
        });
        let recommended = self.provider.recommended_model;
        let first = models
            .iter()
            .find(|model| Some(model.id.as_ref()) == recommended)
            .or_else(|| models.first())
            .map(|model| model.id.clone());
        let Some(first) = first else {
            self.fail(FormField::Form, copy::NO_MODELS_FOUND.get(cx), cx);
            return;
        };
        self.models = models;
        self.selected = vec![first.clone()];
        self.default_id = Some(first);
        self.phase = AddConnectionPhase::Models;
        self.model_filter.update(cx, |input, cx| input.set_value("", window, cx));
        self.sync_default_choice(window, cx);
        cx.notify();
    }

    /// Selects or deselects the verified model `id`; the default follows
    /// the selection (unticking it hands the role to the first model still
    /// ticked).
    pub fn set_model_selected(
        &mut self,
        id: &str,
        selected: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.phase != AddConnectionPhase::Models {
            return;
        }
        let Some(model) = self.models.iter().find(|model| model.id == id) else {
            return;
        };
        let id = model.id.clone();
        match (selected, self.selected.contains(&id)) {
            (true, false) => self.selected.push(id),
            (false, true) => self.selected.retain(|selected| *selected != id),
            _ => return,
        }
        self.after_selection(window, cx);
    }

    /// Selects every verified model, or none.
    pub fn select_all(&mut self, all: bool, window: &mut Window, cx: &mut Context<Self>) {
        if self.phase != AddConnectionPhase::Models {
            return;
        }
        self.selected =
            if all { self.models.iter().map(|model| model.id.clone()).collect() } else { vec![] };
        self.after_selection(window, cx);
    }

    fn after_selection(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.default_id.as_ref().is_some_and(|id| self.selected.contains(id)) {
            // The first ticked, in the list's order.
            self.default_id = self
                .models
                .iter()
                .find(|model| self.selected.contains(&model.id))
                .map(|model| model.id.clone());
        }
        if self.error.as_ref().is_some_and(|(field, _)| *field == FormField::Form) {
            self.error = None;
        }
        self.sync_default_choice(window, cx);
        cx.notify();
    }

    /// The default model's choices are the selected models, in order.
    fn sync_default_choice(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let choices = self
            .models
            .iter()
            .filter(|model| self.selected.contains(&model.id))
            .map(|model| Choice::new(model.id.clone(), model.label.clone()))
            .collect();
        sync_choices(&self.default_choice, choices, self.default_id.as_ref(), window, cx);
    }

    /// Makes the selected model `id` the one new chats start on.
    pub fn set_default_model(&mut self, id: &SharedString, cx: &mut Context<Self>) {
        if self.phase == AddConnectionPhase::Models && self.selected.contains(id) {
            self.default_id = Some(id.clone());
            cx.notify();
        }
    }

    /// Back to the fields, keeping them.
    pub fn back_to_edit(&mut self, cx: &mut Context<Self>) {
        if self.phase == AddConnectionPhase::Models {
            self.phase = AddConnectionPhase::Input;
            self.error = None;
            cx.notify();
        }
    }

    /// The selected ids in the list's order, the default first: the Host
    /// reads the first as the connection's default model.
    fn enabled_ids(&self) -> Vec<String> {
        let default = self.default_id.as_ref();
        let mut ids: Vec<String> = default.iter().map(ToString::to_string).collect();
        ids.extend(
            self.models
                .iter()
                .filter(|model| self.selected.contains(&model.id) && Some(&model.id) != default)
                .map(|model| model.id.to_string()),
        );
        ids
    }

    /// Saves the connection with the selected models.
    fn save(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.selected.is_empty() {
            self.fail(FormField::Form, settings_copy::NO_MODEL_SELECTED.get(cx), cx);
            return;
        }
        let enabled = self.enabled_ids();
        let verify = self.onboarding_input(cx);
        log::info!(
            "connection.onboarding.save for {} with {}",
            describe(&verify),
            enabled.join(", ")
        );
        let request = self.requester(cx).request::<ConnectionOnboardingSave>(&verify.save(enabled));
        self.phase = AddConnectionPhase::Saving;
        self.error = None;
        self._request = Some(cx.spawn_in(window, async move |this, cx| {
            let result = request.await;
            this.update_in(cx, |this, window, cx| this.finish_save(result, window, cx)).ok();
        }));
        cx.notify();
    }

    fn finish_save(
        &mut self,
        result: Result<ConnectionOnboardingSaveResult, HostRequestError>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self._request = None;
        self.phase = AddConnectionPhase::Models;
        let locale = Locale::current(cx);
        let provider = self.display_name(cx);
        match result {
            Ok(ConnectionOnboardingSaveResult::Saved { connection }) => {
                log::info!(
                    "connection.onboarding.save saved {} ({}, revision {})",
                    connection.slug,
                    connection.connection_id,
                    connection.revision
                );
                self.clear_key(window, cx);
                self.connections.update(cx, |catalog, cx| catalog.reload(cx));
                cx.emit(AddConnectionEvent::Added {
                    connection_id: connection.connection_id.into(),
                    models_error: None,
                });
            }
            Ok(ConnectionOnboardingSaveResult::Rejected { reason }) => {
                log::info!("connection.onboarding.save rejected: {reason}");
                if matches!(
                    reason,
                    ConnectionOnboardingRejection::ModelUnavailable
                        | ConnectionOnboardingRejection::Superseded
                        | ConnectionOnboardingRejection::SlugTaken
                ) {
                    self.phase = AddConnectionPhase::Input;
                }
                let field = if reason == ConnectionOnboardingRejection::SlugTaken {
                    FormField::Slug
                } else {
                    FormField::Form
                };
                self.fail(field, rejection_message(&reason, &provider, locale), cx);
            }
            Ok(ConnectionOnboardingSaveResult::Failed { error_class }) => {
                log::info!("connection.onboarding.save failed: {error_class}");
                let field = if error_class == ConnectionEffectFailureClass::Auth {
                    self.phase = AddConnectionPhase::Input;
                    FormField::ApiKey
                } else {
                    FormField::Form
                };
                self.fail(field, failure_message(&error_class, locale), cx);
            }
            Ok(_) => self.fail(FormField::Form, settings_copy::UNEXPECTED.get(cx), cx),
            Err(HostRequestError::Operation {
                code: HostOperationErrorCode::CommitOutcomeUnknown,
                ..
            }) => {
                // It may exist now: never offer to add it again blindly.
                log::warn!("connection.onboarding.save: the outcome is unknown");
                self.clear_key(window, cx);
                self.phase = AddConnectionPhase::OutcomeUnknown;
                self.connections.update(cx, |catalog, cx| catalog.reload(cx));
                cx.notify();
            }
            Err(error) => {
                log::warn!("connection.onboarding.save failed: {error}");
                let what = settings_copy::SAVE_FAILED.in_locale(locale);
                let reason = host_error_reason(&error, locale);
                self.fail(FormField::Form, failure(locale, what, &reason), cx);
            }
        }
    }

    /// Desktop's create path: add the connection, save its key and
    /// headers, list its models.
    fn create(
        &mut self,
        headers: Vec<RequestHeaderUpdate>,
        body: Option<Map<String, Value>>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let locale = Locale::current(cx);
        let name = self.text(&self.name, cx);
        let typed_model = self.text(&self.default_model, cx);
        let model = if typed_model.is_empty() {
            self.provider.recommended_model.unwrap_or_default().to_owned()
        } else {
            typed_model
        };
        let slug = if self.full() {
            self.text(&self.slug, cx)
        } else {
            derive_slug(self.provider.provider_type, &self.existing_slugs)
        };
        let name = if name.is_empty() || !self.full() { self.display_name(cx) } else { name };
        let models = (!model.is_empty()).then_some(model).into_iter().collect();
        let draft =
            ConnectionCatalogEntryDraft::new(slug, name, self.provider.provider_type, models)
                .with_base_url(self.resolved_base_url(cx))
                .with_default_api_protocol(self.provider.is_custom().then(|| self.protocol(cx)))
                .with_request_body_overlay(body);
        let key = self.text(&self.api_key, cx);
        let api_key = (!key.is_empty() && self.provider.supports_api_key()).then_some(key);
        let requester = self.requester(cx);
        self.phase = AddConnectionPhase::Creating;
        self._request = Some(cx.spawn_in(window, async move |this, cx| {
            let result =
                connection_ops::create_connection(&requester, draft, api_key, headers, locale)
                    .await;
            this.update_in(cx, |this, window, cx| this.finish_create(result, window, cx)).ok();
        }));
        cx.notify();
    }

    fn finish_create(
        &mut self,
        result: Result<connection_ops::Created, CreateFailure>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self._request = None;
        self.phase = AddConnectionPhase::Input;
        let locale = Locale::current(cx);
        match result {
            Ok(created) => {
                self.clear_key(window, cx);
                self.connections.update(cx, |catalog, cx| catalog.reload(cx));
                let troubleshooting = if self.provider.supports_api_key() {
                    ModelsTroubleshooting::Key
                } else {
                    ModelsTroubleshooting::Endpoint
                };
                let models_error = created
                    .models_error
                    .map(|error| models_fetch_message(&error, troubleshooting, locale));
                cx.emit(AddConnectionEvent::Added {
                    connection_id: created.connection_id,
                    models_error,
                });
            }
            Err(CreateFailure::SlugTaken) => {
                self.fail(FormField::Slug, copy::SLUG_DUPLICATE.get(cx), cx)
            }
            Err(CreateFailure::Refused(reason)) => {
                let what = settings_copy::SAVE_FAILED.in_locale(locale);
                self.fail(FormField::Form, failure(locale, what, &reason), cx);
            }
        }
    }

    /// Empties the key field once the Host has the key.
    fn clear_key(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.api_key.update(cx, |input, cx| input.set_value("", window, cx));
    }

    /// Leaves the form, unless a step is in flight.
    pub fn cancel(&mut self, cx: &mut Context<Self>) {
        match self.phase {
            AddConnectionPhase::Verifying
            | AddConnectionPhase::Saving
            | AddConnectionPhase::Creating => {}
            AddConnectionPhase::OutcomeUnknown => cx.emit(AddConnectionEvent::ShowList),
            _ => cx.emit(AddConnectionEvent::Cancelled),
        }
    }
}

impl EventEmitter<AddConnectionEvent> for AddConnectionForm {}

/// The text fields [`AddConnectionForm::fill`] types: `None` leaves one as
/// it is.
#[derive(Debug, Clone, Copy, Default)]
pub struct FormFields<'a> {
    pub api_key: Option<&'a str>,
    pub slug: Option<&'a str>,
    pub name: Option<&'a str>,
    pub base_url: Option<&'a str>,
    pub account_id: Option<&'a str>,
    pub default_model: Option<&'a str>,
}

/// Which settings a failed refresh asks the person to check.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ModelsTroubleshooting {
    Key,
    Endpoint,
    Account,
}

/// A refresh that listed nothing, as Desktop words it: what failed, why,
/// and what to check.
pub(crate) fn models_fetch_message(
    error: &ModelsFetchFailure,
    troubleshooting: ModelsTroubleshooting,
    locale: Locale,
) -> SharedString {
    let reason = match error {
        ModelsFetchFailure::Refused(reason) => reason.clone(),
        ModelsFetchFailure::Provider(class) => connection_ops::provider_failure(class, locale),
    };
    let what = copy::MODELS_FETCH_FAILED.in_locale(locale);
    let check = match troubleshooting {
        ModelsTroubleshooting::Key => copy::KEY_TROUBLESHOOTING,
        ModelsTroubleshooting::Endpoint => copy::ENDPOINT_TROUBLESHOOTING,
        ModelsTroubleshooting::Account => copy::OAUTH_TROUBLESHOOTING,
    };
    let detail = copy::models_fetch_failed_detail(locale, check.in_locale(locale));
    sentences(locale, &failure(locale, what, &reason), &detail).into()
}

/// Makes `model` of the connection `connection_id` (called `slug` in the
/// log) the catalog default, at the catalog's current revision; a revision
/// conflict reads it again once.
pub(crate) async fn make_default(
    requester: &HostRequester,
    connection_id: &str,
    slug: &str,
    model: &str,
    locale: Locale,
) -> Result<(), String> {
    let target = ConnectionTarget::new(connection_id.to_owned(), model.to_owned());
    set_default_target(requester, Some(target), &format!("{slug} {model}"), locale).await
}

/// Makes `target` the catalog default (`None` clears it; `label` names it in
/// the log), at the catalog's current revision; a revision conflict reads it
/// again once.
pub(crate) async fn set_default_target(
    requester: &HostRequester,
    target: Option<ConnectionTarget>,
    label: &str,
    locale: Locale,
) -> Result<(), String> {
    let model = target.as_ref().map(|target| target.model_id.clone()).unwrap_or_default();
    for attempt in 0..2 {
        let revision = read_connections(requester)
            .await
            .map_err(|error| host_error_reason(&error, locale))?
            .revision;
        let input = ConnectionCatalogSetDefaultTargetInput::new(revision, target.clone());
        log::info!("connection.catalog.set-default-target {label} at catalog revision {revision}");
        match requester.request::<ConnectionCatalogSetDefaultTarget>(&input).await {
            Ok(SetDefaultConnectionTargetResult::Committed { catalog_revision }) => {
                log::info!(
                    "the default model is now {label} (catalog revision {catalog_revision})"
                );
                return Ok(());
            }
            Ok(SetDefaultConnectionTargetResult::RevisionConflict { .. }) if attempt == 0 => {}
            Ok(SetDefaultConnectionTargetResult::RevisionConflict { .. }) => {
                return Err(settings_copy::DEFAULT_KEPT_CHANGING.in_locale(locale).to_owned());
            }
            Ok(SetDefaultConnectionTargetResult::InvalidDefaultTarget { .. }) => {
                return Err(settings_copy::default_refused(locale, &model));
            }
            Ok(_) => return Err(settings_copy::UNEXPECTED.in_locale(locale).to_owned()),
            Err(error) => return Err(host_error_reason(&error, locale)),
        }
    }
    Err(settings_copy::DEFAULT_KEPT_CHANGING.in_locale(locale).to_owned())
}

/// A refusal as a sentence.
fn rejection_message(
    reason: &ConnectionOnboardingRejection,
    provider: &str,
    locale: Locale,
) -> String {
    match reason {
        ConnectionOnboardingRejection::ProviderUnsupported => {
            settings_copy::REJECTED_PROVIDER_UNSUPPORTED.in_locale(locale)
        }
        ConnectionOnboardingRejection::ConnectionNotFound => {
            settings_copy::REJECTED_CONNECTION_NOT_FOUND.in_locale(locale)
        }
        ConnectionOnboardingRejection::CredentialNotConfigured => {
            return settings_copy::api_key_missing(locale, provider);
        }
        ConnectionOnboardingRejection::BaseUrlNotConfigured => {
            settings_copy::SERVICE_URL_MISSING.in_locale(locale)
        }
        ConnectionOnboardingRejection::SlugTaken => {
            settings_copy::REJECTED_SLUG_TAKEN.in_locale(locale)
        }
        ConnectionOnboardingRejection::CatalogFull => {
            settings_copy::REJECTED_CATALOG_FULL.in_locale(locale)
        }
        ConnectionOnboardingRejection::ModelUnavailable
        | ConnectionOnboardingRejection::Superseded => {
            settings_copy::REJECTED_MODELS_CHANGED.in_locale(locale)
        }
        _ => settings_copy::REJECTED_UNKNOWN.in_locale(locale),
    }
    .to_owned()
}

/// A provider failure as a sentence (Desktop's `onboardingFailureMessage`).
fn failure_message(class: &ConnectionEffectFailureClass, locale: Locale) -> String {
    match class {
        ConnectionEffectFailureClass::Auth => settings_copy::FAILED_AUTH,
        ConnectionEffectFailureClass::Timeout => settings_copy::FAILED_TIMEOUT,
        ConnectionEffectFailureClass::Network => settings_copy::FAILED_NETWORK,
        ConnectionEffectFailureClass::ProviderUnavailable => copy::ONBOARDING_UNAVAILABLE,
        _ => settings_copy::FAILED_INVALID_RESPONSE,
    }
    .in_locale(locale)
    .to_owned()
}

/// An onboarding input for the log, without the key.
fn describe(input: &ConnectionOnboardingVerifyInput) -> String {
    let target = match &input.target {
        ConnectionOnboardingTarget::Create { provider_type, slug, .. } => {
            format!("{provider_type} as {}", slug.as_deref().unwrap_or("a derived identifier"))
        }
        ConnectionOnboardingTarget::Existing { connection_id } => connection_id.clone(),
        _ => "an unknown target".to_owned(),
    };
    format!(
        "{target} at {} ({})",
        input.base_url.as_deref().unwrap_or("the registry endpoint"),
        if input.api_key.is_some() { "with a key" } else { "without a key" }
    )
}

/// A field's error under it, in the destructive ink.
/// A form control with its error line 8px under it.
fn field_control(control: impl IntoElement, error: Option<impl IntoElement>) -> impl IntoElement {
    v_flex().w_full().gap_2().child(control).children(error)
}

fn field_error(key: &str, message: &SharedString, cx: &App) -> impl IntoElement {
    div()
        .id(domain_element_id("connection-field-error", key))
        .test_support()
        .aria_label(message.clone())
        .text_xs()
        .text_color(cx.maka().destructive)
        .child(message.clone())
}

/// The URL a custom connection's chat requests go to
/// (`providerRequestUrlPreview`): a complete http(s) address with
/// `/chat/completions` or `/responses` after it, its credentials masked;
/// none for Anthropic Messages.
pub(crate) fn request_url_preview(base_url: &str, protocol: &ModelApiProtocol) -> Option<String> {
    let base = base_url.trim().trim_end_matches('/');
    let (scheme, rest) = base.split_once("://")?;
    if !(scheme.eq_ignore_ascii_case("http") || scheme.eq_ignore_ascii_case("https"))
        || rest.is_empty()
    {
        return None;
    }
    let path = match protocol {
        ModelApiProtocol::OpenaiChat => "chat/completions",
        ModelApiProtocol::OpenaiResponses => "responses",
        _ => return None,
    };
    let authority_end = rest.find('/').unwrap_or(rest.len());
    let shown = match rest[..authority_end].rsplit_once('@') {
        Some((_, host)) => format!("{scheme}://<redacted>@{host}{}", &rest[authority_end..]),
        None => base.to_owned(),
    };
    Some(format!("{shown}/{path}"))
}

impl AddConnectionForm {
    fn error_for(&self, field: FormField) -> Option<&SharedString> {
        self.error.as_ref().filter(|(errored, _)| *errored == field).map(|(_, message)| message)
    }

    fn render_error(&self, cx: &App) -> Option<impl IntoElement> {
        let message = self.error_for(FormField::Form)?.clone();
        Some(
            div()
                .id("connection-error")
                .test_support()
                .aria_label(message.clone())
                .text_sm()
                .text_color(cx.maka().destructive)
                .child(message),
        )
    }

    /// The two steps of the verified route, as Desktop's compact Astryx
    /// `Stepper` draws them: each step an equal share of the row, under a
    /// 4px bar (primary once reached, the border ink ahead), then a 16px
    /// numbered disc and the step's name at 14. The current step's disc
    /// is primary with its figure in the on-primary ink and its name
    /// semibold ink; a step ahead has a wash disc, a muted figure and a
    /// muted name.
    fn render_stepper(&self, cx: &App) -> impl IntoElement {
        let maka = cx.maka();
        let current = usize::from(matches!(
            self.phase,
            AddConnectionPhase::Models | AddConnectionPhase::Saving
        ));
        let steps =
            [copy::STEP_KEY, copy::STEP_MODELS].into_iter().enumerate().map(|(ix, name)| {
                let reached = ix <= current;
                let name = name.get(cx);
                v_flex()
                    .id(("add-connection-step", ix))
                    .test_support()
                    .aria_label(SharedString::from(name))
                    .aria_selected(ix == current)
                    .flex_1()
                    .min_w_0()
                    .child(div().h_1().w_full().rounded_full().bg(if reached {
                        maka.primary
                    } else {
                        maka.border
                    }))
                    .child(
                        h_flex()
                            .mt_0p5()
                            .py_1()
                            .gap_2()
                            .min_w_0()
                            .child(
                                h_flex()
                                    .size_4()
                                    .flex_shrink_0()
                                    .justify_center()
                                    .rounded_full()
                                    .bg(if reached { maka.primary } else { maka.wash })
                                    .text_xs()
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .text_color(if reached {
                                        maka.on_primary
                                    } else {
                                        maka.ink_muted
                                    })
                                    .child(SharedString::from((ix + 1).to_string())),
                            )
                            .child(
                                div()
                                    .min_w_0()
                                    .truncate()
                                    .text_sm()
                                    .when(ix == current, |this| {
                                        this.font_weight(FontWeight::SEMIBOLD)
                                    })
                                    .text_color(if ix == current {
                                        maka.ink
                                    } else {
                                        maka.ink_muted
                                    })
                                    .child(name),
                            ),
                    )
            });
        h_flex()
            .id("add-connection-steps")
            .test_support()
            .role(gpui_kit::Role::List)
            .aria_label(copy::STEPS_LABEL.get(cx))
            .w_full()
            .gap_1()
            .children(steps)
    }

    fn render_advanced(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let open = self.advanced_open;
        let busy = self.phase.is_busy();
        let label = if open { copy::HIDE_ADVANCED_REQUEST } else { copy::SHOW_ADVANCED_REQUEST };
        let toggle = disclosure(
            Button::new("add-connection-advanced")
                .on_click(cx.listener(|this, _, _, cx| this.toggle_advanced(cx))),
            open,
            label.get(cx),
            cx,
        );
        let error = self.error_for(FormField::Advanced).map(|m| field_error("advanced", m, cx));
        v_flex()
            .id("add-connection-advanced-settings")
            .test_support()
            .w_full()
            .items_start()
            .gap_3()
            .child(toggle)
            .when(open, |this| {
                this.child(
                    v_flex()
                        .w_full()
                        .gap_3()
                        .child(
                            div()
                                .text_sm()
                                .font_weight(FontWeight::MEDIUM)
                                .child(copy::REQUEST_HEADERS.get(cx)),
                        )
                        .child(self.headers.clone())
                        .child(
                            FieldBlock::new("connection-request-body")
                                .field(
                                    copy::EXTRA_REQUEST_BODY.get(cx),
                                    Textarea::new(&self.body)
                                        .field_fill(cx)
                                        .aria_label(copy::EXTRA_REQUEST_BODY.get(cx))
                                        .disabled(busy),
                                )
                                .help(copy::EXTRA_REQUEST_BODY_HELP_ADD.get(cx)),
                        ),
                )
            })
            .children(error)
    }

    fn render_endpoint(&self, cx: &mut Context<Self>) -> FieldBlock {
        let busy = self.phase.is_busy();
        let provider = self.provider;
        if provider.builds_endpoint_from_account() {
            let error =
                self.error_for(FormField::AccountId).map(|m| field_error("account-id", m, cx));
            return FieldBlock::new("connection-account-id")
                .field(
                    copy::ACCOUNT_ID.get(cx),
                    field_control(
                        Input::new(&self.account_id)
                            .field_fill(cx)
                            .id("connection-account-id")
                            .aria_label(copy::ACCOUNT_ID.get(cx))
                            .disabled(busy),
                        error,
                    ),
                )
                .required(true);
        }
        let preview = provider
            .is_custom()
            .then(|| request_url_preview(&self.text(&self.base_url, cx), &self.protocol(cx)))
            .flatten()
            .map(|url| SharedString::from(copy::request_url(Locale::current(cx), &url)));
        let error = self.error_for(FormField::BaseUrl).map(|m| field_error("base-url", m, cx));
        let block = FieldBlock::new("connection-base-url")
            .field(
                settings_copy::SERVICE_URL.get(cx),
                field_control(
                    Input::new(&self.base_url)
                        .field_fill(cx)
                        .id("connection-base-url")
                        .aria_label(settings_copy::SERVICE_URL.get(cx))
                        .disabled(busy),
                    error,
                ),
            )
            .required(provider.requires_base_url());
        match preview {
            Some(preview) => block.help_element(
                div()
                    .id("connection-request-url")
                    .test_support()
                    .aria_label(preview.clone())
                    .child(preview),
            ),
            None => block,
        }
    }

    fn render_fields(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let busy = self.phase.is_busy();
        let provider = self.provider;
        let key_required = provider.requires_secret();
        let key = provider.supports_api_key().then(|| {
            let error = self.error_for(FormField::ApiKey).map(|m| field_error("api-key", m, cx));
            FieldBlock::new("connection-api-key")
                .field(
                    settings_copy::API_KEY.get(cx),
                    field_control(
                        Input::new(&self.api_key)
                            .field_fill(cx)
                            .id("connection-api-key")
                            .aria_label(settings_copy::API_KEY.get(cx))
                            .mask_toggle()
                            .disabled(busy),
                        error,
                    ),
                )
                .required(key_required)
                .optional(!key_required)
        });
        let mut fields = Vec::new();
        if self.full() {
            let error = self.error_for(FormField::Slug).map(|m| field_error("slug", m, cx));
            fields.push(
                FieldBlock::new("connection-slug").field(
                    copy::SLUG.get(cx),
                    field_control(
                        Input::new(&self.slug)
                            .field_fill(cx)
                            .id("connection-slug")
                            .aria_label(copy::SLUG.get(cx))
                            .disabled(busy),
                        error,
                    ),
                ),
            );
            fields.push(
                FieldBlock::new("connection-name").field(
                    copy::DISPLAY_NAME.get(cx),
                    Input::new(&self.name)
                        .field_fill(cx)
                        .id("connection-name")
                        .aria_label(copy::DISPLAY_NAME.get(cx))
                        .disabled(busy),
                ),
            );
            fields.push(self.render_endpoint(cx));
            if provider.is_custom() {
                fields.push(
                    FieldBlock::new("connection-protocol")
                        .field(
                            copy::CONNECTION_API_PROTOCOL.get(cx),
                            Select::new(&self.protocol)
                                .id("connection-protocol")
                                .accessibility_label(copy::CONNECTION_API_PROTOCOL.get(cx))
                                .disabled(busy),
                        )
                        .help(copy::CONNECTION_API_PROTOCOL_HELP.get(cx)),
                );
            }
            if self.route(cx) == Route::Create && provider.recommended_model.is_none() {
                fields.push(
                    FieldBlock::new("connection-default-model")
                        .field(
                            copy::DEFAULT_MODEL.get(cx),
                            Input::new(&self.default_model)
                                .field_fill(cx)
                                .id("connection-default-model")
                                .aria_label(copy::DEFAULT_MODEL.get(cx))
                                .disabled(busy),
                        )
                        .help(copy::DEFAULT_MODEL_HELP.get(cx)),
                );
            }
        }
        // One form: the blocks 16px apart, no rules between them.
        v_flex().w_full().children(key).children(fields)
    }

    fn render_input(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let onboarding = self.route(cx) == Route::Onboarding;
        let (label, busy_label) = if onboarding {
            (copy::VERIFY_AND_CHOOSE, copy::VERIFYING)
        } else {
            (copy::SAVE_PROVIDER, copy::SAVING)
        };
        let busy = self.phase.is_busy();
        let maka = cx.maka();
        v_flex()
            .id("add-connection")
            .test_support()
            .w_full()
            .gap_5()
            .when(onboarding, |this| this.child(self.render_stepper(cx)))
            .child(self.render_fields(cx))
            .child(self.render_advanced(cx))
            .when(busy, |this| {
                this.child(
                    div()
                        .id("connection-progress")
                        .test_support()
                        .text_xs()
                        .text_color(maka.ink_muted)
                        .child(busy_label.get(cx)),
                )
            })
            .children(self.render_error(cx))
            .child(
                h_flex()
                    .justify_end()
                    .gap_2()
                    .child(
                        quiet_button(Button::new("cancel-connection"), cx)
                            .label(settings_copy::CANCEL.get(cx))
                            .disabled(busy)
                            .on_click(cx.listener(|this, _, _, cx| this.cancel(cx))),
                    )
                    .child(
                        control_button(Button::new("submit-connection").primary())
                            .label(if busy { busy_label.get(cx) } else { label.get(cx) })
                            .loading(busy)
                            .on_click(cx.listener(|this, _, window, cx| this.submit(window, cx))),
                    ),
            )
    }

    fn visible_models(&self, cx: &App) -> Vec<&ModelChoice> {
        let query = self.model_filter.read(cx).value().trim().to_lowercase();
        self.models
            .iter()
            .filter(|model| {
                query.is_empty()
                    || model.id.to_lowercase().contains(&query)
                    || model.label.to_lowercase().contains(&query)
            })
            .collect()
    }

    fn render_models(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let locale = Locale::current(cx);
        let saving = self.phase == AddConnectionPhase::Saving;
        let maka = cx.maka();
        let rows: Vec<_> = self
            .visible_models(cx)
            .into_iter()
            .map(|model| {
                let id = model.id.clone();
                let checkbox = Checkbox::new(domain_element_id("model", &model.id))
                    .label(model.label.clone())
                    // The row text size; the kit's medium label is 16px.
                    .text_sm()
                    .checked(self.selected.contains(&model.id))
                    .disabled(saving)
                    .on_click(cx.listener(move |this, checked: &bool, window, cx| {
                        this.set_model_selected(&id, *checked, window, cx)
                    }));
                // The id under a name that is not the id.
                v_flex().child(checkbox).when(model.label != model.id, |this| {
                    this.child(
                        div().pl_6().text_xs().text_color(maka.ink_muted).child(model.id.clone()),
                    )
                })
            })
            .collect();
        let empty = rows.is_empty();
        let count = copy::selected_count(locale, self.selected.len(), self.models.len());
        v_flex()
            .id("connection-models")
            .test_support()
            .w_full()
            .gap_4()
            .child(self.render_stepper(cx))
            .child(
                v_flex()
                    .gap_1()
                    .child(
                        div()
                            .text_sm()
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(maka.ink)
                            .child(copy::CHOOSE_MODELS.get(cx)),
                    )
                    .child(
                        div()
                            .text_xs()
                            .text_color(maka.ink_muted)
                            .child(copy::CHOOSE_MODELS_HELP.get(cx)),
                    ),
            )
            .child(
                h_flex()
                    .w_full()
                    .justify_between()
                    .flex_wrap()
                    .gap_2()
                    .child(
                        div()
                            .id("connection-models-count")
                            .test_support()
                            .aria_label(SharedString::from(count.clone()))
                            .text_xs()
                            .text_color(maka.ink_muted)
                            .child(count),
                    )
                    .child(
                        h_flex()
                            .gap_1()
                            .child(
                                quiet_button(Button::new("connection-models-all"), cx)
                                    .label(copy::SELECT_ALL.get(cx))
                                    .disabled(saving || self.selected.len() == self.models.len())
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.select_all(true, window, cx)
                                    })),
                            )
                            .child(
                                quiet_button(Button::new("connection-models-none"), cx)
                                    .label(copy::DESELECT_ALL.get(cx))
                                    .disabled(saving || self.selected.is_empty())
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.select_all(false, window, cx)
                                    })),
                            ),
                    ),
            )
            .when(self.models.len() > MODEL_FILTER_THRESHOLD, |this| {
                this.child(
                    Input::new(&self.model_filter)
                        .field_fill(cx)
                        .id("connection-models-filter")
                        .aria_label(copy::SEARCH_MODELS.get(cx))
                        .prefix(Icon::new(MakaIcon::Search).small())
                        .cleanable(true)
                        .disabled(saving),
                )
            })
            .child(
                v_flex()
                    .id("connection-models-list")
                    .test_support()
                    .w_full()
                    .gap_2()
                    .when(empty, |this| {
                        this.child(
                            div()
                                .text_sm()
                                .text_color(maka.ink_muted)
                                .child(copy::NO_MODELS_MATCH.get(cx)),
                        )
                    })
                    .children(rows),
            )
            .child(
                FieldBlock::new("connection-default-choice")
                    .field(
                        copy::DEFAULT_MODEL.get(cx),
                        Select::new(&self.default_choice)
                            .id("connection-default-choice")
                            .accessibility_label(copy::DEFAULT_MODEL.get(cx))
                            .placeholder(settings_copy::NO_MODEL_SELECTED.get(cx))
                            .disabled(saving || self.selected.is_empty()),
                    )
                    .help(copy::ONBOARDING_DEFAULT_MODEL_HELP.get(cx)),
            )
            .when(saving, |this| {
                this.child(
                    div()
                        .id("connection-progress")
                        .test_support()
                        .text_xs()
                        .text_color(maka.ink_muted)
                        .child(copy::SAVING.get(cx)),
                )
            })
            .children(self.render_error(cx))
            .child(
                h_flex()
                    .justify_end()
                    .gap_2()
                    .child(
                        quiet_button(Button::new("connection-back-to-edit"), cx)
                            .label(copy::BACK_TO_EDIT.get(cx))
                            .disabled(saving)
                            .on_click(cx.listener(|this, _, _, cx| this.back_to_edit(cx))),
                    )
                    .child(
                        control_button(Button::new("save-connection").primary())
                            .label(if saving {
                                copy::SAVING.get(cx)
                            } else {
                                settings_copy::SAVE.get(cx)
                            })
                            .loading(saving)
                            .disabled(self.selected.is_empty())
                            .on_click(cx.listener(|this, _, window, cx| this.submit(window, cx))),
                    ),
            )
    }

    fn render_outcome_unknown(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let maka = cx.maka();
        v_flex()
            .id("connection-outcome-unknown")
            .test_support()
            .w_full()
            .gap_3()
            .p_3()
            .rounded(cx.theme().radius_lg)
            .border_1()
            .border_color(maka.border)
            .child(
                div()
                    .text_sm()
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(maka.warning)
                    .child(copy::OUTCOME_UNKNOWN.get(cx)),
            )
            .child(
                div()
                    .text_xs()
                    .text_color(maka.ink_muted)
                    .child(copy::OUTCOME_UNKNOWN_DETAIL.get(cx)),
            )
            .child(
                h_flex().justify_end().child(
                    quiet_button(Button::new("connection-reload-list"), cx)
                        .label(copy::RELOAD_CONNECTIONS.get(cx))
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.connections.update(cx, |catalog, cx| catalog.reload(cx));
                            cx.emit(AddConnectionEvent::ShowList);
                        })),
                ),
            )
    }
}

impl Render for AddConnectionForm {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        match self.phase {
            AddConnectionPhase::Models | AddConnectionPhase::Saving => {
                self.render_models(cx).into_any_element()
            }
            AddConnectionPhase::OutcomeUnknown => {
                self.render_outcome_unknown(cx).into_any_element()
            }
            _ => self.render_input(cx).into_any_element(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifiers_follow_the_slug_rules() {
        for good in ["ollama-test", "a1", "x-2-y", &"a".repeat(64)] {
            assert_eq!(slug_issue(good), None, "{good}");
        }
        assert_eq!(slug_issue(""), Some(copy::SLUG_REQUIRED));
        for bad in ["a", "-ab", "ab-", "Ab", "a_b", "a b", "中文"] {
            assert_eq!(slug_issue(bad), Some(copy::SLUG_FORMAT), "{bad}");
        }
        assert_eq!(slug_issue(&"a".repeat(65)), Some(copy::SLUG_TOO_LONG));
    }

    #[test]
    fn a_derived_identifier_avoids_the_taken_ones() {
        assert_eq!(derive_slug("MiniMax-cn", &[]), "minimax-cn");
        let taken: Vec<SharedString> = vec!["deepseek".into(), "deepseek-2".into()];
        assert_eq!(derive_slug("deepseek", &taken), "deepseek-3");
    }

    #[test]
    fn a_custom_request_url_follows_the_protocol() {
        let chat = ModelApiProtocol::OpenaiChat;
        assert_eq!(
            request_url_preview("https://relay.example/v1/", &chat).as_deref(),
            Some("https://relay.example/v1/chat/completions")
        );
        assert_eq!(
            request_url_preview("https://relay.example/v1", &ModelApiProtocol::OpenaiResponses)
                .as_deref(),
            Some("https://relay.example/v1/responses")
        );
        assert_eq!(request_url_preview("relay.example", &chat), None);
        assert_eq!(request_url_preview("https://a", &ModelApiProtocol::AnthropicMessages), None);
        assert_eq!(
            request_url_preview("https://user:pw@relay.example/v1", &chat).as_deref(),
            Some("https://<redacted>@relay.example/v1/chat/completions")
        );
    }

    #[test]
    fn every_refusal_and_failure_reads_as_a_sentence() {
        use ConnectionOnboardingRejection as R;
        for reason in [
            R::ProviderUnsupported,
            R::ConnectionNotFound,
            R::CredentialNotConfigured,
            R::BaseUrlNotConfigured,
            R::SlugTaken,
            R::CatalogFull,
            R::ModelUnavailable,
            R::Superseded,
            R::Other("future".into()),
        ] {
            let message = rejection_message(&reason, "DeepSeek", Locale::English);
            assert!(message.ends_with('.'), "{reason}: {message}");
        }
        use ConnectionEffectFailureClass as F;
        for class in [
            F::Auth,
            F::Timeout,
            F::ProviderUnavailable,
            F::Network,
            F::InvalidResponse,
            F::Unknown,
            F::Other("future".into()),
        ] {
            assert!(failure_message(&class, Locale::English).ends_with('.'), "{class}");
        }
    }
}
