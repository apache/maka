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

use crate::{
    model::{AdminCommand, LocalRelayState, TabId, UpdateCheckState},
    ui::{
        components::{
            action_btn, badge, empty_state, format_uptime, health_tone, kv_row, kv_row_with_action,
            metric_tile, panel_card, remote_status_tone, short_hash,
        },
        state::{
            copy_text, open_command_palette, open_confirm, open_init_root_modal, open_invite_modal,
            open_local_relay_editor, send_command, set_tab, snapshot_signal,
        },
        theme::{CELL_H, CELL_W, Tone, is_compact, palette},
    },
};
use nsh_core::{element::AnyElement, prelude::*};

pub fn overview_screen() -> AnyElement {
    scroll()
        .flex_1()
        .child(dynamic(move || {
            let snap = snapshot_signal().with(|s| s.0.clone());
            let compact = is_compact();

            let total_hosts = snap.hosts.len();
            let live_hosts = snap.hosts.iter().filter(|h| h.health.is_live()).count();
            let total_sessions: usize = snap
                .hosts
                .iter()
                .filter_map(|h| h.runtime.as_ref())
                .map(|r| r.sessions)
                .sum();
            let total_peers: usize = snap.hosts.iter().map(|h| h.peers.len()).sum();

            let (relay_val, relay_sub, relay_tone) = match &snap.local_relay {
                LocalRelayState::Running(rt) => {
                    let addr = rt
                        .https_addr
                        .as_deref()
                        .or(rt.http_addr.as_deref())
                        .unwrap_or("active");
                    let short = addr
                        .rsplit_once(':')
                        .map(|(_, port)| format!(":{port}"))
                        .unwrap_or_else(|| addr.to_owned());
                    (
                        "Running".to_owned(),
                        format!("{short} · {}", format_uptime(rt.uptime_secs)),
                        Tone::Success,
                    )
                }
                LocalRelayState::Stopped => (
                    "Stopped".to_owned(),
                    "Ready to start".to_owned(),
                    Tone::Muted,
                ),
                LocalRelayState::Error { message } => {
                    ("Error".to_owned(), message.clone(), Tone::Danger)
                }
            };

            let active = snap.selected_host().cloned();
            let (ra_val, ra_sub, ra_tone) = match active.as_ref().and_then(|h| h.remote_access.as_ref()) {
                Some(ra) => (
                    ra.status.to_uppercase(),
                    format!(
                        "{}/{} relay(s) up",
                        ra.connected_relays.len(),
                        ra.relays.len()
                    ),
                    remote_status_tone(&ra.status),
                ),
                None => (
                    "Offline".to_owned(),
                    "Host not running".to_owned(),
                    Tone::Muted,
                ),
            };

            let kpis = if compact {
                view()
                    .gap(px(CELL_H))
                    .child(
                        view()
                            .flex_row()
                            .gap(px(CELL_W))
                            .child(metric_tile(
                                "HOSTS",
                                format!("{live_hosts} / {total_hosts}"),
                                format!("{total_sessions} session(s)"),
                                if live_hosts > 0 { Tone::Success } else { Tone::Muted },
                            ))
                            .child(metric_tile("LOCAL RELAY", relay_val, relay_sub, relay_tone)),
                    )
                    .child(
                        view()
                            .flex_row()
                            .gap(px(CELL_W))
                            .child(metric_tile("REMOTE ACCESS", ra_val, ra_sub, ra_tone))
                            .child(metric_tile(
                                "PEERS",
                                total_peers.to_string(),
                                "Authorized devices",
                                if total_peers > 0 { Tone::Peer } else { Tone::Muted },
                            )),
                    )
                    .into_element()
            } else {
                view()
                    .flex_row()
                    .gap(px(CELL_W))
                    .child(metric_tile(
                        "HOSTS",
                        format!("{live_hosts} / {total_hosts}"),
                        format!("{total_sessions} session(s)"),
                        if live_hosts > 0 { Tone::Success } else { Tone::Muted },
                    ))
                    .child(metric_tile("LOCAL RELAY", relay_val, relay_sub, relay_tone))
                    .child(metric_tile("REMOTE ACCESS", ra_val, ra_sub, ra_tone))
                    .child(metric_tile(
                        "PEERS",
                        total_peers.to_string(),
                        "Authorized devices",
                        if total_peers > 0 { Tone::Peer } else { Tone::Muted },
                    ))
                    .into_element()
            };

            let host_card = if let Some(host) = active.clone() {
                let tone = health_tone(&host.health);
                let mut rows: Vec<AnyElement> = vec![
                    kv_row("Root", host.root_path.display().to_string(), Tone::Neutral),
                    kv_row(
                        "Root ID",
                        host.root_id
                            .as_deref()
                            .map(short_hash)
                            .unwrap_or_else(|| "Not initialized".to_owned()),
                        Tone::Muted,
                    ),
                ];

                if let Some(rt) = &host.runtime {
                    rows.push(kv_row(
                        "Process",
                        format!(
                            "pid {} · {} · proto v{}",
                            rt.pid, rt.lifecycle_mode, rt.protocol_version
                        ),
                        Tone::Success,
                    ));
                    rows.push(kv_row(
                        "Activity",
                        format!(
                            "{} session(s) · {} active call(s) · {} endpoint(s)",
                            rt.sessions,
                            rt.active_calls,
                            rt.published_endpoints.len()
                        ),
                        Tone::Neutral,
                    ));
                    if let Some(ws) = rt.websocket_endpoints.first() {
                        let ws_copy = ws.clone();
                        rows.push(kv_row_with_action(
                            "WebSocket",
                            ws.clone(),
                            Tone::Accent,
                            "Copy",
                            move || copy_text("WebSocket endpoint", &ws_copy),
                        ));
                    }
                } else {
                    rows.push(kv_row(
                        "Runtime",
                        "No live Host process detected",
                        Tone::Muted,
                    ));
                }

                if let Some(dep) = &host.deployment {
                    let sup_text = match dep.supervisor_state.as_deref() {
                        Some(state) => format!("{} ({state})", dep.mode),
                        None => dep.mode.clone(),
                    };
                    rows.push(kv_row(
                        "Deployment",
                        format!(
                            "rev {} · {} · policy {}",
                            dep.config_revision, sup_text, dep.update_policy
                        ),
                        Tone::Neutral,
                    ));
                    if dep.pending_update_sha256.is_some() {
                        rows.push(kv_row(
                            "Pending Update",
                            "Interrupted update awaiting reconcile",
                            Tone::Warning,
                        ));
                    }
                }

                // Quick actions strip for the active Host
                let mut actions: Vec<AnyElement> = Vec::new();
                if !host.health.is_live() {
                    let root_id = host.root_id.clone();
                    let root_path = host.root_path.clone();
                    actions.push(action_btn("Start / Activate", Tone::Success, false, move || {
                        send_command(AdminCommand::ActivateHost {
                            root_id: root_id.clone(),
                            root_path: root_path.clone(),
                        });
                    }));
                }
                if let Some(dep) = &host.deployment
                    && let Some(root_id) = &host.root_id
                {
                    let rid = root_id.clone();
                    let did = dep.deployment_id;
                    let rev = dep.config_revision;
                    actions.push(action_btn("Restart", Tone::Primary, false, move || {
                        send_command(AdminCommand::RestartHost {
                            root_id: rid.clone(),
                            deployment_id: did,
                            config_revision: rev,
                        });
                    }));
                    let rid2 = root_id.clone();
                    actions.push(action_btn("Stop", Tone::Warning, false, move || {
                        open_confirm(
                            "Stop managed Host?",
                            "Retires idle sessions and stops the OS service without changing configuration.",
                            "Stop Host",
                            true,
                            AdminCommand::StopHost {
                                root_id: rid2.clone(),
                                deployment_id: did,
                                config_revision: rev,
                            },
                        );
                    }));
                } else if host.health.is_live() {
                    let rp = host.root_path.clone();
                    actions.push(action_btn("Retire", Tone::Warning, false, move || {
                        open_confirm(
                            "Retire running Host?",
                            "Cleanly shuts down the Host if no active tasks are running.",
                            "Retire Host",
                            true,
                            AdminCommand::RetireHost {
                                root_path: rp.clone(),
                                interrupt: false,
                            },
                        );
                    }));
                }
                actions.push(action_btn("Inspect Hosts →", Tone::Accent, false, || {
                    set_tab(TabId::Hosts);
                }));
                actions.push(action_btn("Logs →", Tone::Neutral, false, || {
                    set_tab(TabId::Logs);
                }));

                let body = view()
                    .children(rows)
                    .child(
                        view()
                            .mt(px(CELL_H))
                            .flex_row()
                            .flex_wrap()
                            .gap(px(CELL_W))
                            .children(actions),
                    )
                    .into_element();

                panel_card(
                    format!("Active Host · {}", host.label),
                    Some(badge(host.health.label(), tone)),
                    body,
                )
            } else {
                panel_card(
                    "Active Host",
                    None,
                    empty_state(
                        "No State Roots discovered yet",
                        "Press Init Root below or launch with --root <DIRECTORY>.",
                    ),
                )
            };

            let quick_ops_card = {
                let relay_running = matches!(snap.local_relay, LocalRelayState::Running(_));
                let relay_cfg = snap.local_relay_config.clone();
                let mut buttons: Vec<AnyElement> = vec![
                    if relay_running {
                        action_btn("Stop Local Relay", Tone::Warning, false, || {
                            send_command(AdminCommand::StopLocalRelay);
                        })
                    } else {
                        action_btn("Start Local Relay", Tone::Success, false, move || {
                            send_command(AdminCommand::StartLocalRelay {
                                config: relay_cfg.clone(),
                            });
                        })
                    },
                    action_btn("Configure Relay…", Tone::Accent, false, open_local_relay_editor),
                    action_btn("New Pairing Invite…", Tone::Peer, active.as_ref().is_none_or(|h| !h.health.is_live()), open_invite_modal),
                    action_btn("Init Root…", Tone::Neutral, false, open_init_root_modal),
                    action_btn("Check Updates", Tone::Primary, matches!(snap.update_check, UpdateCheckState::Checking), || {
                        send_command(AdminCommand::CheckUpdates);
                    }),
                    action_btn("Command Palette (:)", Tone::Muted, false, open_command_palette),
                ];

                let update_note = match &snap.update_check {
                    UpdateCheckState::Available { version, .. } => Some(kv_row(
                        "Release",
                        format!("Update available: v{version}"),
                        Tone::Warning,
                    )),
                    UpdateCheckState::UpToDate => Some(kv_row(
                        "Release",
                        format!("Maka v{} ({}) — up to date", snap.system.version, snap.system.channel),
                        Tone::Success,
                    )),
                    UpdateCheckState::DevBuild => Some(kv_row(
                        "Release",
                        format!("Maka v{} (dev build)", snap.system.version),
                        Tone::Muted,
                    )),
                    _ => None,
                };

                let body = view()
                    .child(
                        view()
                            .flex_row()
                            .flex_wrap()
                            .gap(px(CELL_W))
                            .children(buttons.drain(..)),
                    )
                    .children(update_note.map(|n| view().mt(px(CELL_H)).child(n)))
                    .into_element();

                panel_card("Quick Actions", None, body)
            };

            let activity_card = {
                let body = if snap.activity.is_empty() {
                    empty_state(
                        "No control plane actions yet",
                        "Actions executed in this session appear here with outcomes.",
                    )
                } else {
                    let rows: Vec<AnyElement> = snap
                        .activity
                        .iter()
                        .take(8)
                        .map(|item| {
                            let tone = if item.ok { Tone::Success } else { Tone::Danger };
                            view()
                                .h(px(CELL_H))
                                .flex_row()
                                .items_center()
                                .gap(px(CELL_W))
                                .child(text(item.at.clone()).w(px(9.0 * CELL_W)).text_color(palette::FAINT))
                                .child(
                                    text(tone.dot())
                                        .w(px(2.0 * CELL_W))
                                        .text_color(tone.color()),
                                )
                                .child(
                                    text(format!("{}: {}", item.target, item.action))
                                        .w(px(24.0 * CELL_W))
                                        .number_of_lines(1)
                                        .text_color(palette::TEXT),
                                )
                                .child(
                                    text(item.detail.clone())
                                        .flex_1()
                                        .number_of_lines(1)
                                        .text_color(if item.ok {
                                            palette::MUTED
                                        } else {
                                            palette::DANGER
                                        }),
                                )
                                .into_element()
                        })
                        .collect();
                    view().children(rows).into_element()
                };
                panel_card(
                    "Recent Activity",
                    Some(
                        text(format!("{} event(s)", snap.activity.len()))
                            .text_color(palette::FAINT)
                            .into_element(),
                    ),
                    body,
                )
            };

            view()
                .p(px(CELL_W))
                .gap(px(CELL_H))
                .child(kpis)
                .child(host_card)
                .child(quick_ops_card)
                .child(activity_card)
                .into_element()
        }))
        .into_element()
}
