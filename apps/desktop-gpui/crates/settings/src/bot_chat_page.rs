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

//! The Remote access page (Desktop's `bot-chat`), after Maka Desktop's
//! (bot-chat-settings-page.tsx, bot-chat-overview.tsx, bot-chat-detail.tsx,
//! bot-wechat-login.tsx): the platforms in use and the ones to connect, and
//! a platform's detail with its state, its listener, the actions (test,
//! test and connect, restart the listener, QR setup), and its credentials.
//!
//! Everything goes through the window's [`BotService`]. The page reads a
//! channel as a [`ChannelSummary`] and the listener's [`ChannelStatus`], and
//! never holds a secret: a secret field shows only whether one is saved,
//! and what is typed there replaces it once committed (Enter, or leaving
//! the field) and leaves the field. The other fields save the same way; the
//! switch and the domain as they change. What an action found is the line
//! under the actions, where Desktop shows a toast.
//!
//! While the page has shown, the service keeps the bot runtime running, so
//! a channel can be tested before it is enabled; the actions that need it
//! wait for it and say why.

use std::collections::HashMap;

use bots::{
    BotProvider, BotReadiness, BotService, BotServiceError, BotServiceEvent, BotServiceState,
    BotTestResult, ChannelStatus, ChannelSummary, MAX_ALLOWED_USER_IDS, OnboardingBrand,
    OnboardingSnapshot, parse_allowed_user_ids,
};
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{InputEvent, Textarea, TextareaState};
use gpui_kit::component::select::{Select, SelectEvent};
use gpui_kit::component::switch::Switch;
use gpui_kit::component::{Disableable as _, Icon, Sizable as _, WindowExt as _, h_flex, v_flex};
use gpui_kit::{
    AnyElement, App, AppContext as _, Context, Entity, FontWeight, InteractiveElement as _,
    IntoElement, ParentElement as _, Render, Role, SharedString, StatefulInteractiveElement as _,
    Styled as _, Subscription, Task, TestSupportExt as _, Window, div, prelude::FluentBuilder as _,
    rems,
};
use shared::copy::bots as copy;
use shared::copy::{Locale, Text};
use shared::domain_element_id;
use shared::icons::MakaIcon;
use shared::theme::FadedSwitch;
use shared::theme::FieldFill as _;
use shared::theme::{
    ActiveMakaPalette as _, BODY_TEXT_REMS, HEADING_LINE_REMS, HEADING_TEXT_REMS, RADIUS_SURFACE,
    back_link, control_button, disclosure, floating_surface, quiet_button, segment,
    segmented_track, text_link,
};

use crate::bot_chat_view::{
    self as view, FieldKey, FormLine, Placeholder, Support, ViewState, can_enable, help, label,
    status_detail, support, view_state,
};
use crate::bot_onboarding::{BridgeQrDialog, OnboardingDialog, OnboardingEvent};
use crate::page_kit::{Tone, ago, status_dot, titled, warning_line};
use crate::rows::{
    Choice, ChoiceSelect, EmptyRow, FieldBlock, SettingsGroup, SettingsRow, StatusKind, StatusLine,
    TextSetting, TextSettingEvent, list_row, settings_button, sync_choices,
};

/// Feishu's two account domains.
const FEISHU_DOMAIN: &str = "feishu.cn";
const LARK_DOMAIN: &str = "larksuite.com";

/// The iLink base URL a WeChat QR sign-in saves as the bridge address.
const ILINK_ORIGIN: &str = "https://ilinkai.weixin.qq.com";

/// The widest the onboarding dialog grows: Desktop's 480px.
const DIALOG_WIDTH_REMS: f32 = 34.;

/// An action on a platform, one at a time (Desktop's `BotPendingActionName`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BotAction {
    Test,
    Connect,
    Restart,
    Disconnect,
}

/// What the last action found, on the platform it was for.
#[derive(Debug, Clone, PartialEq)]
struct Feedback {
    provider: BotProvider,
    kind: StatusKind,
    line: SharedString,
}

/// A place a screenshot asks for that needs the bot runtime running.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Reveal {
    Scan,
    Bridge,
}

/// Behavior and presentation owner of the Remote access page.
pub struct BotChatPage {
    bots: Option<Entity<BotService>>,
    /// The platform whose detail shows; the overview when `None`.
    detail: Option<BotProvider>,
    /// The detail's credential fields, made when it opens.
    fields: Vec<(FieldKey, Entity<TextSetting>)>,
    domain: Entity<ChoiceSelect<String>>,
    allowed: Entity<TextareaState>,
    /// The allowlist as typed, parsed.
    allowed_ids: Vec<String>,
    /// Quick (QR) setup rather than manual, for a platform that has both.
    quick: bool,
    /// Feishu's quick setup signs in on Lark.
    lark: bool,
    wechat_advanced: bool,
    /// "Disconnect WeChat" asked, waiting for its answer.
    confirm_disconnect: bool,
    pending: Option<(BotProvider, BotAction)>,
    /// Field saves in flight.
    saving: usize,
    feedback: Option<Feedback>,
    /// Why a field's last save failed, by field.
    errors: HashMap<FieldKey, SharedString>,
    onboarding: Option<(Entity<OnboardingDialog>, Subscription)>,
    bridge: Option<Entity<BridgeQrDialog>>,
    /// Whether the page keeps the bot runtime running.
    held: bool,
    reveal: Option<Reveal>,
    utc_offset: i32,
    tasks: Vec<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl std::fmt::Debug for BotChatPage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BotChatPage")
            .field("detail", &self.detail)
            .field("pending", &self.pending)
            .field("feedback", &self.feedback)
            .finish_non_exhaustive()
    }
}

fn domain_choices(locale: Locale) -> Vec<Choice<String>> {
    vec![
        Choice::new(FEISHU_DOMAIN.to_owned(), copy::FEISHU_OPTION.in_locale(locale)),
        Choice::new(LARK_DOMAIN.to_owned(), copy::LARK_OPTION.in_locale(locale)),
    ]
}

impl BotChatPage {
    /// The page over `bots`, the window's chat bots (none in a window that
    /// has none, where the page says so).
    pub fn new(
        bots: Option<Entity<BotService>>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let locale = Locale::current(cx);
        let domain = cx.new(|cx| ChoiceSelect::new(domain_choices(locale), None, window, cx));
        let allowed = cx.new(|cx| {
            TextareaState::new(window, cx)
                .auto_grow(3, 6)
                .placeholder(copy::ALLOWED_USERS_PLACEHOLDER.in_locale(locale))
        });
        let mut subscriptions = vec![
            cx.subscribe_in(
                &domain,
                window,
                |this, _, event: &SelectEvent<Vec<Choice<String>>>, window, cx| {
                    if let SelectEvent::Confirm(Some(domain)) = event {
                        this.set_domain(domain.clone(), window, cx);
                    }
                },
            ),
            cx.subscribe_in(&allowed, window, |this, allowed, event: &InputEvent, window, cx| {
                match event {
                    InputEvent::Change => {
                        this.allowed_ids = parse_allowed_user_ids(&allowed.read(cx).value());
                        cx.notify();
                    }
                    InputEvent::Blur => this.commit_allowed(window, cx),
                    _ => {}
                }
            }),
            cx.observe_global_in::<Locale>(window, |this, window, cx| {
                let locale = Locale::current(cx);
                let placeholder = copy::ALLOWED_USERS_PLACEHOLDER.in_locale(locale);
                this.allowed.update(cx, |input, cx| input.set_placeholder(placeholder, window, cx));
                this.utc_offset = shared::time::local_utc_offset();
                this.sync_fields(window, cx);
            }),
        ];
        if let Some(bots) = &bots {
            subscriptions.push(cx.subscribe_in(
                bots,
                window,
                |this, bots, event: &BotServiceEvent, window, cx| {
                    match event {
                        BotServiceEvent::SettingsChanged => this.sync_fields(window, cx),
                        BotServiceEvent::StateChanged if bots.read(cx).is_running() => {
                            this.open_revealed(window, cx);
                        }
                        _ => {}
                    }
                    cx.notify();
                },
            ));
        }
        cx.on_release(|this, cx| {
            if this.held
                && let Some(bots) = &this.bots
            {
                bots.update(cx, |bots, cx| bots.release(cx));
            }
        })
        .detach();
        Self {
            bots,
            detail: None,
            fields: Vec::new(),
            domain,
            allowed,
            allowed_ids: Vec::new(),
            quick: true,
            lark: false,
            wechat_advanced: false,
            confirm_disconnect: false,
            pending: None,
            saving: 0,
            feedback: None,
            errors: HashMap::new(),
            onboarding: None,
            bridge: None,
            held: false,
            reveal: None,
            utc_offset: shared::time::local_utc_offset(),
            tasks: Vec::new(),
            _subscriptions: subscriptions,
        }
    }

    /// The page shows: the bot runtime runs from now on, while settings
    /// show.
    pub fn activate(&mut self, cx: &mut Context<Self>) {
        if !self.held
            && let Some(bots) = &self.bots
        {
            self.held = true;
            bots.update(cx, |bots, cx| bots.hold(cx));
        }
    }

    /// The platform whose detail shows.
    pub fn detail(&self) -> Option<BotProvider> {
        self.detail
    }

    /// The text field of `key` in the detail shown.
    pub fn field(&self, key: &str) -> Option<&Entity<TextSetting>> {
        self.fields.iter().find(|(field, _)| field.key() == key).map(|(_, setting)| setting)
    }

    pub fn allowed_input(&self) -> &Entity<TextareaState> {
        &self.allowed
    }

    /// The QR onboarding dialog, while it shows.
    #[cfg(test)]
    pub(crate) fn onboarding(&self) -> Option<&Entity<OnboardingDialog>> {
        self.onboarding.as_ref().map(|(dialog, _)| dialog)
    }

    /// The action in flight.
    #[cfg(test)]
    pub(crate) fn pending(&self) -> Option<(BotProvider, BotAction)> {
        self.pending
    }

    /// Whether a change is unanswered: leaving would hide its outcome.
    pub fn is_busy(&self) -> bool {
        self.saving > 0 || self.pending.is_some()
    }

    /// Opens a place inside the page (`--open-settings bot-chat:<target>`):
    /// `<provider>` its detail, then `manual` its manual setup, `lark`
    /// Feishu's Lark sign-in, `scan` the QR setup and `bridge` WeChat's
    /// local bridge code (both once the bot runtime runs).
    pub fn reveal(&mut self, target: &[&str], window: &mut Window, cx: &mut Context<Self>) -> bool {
        let Some((provider, rest)) = target.split_first() else {
            return false;
        };
        let Some(provider) = BotProvider::from_name(provider) else {
            return false;
        };
        self.open_detail(provider, window, cx);
        for flag in rest {
            match *flag {
                "manual" if provider.has_onboarding() => self.quick = false,
                "lark" if provider == BotProvider::Feishu => self.lark = true,
                "scan" if provider.has_onboarding() => self.reveal = Some(Reveal::Scan),
                "bridge" if provider == BotProvider::Wechat => self.reveal = Some(Reveal::Bridge),
                _ => return false,
            }
        }
        if self.running(cx) {
            self.open_revealed(window, cx);
        }
        cx.notify();
        true
    }

    fn open_revealed(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(provider) = self.detail else {
            return;
        };
        match self.reveal.take() {
            Some(Reveal::Scan) => self.open_onboarding(provider, window, cx),
            Some(Reveal::Bridge) => self.open_bridge(window, cx),
            None => {}
        }
    }

    fn running(&self, cx: &App) -> bool {
        self.bots.as_ref().is_some_and(|bots| bots.read(cx).is_running())
    }

    fn channel(&self, provider: BotProvider, cx: &App) -> Option<ChannelSummary> {
        self.bots.as_ref()?.read(cx).channel(provider)
    }

    fn status(&self, provider: BotProvider, cx: &App) -> Option<ChannelStatus> {
        self.bots.as_ref()?.read(cx).channel_status(provider).cloned()
    }

    /// Shows `provider`'s detail with its fields.
    pub fn open_detail(
        &mut self,
        provider: BotProvider,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.detail == Some(provider) {
            return;
        }
        let channel = self.channel(provider, cx);
        self.detail = Some(provider);
        // Desktop starts every platform on quick setup.
        self.quick = true;
        self.lark = channel.as_ref().and_then(|c| c.domain.as_deref()) == Some(LARK_DOMAIN);
        self.wechat_advanced = channel.as_ref().is_some_and(|channel| {
            !channel.app_id.is_empty() || channel.has_app_secret || !channel.webhook_url.is_empty()
        });
        self.confirm_disconnect = false;
        self.errors.clear();
        self.feedback = None;
        self.fields = view::fields(provider)
            .into_iter()
            .map(|key| {
                let label = field_label(provider, key);
                let setting = cx.new(|cx| TextSetting::new(label, "", window, cx));
                if key.is_secret() {
                    setting.update(cx, |setting, cx| {
                        setting.input().update(cx, |input, cx| input.set_masked(true, window, cx));
                    });
                }
                let subscription = cx.subscribe_in(
                    &setting,
                    window,
                    move |this, _, event: &TextSettingEvent, window, cx| {
                        let TextSettingEvent::Committed(value) = event;
                        this.commit_field(key, value.clone(), window, cx);
                    },
                );
                self._subscriptions.push(subscription);
                (key, setting)
            })
            .collect();
        let ids = channel.map(|channel| channel.allowed_user_ids.join("\n")).unwrap_or_default();
        self.allowed.update(cx, |input, cx| input.set_value(ids, window, cx));
        self.allowed_ids = parse_allowed_user_ids(&self.allowed.read(cx).value());
        self.sync_fields(window, cx);
        cx.notify();
    }

    /// Back to the overview, unless an action is in flight.
    pub fn back(&mut self, cx: &mut Context<Self>) {
        if self.pending.is_some() {
            return;
        }
        self.detail = None;
        self.fields.clear();
        self.reveal = None;
        cx.notify();
    }

    /// Brings the fields up to the saved channel: a plain one shows its
    /// value (unless being edited), a secret one says whether it is saved.
    fn sync_fields(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(provider) = self.detail else {
            return;
        };
        let locale = Locale::current(cx);
        let channel = self.channel(provider, cx);
        let editable = channel.is_some();
        for (key, setting) in &self.fields {
            let placeholder = field_placeholder(provider, *key, locale);
            setting.update(cx, |setting, cx| {
                match channel.as_ref() {
                    Some(channel) if key.is_secret() => {
                        let placeholder = if key.is_saved(channel) {
                            copy::SECRET_SAVED.in_locale(locale).to_owned()
                        } else {
                            placeholder
                        };
                        setting.set_placeholder(placeholder, window, cx);
                    }
                    Some(channel) => {
                        setting.set_committed(key.value(channel).unwrap_or_default(), window, cx);
                        setting.set_placeholder(placeholder, window, cx);
                    }
                    None => setting.set_placeholder(placeholder, window, cx),
                }
                setting.set_disabled(!editable, cx);
            });
        }
        let domain = channel.and_then(|channel| channel.domain).unwrap_or(FEISHU_DOMAIN.to_owned());
        sync_choices(&self.domain, domain_choices(locale), Some(&domain), window, cx);
        cx.notify();
    }

    /// Saves `change` to `provider`'s channel; a refusal says why on the
    /// line under the actions (or under `field`, and puts its value back).
    fn save(
        &mut self,
        provider: BotProvider,
        field: Option<FieldKey>,
        change: impl FnOnce(&mut bots::BotChannelSettings) + Send + 'static,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(bots) = self.bots.clone() else {
            return;
        };
        let locale = Locale::current(cx);
        let task = bots.update(cx, |bots, cx| bots.update_channel(provider, change, cx));
        if let Some(field) = field {
            self.errors.remove(&field);
        }
        self.saving += 1;
        let task = cx.spawn_in(window, async move |this, cx| {
            let result = task.await;
            let _ = this.update_in(cx, |this, window, cx| {
                this.saving = this.saving.saturating_sub(1);
                if let Err(error) = result {
                    let name = label(provider).in_locale(locale);
                    let title = copy::named(copy::SAVE_FAILED, locale, name);
                    let line: SharedString = titled(locale, &title, &error.to_string()).into();
                    match field {
                        Some(field) => {
                            this.errors.insert(field, line);
                        }
                        None => this.set_feedback(provider, StatusKind::Error, line),
                    }
                    this.sync_fields(window, cx);
                }
                cx.notify();
            });
        });
        self.tasks.push(task);
        cx.notify();
    }

    fn commit_field(
        &mut self,
        key: FieldKey,
        value: SharedString,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(provider) = self.detail else {
            return;
        };
        let value = value.trim().to_owned();
        if key.is_secret() {
            // The secret leaves the field for the file whatever happens; a
            // refused one is typed again.
            if let Some((_, setting)) = self.fields.iter().find(|(field, _)| *field == key) {
                setting.update(cx, |setting, cx| setting.clear(window, cx));
            }
            if value.is_empty() {
                return;
            }
        }
        self.save(
            provider,
            Some(key),
            move |channel| match key {
                FieldKey::Token => channel.token = value,
                FieldKey::ProxyUrl => channel.proxy_url = value,
                FieldKey::AppId => channel.app_id = Some(value).filter(|v| !v.is_empty()),
                FieldKey::AppSecret => channel.app_secret = Some(value),
                FieldKey::WebhookUrl => channel.webhook_url = Some(value).filter(|v| !v.is_empty()),
            },
            window,
            cx,
        );
    }

    fn set_domain(&mut self, domain: String, window: &mut Window, cx: &mut Context<Self>) {
        let Some(provider) = self.detail.filter(|provider| *provider == BotProvider::Feishu) else {
            return;
        };
        if self.channel(provider, cx).and_then(|channel| channel.domain).as_deref() == Some(&domain)
        {
            return;
        }
        self.lark = domain == LARK_DOMAIN;
        self.save(provider, None, move |channel| channel.domain = Some(domain), window, cx);
    }

    /// The allowlist left its field: saved when it changed (an empty one is
    /// no restriction).
    fn commit_allowed(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(provider) = self.detail.filter(|provider| *provider == BotProvider::Telegram)
        else {
            return;
        };
        let saved = self.channel(provider, cx).map(|channel| channel.allowed_user_ids);
        if saved.as_ref() == Some(&self.allowed_ids) {
            return;
        }
        let ids = self.allowed_ids.clone();
        self.save(
            provider,
            None,
            move |channel| channel.allowed_user_ids = (!ids.is_empty()).then_some(ids),
            window,
            cx,
        );
    }

    fn set_enabled(
        &mut self,
        provider: BotProvider,
        on: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.save(provider, None, move |channel| channel.enabled = on, window, cx);
    }

    fn set_feedback(
        &mut self,
        provider: BotProvider,
        kind: StatusKind,
        line: impl Into<SharedString>,
    ) {
        self.feedback = Some(Feedback { provider, kind, line: line.into() });
    }

    /// Starts `action` on `provider` unless one runs (`beginBotAction`).
    fn begin(&mut self, provider: BotProvider, action: BotAction, cx: &mut Context<Self>) -> bool {
        if self.pending.is_some() || self.bots.is_none() {
            return false;
        }
        self.pending = Some((provider, action));
        self.feedback = None;
        cx.notify();
        true
    }

    fn finish(&mut self, cx: &mut Context<Self>) {
        self.pending = None;
        cx.notify();
    }

    /// What a test found, as Desktop's toast says it.
    fn tested(
        &mut self,
        provider: BotProvider,
        result: &Result<BotTestResult, BotServiceError>,
        locale: Locale,
    ) {
        let name = label(provider).in_locale(locale);
        let (kind, title, detail) = match result {
            Ok(result) if result.ok => (
                StatusKind::Info,
                copy::named(copy::CREDENTIAL_VERIFIED, locale, name),
                view::test_message(result, locale),
            ),
            Ok(result) => (
                StatusKind::Error,
                copy::named(copy::CREDENTIAL_TEST_FAILED, locale, name),
                view::test_message(result, locale),
            ),
            Err(error) => {
                (StatusKind::Error, copy::named(copy::TEST_ERROR, locale, name), error.to_string())
            }
        };
        self.set_feedback(provider, kind, titled(locale, &title, &detail));
    }

    /// Tests the saved credentials (`testChannel`).
    fn test(&mut self, provider: BotProvider, cx: &mut Context<Self>) {
        let Some(bots) = self.bots.clone() else {
            return;
        };
        if !self.begin(provider, BotAction::Test, cx) {
            return;
        }
        let locale = Locale::current(cx);
        let task = bots.update(cx, |bots, cx| bots.test_channel(provider, cx));
        self.tasks.push(cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.tested(provider, &result, locale);
                this.finish(cx);
            });
        }));
    }

    /// Tests, and once the credentials pass, enables the channel and starts
    /// its listener (`testAndConnect`).
    fn connect(&mut self, provider: BotProvider, cx: &mut Context<Self>) {
        let Some(bots) = self.bots.clone() else {
            return;
        };
        if !self.begin(provider, BotAction::Connect, cx) {
            return;
        }
        let locale = Locale::current(cx);
        let test = bots.update(cx, |bots, cx| bots.test_channel(provider, cx));
        self.tasks.push(cx.spawn(async move |this, cx| {
            let result = test.await;
            let passed = result.as_ref().is_ok_and(|result| result.ok);
            let _ = this.update(cx, |this, _| this.tested(provider, &result, locale));
            if !passed || support(provider) != Support::Runtime {
                let _ = this.update(cx, |this, cx| this.finish(cx));
                return;
            }
            let enabled = bots.read_with(cx, |bots, _| {
                bots.channel(provider).is_some_and(|channel| channel.enabled)
            });
            if !enabled {
                let enable = bots.update(cx, |bots, cx| {
                    bots.update_channel(provider, |channel| channel.enabled = true, cx)
                });
                if let Err(error) = enable.await {
                    let _ = this.update(cx, |this, cx| {
                        let name = label(provider).in_locale(locale);
                        let title = copy::named(copy::SAVE_FAILED, locale, name);
                        this.set_feedback(
                            provider,
                            StatusKind::Error,
                            titled(locale, &title, &error.to_string()),
                        );
                        this.finish(cx);
                    });
                    return;
                }
            }
            let restart = bots.update(cx, |bots, cx| bots.restart_channel(provider, cx));
            let restarted = restart.await;
            let _ = this.update(cx, |this, cx| {
                this.restarted(provider, restarted, locale);
                this.finish(cx);
            });
        }));
    }

    /// Restarts the listener (`restartChannel`).
    fn restart(&mut self, provider: BotProvider, cx: &mut Context<Self>) {
        let Some(bots) = self.bots.clone() else {
            return;
        };
        if !self.begin(provider, BotAction::Restart, cx) {
            return;
        }
        let locale = Locale::current(cx);
        let task = bots.update(cx, |bots, cx| bots.restart_channel(provider, cx));
        self.tasks.push(cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.restarted(provider, result, locale);
                this.finish(cx);
            });
        }));
    }

    /// What a restart found: listening or not, by the listener's own state
    /// (`restartBotProvider`).
    fn restarted(
        &mut self,
        provider: BotProvider,
        result: Result<Option<ChannelStatus>, BotServiceError>,
        locale: Locale,
    ) {
        let name = label(provider).in_locale(locale);
        let (kind, title, detail) = match result {
            Ok(Some(status)) if status.status.running => (
                StatusKind::Info,
                copy::named(copy::NOW_LISTENING, locale, name),
                status_detail(&status.status, locale),
            ),
            Ok(status) => (
                StatusKind::Error,
                copy::named(copy::NOT_LISTENING, locale, name),
                status.map_or_else(
                    || copy::STATUS_DETAILS_IN_LOGS.in_locale(locale).to_owned(),
                    |status| status_detail(&status.status, locale),
                ),
            ),
            Err(error) => (
                StatusKind::Error,
                copy::named(copy::START_FAILED, locale, name),
                error.to_string(),
            ),
        };
        self.set_feedback(provider, kind, titled(locale, &title, &detail));
    }

    /// Clears WeChat's saved sign-in, once confirmed
    /// (`disconnectLinkedSession`).
    fn disconnect_wechat(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let provider = BotProvider::Wechat;
        let Some(bots) = self.bots.clone() else {
            return;
        };
        if !self.begin(provider, BotAction::Disconnect, cx) {
            return;
        }
        self.confirm_disconnect = false;
        let locale = Locale::current(cx);
        let task = bots.update(cx, |bots, cx| {
            bots.update_channel(
                provider,
                |channel| {
                    let ilink = channel
                        .webhook_url
                        .as_deref()
                        .is_some_and(|url| url.trim().starts_with(ILINK_ORIGIN));
                    channel.token.clear();
                    if ilink {
                        channel.webhook_url = Some(String::new());
                    }
                    channel.bot_user_id = None;
                    channel.connected = false;
                    channel.readiness = Some(BotReadiness::Scaffolded);
                    channel.readiness_reason = None;
                    channel.readiness_updated_at = Some(unix_millis());
                    channel.last_error = None;
                },
                cx,
            )
        });
        self.tasks.push(cx.spawn_in(window, async move |this, cx| {
            let result = task.await;
            let _ = this.update_in(cx, |this, window, cx| {
                let line = match result {
                    Ok(()) => (
                        StatusKind::Info,
                        titled(
                            locale,
                            copy::DISCONNECTED.in_locale(locale),
                            copy::CREDENTIALS_CLEARED.in_locale(locale),
                        ),
                    ),
                    Err(error) => {
                        let name = label(provider).in_locale(locale);
                        let title = copy::named(copy::SAVE_FAILED, locale, name);
                        (StatusKind::Error, titled(locale, &title, &error.to_string()))
                    }
                };
                this.set_feedback(provider, line.0, line.1);
                this.sync_fields(window, cx);
                this.finish(cx);
            });
        }));
    }

    /// Opens the QR setup of `provider`.
    pub fn open_onboarding(
        &mut self,
        provider: BotProvider,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(bots) = self.bots.clone() else {
            return;
        };
        if self.onboarding.is_some() || !provider.has_onboarding() {
            return;
        }
        let brand = (provider == BotProvider::Feishu).then_some(if self.lark {
            OnboardingBrand::Lark
        } else {
            OnboardingBrand::Feishu
        });
        let dialog = cx.new(|cx| OnboardingDialog::new(bots, provider, brand, cx));
        let subscription =
            cx.subscribe_in(&dialog, window, |this, _, event: &OnboardingEvent, window, cx| {
                match event {
                    OnboardingEvent::Connected(snapshot) => this.onboarded(snapshot, cx),
                    OnboardingEvent::Dismissed => this.onboarding_closed(window, cx),
                }
            });
        self.onboarding = Some((dialog.clone(), subscription));
        let page = cx.weak_entity();
        let width = window.rem_size() * DIALOG_WIDTH_REMS;
        window.open_dialog(cx, move |surface, _, cx| {
            let page = page.clone();
            let surface = floating_surface(surface, cx).w(width).on_close(move |_, window, cx| {
                page.update(cx, |this, cx| this.onboarding_closed(window, cx)).ok();
            });
            dialog.update(cx, |dialog, cx| dialog.dialog(surface, cx))
        });
        cx.notify();
    }

    fn onboarding_closed(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some((dialog, _)) = self.onboarding.take() {
            dialog.update(cx, |dialog, cx| dialog.close(window, cx));
        }
        cx.notify();
    }

    /// A scan was confirmed and saved (the modal's `onConnected`).
    fn onboarded(&mut self, snapshot: &OnboardingSnapshot, cx: &mut Context<Self>) {
        let locale = Locale::current(cx);
        let provider = snapshot.provider;
        let name = label(provider).in_locale(locale);
        let (kind, title, detail) = if snapshot.warning_code.is_some() {
            let detail = snapshot
                .warning_detail
                .as_deref()
                .map(|detail| view::reason_message(detail, locale));
            (
                StatusKind::Error,
                copy::named(copy::CREDENTIALS_SAVED, locale, name),
                copy::saved_not_connected(locale, detail.as_deref()),
            )
        } else {
            let identity = snapshot
                .identity
                .as_ref()
                .and_then(|identity| identity.display_name.clone().or(identity.id.clone()));
            (
                StatusKind::Info,
                copy::named(copy::SCAN_COMPLETE, locale, name),
                identity.unwrap_or_else(|| copy::SAVED_AND_CONNECTED.in_locale(locale).to_owned()),
            )
        };
        self.set_feedback(provider, kind, titled(locale, &title, &detail));
        cx.notify();
    }

    /// Opens the local wechat-bridge's QR sign-in.
    fn open_bridge(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(bots) = self.bots.clone() else {
            return;
        };
        if self.bridge.is_some() {
            return;
        }
        let dialog = cx.new(|cx| BridgeQrDialog::new(bots, cx));
        self.bridge = Some(dialog.clone());
        let page = cx.weak_entity();
        let width = window.rem_size() * DIALOG_WIDTH_REMS;
        window.open_dialog(cx, move |surface, _, cx| {
            let page = page.clone();
            let surface = floating_surface(surface, cx).w(width).on_close(move |_, window, cx| {
                page.update(cx, |this, cx| {
                    if let Some(dialog) = this.bridge.take() {
                        dialog.update(cx, |dialog, cx| dialog.close(window, cx));
                    }
                    // The bridge may have signed in: read the statuses again.
                    this.refresh_after_bridge(cx);
                })
                .ok();
            });
            dialog.update(cx, |dialog, cx| dialog.dialog(surface, cx))
        });
    }

    fn refresh_after_bridge(&mut self, cx: &mut Context<Self>) {
        if let Some(bots) = &self.bots {
            let task = bots.update(cx, |bots, cx| bots.restart_channel(BotProvider::Wechat, cx));
            cx.background_spawn(async move {
                let _ = task.await;
            })
            .detach();
        }
        cx.notify();
    }

    /// Why the bot runtime cannot serve the page now, with what to do;
    /// only what went wrong when `errors_only`.
    fn runtime_notice(
        &self,
        key: &'static str,
        errors_only: bool,
        cx: &mut Context<Self>,
    ) -> Option<StatusLine> {
        let locale = Locale::current(cx);
        let Some(bots) = &self.bots else {
            return Some(StatusLine::info(key, copy::RUNTIME_NOT_RUNNING.get(cx)));
        };
        let service = bots.read(cx);
        if let Some(error) = service.settings_error() {
            let line =
                shared::copy::failure(locale, copy::SETTINGS_UNREADABLE.in_locale(locale), error);
            return Some(StatusLine::error(key, line));
        }
        let retry = || {
            let bots = bots.clone();
            settings_button(domain_element_id("bot-runtime-retry", key), copy::RETRY.get(cx), cx)
                .on_click(move |_, _, cx| bots.update(cx, |bots, cx| bots.restart(cx)))
        };
        match service.state() {
            BotServiceState::Running { .. } => None,
            BotServiceState::Restarting { .. } | BotServiceState::Idle if errors_only => None,
            BotServiceState::Preparing | BotServiceState::Starting if errors_only => None,
            BotServiceState::Unavailable { held_elsewhere: true, .. } => {
                Some(StatusLine::error(key, copy::RUNTIME_HELD_ELSEWHERE.get(cx)).action(retry()))
            }
            BotServiceState::Unavailable { reason, .. } => {
                let line = shared::copy::failure(
                    locale,
                    copy::RUNTIME_UNAVAILABLE.in_locale(locale),
                    reason,
                );
                Some(StatusLine::error(key, line).action(retry()))
            }
            BotServiceState::Restarting { .. } => {
                Some(StatusLine::info(key, copy::RUNTIME_RESTARTING.get(cx)).action(retry()))
            }
            BotServiceState::Idle if !self.held => None,
            BotServiceState::Idle => Some(StatusLine::info(key, copy::RUNTIME_NOT_RUNNING.get(cx))),
            _ => Some(StatusLine::info(key, copy::RUNTIME_STARTING.get(cx))),
        }
    }

    fn render_overview(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let notice = self.runtime_notice("bot-runtime", true, cx);
        struct Row {
            provider: BotProvider,
            status: Option<ChannelStatus>,
            state: ViewState,
        }
        let rows: Vec<Row> = BotProvider::ALL
            .into_iter()
            .filter_map(|provider| {
                let channel = self.channel(provider, cx)?;
                let status = self.status(provider, cx);
                let state = view_state(&channel, status.as_ref());
                Some(Row { provider, status, state })
            })
            .collect();
        let loaded = !rows.is_empty();
        // Needing attention first, then the latest activity, then Desktop's
        // order (`BOT_PROVIDERS`, the order `rows` keeps).
        let mut active: Vec<&Row> = rows.iter().filter(|row| row.state.configured).collect();
        let last_event = |row: &Row| {
            row.status.as_ref().and_then(|status| status.status.last_event_at).unwrap_or(0)
        };
        active.sort_by(|a, b| {
            b.state
                .needs_attention
                .cmp(&a.state.needs_attention)
                .then(last_event(b).cmp(&last_event(a)))
        });
        let active_rows: Vec<AnyElement> = active
            .iter()
            .enumerate()
            .map(|(ix, row)| {
                let at = (ix, active.len());
                self.render_active_row(row.provider, row.status.as_ref(), &row.state, at, cx)
            })
            .collect();
        let available: Vec<_> = rows.iter().filter(|row| !row.state.configured).collect();
        let available_rows: Vec<AnyElement> = available
            .iter()
            .enumerate()
            .map(|(ix, row)| self.render_available_row(row.provider, (ix, available.len()), cx))
            .collect();
        let empty = (loaded && active_rows.is_empty())
            .then(|| EmptyRow::new("bot-chat-empty", copy::EMPTY.get(cx)));
        v_flex()
            .w_full()
            .gap_8()
            .children(notice)
            .child(
                SettingsGroup::new("remote-access-active")
                    .title(copy::ACTIVE.get(cx))
                    .description(copy::SORT_HINT.get(cx))
                    .children(active_rows)
                    .children(empty),
            )
            .child(
                SettingsGroup::new("remote-access-available")
                    .title(copy::MORE.get(cx))
                    .description(copy::CHOOSE.get(cx))
                    .children(available_rows),
            )
            .into_any_element()
    }

    /// A channel in use: its state, and what it last did.
    fn render_active_row(
        &self,
        provider: BotProvider,
        status: Option<&ChannelStatus>,
        state: &ViewState,
        at: (usize, usize),
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let locale = Locale::current(cx);
        let (label_text, tone) = status_label(state, status);
        let name = label(provider).in_locale(locale);
        let detail = overview_detail(status, state, locale, self.utc_offset);
        let accessible = copy::manage_label(locale, name, label_text.in_locale(locale));
        self.render_row(
            provider,
            accessible,
            Some(status_dot(provider.as_str(), label_text.get(cx), tone, cx)),
            detail,
            at,
            cx,
        )
    }

    fn render_available_row(
        &self,
        provider: BotProvider,
        at: (usize, usize),
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let locale = Locale::current(cx);
        let accessible =
            copy::named(copy::CONNECT_LABEL, locale, label(provider).in_locale(locale));
        let detail = help(provider).in_locale(locale).to_owned();
        self.render_row(provider, accessible, None, detail, at, cx)
    }

    fn render_row(
        &self,
        provider: BotProvider,
        accessible: String,
        status: Option<AnyElement>,
        detail: String,
        (ix, len): (usize, usize),
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let maka = cx.maka();
        let row = Button::new(domain_element_id("bot-channel-row", provider.as_str()))
            .ghost()
            .w_full()
            .h_auto()
            .px_0()
            .py_2p5()
            .justify_start()
            .accessibility_label(accessible)
            .child(
                h_flex()
                    .flex_1()
                    .min_w_0()
                    .gap_3()
                    .child(platform_mark(provider, false, cx))
                    .child(
                        v_flex()
                            .flex_1()
                            .min_w_0()
                            .items_start()
                            .gap_0p5()
                            .child(
                                h_flex()
                                    .gap_2()
                                    .min_w_0()
                                    .child(
                                        div()
                                            .truncate()
                                            .text_sm()
                                            .font_weight(FontWeight::MEDIUM)
                                            .text_color(maka.ink)
                                            .child(label(provider).get(cx)),
                                    )
                                    .children(status),
                            )
                            .child(
                                div()
                                    .id(domain_element_id("bot-channel-summary", provider.as_str()))
                                    .test_support()
                                    .aria_label(SharedString::from(detail.clone()))
                                    .w_full()
                                    .truncate()
                                    .text_xs()
                                    .text_color(maka.ink_muted)
                                    .child(detail),
                            ),
                    )
                    .child(Icon::new(MakaIcon::ChevronRight).small().text_color(maka.ink_muted)),
            )
            .on_click(
                cx.listener(move |this, _, window, cx| this.open_detail(provider, window, cx)),
            );
        list_row(row, ix, len).into_any_element()
    }

    fn render_detail(&mut self, provider: BotProvider, cx: &mut Context<Self>) -> AnyElement {
        let locale = Locale::current(cx);
        let maka = cx.maka();
        let channel = self.channel(provider, cx);
        let status = self.status(provider, cx);
        let running = self.running(cx);
        let busy = self.pending.is_some();
        let state = channel.as_ref().map(|channel| view_state(channel, status.as_ref()));
        let readiness = state.as_ref().map_or(BotReadiness::Scaffolded, |state| state.readiness);
        let (ready_label, ready_detail, _) = view::readiness(readiness);
        let (status_text, tone) = match &state {
            Some(state) => status_label(state, status.as_ref()),
            None => (copy::READINESS_SCAFFOLDED, Tone::Neutral),
        };
        let quick_provider = provider.has_onboarding();
        let in_quick = quick_provider && (provider == BotProvider::Wechat || self.quick);
        let enabled = channel.as_ref().is_some_and(|channel| channel.enabled);
        let hint = (!enabled && !can_enable(readiness)).then_some(if in_quick {
            copy::SCAN_FIRST_HINT
        } else {
            copy::TEST_FIRST_HINT
        });
        let name = label(provider).in_locale(locale);
        let page = cx.weak_entity();
        let switch = {
            let (checked, disabled) =
                (enabled, channel.is_none() || busy || (!enabled && !can_enable(readiness)));
            FadedSwitch::new(
                Switch::new(domain_element_id("settings-toggle", "bot-enabled"))
                    .checked(checked)
                    .disabled(disabled)
                    .accessibility_label(copy::named(copy::ENABLE_LABEL, locale, name))
                    .on_change(move |on, window, cx| {
                        page.update(cx, |page, cx| page.set_enabled(provider, *on, window, cx))
                            .ok();
                    }),
                checked,
                disabled,
            )
        };
        let docs = view::config_docs(provider).map(|url| {
            // Desktop's doc link: 14/500 in the link colour, underlined
            // only under the pointer.
            text_link(
                Button::new("bot-config-docs"),
                copy::CONFIG_DOCS_LINK.get(cx),
                maka.primary,
                rems(BODY_TEXT_REMS),
                gpui_kit::FontWeight::MEDIUM,
                cx,
            )
            .on_click(move |_, _, cx| cx.open_url(url))
        });
        let header = h_flex()
            .w_full()
            .items_start()
            .gap_3()
            .child(platform_mark(provider, true, cx))
            .child(
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .gap_0p5()
                    .child(
                        h_flex()
                            .gap_2()
                            .flex_wrap()
                            .child(
                                div()
                                    .id("bot-detail-title")
                                    .test_support()
                                    .role(Role::Heading)
                                    .aria_label(label(provider).get(cx))
                                    .text_size(rems(HEADING_TEXT_REMS))
                                    .line_height(rems(HEADING_LINE_REMS))
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .text_color(maka.ink)
                                    .child(label(provider).get(cx)),
                            )
                            .child(status_dot("bot-detail", status_text.get(cx), tone, cx)),
                    )
                    .child(div().text_sm().text_color(maka.ink_muted).child(help(provider).get(cx)))
                    .children(hint.map(|hint| {
                        div()
                            .id("bot-enable-hint")
                            .test_support()
                            .aria_label(hint.get(cx))
                            .mt_0p5()
                            .text_xs()
                            .text_color(maka.ink_muted)
                            .child(hint.get(cx))
                    }))
                    // Desktop's bot.css: the link in the body column, under
                    // the help, not under the switch.
                    .children(docs.map(|docs| h_flex().mt_2().child(docs))),
            )
            // The switch alone at the end, centred on the title's line.
            .child(
                h_flex().flex_shrink_0().h(rems(HEADING_LINE_REMS)).items_center().child(switch),
            );
        let back = back_link(
            Button::new("bot-detail-back")
                .disabled(busy)
                .on_click(cx.listener(|this, _, _, cx| this.back(cx))),
            copy::BACK.get(cx),
            cx,
        );

        let live = state.as_ref().is_some_and(|state| state.live_operational);
        let runtime = SettingsGroup::new("bot-runtime")
            .title(if live { copy::DETAIL_LISTENING } else { ready_label }.get(cx))
            .description(if live { copy::HEALTHY } else { ready_detail }.get(cx))
            .action(self.render_actions(
                provider,
                channel.as_ref(),
                status.as_ref(),
                in_quick,
                running,
                cx,
            ))
            .bare()
            .child(self.render_facts(channel.as_ref(), status.as_ref(), cx))
            .children(
                self.feedback
                    .clone()
                    .filter(|f| f.provider == provider)
                    .map(|feedback| StatusLine::new("bot-action", feedback.kind, feedback.line)),
            )
            .children(self.confirm_disconnect.then(|| self.render_disconnect(cx)));

        let mut warnings: Vec<AnyElement> = Vec::new();
        if let Some(notice) = self.runtime_notice("bot-runtime", false, cx) {
            warnings.push(notice.into_any_element());
        }
        if let Some(conflict) = status.as_ref().and_then(|status| status.conflict.as_ref()) {
            warnings.push(warning_line(
                "bot-conflict",
                view::conflict_text(conflict.kind).get(cx),
                cx,
            ));
        }
        if let (Some(status), Some(state)) = (&status, &state)
            && status.status.reason.is_some()
            && enabled
            && !state.live_operational
            && status.conflict.is_none()
        {
            let line = titled(
                locale,
                &status_detail(&status.status, locale),
                ready_detail.in_locale(locale),
            );
            warnings.push(warning_line("bot-status", line, cx));
        }
        if let Some(error) = state.as_ref().and_then(|state| state.current_error.clone()) {
            let line = titled(
                locale,
                copy::LATEST_FAILURE.in_locale(locale),
                &view::reason_message(&error, locale),
            );
            warnings.push(StatusLine::error("bot-latest-failure", line).into_any_element());
        }

        let setup = SettingsGroup::new("bot-setup")
            .title(
                if quick_provider && provider != BotProvider::Wechat {
                    copy::SETUP_METHOD
                } else {
                    copy::CONNECTION_SETTINGS
                }
                .get(cx),
            )
            .description(
                if quick_provider { copy::LOCAL_CREDENTIALS } else { copy::AUTOSAVE }.get(cx),
            )
            .bare()
            .children(self.render_setup(provider, running, cx));

        v_flex()
            .id(domain_element_id("bot-detail", provider.as_str()))
            .test_support()
            .w_full()
            .gap_6()
            .child(back)
            .child(header)
            .child(runtime)
            .children(warnings)
            .child(setup)
            .into_any_element()
    }

    /// The runtime group's buttons, as Desktop picks them.
    fn render_actions(
        &self,
        provider: BotProvider,
        channel: Option<&ChannelSummary>,
        status: Option<&ChannelStatus>,
        in_quick: bool,
        running: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let pending =
            self.pending.filter(|(for_provider, _)| *for_provider == provider).map(|(_, a)| a);
        let busy = self.pending.is_some();
        let listening = status.is_some_and(|status| status.status.running);
        let blocked = busy || !running;
        let locale = Locale::current(cx);
        let label_of = |action: BotAction, idle: Text, working: Text| {
            if pending == Some(action) { working } else { idle }.in_locale(locale)
        };
        let mut buttons: Vec<AnyElement> = Vec::new();
        if in_quick {
            let primary = match provider {
                BotProvider::Wecom => copy::QUICK_BIND,
                BotProvider::Wechat => copy::SCAN_LOGIN,
                _ => copy::SCAN_CONNECT,
            };
            buttons.push(
                control_button(Button::new("bot-scan").primary())
                    .label(primary.get(cx))
                    .disabled(blocked)
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.open_onboarding(provider, window, cx)
                    }))
                    .into_any_element(),
            );
            if provider == BotProvider::Wechat {
                let signed_in = channel.is_some_and(|channel| channel.has_token)
                    || status.is_some_and(|status| status.status.identity.is_some());
                if signed_in {
                    buttons.push(
                        settings_button(
                            "bot-disconnect",
                            label_of(
                                BotAction::Disconnect,
                                copy::DISCONNECT_WECHAT,
                                copy::DISCONNECTING,
                            ),
                            cx,
                        )
                        .disabled(busy)
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.confirm_disconnect = true;
                            cx.notify();
                        }))
                        .into_any_element(),
                    );
                }
                buttons.push(
                    settings_button("bot-bridge-qr", copy::BRIDGE_QR.get(cx), cx)
                        .disabled(blocked)
                        .on_click(cx.listener(|this, _, window, cx| this.open_bridge(window, cx)))
                        .into_any_element(),
                );
            }
            buttons.push(self.test_button(provider, copy::TEST, pending, blocked, cx));
        } else if support(provider) == Support::Runtime && !listening {
            buttons.push(
                control_button(Button::new("bot-connect").primary())
                    .label(label_of(BotAction::Connect, copy::TEST_AND_CONNECT, copy::CONNECTING))
                    .loading(pending == Some(BotAction::Connect))
                    .disabled(blocked)
                    .on_click(cx.listener(move |this, _, _, cx| this.connect(provider, cx)))
                    .into_any_element(),
            );
        } else {
            let idle = if support(provider) == Support::Runtime {
                copy::TEST
            } else {
                copy::TEST_AND_CONNECT
            };
            buttons.push(self.test_button(provider, idle, pending, blocked, cx));
        }
        if support(provider) == Support::Runtime
            && (listening || pending == Some(BotAction::Restart))
            && provider != BotProvider::Wechat
        {
            buttons.push(
                settings_button(
                    "bot-restart",
                    label_of(BotAction::Restart, copy::RESTART, copy::RESTARTING),
                    cx,
                )
                .loading(pending == Some(BotAction::Restart))
                .disabled(blocked)
                .on_click(cx.listener(move |this, _, _, cx| this.restart(provider, cx)))
                .into_any_element(),
            );
        }
        h_flex()
            .id("bot-actions")
            .test_support()
            .aria_label(copy::named(copy::ACTIONS_LABEL, locale, label(provider).in_locale(locale)))
            .flex_wrap()
            .gap_2()
            .children(buttons)
            .into_any_element()
    }

    fn test_button(
        &self,
        provider: BotProvider,
        idle: Text,
        pending: Option<BotAction>,
        blocked: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let testing = pending == Some(BotAction::Test);
        settings_button("bot-test", if testing { copy::TESTING } else { idle }.get(cx), cx)
            .loading(testing)
            .disabled(blocked)
            .on_click(cx.listener(move |this, _, _, cx| this.test(provider, cx)))
            .into_any_element()
    }

    /// Identity, connection, last event, last test (Desktop's
    /// `MetadataList`).
    fn render_facts(
        &self,
        channel: Option<&ChannelSummary>,
        status: Option<&ChannelStatus>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let locale = Locale::current(cx);
        let maka = cx.maka();
        let status = status.map(|status| &status.status);
        let identity = status
            .and_then(|status| status.identity.as_ref())
            .and_then(|identity| identity.username.clone().or(identity.display_name.clone()))
            .unwrap_or_else(|| copy::UNKNOWN_IDENTITY.in_locale(locale).to_owned());
        let connection =
            view::connection_label(status.map_or(bots::BotConnection::None, |s| s.connection));
        let last_event = status
            .and_then(|status| status.last_event_at)
            .map(|at| ago(locale, at, self.utc_offset))
            .unwrap_or_else(|| copy::NONE_YET.in_locale(locale).to_owned());
        let last_test = channel
            .and_then(|channel| channel.last_test_at)
            .map(|at| ago(locale, at, self.utc_offset))
            .unwrap_or_else(|| copy::NEVER_TESTED.in_locale(locale).to_owned());
        let facts = [
            ("identity", copy::IDENTITY, identity),
            ("connection", copy::CONNECTION_TYPE, connection.in_locale(locale).to_owned()),
            ("last-event", copy::LAST_EVENT, last_event),
            ("last-test", copy::LAST_TEST, last_test),
        ];
        h_flex()
            .id("bot-facts")
            .test_support()
            .role(Role::Group)
            .aria_label(copy::named(
                copy::RUNTIME_LABEL,
                locale,
                self.detail.map_or("", |provider| label(provider).in_locale(locale)),
            ))
            .w_full()
            .flex_wrap()
            .gap_x_8()
            .gap_y_2()
            .children(facts.map(|(key, title, value)| {
                v_flex()
                    .id(domain_element_id("bot-fact", key))
                    .test_support()
                    .aria_label(SharedString::from(value.clone()))
                    .min_w(rems(8.))
                    .gap_0p5()
                    .child(
                        div()
                            .text_xs()
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(maka.ink_muted)
                            .child(title.get(cx)),
                    )
                    .child(div().text_sm().text_color(maka.ink).child(value))
            }))
            .into_any_element()
    }

    /// "Disconnect WeChat?" asked inline, with its answer.
    fn render_disconnect(&self, cx: &mut Context<Self>) -> AnyElement {
        let maka = cx.maka();
        v_flex()
            .id("bot-disconnect-confirm")
            .test_support()
            .aria_label(copy::DISCONNECT_TITLE.get(cx))
            .w_full()
            .gap_2()
            .child(
                div()
                    .text_sm()
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(maka.ink)
                    .child(copy::DISCONNECT_TITLE.get(cx)),
            )
            .child(
                div()
                    .text_xs()
                    .text_color(maka.ink_muted)
                    .child(copy::DISCONNECT_DESCRIPTION.get(cx)),
            )
            .child(
                h_flex()
                    .gap_2()
                    .child(
                        crate::rows::destructive_button(
                            "bot-disconnect-confirm-button",
                            copy::DISCONNECT.get(cx),
                            cx,
                        )
                        .on_click(
                            cx.listener(|this, _, window, cx| this.disconnect_wechat(window, cx)),
                        ),
                    )
                    .child(
                        quiet_button(Button::new("bot-disconnect-cancel"), cx)
                            .label(copy::CANCEL.get(cx))
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.confirm_disconnect = false;
                                cx.notify();
                            })),
                    ),
            )
            .into_any_element()
    }

    /// The setup group's content: the setup switch, the quick setup, the
    /// credential form.
    fn render_setup(
        &self,
        provider: BotProvider,
        running: bool,
        cx: &mut Context<Self>,
    ) -> Vec<AnyElement> {
        let locale = Locale::current(cx);
        let quick_provider = provider.has_onboarding();
        let mut children = Vec::new();
        if quick_provider && provider != BotProvider::Wechat {
            let modes = [(true, copy::QUICK_RECOMMENDED, "quick"), (false, copy::MANUAL, "manual")];
            let quick = self.quick;
            children.push(
                segmented_track(cx)
                    .id("bot-setup-modes")
                    .test_support()
                    .aria_label(copy::named(
                        copy::SETUP_LABEL,
                        locale,
                        label(provider).in_locale(locale),
                    ))
                    .w(rems(20.))
                    .children(modes.map(|(mode, text, key)| {
                        let button = Button::new(domain_element_id("bot-setup-mode", key))
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.quick = mode;
                                cx.notify();
                            }));
                        segment(button, text.get(cx), quick == mode, cx)
                    }))
                    .into_any_element(),
            );
        }
        if quick_provider && provider != BotProvider::Wechat && self.quick {
            children.push(self.render_quick(provider, running, cx));
        }
        if !quick_provider || provider == BotProvider::Wechat || !self.quick {
            children.push(self.render_form(&view::form(provider), cx));
        }
        if provider == BotProvider::Wechat {
            let open = self.wechat_advanced;
            children.push(
                disclosure(
                    Button::new("bot-wechat-advanced").on_click(cx.listener(|this, _, _, cx| {
                        this.wechat_advanced = !this.wechat_advanced;
                        cx.notify();
                    })),
                    open,
                    if open { copy::COLLAPSE_ADVANCED } else { copy::EXPAND_ADVANCED }.get(cx),
                    cx,
                )
                .into_any_element(),
            );
            if open {
                children.push(self.render_form(&view::wechat_advanced(), cx));
            }
        }
        children
    }

    /// The quick setup callout (Desktop's `Card`).
    fn render_quick(
        &self,
        provider: BotProvider,
        running: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let locale = Locale::current(cx);
        let maka = cx.maka();
        let (title, detail) = match provider {
            BotProvider::Wecom => (copy::QUICK_WECOM_TITLE, copy::QUICK_WECOM_DETAIL),
            BotProvider::Qq => (copy::QUICK_QQ_TITLE, copy::QUICK_QQ_DETAIL),
            _ => (copy::QUICK_TITLE, copy::QUICK_DETAIL),
        };
        let brand = (provider == BotProvider::Feishu).then(|| {
            let lark = self.lark;
            let brands =
                [(false, copy::PROVIDER_FEISHU, "feishu"), (true, copy::PROVIDER_LARK, "lark")];
            segmented_track(cx)
                .id("bot-feishu-brand")
                .test_support()
                .aria_label(copy::FEISHU_REGION_LABEL.get(cx))
                .w(rems(12.))
                .children(brands.map(|(value, text, key)| {
                    let button = Button::new(domain_element_id("bot-feishu-brand", key)).on_click(
                        cx.listener(move |this, _, _, cx| {
                            this.lark = value;
                            cx.notify();
                        }),
                    );
                    segment(button, text.get(cx), lark == value, cx)
                }))
        });
        let button_label = if provider == BotProvider::Wecom {
            copy::BEGIN_QUICK_BIND.get(cx).to_owned()
        } else {
            let name = if provider == BotProvider::Feishu && self.lark {
                copy::PROVIDER_LARK.in_locale(locale)
            } else {
                label(provider).in_locale(locale)
            };
            copy::named(copy::SCAN_WITH, locale, name)
        };
        v_flex()
            .id("bot-quick-setup")
            .test_support()
            .aria_label(copy::named(copy::QUICK_LABEL, locale, label(provider).in_locale(locale)))
            .w_full()
            .p_4()
            .gap_2()
            .items_start()
            .rounded(RADIUS_SURFACE)
            .border_1()
            .border_color(maka.border_soft)
            .child(
                div()
                    .text_sm()
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(maka.ink)
                    .child(title.get(cx)),
            )
            .child(div().text_xs().text_color(maka.ink_muted).child(detail.get(cx)))
            .children(brand)
            .child(
                control_button(Button::new("bot-quick-scan").primary())
                    .label(button_label)
                    .disabled(self.pending.is_some() || !running)
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.open_onboarding(provider, window, cx)
                    })),
            )
            .into_any_element()
    }

    /// A credential form: its lines stacked as one form, the field blocks
    /// 16px apart with no rules between them.
    fn render_form(&self, lines: &[FormLine], cx: &mut Context<Self>) -> AnyElement {
        let locale = Locale::current(cx);
        let lines: Vec<AnyElement> = lines
            .iter()
            .filter_map(|line| match *line {
                FormLine::Field { key, label, description, .. } => {
                    let setting = self.field(key.key())?.clone();
                    let status = self
                        .errors
                        .get(&key)
                        .map(|error| StatusLine::error(key.key(), error.clone()));
                    let mut block = FieldBlock::new(format!("bot-field-{}", key.key()))
                        .field(label.get(cx), setting)
                        .status(status);
                    if let Some(description) = description {
                        block = block.help(description.get(cx));
                    }
                    Some(block.into_any_element())
                }
                FormLine::Domain => Some(
                    SettingsRow::select(
                        "bot-domain",
                        copy::FEISHU_DOMAIN.get(cx),
                        Select::new(&self.domain),
                    )
                    .into_any_element(),
                ),
                FormLine::AllowedUsers => Some(self.render_allowed(locale, cx)),
                FormLine::Notice(key, text) => Some(
                    div()
                        .py_2()
                        .child(StatusLine::info(format!("bot-notice-{key}"), text.get(cx)))
                        .into_any_element(),
                ),
            })
            .collect();
        v_flex().w_full().children(lines).into_any_element()
    }

    /// Telegram's allowlist (`BotAllowedUserIdsField`): saved when it
    /// leaves the field; entries that are not numbers are named.
    fn render_allowed(&self, locale: Locale, cx: &mut Context<Self>) -> AnyElement {
        let count = self.allowed_ids.len();
        let invalid: Vec<&str> = self
            .allowed_ids
            .iter()
            .map(String::as_str)
            .filter(|id| !id.chars().all(|c| c.is_ascii_digit()))
            .collect();
        let help = if count >= MAX_ALLOWED_USER_IDS {
            copy::ALLOWED_USERS_HELP_AT_CAP
        } else {
            copy::ALLOWED_USERS_HELP
        };
        let warning = (!invalid.is_empty()).then(|| copy::invalid_users(locale, &invalid));
        let mut block = FieldBlock::new("bot-allowed-users")
            .field(
                copy::allowed_users(locale, count, MAX_ALLOWED_USER_IDS),
                Textarea::new(&self.allowed).field_fill(cx).aria_label(copy::allowed_users(
                    locale,
                    count,
                    MAX_ALLOWED_USER_IDS,
                )),
            )
            .help(help.get(cx));
        if let Some(warning) = warning {
            block = block.status(StatusLine::error("bot-allowed-users", warning));
        }
        block.into_any_element()
    }
}

impl Render for BotChatPage {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let body = match self.detail {
            Some(provider) => self.render_detail(provider, cx),
            None => self.render_overview(cx),
        };
        v_flex().id("bot-chat").test_support().w_full().child(body)
    }
}

/// A channel's status beside its name: a conflict first, then its
/// readiness (`botReadinessCopyForSupport`).
fn status_label(state: &ViewState, status: Option<&ChannelStatus>) -> (Text, Tone) {
    if status.is_some_and(|status| status.conflict.is_some()) {
        return (copy::CONFLICT_STATUS, Tone::Error);
    }
    let (label, _, tone) = view::readiness(state.readiness);
    (label, tone)
}

/// The overview row's line (`botOverviewDetail`).
fn overview_detail(
    status: Option<&ChannelStatus>,
    state: &ViewState,
    locale: Locale,
    utc_offset: i32,
) -> String {
    if let Some(conflict) = status.and_then(|status| status.conflict.as_ref()) {
        return view::conflict_text(conflict.kind).in_locale(locale).to_owned();
    }
    let status = status.map(|status| &status.status);
    if state.live_operational {
        let identity = status
            .and_then(|status| status.identity.as_ref())
            .and_then(|identity| identity.username.clone().or(identity.display_name.clone()));
        let mut line = copy::LISTENING.in_locale(locale).to_owned();
        for part in
            [identity, status.and_then(|s| s.last_event_at).map(|at| ago(locale, at, utc_offset))]
                .into_iter()
                .flatten()
        {
            line.push_str(" · ");
            line.push_str(&part);
        }
        return line;
    }
    if let Some(error) = &state.current_error {
        return view::reason_message(error, locale);
    }
    if let Some(status) = status.filter(|status| status.reason.is_some()) {
        return status_detail(status, locale);
    }
    view::readiness(state.readiness).1.in_locale(locale).to_owned()
}

/// A platform's mark: a disc with its name's first character, as the
/// Models page marks a provider. It paints in palette roles, so it follows
/// the theme; Desktop draws brand logos here, at `.settingsBotLogo`'s
/// sizes: 32 in a list, 36 (`data-large`) in the detail's header.
fn platform_mark(provider: BotProvider, large: bool, cx: &App) -> AnyElement {
    let name = label(provider).in_locale(Locale::current(cx));
    let letter: String =
        name.chars().next().map(|c| c.to_uppercase().collect()).unwrap_or_default();
    let maka = cx.maka();
    h_flex()
        .when(large, |this| this.size_9().text_base())
        .when(!large, |this| this.size_8().text_sm())
        .flex_shrink_0()
        .justify_center()
        .rounded_full()
        .bg(maka.chip)
        .text_color(maka.ink)
        .font_weight(FontWeight::SEMIBOLD)
        .child(letter)
        .into_any_element()
}

fn field_label(provider: BotProvider, key: FieldKey) -> Text {
    let mut lines = view::form(provider);
    lines.extend(view::wechat_advanced());
    lines
        .into_iter()
        .find_map(|line| match line {
            FormLine::Field { key: field, label, .. } if field == key => Some(label),
            _ => None,
        })
        .unwrap_or(copy::CONNECTION_SETTINGS)
}

fn field_placeholder(provider: BotProvider, key: FieldKey, locale: Locale) -> String {
    let mut lines = view::form(provider);
    if provider == BotProvider::Wechat {
        lines.extend(view::wechat_advanced());
    }
    lines
        .into_iter()
        .find_map(|line| match line {
            FormLine::Field { key: field, placeholder, .. } if field == key => {
                Some(match placeholder {
                    Placeholder::Fixed(text) => text.to_owned(),
                    Placeholder::Words(text) => text.in_locale(locale).to_owned(),
                })
            }
            _ => None,
        })
        .unwrap_or_default()
}

fn unix_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or_default()
}
