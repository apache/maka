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
    model::{AdminCommand, LocalRelayState},
    ui::{
        components::{
            action_btn, badge, empty_state, format_uptime, inline_link, kv_row, kv_row_with_action,
            notice_banner, panel_card, remote_status_tone, short_hash,
        },
        state::{
            copy_text, open_add_relay_modal, open_confirm, open_local_relay_editor, send_command,
            snapshot_signal,
        },
        theme::{CELL_H, CELL_W, Tone, palette},
    },
};
use nsh_core::{element::AnyElement, prelude::*};

pub fn relay_screen() -> AnyElement {
    scroll()
        .flex_1()
        .child(dynamic(move || {
            let snap = snapshot_signal().with(|s| s.0.clone());
            let active_host = snap.selected_host().cloned();

            // 1. Local Self-Hosted Relay Server Card
            let local_relay_card = {
                let cfg = snap.local_relay_config.clone();
                let (status_badge, mut rows, mut actions) = match &snap.local_relay {
                    LocalRelayState::Running(rt) => {
                        let mut rows: Vec<AnyElement> = Vec::new();
                        let ep_copy = rt.endpoint_url.clone();
                        rows.push(kv_row_with_action(
                            "Endpoint URL",
                            rt.endpoint_url.clone(),
                            Tone::Accent,
                            "Copy",
                            move || copy_text("Relay URL", &ep_copy),
                        ));
                        if let Some(http) = &rt.http_addr {
                            rows.push(kv_row("HTTP Listener", http.clone(), Tone::Neutral));
                        }
                        if let Some(https) = &rt.https_addr {
                            rows.push(kv_row("HTTPS Listener", https.clone(), Tone::Success));
                        }
                        if let Some(quic) = &rt.quic_addr {
                            rows.push(kv_row("QUIC Discovery", quic.clone(), Tone::Primary));
                        }
                        if let Some(sha) = &rt.cert_sha256 {
                            let sha_copy = sha.clone();
                            rows.push(kv_row_with_action(
                                "Cert SHA-256",
                                short_hash(sha),
                                Tone::Muted,
                                "Copy",
                                move || copy_text("Cert SHA-256", &sha_copy),
                            ));
                        }
                        rows.push(kv_row(
                            "Bearer Auth",
                            if rt.has_auth_token {
                                "Enabled (token protected)"
                            } else {
                                "Disabled (open on listener)"
                            },
                            if rt.has_auth_token { Tone::Success } else { Tone::Warning },
                        ));
                        rows.push(kv_row(
                            "Uptime",
                            format!("{} (since {})", format_uptime(rt.uptime_secs), rt.started_at),
                            Tone::Muted,
                        ));
                        let cli_copy = rt.cli_command.clone();
                        rows.push(kv_row_with_action(
                            "CLI Equivalent",
                            rt.cli_command.clone(),
                            Tone::Muted,
                            "Copy",
                            move || copy_text("maka relay command", &cli_copy),
                        ));

                        let mut actions: Vec<AnyElement> = vec![
                            action_btn("Stop Relay", Tone::Danger, false, || {
                                send_command(AdminCommand::StopLocalRelay);
                            }),
                            action_btn("Configure…", Tone::Accent, false, open_local_relay_editor),
                        ];
                        if let Some(host) = &active_host
                            && host.health.is_live()
                        {
                            let rp = host.root_path.clone();
                            actions.push(action_btn(
                                "Attach to Active Host",
                                Tone::Success,
                                false,
                                move || {
                                    send_command(AdminCommand::ApplyLocalRelayToHost {
                                        root_path: rp.clone(),
                                    });
                                },
                            ));
                        }
                        (badge("Running", Tone::Success), rows, actions)
                    }
                    LocalRelayState::Stopped => {
                        let rows = vec![
                            kv_row("TLS Mode", cfg.tls_mode.label(), Tone::Neutral),
                            kv_row(
                                "HTTP Bind",
                                if cfg.http_addr.is_empty() { "disabled".to_owned() } else { cfg.http_addr.clone() },
                                Tone::Muted,
                            ),
                            kv_row(
                                "HTTPS Bind",
                                if cfg.https_addr.is_empty() { "disabled".to_owned() } else { cfg.https_addr.clone() },
                                Tone::Muted,
                            ),
                            kv_row(
                                "QUIC Bind",
                                if cfg.quic_addr.is_empty() { "disabled".to_owned() } else { cfg.quic_addr.clone() },
                                Tone::Muted,
                            ),
                            kv_row(
                                "Bearer Auth",
                                if cfg.auth_token.is_empty() { "none" } else { "configured" },
                                Tone::Muted,
                            ),
                        ];
                        let cfg_start = cfg.clone();
                        let actions = vec![
                            action_btn("Start Local Relay", Tone::Success, false, move || {
                                send_command(AdminCommand::StartLocalRelay {
                                    config: cfg_start.clone(),
                                });
                            }),
                            action_btn("Configure…", Tone::Accent, false, open_local_relay_editor),
                            action_btn("Generate Token", Tone::Primary, false, || {
                                send_command(AdminCommand::GenerateRelayToken);
                            }),
                        ];
                        (badge("Stopped", Tone::Muted), rows, actions)
                    }
                    LocalRelayState::Error { message } => {
                        let rows = vec![notice_banner(message.clone(), Tone::Danger)];
                        let cfg_retry = cfg.clone();
                        let actions = vec![
                            action_btn("Retry Start", Tone::Warning, false, move || {
                                send_command(AdminCommand::StartLocalRelay {
                                    config: cfg_retry.clone(),
                                });
                            }),
                            action_btn("Configure…", Tone::Accent, false, open_local_relay_editor),
                        ];
                        (badge("Error", Tone::Danger), rows, actions)
                    }
                };

                let body = view()
                    .children(rows.drain(..))
                    .child(
                        view()
                            .mt(px(CELL_H))
                            .flex_row()
                            .flex_wrap()
                            .gap(px(CELL_W))
                            .children(actions.drain(..)),
                    )
                    .into_element();

                panel_card(
                    "Local Self-Hosted Relay Server",
                    Some(status_badge),
                    body,
                )
            };

            // 2. Active Host Remote Access & Relay Routing Card
            let host_remote_card = if let Some(host) = active_host {
                if let Some(ra) = &host.remote_access {
                    let mut rows: Vec<AnyElement> = Vec::new();
                    if let Some(err) = &ra.error {
                        rows.push(notice_banner(err.clone(), Tone::Danger));
                    }
                    if ra.cli_override {
                        rows.push(notice_banner(
                            "Host started with CLI relay override; saved changes apply on next normal start",
                            Tone::Warning,
                        ));
                    }
                    if let Some(sas) = &ra.sas {
                        rows.push(notice_banner(
                            format!("Pairing SAS verification code: {} (peer {})", sas.sas, short_hash(&sas.peer_id)),
                            Tone::Peer,
                        ));
                    }

                    let peer_copy = ra.peer_id.clone();
                    rows.push(kv_row_with_action(
                        "Host Peer ID",
                        short_hash(&ra.peer_id),
                        Tone::Peer,
                        "Copy",
                        move || copy_text("Host Peer ID", &peer_copy),
                    ));
                    rows.push(kv_row(
                        "Remote Access",
                        if ra.enabled { "Enabled" } else { "Disabled" },
                        if ra.enabled { Tone::Success } else { Tone::Muted },
                    ));
                    rows.push(kv_row(
                        "Routing Mode",
                        if ra.relay_only {
                            "Relay only (strict)"
                        } else {
                            "Direct P2P + Relay fallback"
                        },
                        Tone::Neutral,
                    ));

                    let rp_enable = host.root_path.clone();
                    let next_enabled = !ra.enabled;
                    let rp_relay_only = host.root_path.clone();
                    let next_relay_only = !ra.relay_only;

                    let controls = view()
                        .mt(px(CELL_H))
                        .flex_row()
                        .flex_wrap()
                        .gap(px(CELL_W))
                        .child(action_btn(
                            if ra.enabled {
                                "Disable Remote Access"
                            } else {
                                "Enable Remote Access"
                            },
                            if ra.enabled { Tone::Warning } else { Tone::Success },
                            false,
                            move || {
                                send_command(AdminCommand::SetRemoteAccessEnabled {
                                    root_path: rp_enable.clone(),
                                    enabled: next_enabled,
                                });
                            },
                        ))
                        .child(action_btn(
                            if ra.relay_only {
                                "Allow Direct P2P"
                            } else {
                                "Force Relay-Only"
                            },
                            Tone::Primary,
                            false,
                            move || {
                                send_command(AdminCommand::SetRemoteAccessRelayOnly {
                                    root_path: rp_relay_only.clone(),
                                    relay_only: next_relay_only,
                                });
                            },
                        ))
                        .child(action_btn("+ Add Relay…", Tone::Accent, false, open_add_relay_modal))
                        .into_element();

                    let relay_list: Vec<AnyElement> = if ra.relays.is_empty() {
                        vec![empty_state(
                            "No upstream relays configured",
                            "Add a relay URL or start the Local Relay above and click Attach to Active Host.",
                        )]
                    } else {
                        ra.relays
                            .iter()
                            .map(|relay| {
                                let conn_tone = if relay.connected {
                                    Tone::Success
                                } else if ra.enabled {
                                    Tone::Warning
                                } else {
                                    Tone::Muted
                                };
                                let mut flags = Vec::new();
                                if let Some(q) = relay.quic_port {
                                    flags.push(format!("quic:{q}"));
                                }
                                if relay.cert_sha256.is_some() {
                                    flags.push("pin".to_owned());
                                }
                                if relay.ca_der_path.is_some() {
                                    flags.push("ca".to_owned());
                                }
                                if relay.has_auth_token {
                                    flags.push("bearer".to_owned());
                                }
                                let flags_str = if flags.is_empty() {
                                    "default".to_owned()
                                } else {
                                    flags.join(" · ")
                                };
                                let rp_rm = host.root_path.clone();
                                let url_rm = relay.url.clone();
                                let url_copy = relay.url.clone();

                                view()
                                    .h(px(CELL_H))
                                    .flex_row()
                                    .items_center()
                                    .gap(px(CELL_W))
                                    .child(
                                        text(conn_tone.dot())
                                            .w(px(2.0 * CELL_W))
                                            .text_color(conn_tone.color()),
                                    )
                                    .child(
                                        text(relay.url.clone())
                                            .flex_1()
                                            .number_of_lines(1)
                                            .text_color(palette::TEXT),
                                    )
                                    .child(
                                        text(flags_str)
                                            .w(px(20.0 * CELL_W))
                                            .number_of_lines(1)
                                            .text_color(palette::FAINT),
                                    )
                                    .child(inline_link("Copy", Tone::Accent, move || {
                                        copy_text("Relay URL", &url_copy);
                                    }))
                                    .child(inline_link("Remove", Tone::Danger, move || {
                                        open_confirm(
                                            "Remove relay from Host?",
                                            format!("Removes {url_rm} from this Host's remote access routing."),
                                            "Remove Relay",
                                            true,
                                            AdminCommand::RemoveHostRelay {
                                                root_path: rp_rm.clone(),
                                                url: url_rm.clone(),
                                            },
                                        );
                                    }))
                                    .into_element()
                            })
                            .collect()
                    };

                    let body = view()
                        .children(rows)
                        .child(controls)
                        .child(
                            view()
                                .mt(px(CELL_H))
                                .pt(px(CELL_H))
                                .border_t_1()
                                .border_t_color(palette::BORDER)
                                .child(
                                    text(format!("Configured Relays ({})", ra.relays.len()))
                                        .h(px(CELL_H))
                                        .font_weight(FontWeight::SEMIBOLD)
                                        .text_color(palette::MUTED),
                                )
                                .children(relay_list),
                        )
                        .into_element();

                    panel_card(
                        format!("Active Host Remote Access · {}", host.label),
                        Some(badge(ra.status.clone(), remote_status_tone(&ra.status))),
                        body,
                    )
                } else {
                    panel_card(
                        format!("Active Host Remote Access · {}", host.label),
                        Some(badge("Host Offline", Tone::Muted)),
                        empty_state(
                            "Host is not running",
                            "Activate the Host in Overview or Hosts to inspect and configure its remote access relays.",
                        ),
                    )
                }
            } else {
                panel_card(
                    "Active Host Remote Access",
                    None,
                    empty_state("No Host selected", "Initialize or select a State Root first."),
                )
            };

            view()
                .p(px(CELL_W))
                .gap(px(CELL_H))
                .child(local_relay_card)
                .child(host_remote_card)
                .into_element()
        }))
        .into_element()
}
