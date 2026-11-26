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

pub mod discovery;
pub mod host_ops;
pub mod logs;
pub mod relay_mgr;

use crate::model::{
    ActivityEntry, AdminCommand, AdminSnapshot, AppPairingView, LogSnapshot, PairingInviteView,
    ToastNotice, ToastTone, UpdateCheckState,
};
use discovery::{DiscoveryConfig, collect_system_info, discover_hosts};
use jiff::Timestamp;
use logs::LogWatcher;
use nsh_engine::HostChannel;
use relay_mgr::RelayManager;
use std::{
    collections::VecDeque,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::{sync::mpsc, task::JoinHandle};
use tokio_util::sync::CancellationToken;

const MAX_ACTIVITY: usize = 80;

pub struct ControlPlaneConfig {
    pub extra_root: Option<PathBuf>,
    pub preferred_root_id: Option<String>,
    pub maka_binary: PathBuf,
    pub refresh_interval: Duration,
}

pub struct ControlPlane {
    cancel: CancellationToken,
    task: Option<JoinHandle<()>>,
}

impl ControlPlane {
    pub fn start(
        config: ControlPlaneConfig,
        channel: HostChannel,
        runtime: &tokio::runtime::Handle,
    ) -> Self {
        let cancel = CancellationToken::new();
        let (cmd_tx, cmd_rx) = mpsc::unbounded_channel::<AdminCommand>();

        let sender = cmd_tx.clone();
        channel.handle("command", move |call| {
            let parsed = serde_json::from_value::<AdminCommand>(call.data().clone());
            match parsed {
                Ok(cmd) => {
                    let _ = sender.send(cmd);
                    call.resolve(serde_json::json!({ "ok": true }));
                }
                Err(error) => {
                    call.reject(format!("invalid command: {error}"));
                }
            }
        });

        let task_cancel = cancel.clone();
        let task = runtime.spawn(run_loop(config, channel, cmd_rx, task_cancel));
        Self {
            cancel,
            task: Some(task),
        }
    }

    pub async fn shutdown(mut self) {
        self.cancel.cancel();
        if let Some(task) = self.task.take() {
            let _ = tokio::time::timeout(Duration::from_secs(4), task).await;
        }
    }
}

struct State {
    discovery: DiscoveryConfig,
    snapshot: AdminSnapshot,
    relay: RelayManager,
    logs: LogWatcher,
    activity: VecDeque<ActivityEntry>,
    next_activity_id: u64,
    next_toast_id: Arc<AtomicU64>,
    channel: HostChannel,
}

impl State {
    fn emit_snapshot(&mut self) {
        self.snapshot.local_relay = self.relay.state();
        self.snapshot.local_relay_config = self.relay.config().clone();
        self.snapshot.activity = self.activity.iter().cloned().collect();
        if let Ok(value) = serde_json::to_value(&self.snapshot) {
            let _ = self.channel.send("snapshot", value);
        }
    }

    fn emit_toast(&self, tone: ToastTone, message: impl Into<String>) {
        let id = self.next_toast_id.fetch_add(1, Ordering::Relaxed) + 1;
        let notice = ToastNotice {
            id,
            tone,
            message: message.into(),
        };
        if let Ok(value) = serde_json::to_value(notice) {
            let _ = self.channel.send("toast", value);
        }
    }

    fn record_activity(
        &mut self,
        target: impl Into<String>,
        action: impl Into<String>,
        ok: bool,
        detail: impl Into<String>,
    ) {
        self.next_activity_id += 1;
        let entry = ActivityEntry {
            id: self.next_activity_id,
            at: Timestamp::now().strftime("%H:%M:%S").to_string(),
            target: target.into(),
            action: action.into(),
            ok,
            detail: detail.into(),
        };
        if self.activity.len() >= MAX_ACTIVITY {
            self.activity.pop_back();
        }
        self.activity.push_front(entry);
    }

    async fn refresh(&mut self) {
        let invite_id = self
            .snapshot
            .active_invite
            .as_ref()
            .map(|i| i.invite_id.clone());
        let hosts = discover_hosts(&self.discovery, invite_id).await;
        let prev_selected = self.snapshot.selected_host_key.clone();
        let selected_key = prev_selected
            .filter(|key| hosts.iter().any(|h| &h.key == key))
            .or_else(|| {
                self.discovery
                    .preferred_root_id
                    .as_ref()
                    .and_then(|id| hosts.iter().find(|h| h.root_id.as_deref() == Some(id)))
                    .map(|h| h.key.clone())
            })
            .or_else(|| hosts.first().map(|h| h.key.clone()));

        // Keep active invite status synced with the selected Host's remote access status.
        if let Some(invite) = self.snapshot.active_invite.as_mut()
            && let Some(host) = hosts
                .iter()
                .find(|h| h.root_id.as_deref() == Some(invite.root_id.as_str()))
            && let Some(ra) = &host.remote_access
            && let Some(state) = &ra.invite_state
        {
            invite.state = Some(state.clone());
        }

        let watch_root_id = selected_key
            .as_deref()
            .and_then(|key| hosts.iter().find(|h| h.key == key))
            .and_then(|h| h.root_id.clone());

        self.snapshot.hosts = hosts;
        self.snapshot.selected_host_key = selected_key;
        self.snapshot.refreshed_at = Timestamp::now().strftime("%H:%M:%S").to_string();
        self.emit_snapshot();
        self.logs.watch_root(watch_root_id, false).await;
    }

    fn set_busy(&mut self, label: Option<&str>) {
        self.snapshot.busy_label = label.map(str::to_owned);
        self.emit_snapshot();
    }

    async fn handle_command(&mut self, cmd: AdminCommand) {
        match cmd {
            AdminCommand::Refresh => {
                self.refresh().await;
            }
            AdminCommand::SelectHost { key } => {
                if self.snapshot.hosts.iter().any(|h| h.key == key) {
                    self.snapshot.selected_host_key = Some(key.clone());
                    let watch_root = self
                        .snapshot
                        .hosts
                        .iter()
                        .find(|h| h.key == key)
                        .and_then(|h| h.root_id.clone());
                    self.emit_snapshot();
                    self.logs.watch_root(watch_root, false).await;
                }
            }
            AdminCommand::ActivateHost { root_id, root_path } => {
                let has_deployment = self
                    .snapshot
                    .hosts
                    .iter()
                    .any(|h| h.root_path == root_path && h.deployment.is_some());
                self.set_busy(Some("Activating Host…"));
                let res = host_ops::activate_host(
                    &self.discovery.maka_binary,
                    root_id.as_deref(),
                    &root_path,
                    has_deployment,
                )
                .await;
                self.finish_op("Host", "Activate", res).await;
            }
            AdminCommand::RestartHost {
                root_id,
                deployment_id,
                config_revision,
            } => {
                self.set_busy(Some("Restarting Host…"));
                let res = host_ops::restart_host(
                    &self.discovery.maka_binary,
                    &root_id,
                    deployment_id,
                    config_revision,
                )
                .await;
                self.finish_op("Host", "Restart", res).await;
            }
            AdminCommand::StopHost {
                root_id,
                deployment_id,
                config_revision,
            } => {
                self.set_busy(Some("Stopping Host…"));
                let res = host_ops::stop_host(
                    &self.discovery.maka_binary,
                    &root_id,
                    deployment_id,
                    config_revision,
                )
                .await;
                self.finish_op("Host", "Stop", res).await;
            }
            AdminCommand::RetireHost {
                root_path,
                interrupt,
            } => {
                let label = if interrupt {
                    "Force retiring Host…"
                } else {
                    "Retiring Host…"
                };
                self.set_busy(Some(label));
                let res = host_ops::retire_host(&root_path, interrupt).await;
                self.finish_op(
                    "Host",
                    if interrupt { "Force Retire" } else { "Retire" },
                    res,
                )
                .await;
            }
            AdminCommand::ReconcileHost {
                root_id,
                deployment_id,
                config_revision,
            } => {
                self.set_busy(Some("Reconciling pending update…"));
                let res = host_ops::reconcile_host(
                    &self.discovery.maka_binary,
                    &root_id,
                    deployment_id,
                    config_revision,
                )
                .await;
                self.finish_op("Host", "Reconcile", res).await;
            }
            AdminCommand::UninstallHost {
                root_id,
                deployment_id,
                config_revision,
            } => {
                self.set_busy(Some("Uninstalling deployment…"));
                let res = host_ops::uninstall_host(
                    &self.discovery.maka_binary,
                    &root_id,
                    deployment_id,
                    config_revision,
                )
                .await;
                self.finish_op("Host", "Uninstall", res).await;
            }
            AdminCommand::InstallHost { root_path, mode } => {
                self.set_busy(Some("Installing managed Host…"));
                let res =
                    host_ops::install_host(&self.discovery.maka_binary, &root_path, &mode).await;
                self.finish_op("Host", "Install", res).await;
            }
            AdminCommand::InitRoot { root_path } => {
                self.set_busy(Some("Initializing State Root…"));
                let res = host_ops::init_root(&self.discovery.maka_binary, &root_path).await;
                if res.is_ok() {
                    self.discovery.extra_root = Some(root_path);
                }
                self.finish_op("Root", "Init", res).await;
            }
            AdminCommand::SetUpdatePolicy {
                root_id,
                deployment_id,
                policy_revision,
                policy,
            } => {
                self.set_busy(Some("Updating policy…"));
                let res = host_ops::set_update_policy(
                    &self.discovery.maka_binary,
                    &root_id,
                    deployment_id,
                    policy_revision,
                    &policy,
                )
                .await;
                self.finish_op("Update Policy", "Configure", res).await;
            }
            AdminCommand::StartLocalRelay { config } => {
                self.set_busy(Some("Starting local Relay…"));
                let res = self
                    .relay
                    .start(config)
                    .await
                    .map(|rt| format!("Relay listening on {}", rt.endpoint_url));
                self.finish_local_op("Local Relay", "Start", res);
            }
            AdminCommand::StopLocalRelay => {
                self.set_busy(Some("Stopping local Relay…"));
                self.relay.stop().await;
                self.finish_local_op("Local Relay", "Stop", Ok("Stopped local Relay".to_owned()));
            }
            AdminCommand::ApplyLocalRelayToHost { root_path } => {
                let Some(endpoint) = self.relay.running_endpoint() else {
                    self.emit_toast(
                        ToastTone::Warning,
                        "Start the local Relay before attaching it to a Host",
                    );
                    return;
                };
                self.set_busy(Some("Attaching local Relay to Host…"));
                let res = host_ops::add_host_relay(
                    &root_path,
                    endpoint.url,
                    endpoint.quic_port,
                    endpoint.cert_sha256,
                    None,
                    endpoint.auth_token,
                    true,
                )
                .await;
                self.finish_op("Remote Access", "Attach Local Relay", res)
                    .await;
            }
            AdminCommand::SetRemoteAccessEnabled { root_path, enabled } => {
                self.set_busy(Some("Updating Remote Access…"));
                let res = host_ops::set_remote_access_enabled(&root_path, enabled).await;
                self.finish_op("Remote Access", "Toggle Enabled", res).await;
            }
            AdminCommand::SetRemoteAccessRelayOnly {
                root_path,
                relay_only,
            } => {
                self.set_busy(Some("Updating Relay-Only mode…"));
                let res = host_ops::set_remote_access_relay_only(&root_path, relay_only).await;
                self.finish_op("Remote Access", "Toggle Relay-Only", res)
                    .await;
            }
            AdminCommand::AddHostRelay {
                root_path,
                url,
                quic_port,
                cert_sha256,
                ca_der_path,
                auth_token,
            } => {
                self.set_busy(Some("Adding Host Relay…"));
                let res = host_ops::add_host_relay(
                    &root_path,
                    url,
                    quic_port,
                    cert_sha256,
                    ca_der_path,
                    auth_token,
                    false,
                )
                .await;
                self.finish_op("Remote Access", "Add Relay", res).await;
            }
            AdminCommand::RemoveHostRelay { root_path, url } => {
                self.set_busy(Some("Removing Host Relay…"));
                let res = host_ops::remove_host_relay(&root_path, &url).await;
                self.finish_op("Remote Access", "Remove Relay", res).await;
            }
            AdminCommand::CreatePairingInvite {
                root_path,
                host_name,
                label,
                ttl_secs,
            } => {
                self.set_busy(Some("Generating pairing invite…"));
                let res =
                    host_ops::create_pairing_invite(&root_path, host_name, label, ttl_secs).await;
                self.snapshot.busy_label = None;
                match res {
                    Ok(invite) => {
                        let summary = format!("Issued pairing invite {}", invite.invite_id);
                        self.snapshot.active_invite = Some(invite);
                        self.record_activity("Access", "Pairing Invite", true, &summary);
                        self.emit_toast(ToastTone::Success, summary);
                        self.refresh().await;
                    }
                    Err(err) => {
                        self.record_activity("Access", "Pairing Invite", false, &err);
                        self.emit_toast(ToastTone::Danger, err);
                        self.emit_snapshot();
                    }
                }
            }
            AdminCommand::RevokePeer { root_path, peer_id } => {
                self.set_busy(Some("Revoking native peer…"));
                let res = host_ops::revoke_peer(&root_path, &peer_id).await;
                self.finish_op("Access", "Revoke Peer", res).await;
            }
            AdminCommand::PrepareAppAccess {
                root_path,
                principal,
            } => {
                self.set_busy(Some("Preparing app credential…"));
                let res = host_ops::prepare_app_access(&root_path, principal).await;
                self.snapshot.busy_label = None;
                match res {
                    Ok(pairing) => {
                        let summary = format!(
                            "Issued credential {} for {}",
                            pairing.credential_id, pairing.principal
                        );
                        self.snapshot.last_app_pairing = Some(pairing);
                        self.record_activity("Access", "Prepare Credential", true, &summary);
                        self.emit_toast(ToastTone::Success, summary);
                        self.emit_snapshot();
                    }
                    Err(err) => {
                        self.record_activity("Access", "Prepare Credential", false, &err);
                        self.emit_toast(ToastTone::Danger, err);
                        self.emit_snapshot();
                    }
                }
            }
            AdminCommand::RevokeAppCredential {
                root_path,
                credential_id,
            } => {
                self.set_busy(Some("Revoking credential…"));
                let res = host_ops::revoke_app_credential(&root_path, credential_id).await;
                self.finish_op("Access", "Revoke Credential", res).await;
            }
            AdminCommand::CheckUpdates => {
                self.snapshot.update_check = UpdateCheckState::Checking;
                self.emit_snapshot();
                let outcome = host_ops::check_for_updates().await;
                let (ok, tone, msg) = match &outcome {
                    UpdateCheckState::DevBuild => (
                        true,
                        ToastTone::Info,
                        "Dev build: automatic updates disabled".to_owned(),
                    ),
                    UpdateCheckState::UpToDate => (
                        true,
                        ToastTone::Success,
                        format!("Maka {} is up to date", self.snapshot.system.version),
                    ),
                    UpdateCheckState::Available { version, .. } => (
                        true,
                        ToastTone::Warning,
                        format!("Update available: v{version}"),
                    ),
                    UpdateCheckState::Error { message } => {
                        (false, ToastTone::Danger, message.clone())
                    }
                    _ => (true, ToastTone::Info, "Update check finished".to_owned()),
                };
                self.snapshot.update_check = outcome;
                self.record_activity("Updates", "Check", ok, &msg);
                self.emit_toast(tone, msg);
                self.emit_snapshot();
            }
            AdminCommand::SetLogFollow { follow } => {
                self.logs.set_follow(follow);
            }
            AdminCommand::RefreshLogs => {
                let root_id = self
                    .snapshot
                    .selected_host()
                    .and_then(|h| h.root_id.clone());
                self.logs.watch_root(root_id, true).await;
            }
            AdminCommand::GenerateRelayToken => {
                let token = self.relay.set_generated_token();
                self.record_activity(
                    "Local Relay",
                    "Generate Token",
                    true,
                    "Generated 256-bit Bearer token",
                );
                let _ = self.channel.send(
                    "relay_token_generated",
                    serde_json::json!({ "token": token }),
                );
                self.emit_toast(ToastTone::Success, "Generated new Bearer token");
                self.emit_snapshot();
            }
        }
    }

    fn finish_local_op(&mut self, target: &str, action: &str, result: Result<String, String>) {
        self.snapshot.busy_label = None;
        match result {
            Ok(message) => {
                self.record_activity(target, action, true, &message);
                self.emit_toast(ToastTone::Success, message);
            }
            Err(error) => {
                self.record_activity(target, action, false, &error);
                self.emit_toast(ToastTone::Danger, error);
            }
        }
        self.emit_snapshot();
    }

    async fn finish_op(&mut self, target: &str, action: &str, result: Result<String, String>) {
        self.finish_local_op(target, action, result);
        self.refresh().await;
    }
}

async fn run_loop(
    config: ControlPlaneConfig,
    channel: HostChannel,
    mut cmd_rx: mpsc::UnboundedReceiver<AdminCommand>,
    cancel: CancellationToken,
) {
    let log_channel = channel.clone();
    let logs = LogWatcher::new(Arc::new(move |snap: LogSnapshot| {
        if let Ok(value) = serde_json::to_value(snap) {
            let _ = log_channel.send("logs", value);
        }
    }));

    let system = collect_system_info(&config.maka_binary);
    let mut state = State {
        discovery: DiscoveryConfig {
            extra_root: config.extra_root,
            preferred_root_id: config.preferred_root_id,
            maka_binary: config.maka_binary,
        },
        snapshot: AdminSnapshot {
            system,
            ..Default::default()
        },
        relay: RelayManager::default(),
        logs,
        activity: VecDeque::with_capacity(MAX_ACTIVITY),
        next_activity_id: 0,
        next_toast_id: Arc::new(AtomicU64::new(0)),
        channel,
    };

    state.refresh().await;

    let mut ticker = tokio::time::interval(config.refresh_interval.max(Duration::from_secs(1)));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // Skip the immediate first tick since we already refreshed above.
    ticker.tick().await;

    loop {
        tokio::select! {
            biased;
            () = cancel.cancelled() => break,
            cmd = cmd_rx.recv() => {
                match cmd {
                    Some(cmd) => state.handle_command(cmd).await,
                    None => break,
                }
            }
            _ = ticker.tick() => {
                state.refresh().await;
            }
        }
    }

    state.logs.stop().await;
    state.relay.stop().await;
}

pub fn format_diagnostics_json(snapshot: &AdminSnapshot, logs: &LogSnapshot) -> String {
    serde_json::to_string_pretty(&serde_json::json!({
        "refreshedAt": snapshot.refreshed_at,
        "system": snapshot.system,
        "hosts": snapshot.hosts,
        "localRelay": snapshot.local_relay,
        "updateCheck": snapshot.update_check,
        "recentActivity": snapshot.activity,
        "recentLogs": logs.lines.iter().rev().take(50).collect::<Vec<_>>(),
    }))
    .unwrap_or_else(|_| "{}".to_owned())
}

// Keep unused imports clean across platforms.
#[allow(dead_code)]
fn _assert_types(_: Option<PairingInviteView>, _: Option<AppPairingView>) {}
