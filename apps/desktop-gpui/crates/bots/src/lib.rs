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

//! Remote access through chat bots.
//!
//! Maka Desktop runs its chat bots (Telegram, 飞书/Lark, 企业微信, 微信,
//! Discord, 钉钉, QQ, Slack) inside its Electron main process with the
//! plain-Node package `@maka/runtime/bots`. This client runs the same package
//! in a Node sidecar from the Maka checkout it launches its Runtime Host from
//! (`sidecars/bots/`), and keeps only the settings and the supervision here.
//! `docs/bots-sidecar.md` describes the sidecar and its stdio protocol.
//!
//! - [`BotSettingsStore`] keeps [`BotChatSettings`] in `bot-chat.json` in
//!   the client's config directory, owner-only.
//! - [`prepare_launch`] checks that the Host is local, takes the State Root's
//!   [`InstanceLock`], and finds the checkout and Node; [`supervise`] runs the
//!   sidecar, restarts it with backoff, and carries commands
//!   ([`BotHandle`]) and events ([`BotEvent`]). Neither uses GPUI.
//! - [`BotService`] wraps both as a GPUI entity: it runs the sidecar while a
//!   channel is enabled (or a settings page holds it), and offers the
//!   settings actions a settings page needs, the QR onboarding included,
//!   without ever handing a page a secret ([`ChannelSummary`]).
//! - `testing` (feature `test-support`) stands in for the sidecar in tests.

mod instance_lock;
mod launch;
mod protocol;
mod service;
mod settings;
mod sidecar;
mod supervisor;
#[cfg(any(test, feature = "test-support"))]
pub mod testing;

#[cfg(test)]
mod service_tests;

pub use instance_lock::{InstanceLock, InstanceLockError, default_lock_directory};
pub use launch::{BotHost, LaunchOptions, LaunchRefusal, PreparedLaunch, prepare_launch};
pub use protocol::{
    BotConnection, BotIdentity, BotStatus, BotTestResult, ChannelConflict, ChannelStatus,
    ConflictKind, HostLinkState, LogLevel, OnboardingBrand, OnboardingIdentity, OnboardingQr,
    OnboardingSnapshot, OnboardingState, RetryHealth, SIDECAR_PROTOCOL_VERSION, SidecarRefusal,
    WechatBridgeQr,
};
pub use service::{
    BotLauncher, BotService, BotServiceError, BotServiceEvent, BotServiceState, launcher,
};
pub use settings::{
    BOT_SETTINGS_FILE, BotChannelSettings, BotChatSettings, BotProvider, BotReadiness,
    BotSettingsError, BotSettingsStore, ChannelSummary, MAX_ALLOWED_USER_IDS,
    parse_allowed_user_ids,
};
pub use sidecar::{
    BOTS_BUILD_MARKER, SidecarCommand, default_cache_directory, materialize_sidecar,
};
pub use supervisor::{
    BotCommandError, BotEvent, BotHandle, BotRun, EVENT_CHANNEL_CAPACITY, RestartPolicy,
    SupervisedBots, supervise,
};
