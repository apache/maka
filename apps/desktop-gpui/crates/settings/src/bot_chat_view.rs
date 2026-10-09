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

//! What the Remote access page says about a platform, as Maka Desktop
//! derives it (bot-settings-view-model.ts, bot-chat-shared.tsx, and the
//! copy lookups of locales/settings-bot-copy.ts and
//! settings-test-result-copy.ts): the state a channel reads as, the words
//! for a listener's reason codes and a test's result, and each platform's
//! credential fields.

use bots::{
    BotConnection, BotProvider, BotReadiness, BotStatus, BotTestResult, ChannelStatus,
    ChannelSummary, ConflictKind,
};
use shared::copy::bots as copy;
use shared::copy::{Locale, Text};

use crate::page_kit::Tone;

/// How far Maka supports a platform (Desktop's `BOT_LABELS[provider].support`):
/// a listener it runs and restarts, or credentials it tests.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Support {
    Runtime,
    Credentials,
}

pub(crate) fn support(provider: BotProvider) -> Support {
    match provider {
        BotProvider::Feishu | BotProvider::Wecom | BotProvider::Wechat => Support::Credentials,
        _ => Support::Runtime,
    }
}

pub(crate) fn label(provider: BotProvider) -> Text {
    match provider {
        BotProvider::Telegram => copy::PROVIDER_TELEGRAM,
        BotProvider::Feishu => copy::PROVIDER_FEISHU,
        BotProvider::Wecom => copy::PROVIDER_WECOM,
        BotProvider::Wechat => copy::PROVIDER_WECHAT,
        BotProvider::Discord => copy::PROVIDER_DISCORD,
        BotProvider::Dingtalk => copy::PROVIDER_DINGTALK,
        BotProvider::Qq => copy::PROVIDER_QQ,
        BotProvider::Slack => copy::PROVIDER_SLACK,
    }
}

pub(crate) fn help(provider: BotProvider) -> Text {
    match provider {
        BotProvider::Telegram => copy::HELP_TELEGRAM,
        BotProvider::Feishu => copy::HELP_FEISHU,
        BotProvider::Wecom => copy::HELP_WECOM,
        BotProvider::Wechat => copy::HELP_WECHAT,
        BotProvider::Discord => copy::HELP_DISCORD,
        BotProvider::Dingtalk => copy::HELP_DINGTALK,
        BotProvider::Qq => copy::HELP_QQ,
        BotProvider::Slack => copy::HELP_SLACK,
    }
}

/// The platform's official setup guide.
pub(crate) fn config_docs(provider: BotProvider) -> Option<&'static str> {
    copy::CONFIG_DOCS.iter().find(|(name, _)| *name == provider.as_str()).map(|(_, url)| *url)
}

/// A readiness state's label, line, and tone (`readiness` in the copy).
pub(crate) fn readiness(readiness: BotReadiness) -> (Text, Text, Tone) {
    match readiness {
        BotReadiness::Unscaffolded => {
            (copy::READINESS_UNSCAFFOLDED, copy::READINESS_UNSCAFFOLDED_DETAIL, Tone::Neutral)
        }
        BotReadiness::Configured => {
            (copy::READINESS_CONFIGURED, copy::READINESS_CONFIGURED_DETAIL, Tone::Attention)
        }
        BotReadiness::CredentialsValid => (
            copy::READINESS_CREDENTIALS_VALID,
            copy::READINESS_CREDENTIALS_VALID_DETAIL,
            Tone::Attention,
        ),
        BotReadiness::Operational => {
            (copy::READINESS_OPERATIONAL, copy::READINESS_OPERATIONAL_DETAIL, Tone::Success)
        }
        BotReadiness::Degraded => {
            (copy::READINESS_DEGRADED, copy::READINESS_DEGRADED_DETAIL, Tone::Error)
        }
        _ => (copy::READINESS_SCAFFOLDED, copy::READINESS_SCAFFOLDED_DETAIL, Tone::Neutral),
    }
}

/// `deriveBotChannelViewState`: how a channel reads, from what is saved and
/// what its listener reports.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ViewState {
    pub(crate) readiness: BotReadiness,
    /// In use: shown under "In use" rather than among the platforms to add.
    pub(crate) configured: bool,
    pub(crate) needs_attention: bool,
    /// The failure to show, as a reason code.
    pub(crate) current_error: Option<String>,
    /// Running and proven to exchange messages.
    pub(crate) live_operational: bool,
}

pub(crate) fn view_state(channel: &ChannelSummary, status: Option<&ChannelStatus>) -> ViewState {
    let status = status.map(|status| &status.status);
    let running = status.is_some_and(|status| status.running);
    let readiness = match status {
        Some(status) if channel.enabled || status.running => status.readiness,
        _ => channel.readiness,
    };
    let claims = |readiness: BotReadiness| {
        matches!(
            readiness,
            BotReadiness::Configured
                | BotReadiness::CredentialsValid
                | BotReadiness::Operational
                | BotReadiness::Degraded
        )
    };
    let configured = channel.connected
        || channel.enabled
        || running
        || status.is_some_and(|status| status.identity.is_some())
        || claims(channel.readiness)
        || claims(readiness);
    let live_operational = running && readiness == BotReadiness::Operational;
    let live_error = (readiness == BotReadiness::Degraded)
        .then(|| status.and_then(|status| error_reason(status.reason.as_deref())))
        .flatten();
    let current_error =
        if live_operational { None } else { live_error.or_else(|| channel.last_error.clone()) };
    let needs_attention = configured
        && (readiness == BotReadiness::Degraded
            || current_error.is_some()
            || (channel.enabled && status.is_some_and(|status| !status.running)));
    ViewState { readiness, configured, needs_attention, current_error, live_operational }
}

/// `botStatusErrorReason`: a reason code worth showing as a failure; the
/// benign ones (off, not configured yet) are not.
fn error_reason(reason: Option<&str>) -> Option<String> {
    const BENIGN: [&str; 8] = [
        "disabled",
        "stopped",
        "token_missing",
        "feishu_credentials_missing",
        "feishu-domain-required",
        "feishu-events-not-connected",
        "scaffold-only",
        "unimplemented",
    ];
    let reason = reason?.trim();
    if reason.is_empty() || BENIGN.contains(&reason) {
        return None;
    }
    Some(reason.chars().take(200).collect())
}

/// `botStatusDetail`: the line for a listener's state.
pub(crate) fn status_detail(status: &BotStatus, locale: Locale) -> String {
    let fixed = match status.reason.as_deref() {
        Some("disabled") => copy::STATUS_DISABLED,
        Some("token_missing") => copy::STATUS_NO_TOKEN,
        Some("feishu_credentials_missing") => copy::STATUS_MISSING_FEISHU,
        Some("feishu-domain-required") => copy::STATUS_FEISHU_DOMAIN_REQUIRED,
        Some("feishu-events-not-connected") => copy::STATUS_FEISHU_EVENTS_NOT_CONNECTED,
        Some("scaffold-only" | "unimplemented") => copy::STATUS_UNAVAILABLE,
        Some("stopped") => copy::STATUS_STOPPED,
        Some(reason) => return reason_message(reason, locale),
        None => copy::STATUS_DETAILS_IN_LOGS,
    };
    fixed.in_locale(locale).to_owned()
}

/// `botStatusReasonMessage`: a reason code in words; one this client does
/// not know points at the logs.
pub(crate) fn reason_message(reason: &str, locale: Locale) -> String {
    reason_copy(reason, locale)
        .unwrap_or_else(|| copy::STATUS_DETAILS_IN_LOGS.in_locale(locale).to_owned())
}

/// `botStatusReasonCopy`.
fn reason_copy(reason: &str, locale: Locale) -> Option<String> {
    let fixed = match reason {
        "slack-disconnected" => Some(copy::REASON_SLACK_DISCONNECTED),
        "disconnected" => Some(copy::REASON_DISCONNECTED),
        "reconnecting" => Some(copy::REASON_RECONNECTING),
        "stream-failed" => Some(copy::REASON_STREAM_FAILED),
        "timeout" => Some(copy::REASON_TIMEOUT),
        "rate_limited" => Some(copy::REASON_RATE_LIMITED),
        "auth_failed" => Some(copy::REASON_AUTH_FAILED),
        "provider_error" => Some(copy::REASON_PROVIDER_ERROR),
        "network_error" => Some(copy::REASON_NETWORK_ERROR),
        "rate-limited" => Some(copy::REASON_SEND_THROTTLED),
        "polling-timeout" => Some(copy::REASON_POLLING_TIMEOUT),
        "send-failed" => Some(copy::REASON_SEND_FAILED),
        "get-me-failed" => Some(copy::REASON_GET_ME_FAILED),
        "disabled" => Some(copy::STATUS_DISABLED),
        "stopped" => Some(copy::STATUS_STOPPED),
        _ => test_error(reason),
    };
    if let Some(text) = fixed {
        return Some(text.in_locale(locale).to_owned());
    }
    const WITH_CODE: [(&str, Text); 6] = [
        ("gateway-bot-", copy::REASON_GATEWAY_BOT),
        ("gateway-closed-", copy::REASON_GATEWAY_CLOSED),
        ("connections-open-", copy::REASON_CONNECTIONS_OPEN),
        ("stream-closed-", copy::REASON_STREAM_CLOSED),
        ("send-failed-", copy::REASON_SEND_FAILED_CODE),
        ("getAppAccessToken-", copy::REASON_APP_ACCESS_TOKEN),
    ];
    WITH_CODE.iter().find_map(|(prefix, text)| {
        let code = reason.strip_prefix(prefix)?;
        (!code.is_empty() && code.chars().all(|c| c.is_ascii_digit()))
            .then(|| copy::with_code(*text, locale, code))
    })
}

/// A test's error code in words (`testErrors`).
fn test_error(code: &str) -> Option<Text> {
    Some(match code {
        "connection_failed" => copy::TEST_CONNECTION_FAILED,
        "token_missing" => copy::TEST_TOKEN_MISSING,
        "token_invalid" => copy::TEST_TOKEN_INVALID,
        "slack_tokens_missing" => copy::TEST_SLACK_TOKENS_MISSING,
        "feishu_credentials_missing" => copy::TEST_FEISHU_CREDENTIALS_MISSING,
        "wecom_credentials_missing" => copy::TEST_WECOM_CREDENTIALS_MISSING,
        "dingtalk_credentials_missing" => copy::TEST_DINGTALK_CREDENTIALS_MISSING,
        "dingtalk_no_access_token" => copy::TEST_DINGTALK_NO_ACCESS_TOKEN,
        "qq_credentials_missing" => copy::TEST_QQ_CREDENTIALS_MISSING,
        "qq_no_access_token" => copy::TEST_QQ_NO_ACCESS_TOKEN,
        "wechat_bridge_url_invalid" => copy::TEST_WECHAT_BRIDGE_URL_INVALID,
        "wechat_ilink_credentials_incomplete" => copy::TEST_WECHAT_ILINK_INCOMPLETE,
        _ => return None,
    })
}

/// `settingsTestResultMessage` for a channel test.
pub(crate) fn test_message(result: &BotTestResult, locale: Locale) -> String {
    if result.ok {
        let username = result.identity.as_ref().and_then(|identity| identity.username.as_deref());
        return copy::credentials_check_passed(locale, username);
    }
    let text =
        result.error_code.as_deref().and_then(test_error).unwrap_or(copy::TEST_CONNECTION_FAILED);
    text.in_locale(locale).to_owned()
}

pub(crate) fn connection_label(connection: BotConnection) -> Text {
    match connection {
        BotConnection::Polling => copy::CONNECTION_POLLING,
        BotConnection::Gateway => copy::CONNECTION_GATEWAY,
        BotConnection::Webhook => copy::CONNECTION_WEBHOOK,
        _ => copy::CONNECTION_NONE,
    }
}

/// What the page says about a Telegram token another client took.
pub(crate) fn conflict_text(kind: ConflictKind) -> Text {
    match kind {
        ConflictKind::Webhook => copy::CONFLICT_WEBHOOK,
        _ => copy::CONFLICT_POLLING,
    }
}

/// `botOnboardingErrorMessage`: an onboarding's error code in words.
pub(crate) fn onboarding_error(code: Option<&str>) -> Text {
    match code {
        Some("cancelled") => copy::ONBOARDING_ERROR_CANCELLED,
        Some("timeout") => copy::REASON_TIMEOUT,
        Some("rate_limited") => copy::REASON_RATE_LIMITED,
        Some("auth_failed") => copy::REASON_AUTH_FAILED,
        Some("provider_error") => copy::REASON_PROVIDER_ERROR,
        Some("network_error") => copy::REASON_NETWORK_ERROR,
        Some("unavailable") => copy::ONBOARDING_ERROR_UNAVAILABLE,
        _ => copy::ONBOARDING_FAILED,
    }
}

/// Whether a channel in `readiness` may be switched on
/// (`canEnableBotChannel`): only once its credentials were proven.
pub(crate) fn can_enable(readiness: BotReadiness) -> bool {
    matches!(
        readiness,
        BotReadiness::CredentialsValid | BotReadiness::Operational | BotReadiness::Degraded
    )
}

/// A credential field of a channel.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum FieldKey {
    Token,
    ProxyUrl,
    AppId,
    AppSecret,
    WebhookUrl,
}

impl FieldKey {
    pub(crate) fn key(self) -> &'static str {
        match self {
            Self::Token => "token",
            Self::ProxyUrl => "proxy-url",
            Self::AppId => "app-id",
            Self::AppSecret => "app-secret",
            Self::WebhookUrl => "webhook-url",
        }
    }

    /// A secret: never read back, only replaced.
    pub(crate) fn is_secret(self) -> bool {
        matches!(self, Self::Token | Self::AppSecret)
    }

    /// The saved value a plain field shows; a secret's is never shown.
    pub(crate) fn value(self, channel: &ChannelSummary) -> Option<String> {
        match self {
            Self::ProxyUrl => Some(channel.proxy_url.clone()),
            Self::AppId => Some(channel.app_id.clone()),
            Self::WebhookUrl => Some(channel.webhook_url.clone()),
            Self::Token | Self::AppSecret => None,
        }
    }

    pub(crate) fn is_saved(self, channel: &ChannelSummary) -> bool {
        match self {
            Self::Token => channel.has_token,
            Self::AppSecret => channel.has_app_secret,
            _ => false,
        }
    }
}

/// The placeholder of an empty field: Desktop's sample value, fixed or in
/// words.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Placeholder {
    Fixed(&'static str),
    Words(Text),
}

/// One line of a platform's credential form (Desktop's
/// `botCredentialFields`), in order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FormLine {
    Field {
        key: FieldKey,
        label: Text,
        description: Option<Text>,
        placeholder: Placeholder,
    },
    /// Feishu's domain: feishu.cn or larksuite.com.
    Domain,
    /// Telegram's allowlist.
    AllowedUsers,
    /// A note, by a key for its element.
    Notice(&'static str, Text),
}

fn field(key: FieldKey, label: Text, placeholder: Placeholder) -> FormLine {
    FormLine::Field { key, label, description: None, placeholder }
}

/// The form of `provider`. WeChat's advanced fields are in
/// [`wechat_advanced`].
pub(crate) fn form(provider: BotProvider) -> Vec<FormLine> {
    use FieldKey::*;
    use Placeholder::{Fixed, Words};
    match provider {
        BotProvider::Telegram => vec![
            // How to get a token is the token's caption, not a notice.
            FormLine::Field {
                key: Token,
                label: copy::TELEGRAM_TOKEN,
                description: Some(copy::TELEGRAM_OFFICIAL_FLOW),
                placeholder: Fixed(copy::TELEGRAM_TOKEN_PLACEHOLDER),
            },
            FormLine::Field {
                key: ProxyUrl,
                label: copy::TELEGRAM_PROXY,
                description: Some(copy::CHINA_REQUIRED),
                placeholder: Fixed(copy::PROXY_PLACEHOLDER),
            },
            FormLine::AllowedUsers,
            FormLine::Notice("telegram-tun", copy::TELEGRAM_NOTICE),
        ],
        BotProvider::Feishu => vec![
            field(AppId, copy::FEISHU_CREDENTIAL_ID, Fixed(copy::FEISHU_APP_ID_PLACEHOLDER)),
            field(AppSecret, copy::FEISHU_SECRET, Fixed(copy::SECRET_PLACEHOLDER)),
            FormLine::Domain,
        ],
        BotProvider::Discord => vec![
            field(Token, copy::DISCORD_TOKEN, Fixed(copy::DISCORD_TOKEN_PLACEHOLDER)),
            FormLine::Field {
                key: ProxyUrl,
                label: copy::DISCORD_PROXY,
                description: Some(copy::AUTH_ONLY),
                placeholder: Fixed(copy::PROXY_PLACEHOLDER),
            },
            FormLine::Notice("discord-proxy", copy::DISCORD_NOTICE),
        ],
        BotProvider::Dingtalk => vec![
            field(AppId, copy::DINGTALK_ID, Fixed(copy::DINGTALK_ID_PLACEHOLDER)),
            field(AppSecret, copy::DINGTALK_SECRET, Fixed(copy::SECRET_PLACEHOLDER)),
        ],
        BotProvider::Wecom => vec![
            field(AppId, copy::WECOM_BOT, Words(copy::WECOM_BOT_PLACEHOLDER)),
            field(AppSecret, copy::WECOM_SECRET, Words(copy::WECOM_SECRET_PLACEHOLDER)),
        ],
        BotProvider::Qq => vec![
            field(AppId, copy::QQ_ID, Fixed(copy::QQ_ID_PLACEHOLDER)),
            field(AppSecret, copy::QQ_SECRET, Fixed(copy::SECRET_PLACEHOLDER)),
        ],
        BotProvider::Slack => vec![
            field(Token, copy::SLACK_TOKEN, Fixed(copy::SLACK_TOKEN_PLACEHOLDER)),
            field(AppSecret, copy::SLACK_APP_TOKEN, Fixed(copy::SLACK_APP_TOKEN_PLACEHOLDER)),
        ],
        BotProvider::Wechat => {
            vec![field(Token, copy::WECHAT_TOKEN, Words(copy::WECHAT_TOKEN_PLACEHOLDER))]
        }
    }
}

/// WeChat's advanced settings (`BotWeChatFields`): the local bridge and the
/// Official Account's credentials.
pub(crate) fn wechat_advanced() -> Vec<FormLine> {
    use FieldKey::*;
    use Placeholder::{Fixed, Words};
    vec![
        field(WebhookUrl, copy::BRIDGE_ADDRESS, Fixed(copy::BRIDGE_PLACEHOLDER)),
        field(AppId, copy::WECHAT_APP_ID, Words(copy::WECHAT_APP_ID_PLACEHOLDER)),
        field(AppSecret, copy::WECHAT_APP_SECRET, Words(copy::WECHAT_APP_SECRET_PLACEHOLDER)),
        FormLine::Notice("wechat-advanced", copy::ADVANCED_NOTICE),
    ]
}

/// Every field of `provider`'s form, WeChat's advanced ones included.
pub(crate) fn fields(provider: BotProvider) -> Vec<FieldKey> {
    let mut lines = form(provider);
    if provider == BotProvider::Wechat {
        lines.extend(wechat_advanced());
    }
    lines
        .into_iter()
        .filter_map(|line| match line {
            FormLine::Field { key, .. } => Some(key),
            _ => None,
        })
        .collect()
}

/// The onboarding dialog's words for `provider` (Lark for Feishu with that
/// brand): title, subtitle, waiting, scanned, and the QR code's name.
pub(crate) fn onboarding_copy(provider: BotProvider, lark: bool) -> [Text; 5] {
    match provider {
        BotProvider::Dingtalk => [
            copy::DINGTALK_TITLE,
            copy::DINGTALK_SUBTITLE,
            copy::DINGTALK_WAITING,
            copy::DINGTALK_SCANNED,
            copy::DINGTALK_QR_ALT,
        ],
        BotProvider::Feishu if lark => [
            copy::LARK_TITLE,
            copy::LARK_SUBTITLE,
            copy::LARK_WAITING,
            copy::LARK_SCANNED,
            copy::LARK_QR_ALT,
        ],
        BotProvider::Feishu => [
            copy::FEISHU_TITLE,
            copy::FEISHU_SUBTITLE,
            copy::FEISHU_WAITING,
            copy::FEISHU_SCANNED,
            copy::FEISHU_QR_ALT,
        ],
        BotProvider::Wecom => [
            copy::WECOM_TITLE,
            copy::WECOM_SUBTITLE,
            copy::WECOM_WAITING,
            copy::WECOM_SCANNED,
            copy::WECOM_QR_ALT,
        ],
        BotProvider::Wechat => [
            copy::WECHAT_TITLE,
            copy::WECHAT_SUBTITLE,
            copy::WECHAT_WAITING,
            copy::WECHAT_SCANNED,
            copy::WECHAT_QR_ALT,
        ],
        _ => {
            [copy::QQ_TITLE, copy::QQ_SUBTITLE, copy::QQ_WAITING, copy::QQ_SCANNED, copy::QQ_QR_ALT]
        }
    }
}

/// The words of a backoff's cause (`retryCategory*`).
pub(crate) fn retry_reason(category: &str) -> Text {
    match category {
        "timeout" => copy::RETRY_TIMEOUT,
        "network" => copy::RETRY_NETWORK,
        "rate_limited" => copy::RETRY_RATE_LIMITED,
        "server" => copy::RETRY_SERVER,
        _ => copy::RETRY_OTHER,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn status(value: serde_json::Value) -> ChannelStatus {
        serde_json::from_value(value).expect("status")
    }

    fn channel(
        provider: BotProvider,
        edit: impl FnOnce(&mut bots::BotChannelSettings),
    ) -> ChannelSummary {
        let mut channel = bots::BotChannelSettings::new(provider);
        edit(&mut channel);
        channel.summary()
    }

    #[test]
    fn a_channel_reads_as_desktop_derives_it() {
        let fresh = channel(BotProvider::Telegram, |_| {});
        let state = view_state(&fresh, None);
        assert!(!state.configured && !state.needs_attention && !state.live_operational);
        assert_eq!(state.readiness, BotReadiness::Scaffolded);

        let enabled = channel(BotProvider::Telegram, |channel| {
            channel.enabled = true;
            channel.token = "123:abc".into();
            channel.readiness = Some(BotReadiness::CredentialsValid);
        });
        let live = status(json!({"status": {"platform": "telegram", "running": true,
            "readiness": "operational", "connection": "polling", "lastEventAt": 5}}));
        let state = view_state(&enabled, Some(&live));
        assert!(state.configured && state.live_operational && !state.needs_attention);
        assert_eq!(state.readiness, BotReadiness::Operational);

        // Enabled, but the listener stopped: needs attention.
        let stopped = status(json!({"status": {"platform": "telegram", "running": false,
            "readiness": "credentials_valid", "reason": "stopped", "connection": "none"}}));
        assert!(view_state(&enabled, Some(&stopped)).needs_attention);

        // Degraded: the live reason is the failure, unless it is benign.
        let degraded = status(json!({"status": {"platform": "telegram", "running": true,
            "readiness": "degraded", "reason": "gateway-closed-4004", "connection": "polling"}}));
        let state = view_state(&enabled, Some(&degraded));
        assert_eq!(state.current_error.as_deref(), Some("gateway-closed-4004"));
        assert!(state.needs_attention);

        // A failed test is remembered in the settings.
        let failed = channel(BotProvider::Discord, |channel| {
            channel.token = "t".into();
            channel.readiness = Some(BotReadiness::Configured);
            channel.last_error = Some("token_invalid".into());
        });
        let state = view_state(&failed, None);
        assert!(state.configured && state.needs_attention);
        assert_eq!(state.current_error.as_deref(), Some("token_invalid"));
    }

    #[test]
    fn reason_codes_read_in_desktops_words() {
        let en = Locale::English;
        assert_eq!(
            reason_message("gateway-closed-4004", en),
            "Gateway connection closed (4004); reconnecting"
        );
        assert_eq!(reason_message("token_invalid", en), copy::TEST_TOKEN_INVALID.en());
        assert_eq!(reason_message("rate-limited", en), copy::REASON_SEND_THROTTLED.en());
        assert_eq!(reason_message("something-new", en), copy::STATUS_DETAILS_IN_LOGS.en());
        assert_eq!(reason_message("send-failed-", en), copy::STATUS_DETAILS_IN_LOGS.en());
        let disabled = status(json!({"status": {"platform": "qq", "running": false,
            "readiness": "scaffolded", "reason": "disabled", "connection": "none"}}));
        assert_eq!(status_detail(&disabled.status, en), copy::STATUS_DISABLED.en());
        assert_eq!(
            reason_message("getAppAccessToken-401", Locale::SimplifiedChinese),
            "获取 access_token 失败（HTTP 401）"
        );
    }

    #[test]
    fn a_test_result_reads_as_desktops_toast() {
        let en = Locale::English;
        let passed: BotTestResult =
            serde_json::from_value(json!({"ok": true, "identity": {"username": "maka_bot"}}))
                .expect("result");
        assert!(test_message(&passed, en).contains("maka_bot"));
        let failed: BotTestResult =
            serde_json::from_value(json!({"ok": false, "errorCode": "qq_no_access_token"}))
                .expect("result");
        assert_eq!(test_message(&failed, en), copy::TEST_QQ_NO_ACCESS_TOKEN.en());
        let unknown: BotTestResult =
            serde_json::from_value(json!({"ok": false, "errorCode": "new"})).expect("result");
        assert_eq!(test_message(&unknown, en), copy::TEST_CONNECTION_FAILED.en());
    }

    #[test]
    fn every_platform_has_desktops_fields() {
        assert_eq!(fields(BotProvider::Telegram), [FieldKey::Token, FieldKey::ProxyUrl]);
        assert_eq!(fields(BotProvider::Slack), [FieldKey::Token, FieldKey::AppSecret]);
        assert_eq!(
            fields(BotProvider::Wechat),
            [FieldKey::Token, FieldKey::WebhookUrl, FieldKey::AppId, FieldKey::AppSecret]
        );
        assert!(form(BotProvider::Feishu).contains(&FormLine::Domain));
        assert!(form(BotProvider::Telegram).contains(&FormLine::AllowedUsers));
        for provider in BotProvider::ALL {
            assert!(config_docs(provider).is_some_and(|url| url.starts_with("https://")));
        }
        assert!(FieldKey::Token.is_secret() && !FieldKey::AppId.is_secret());
    }
}
