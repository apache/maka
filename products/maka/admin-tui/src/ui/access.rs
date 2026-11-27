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
    model::AdminCommand,
    ui::{
        components::{
            action_btn, badge, empty_state, inline_link, kv_row, kv_row_with_action, notice_banner,
            panel_card, section_heading, short_hash,
        },
        state::{
            copy_text, open_confirm, open_invite_modal, open_prepare_access_modal,
            open_revoke_cred_modal, snapshot_signal,
        },
        theme::{CELL_H, CELL_W, Tone, palette},
    },
};
use nsh_core::{element::AnyElement, prelude::*};

pub fn access_screen() -> AnyElement {
    scroll()
        .flex_1()
        .child(dynamic(move || {
            let snap = snapshot_signal().with(|s| s.0.clone());
            let Some(host) = snap.selected_host().cloned() else {
                return view()
                    .p(px(CELL_W))
                    .child(panel_card(
                        "Access & Peers",
                        None,
                        empty_state("No Host selected", "Select or initialize a Host first."),
                    ))
                    .into_element();
            };

            let host_live = host.health.is_live();

            // 1. Native Pairing Invite Card
            let invite_card = {
                let mut rows: Vec<AnyElement> = Vec::new();
                if let Some(ra) = &host.remote_access
                    && let Some(sas) = &ra.sas
                {
                    rows.push(notice_banner(
                        format!(
                            "Verify SAS code on peer device: {}  (peer {})",
                            sas.sas,
                            short_hash(&sas.peer_id)
                        ),
                        Tone::Peer,
                    ));
                }

                if let Some(invite) = &snap.active_invite
                    && host.root_id.as_deref() == Some(invite.root_id.as_str())
                {
                    let state_str = invite.state.as_deref().unwrap_or("pending");
                    let state_tone = match state_str {
                        "consumed" => Tone::Success,
                        "expired" => Tone::Danger,
                        _ => Tone::Warning,
                    };
                    let uri_copy = invite.uri.clone();
                    rows.push(kv_row("Invite ID", invite.invite_id.clone(), Tone::Neutral));
                    rows.push(kv_row("Status", state_str.to_uppercase(), state_tone));
                    rows.push(kv_row("Host Peer ID", short_hash(&invite.host_peer_id), Tone::Peer));
                    rows.push(kv_row(
                        "Relays",
                        if invite.relays.is_empty() {
                            "none".to_owned()
                        } else {
                            invite.relays.join(", ")
                        },
                        Tone::Muted,
                    ));
                    rows.push(kv_row_with_action(
                        "Pairing URI",
                        invite.uri.clone(),
                        Tone::Accent,
                        "Copy URI",
                        move || copy_text("Pairing URI", &uri_copy),
                    ));
                } else {
                    rows.push(
                        text("Generate a signed, one-time pairing URI to authorize a native mobile or desktop peer.")
                            .text_color(palette::MUTED)
                            .into_element(),
                    );
                }

                let body = view()
                    .children(rows)
                    .child(
                        view()
                            .mt(px(CELL_H))
                            .flex_row()
                            .flex_wrap()
                            .gap(px(CELL_W))
                            .child(action_btn(
                                "+ New Pairing Invite…",
                                Tone::Peer,
                                !host_live,
                                open_invite_modal,
                            )),
                    )
                    .into_element();

                panel_card(
                    "Native Peer Pairing",
                    Some(badge(
                        if host_live { "Host Ready" } else { "Host Offline" },
                        if host_live { Tone::Success } else { Tone::Muted },
                    )),
                    body,
                )
            };

            // 2. Authorized Native Peers Table
            let peers_card = {
                let body = if !host_live {
                    empty_state(
                        "Host is offline",
                        "Start the Host to inspect and manage authorized peers.",
                    )
                } else if host.peers.is_empty() {
                    empty_state(
                        "No authorized native peers",
                        "Create a pairing invite above to pair an iOS or remote desktop client.",
                    )
                } else {
                    let rows: Vec<AnyElement> = host
                        .peers
                        .iter()
                        .map(|peer| {
                            let rp = host.root_path.clone();
                            let pid = peer.peer_id.clone();
                            let pid_copy = peer.peer_id.clone();
                            let label = if peer.label.is_empty() {
                                "Unnamed device".to_owned()
                            } else {
                                peer.label.clone()
                            };
                            let seen = peer
                                .last_active_at
                                .clone()
                                .unwrap_or_else(|| "never".to_owned());

                            view()
                                .h(px(CELL_H))
                                .flex_row()
                                .items_center()
                                .gap(px(CELL_W))
                                .child(
                                    text(label)
                                        .w(px(18.0 * CELL_W))
                                        .number_of_lines(1)
                                        .font_weight(FontWeight::SEMIBOLD)
                                        .text_color(palette::TEXT),
                                )
                                .child(
                                    text(short_hash(&peer.peer_id))
                                        .w(px(18.0 * CELL_W))
                                        .number_of_lines(1)
                                        .text_color(palette::PEER),
                                )
                                .child(
                                    text(seen)
                                        .flex_1()
                                        .number_of_lines(1)
                                        .text_color(palette::MUTED),
                                )
                                .child(inline_link("Copy ID", Tone::Accent, move || {
                                    copy_text("Peer ID", &pid_copy);
                                }))
                                .child(inline_link("Revoke", Tone::Danger, move || {
                                    open_confirm(
                                        "Revoke authorized peer?",
                                        format!("Revokes peer {} and immediately disconnects its active sessions.", short_hash(&pid)),
                                        "Revoke Peer",
                                        true,
                                        AdminCommand::RevokePeer {
                                            root_path: rp.clone(),
                                            peer_id: pid.clone(),
                                        },
                                    );
                                }))
                                .into_element()
                        })
                        .collect();

                    view()
                        .child(section_heading(
                            "DEVICE            PEER ID           LAST ACTIVE",
                        ))
                        .children(rows)
                        .into_element()
                };

                panel_card(
                    format!("Authorized Native Peers ({})", host.peers.len()),
                    None,
                    body,
                )
            };

            // 3. Remote Application Credentials Card
            let creds_card = {
                let mut rows: Vec<AnyElement> = Vec::new();
                if let Some(app_pairing) = &snap.last_app_pairing
                    && host.root_id.as_deref() == Some(app_pairing.root_id.as_str())
                {
                    let cid_copy = app_pairing.credential_id.clone();
                    let json_payload = serde_json::to_string(&serde_json::json!({
                        "rootId": app_pairing.root_id,
                        "credentialId": app_pairing.credential_id,
                        "credential": app_pairing.credential,
                    }))
                    .unwrap_or_default();
                    rows.push(notice_banner(
                        "Short-lived pairing secret issued — share only with the intended remote client",
                        Tone::Warning,
                    ));
                    rows.push(kv_row("Principal", app_pairing.principal.clone(), Tone::Neutral));
                    rows.push(kv_row_with_action(
                        "Credential ID",
                        app_pairing.credential_id.clone(),
                        Tone::Accent,
                        "Copy ID",
                        move || copy_text("Credential ID", &cid_copy),
                    ));
                    rows.push(kv_row_with_action(
                        "Pairing JSON",
                        "•••••••• (secret hidden)",
                        Tone::Muted,
                        "Copy JSON",
                        move || copy_text("Pairing JSON", &json_payload),
                    ));
                } else {
                    rows.push(
                        text("Issue or revoke short-lived application pairing credentials for remote API/Desktop access.")
                            .text_color(palette::MUTED)
                            .into_element(),
                    );
                }

                let body = view()
                    .children(rows)
                    .child(
                        view()
                            .mt(px(CELL_H))
                            .flex_row()
                            .flex_wrap()
                            .gap(px(CELL_W))
                            .child(action_btn(
                                "Prepare Credential…",
                                Tone::Primary,
                                !host_live,
                                open_prepare_access_modal,
                            ))
                            .child(action_btn(
                                "Revoke Credential…",
                                Tone::Danger,
                                !host_live,
                                open_revoke_cred_modal,
                            )),
                    )
                    .into_element();

                panel_card("Application Credentials", None, body)
            };

            view()
                .p(px(CELL_W))
                .gap(px(CELL_H))
                .child(invite_card)
                .child(peers_card)
                .child(creds_card)
                .into_element()
        }))
        .into_element()
}
