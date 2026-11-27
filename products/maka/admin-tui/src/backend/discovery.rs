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
    DeploymentView, HostEntry, HostHealth, HostRuntimeView, PeerEntry, PublishedEndpointView,
    RemoteAccessView, RemoteRelayItem, SasView, SystemInfo,
};
use maka_event_log::root::{self, FileLease, RootNamespaces};
use maka_host_runtime::application::host::{
    Client, Configuration, LifecycleMode, discovery, remote_access::ConnectionStatus,
};
use maka_updater::BuildInfo;
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde::Deserialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    time::Duration,
};
use uuid::Uuid;

#[derive(Clone, Debug)]
pub struct DiscoveryConfig {
    pub extra_root: Option<PathBuf>,
    pub preferred_root_id: Option<String>,
    pub maka_binary: PathBuf,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeploymentRow {
    deployment_id: Uuid,
    config_revision: u64,
    root_id: String,
    root_path: PathBuf,
    executable: PathBuf,
    sha256: String,
    mode: String,
    websocket: String,
    admission: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingRow {
    deployment: PendingDeploymentRow,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingDeploymentRow {
    sha256: String,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PolicyRow {
    #[serde(default)]
    revision: u64,
    #[serde(default = "default_policy_name")]
    policy: String,
    #[serde(default)]
    last_error: Option<String>,
}

fn default_policy_name() -> String {
    "manual".to_owned()
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum CliStatusObservation {
    Installed {
        supervisor: CliSupervisorObservation,
    },
    #[serde(other)]
    Other,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum CliSupervisorObservation {
    OnDemand,
    Missing,
    Present {
        state: String,
        enabled: Option<bool>,
        pid: Option<u32>,
        #[serde(rename = "lastResult")]
        last_result: Option<i64>,
    },
    Unavailable {
        message: String,
    },
}

struct CandidateRoot {
    label: String,
    root_path: PathBuf,
    root_id: Option<String>,
    deployment_dir: Option<PathBuf>,
    deployment_row: Option<DeploymentRow>,
    pending_sha256: Option<String>,
    policy: PolicyRow,
    operation_in_progress: bool,
    incomplete_deployment: bool,
}

pub fn default_business_root() -> Option<PathBuf> {
    maka_sandbox::account_home()
        .ok()
        .map(|home| home.join(".maka").join("application").join("host"))
}

pub fn account_data_dir(namespaces: &RootNamespaces) -> Option<PathBuf> {
    namespaces.ownership.parent().map(Path::to_path_buf)
}

pub fn collect_system_info(maka_binary: &Path) -> SystemInfo {
    let build = BuildInfo::current();
    let install = maka_updater::current_installation().ok();
    let namespaces = RootNamespaces::for_current_account().ok();
    let account_dir = namespaces.as_ref().and_then(account_data_dir);
    let deployments_dir = account_dir
        .as_ref()
        .map(|d| d.join("deployments"))
        .map(|p| p.display().to_string())
        .unwrap_or_else(|| "unavailable".to_owned());
    let control_dir = namespaces
        .as_ref()
        .map(|n| n.control.display().to_string())
        .unwrap_or_else(|| "unavailable".to_owned());
    let default_root = default_business_root()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|| "unavailable".to_owned());

    SystemInfo {
        version: build.version.to_string(),
        channel: build.channel.as_str().to_owned(),
        install_path: std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.display().to_string()))
            .unwrap_or_else(|| "unknown".to_owned()),
        install_writable: install.as_ref().is_some_and(|i| i.can_install()),
        os: std::env::consts::OS.to_owned(),
        arch: std::env::consts::ARCH.to_owned(),
        maka_binary: maka_binary.display().to_string(),
        account_data_dir: account_dir
            .map(|d| d.display().to_string())
            .unwrap_or_else(|| "unavailable".to_owned()),
        deployments_dir,
        control_dir,
        default_root,
    }
}

pub async fn discover_hosts(
    config: &DiscoveryConfig,
    active_invite_id: Option<String>,
) -> Vec<HostEntry> {
    let cfg = config.clone();
    let candidates = tokio::task::spawn_blocking(move || scan_candidates(&cfg))
        .await
        .unwrap_or_default();

    let mut handles = Vec::with_capacity(candidates.len());
    for candidate in candidates {
        let maka = config.maka_binary.clone();
        let invite_id = active_invite_id.clone();
        handles.push(tokio::spawn(async move {
            probe_candidate(candidate, &maka, invite_id).await
        }));
    }

    let mut entries = Vec::with_capacity(handles.len());
    for handle in handles {
        if let Ok(entry) = handle.await {
            entries.push(entry);
        }
    }

    entries.sort_by(|a, b| {
        let rank = |h: &HostEntry| -> u8 {
            if config
                .preferred_root_id
                .as_deref()
                .is_some_and(|id| h.root_id.as_deref() == Some(id))
            {
                0
            } else if h.health.is_live() {
                1
            } else if h.deployment.is_some() {
                2
            } else {
                3
            }
        };
        rank(a).cmp(&rank(b)).then_with(|| a.label.cmp(&b.label))
    });
    entries
}

fn scan_candidates(config: &DiscoveryConfig) -> Vec<CandidateRoot> {
    let namespaces = RootNamespaces::for_current_account().ok();
    let mut by_key: BTreeMap<String, CandidateRoot> = BTreeMap::new();
    let mut seen_paths: BTreeSet<PathBuf> = BTreeSet::new();

    let mut insert_path = |path: PathBuf, default_label: Option<&str>| {
        let resolved_root = root::resolve(&path).ok();
        let canonical = resolved_root
            .as_ref()
            .map(|r| r.canonical_path().to_path_buf())
            .unwrap_or_else(|| path.canonicalize().unwrap_or_else(|_| path.clone()));
        if !seen_paths.insert(canonical.clone()) {
            return;
        }
        let root_id = resolved_root.as_ref().map(|r| r.root_id().to_owned());
        let key = root_id
            .clone()
            .unwrap_or_else(|| canonical.display().to_string());
        let label = default_label.map(str::to_owned).unwrap_or_else(|| {
            canonical
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| canonical.display().to_string())
        });
        by_key.entry(key).or_insert(CandidateRoot {
            label,
            root_path: canonical,
            root_id,
            deployment_dir: None,
            deployment_row: None,
            pending_sha256: None,
            policy: PolicyRow::default(),
            operation_in_progress: false,
            incomplete_deployment: false,
        });
    };

    if let Some(extra) = &config.extra_root {
        insert_path(extra.clone(), Some("Selected Root"));
    }

    if let Some(default_root) = default_business_root() {
        insert_path(default_root, Some("Default Host"));
    }

    if let Some(ns) = &namespaces
        && let Some(data_dir) = account_data_dir(ns)
    {
        let runtime_host = data_dir.join("runtime-host-rust");
        if runtime_host.exists() {
            insert_path(runtime_host, Some("Managed Host"));
        }

        let deployments_dir = data_dir.join("deployments");
        if let Ok(entries) = std::fs::read_dir(&deployments_dir) {
            for entry in entries.flatten() {
                let dir = entry.path();
                if !dir.is_dir() {
                    continue;
                }
                let dir_root_id = entry.file_name().to_string_lossy().into_owned();
                let (deployment_row, pending_sha256, policy, incomplete) =
                    read_deployment_sqlite(&dir);
                let op_busy = FileLease::is_held(&dir.join("executor.lock")).unwrap_or(false);

                if let Some(row) = deployment_row {
                    // Skip orphaned deployment records whose State Root directory was deleted.
                    if !row.root_path.exists() {
                        continue;
                    }
                    let key = row.root_id.clone();
                    let label = label_for_root_path(&row.root_path);
                    seen_paths.insert(row.root_path.clone());
                    by_key
                        .entry(key)
                        .and_modify(|existing| {
                            existing.root_id = Some(row.root_id.clone());
                            existing.deployment_dir = Some(dir.clone());
                            existing.deployment_row = Some(DeploymentRow {
                                deployment_id: row.deployment_id,
                                config_revision: row.config_revision,
                                root_id: row.root_id.clone(),
                                root_path: row.root_path.clone(),
                                executable: row.executable.clone(),
                                sha256: row.sha256.clone(),
                                mode: row.mode.clone(),
                                websocket: row.websocket.clone(),
                                admission: row.admission.clone(),
                            });
                            existing.pending_sha256 = pending_sha256.clone();
                            existing.policy = PolicyRow {
                                revision: policy.revision,
                                policy: policy.policy.clone(),
                                last_error: policy.last_error.clone(),
                            };
                            existing.operation_in_progress = op_busy;
                            existing.incomplete_deployment = incomplete;
                        })
                        .or_insert(CandidateRoot {
                            label,
                            root_path: row.root_path.clone(),
                            root_id: Some(row.root_id.clone()),
                            deployment_dir: Some(dir),
                            deployment_row: Some(row),
                            pending_sha256,
                            policy,
                            operation_in_progress: op_busy,
                            incomplete_deployment: incomplete,
                        });
                } else if incomplete {
                    by_key.entry(dir_root_id.clone()).or_insert(CandidateRoot {
                        label: format!("Incomplete ({})", short_prefix(&dir_root_id)),
                        root_path: dir.clone(),
                        root_id: Some(dir_root_id),
                        deployment_dir: Some(dir),
                        deployment_row: None,
                        pending_sha256: None,
                        policy: PolicyRow::default(),
                        operation_in_progress: op_busy,
                        incomplete_deployment: true,
                    });
                }
            }
        }
    }

    by_key.into_values().collect()
}

fn label_for_root_path(path: &Path) -> String {
    if default_business_root().as_deref() == Some(path) {
        return "Default Host".to_owned();
    }
    if path.file_name().is_some_and(|n| n == "runtime-host-rust") {
        return "Managed Host".to_owned();
    }
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string())
}

fn short_prefix(s: &str) -> &str {
    if s.len() > 8 { &s[..8] } else { s }
}

fn read_deployment_sqlite(dir: &Path) -> (Option<DeploymentRow>, Option<String>, PolicyRow, bool) {
    let db = dir.join("deployment.sqlite");
    if !db.is_file() {
        let incomplete = dir.join("executor.lock").exists() || dir.join("packages").exists();
        return (None, None, PolicyRow::default(), incomplete);
    }
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let Ok(conn) = Connection::open_with_flags(&db, flags) else {
        return (None, None, PolicyRow::default(), true);
    };
    let _ = conn.busy_timeout(Duration::from_millis(250));

    let deployment: Option<DeploymentRow> = conn
        .query_row(
            "SELECT configuration FROM deployment WHERE singleton = 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str(&raw).ok());

    let pending: Option<String> = conn
        .query_row(
            "SELECT target FROM deployment_update WHERE singleton = 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str::<PendingRow>(&raw).ok())
        .map(|p| p.deployment.sha256);

    let policy: PolicyRow = conn
        .query_row(
            "SELECT configuration FROM deployment_update_policy WHERE singleton = 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();

    let incomplete = deployment.is_none();
    (deployment, pending, policy, incomplete)
}

async fn probe_candidate(
    candidate: CandidateRoot,
    maka_binary: &Path,
    active_invite_id: Option<String>,
) -> HostEntry {
    let key = candidate
        .root_id
        .clone()
        .unwrap_or_else(|| candidate.root_path.display().to_string());

    let root_path_for_disc = candidate.root_path.clone();
    let discovered =
        tokio::task::spawn_blocking(move || discovery::read(&root_path_for_disc)).await;

    let mut runtime = None;
    let mut remote_access = None;
    let mut peers = Vec::new();
    let mut probe_error = None;
    let mut root_id = candidate.root_id.clone();

    if let Ok(Ok(reg)) = discovered {
        root_id = Some(reg.root_id.clone());
        match tokio::time::timeout(
            Duration::from_millis(1500),
            Client::status(&reg.endpoint, Some(reg.host_epoch)),
        )
        .await
        {
            Ok(Ok(status)) if reg.verify(&status).is_ok() || status.closing => {
                let lifecycle_mode = match status.lifecycle_mode {
                    LifecycleMode::Service => "service",
                    LifecycleMode::Ephemeral => "ephemeral",
                }
                .to_owned();

                let (ra_res, peers_res, pub_res) = tokio::join!(
                    tokio::time::timeout(
                        Duration::from_millis(1500),
                        Client::remote_access_status(
                            &reg.endpoint,
                            reg.host_epoch,
                            active_invite_id.as_deref(),
                        ),
                    ),
                    tokio::time::timeout(
                        Duration::from_millis(1500),
                        Client::list_peer_access(&reg.endpoint, reg.host_epoch),
                    ),
                    fetch_published_endpoints(&reg.endpoint, reg.host_epoch),
                );

                if let Ok(Ok(ra)) = ra_res {
                    let connected_set: BTreeSet<&str> =
                        ra.connected_relays.iter().map(String::as_str).collect();
                    let status_str = match ra.status {
                        ConnectionStatus::Disabled => "disabled",
                        ConnectionStatus::Starting => "starting",
                        ConnectionStatus::Connected => "connected",
                        ConnectionStatus::Error => "error",
                    }
                    .to_owned();
                    let relays = ra
                        .config
                        .relays
                        .into_iter()
                        .map(|r| RemoteRelayItem {
                            connected: connected_set.contains(r.endpoint.url.as_str()),
                            url: r.endpoint.url,
                            quic_port: r.endpoint.quic_port,
                            cert_sha256: r.endpoint.cert_sha256,
                            ca_der_path: r.ca_der_path.map(|p| p.display().to_string()),
                            has_auth_token: r.has_auth_token,
                        })
                        .collect();
                    remote_access = Some(RemoteAccessView {
                        status: status_str,
                        peer_id: ra.peer_id,
                        enabled: ra.config.enabled,
                        relay_only: ra.config.relay_only,
                        relays,
                        connected_relays: ra.connected_relays,
                        sas: ra.sas.map(|s| SasView {
                            peer_id: s.peer_id,
                            sas: s.sas,
                            at: s.at,
                        }),
                        invite_state: ra.invite_state.map(|s| format!("{s:?}").to_lowercase()),
                        error: ra.error,
                        cli_override: ra.cli_override,
                    });
                }

                if let Ok(Ok(list)) = peers_res {
                    peers = list
                        .into_iter()
                        .map(|p| PeerEntry {
                            peer_id: p.peer_id,
                            grant: p.grant,
                            label: p.label,
                            created_at: p.created_at,
                            last_active_at: p.last_active_at,
                        })
                        .collect();
                }

                runtime = Some(HostRuntimeView {
                    pid: status.pid.get(),
                    epoch: status.epoch.to_string(),
                    generation: status.generation,
                    lifecycle_mode,
                    protocol_version: status.version,
                    sessions: status.sessions,
                    active_calls: status.active_calls,
                    closing: status.closing,
                    closed: status.closed,
                    cleanup_error: status.cleanup_error,
                    ipc_endpoint: reg.endpoint.display().to_string(),
                    websocket_endpoints: reg.websocket_endpoints,
                    published_endpoints: pub_res,
                });
            }
            Ok(Ok(_)) => {}
            Ok(Err(error)) => {
                // Stale registration after clean shutdown is expected when stopped.
                let msg = error.to_string();
                if !msg.contains("Connection refused")
                    && !msg.contains("No such file")
                    && !msg.contains("not found")
                {
                    probe_error = Some(msg);
                }
            }
            Err(_) => {
                probe_error = Some("Host IPC status probe timed out".to_owned());
            }
        }
    }

    let deployment = if let Some(row) = candidate.deployment_row {
        let mut sup_kind = if row.mode == "on_demand" {
            "on_demand".to_owned()
        } else {
            "unknown".to_owned()
        };
        let mut sup_state = None;
        let mut sup_enabled = None;
        let mut sup_pid = None;
        let mut sup_last_result = None;
        let mut sup_message = None;

        if row.mode == "supervised"
            && row.admission == "active"
            && let Some(obs) = probe_supervisor_via_cli(maka_binary, &row.root_id).await
        {
            match obs {
                CliSupervisorObservation::OnDemand => sup_kind = "on_demand".to_owned(),
                CliSupervisorObservation::Missing => sup_kind = "missing".to_owned(),
                CliSupervisorObservation::Present {
                    state,
                    enabled,
                    pid,
                    last_result,
                } => {
                    sup_kind = "present".to_owned();
                    sup_state = Some(state);
                    sup_enabled = enabled;
                    sup_pid = pid;
                    sup_last_result = last_result;
                }
                CliSupervisorObservation::Unavailable { message } => {
                    sup_kind = "unavailable".to_owned();
                    sup_message = Some(message);
                }
            }
        }

        Some(DeploymentView {
            deployment_id: row.deployment_id,
            config_revision: row.config_revision,
            mode: row.mode,
            admission: row.admission,
            websocket: row.websocket,
            sha256: row.sha256,
            executable: row.executable.display().to_string(),
            pending_update_sha256: candidate.pending_sha256,
            update_policy: candidate.policy.policy,
            update_policy_revision: candidate.policy.revision,
            update_policy_last_error: candidate.policy.last_error,
            operation_in_progress: candidate.operation_in_progress,
            supervisor_kind: sup_kind,
            supervisor_state: sup_state,
            supervisor_enabled: sup_enabled,
            supervisor_pid: sup_pid,
            supervisor_last_result: sup_last_result,
            supervisor_message: sup_message,
        })
    } else {
        None
    };

    let health = if let Some(rt) = &runtime {
        if rt.closing || rt.closed {
            HostHealth::Draining
        } else {
            HostHealth::Running
        }
    } else if candidate.incomplete_deployment {
        HostHealth::Incomplete
    } else if let Some(err) = &probe_error {
        HostHealth::Error {
            message: err.clone(),
        }
    } else if root_id.is_some() || deployment.is_some() {
        HostHealth::Stopped
    } else {
        HostHealth::NotInstalled
    };

    HostEntry {
        key,
        label: candidate.label,
        root_id,
        root_path: candidate.root_path,
        health,
        runtime,
        deployment,
        remote_access,
        peers,
        error: probe_error,
    }
}

async fn fetch_published_endpoints(endpoint: &Path, epoch: Uuid) -> Vec<PublishedEndpointView> {
    let result = tokio::time::timeout(Duration::from_millis(1200), async {
        let mut client = Client::connect(endpoint, Some(epoch)).await?;
        let publication = client.publication().await;
        let _ = client.close().await;
        publication
    })
    .await;

    let Ok(Ok(publication)) = result else {
        return Vec::new();
    };
    let Configuration::PublicHost {
        endpoints,
        product_methods,
        ..
    } = publication.configuration;

    endpoints
        .into_iter()
        .map(|(name, ep)| PublishedEndpointView {
            product_owned: product_methods.contains(&name),
            name,
            methods: ep.grant.methods.into_iter().collect(),
        })
        .collect()
}

async fn probe_supervisor_via_cli(
    maka_binary: &Path,
    root_id: &str,
) -> Option<CliSupervisorObservation> {
    let mut cmd = tokio::process::Command::new(maka_binary);
    cmd.args(["host", "status", "--root-id", root_id])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(3), cmd.output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() {
        return None;
    }
    match serde_json::from_slice::<CliStatusObservation>(&output.stdout).ok()? {
        CliStatusObservation::Installed { supervisor } => Some(supervisor),
        CliStatusObservation::Other => None,
    }
}
