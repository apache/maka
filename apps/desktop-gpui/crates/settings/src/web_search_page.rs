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

//! The Web Search page (Beta), after Maka Desktop's
//! (web-search-settings-page.tsx): the search source (the main model's own
//! search, or Tavily), the switch, the Tavily key and its test, and a real
//! query with its results.
//!
//! The source and the switch are the Host's runtime policy
//! (`set_web_search`). The key lives in the Host's vault
//! (`credential.vault.*`, locator `web_search/tavily/api_key`): the page
//! knows whether one is saved and at which revision, never the key. The
//! field is write-only; a key typed there replaces the saved one on Save
//! and is tested in place of it until then. A test and a query are
//! `web-search.execute`.
//!
//! Desktop shows the vault's last write time as "Last tested" and every
//! saved key as "Not tested" after a reload; this page shows what a test
//! run here found, and when, until the key changes.

use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::select::{Select, SelectEvent};
use gpui_kit::component::switch::Switch;
use gpui_kit::component::{Disableable as _, h_flex, v_flex};
use gpui_kit::{
    AnyElement, AnyWindowHandle, App, AppContext as _, Context, Entity, InteractiveElement as _,
    IntoElement, ParentElement as _, Render, SharedString, StatefulInteractiveElement as _,
    Styled as _, Subscription, Task, TestSupportExt as _, Window, div, rems,
};
use host_protocol::{
    CredentialKind, CredentialLocator, CredentialMutationResult, CredentialStatus,
    CredentialVaultDelete, CredentialVaultDeleteInput, CredentialVaultQuery,
    CredentialVaultQueryInput, CredentialVaultQueryResult, CredentialVaultSet,
    CredentialVaultSetInput, RuntimePolicy, RuntimePolicyMutation, WEB_SEARCH_DEFAULT_LIMIT,
    WebSearchErrorReason, WebSearchExecute, WebSearchExecuteInput, WebSearchExecuteResult,
    WebSearchPolicy, WebSearchProvider, WebSearchResultRow,
};
use shared::copy::web_search as copy;
use shared::copy::{Locale, Text, failure, settings as settings_copy};
use shared::domain_element_id;
use shared::theme::FadedSwitch;
use shared::theme::FieldFill as _;
use shared::theme::{ActiveMakaPalette as _, control_button, quiet_button};
use workspace::{HostRequestError, HostRequester, HostSession, HostSessionEvent};

use crate::page_kit::{Tone, ago, policy_status, status_dot, titled};
use crate::policy::{HostPolicy, host_error_reason};
use crate::rows::{
    ActionRow, Choice, ChoiceSelect, FieldBlock, SettingsGroup, SettingsRow, StatusKind,
    StatusLine, settings_button, sync_choices,
};

/// A write the vault answered stale is read and tried again, at most this
/// many times in all (Desktop's `setCredential` and `deleteCredential`).
const CREDENTIAL_ATTEMPTS: usize = 3;

/// The key of the page's own status line (offline, or the policy unread).
const PAGE_KEY: &str = "web-search";

/// Where the Tavily key lives.
pub fn tavily_locator() -> CredentialLocator {
    CredentialLocator::WebSearch { provider: "tavily".to_owned(), kind: CredentialKind::ApiKey }
}

fn provider_choices(locale: Locale) -> Vec<Choice<WebSearchProvider>> {
    vec![
        Choice::new(WebSearchProvider::Model, copy::PROVIDER_MODEL.in_locale(locale)),
        Choice::new(WebSearchProvider::Tavily, copy::PROVIDER_TAVILY),
    ]
}

/// What a test found about the saved key (Desktop's
/// `WebSearchCredentialStatus`, from `webSearchCredentialStatusFromResponse`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyCheck {
    Valid,
    InvalidCredentials,
    RateLimited,
    Timeout,
    NetworkError,
    NotConfigured,
}

impl KeyCheck {
    fn of(reason: &WebSearchErrorReason) -> Self {
        match reason {
            WebSearchErrorReason::InvalidCredentials => Self::InvalidCredentials,
            WebSearchErrorReason::RateLimited => Self::RateLimited,
            WebSearchErrorReason::Timeout => Self::Timeout,
            WebSearchErrorReason::NotConfigured => Self::NotConfigured,
            _ => Self::NetworkError,
        }
    }
}

/// The sentence for why the source refused (Desktop's `errors`).
fn reason_text(reason: &WebSearchErrorReason) -> Option<Text> {
    Some(match reason {
        WebSearchErrorReason::InvalidQuery => copy::ERROR_INVALID_QUERY,
        WebSearchErrorReason::IncognitoActive => copy::ERROR_INCOGNITO,
        WebSearchErrorReason::NotConfigured => copy::ERROR_NOT_CONFIGURED,
        WebSearchErrorReason::InvalidCredentials => copy::ERROR_INVALID_CREDENTIALS,
        WebSearchErrorReason::RateLimited => copy::ERROR_RATE_LIMITED,
        WebSearchErrorReason::NetworkError => copy::ERROR_NETWORK,
        WebSearchErrorReason::Timeout => copy::ERROR_TIMEOUT,
        WebSearchErrorReason::UnsupportedProvider => copy::ERROR_UNSUPPORTED_PROVIDER,
        WebSearchErrorReason::ExperimentalDisabled => copy::ERROR_EXPERIMENTAL_DISABLED,
        _ => return None,
    })
}

/// A refusal in words: its sentence, or the Host's message for a reason
/// this client does not know.
fn refusal_text(reason: &WebSearchErrorReason, message: &str, locale: Locale) -> String {
    reason_text(reason).map_or_else(|| message.to_owned(), |text| text.in_locale(locale).to_owned())
}

/// The status beside the switch: its words and tone (Desktop's
/// `presentWebSearchCredentialStatus`).
fn key_status(
    provider: &WebSearchProvider,
    enabled: bool,
    saved: bool,
    check: Option<KeyCheck>,
) -> (Text, Tone) {
    if *provider == WebSearchProvider::Model {
        return if enabled {
            (copy::STATUS_MODEL_ENABLED, Tone::Success)
        } else {
            (copy::STATUS_MODEL_DISABLED, Tone::Attention)
        };
    }
    if !saved {
        return (copy::STATUS_NOT_CONFIGURED, Tone::Attention);
    }
    match check {
        Some(KeyCheck::Valid) if enabled => (copy::STATUS_VALID_ENABLED, Tone::Success),
        Some(KeyCheck::Valid) => (copy::STATUS_VALID_DISABLED, Tone::Neutral),
        Some(KeyCheck::InvalidCredentials) => (copy::STATUS_INVALID_CREDENTIALS, Tone::Error),
        Some(KeyCheck::RateLimited) => (copy::STATUS_RATE_LIMITED, Tone::Attention),
        Some(KeyCheck::Timeout) => (copy::STATUS_TIMEOUT, Tone::Attention),
        Some(KeyCheck::NetworkError) => (copy::STATUS_NETWORK_ERROR, Tone::Attention),
        Some(KeyCheck::NotConfigured) => (copy::STATUS_NOT_CONFIGURED, Tone::Attention),
        None if enabled => (copy::STATUS_UNKNOWN_ENABLED, Tone::Attention),
        None => (copy::STATUS_UNTESTED, Tone::Attention),
    }
}

/// A result row the page shows: only an `http:` or `https:` link, as
/// Desktop's `normalizeSearchUrl` keeps (the Host filters first; the page
/// does not trust a row either).
fn safe_rows(rows: Vec<WebSearchResultRow>) -> Vec<WebSearchResultRow> {
    rows.into_iter()
        .filter(|row| {
            let url = row.url.trim().to_ascii_lowercase();
            url.starts_with("https://") || url.starts_with("http://")
        })
        .collect()
}

/// The last test of the saved key, while the key is the one tested.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Checked {
    check: KeyCheck,
    /// The key's vault revision when it was tested.
    revision: Option<u64>,
    at_ms: u64,
}

/// The action in flight among those that touch the key: one at a time,
/// and the button that started it says so.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum KeyAction {
    Save,
    Clear,
    Test,
}

/// Where the live query stands.
#[derive(Debug, Clone, PartialEq, Eq)]
enum LiveQuery {
    Idle,
    Running(String),
    Found(Vec<WebSearchResultRow>),
    Failed(SharedString),
}

/// Behavior and presentation owner of the Web Search page.
///
/// The source and the switch save as they change; the key saves with Save
/// key, and Clear key removes it and turns web search off, as Desktop's
/// does. One key action runs at a time. What an action found says so on the
/// line under the buttons; a query's results show under the search box and
/// go when the query is edited.
pub struct WebSearchPage {
    host: Entity<HostSession>,
    policy: Entity<HostPolicy>,
    provider: Entity<ChoiceSelect<WebSearchProvider>>,
    key: Entity<InputState>,
    query: Entity<InputState>,
    /// The saved key's status, once read.
    credential: Option<CredentialStatus>,
    credential_error: Option<SharedString>,
    checked: Option<Checked>,
    key_action: Option<KeyAction>,
    /// What the last key action found.
    feedback: Option<(StatusKind, SharedString)>,
    /// Why the last source or switch change was refused.
    policy_error: Option<SharedString>,
    policy_saving: bool,
    live: LiveQuery,
    utc_offset: i32,
    /// The window the page draws in, for a read that ends outside an event.
    window: AnyWindowHandle,
    _credential: Option<Task<()>>,
    _action: Option<Task<()>>,
    _policy: Option<Task<()>>,
    _live: Option<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl std::fmt::Debug for WebSearchPage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WebSearchPage")
            .field("credential", &self.credential)
            .field("key_action", &self.key_action)
            .field("live", &self.live)
            .finish_non_exhaustive()
    }
}

impl WebSearchPage {
    pub fn new(
        host: Entity<HostSession>,
        policy: Entity<HostPolicy>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let locale = Locale::current(cx);
        let provider = cx.new(|cx| ChoiceSelect::new(provider_choices(locale), None, window, cx));
        let key = cx.new(|cx| {
            let mut input = InputState::new(window, cx).placeholder(copy::KEY_PLACEHOLDER);
            input.set_masked(true, window, cx);
            input
        });
        let query =
            cx.new(|cx| InputState::new(window, cx).placeholder(copy::QUERY_PLACEHOLDER.get(cx)));
        let subscriptions = vec![
            cx.subscribe_in(
                &provider,
                window,
                |this, _, event: &SelectEvent<Vec<Choice<WebSearchProvider>>>, window, cx| {
                    if let SelectEvent::Confirm(Some(provider)) = event {
                        this.set_provider(provider.clone(), window, cx);
                    }
                },
            ),
            cx.subscribe_in(&key, window, |_, _, event: &InputEvent, _, cx| {
                if matches!(event, InputEvent::Change) {
                    cx.notify();
                }
            }),
            cx.subscribe_in(
                &query,
                window,
                |this, _, event: &InputEvent, window, cx| match event {
                    InputEvent::Change => this.query_changed(cx),
                    InputEvent::PressEnter { .. } => this.run_query(window, cx),
                    _ => {}
                },
            ),
            cx.subscribe(&host, |this, _, event: &HostSessionEvent, cx| {
                if matches!(event, HostSessionEvent::Connected { .. }) {
                    this.read_credential(cx);
                }
            }),
            cx.observe_in(&policy, window, |this, _, window, cx| this.sync(window, cx)),
            cx.observe_global_in::<Locale>(window, |this, window, cx| {
                let placeholder = copy::QUERY_PLACEHOLDER.get(cx);
                this.query.update(cx, |input, cx| input.set_placeholder(placeholder, window, cx));
                this.utc_offset = shared::time::local_utc_offset();
                this.sync(window, cx);
            }),
            cx.observe(&host, |_, _, cx| cx.notify()),
        ];
        let mut this = Self {
            host,
            policy,
            provider,
            key,
            query,
            credential: None,
            credential_error: None,
            checked: None,
            key_action: None,
            feedback: None,
            policy_error: None,
            policy_saving: false,
            live: LiveQuery::Idle,
            utc_offset: shared::time::local_utc_offset(),
            window: window.window_handle(),
            _credential: None,
            _action: None,
            _policy: None,
            _live: None,
            _subscriptions: subscriptions,
        };
        this.sync(window, cx);
        this
    }

    /// The page shows: reads whether a key is saved.
    pub fn activate(&mut self, cx: &mut Context<Self>) {
        self.read_credential(cx);
    }

    pub fn key_input(&self) -> &Entity<InputState> {
        &self.key
    }

    pub fn query_input(&self) -> &Entity<InputState> {
        &self.query
    }

    /// Whether a key is saved in the vault.
    pub fn key_saved(&self) -> bool {
        self.credential.as_ref().is_some_and(|status| status.configured)
    }

    /// Whether a write is unanswered (a test or a query is not one:
    /// leaving drops it).
    pub fn is_busy(&self) -> bool {
        self.policy_saving || matches!(self.key_action, Some(KeyAction::Save | KeyAction::Clear))
    }

    fn requester(&self, cx: &App) -> HostRequester {
        self.host.read(cx).requester()
    }

    fn web_search(&self, cx: &App) -> Option<WebSearchPolicy> {
        self.policy.read(cx).policy().map(|policy| policy.web_search.clone())
    }

    fn sync(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let locale = Locale::current(cx);
        let provider = self.web_search(cx).map(|web| web.default_provider);
        sync_choices(&self.provider, provider_choices(locale), provider.as_ref(), window, cx);
        let placeholder =
            if self.key_saved() { copy::STORED_PLACEHOLDER.get(cx) } else { copy::KEY_PLACEHOLDER };
        self.key.update(cx, |input, cx| input.set_placeholder(placeholder, window, cx));
        cx.notify();
    }

    /// Reads whether a key is saved; the key field's placeholder follows.
    fn read_credential(&mut self, cx: &mut Context<Self>) {
        if !self.host.read(cx).is_connected() {
            return;
        }
        let requester = self.requester(cx);
        let locale = Locale::current(cx);
        let window = self.window;
        self._credential = Some(cx.spawn(async move |this, cx| {
            let status = query_status(&requester).await;
            cx.update_window(window, |_, window, cx| {
                this.update(cx, |this, cx| {
                    this._credential = None;
                    match status {
                        Ok(status) => {
                            this.credential = status;
                            this.credential_error = None;
                        }
                        Err(error) => {
                            log::warn!("credential.vault.query failed: {error}");
                            this.credential_error = Some(host_error_reason(&error, locale).into());
                        }
                    }
                    this.sync(window, cx);
                })
                .ok();
            })
            .ok();
        }));
    }

    /// Writes the web search policy `edit` makes of it.
    fn change_policy(
        &mut self,
        edit: impl Fn(&mut WebSearchPolicy) + 'static,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let locale = Locale::current(cx);
        let change = move |policy: &RuntimePolicy| {
            let mut value = policy.web_search.clone();
            edit(&mut value);
            (value != policy.web_search).then_some(RuntimePolicyMutation::SetWebSearch { value })
        };
        let Some(task) = self.policy.update(cx, |policy, cx| policy.mutate(change, locale, cx))
        else {
            self.sync(window, cx);
            return;
        };
        self.policy_saving = true;
        self.policy_error = None;
        self._policy = Some(cx.spawn_in(window, async move |this, cx| {
            let result = task.await;
            this.update_in(cx, |this, window, cx| {
                this._policy = None;
                this.policy_saving = false;
                if let Err(refusal) = result {
                    let what = copy::SAVE_FAILED.in_locale(locale);
                    this.policy_error = Some(titled(locale, what, refusal.reason()).into());
                }
                this.sync(window, cx);
            })
            .ok();
        }));
        cx.notify();
    }

    fn set_provider(
        &mut self,
        provider: WebSearchProvider,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.live = LiveQuery::Idle;
        self.feedback = None;
        self.change_policy(move |web| web.default_provider = provider.clone(), window, cx);
    }

    /// The switch: on only with a usable source.
    pub fn set_enabled(&mut self, enabled: bool, window: &mut Window, cx: &mut Context<Self>) {
        self.change_policy(move |web| web.enabled = enabled, window, cx);
    }

    /// Whether the chosen source can search: the model's own always, Tavily
    /// with a saved key.
    fn usable(&self, cx: &App) -> bool {
        match self.web_search(cx) {
            Some(web) if web.default_provider == WebSearchProvider::Model => true,
            Some(_) => self.key_saved(),
            None => false,
        }
    }

    fn draft_key(&self, cx: &App) -> String {
        self.key.read(cx).value().to_string()
    }

    /// Save key: the typed key replaces the saved one; the field empties
    /// once the vault has it.
    pub fn save_key(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let secret = self.draft_key(cx);
        if self.key_action.is_some() || secret.is_empty() {
            return;
        }
        let requester = self.requester(cx);
        let locale = Locale::current(cx);
        self.key_action = Some(KeyAction::Save);
        self.feedback = None;
        self._action = Some(cx.spawn_in(window, async move |this, cx| {
            let result = set_key(&requester, &secret, locale).await;
            this.update_in(cx, |this, window, cx| {
                this._action = None;
                this.key_action = None;
                match result {
                    Ok(status) => {
                        this.credential = Some(status);
                        this.key.update(cx, |input, cx| input.set_value("", window, cx));
                        let line = titled(
                            locale,
                            copy::KEY_SAVED.in_locale(locale),
                            copy::KEY_SAVED_DETAIL.in_locale(locale),
                        );
                        this.feedback = Some((StatusKind::Info, line.into()));
                    }
                    Err(reason) => {
                        let what = copy::SAVE_FAILED.in_locale(locale);
                        this.feedback =
                            Some((StatusKind::Error, titled(locale, what, &reason).into()));
                    }
                }
                this.sync(window, cx);
            })
            .ok();
        }));
        cx.notify();
    }

    /// Clear key: turns web search off, then deletes the saved key (as
    /// Desktop's `clearKey`).
    pub fn clear_key(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.key_action.is_some() || !self.key_saved() {
            return;
        }
        let locale = Locale::current(cx);
        let off = |policy: &RuntimePolicy| {
            policy.web_search.enabled.then(|| RuntimePolicyMutation::SetWebSearch {
                value: WebSearchPolicy::new(false, policy.web_search.default_provider.clone()),
            })
        };
        let Some(disable) = self.policy.update(cx, |policy, cx| policy.mutate(off, locale, cx))
        else {
            return;
        };
        let requester = self.requester(cx);
        self.key_action = Some(KeyAction::Clear);
        self.feedback = None;
        self._action = Some(cx.spawn_in(window, async move |this, cx| {
            let what = copy::SAVE_FAILED.in_locale(locale);
            let result = match disable.await {
                Ok(()) => delete_key(&requester, locale).await,
                Err(refusal) => Err(refusal.reason().to_owned()),
            };
            this.update_in(cx, |this, window, cx| {
                this._action = None;
                this.key_action = None;
                match result {
                    Ok(status) => {
                        this.credential = status;
                        this.checked = None;
                        this.key.update(cx, |input, cx| input.set_value("", window, cx));
                        let line = titled(
                            locale,
                            copy::CREDENTIALS_CLEARED.in_locale(locale),
                            copy::CREDENTIALS_CLEARED_DETAIL.in_locale(locale),
                        );
                        this.feedback = Some((StatusKind::Info, line.into()));
                    }
                    Err(reason) => {
                        this.feedback =
                            Some((StatusKind::Error, titled(locale, what, &reason).into()));
                    }
                }
                this.sync(window, cx);
            })
            .ok();
        }));
        cx.notify();
    }

    /// Test credentials: the typed key when there is one, else the saved
    /// one, whose outcome the status then shows.
    pub fn test_key(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let draft = self.draft_key(cx);
        if self.key_action.is_some() || (draft.is_empty() && !self.key_saved()) {
            return;
        }
        let tests_saved = draft.trim().is_empty();
        let revision = self.credential.as_ref().and_then(|status| status.revision);
        let request = self
            .requester(cx)
            .request::<WebSearchExecute>(&WebSearchExecuteInput::test(Some(draft)));
        let locale = Locale::current(cx);
        self.key_action = Some(KeyAction::Test);
        self.feedback = None;
        self._action = Some(cx.spawn_in(window, async move |this, cx| {
            let result = request.await;
            this.update(cx, |this, cx| {
                this._action = None;
                this.key_action = None;
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0, |elapsed| elapsed.as_millis() as u64);
                let (check, line) = match result {
                    Ok(WebSearchExecuteResult::Found { results, .. }) => (
                        Some(KeyCheck::Valid),
                        (
                            StatusKind::Info,
                            titled(
                                locale,
                                copy::CREDENTIAL_VALID.in_locale(locale),
                                &copy::result_count(locale, results.len()),
                            ),
                        ),
                    ),
                    Ok(WebSearchExecuteResult::Failed { reason, message }) => {
                        let what = copy::TEST_FAILED.in_locale(locale);
                        let text = refusal_text(&reason, &message, locale);
                        (
                            Some(KeyCheck::of(&reason)),
                            (StatusKind::Error, titled(locale, what, &text)),
                        )
                    }
                    Ok(_) => {
                        (None, (StatusKind::Error, copy::TEST_ERROR.in_locale(locale).to_owned()))
                    }
                    Err(error) => {
                        let what = copy::TEST_ERROR.in_locale(locale);
                        let reason = host_error_reason(&error, locale);
                        (None, (StatusKind::Error, titled(locale, what, &reason)))
                    }
                };
                if let (Some(check), true) = (check, tests_saved) {
                    this.checked = Some(Checked { check, revision, at_ms: now });
                }
                this.feedback = Some((line.0, line.1.into()));
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    /// Why Search cannot run now, as the line beside it says.
    fn query_blocked(&self, cx: &App) -> Option<Text> {
        let web = self.web_search(cx)?;
        if !self.usable(cx) {
            return Some(copy::NO_KEY_REASON);
        }
        if !web.enabled {
            return Some(copy::DISABLED_REASON);
        }
        self.query.read(cx).value().trim().is_empty().then_some(copy::NO_QUERY_REASON)
    }

    fn query_changed(&mut self, cx: &mut Context<Self>) {
        // Results answer the query they were asked for: typing drops them.
        if !matches!(self.live, LiveQuery::Running(_) | LiveQuery::Idle) {
            self.live = LiveQuery::Idle;
        }
        cx.notify();
    }

    /// Search: a real query of five rows through the chosen source.
    pub fn run_query(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if matches!(self.live, LiveQuery::Running(_)) || self.query_blocked(cx).is_some() {
            return;
        }
        let text = self.query.read(cx).value().to_string();
        let Some(input) = WebSearchExecuteInput::query(&text, WEB_SEARCH_DEFAULT_LIMIT) else {
            return;
        };
        let request = self.requester(cx).request::<WebSearchExecute>(&input);
        let locale = Locale::current(cx);
        let revision = self.credential.as_ref().and_then(|status| status.revision);
        self.live = LiveQuery::Running(text.clone());
        self._live = Some(cx.spawn_in(window, async move |this, cx| {
            let result = request.await;
            this.update(cx, |this, cx| {
                this._live = None;
                // A query edited since it was sent no longer owns the answer.
                if this.query.read(cx).value() != text.as_str() {
                    this.live = LiveQuery::Idle;
                    cx.notify();
                    return;
                }
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0, |elapsed| elapsed.as_millis() as u64);
                let tavily = this
                    .web_search(cx)
                    .is_some_and(|web| web.default_provider == WebSearchProvider::Tavily);
                this.live = match result {
                    Ok(WebSearchExecuteResult::Found { results, .. }) => {
                        if tavily {
                            this.checked =
                                Some(Checked { check: KeyCheck::Valid, revision, at_ms: now });
                        }
                        LiveQuery::Found(safe_rows(results))
                    }
                    Ok(WebSearchExecuteResult::Failed { reason, message }) => {
                        if tavily {
                            let check = KeyCheck::of(&reason);
                            this.checked = Some(Checked { check, revision, at_ms: now });
                        }
                        LiveQuery::Failed(refusal_text(&reason, &message, locale).into())
                    }
                    Ok(_) => LiveQuery::Failed(settings_copy::UNEXPECTED.in_locale(locale).into()),
                    Err(error) => LiveQuery::Failed(host_error_reason(&error, locale).into()),
                };
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    /// The test outcome that still describes the saved key.
    fn current_check(&self) -> Option<&Checked> {
        let revision = self.credential.as_ref().and_then(|status| status.revision);
        self.checked.as_ref().filter(|checked| checked.revision == revision)
    }

    fn render_provider(
        &self,
        web: &WebSearchPolicy,
        editable: bool,
        cx: &mut Context<Self>,
    ) -> SettingsGroup {
        let locale = Locale::current(cx);
        let model = web.default_provider == WebSearchProvider::Model;
        let provider = SettingsRow::select(
            "web-search-provider",
            copy::PROVIDER.get(cx),
            Select::new(&self.provider).disabled(!editable),
        )
        .detail(copy::PROVIDER_HELP.get(cx))
        .status(
            self.policy_error.clone().map(|error| StatusLine::error("web-search-provider", error)),
        );
        let check = self.current_check();
        let (label, tone) = key_status(
            &web.default_provider,
            web.enabled,
            self.key_saved(),
            check.map(|c| c.check),
        );
        let source = if model {
            copy::SOURCE_MODEL
        } else if self.key_saved() {
            copy::SOURCE_SAVED
        } else {
            copy::SOURCE_NONE
        };
        let last_test = check
            .filter(|_| !model)
            .map(|checked| copy::last_test(locale, &ago(locale, checked.at_ms, self.utc_offset)));
        let muted = cx.maka().ink_muted;
        let status = v_flex()
            .id("web-search-status")
            .test_support()
            .aria_label(copy::STATUS_LABEL.get(cx))
            .items_end()
            .gap_0p5()
            .child(status_dot("web-search", label.get(cx), tone, cx))
            .children(last_test.map(|line| div().text_xs().text_color(muted).child(line)))
            .child(
                div()
                    .id("web-search-source")
                    .test_support()
                    .aria_label(source.get(cx))
                    .text_xs()
                    .text_color(muted)
                    .child(source.get(cx)),
            );
        let page = cx.weak_entity();
        let switch = {
            let (checked, disabled) = (web.enabled, !editable || !self.usable(cx));
            FadedSwitch::new(
                Switch::new(domain_element_id("settings-toggle", "web-search-enabled"))
                    .checked(checked)
                    .disabled(disabled)
                    .accessibility_label(copy::ENABLED.get(cx))
                    .on_change(move |on, window, cx| {
                        page.update(cx, |page, cx| page.set_enabled(*on, window, cx)).ok();
                    }),
                checked,
                disabled,
            )
        };
        let enabled = SettingsRow::new("web-search-enabled", copy::ENABLED.get(cx))
            .detail(copy::ENABLED_HELP.get(cx))
            .end(h_flex().items_start().gap_3().child(status).child(switch));
        let group = SettingsGroup::new("search-provider")
            .title(copy::SEARCH_PROVIDER.get(cx))
            .description(copy::SEARCH_PROVIDER_HELP.get(cx))
            .child(provider)
            .child(enabled);
        if model {
            return group.child(
                SettingsRow::new("web-search-model", copy::MODEL_CREDENTIAL.get(cx))
                    .detail(copy::MODEL_CREDENTIAL_HELP.get(cx)),
            );
        }
        let busy = self.key_action.is_some();
        let help = h_flex()
            .flex_wrap()
            .gap_1()
            .text_xs()
            .text_color(muted)
            .child(copy::SAVED_KEY_HELP.get(cx))
            .child(
                div()
                    .id("web-search-tavily-link")
                    .test_support()
                    .text_color(cx.maka().primary)
                    .cursor_pointer()
                    .child(copy::TAVILY_SITE)
                    .on_click(|_, _, cx| cx.open_url(copy::TAVILY_URL)),
            );
        let key = FieldBlock::new("web-search-key")
            .field(
                copy::KEY.get(cx),
                Input::new(&self.key)
                    .field_fill(cx)
                    .id("web-search-key-field")
                    .aria_label(copy::KEY.get(cx))
                    .mask_toggle()
                    .disabled(busy || !editable),
            )
            .status(self.credential_error.clone().map(|error| {
                let reason = failure(locale, settings_copy::GENERAL_LOAD_FAILED.get(cx), &error);
                StatusLine::error("web-search-key", reason)
            }));
        let draft = !self.draft_key(cx).is_empty();
        let label = |action: KeyAction, idle: Text, running: Text| {
            if self.key_action == Some(action) { running } else { idle }
        };
        let save = control_button(Button::new("web-search-save-key").primary())
            .label(label(KeyAction::Save, copy::SAVE_KEY, copy::SAVING).get(cx))
            .loading(self.key_action == Some(KeyAction::Save))
            .disabled(busy || !draft || !editable)
            .on_click(cx.listener(|this, _, window, cx| this.save_key(window, cx)));
        let test = settings_button(
            "web-search-test-key",
            label(KeyAction::Test, copy::TEST_KEY, copy::TESTING).get(cx),
            cx,
        )
        .loading(self.key_action == Some(KeyAction::Test))
        .disabled(busy || (!draft && !self.key_saved()) || !self.host.read(cx).is_connected())
        .on_click(cx.listener(|this, _, window, cx| this.test_key(window, cx)));
        let clear = self.key_saved().then(|| {
            quiet_button(Button::new("web-search-clear-key"), cx)
                .label(label(KeyAction::Clear, copy::CLEAR_KEY, copy::CLEARING).get(cx))
                .loading(self.key_action == Some(KeyAction::Clear))
                .disabled(busy || !editable)
                .on_click(cx.listener(|this, _, window, cx| this.clear_key(window, cx)))
        });
        let feedback = self
            .feedback
            .clone()
            .map(|(kind, line)| StatusLine::new("web-search-key-action", kind, line));
        group.field(key.help_element(help)).child(
            v_flex()
                .id("web-search-key-actions")
                .test_support()
                .aria_label(copy::ACTIONS.get(cx))
                .w_full()
                .child(ActionRow::new("web-search-key").child(save).child(test).children(clear))
                .children(feedback.map(|line| div().pb_2().child(line))),
        )
    }

    fn render_query(&self, cx: &mut Context<Self>) -> AnyElement {
        let locale = Locale::current(cx);
        let running = matches!(self.live, LiveQuery::Running(_));
        let blocked = self.query_blocked(cx);
        let field = FieldBlock::new("web-search-query")
            .field(
                copy::TEST_SEARCH.get(cx),
                Input::new(&self.query)
                    .field_fill(cx)
                    .id("web-search-query-field")
                    .aria_label(copy::TEST_SEARCH.get(cx)),
            )
            .help(copy::TEST_SEARCH_HELP.get(cx));
        let search = control_button(Button::new("web-search-search").primary())
            .label(if running { copy::SEARCHING } else { copy::SEARCH }.get(cx))
            .loading(running)
            .disabled(running || blocked.is_some())
            .on_click(cx.listener(|this, _, window, cx| this.run_query(window, cx)));
        let muted = cx.maka().ink_muted;
        let reason = (!running).then_some(blocked).flatten().map(|reason| {
            div()
                .id("web-search-query-blocked")
                .test_support()
                .aria_label(reason.get(cx))
                .text_xs()
                .text_color(muted)
                .child(reason.get(cx))
        });
        let results: Option<AnyElement> = match &self.live {
            LiveQuery::Failed(error) => Some(
                StatusLine::error("web-search-query", copy::query_failed(locale, error))
                    .into_any_element(),
            ),
            LiveQuery::Found(rows) if rows.is_empty() => Some(
                div()
                    .id("web-search-no-results")
                    .test_support()
                    .text_sm()
                    .text_color(muted)
                    .child(copy::NO_RESULTS.get(cx))
                    .into_any_element(),
            ),
            LiveQuery::Found(rows) => Some(self.render_results(rows, cx)),
            _ => None,
        };
        v_flex()
            .w_full()
            .gap_3()
            .child(
                SettingsGroup::new("search-behavior")
                    .title(copy::SEARCH_BEHAVIOR.get(cx))
                    .description(copy::SEARCH_BEHAVIOR_HELP.get(cx))
                    .child(field)
                    .child(
                        ActionRow::new("web-search-query")
                            .child(h_flex().items_center().gap_3().child(search).children(reason)),
                    ),
            )
            .children(results)
            .into_any_element()
    }

    fn render_results(&self, rows: &[WebSearchResultRow], cx: &mut Context<Self>) -> AnyElement {
        let maka = cx.maka();
        let items = rows.iter().enumerate().map(|(ix, row)| {
            let url = row.url.clone();
            v_flex()
                .id(("web-search-result", ix))
                .test_support()
                .aria_label(SharedString::from(row.title.clone()))
                .w_full()
                .gap_0p5()
                .py_2()
                .child(
                    div()
                        .id(("web-search-result-link", ix))
                        .text_sm()
                        .font_weight(gpui_kit::FontWeight::MEDIUM)
                        .text_color(maka.primary)
                        .cursor_pointer()
                        .child(row.title.clone())
                        .on_click(move |_, _, cx| cx.open_url(&url)),
                )
                .child(div().text_xs().text_color(maka.ink_muted).child(row.source.clone()))
                .child(
                    div()
                        .text_sm()
                        .line_height(rems(1.25))
                        .text_color(maka.ink)
                        .child(row.snippet.clone()),
                )
        });
        v_flex()
            .id("web-search-results")
            .test_support()
            .aria_label(copy::RESULTS_LABEL.get(cx))
            .w_full()
            .children(items)
            .into_any_element()
    }
}

impl Render for WebSearchPage {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let status = policy_status(PAGE_KEY, &self.host, &self.policy, cx);
        let connected = self.host.read(cx).is_connected();
        let (web, loading) = {
            let policy = self.policy.read(cx);
            (policy.policy().map(|policy| policy.web_search.clone()), policy.load_error().is_none())
        };
        let Some(web) = web else {
            let group = SettingsGroup::new("search-provider").title(copy::SEARCH_PROVIDER.get(cx));
            let placeholder = (connected && loading).then(|| {
                SettingsRow::loading("web-search-provider", copy::PROVIDER.get(cx), 8., cx)
            });
            return v_flex().w_full().gap_8().children(status).child(group.children(placeholder));
        };
        let editable = connected && !self.policy_saving && !self.policy.read(cx).is_saving();
        let provider = self.render_provider(&web, editable, cx);
        let query =
            (web.default_provider != WebSearchProvider::Model).then(|| self.render_query(cx));
        v_flex().w_full().gap_8().children(status).child(provider).children(query)
    }
}

/// The Tavily key's status: `None` when the Host answers a kind this
/// client does not know.
async fn query_status(
    requester: &HostRequester,
) -> Result<Option<CredentialStatus>, HostRequestError> {
    let input = CredentialVaultQueryInput::new(tavily_locator());
    Ok(match requester.request::<CredentialVaultQuery>(&input).await? {
        CredentialVaultQueryResult::Status { status } => Some(status),
        _ => None,
    })
}

/// Saves `secret` as the Tavily key over the one saved, reading its status
/// again after a stale write (Desktop's `setCredential`). Returns the new
/// status, or why not in words.
async fn set_key(
    requester: &HostRequester,
    secret: &str,
    locale: Locale,
) -> Result<CredentialStatus, String> {
    let reason = |error: HostRequestError| host_error_reason(&error, locale);
    for _ in 0..CREDENTIAL_ATTEMPTS {
        let current = query_status(requester).await.map_err(reason)?;
        let basis = current.as_ref().and_then(CredentialStatus::basis);
        let input = CredentialVaultSetInput::new(tavily_locator(), basis.as_ref(), secret);
        match requester.request::<CredentialVaultSet>(&input).await.map_err(reason)? {
            CredentialMutationResult::Committed { status, .. } => return Ok(status),
            CredentialMutationResult::CredentialStale { .. } => continue,
            _ => return Err(settings_copy::UNEXPECTED.in_locale(locale).to_owned()),
        }
    }
    Err(settings_copy::POLICY_KEPT_CHANGING.in_locale(locale).to_owned())
}

/// Deletes the saved Tavily key, reading its status again after a stale
/// write (Desktop's `deleteCredential`). Returns the status after.
async fn delete_key(
    requester: &HostRequester,
    locale: Locale,
) -> Result<Option<CredentialStatus>, String> {
    let reason = |error: HostRequestError| host_error_reason(&error, locale);
    for _ in 0..CREDENTIAL_ATTEMPTS {
        let current = query_status(requester).await.map_err(reason)?;
        let Some(basis) = current.as_ref().and_then(CredentialStatus::basis) else {
            return Ok(current);
        };
        let input = CredentialVaultDeleteInput::new(basis);
        match requester.request::<CredentialVaultDelete>(&input).await.map_err(reason)? {
            CredentialMutationResult::Committed { status, .. } => return Ok(Some(status)),
            CredentialMutationResult::CredentialStale { .. } => continue,
            _ => return Err(settings_copy::UNEXPECTED.in_locale(locale).to_owned()),
        }
    }
    Err(settings_copy::POLICY_KEPT_CHANGING.in_locale(locale).to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_status_reads_as_desktops() {
        let tavily = WebSearchProvider::Tavily;
        assert_eq!(
            key_status(&tavily, true, false, None),
            (copy::STATUS_NOT_CONFIGURED, Tone::Attention)
        );
        assert_eq!(
            key_status(&tavily, false, true, None),
            (copy::STATUS_UNTESTED, Tone::Attention)
        );
        assert_eq!(
            key_status(&tavily, true, true, None),
            (copy::STATUS_UNKNOWN_ENABLED, Tone::Attention)
        );
        assert_eq!(
            key_status(&tavily, true, true, Some(KeyCheck::Valid)),
            (copy::STATUS_VALID_ENABLED, Tone::Success)
        );
        assert_eq!(
            key_status(&tavily, false, true, Some(KeyCheck::Valid)),
            (copy::STATUS_VALID_DISABLED, Tone::Neutral)
        );
        assert_eq!(
            key_status(&tavily, true, true, Some(KeyCheck::InvalidCredentials)),
            (copy::STATUS_INVALID_CREDENTIALS, Tone::Error)
        );
        let model = WebSearchProvider::Model;
        assert_eq!(
            key_status(&model, true, false, None),
            (copy::STATUS_MODEL_ENABLED, Tone::Success)
        );
        assert_eq!(
            key_status(&model, false, true, None),
            (copy::STATUS_MODEL_DISABLED, Tone::Attention)
        );
        assert_eq!(KeyCheck::of(&WebSearchErrorReason::IncognitoActive), KeyCheck::NetworkError);
    }

    #[test]
    fn only_web_links_are_shown() {
        let row = |url: &str| -> WebSearchResultRow {
            serde_json::from_value(serde_json::json!({"provider": "tavily", "title": "t",
                "url": url, "snippet": "", "source": "s"}))
            .expect("row")
        };
        let kept = safe_rows(vec![
            row("https://a.dev/"),
            row("javascript:alert(1)"),
            row("HTTP://B.DEV"),
            row("file:///etc/passwd"),
        ]);
        let urls: Vec<_> = kept.iter().map(|row| row.url.as_str()).collect();
        assert_eq!(urls, ["https://a.dev/", "HTTP://B.DEV"]);
    }
}
