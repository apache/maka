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

//! The chat bot settings and the file that keeps them.
//!
//! The shape is Maka Desktop's `BotChatSettings`
//! (`packages/core/src/bot-chat-settings.ts`), which Desktop keeps inside its
//! plaintext settings file. This client keeps it in `bot-chat.json` in its
//! config directory, owner-only because it holds bot tokens, and hands it to
//! the sidecar with `apply_settings`; the sidecar never reads or writes the
//! file. Normalization (readiness derived from the credentials, the allowlist
//! trimmed) is Maka's own: the sidecar runs `normalizeBotChatSettings` on
//! what it receives, so this side only keeps the fields and fills in the
//! channels a file lacks.

use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use thiserror::Error;

use crate::protocol::BotTestResult;

/// The settings file name in the client's config directory.
pub const BOT_SETTINGS_FILE: &str = "bot-chat.json";

/// Larger than any settings file this client writes; anything bigger is not
/// ours.
const MAX_SETTINGS_BYTES: u64 = 1024 * 1024;

/// `BotProvider`: a chat platform, in `BOT_PROVIDERS` order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BotProvider {
    Telegram,
    Feishu,
    Wecom,
    Wechat,
    Discord,
    Dingtalk,
    Qq,
    Slack,
}

impl BotProvider {
    /// Every provider, in `BOT_PROVIDERS` order.
    pub const ALL: [Self; 8] = [
        Self::Telegram,
        Self::Feishu,
        Self::Wecom,
        Self::Wechat,
        Self::Discord,
        Self::Dingtalk,
        Self::Qq,
        Self::Slack,
    ];

    /// The wire name, e.g. `telegram`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Telegram => "telegram",
            Self::Feishu => "feishu",
            Self::Wecom => "wecom",
            Self::Wechat => "wechat",
            Self::Discord => "discord",
            Self::Dingtalk => "dingtalk",
            Self::Qq => "qq",
            Self::Slack => "slack",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|provider| provider.as_str() == name)
    }

    /// Whether Maka can set this platform up by QR code
    /// (`BOT_ONBOARDING_PROVIDERS` in packages/core/src/bot-onboarding.ts).
    pub fn has_onboarding(self) -> bool {
        matches!(self, Self::Dingtalk | Self::Feishu | Self::Wecom | Self::Wechat | Self::Qq)
    }
}

/// The most user ids an allowlist keeps (`MAX_ALLOWED_USER_IDS` in
/// packages/core/src/bot-chat-settings.ts).
pub const MAX_ALLOWED_USER_IDS: usize = 50;

/// `parseAllowedUserIdsFromText`: one id per line, trimmed, blank lines and
/// repeats dropped, at most [`MAX_ALLOWED_USER_IDS`].
pub fn parse_allowed_user_ids(text: &str) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    for line in text.split('\n') {
        let id = line.trim();
        if id.is_empty() || ids.iter().any(|seen| seen == id) {
            continue;
        }
        ids.push(id.to_owned());
        if ids.len() >= MAX_ALLOWED_USER_IDS {
            break;
        }
    }
    ids
}

/// `BotReadinessState` (`BOT_READINESS_STATES`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum BotReadiness {
    Unscaffolded,
    Scaffolded,
    Configured,
    CredentialsValid,
    Operational,
    Degraded,
    /// A state this client does not recognize.
    #[serde(other, skip_serializing)]
    Unknown,
}

/// `BotChannelSettings`: one platform's credentials and state.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct BotChannelSettings {
    pub provider: BotProvider,
    #[serde(default)]
    pub enabled: bool,
    /// The legacy credential-test flag; `readiness` supersedes it.
    #[serde(default)]
    pub connected: bool,
    /// Left out when unknown: the sidecar derives it from the credentials,
    /// as `normalizeBotChatSettings` does for a file without one.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "known_readiness"
    )]
    pub readiness: Option<BotReadiness>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub readiness_reason: Option<String>,
    /// Milliseconds since the Unix epoch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub readiness_updated_at: Option<u64>,
    #[serde(default)]
    pub token: String,
    #[serde(default)]
    pub proxy_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub webhook_url: Option<String>,
    /// The public callback domain set in the platform console.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub domain: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_secret: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bot_user_id: Option<String>,
    /// Milliseconds since the Unix epoch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_test_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    /// Platform user ids allowed to message the bot; none or empty means
    /// anyone. Strings, because Telegram ids exceed 2^53.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allowed_user_ids: Option<Vec<String>>,
}

impl BotChannelSettings {
    /// `createDefaultBotChannel`: disabled, without credentials.
    pub fn new(provider: BotProvider) -> Self {
        Self {
            provider,
            enabled: false,
            connected: false,
            readiness: Some(BotReadiness::Scaffolded),
            readiness_reason: None,
            readiness_updated_at: None,
            token: String::new(),
            proxy_url: if provider == BotProvider::Telegram {
                "http://127.0.0.1:7890".to_owned()
            } else {
                String::new()
            },
            webhook_url: (provider == BotProvider::Wechat)
                .then(|| "http://127.0.0.1:18400".to_owned()),
            domain: None,
            app_id: None,
            app_secret: None,
            bot_user_id: None,
            last_test_at: None,
            last_error: None,
            allowed_user_ids: None,
        }
    }

    /// `hasBotChannelCredentials`: whether any credential is filled in (both
    /// tokens for Slack; the bridge address counts for WeChat).
    pub fn has_credentials(&self) -> bool {
        let filled =
            |value: &Option<String>| value.as_deref().is_some_and(|v| !v.trim().is_empty());
        if self.provider == BotProvider::Slack {
            return !self.token.trim().is_empty() && filled(&self.app_secret);
        }
        if !self.token.trim().is_empty()
            || self.app_id.as_deref().is_some_and(|v| !v.is_empty())
            || self.app_secret.as_deref().is_some_and(|v| !v.is_empty())
        {
            return true;
        }
        self.provider == BotProvider::Wechat && filled(&self.webhook_url)
    }

    /// The readiness as `normalizeBotChatSettings` settles it: the saved one
    /// (derived when missing, `readinessFromChannel`), and never one that
    /// claims credentials a channel without any has
    /// (`coerceReadinessForCurrentState`).
    pub fn effective_readiness(&self) -> BotReadiness {
        let has_credentials = self.has_credentials();
        let candidate = self.readiness.unwrap_or(if self.enabled && has_credentials {
            BotReadiness::Configured
        } else {
            BotReadiness::Scaffolded
        });
        let claims_credentials = matches!(
            candidate,
            BotReadiness::Configured
                | BotReadiness::CredentialsValid
                | BotReadiness::Operational
                | BotReadiness::Degraded
        );
        if claims_credentials && !has_credentials { BotReadiness::Scaffolded } else { candidate }
    }

    /// What a page may show of the channel: everything but its secrets.
    pub fn summary(&self) -> ChannelSummary {
        let saved = |value: &Option<String>| value.as_deref().is_some_and(|v| !v.is_empty());
        ChannelSummary {
            provider: self.provider,
            enabled: self.enabled,
            connected: self.connected,
            readiness: self.effective_readiness(),
            readiness_reason: self.readiness_reason.clone(),
            last_test_at: self.last_test_at,
            last_error: self.last_error.clone(),
            has_token: !self.token.is_empty(),
            has_app_secret: saved(&self.app_secret),
            app_id: self.app_id.clone().unwrap_or_default(),
            domain: self.domain.clone(),
            proxy_url: self.proxy_url.clone(),
            webhook_url: self.webhook_url.clone().unwrap_or_default(),
            bot_user_id: self.bot_user_id.clone(),
            allowed_user_ids: self.allowed_user_ids.clone().unwrap_or_default(),
        }
    }

    /// Records a channel test the way `settings:testBotChannel` does
    /// (apps/desktop/src/main/settings-bots-ipc-main.ts). A result that could
    /// not verify the credentials against the platform (`verified: false`)
    /// only stamps the time, so it never downgrades a working channel.
    pub fn record_test(&mut self, result: &BotTestResult, now_ms: u64) {
        self.last_test_at = Some(now_ms);
        if result.verified == Some(false) {
            return;
        }
        let failure = (!result.ok)
            .then(|| result.error_code.clone().unwrap_or_else(|| "connection_failed".into()));
        self.connected = result.ok;
        self.readiness =
            Some(if result.ok { BotReadiness::CredentialsValid } else { BotReadiness::Configured });
        self.readiness_reason = failure.clone();
        self.readiness_updated_at = Some(now_ms);
        self.last_error = failure;
    }
}

/// A channel as a settings page shows it ([`BotChannelSettings::summary`]):
/// its state and its plain fields, and only whether each secret (the bot
/// token, the app secret) is saved, never the secret itself.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct ChannelSummary {
    pub provider: BotProvider,
    pub enabled: bool,
    pub connected: bool,
    /// [`BotChannelSettings::effective_readiness`].
    pub readiness: BotReadiness,
    pub readiness_reason: Option<String>,
    pub last_test_at: Option<u64>,
    pub last_error: Option<String>,
    pub has_token: bool,
    pub has_app_secret: bool,
    pub app_id: String,
    pub domain: Option<String>,
    pub proxy_url: String,
    pub webhook_url: String,
    pub bot_user_id: Option<String>,
    pub allowed_user_ids: Vec<String>,
}

/// `BotChatSettings`: every platform's channel.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BotChatSettings {
    channels: BTreeMap<BotProvider, BotChannelSettings>,
}

impl Default for BotChatSettings {
    /// `createDefaultBotChatSettings`.
    fn default() -> Self {
        Self {
            channels: BotProvider::ALL
                .into_iter()
                .map(|provider| (provider, BotChannelSettings::new(provider)))
                .collect(),
        }
    }
}

impl BotChatSettings {
    pub fn channel(&self, provider: BotProvider) -> &BotChannelSettings {
        &self.channels[&provider]
    }

    pub fn channel_mut(&mut self, provider: BotProvider) -> &mut BotChannelSettings {
        self.channels.entry(provider).or_insert_with(|| BotChannelSettings::new(provider))
    }

    /// Every channel, in `BOT_PROVIDERS` order.
    pub fn channels(&self) -> impl Iterator<Item = &BotChannelSettings> {
        self.channels.values()
    }
}

impl<'de> Deserialize<'de> for BotChatSettings {
    /// Reads the channels a file has, each under its provider (a channel's
    /// own `provider` field is ignored, as `normalizeBotChatSettings` ignores
    /// it), and fills the rest with defaults. Unknown providers are dropped.
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        struct Raw {
            #[serde(default)]
            channels: serde_json::Map<String, Value>,
        }
        let raw = Raw::deserialize(deserializer)?;
        let mut settings = Self::default();
        for (name, value) in raw.channels {
            let Some(provider) = BotProvider::from_name(&name) else { continue };
            let Value::Object(mut fields) = value else {
                return Err(serde::de::Error::custom(format!("channel {name} is not an object")));
            };
            fields.insert("provider".to_owned(), Value::from(name));
            let channel = BotChannelSettings::deserialize(Value::Object(fields))
                .map_err(serde::de::Error::custom)?;
            settings.channels.insert(provider, channel);
        }
        Ok(settings)
    }
}

/// A readiness this client knows, or none: an unknown state is left for the
/// sidecar to derive, as `normalizeBotChatSettings` replaces one that fails
/// `isBotReadinessState`.
fn known_readiness<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<BotReadiness>, D::Error> {
    let value = Option::<Value>::deserialize(deserializer)?;
    Ok(value
        .and_then(|value| BotReadiness::deserialize(value).ok())
        .filter(|readiness| *readiness != BotReadiness::Unknown))
}

/// A failure to read or write the settings file.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum BotSettingsError {
    #[error("cannot determine the platform config directory")]
    NoConfigDirectory,
    #[error("failed to access the bot settings at {}", path.display())]
    Io {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    /// The file is not the settings this client writes. It is left alone,
    /// never replaced with defaults: it may hold the only copy of a token.
    #[error("the bot settings at {} are invalid: {reason}", path.display())]
    Invalid { path: PathBuf, reason: String },
}

/// `bot-chat.json`: read whole, replaced whole, owner-only.
#[derive(Debug)]
pub struct BotSettingsStore {
    path: PathBuf,
    writes: async_lock::Mutex<()>,
}

impl BotSettingsStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into(), writes: async_lock::Mutex::new(()) }
    }

    /// The file in the client's config directory, beside
    /// `client-instance-id` (on macOS
    /// `~/Library/Application Support/maka-gpui/bot-chat.json`).
    pub fn in_config_directory() -> Result<Self, BotSettingsError> {
        let config = dirs::config_dir().ok_or(BotSettingsError::NoConfigDirectory)?;
        Ok(Self::new(config.join(host_client::CLIENT_CONFIG_DIRECTORY).join(BOT_SETTINGS_FILE)))
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The saved settings, or the defaults when there is no file yet.
    pub async fn load(&self) -> Result<BotChatSettings, BotSettingsError> {
        let metadata = match async_fs::symlink_metadata(&self.path).await {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Ok(BotChatSettings::default());
            }
            Err(source) => return Err(BotSettingsError::Io { path: self.path.clone(), source }),
        };
        if !metadata.is_file() || metadata.len() > MAX_SETTINGS_BYTES {
            return Err(self.invalid("not a regular file within its size limit"));
        }
        let bytes = async_fs::read(&self.path)
            .await
            .map_err(|source| BotSettingsError::Io { path: self.path.clone(), source })?;
        serde_json::from_slice(&bytes).map_err(|error| self.invalid(error.to_string()))
    }

    /// Replaces the file with `settings`.
    pub async fn save(&self, settings: &BotChatSettings) -> Result<(), BotSettingsError> {
        let _guard = self.writes.lock().await;
        self.write(settings).await
    }

    /// Reads the settings, applies `change`, and writes them back, with no
    /// other write of this store in between. Returns what was written.
    pub async fn update(
        &self,
        change: impl FnOnce(&mut BotChatSettings),
    ) -> Result<BotChatSettings, BotSettingsError> {
        let _guard = self.writes.lock().await;
        let mut settings = self.load().await?;
        change(&mut settings);
        self.write(&settings).await?;
        Ok(settings)
    }

    async fn write(&self, settings: &BotChatSettings) -> Result<(), BotSettingsError> {
        let mut bytes = serde_json::to_vec_pretty(settings).map_err(|error| {
            BotSettingsError::Io { path: self.path.clone(), source: error.into() }
        })?;
        bytes.push(b'\n');
        write_private(&self.path, &bytes)
            .await
            .map_err(|source| BotSettingsError::Io { path: self.path.clone(), source })
    }

    fn invalid(&self, reason: impl Into<String>) -> BotSettingsError {
        BotSettingsError::Invalid { path: self.path.clone(), reason: reason.into() }
    }
}

/// Writes `bytes` to a new 0600 file beside `path` and renames it over
/// `path`, creating the directory (0700) first.
async fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    use futures_lite::AsyncWriteExt as _;

    let directory = path.parent().unwrap_or(Path::new("."));
    let mut builder = async_fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use async_fs::unix::DirBuilderExt as _;
        builder.mode(0o700);
    }
    builder.create(directory).await?;
    let name = path.file_name().map(|name| name.to_string_lossy()).unwrap_or_default();
    let temporary = directory.join(format!(".{name}-{}.tmp", uuid::Uuid::new_v4().simple()));
    let mut options = async_fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use async_fs::unix::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let written = async {
        let mut file = options.open(&temporary).await?;
        file.write_all(bytes).await?;
        file.flush().await?;
        file.sync_all().await?;
        drop(file);
        async_fs::rename(&temporary, path).await
    }
    .await;
    if written.is_err() {
        let _ = async_fs::remove_file(&temporary).await;
    }
    written
}

#[cfg(test)]
// Test setup reads fixture files synchronously; no UI thread is involved.
#[allow(clippy::disallowed_methods)]
mod tests {
    use std::fs;

    use futures_lite::future::block_on;
    use serde_json::json;

    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("bots-settings-{name}-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    #[test]
    fn defaults_match_create_default_bot_chat_settings() {
        let settings = BotChatSettings::default();
        assert_eq!(settings.channels().count(), 8);
        let providers: Vec<_> = settings.channels().map(|channel| channel.provider).collect();
        assert_eq!(providers, BotProvider::ALL);
        let value = serde_json::to_value(&settings).expect("serialize");
        assert_eq!(
            value["channels"]["telegram"],
            json!({
                "provider": "telegram",
                "enabled": false,
                "connected": false,
                "readiness": "scaffolded",
                "token": "",
                "proxyUrl": "http://127.0.0.1:7890"
            })
        );
        assert_eq!(value["channels"]["wechat"]["webhookUrl"], "http://127.0.0.1:18400");
        assert_eq!(value["channels"]["slack"]["proxyUrl"], "");
    }

    #[test]
    fn a_partial_file_keeps_its_channels_and_fills_the_rest() {
        let settings: BotChatSettings = serde_json::from_value(json!({
            "channels": {
                "telegram": {
                    "provider": "slack",
                    "enabled": true,
                    "token": "123:abc",
                    "readiness": "a-state-from-the-future",
                    "allowedUserIds": ["42"],
                    "someFutureField": 1
                },
                "fax": { "enabled": true }
            }
        }))
        .expect("decode");
        let telegram = settings.channel(BotProvider::Telegram);
        assert_eq!(telegram.provider, BotProvider::Telegram);
        assert!(telegram.enabled);
        assert_eq!(telegram.token, "123:abc");
        assert_eq!(telegram.readiness, None);
        assert_eq!(telegram.proxy_url, "");
        assert_eq!(telegram.allowed_user_ids.as_deref(), Some(&["42".to_owned()][..]));
        assert_eq!(
            settings.channel(BotProvider::Feishu),
            &BotChannelSettings::new(BotProvider::Feishu)
        );
        let value = serde_json::to_value(&settings).expect("serialize");
        assert!(value["channels"]["telegram"].get("readiness").is_none());
        assert!(value["channels"].get("fax").is_none());
    }

    #[test]
    fn a_test_result_is_recorded_as_desktop_records_it() {
        let passed: BotTestResult = serde_json::from_value(json!({
            "ok": true,
            "identity": { "id": "1", "username": "bot" },
            "messageSent": false
        }))
        .expect("result");
        let mut channel = BotChannelSettings::new(BotProvider::Telegram);
        channel.record_test(&passed, 1_000);
        assert!(channel.connected);
        assert_eq!(channel.readiness, Some(BotReadiness::CredentialsValid));
        assert_eq!(
            (channel.readiness_reason.as_deref(), channel.last_error.as_deref()),
            (None, None)
        );
        assert_eq!(
            (channel.readiness_updated_at, channel.last_test_at),
            (Some(1_000), Some(1_000))
        );

        let failed: BotTestResult =
            serde_json::from_value(json!({ "ok": false, "errorCode": "token_invalid" }))
                .expect("result");
        channel.record_test(&failed, 2_000);
        assert!(!channel.connected);
        assert_eq!(channel.readiness, Some(BotReadiness::Configured));
        assert_eq!(channel.readiness_reason.as_deref(), Some("token_invalid"));
        assert_eq!(channel.last_error.as_deref(), Some("token_invalid"));

        let unverified: BotTestResult =
            serde_json::from_value(json!({ "ok": true, "verified": false })).expect("result");
        channel.record_test(&unverified, 3_000);
        assert_eq!(channel.readiness, Some(BotReadiness::Configured));
        assert_eq!(
            (channel.readiness_updated_at, channel.last_test_at),
            (Some(2_000), Some(3_000))
        );

        let failed_without_code: BotTestResult =
            serde_json::from_value(json!({ "ok": false })).expect("result");
        channel.record_test(&failed_without_code, 4_000);
        assert_eq!(channel.last_error.as_deref(), Some("connection_failed"));
    }

    #[test]
    fn the_readiness_shown_is_the_one_maka_settles_on() {
        let mut telegram = BotChannelSettings::new(BotProvider::Telegram);
        assert_eq!(telegram.effective_readiness(), BotReadiness::Scaffolded);
        telegram.readiness = None;
        telegram.enabled = true;
        telegram.token = "123:abc".into();
        assert_eq!(telegram.effective_readiness(), BotReadiness::Configured);
        telegram.readiness = Some(BotReadiness::CredentialsValid);
        assert_eq!(telegram.effective_readiness(), BotReadiness::CredentialsValid);
        // Cleared credentials take the claim with them.
        telegram.token.clear();
        assert_eq!(telegram.effective_readiness(), BotReadiness::Scaffolded);
        let mut slack = BotChannelSettings::new(BotProvider::Slack);
        slack.token = "xoxb-1".into();
        assert!(!slack.has_credentials(), "Slack needs both tokens");
        slack.app_secret = Some("xapp-1".into());
        assert!(slack.has_credentials());
        assert!(BotChannelSettings::new(BotProvider::Wechat).has_credentials(), "the bridge URL");
    }

    #[test]
    fn a_summary_says_whether_a_secret_is_saved_but_not_what_it_is() {
        let mut feishu = BotChannelSettings::new(BotProvider::Feishu);
        feishu.app_id = Some("cli_123".into());
        feishu.app_secret = Some("feishu-secret".into());
        feishu.token = "unused-token".into();
        let summary = feishu.summary();
        assert!(summary.has_app_secret && summary.has_token);
        assert_eq!(summary.app_id, "cli_123");
        let shown = format!("{summary:?}");
        assert!(!shown.contains("feishu-secret") && !shown.contains("unused-token"), "{shown}");
        assert!(!BotChannelSettings::new(BotProvider::Feishu).summary().has_app_secret);
    }

    #[test]
    fn allowed_user_ids_parse_as_desktop_parses_them() {
        assert_eq!(parse_allowed_user_ids(" 42\n\n7\n42\n@alice "), ["42", "7", "@alice"]);
        let many: String = (0..60).map(|n| format!("{n}\n")).collect();
        assert_eq!(parse_allowed_user_ids(&many).len(), MAX_ALLOWED_USER_IDS);
        assert!(parse_allowed_user_ids("").is_empty());
    }

    #[test]
    fn the_store_writes_an_owner_only_file_and_reads_it_back() {
        let dir = scratch("store");
        let store = BotSettingsStore::new(dir.join("nested").join(BOT_SETTINGS_FILE));
        assert_eq!(block_on(store.load()).expect("defaults"), BotChatSettings::default());
        let written = block_on(store.update(|settings| {
            let telegram = settings.channel_mut(BotProvider::Telegram);
            telegram.enabled = true;
            telegram.token = "123:abc".into();
        }))
        .expect("update");
        assert_eq!(block_on(store.load()).expect("reload"), written);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = fs::metadata(store.path()).expect("file").permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
            let mode = fs::metadata(dir.join("nested")).expect("dir").permissions().mode();
            assert_eq!(mode & 0o777, 0o700);
        }

        // A file that is not ours is reported, and not replaced.
        fs::write(store.path(), b"{ not json").expect("corrupt");
        assert!(matches!(block_on(store.load()), Err(BotSettingsError::Invalid { .. })));
        assert!(block_on(store.update(|_| {})).is_err());
        assert_eq!(fs::read(store.path()).expect("kept"), b"{ not json");
        fs::remove_dir_all(dir).ok();
    }
}
