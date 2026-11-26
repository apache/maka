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

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use uuid::Uuid;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TabId {
    #[default]
    Overview,
    Hosts,
    Relay,
    Access,
    Logs,
    System,
}

impl TabId {
    pub const ALL: [Self; 6] = [
        Self::Overview,
        Self::Hosts,
        Self::Relay,
        Self::Access,
        Self::Logs,
        Self::System,
    ];

    pub const fn key_digit(self) -> &'static str {
        match self {
            Self::Overview => "1",
            Self::Hosts => "2",
            Self::Relay => "3",
            Self::Access => "4",
            Self::Logs => "5",
            Self::System => "6",
        }
    }

    pub const fn label(self) -> &'static str {
        match self {
            Self::Overview => "Overview",
            Self::Hosts => "Hosts",
            Self::Relay => "Relay",
            Self::Access => "Access",
            Self::Logs => "Logs",
            Self::System => "System",
        }
    }

    pub const fn subtitle(self) -> &'static str {
        match self {
            Self::Overview => "Control plane health, active Host vitals & quick actions",
            Self::Hosts => "Discovered State Roots, deployments, services & update policies",
            Self::Relay => "Self-hosted relay server & Host remote-access relay routing",
            Self::Access => "Authorized native peers, pairing invites & app credentials",
            Self::Logs => "Live stderr stream from the active Host",
            Self::System => "Build channel, updates, account paths & control plane audit trail",
        }
    }

    pub fn next(self) -> Self {
        let idx = Self::ALL.iter().position(|t| *t == self).unwrap_or(0);
        Self::ALL[(idx + 1) % Self::ALL.len()]
    }

    pub fn prev(self) -> Self {
        let idx = Self::ALL.iter().position(|t| *t == self).unwrap_or(0);
        Self::ALL[(idx + Self::ALL.len() - 1) % Self::ALL.len()]
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum HostHealth {
    Running,
    Draining,
    Stopped,
    Incomplete,
    NotInstalled,
    Error { message: String },
}

impl HostHealth {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Running => "Running",
            Self::Draining => "Draining",
            Self::Stopped => "Stopped",
            Self::Incomplete => "Incomplete",
            Self::NotInstalled => "Not installed",
            Self::Error { .. } => "Error",
        }
    }

    pub fn is_live(&self) -> bool {
        matches!(self, Self::Running | Self::Draining)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostRuntimeView {
    pub pid: u32,
    pub epoch: String,
    pub generation: Option<String>,
    pub lifecycle_mode: String,
    pub protocol_version: u32,
    pub sessions: usize,
    pub active_calls: usize,
    pub closing: bool,
    pub closed: bool,
    pub cleanup_error: Option<String>,
    pub ipc_endpoint: String,
    pub websocket_endpoints: Vec<String>,
    pub published_endpoints: Vec<PublishedEndpointView>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishedEndpointView {
    pub name: String,
    pub methods: Vec<String>,
    pub product_owned: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeploymentView {
    pub deployment_id: Uuid,
    pub config_revision: u64,
    pub mode: String,
    pub admission: String,
    pub websocket: String,
    pub sha256: String,
    pub executable: String,
    pub pending_update_sha256: Option<String>,
    pub update_policy: String,
    pub update_policy_revision: u64,
    pub update_policy_last_error: Option<String>,
    pub operation_in_progress: bool,
    pub supervisor_kind: String,
    pub supervisor_state: Option<String>,
    pub supervisor_enabled: Option<bool>,
    pub supervisor_pid: Option<u32>,
    pub supervisor_last_result: Option<i64>,
    pub supervisor_message: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteRelayItem {
    pub url: String,
    pub quic_port: Option<u16>,
    pub cert_sha256: Option<String>,
    pub ca_der_path: Option<String>,
    pub has_auth_token: bool,
    pub connected: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SasView {
    pub peer_id: String,
    pub sas: String,
    pub at: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAccessView {
    pub status: String,
    pub peer_id: String,
    pub enabled: bool,
    pub relay_only: bool,
    pub relays: Vec<RemoteRelayItem>,
    pub connected_relays: Vec<String>,
    pub sas: Option<SasView>,
    pub invite_state: Option<String>,
    pub error: Option<String>,
    pub cli_override: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerEntry {
    pub peer_id: String,
    pub grant: String,
    pub label: String,
    pub created_at: String,
    pub last_active_at: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostEntry {
    pub key: String,
    pub label: String,
    pub root_id: Option<String>,
    pub root_path: PathBuf,
    pub health: HostHealth,
    pub runtime: Option<HostRuntimeView>,
    pub deployment: Option<DeploymentView>,
    pub remote_access: Option<RemoteAccessView>,
    pub peers: Vec<PeerEntry>,
    pub error: Option<String>,
}

impl HostEntry {
    pub fn short_id(&self) -> String {
        match &self.root_id {
            Some(id) if id.len() > 12 => format!("{}…", &id[..12]),
            Some(id) => id.clone(),
            None => "uninitialized".to_owned(),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RelayTlsMode {
    #[default]
    None,
    SelfSigned,
    Pem,
}

impl RelayTlsMode {
    pub const fn label(self) -> &'static str {
        match self {
            Self::None => "Plain HTTP",
            Self::SelfSigned => "Self-Signed TLS",
            Self::Pem => "PEM Certificate",
        }
    }

    pub const fn cycle(self) -> Self {
        match self {
            Self::None => Self::SelfSigned,
            Self::SelfSigned => Self::Pem,
            Self::Pem => Self::None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalRelayConfig {
    pub http_addr: String,
    pub https_addr: String,
    pub quic_addr: String,
    pub tls_mode: RelayTlsMode,
    pub tls_sans: String,
    pub tls_cert_path: String,
    pub tls_key_path: String,
    pub auth_token: String,
}

impl Default for LocalRelayConfig {
    fn default() -> Self {
        Self {
            http_addr: "127.0.0.1:3340".to_owned(),
            https_addr: String::new(),
            quic_addr: String::new(),
            tls_mode: RelayTlsMode::None,
            tls_sans: "localhost,127.0.0.1".to_owned(),
            tls_cert_path: String::new(),
            tls_key_path: String::new(),
            auth_token: String::new(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalRelayRuntime {
    pub http_addr: Option<String>,
    pub https_addr: Option<String>,
    pub quic_addr: Option<String>,
    pub cert_sha256: Option<String>,
    pub has_auth_token: bool,
    pub started_at: String,
    pub uptime_secs: u64,
    pub endpoint_url: String,
    pub cli_command: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LocalRelayState {
    #[default]
    Stopped,
    Running(LocalRelayRuntime),
    Error {
        message: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingInviteView {
    pub uri: String,
    pub host_peer_id: String,
    pub root_id: String,
    pub invite_id: String,
    pub expires_at_ms: u64,
    pub relays: Vec<String>,
    pub state: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppPairingView {
    pub principal: String,
    pub root_id: String,
    pub credential_id: String,
    pub credential: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LogLevel {
    Error,
    Warn,
    Info,
    Debug,
    Trace,
    Other,
}

impl LogLevel {
    pub const fn badge(self) -> &'static str {
        match self {
            Self::Error => "ERR",
            Self::Warn => "WRN",
            Self::Info => "INF",
            Self::Debug => "DBG",
            Self::Trace => "TRC",
            Self::Other => "LOG",
        }
    }

    pub fn detect(line: &str) -> Self {
        let upper = line.to_ascii_uppercase();
        if upper.contains(" ERROR ")
            || upper.starts_with("ERROR")
            || upper.contains(r#""LEVEL":"ERROR""#)
        {
            Self::Error
        } else if upper.contains(" WARN ")
            || upper.starts_with("WARN")
            || upper.contains(r#""LEVEL":"WARN""#)
        {
            Self::Warn
        } else if upper.contains(" INFO ")
            || upper.starts_with("INFO")
            || upper.contains(r#""LEVEL":"INFO""#)
        {
            Self::Info
        } else if upper.contains(" DEBUG ")
            || upper.starts_with("DEBUG")
            || upper.contains(r#""LEVEL":"DEBUG""#)
        {
            Self::Debug
        } else if upper.contains(" TRACE ")
            || upper.starts_with("TRACE")
            || upper.contains(r#""LEVEL":"TRACE""#)
        {
            Self::Trace
        } else {
            Self::Other
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    pub seq: u64,
    pub level: LogLevel,
    pub text: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogSnapshot {
    pub root_id: Option<String>,
    pub path: Option<String>,
    pub missing: bool,
    pub follow: bool,
    pub lines: Vec<LogLine>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToastTone {
    Info,
    Success,
    Warning,
    Danger,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToastNotice {
    pub id: u64,
    pub tone: ToastTone,
    pub message: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityEntry {
    pub id: u64,
    pub at: String,
    pub target: String,
    pub action: String,
    pub ok: bool,
    pub detail: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum UpdateCheckState {
    #[default]
    Idle,
    Checking,
    DevBuild,
    UpToDate,
    Available {
        version: String,
        url: String,
    },
    Error {
        message: String,
    },
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    pub version: String,
    pub channel: String,
    pub install_path: String,
    pub install_writable: bool,
    pub os: String,
    pub arch: String,
    pub maka_binary: String,
    pub account_data_dir: String,
    pub deployments_dir: String,
    pub control_dir: String,
    pub default_root: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminSnapshot {
    pub refreshed_at: String,
    pub busy_label: Option<String>,
    pub selected_host_key: Option<String>,
    pub hosts: Vec<HostEntry>,
    pub local_relay: LocalRelayState,
    pub local_relay_config: LocalRelayConfig,
    pub active_invite: Option<PairingInviteView>,
    pub last_app_pairing: Option<AppPairingView>,
    pub update_check: UpdateCheckState,
    pub system: SystemInfo,
    pub activity: Vec<ActivityEntry>,
}

impl AdminSnapshot {
    pub fn selected_host(&self) -> Option<&HostEntry> {
        if let Some(key) = &self.selected_host_key
            && let Some(found) = self.hosts.iter().find(|h| &h.key == key)
        {
            return Some(found);
        }
        self.hosts.first()
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AdminCommand {
    Refresh,
    SelectHost {
        key: String,
    },
    ActivateHost {
        root_id: Option<String>,
        root_path: PathBuf,
    },
    RestartHost {
        root_id: String,
        deployment_id: Uuid,
        config_revision: u64,
    },
    StopHost {
        root_id: String,
        deployment_id: Uuid,
        config_revision: u64,
    },
    RetireHost {
        root_path: PathBuf,
        interrupt: bool,
    },
    ReconcileHost {
        root_id: String,
        deployment_id: Uuid,
        config_revision: u64,
    },
    UninstallHost {
        root_id: String,
        deployment_id: Uuid,
        config_revision: u64,
    },
    InstallHost {
        root_path: PathBuf,
        mode: String,
    },
    InitRoot {
        root_path: PathBuf,
    },
    SetUpdatePolicy {
        root_id: String,
        deployment_id: Uuid,
        policy_revision: u64,
        policy: String,
    },
    StartLocalRelay {
        config: LocalRelayConfig,
    },
    StopLocalRelay,
    ApplyLocalRelayToHost {
        root_path: PathBuf,
    },
    SetRemoteAccessEnabled {
        root_path: PathBuf,
        enabled: bool,
    },
    SetRemoteAccessRelayOnly {
        root_path: PathBuf,
        relay_only: bool,
    },
    AddHostRelay {
        root_path: PathBuf,
        url: String,
        quic_port: Option<u16>,
        cert_sha256: Option<String>,
        ca_der_path: Option<String>,
        auth_token: Option<String>,
    },
    RemoveHostRelay {
        root_path: PathBuf,
        url: String,
    },
    CreatePairingInvite {
        root_path: PathBuf,
        host_name: String,
        label: Option<String>,
        ttl_secs: Option<u64>,
    },
    RevokePeer {
        root_path: PathBuf,
        peer_id: String,
    },
    PrepareAppAccess {
        root_path: PathBuf,
        principal: String,
    },
    RevokeAppCredential {
        root_path: PathBuf,
        credential_id: String,
    },
    CheckUpdates,
    SetLogFollow {
        follow: bool,
    },
    RefreshLogs,
    GenerateRelayToken,
}
