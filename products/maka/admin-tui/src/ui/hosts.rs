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
    model::{AdminCommand, HostEntry},
    ui::{
        components::{
            action_btn, badge, empty_state, health_tone, kv_row, kv_row_with_action, notice_banner,
            panel_card, section_heading, short_hash,
        },
        state::{
            copy_text, open_confirm, open_init_root_modal, open_install_host_modal,
            select_host_key, send_command, snapshot_signal,
        },
        theme::{CELL_H, CELL_W, Tone, is_compact, palette},
    },
};
use nsh_core::{
    element::{AccessibilityRole, AccessibilityState, AnyElement},
    prelude::*,
};

pub fn hosts_screen() -> AnyElement {
    dynamic(move || {
        let snap = snapshot_signal().with(|s| s.0.clone());
        let selected_key = snap.selected_host().map(|h| h.key.clone());
        let selected = snap.selected_host().cloned();
        let compact = is_compact();

        let list_panel = host_list_card(&snap.hosts, selected_key.as_deref(), compact);
        let detail_panel = match selected {
            Some(host) => host_inspector(&host),
            None => panel_card(
                "Host Inspector",
                None,
                empty_state(
                    "No Host selected",
                    "Use Init Root to initialize a new State Root on this machine.",
                ),
            ),
        };

        if compact {
            scroll()
                .flex_1()
                .child(
                    view()
                        .p(px(CELL_W))
                        .gap(px(CELL_H))
                        .child(list_panel)
                        .child(detail_panel),
                )
                .into_element()
        } else {
            view()
                .flex_1()
                .flex_row()
                .p(px(CELL_W))
                .gap(px(CELL_W))
                .child(view().w(px(30.0 * CELL_W)).child(list_panel))
                .child(scroll().flex_1().child(detail_panel))
                .into_element()
        }
    })
    .into_element()
}

fn host_list_card(hosts: &[HostEntry], selected_key: Option<&str>, compact: bool) -> AnyElement {
    let items: Vec<AnyElement> = if hosts.is_empty() {
        vec![empty_state(
            "No Hosts found",
            "Click Init Root to create one.",
        )]
    } else {
        hosts
            .iter()
            .map(|host| {
                let is_selected = selected_key == Some(host.key.as_str());
                let tone = health_tone(&host.health);
                let key = host.key.clone();
                let meta = if let Some(rt) = &host.runtime {
                    format!("pid {} · {} sess", rt.pid, rt.sessions)
                } else if let Some(dep) = &host.deployment {
                    format!("{} · rev {}", dep.mode, dep.config_revision)
                } else {
                    host.health.label().to_owned()
                };

                view()
                    .h(px(2.0 * CELL_H))
                    .px(px(CELL_W))
                    .role(AccessibilityRole::Button)
                    .label(host.label.clone())
                    .accessibility_state(AccessibilityState {
                        selected: is_selected,
                        ..AccessibilityState::default()
                    })
                    .style_when(is_selected, |s| s.bg(palette::RAISED))
                    .on_press(move || select_host_key(key.clone()))
                    .child(
                        view()
                            .h(px(CELL_H))
                            .flex_row()
                            .items_center()
                            .justify_between()
                            .child(
                                text(format!("{} {}", tone.dot(), host.label))
                                    .flex_1()
                                    .number_of_lines(1)
                                    .font_weight(if is_selected {
                                        FontWeight::BOLD
                                    } else {
                                        FontWeight::NORMAL
                                    })
                                    .text_color(if is_selected {
                                        palette::TEXT
                                    } else {
                                        tone.color()
                                    }),
                            ),
                    )
                    .child(
                        text(format!("  {meta}"))
                            .h(px(CELL_H))
                            .number_of_lines(1)
                            .text_color(palette::FAINT),
                    )
                    .into_element()
            })
            .collect()
    };

    let footer = view()
        .mt(px(CELL_H))
        .flex_row()
        .gap(px(CELL_W))
        .child(action_btn(
            "+ Init Root…",
            Tone::Accent,
            false,
            open_init_root_modal,
        ))
        .into_element();

    let body = if compact {
        view().children(items).child(footer).into_element()
    } else {
        view()
            .flex_1()
            .child(scroll().flex_1().child(view().children(items)))
            .child(footer)
            .into_element()
    };

    panel_card(
        format!("State Roots ({})", hosts.len()),
        Some(text("↑/↓").text_color(palette::FAINT).into_element()),
        body,
    )
}

fn host_inspector(host: &HostEntry) -> AnyElement {
    let tone = health_tone(&host.health);

    let mut sections: Vec<AnyElement> = Vec::new();

    if let Some(err) = &host.error {
        sections.push(notice_banner(err.clone(), Tone::Danger));
    }

    // Lifecycle Actions bar
    let mut actions: Vec<AnyElement> = Vec::new();
    if !host.health.is_live() {
        let rid = host.root_id.clone();
        let rp = host.root_path.clone();
        actions.push(action_btn(
            "Activate / Start",
            Tone::Success,
            false,
            move || {
                send_command(AdminCommand::ActivateHost {
                    root_id: rid.clone(),
                    root_path: rp.clone(),
                });
            },
        ));
    }
    if let Some(dep) = &host.deployment
        && let Some(rid) = &host.root_id
    {
        let root_id = rid.clone();
        let did = dep.deployment_id;
        let rev = dep.config_revision;
        if dep.pending_update_sha256.is_some() {
            let rid_rec = root_id.clone();
            actions.push(action_btn(
                "Reconcile Update",
                Tone::Warning,
                false,
                move || {
                    send_command(AdminCommand::ReconcileHost {
                        root_id: rid_rec.clone(),
                        deployment_id: did,
                        config_revision: rev,
                    });
                },
            ));
        }
        let rid_rst = root_id.clone();
        actions.push(action_btn(
            "Restart",
            Tone::Primary,
            dep.pending_update_sha256.is_some(),
            move || {
                send_command(AdminCommand::RestartHost {
                    root_id: rid_rst.clone(),
                    deployment_id: did,
                    config_revision: rev,
                });
            },
        ));
        let rid_stp = root_id.clone();
        actions.push(action_btn("Stop", Tone::Warning, false, move || {
            open_confirm(
                "Stop Host deployment?",
                "Stops the managed Host process and OS service without altering its config.",
                "Stop Host",
                true,
                AdminCommand::StopHost {
                    root_id: rid_stp.clone(),
                    deployment_id: did,
                    config_revision: rev,
                },
            );
        }));
        let next_policy = if dep.update_policy == "nightly" {
            "manual"
        } else {
            "nightly"
        };
        let rid_pol = root_id.clone();
        let pol_rev = dep.update_policy_revision;
        actions.push(action_btn(
            format!("Policy → {next_policy}"),
            Tone::Accent,
            false,
            move || {
                send_command(AdminCommand::SetUpdatePolicy {
                    root_id: rid_pol.clone(),
                    deployment_id: did,
                    policy_revision: pol_rev,
                    policy: next_policy.to_owned(),
                });
            },
        ));
        let rid_uninst = root_id.clone();
        actions.push(action_btn("Uninstall", Tone::Danger, false, move || {
            open_confirm(
                "Uninstall managed deployment?",
                "Revokes startup and unregisters the OS service. State Root data and sessions are preserved.",
                "Uninstall",
                true,
                AdminCommand::UninstallHost {
                    root_id: rid_uninst.clone(),
                    deployment_id: did,
                    config_revision: rev,
                },
            );
        }));
    } else {
        actions.push(action_btn(
            "Install Managed…",
            Tone::Primary,
            false,
            open_install_host_modal,
        ));
    }

    if host.health.is_live() {
        let rp1 = host.root_path.clone();
        actions.push(action_btn("Retire", Tone::Warning, false, move || {
            open_confirm(
                "Retire running Host?",
                "Cleanly shuts down the Host if idle (refuses while tasks are active).",
                "Retire",
                true,
                AdminCommand::RetireHost {
                    root_path: rp1.clone(),
                    interrupt: false,
                },
            );
        }));
        let rp2 = host.root_path.clone();
        actions.push(action_btn("Force Retire", Tone::Danger, false, move || {
            open_confirm(
                "Force retire Host (interrupt active tasks)?",
                "Interrupts in-flight durable tasks and shuts down the Host immediately.",
                "Force Retire",
                true,
                AdminCommand::RetireHost {
                    root_path: rp2.clone(),
                    interrupt: true,
                },
            );
        }));
    }

    sections.push(panel_card(
        format!("{} · Controls", host.label),
        Some(badge(host.health.label(), tone)),
        view()
            .flex_row()
            .flex_wrap()
            .gap(px(CELL_W))
            .children(actions)
            .into_element(),
    ));

    // Identity & Runtime card
    let mut id_rows: Vec<AnyElement> = Vec::new();
    let rp_str = host.root_path.display().to_string();
    let rp_copy = rp_str.clone();
    id_rows.push(kv_row_with_action(
        "Root Path",
        rp_str,
        Tone::Neutral,
        "Copy",
        move || copy_text("Root path", &rp_copy),
    ));
    if let Some(rid) = &host.root_id {
        let rid_copy = rid.clone();
        id_rows.push(kv_row_with_action(
            "Root ID",
            rid.clone(),
            Tone::Muted,
            "Copy",
            move || copy_text("Root ID", &rid_copy),
        ));
    } else {
        id_rows.push(kv_row("Root ID", "Uninitialized", Tone::Warning));
    }

    if let Some(rt) = &host.runtime {
        id_rows.push(kv_row(
            "PID / Mode",
            format!(
                "{} ({}) · protocol v{}",
                rt.pid, rt.lifecycle_mode, rt.protocol_version
            ),
            Tone::Success,
        ));
        id_rows.push(kv_row("Host Epoch", rt.epoch.clone(), Tone::Muted));
        if let Some(generation) = &rt.generation {
            id_rows.push(kv_row("Generation", generation.clone(), Tone::Muted));
        }
        id_rows.push(kv_row(
            "Sessions / Calls",
            format!(
                "{} connected session(s) · {} active call(s)",
                rt.sessions, rt.active_calls
            ),
            Tone::Neutral,
        ));
        let ipc_copy = rt.ipc_endpoint.clone();
        id_rows.push(kv_row_with_action(
            "IPC Endpoint",
            rt.ipc_endpoint.clone(),
            Tone::Muted,
            "Copy",
            move || copy_text("IPC endpoint", &ipc_copy),
        ));
        for ws in &rt.websocket_endpoints {
            let ws_copy = ws.clone();
            id_rows.push(kv_row_with_action(
                "WebSocket",
                ws.clone(),
                Tone::Accent,
                "Copy",
                move || copy_text("WebSocket endpoint", &ws_copy),
            ));
        }
        if let Some(cleanup_err) = &rt.cleanup_error {
            id_rows.push(kv_row("Cleanup Error", cleanup_err.clone(), Tone::Danger));
        }
    }

    sections.push(panel_card(
        "Identity & Runtime",
        None,
        view().children(id_rows).into_element(),
    ));

    // Deployment & OS Service card
    if let Some(dep) = &host.deployment {
        let mut dep_rows: Vec<AnyElement> = vec![
            kv_row(
                "Deployment ID",
                dep.deployment_id.to_string(),
                Tone::Neutral,
            ),
            kv_row(
                "Revision / Mode",
                format!(
                    "rev {} · {} · admission {}",
                    dep.config_revision, dep.mode, dep.admission
                ),
                if dep.admission == "active" {
                    Tone::Success
                } else {
                    Tone::Danger
                },
            ),
            kv_row("Listener", dep.websocket.clone(), Tone::Accent),
            kv_row("Package SHA-256", short_hash(&dep.sha256), Tone::Muted),
            kv_row("Executable", dep.executable.clone(), Tone::Muted),
            kv_row(
                "Update Policy",
                format!("{} (rev {})", dep.update_policy, dep.update_policy_revision),
                if dep.update_policy == "nightly" {
                    Tone::Accent
                } else {
                    Tone::Neutral
                },
            ),
            kv_row(
                "Executor Lock",
                if dep.operation_in_progress {
                    "Operation in progress"
                } else {
                    "Idle"
                },
                if dep.operation_in_progress {
                    Tone::Warning
                } else {
                    Tone::Muted
                },
            ),
        ];

        let sup_summary = match dep.supervisor_kind.as_str() {
            "present" => format!(
                "state={} · enabled={} · pid={}",
                dep.supervisor_state.as_deref().unwrap_or("?"),
                dep.supervisor_enabled
                    .map(|b| if b { "yes" } else { "no" })
                    .unwrap_or("?"),
                dep.supervisor_pid
                    .map(|p| p.to_string())
                    .unwrap_or_else(|| "none".to_owned()),
            ),
            "on_demand" => "On-demand (no persistent OS service)".to_owned(),
            "missing" => "Service unit not registered".to_owned(),
            "unavailable" => dep
                .supervisor_message
                .clone()
                .unwrap_or_else(|| "Supervisor unavailable".to_owned()),
            _ => "Unknown".to_owned(),
        };
        dep_rows.push(kv_row("OS Supervisor", sup_summary, Tone::Neutral));

        if let Some(pending) = &dep.pending_update_sha256 {
            dep_rows.push(kv_row(
                "Pending Update",
                format!("target {} (run Reconcile)", short_hash(pending)),
                Tone::Warning,
            ));
        }
        if let Some(err) = &dep.update_policy_last_error {
            dep_rows.push(kv_row("Policy Error", err.clone(), Tone::Danger));
        }

        sections.push(panel_card(
            "Managed Deployment & Service",
            None,
            view().children(dep_rows).into_element(),
        ));
    }

    // Published Endpoints card
    if let Some(rt) = &host.runtime
        && !rt.published_endpoints.is_empty()
    {
        let ep_rows: Vec<AnyElement> = rt
            .published_endpoints
            .iter()
            .map(|ep| {
                let owner = if ep.product_owned {
                    "product"
                } else {
                    "custom"
                };
                let methods = if ep.methods.is_empty() {
                    "none".to_owned()
                } else {
                    ep.methods.join(", ")
                };
                view()
                    .h(px(CELL_H))
                    .flex_row()
                    .items_center()
                    .gap(px(CELL_W))
                    .child(
                        text(ep.name.clone())
                            .w(px(20.0 * CELL_W))
                            .number_of_lines(1)
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(palette::ACCENT),
                    )
                    .child(
                        text(format!("[{owner}]"))
                            .w(px(10.0 * CELL_W))
                            .text_color(palette::FAINT),
                    )
                    .child(
                        text(methods)
                            .flex_1()
                            .number_of_lines(1)
                            .text_color(palette::MUTED),
                    )
                    .into_element()
            })
            .collect();

        sections.push(panel_card(
            format!("Published Endpoints ({})", rt.published_endpoints.len()),
            None,
            view()
                .child(section_heading(
                    "ENDPOINT             OWNERSHIP  GRANTED METHODS",
                ))
                .children(ep_rows)
                .into_element(),
        ));
    }

    view().gap(px(CELL_H)).children(sections).into_element()
}
