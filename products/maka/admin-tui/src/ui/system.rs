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
    backend::format_diagnostics_json,
    model::{AdminCommand, UpdateCheckState},
    ui::{
        components::{action_btn, badge, empty_state, kv_row, kv_row_with_action, panel_card},
        state::{copy_text, logs_signal, send_command, snapshot_signal},
        theme::{CELL_H, CELL_W, Tone, palette},
    },
};
use nsh_core::{element::AnyElement, prelude::*};

pub fn system_screen() -> AnyElement {
    scroll()
        .flex_1()
        .child(dynamic(move || {
            let snap = snapshot_signal().with(|s| s.0.clone());
            let sys = &snap.system;

            // 1. Build & Updates Card
            let (upd_text, upd_tone) = match &snap.update_check {
                UpdateCheckState::Idle => ("Not checked yet".to_owned(), Tone::Muted),
                UpdateCheckState::Checking => ("Checking release channel…".to_owned(), Tone::Warning),
                UpdateCheckState::DevBuild => (
                    "Development build (auto-update disabled)".to_owned(),
                    Tone::Muted,
                ),
                UpdateCheckState::UpToDate => ("Up to date".to_owned(), Tone::Success),
                UpdateCheckState::Available { version, url } => {
                    (format!("Update available: v{version} ({url})"), Tone::Warning)
                }
                UpdateCheckState::Error { message } => (format!("Error: {message}"), Tone::Danger),
            };

            let build_card = {
                let diag_snap = snap.clone();
                let body = view()
                    .child(kv_row(
                        "Version",
                        format!("Maka v{} ({})", sys.version, sys.channel),
                        Tone::Accent,
                    ))
                    .child(kv_row(
                        "Platform",
                        format!("{} / {}", sys.os, sys.arch),
                        Tone::Neutral,
                    ))
                    .child(kv_row(
                        "Install Path",
                        format!(
                            "{} ({})",
                            sys.install_path,
                            if sys.install_writable { "writable" } else { "read-only" }
                        ),
                        Tone::Muted,
                    ))
                    .child(kv_row("Maka CLI", sys.maka_binary.clone(), Tone::Muted))
                    .child(kv_row("Update Status", upd_text, upd_tone))
                    .child(
                        view()
                            .mt(px(CELL_H))
                            .flex_row()
                            .flex_wrap()
                            .gap(px(CELL_W))
                            .child(action_btn(
                                "Check for Updates",
                                Tone::Primary,
                                matches!(snap.update_check, UpdateCheckState::Checking),
                                || send_command(AdminCommand::CheckUpdates),
                            ))
                            .child(action_btn(
                                "Copy Diagnostics JSON",
                                Tone::Accent,
                                false,
                                move || {
                                    let logs = logs_signal().with(|l| l.0.clone());
                                    let json = format_diagnostics_json(&diag_snap, &logs);
                                    copy_text("Diagnostics JSON", &json);
                                },
                            )),
                    )
                    .into_element();

                panel_card(
                    "Build & Release Channel",
                    Some(badge(sys.channel.clone(), Tone::Primary)),
                    body,
                )
            };

            // 2. Account Directories & Namespaces Card
            let paths_card = {
                let data_copy = sys.account_data_dir.clone();
                let dep_copy = sys.deployments_dir.clone();
                let ctrl_copy = sys.control_dir.clone();
                let root_copy = sys.default_root.clone();

                let body = view()
                    .child(kv_row_with_action(
                        "Default Host Root",
                        sys.default_root.clone(),
                        Tone::Neutral,
                        "Copy",
                        move || copy_text("Default root", &root_copy),
                    ))
                    .child(kv_row_with_action(
                        "Account Data Dir",
                        sys.account_data_dir.clone(),
                        Tone::Muted,
                        "Copy",
                        move || copy_text("Account data dir", &data_copy),
                    ))
                    .child(kv_row_with_action(
                        "Deployments Dir",
                        sys.deployments_dir.clone(),
                        Tone::Muted,
                        "Copy",
                        move || copy_text("Deployments dir", &dep_copy),
                    ))
                    .child(kv_row_with_action(
                        "Control Dir",
                        sys.control_dir.clone(),
                        Tone::Muted,
                        "Copy",
                        move || copy_text("Control dir", &ctrl_copy),
                    ))
                    .into_element();

                panel_card("Account Namespaces & Storage", None, body)
            };

            // 3. Control Plane Audit Log Card
            let audit_card = {
                let body = if snap.activity.is_empty() {
                    empty_state(
                        "No audit events recorded",
                        "Every Host, Relay, Access, and Update operation performed in this session is logged here.",
                    )
                } else {
                    let rows: Vec<AnyElement> = snap
                        .activity
                        .iter()
                        .take(30)
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
                    format!("Session Audit Trail ({})", snap.activity.len()),
                    None,
                    body,
                )
            };

            view()
                .p(px(CELL_W))
                .gap(px(CELL_H))
                .child(build_card)
                .child(paths_card)
                .child(audit_card)
                .into_element()
        }))
        .into_element()
}
