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

use crate::model::{AppPairingView, PairingInviteView, UpdateCheckState};
use maka_config::remote_access::{RelayAuthUpdate, RemoteAccessUpdate, RemoteRelayUpdate};
use maka_host_runtime::application::host::{
    Client, PeerId, PeerPairingOptions, discovery, startup,
};
use maka_remote_pairing::RelayEndpoint;
use maka_updater::{BuildInfo, Channel};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use uuid::Uuid;

async fn read_live_discovery(root_path: &Path) -> Result<discovery::Discovery, String> {
    let path = root_path.to_path_buf();
    let reg = tokio::task::spawn_blocking(move || discovery::read(&path))
        .await
        .map_err(|e| format!("discovery task failed: {e}"))?
        .map_err(|e| format!("Host is not running for this root: {e}"))?;
    let status = tokio::time::timeout(
        Duration::from_secs(3),
        Client::status(&reg.endpoint, Some(reg.host_epoch)),
    )
    .await
    .map_err(|_| "timed out contacting Host".to_owned())?
    .map_err(|e| format!("Host status failed: {e}"))?;
    reg.verify(&status)
        .map_err(|e| format!("Host discovery stale: {e}"))?;
    Ok(reg)
}

async fn run_maka(maka: &Path, args: &[String], timeout_secs: u64) -> Result<String, String> {
    let mut cmd = tokio::process::Command::new(maka);
    cmd.args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(timeout_secs), cmd.output())
        .await
        .map_err(|_| format!("maka {} timed out after {timeout_secs}s", args.join(" ")))?
        .map_err(|e| format!("failed to run {}: {e}", maka.display()))?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    if !output.status.success() {
        let detail = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            format!("exited with {}", output.status)
        };
        return Err(detail);
    }
    Ok(stdout)
}

pub async fn activate_host(
    maka: &Path,
    root_id: Option<&str>,
    root_path: &Path,
    has_deployment: bool,
) -> Result<String, String> {
    if has_deployment && let Some(id) = root_id {
        let out = run_maka(
            maka,
            &[
                "host".to_owned(),
                "activate".to_owned(),
                "--root-id".to_owned(),
                id.to_owned(),
            ],
            30,
        )
        .await?;
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&out)
            && let Some(pid) = val.get("pid").and_then(|v| v.as_u64())
        {
            return Ok(format!("Activated Host (pid {pid})"));
        }
        return Ok("Activated managed Host".to_owned());
    }

    let mut client = tokio::time::timeout(
        Duration::from_secs(30),
        startup::connect_root(maka, root_path),
    )
    .await
    .map_err(|_| "timed out starting local Host".to_owned())?
    .map_err(|e| format!("failed to start local Host: {e}"))?;
    let epoch = client.epoch().to_string();
    let _ = client.close().await;
    Ok(format!("Started local Host (epoch {})", &epoch[..8]))
}

pub async fn restart_host(
    maka: &Path,
    root_id: &str,
    deployment_id: Uuid,
    config_revision: u64,
) -> Result<String, String> {
    let out = run_maka(
        maka,
        &[
            "host".to_owned(),
            "restart".to_owned(),
            "--root-id".to_owned(),
            root_id.to_owned(),
            "--expected-deployment-id".to_owned(),
            deployment_id.to_string(),
            "--expected-revision".to_owned(),
            config_revision.to_string(),
        ],
        30,
    )
    .await?;
    parse_control_outcome(&out, "Restarted Host")
}

pub async fn stop_host(
    maka: &Path,
    root_id: &str,
    deployment_id: Uuid,
    config_revision: u64,
) -> Result<String, String> {
    let out = run_maka(
        maka,
        &[
            "host".to_owned(),
            "stop".to_owned(),
            "--root-id".to_owned(),
            root_id.to_owned(),
            "--expected-deployment-id".to_owned(),
            deployment_id.to_string(),
            "--expected-revision".to_owned(),
            config_revision.to_string(),
        ],
        30,
    )
    .await?;
    parse_control_outcome(&out, "Stopped Host")
}

pub async fn uninstall_host(
    maka: &Path,
    root_id: &str,
    deployment_id: Uuid,
    config_revision: u64,
) -> Result<String, String> {
    let out = run_maka(
        maka,
        &[
            "host".to_owned(),
            "uninstall".to_owned(),
            "--root-id".to_owned(),
            root_id.to_owned(),
            "--expected-deployment-id".to_owned(),
            deployment_id.to_string(),
            "--expected-revision".to_owned(),
            config_revision.to_string(),
        ],
        30,
    )
    .await?;
    parse_control_outcome(&out, "Uninstalled deployment (State Root preserved)")
}

pub async fn reconcile_host(
    maka: &Path,
    root_id: &str,
    deployment_id: Uuid,
    config_revision: u64,
) -> Result<String, String> {
    let _ = run_maka(
        maka,
        &[
            "host".to_owned(),
            "reconcile".to_owned(),
            "--root-id".to_owned(),
            root_id.to_owned(),
            "--expected-deployment-id".to_owned(),
            deployment_id.to_string(),
            "--expected-revision".to_owned(),
            config_revision.to_string(),
        ],
        45,
    )
    .await?;
    Ok("Reconciled pending deployment update".to_owned())
}

pub async fn install_host(maka: &Path, root_path: &Path, mode: &str) -> Result<String, String> {
    let cli_mode = match mode {
        "supervised" | "service" => "supervised",
        _ => "on-demand",
    };
    let _ = run_maka(
        maka,
        &[
            "host".to_owned(),
            "install".to_owned(),
            "--root".to_owned(),
            root_path.display().to_string(),
            "--mode".to_owned(),
            cli_mode.to_owned(),
        ],
        30,
    )
    .await?;
    Ok(format!("Installed managed Host ({cli_mode})"))
}

pub async fn init_root(maka: &Path, root_path: &Path) -> Result<String, String> {
    let _ = run_maka(
        maka,
        &[
            "host".to_owned(),
            "init".to_owned(),
            "--root".to_owned(),
            root_path.display().to_string(),
        ],
        20,
    )
    .await?;
    Ok(format!("Initialized State Root at {}", root_path.display()))
}

pub async fn set_update_policy(
    maka: &Path,
    root_id: &str,
    deployment_id: Uuid,
    policy_revision: u64,
    policy: &str,
) -> Result<String, String> {
    let out = run_maka(
        maka,
        &[
            "host".to_owned(),
            "update-policy".to_owned(),
            "--root-id".to_owned(),
            root_id.to_owned(),
            "--policy".to_owned(),
            policy.to_owned(),
            "--expected-policy-revision".to_owned(),
            policy_revision.to_string(),
            "--expected-deployment-id".to_owned(),
            deployment_id.to_string(),
        ],
        20,
    )
    .await?;
    if let Ok(val) = serde_json::from_str::<serde_json::Value>(&out)
        && let Some(err) = val.get("schedulingError").and_then(|v| v.as_str())
    {
        return Ok(format!("Policy set to {policy} (scheduler note: {err})"));
    }
    Ok(format!("Update policy set to {policy}"))
}

pub async fn retire_host(root_path: &Path, interrupt: bool) -> Result<String, String> {
    let reg = read_live_discovery(root_path).await?;
    let prepared = tokio::time::timeout(
        Duration::from_secs(15),
        Client::retire_with_options(&reg.endpoint, reg.host_epoch, interrupt, false),
    )
    .await
    .map_err(|_| "timed out retiring Host".to_owned())?
    .map_err(|e| format!("retire failed: {e}"))?;
    if prepared {
        Ok(format!("Retired Host (pid {})", reg.pid))
    } else {
        Err(
            "Host has active tasks; use Force Retire (interrupt) if you want to interrupt them"
                .to_owned(),
        )
    }
}

pub async fn update_remote_access_with<F>(root_path: &Path, mutate: F) -> Result<String, String>
where
    F: FnOnce(&mut RemoteAccessUpdate) -> Result<String, String>,
{
    let reg = read_live_discovery(root_path).await?;
    let current = tokio::time::timeout(
        Duration::from_secs(5),
        Client::remote_access_status(&reg.endpoint, reg.host_epoch, None),
    )
    .await
    .map_err(|_| "timed out reading remote access status".to_owned())?
    .map_err(|e| format!("failed to read remote access status: {e}"))?;

    let mut update = RemoteAccessUpdate {
        enabled: current.config.enabled,
        relay_only: current.config.relay_only,
        relays: current
            .config
            .relays
            .into_iter()
            .map(|r| RemoteRelayUpdate {
                endpoint: r.endpoint,
                ca_der_path: r.ca_der_path,
                auth: RelayAuthUpdate::Keep,
            })
            .collect(),
    };
    let summary = mutate(&mut update)?;

    tokio::time::timeout(
        Duration::from_secs(10),
        Client::update_remote_access(&reg.endpoint, reg.host_epoch, update),
    )
    .await
    .map_err(|_| "timed out updating remote access".to_owned())?
    .map_err(|e| format!("failed to update remote access: {e}"))?;
    Ok(summary)
}

pub async fn set_remote_access_enabled(root_path: &Path, enabled: bool) -> Result<String, String> {
    update_remote_access_with(root_path, |u| {
        if enabled && u.relays.is_empty() {
            return Err("Add at least one relay URL before enabling Remote Access".to_owned());
        }
        u.enabled = enabled;
        Ok(if enabled {
            "Remote Access enabled".to_owned()
        } else {
            "Remote Access disabled".to_owned()
        })
    })
    .await
}

pub async fn set_remote_access_relay_only(
    root_path: &Path,
    relay_only: bool,
) -> Result<String, String> {
    update_remote_access_with(root_path, |u| {
        u.relay_only = relay_only;
        Ok(if relay_only {
            "Relay-only mode enabled".to_owned()
        } else {
            "Direct + Relay mode enabled".to_owned()
        })
    })
    .await
}

pub async fn add_host_relay(
    root_path: &Path,
    url: String,
    quic_port: Option<u16>,
    cert_sha256: Option<String>,
    ca_der_path: Option<String>,
    auth_token: Option<String>,
    auto_enable: bool,
) -> Result<String, String> {
    let trimmed_url = url.trim().to_owned();
    let endpoint = RelayEndpoint {
        url: trimmed_url.clone(),
        quic_port,
        cert_sha256: cert_sha256
            .map(|s| s.trim().to_owned())
            .filter(|s| !s.is_empty()),
    };
    let validated = endpoint
        .validate()
        .map_err(|e| format!("invalid relay endpoint: {e}"))?;
    let normalized_url = validated.url.to_string();
    let ca_path = ca_der_path
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
        .map(PathBuf::from);
    let auth = match auth_token
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
    {
        Some(token) => RelayAuthUpdate::Replace(token),
        None => RelayAuthUpdate::Clear,
    };

    update_remote_access_with(root_path, move |u| {
        u.relays.retain(|r| r.endpoint.url != normalized_url);
        u.relays.push(RemoteRelayUpdate {
            endpoint: RelayEndpoint {
                url: normalized_url.clone(),
                quic_port,
                cert_sha256: endpoint.cert_sha256,
            },
            ca_der_path: ca_path,
            auth,
        });
        if auto_enable {
            u.enabled = true;
        }
        Ok(format!("Configured relay {normalized_url}"))
    })
    .await
}

pub async fn remove_host_relay(root_path: &Path, url: &str) -> Result<String, String> {
    let target = url.to_owned();
    update_remote_access_with(root_path, move |u| {
        let before = u.relays.len();
        u.relays.retain(|r| r.endpoint.url != target);
        if u.relays.len() == before {
            return Err(format!("relay {target} was not configured"));
        }
        if u.relays.is_empty() {
            u.enabled = false;
        }
        Ok(format!("Removed relay {target}"))
    })
    .await
}

pub async fn create_pairing_invite(
    root_path: &Path,
    host_name: String,
    label: Option<String>,
    ttl_secs: Option<u64>,
) -> Result<PairingInviteView, String> {
    let name = host_name.trim().to_owned();
    if name.is_empty() {
        return Err("Host name is required for pairing invite".to_owned());
    }
    let reg = read_live_discovery(root_path).await?;
    let invite = tokio::time::timeout(
        Duration::from_secs(10),
        Client::prepare_peer_pairing(
            &reg.endpoint,
            reg.host_epoch,
            PeerPairingOptions {
                host_name: name,
                label: label.map(|s| s.trim().to_owned()).filter(|s| !s.is_empty()),
                ttl_secs,
            },
        ),
    )
    .await
    .map_err(|_| "timed out creating pairing invite".to_owned())?
    .map_err(|e| format!("failed to create pairing invite: {e}"))?;

    Ok(PairingInviteView {
        uri: invite.uri,
        host_peer_id: invite.host_peer_id,
        root_id: invite.root_id,
        invite_id: invite.invite_id,
        expires_at_ms: invite.expires_at_ms,
        relays: invite.relays.into_iter().map(|r| r.url).collect(),
        state: Some("pending".to_owned()),
    })
}

pub async fn revoke_peer(root_path: &Path, peer_id: &str) -> Result<String, String> {
    let reg = read_live_discovery(root_path).await?;
    let parsed = PeerId::new(peer_id.to_owned()).map_err(|e| format!("invalid peer ID: {e}"))?;
    let revoked = tokio::time::timeout(
        Duration::from_secs(10),
        Client::revoke_peer_access(&reg.endpoint, reg.host_epoch, &parsed),
    )
    .await
    .map_err(|_| "timed out revoking peer".to_owned())?
    .map_err(|e| format!("revoke peer failed: {e}"))?;
    if revoked {
        Ok(format!("Revoked peer {peer_id}"))
    } else {
        Ok(format!("Peer {peer_id} was already revoked or absent"))
    }
}

pub async fn prepare_app_access(
    root_path: &Path,
    principal: String,
) -> Result<AppPairingView, String> {
    let principal = principal.trim().to_owned();
    if principal.is_empty()
        || principal.len() > 128
        || !principal
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.:-".contains(&b))
    {
        return Err("principal must be 1-128 ASCII letters, digits, or _ . : -".to_owned());
    }
    let reg = read_live_discovery(root_path).await?;
    let pairing = tokio::time::timeout(
        Duration::from_secs(10),
        Client::prepare_access(&reg.endpoint, reg.host_epoch, principal.clone()),
    )
    .await
    .map_err(|_| "timed out preparing application pairing".to_owned())?
    .map_err(|e| format!("prepare access failed: {e}"))?;

    Ok(AppPairingView {
        principal,
        root_id: pairing.root_id,
        credential_id: pairing.credential_id,
        credential: pairing.credential,
    })
}

pub async fn revoke_app_credential(
    root_path: &Path,
    credential_id: String,
) -> Result<String, String> {
    let id = credential_id.trim().to_owned();
    if id.is_empty() {
        return Err("credential ID is required".to_owned());
    }
    let reg = read_live_discovery(root_path).await?;
    let revoked = tokio::time::timeout(
        Duration::from_secs(10),
        Client::revoke_access(&reg.endpoint, reg.host_epoch, id.clone()),
    )
    .await
    .map_err(|_| "timed out revoking credential".to_owned())?
    .map_err(|e| format!("revoke credential failed: {e}"))?;
    if revoked {
        Ok(format!("Revoked credential {id}"))
    } else {
        Ok(format!("Credential {id} was already revoked or absent"))
    }
}

pub async fn check_for_updates() -> UpdateCheckState {
    let info = BuildInfo::current();
    if info.channel == Channel::Dev {
        return UpdateCheckState::DevBuild;
    }
    match tokio::time::timeout(Duration::from_secs(15), maka_updater::check(&info)).await {
        Ok(Ok(Some(available))) => UpdateCheckState::Available {
            version: available.version.to_string(),
            url: available.url.clone(),
        },
        Ok(Ok(None)) => UpdateCheckState::UpToDate,
        Ok(Err(error)) => UpdateCheckState::Error {
            message: error.to_string(),
        },
        Err(_) => UpdateCheckState::Error {
            message: "Update check timed out".to_owned(),
        },
    }
}

fn parse_control_outcome(stdout: &str, default_msg: &str) -> Result<String, String> {
    if let Ok(val) = serde_json::from_str::<serde_json::Value>(stdout)
        && let Some(kind) = val.get("kind").and_then(|v| v.as_str())
    {
        return match kind {
            "active_tasks" => {
                Err("Host has active tasks; wait for them to finish or use Force Retire".to_owned())
            }
            "stopped" => Ok("Stopped Host deployment".to_owned()),
            "ready" => {
                let pid = val
                    .pointer("/host/pid")
                    .and_then(|v| v.as_u64())
                    .map(|p| format!(" (pid {p})"))
                    .unwrap_or_default();
                Ok(format!("Host ready{pid}"))
            }
            "unregistered" => Ok("Uninstalled deployment (State Root preserved)".to_owned()),
            _ => Ok(default_msg.to_owned()),
        };
    }
    Ok(default_msg.to_owned())
}
