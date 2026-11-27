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

use crate::model::{
    AdminCommand, AdminSnapshot, HostEntry, LocalRelayConfig, LogLevel, LogSnapshot, TabId,
    ToastNotice, ToastTone,
};
use nsh_core::prelude::*;
use std::path::PathBuf;
use uuid::Uuid;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum LogFilter {
    #[default]
    All,
    Error,
    Warn,
    Info,
    Debug,
}

impl LogFilter {
    pub const ALL: [Self; 5] = [Self::All, Self::Error, Self::Warn, Self::Info, Self::Debug];

    pub const fn label(self) -> &'static str {
        match self {
            Self::All => "ALL",
            Self::Error => "ERR",
            Self::Warn => "WRN",
            Self::Info => "INF",
            Self::Debug => "DBG",
        }
    }

    pub fn matches(self, level: LogLevel) -> bool {
        match self {
            Self::All => true,
            Self::Error => level == LogLevel::Error,
            Self::Warn => matches!(level, LogLevel::Error | LogLevel::Warn),
            Self::Info => matches!(level, LogLevel::Error | LogLevel::Warn | LogLevel::Info),
            Self::Debug => level != LogLevel::Trace,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConfirmSpec {
    pub title: String,
    pub body: String,
    pub confirm_label: String,
    pub destructive: bool,
    pub command: AdminCommand,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum Overlay {
    #[default]
    None,
    Help,
    CommandPalette {
        query: String,
        selected: usize,
    },
    Confirm(ConfirmSpec),
    AddRelay {
        root_path: PathBuf,
        url: String,
        quic_port: String,
        cert_sha256: String,
        ca_der_path: String,
        auth_token: String,
        error: Option<String>,
    },
    CreateInvite {
        root_path: PathBuf,
        host_name: String,
        label: String,
        ttl_secs: String,
        error: Option<String>,
    },
    InitRoot {
        root_path: String,
        error: Option<String>,
    },
    InstallHost {
        root_path: PathBuf,
        mode: String,
        error: Option<String>,
    },
    PrepareAccess {
        root_path: PathBuf,
        principal: String,
        error: Option<String>,
    },
    RevokeCredential {
        root_path: PathBuf,
        credential_id: String,
        error: Option<String>,
    },
    ConfigureLocalRelay {
        draft: LocalRelayConfig,
        error: Option<String>,
    },
}

impl Overlay {
    pub fn is_open(&self) -> bool {
        !matches!(self, Self::None)
    }
}

#[derive(Clone, Default)]
pub struct SnapshotStore(pub AdminSnapshot);

#[derive(Clone, Default)]
pub struct LogsStore(pub LogSnapshot);

#[derive(Clone, Default)]
pub struct ToastStore(pub Option<ToastNotice>);

#[derive(Clone)]
pub struct UiStore {
    pub tab: TabId,
    pub log_filter: LogFilter,
    pub log_search: String,
    pub overlay: Overlay,
    pub local_toast_seq: u64,
    pub host_scroll_anchor: usize,
}

impl Default for UiStore {
    fn default() -> Self {
        Self {
            tab: TabId::Overview,
            log_filter: LogFilter::All,
            log_search: String::new(),
            overlay: Overlay::None,
            local_toast_seq: 100_000,
            host_scroll_anchor: 0,
        }
    }
}

pub fn snapshot_signal() -> Signal<SnapshotStore> {
    global::<SnapshotStore>()
}

pub fn logs_signal() -> Signal<LogsStore> {
    global::<LogsStore>()
}

pub fn toast_signal() -> Signal<ToastStore> {
    global::<ToastStore>()
}

pub fn ui_signal() -> Signal<UiStore> {
    global::<UiStore>()
}

pub fn active_tab() -> TabId {
    ui_signal().with(|u| u.tab)
}

pub fn set_tab(tab: TabId) {
    ui_signal().update(|u| {
        u.tab = tab;
    });
}

pub fn selected_host() -> Option<HostEntry> {
    snapshot_signal().with(|s| s.0.selected_host().cloned())
}

pub fn send_command(cmd: AdminCommand) {
    if let Ok(value) = serde_json::to_value(cmd) {
        host_post("command", value);
    }
}

pub fn show_toast(tone: ToastTone, message: impl Into<String>) {
    let msg = message.into();
    let id = {
        let mut next = 0;
        ui_signal().update(|u| {
            u.local_toast_seq += 1;
            next = u.local_toast_seq;
        });
        next
    };
    toast_signal().set(ToastStore(Some(ToastNotice {
        id,
        tone,
        message: msg,
    })));
    set_timeout(std::time::Duration::from_secs(5), move || {
        toast_signal().update(|t| {
            if t.0.as_ref().is_some_and(|n| n.id == id) {
                t.0 = None;
            }
        });
    });
}

pub fn copy_text(label: &str, value: &str) {
    let answer = set_clipboard(value);
    spawn(async move {
        let _ = answer.await;
    });
    show_toast(ToastTone::Success, format!("Copied {label} to clipboard"));
}

pub fn open_overlay(overlay: Overlay) {
    ui_signal().update(|u| {
        u.overlay = overlay;
    });
}

pub fn close_overlay() {
    ui_signal().update(|u| {
        u.overlay = Overlay::None;
    });
}

pub fn open_confirm(
    title: impl Into<String>,
    body: impl Into<String>,
    confirm_label: impl Into<String>,
    destructive: bool,
    command: AdminCommand,
) {
    open_overlay(Overlay::Confirm(ConfirmSpec {
        title: title.into(),
        body: body.into(),
        confirm_label: confirm_label.into(),
        destructive,
        command,
    }));
}

pub fn open_command_palette() {
    open_overlay(Overlay::CommandPalette {
        query: String::new(),
        selected: 0,
    });
}

pub fn cycle_host(delta: isize) {
    let next_key = snapshot_signal().with(|s| {
        let hosts = &s.0.hosts;
        if hosts.is_empty() {
            return None;
        }
        let current_idx =
            s.0.selected_host_key
                .as_deref()
                .and_then(|k| hosts.iter().position(|h| h.key == k))
                .unwrap_or(0);
        let len = hosts.len() as isize;
        let next_idx = (current_idx as isize + delta).rem_euclid(len) as usize;
        Some(hosts[next_idx].key.clone())
    });
    if let Some(key) = next_key {
        send_command(AdminCommand::SelectHost { key });
    }
}

pub fn select_host_key(key: String) {
    snapshot_signal().update(|s| {
        s.0.selected_host_key = Some(key.clone());
    });
    send_command(AdminCommand::SelectHost { key });
}

pub fn open_local_relay_editor() {
    let draft = snapshot_signal().with(|s| s.0.local_relay_config.clone());
    open_overlay(Overlay::ConfigureLocalRelay { draft, error: None });
}

pub fn open_add_relay_modal() {
    let Some(host) = selected_host() else {
        show_toast(ToastTone::Warning, "Select a Host first");
        return;
    };
    open_overlay(Overlay::AddRelay {
        root_path: host.root_path,
        url: String::new(),
        quic_port: String::new(),
        cert_sha256: String::new(),
        ca_der_path: String::new(),
        auth_token: String::new(),
        error: None,
    });
}

pub fn open_invite_modal() {
    let Some(host) = selected_host() else {
        show_toast(ToastTone::Warning, "Select a Host first");
        return;
    };
    let host_name = default_host_name(&host);
    open_overlay(Overlay::CreateInvite {
        root_path: host.root_path,
        host_name,
        label: String::new(),
        ttl_secs: "600".to_owned(),
        error: None,
    });
}

pub fn open_prepare_access_modal() {
    let Some(host) = selected_host() else {
        show_toast(ToastTone::Warning, "Select a Host first");
        return;
    };
    open_overlay(Overlay::PrepareAccess {
        root_path: host.root_path,
        principal: "desktop".to_owned(),
        error: None,
    });
}

pub fn open_revoke_cred_modal() {
    let Some(host) = selected_host() else {
        show_toast(ToastTone::Warning, "Select a Host first");
        return;
    };
    open_overlay(Overlay::RevokeCredential {
        root_path: host.root_path,
        credential_id: String::new(),
        error: None,
    });
}

pub fn open_init_root_modal() {
    let suggested = snapshot_signal().with(|s| s.0.system.default_root.clone());
    open_overlay(Overlay::InitRoot {
        root_path: suggested,
        error: None,
    });
}

pub fn open_install_host_modal() {
    let Some(host) = selected_host() else {
        show_toast(ToastTone::Warning, "Select a Host first");
        return;
    };
    open_overlay(Overlay::InstallHost {
        root_path: host.root_path,
        mode: "on-demand".to_owned(),
        error: None,
    });
}

pub fn default_host_name(host: &HostEntry) -> String {
    if let Ok(name) = std::env::var("HOSTNAME")
        && !name.trim().is_empty()
    {
        return name.trim().to_owned();
    }
    if let Ok(name) = std::env::var("COMPUTERNAME")
        && !name.trim().is_empty()
    {
        return name.trim().to_owned();
    }
    host.label.clone()
}

pub fn wire_host_events() {
    on_host_event("snapshot", |value| {
        if let Ok(snap) = serde_json::from_value::<AdminSnapshot>(value.clone()) {
            snapshot_signal().set(SnapshotStore(snap));
        }
    });
    on_host_event("logs", |value| {
        if let Ok(logs) = serde_json::from_value::<LogSnapshot>(value.clone()) {
            logs_signal().set(LogsStore(logs));
        }
    });
    on_host_event("toast", |value| {
        if let Ok(notice) = serde_json::from_value::<ToastNotice>(value.clone()) {
            let id = notice.id;
            toast_signal().set(ToastStore(Some(notice)));
            set_timeout(std::time::Duration::from_secs(5), move || {
                toast_signal().update(|t| {
                    if t.0.as_ref().is_some_and(|n| n.id == id) {
                        t.0 = None;
                    }
                });
            });
        }
    });
    on_host_event("relay_token_generated", |value| {
        if let Some(token) = value.get("token").and_then(|v| v.as_str()) {
            let token = token.to_owned();
            ui_signal().update(|u| {
                if let Overlay::ConfigureLocalRelay { draft, .. } = &mut u.overlay {
                    draft.auth_token = token;
                }
            });
        }
    });
}

#[allow(dead_code)]
fn _keep_uuid(_: Uuid) {}
