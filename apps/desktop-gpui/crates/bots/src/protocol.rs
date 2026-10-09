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

//! The stdio protocol between this client and the bot sidecar: one JSON
//! object per line, commands on the sidecar's stdin, answers and events on
//! its stdout. `docs/bots-sidecar.md` describes it; `sidecars/bots/main.mjs`
//! and `sidecar.mjs` are the other end.
//!
//! The payload types mirror the TypeScript they carry:
//! [`BotStatus`] is `BotStatus` and [`BotTestResult`] is `BotTestResult` in
//! `packages/runtime/src/bots/types.ts`, [`OnboardingSnapshot`] is
//! `BotOnboardingSnapshot` in `packages/core/src/bot-onboarding.ts` (with the
//! QR code's content in place of its rendered image), and
//! [`WechatBridgeQr`] is `WechatBridgeQrCodeResult` in
//! `packages/runtime/src/bots/wechat-bridge.ts`.

use std::collections::BTreeMap;

use host_protocol::WorkspaceTarget;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::settings::{BotChannelSettings, BotChatSettings, BotProvider, BotReadiness};

/// `SIDECAR_PROTOCOL_VERSION` in `sidecars/bots/sidecar.mjs`.
pub const SIDECAR_PROTOCOL_VERSION: u32 = 1;

/// `BotStatus`: a bridge's runtime state. `running` is the receive loop
/// only; `readiness` is what the user should be told.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct BotStatus {
    pub platform: BotProvider,
    pub running: bool,
    pub readiness: BotReadiness,
    /// A stable code (`BotStatusReason`), e.g. `disabled`, `token_invalid`,
    /// `send-failed-403`; presenters own the copy.
    #[serde(default)]
    pub reason: Option<String>,
    /// Milliseconds since the Unix epoch.
    #[serde(default)]
    pub started_at: Option<u64>,
    #[serde(default)]
    pub last_event_at: Option<u64>,
    pub connection: BotConnection,
    #[serde(default)]
    pub identity: Option<BotIdentity>,
}

/// `BotStatus.connection`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum BotConnection {
    Polling,
    Gateway,
    Webhook,
    None,
    #[serde(other)]
    Unknown,
}

/// `BotStatus.identity`: the bot account the bridge signed in as.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct BotIdentity {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub display_name: Option<String>,
}

/// A channel's status as the sidecar reports it: the bridge's
/// [`BotStatus`], and the conflict that suspended it, if one did.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[non_exhaustive]
pub struct ChannelStatus {
    pub status: BotStatus,
    #[serde(default)]
    pub conflict: Option<ChannelConflict>,
}

impl ChannelStatus {
    pub fn provider(&self) -> BotProvider {
        self.status.platform
    }
}

/// Telegram answered this channel's `getUpdates` with 409 Conflict: another
/// client polls the same bot token, or the bot delivers to a webhook. The
/// sidecar stopped the channel instead of taking turns with the other
/// client; a restart of the channel, or other credentials, resume it.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ChannelConflict {
    pub kind: ConflictKind,
    /// Telegram's own description, at most 200 characters.
    #[serde(default)]
    pub description: Option<String>,
    /// Milliseconds since the Unix epoch.
    pub detected_at: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum ConflictKind {
    /// Another process polls `getUpdates` with this token.
    Polling,
    /// The bot has a webhook, so it cannot be polled.
    Webhook,
    #[serde(other)]
    Unknown,
}

/// `BotTestResult`: what a channel test found.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct BotTestResult {
    pub ok: bool,
    #[serde(default)]
    pub identity: Option<BotIdentity>,
    #[serde(default)]
    pub message_sent: Option<bool>,
    #[serde(default)]
    pub capabilities: Option<BTreeMap<String, bool>>,
    /// A stable code (`BotTestErrorCode`), e.g. `token_invalid`.
    #[serde(default)]
    pub error_code: Option<String>,
    /// A redacted diagnostic for logs, never product copy.
    #[serde(default)]
    pub error: Option<String>,
    /// `false` when only the shape of the credentials was checked.
    #[serde(default)]
    pub verified: Option<bool>,
}

/// The sidecar's connection to the Runtime Host.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
#[non_exhaustive]
pub enum HostLinkState {
    #[serde(rename_all = "camelCase")]
    Connected { root_id: String, host_epoch: String },
    /// Not connected; `reason` is a `connectExistingRuntimeHost` reason
    /// such as `not_registered`, or why the connection ended.
    Disconnected { reason: String },
}

/// The level of a sidecar log line.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum LogLevel {
    Info,
    Warn,
    Error,
    #[serde(other)]
    Unknown,
}

/// `BotOnboardingBrand`: Feishu and Lark share one channel but sign in on
/// different account domains.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OnboardingBrand {
    Feishu,
    Lark,
}

/// `BotOnboardingState`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum OnboardingState {
    /// The code is shown; nobody scanned it yet.
    Waiting,
    /// Scanned; the person confirms on the phone.
    Scanned,
    /// Confirmed; the channel is being saved and started.
    Connecting,
    Connected,
    Expired,
    Denied,
    Cancelled,
    Error,
    #[serde(other)]
    Unknown,
}

impl OnboardingState {
    /// Whether the session still polls the provider.
    pub fn is_pending(self) -> bool {
        matches!(self, Self::Waiting | Self::Scanned)
    }
}

/// What the QR code shows: the text to encode (a verification URL), or an
/// image the provider drew itself (a `data:image/...` URL).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OnboardingQr {
    Text(String),
    Image(String),
}

/// `BotOnboardingRetryHealth`: the session is backing off after transient
/// failures.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct RetryHealth {
    /// `timeout`, `network`, `rate_limited`, or `server`.
    pub category: String,
    pub consecutive_failures: u32,
}

/// The account a finished onboarding connected.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct OnboardingIdentity {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub display_name: Option<String>,
}

/// `BotOnboardingSnapshot`: an onboarding session as a page may show it.
/// Device codes and credentials never appear in one.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct OnboardingSnapshot {
    pub session_id: String,
    pub provider: BotProvider,
    #[serde(default)]
    pub brand: Option<OnboardingBrand>,
    pub state: OnboardingState,
    /// On the first snapshot of a session only.
    #[serde(default)]
    pub qr: Option<OnboardingQr>,
    /// Milliseconds since the Unix epoch.
    #[serde(default)]
    pub expires_at: Option<u64>,
    /// When to poll next.
    #[serde(default)]
    pub next_poll_after_ms: u64,
    #[serde(default)]
    pub retry_health: Option<RetryHealth>,
    #[serde(default)]
    pub can_open_in_browser: bool,
    #[serde(default)]
    pub identity: Option<OnboardingIdentity>,
    /// A `BotOnboardingErrorCode` in the `error` state.
    #[serde(default)]
    pub error_code: Option<String>,
    /// `saved_not_connected` when the saved channel's listener did not start.
    #[serde(default)]
    pub warning_code: Option<String>,
    /// The listener's redacted status reason, for that warning.
    #[serde(default)]
    pub warning_detail: Option<String>,
}

/// The channel fields a confirmed scan sets (`channelPatchFromCredential` in
/// apps/desktop/src/main/bot-onboarding-main.ts). Only the settings store
/// sees it.
#[derive(Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OnboardingChannel {
    #[serde(default)]
    pub(crate) readiness_updated_at: Option<u64>,
    #[serde(default)]
    pub(crate) token: Option<String>,
    #[serde(default)]
    pub(crate) app_id: Option<String>,
    #[serde(default)]
    pub(crate) app_secret: Option<String>,
    #[serde(default)]
    pub(crate) domain: Option<String>,
    #[serde(default)]
    pub(crate) webhook_url: Option<String>,
    #[serde(default)]
    pub(crate) bot_user_id: Option<String>,
}

impl std::fmt::Debug for OnboardingChannel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OnboardingChannel")
            .field("app_id", &self.app_id)
            .field("domain", &self.domain)
            .finish_non_exhaustive()
    }
}

impl OnboardingChannel {
    /// Writes the credentials into `channel`, enabled and awaiting a test,
    /// as Desktop's `persistCredential` patches the channel.
    pub(crate) fn apply(&self, channel: &mut BotChannelSettings, now_ms: u64) {
        channel.enabled = true;
        channel.connected = false;
        channel.readiness = Some(BotReadiness::Configured);
        channel.readiness_reason = None;
        channel.readiness_updated_at = Some(self.readiness_updated_at.unwrap_or(now_ms));
        channel.last_error = None;
        if let Some(token) = &self.token {
            channel.token = token.clone();
        }
        for (field, value) in [
            (&mut channel.app_id, &self.app_id),
            (&mut channel.app_secret, &self.app_secret),
            (&mut channel.domain, &self.domain),
            (&mut channel.webhook_url, &self.webhook_url),
            (&mut channel.bot_user_id, &self.bot_user_id),
        ] {
            if value.is_some() {
                *field = value.clone();
            }
        }
    }
}

/// `WechatBridgeQrCodeResult`: what the local wechat-bridge's QR endpoint
/// answered.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct WechatBridgeQr {
    pub ok: bool,
    /// A `data:image/...` URL.
    #[serde(default)]
    pub qrcode: Option<String>,
    #[serde(default)]
    pub expired: bool,
    #[serde(default)]
    pub logged_in: bool,
    /// `wechat_bridge_remote_url` or `wechat_bridge_unreachable`.
    #[serde(default)]
    pub hint_code: Option<String>,
    /// A redacted diagnostic for logs, never product copy.
    #[serde(default)]
    pub error: Option<String>,
}

/// A command for the sidecar.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "command", rename_all = "snake_case")]
pub(crate) enum Command {
    ApplySettings {
        settings: Box<BotChatSettings>,
    },
    SetWorkspace {
        workspace: Option<WorkspaceTarget>,
    },
    TestChannel {
        provider: BotProvider,
        channel: Box<BotChannelSettings>,
    },
    RestartListeners {
        #[serde(skip_serializing_if = "Option::is_none")]
        provider: Option<BotProvider>,
    },
    ListStatuses,
    OnboardingStart {
        provider: BotProvider,
        #[serde(skip_serializing_if = "Option::is_none")]
        brand: Option<OnboardingBrand>,
    },
    #[serde(rename_all = "camelCase")]
    OnboardingPoll {
        session_id: String,
    },
    #[serde(rename_all = "camelCase")]
    OnboardingFinish {
        session_id: String,
    },
    #[serde(rename_all = "camelCase")]
    OnboardingCancel {
        session_id: String,
    },
    #[serde(rename_all = "camelCase")]
    OnboardingUrl {
        session_id: String,
    },
    WechatBridgeQr {
        channel: Box<BotChannelSettings>,
    },
    Shutdown,
}

impl Command {
    pub(crate) fn name(&self) -> &'static str {
        match self {
            Self::ApplySettings { .. } => "apply_settings",
            Self::SetWorkspace { .. } => "set_workspace",
            Self::TestChannel { .. } => "test_channel",
            Self::RestartListeners { .. } => "restart_listeners",
            Self::ListStatuses => "list_statuses",
            Self::OnboardingStart { .. } => "onboarding_start",
            Self::OnboardingPoll { .. } => "onboarding_poll",
            Self::OnboardingFinish { .. } => "onboarding_finish",
            Self::OnboardingCancel { .. } => "onboarding_cancel",
            Self::OnboardingUrl { .. } => "onboarding_url",
            Self::WechatBridgeQr { .. } => "wechat_bridge_qr",
            Self::Shutdown => "shutdown",
        }
    }
}

/// One command line: `{"id": 1, "command": "...", ...}`.
pub(crate) fn encode_command(id: u64, command: &Command) -> Result<Vec<u8>, serde_json::Error> {
    #[derive(Serialize)]
    struct Line<'a> {
        id: u64,
        #[serde(flatten)]
        command: &'a Command,
    }
    let mut line = serde_json::to_vec(&Line { id, command })?;
    line.push(b'\n');
    Ok(line)
}

/// An event line: `{"event": "...", ...}`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub(crate) enum SidecarEvent {
    #[serde(rename_all = "camelCase")]
    Ready {
        protocol: u32,
        #[serde(default)]
        compatibility_epoch: Option<u32>,
        #[serde(default)]
        pid: Option<u32>,
    },
    Fatal {
        code: String,
        message: String,
    },
    Status(ChannelStatus),
    Host(HostLinkState),
    Log {
        level: LogLevel,
        message: String,
    },
    #[serde(other)]
    Unknown,
}

/// The answer to command `id`.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Answer {
    pub(crate) id: u64,
    /// The answer's other fields on success, the sidecar's refusal otherwise.
    pub(crate) result: Result<Value, SidecarRefusal>,
}

/// The sidecar could not run a command.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[non_exhaustive]
pub struct SidecarRefusal {
    /// `invalid_command`, `unknown_command`, `stopping`, or `failed`.
    pub code: String,
    pub message: String,
}

/// One stdout line of the sidecar.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum SidecarLine {
    Answer(Answer),
    Event(SidecarEvent),
}

/// Decodes one stdout line: an answer when it has an `id`, else an event.
pub(crate) fn decode_line(line: &str) -> Result<SidecarLine, serde_json::Error> {
    let value: Value = serde_json::from_str(line)?;
    let Some(id) = value.get("id").and_then(Value::as_u64) else {
        return serde_json::from_value(value).map(SidecarLine::Event);
    };
    let Value::Object(mut fields) = value else { unreachable!("a value with an id is an object") };
    fields.remove("id");
    let ok = fields.remove("ok").and_then(|ok| ok.as_bool()).unwrap_or(false);
    let result = if ok {
        Ok(Value::Object(fields))
    } else {
        Err(serde_json::from_value(fields.remove("error").unwrap_or(Value::Null)).unwrap_or(
            SidecarRefusal {
                code: "failed".into(),
                message: "the sidecar refused the command".into(),
            },
        ))
    };
    Ok(SidecarLine::Answer(Answer { id, result }))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    // Lines as sidecars/bots/main.mjs writes them, taken from a run against
    // a 197 Host (the smoke run in docs/bots-sidecar.md).
    const READY: &str = r#"{"event":"ready","protocol":1,"compatibilityEpoch":197,"pid":52953}"#;
    const STATUS: &str = r#"{"event":"status","status":{"platform":"telegram","running":true,"readiness":"credentials_valid","startedAt":1727500000000,"connection":"polling","identity":{"id":"4242","username":"maka_test_bot","displayName":"Maka Test"}}}"#;
    const CONFLICT: &str = r#"{"event":"status","status":{"platform":"telegram","running":false,"readiness":"scaffolded","reason":"disabled","connection":"none"},"conflict":{"kind":"polling","description":"Conflict: terminated by other getUpdates request; make sure that only one bot instance is running","detectedAt":1727500001000}}"#;
    const HOST: &str = r#"{"event":"host","state":"connected","rootId":"7af36cde97737d1186aad02c0f0ddf6e493daec24726ff5ce92d9b0733bbe831","hostEpoch":"fce3961e-1cdd-4153-a900-11c90b02d59b"}"#;

    #[test]
    fn events_decode() {
        assert_eq!(
            decode_line(READY).expect("ready"),
            SidecarLine::Event(SidecarEvent::Ready {
                protocol: 1,
                compatibility_epoch: Some(197),
                pid: Some(52953)
            })
        );
        let SidecarLine::Event(SidecarEvent::Status(status)) = decode_line(STATUS).expect("status")
        else {
            panic!("a status event");
        };
        assert_eq!(status.provider(), BotProvider::Telegram);
        assert!(status.status.running);
        assert_eq!(status.status.readiness, BotReadiness::CredentialsValid);
        assert_eq!(status.status.connection, BotConnection::Polling);
        assert_eq!(
            status.status.identity.and_then(|identity| identity.username).as_deref(),
            Some("maka_test_bot")
        );
        assert_eq!(status.conflict, None);
        let SidecarLine::Event(SidecarEvent::Status(suspended)) =
            decode_line(CONFLICT).expect("conflict")
        else {
            panic!("a status event");
        };
        let conflict = suspended.conflict.expect("conflict");
        assert_eq!(
            (conflict.kind, conflict.detected_at),
            (ConflictKind::Polling, 1_727_500_001_000)
        );
        assert!(matches!(
            decode_line(HOST).expect("host"),
            SidecarLine::Event(SidecarEvent::Host(HostLinkState::Connected { .. }))
        ));
        assert_eq!(
            decode_line(r#"{"event":"host","state":"disconnected","reason":"not_registered"}"#)
                .expect("disconnected"),
            SidecarLine::Event(SidecarEvent::Host(HostLinkState::Disconnected {
                reason: "not_registered".into()
            }))
        );
        assert_eq!(
            decode_line(r#"{"event":"something_new","x":1}"#).expect("unknown"),
            SidecarLine::Event(SidecarEvent::Unknown)
        );
    }

    #[test]
    fn answers_decode() {
        let SidecarLine::Answer(answer) =
            decode_line(r#"{"id":3,"ok":true,"result":{"ok":false,"errorCode":"token_invalid"}}"#)
                .expect("answer")
        else {
            panic!("an answer");
        };
        assert_eq!(answer.id, 3);
        let result: BotTestResult =
            serde_json::from_value(answer.result.expect("ok")["result"].clone())
                .expect("test result");
        assert_eq!(result.error_code.as_deref(), Some("token_invalid"));
        assert_eq!(
            decode_line(
                r#"{"id":4,"ok":false,"error":{"code":"unknown_command","message":"Unknown command"}}"#
            )
            .expect("refusal"),
            SidecarLine::Answer(Answer {
                id: 4,
                result: Err(SidecarRefusal {
                    code: "unknown_command".into(),
                    message: "Unknown command".into()
                })
            })
        );
    }

    // Answers recorded from sidecars/bots/sidecar.mjs driving a DingTalk
    // onboarding against test/fake-onboarding.mjs.
    const ONBOARDING_STARTED: &str = r#"{"id":5,"ok":true,"snapshot":{"sessionId":"4dd9821a-1268-4469-890b-afd47be61b6d","provider":"dingtalk","state":"waiting","qr":{"text":"https://open-dev.dingtalk.com/openapp/registration?code=abc"},"expiresAt":1790624703909,"nextPollAfterMs":1000,"canOpenInBrowser":true}}"#;
    const ONBOARDING_CONFIRMED: &str = r#"{"id":6,"ok":true,"snapshot":{"sessionId":"4dd9821a-1268-4469-890b-afd47be61b6d","provider":"dingtalk","state":"connecting","expiresAt":1790624703909,"nextPollAfterMs":0,"canOpenInBrowser":true,"identity":{"id":"ding-app"}},"channel":{"enabled":true,"connected":false,"readiness":"configured","readinessUpdatedAt":1790617505018,"appId":"ding-app","appSecret":"ding-secret"}}"#;
    const ONBOARDING_FINISHED: &str = r#"{"id":7,"ok":true,"snapshot":{"sessionId":"4dd9821a-1268-4469-890b-afd47be61b6d","provider":"dingtalk","state":"connected","expiresAt":1790624703909,"nextPollAfterMs":0,"canOpenInBrowser":true,"identity":{"id":"ding-app"},"warningCode":"saved_not_connected","warningDetail":"disabled"}}"#;
    const WECHAT_BRIDGE_REFUSED: &str = r#"{"id":8,"ok":true,"result":{"ok":false,"error":"WeChat bridge URL must be http://127.0.0.1 or http://localhost","hintCode":"wechat_bridge_remote_url"}}"#;

    fn answer_fields(line: &str) -> Value {
        let SidecarLine::Answer(answer) = decode_line(line).expect("answer") else {
            panic!("an answer");
        };
        answer.result.expect("ok")
    }

    #[test]
    fn onboarding_answers_decode() {
        let started: OnboardingSnapshot =
            serde_json::from_value(answer_fields(ONBOARDING_STARTED)["snapshot"].clone())
                .expect("snapshot");
        assert_eq!(started.provider, BotProvider::Dingtalk);
        assert_eq!(started.state, OnboardingState::Waiting);
        assert!(started.state.is_pending());
        assert_eq!(
            started.qr,
            Some(OnboardingQr::Text(
                "https://open-dev.dingtalk.com/openapp/registration?code=abc".into()
            ))
        );
        assert_eq!((started.next_poll_after_ms, started.can_open_in_browser), (1000, true));
        assert_eq!(started.expires_at, Some(1_790_624_703_909));

        let mut fields = answer_fields(ONBOARDING_CONFIRMED);
        let snapshot: OnboardingSnapshot =
            serde_json::from_value(fields["snapshot"].take()).expect("snapshot");
        assert_eq!(snapshot.state, OnboardingState::Connecting);
        assert_eq!(snapshot.qr, None);
        let channel: OnboardingChannel =
            serde_json::from_value(fields["channel"].take()).expect("channel");
        assert!(!format!("{channel:?}").contains("ding-secret"), "no secret in Debug");
        let mut dingtalk = BotChannelSettings::new(BotProvider::Dingtalk);
        dingtalk.last_error = Some("token_invalid".into());
        dingtalk.readiness_reason = Some("token_invalid".into());
        channel.apply(&mut dingtalk, 1);
        assert!(dingtalk.enabled && !dingtalk.connected);
        assert_eq!(dingtalk.readiness, Some(BotReadiness::Configured));
        assert_eq!(dingtalk.readiness_updated_at, Some(1_790_617_505_018));
        assert_eq!(
            (dingtalk.app_id.as_deref(), dingtalk.app_secret.as_deref()),
            (Some("ding-app"), Some("ding-secret"))
        );
        assert_eq!((dingtalk.last_error, dingtalk.readiness_reason), (None, None));
        assert_eq!(dingtalk.token, "", "fields the scan did not set are kept");

        let finished: OnboardingSnapshot =
            serde_json::from_value(answer_fields(ONBOARDING_FINISHED)["snapshot"].clone())
                .expect("snapshot");
        assert_eq!(finished.state, OnboardingState::Connected);
        assert_eq!(finished.warning_code.as_deref(), Some("saved_not_connected"));
        assert_eq!(finished.identity.and_then(|identity| identity.id).as_deref(), Some("ding-app"));

        let bridge: WechatBridgeQr =
            serde_json::from_value(answer_fields(WECHAT_BRIDGE_REFUSED)["result"].clone())
                .expect("bridge");
        assert!(!bridge.ok);
        assert_eq!(bridge.hint_code.as_deref(), Some("wechat_bridge_remote_url"));
        let image: OnboardingQr =
            serde_json::from_value(json!({ "image": "data:image/png;base64,AAAA" })).expect("qr");
        assert_eq!(image, OnboardingQr::Image("data:image/png;base64,AAAA".into()));
        let state: OnboardingState = serde_json::from_value(json!("rewound")).expect("state");
        assert_eq!(state, OnboardingState::Unknown);
    }

    #[test]
    fn commands_encode_as_the_sidecar_reads_them() {
        let line =
            encode_command(7, &Command::RestartListeners { provider: Some(BotProvider::Qq) })
                .expect("encode");
        assert_eq!(line.last(), Some(&b'\n'));
        let value: Value = serde_json::from_slice(&line).expect("json");
        assert_eq!(value, json!({ "id": 7, "command": "restart_listeners", "provider": "qq" }));
        let value: Value = serde_json::from_slice(
            &encode_command(8, &Command::RestartListeners { provider: None }).expect("encode"),
        )
        .expect("json");
        assert_eq!(value, json!({ "id": 8, "command": "restart_listeners" }));
        let workspace = WorkspaceTarget::Project { project_id: "p1".into() };
        let value: Value = serde_json::from_slice(
            &encode_command(9, &Command::SetWorkspace { workspace: Some(workspace) })
                .expect("encode"),
        )
        .expect("json");
        assert_eq!(
            value,
            json!({ "id": 9, "command": "set_workspace", "workspace": { "kind": "project", "projectId": "p1" } })
        );
        let value: Value = serde_json::from_slice(
            &encode_command(10, &Command::ApplySettings { settings: Box::default() })
                .expect("encode"),
        )
        .expect("json");
        assert_eq!(value["command"], "apply_settings");
        assert_eq!(value["settings"]["channels"]["slack"]["provider"], "slack");
        let value: Value = serde_json::from_slice(
            &encode_command(
                11,
                &Command::OnboardingStart {
                    provider: BotProvider::Feishu,
                    brand: Some(OnboardingBrand::Lark),
                },
            )
            .expect("encode"),
        )
        .expect("json");
        assert_eq!(
            value,
            json!({ "id": 11, "command": "onboarding_start", "provider": "feishu", "brand": "lark" })
        );
        let value: Value = serde_json::from_slice(
            &encode_command(12, &Command::OnboardingPoll { session_id: "s-1".into() })
                .expect("encode"),
        )
        .expect("json");
        assert_eq!(value, json!({ "id": 12, "command": "onboarding_poll", "sessionId": "s-1" }));
    }
}
