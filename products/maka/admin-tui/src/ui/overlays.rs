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
    model::{AdminCommand, LocalRelayState, RelayTlsMode, TabId},
    ui::{
        components::{action_btn, filter_chip, notice_banner},
        state::{
            ConfirmSpec, Overlay, close_overlay, copy_text, logs_signal, open_add_relay_modal,
            open_confirm, open_init_root_modal, open_install_host_modal, open_invite_modal,
            open_local_relay_editor, open_prepare_access_modal, open_revoke_cred_modal,
            selected_host, send_command, set_tab, snapshot_signal, ui_signal,
        },
        theme::{CELL_H, CELL_W, Tone, palette},
    },
};
use nsh_base::input;
use nsh_core::{
    element::{AccessibilityRole, AccessibilityState, AnyElement},
    prelude::*,
};
use std::path::PathBuf;

pub struct PaletteItem {
    pub title: &'static str,
    pub hint: &'static str,
    pub category: &'static str,
    pub action: fn(),
}

pub fn palette_items() -> Vec<PaletteItem> {
    vec![
        PaletteItem {
            title: "Refresh All Hosts & Status",
            hint: "r",
            category: "General",
            action: || send_command(AdminCommand::Refresh),
        },
        PaletteItem {
            title: "Go to Overview",
            hint: "1",
            category: "Nav",
            action: || set_tab(TabId::Overview),
        },
        PaletteItem {
            title: "Go to Hosts & Deployments",
            hint: "2",
            category: "Nav",
            action: || set_tab(TabId::Hosts),
        },
        PaletteItem {
            title: "Go to Relay & Remote Access",
            hint: "3",
            category: "Nav",
            action: || set_tab(TabId::Relay),
        },
        PaletteItem {
            title: "Go to Access & Peers",
            hint: "4",
            category: "Nav",
            action: || set_tab(TabId::Access),
        },
        PaletteItem {
            title: "Go to Live Host Logs",
            hint: "5",
            category: "Nav",
            action: || set_tab(TabId::Logs),
        },
        PaletteItem {
            title: "Go to System & Updates",
            hint: "6",
            category: "Nav",
            action: || set_tab(TabId::System),
        },
        PaletteItem {
            title: "Activate / Start Active Host",
            hint: "",
            category: "Host",
            action: || {
                if let Some(host) = selected_host() {
                    send_command(AdminCommand::ActivateHost {
                        root_id: host.root_id,
                        root_path: host.root_path,
                    });
                }
            },
        },
        PaletteItem {
            title: "Restart Active Managed Host",
            hint: "",
            category: "Host",
            action: || {
                if let Some(host) = selected_host()
                    && let (Some(rid), Some(dep)) = (host.root_id, host.deployment)
                {
                    send_command(AdminCommand::RestartHost {
                        root_id: rid,
                        deployment_id: dep.deployment_id,
                        config_revision: dep.config_revision,
                    });
                }
            },
        },
        PaletteItem {
            title: "Retire Active Host (Graceful)",
            hint: "",
            category: "Host",
            action: || {
                if let Some(host) = selected_host() {
                    open_confirm(
                        "Retire active Host?",
                        "Cleanly shuts down the Host if no tasks are active.",
                        "Retire Host",
                        true,
                        AdminCommand::RetireHost {
                            root_path: host.root_path,
                            interrupt: false,
                        },
                    );
                }
            },
        },
        PaletteItem {
            title: "Initialize New State Root…",
            hint: "",
            category: "Host",
            action: open_init_root_modal,
        },
        PaletteItem {
            title: "Install Managed Host Deployment…",
            hint: "",
            category: "Host",
            action: open_install_host_modal,
        },
        PaletteItem {
            title: "Start / Stop Local Relay Server",
            hint: "",
            category: "Relay",
            action: || {
                let running = snapshot_signal()
                    .with(|s| matches!(s.0.local_relay, LocalRelayState::Running(_)));
                if running {
                    send_command(AdminCommand::StopLocalRelay);
                } else {
                    let config = snapshot_signal().with(|s| s.0.local_relay_config.clone());
                    send_command(AdminCommand::StartLocalRelay { config });
                }
            },
        },
        PaletteItem {
            title: "Configure Local Relay Server…",
            hint: "",
            category: "Relay",
            action: open_local_relay_editor,
        },
        PaletteItem {
            title: "Attach Local Relay to Active Host",
            hint: "",
            category: "Relay",
            action: || {
                if let Some(host) = selected_host() {
                    send_command(AdminCommand::ApplyLocalRelayToHost {
                        root_path: host.root_path,
                    });
                }
            },
        },
        PaletteItem {
            title: "Add Upstream Relay to Active Host…",
            hint: "",
            category: "Relay",
            action: open_add_relay_modal,
        },
        PaletteItem {
            title: "New Native Peer Pairing Invite…",
            hint: "",
            category: "Access",
            action: open_invite_modal,
        },
        PaletteItem {
            title: "Prepare Application Pairing Credential…",
            hint: "",
            category: "Access",
            action: open_prepare_access_modal,
        },
        PaletteItem {
            title: "Revoke Application Credential…",
            hint: "",
            category: "Access",
            action: open_revoke_cred_modal,
        },
        PaletteItem {
            title: "Check for Maka Updates",
            hint: "",
            category: "System",
            action: || send_command(AdminCommand::CheckUpdates),
        },
        PaletteItem {
            title: "Copy Diagnostics JSON Snapshot",
            hint: "",
            category: "System",
            action: || {
                let snap = snapshot_signal().with(|s| s.0.clone());
                let logs = logs_signal().with(|l| l.0.clone());
                copy_text("Diagnostics JSON", &format_diagnostics_json(&snap, &logs));
            },
        },
        PaletteItem {
            title: "Quit Maka Admin",
            hint: "q",
            category: "General",
            action: || nsh_core::element::desktop::quit(),
        },
    ]
}

pub fn filtered_palette(query: &str) -> Vec<PaletteItem> {
    let needle = query.trim().to_ascii_lowercase();
    palette_items()
        .into_iter()
        .filter(|item| {
            needle.is_empty()
                || item.title.to_ascii_lowercase().contains(&needle)
                || item.category.to_ascii_lowercase().contains(&needle)
        })
        .collect()
}

pub fn execute_palette_selection() {
    let (query, selected) = ui_signal().with(|u| match &u.overlay {
        Overlay::CommandPalette { query, selected } => (query.clone(), *selected),
        _ => (String::new(), usize::MAX),
    });
    if selected == usize::MAX {
        return;
    }
    let items = filtered_palette(&query);
    if let Some(item) = items.get(selected) {
        close_overlay();
        (item.action)();
    }
}

pub fn move_palette_selection(delta: isize) {
    ui_signal().update(|u| {
        if let Overlay::CommandPalette { query, selected } = &mut u.overlay {
            let count = filtered_palette(query).len();
            if count == 0 {
                *selected = 0;
            } else {
                *selected = (*selected as isize + delta).rem_euclid(count as isize) as usize;
            }
        }
    });
}

pub fn overlay_layer() -> AnyElement {
    dynamic(move || {
        let overlay = ui_signal().with(|u| u.overlay.clone());
        match overlay {
            Overlay::None => view().into_element(),
            Overlay::Help => modal_frame(
                "Keyboard Shortcuts & Navigation",
                64.0,
                help_body(),
                vec![action_btn(
                    "Close (Esc)",
                    Tone::Accent,
                    false,
                    close_overlay,
                )],
            ),
            Overlay::CommandPalette { query, selected } => command_palette_modal(query, selected),
            Overlay::Confirm(spec) => confirm_modal(spec),
            Overlay::AddRelay {
                root_path,
                url,
                quic_port,
                cert_sha256,
                ca_der_path,
                auth_token,
                error,
            } => add_relay_modal(
                root_path,
                url,
                quic_port,
                cert_sha256,
                ca_der_path,
                auth_token,
                error,
            ),
            Overlay::CreateInvite {
                root_path,
                host_name,
                label,
                ttl_secs,
                error,
            } => create_invite_modal(root_path, host_name, label, ttl_secs, error),
            Overlay::InitRoot { root_path, error } => init_root_modal(root_path, error),
            Overlay::InstallHost {
                root_path,
                mode,
                error,
            } => install_host_modal(root_path, mode, error),
            Overlay::PrepareAccess {
                root_path,
                principal,
                error,
            } => prepare_access_modal(root_path, principal, error),
            Overlay::RevokeCredential {
                root_path,
                credential_id,
                error,
            } => revoke_cred_modal(root_path, credential_id, error),
            Overlay::ConfigureLocalRelay { draft, error } => {
                configure_local_relay_modal(draft, error)
            }
        }
    })
    .into_element()
}

fn modal_frame(
    title: impl Into<SharedString>,
    width_cols: f32,
    body: AnyElement,
    footer_buttons: Vec<AnyElement>,
) -> AnyElement {
    let title: SharedString = title.into();
    let max_w = (window().width.0 - 4.0 * CELL_W).max(36.0 * CELL_W);
    let box_w = (width_cols * CELL_W).min(max_w);

    view()
        .absolute()
        .inset_0()
        .items_center()
        .justify_center()
        .bg(palette::BG)
        .child(
            view()
                .w(px(box_w))
                .border_1()
                .border_color(palette::ACCENT)
                .rounded(px(4.0))
                .child(
                    view().border_b_1().border_b_color(palette::BORDER).child(
                        view()
                            .h(px(CELL_H))
                            .flex_row()
                            .items_center()
                            .justify_between()
                            .px(px(CELL_W))
                            .child(
                                text(title)
                                    .font_weight(FontWeight::BOLD)
                                    .text_color(palette::TEXT),
                            )
                            .child(text("Esc").text_color(palette::FAINT)),
                    ),
                )
                .child(view().p(px(CELL_W)).gap(px(CELL_H)).child(body))
                .child(
                    view().border_t_1().border_t_color(palette::BORDER).child(
                        view()
                            .h(px(CELL_H))
                            .flex_row()
                            .items_center()
                            .justify_end()
                            .gap(px(CELL_W))
                            .px(px(CELL_W))
                            .children(footer_buttons),
                    ),
                ),
        )
        .into_element()
}

fn form_field(
    label: &'static str,
    value: String,
    placeholder: &'static str,
    on_change: impl Fn(&str) + 'static,
) -> AnyElement {
    view()
        .h(px(CELL_H))
        .flex_row()
        .items_center()
        .gap(px(CELL_W))
        .child(text(label).w(px(16.0 * CELL_W)).text_color(palette::MUTED))
        .child(
            input()
                .value(value)
                .on_change(on_change)
                .placeholder(placeholder)
                .flex_1()
                .h(px(CELL_H))
                .bg(palette::RAISED)
                .px(px(CELL_W))
                .text_color(palette::TEXT),
        )
        .into_element()
}

fn confirm_modal(spec: ConfirmSpec) -> AnyElement {
    let cmd = spec.command.clone();
    let tone = if spec.destructive {
        Tone::Danger
    } else {
        Tone::Primary
    };
    modal_frame(
        spec.title,
        56.0,
        text(spec.body).text_color(palette::MUTED).into_element(),
        vec![
            action_btn("Cancel", Tone::Neutral, false, close_overlay),
            action_btn(spec.confirm_label, tone, false, move || {
                close_overlay();
                send_command(cmd.clone());
            }),
        ],
    )
}

fn command_palette_modal(query: String, selected: usize) -> AnyElement {
    let items = filtered_palette(&query);
    let clamped = if items.is_empty() {
        0
    } else {
        selected.min(items.len() - 1)
    };

    let rows: Vec<AnyElement> = if items.is_empty() {
        vec![
            text("No matching commands")
                .h(px(CELL_H))
                .text_color(palette::FAINT)
                .into_element(),
        ]
    } else {
        items
            .into_iter()
            .take(12)
            .enumerate()
            .map(|(idx, item)| {
                let is_sel = idx == clamped;
                let action = item.action;
                view()
                    .h(px(CELL_H))
                    .flex_row()
                    .items_center()
                    .gap(px(CELL_W))
                    .px(px(CELL_W))
                    .role(AccessibilityRole::Button)
                    .label(item.title)
                    .accessibility_state(AccessibilityState {
                        selected: is_sel,
                        ..AccessibilityState::default()
                    })
                    .style_when(is_sel, |s| s.bg(palette::RAISED))
                    .on_press(move || {
                        close_overlay();
                        action();
                    })
                    .child(
                        text(item.category)
                            .w(px(8.0 * CELL_W))
                            .text_color(palette::FAINT),
                    )
                    .child(
                        text(item.title)
                            .flex_1()
                            .number_of_lines(1)
                            .font_weight(if is_sel {
                                FontWeight::BOLD
                            } else {
                                FontWeight::NORMAL
                            })
                            .text_color(if is_sel {
                                palette::ACCENT
                            } else {
                                palette::TEXT
                            }),
                    )
                    .child(text(item.hint).text_color(palette::FAINT))
                    .into_element()
            })
            .collect()
    };

    let body = view()
        .gap(px(CELL_H))
        .child(
            input()
                .auto_focus(true)
                .value(query)
                .on_change(move |val: &str| {
                    ui_signal().update(|u| {
                        if let Overlay::CommandPalette { query, selected } = &mut u.overlay {
                            *query = val.to_owned();
                            *selected = 0;
                        }
                    });
                })
                .on_submit(move |_: &str| execute_palette_selection())
                .placeholder("Type a command… (↑/↓ select, Enter run)")
                .h(px(CELL_H))
                .bg(palette::RAISED)
                .px(px(CELL_W))
                .text_color(palette::TEXT),
        )
        .child(view().children(rows))
        .into_element();

    modal_frame(
        "Command Palette",
        64.0,
        body,
        vec![
            action_btn("Cancel", Tone::Muted, false, close_overlay),
            action_btn(
                "Run (Enter)",
                Tone::Accent,
                false,
                execute_palette_selection,
            ),
        ],
    )
}

fn help_body() -> AnyElement {
    let entries = [
        (
            "1 - 6",
            "Switch sections (Overview, Hosts, Relay, Access, Logs, System)",
        ),
        ("[ / ]", "Previous / Next section"),
        (
            "↑ / ↓ or j / k",
            "Select previous / next discovered Host (or palette item)",
        ),
        ("r / Ctrl+R", "Refresh Hosts, Relay & status immediately"),
        (": / Ctrl+P / Ctrl+K", "Open Command Palette"),
        ("f (in Logs)", "Toggle live log follow"),
        (
            "Tab / Shift+Tab",
            "Move keyboard focus between buttons and inputs",
        ),
        ("Enter / Space", "Activate focused button or control"),
        ("?", "Toggle this keyboard shortcuts reference"),
        ("Esc", "Close open dialog or overlay"),
        (
            "q / Ctrl+C",
            "Quit Maka Admin (cleanly stops any local Relay)",
        ),
    ];
    let rows: Vec<AnyElement> = entries
        .into_iter()
        .map(|(k, desc)| {
            view()
                .h(px(CELL_H))
                .flex_row()
                .items_center()
                .gap(px(CELL_W))
                .child(
                    text(k)
                        .w(px(20.0 * CELL_W))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(palette::ACCENT),
                )
                .child(
                    text(desc)
                        .flex_1()
                        .number_of_lines(1)
                        .text_color(palette::TEXT),
                )
                .into_element()
        })
        .collect();
    view().children(rows).into_element()
}

fn configure_local_relay_modal(
    draft: crate::model::LocalRelayConfig,
    error: Option<String>,
) -> AnyElement {
    let submit = {
        let draft = draft.clone();
        move || {
            close_overlay();
            send_command(AdminCommand::StartLocalRelay {
                config: draft.clone(),
            });
        }
    };

    let tls_row = view()
        .h(px(CELL_H))
        .flex_row()
        .items_center()
        .gap(px(CELL_W))
        .child(
            text("TLS Mode")
                .w(px(16.0 * CELL_W))
                .text_color(palette::MUTED),
        )
        .child(filter_chip(
            RelayTlsMode::None.label(),
            draft.tls_mode == RelayTlsMode::None,
            || {
                ui_signal().update(|u| {
                    if let Overlay::ConfigureLocalRelay { draft, .. } = &mut u.overlay {
                        draft.tls_mode = RelayTlsMode::None;
                        if draft.http_addr.is_empty() {
                            draft.http_addr = "127.0.0.1:3340".to_owned();
                        }
                        draft.https_addr.clear();
                        draft.quic_addr.clear();
                    }
                });
            },
        ))
        .child(filter_chip(
            RelayTlsMode::SelfSigned.label(),
            draft.tls_mode == RelayTlsMode::SelfSigned,
            || {
                ui_signal().update(|u| {
                    if let Overlay::ConfigureLocalRelay { draft, .. } = &mut u.overlay {
                        draft.tls_mode = RelayTlsMode::SelfSigned;
                        if draft.https_addr.is_empty() {
                            draft.https_addr = "127.0.0.1:3443".to_owned();
                        }
                    }
                });
            },
        ))
        .child(filter_chip(
            RelayTlsMode::Pem.label(),
            draft.tls_mode == RelayTlsMode::Pem,
            || {
                ui_signal().update(|u| {
                    if let Overlay::ConfigureLocalRelay { draft, .. } = &mut u.overlay {
                        draft.tls_mode = RelayTlsMode::Pem;
                        if draft.https_addr.is_empty() {
                            draft.https_addr = "0.0.0.0:3443".to_owned();
                        }
                    }
                });
            },
        ))
        .into_element();

    let mut fields: Vec<AnyElement> = Vec::new();
    if let Some(err) = error {
        fields.push(notice_banner(err, Tone::Danger));
    }
    fields.push(tls_row);
    fields.push(form_field(
        "HTTP Bind",
        draft.http_addr.clone(),
        "127.0.0.1:3340 (optional)",
        |val| {
            ui_signal().update(|u| {
                if let Overlay::ConfigureLocalRelay { draft, .. } = &mut u.overlay {
                    draft.http_addr = val.to_owned();
                }
            });
        },
    ));
    fields.push(form_field(
        "HTTPS Bind",
        draft.https_addr.clone(),
        "127.0.0.1:3443 (requires TLS)",
        |val| {
            ui_signal().update(|u| {
                if let Overlay::ConfigureLocalRelay { draft, .. } = &mut u.overlay {
                    draft.https_addr = val.to_owned();
                }
            });
        },
    ));
    fields.push(form_field(
        "QUIC UDP Bind",
        draft.quic_addr.clone(),
        "0.0.0.0:3478 (optional, TLS)",
        |val| {
            ui_signal().update(|u| {
                if let Overlay::ConfigureLocalRelay { draft, .. } = &mut u.overlay {
                    draft.quic_addr = val.to_owned();
                }
            });
        },
    ));
    if draft.tls_mode == RelayTlsMode::SelfSigned {
        fields.push(form_field(
            "Self-Signed SANs",
            draft.tls_sans.clone(),
            "localhost,127.0.0.1",
            |val| {
                ui_signal().update(|u| {
                    if let Overlay::ConfigureLocalRelay { draft, .. } = &mut u.overlay {
                        draft.tls_sans = val.to_owned();
                    }
                });
            },
        ));
    }
    if draft.tls_mode == RelayTlsMode::Pem {
        fields.push(form_field(
            "TLS Cert PEM",
            draft.tls_cert_path.clone(),
            "/path/to/fullchain.pem",
            |val| {
                ui_signal().update(|u| {
                    if let Overlay::ConfigureLocalRelay { draft, .. } = &mut u.overlay {
                        draft.tls_cert_path = val.to_owned();
                    }
                });
            },
        ));
        fields.push(form_field(
            "TLS Key PEM",
            draft.tls_key_path.clone(),
            "/path/to/privkey.pem",
            |val| {
                ui_signal().update(|u| {
                    if let Overlay::ConfigureLocalRelay { draft, .. } = &mut u.overlay {
                        draft.tls_key_path = val.to_owned();
                    }
                });
            },
        ));
    }
    fields.push(form_field(
        "Bearer Token",
        draft.auth_token.clone(),
        "Optional shared auth token",
        |val| {
            ui_signal().update(|u| {
                if let Overlay::ConfigureLocalRelay { draft, .. } = &mut u.overlay {
                    draft.auth_token = val.to_owned();
                }
            });
        },
    ));

    modal_frame(
        "Configure Local Self-Hosted Relay",
        72.0,
        view().gap(px(CELL_H)).children(fields).into_element(),
        vec![
            action_btn("Generate Token", Tone::Primary, false, || {
                send_command(AdminCommand::GenerateRelayToken);
            }),
            action_btn("Cancel", Tone::Muted, false, close_overlay),
            action_btn("Start Relay", Tone::Success, false, submit),
        ],
    )
}

#[allow(clippy::too_many_arguments)]
fn add_relay_modal(
    root_path: PathBuf,
    url: String,
    quic_port: String,
    cert_sha256: String,
    ca_der_path: String,
    auth_token: String,
    error: Option<String>,
) -> AnyElement {
    let submit = {
        let root_path = root_path.clone();
        let url = url.clone();
        let quic_port = quic_port.clone();
        let cert_sha256 = cert_sha256.clone();
        let ca_der_path = ca_der_path.clone();
        let auth_token = auth_token.clone();
        move || {
            if url.trim().is_empty() {
                ui_signal().update(|u| {
                    if let Overlay::AddRelay { error, .. } = &mut u.overlay {
                        *error = Some(
                            "Relay URL is required (e.g. https://relay.example.com/)".to_owned(),
                        );
                    }
                });
                return;
            }
            let parsed_quic = if quic_port.trim().is_empty() {
                None
            } else {
                match quic_port.trim().parse::<u16>() {
                    Ok(p) => Some(p),
                    Err(_) => {
                        ui_signal().update(|u| {
                            if let Overlay::AddRelay { error, .. } = &mut u.overlay {
                                *error = Some(
                                    "QUIC port must be a number between 1 and 65535".to_owned(),
                                );
                            }
                        });
                        return;
                    }
                }
            };
            close_overlay();
            send_command(AdminCommand::AddHostRelay {
                root_path: root_path.clone(),
                url: url.clone(),
                quic_port: parsed_quic,
                cert_sha256: (!cert_sha256.trim().is_empty()).then(|| cert_sha256.clone()),
                ca_der_path: (!ca_der_path.trim().is_empty()).then(|| ca_der_path.clone()),
                auth_token: (!auth_token.trim().is_empty()).then(|| auth_token.clone()),
            });
        }
    };

    let mut fields: Vec<AnyElement> = Vec::new();
    if let Some(err) = error {
        fields.push(notice_banner(err, Tone::Danger));
    }
    fields.push(form_field(
        "Relay URL",
        url,
        "https://relay.example.com/",
        |val| {
            ui_signal().update(|u| {
                if let Overlay::AddRelay { url, error, .. } = &mut u.overlay {
                    *url = val.to_owned();
                    *error = None;
                }
            });
        },
    ));
    fields.push(form_field(
        "QUIC Port",
        quic_port,
        "3478 (optional)",
        |val| {
            ui_signal().update(|u| {
                if let Overlay::AddRelay { quic_port, .. } = &mut u.overlay {
                    *quic_port = val.to_owned();
                }
            });
        },
    ));
    fields.push(form_field(
        "Cert SHA-256",
        cert_sha256,
        "Optional leaf pin hex",
        |val| {
            ui_signal().update(|u| {
                if let Overlay::AddRelay { cert_sha256, .. } = &mut u.overlay {
                    *cert_sha256 = val.to_owned();
                }
            });
        },
    ));
    fields.push(form_field(
        "CA DER Path",
        ca_der_path,
        "Optional /path/to/ca.der",
        |val| {
            ui_signal().update(|u| {
                if let Overlay::AddRelay { ca_der_path, .. } = &mut u.overlay {
                    *ca_der_path = val.to_owned();
                }
            });
        },
    ));
    fields.push(form_field(
        "Bearer Token",
        auth_token,
        "Optional https:// Bearer token",
        |val| {
            ui_signal().update(|u| {
                if let Overlay::AddRelay { auth_token, .. } = &mut u.overlay {
                    *auth_token = val.to_owned();
                }
            });
        },
    ));

    modal_frame(
        "Add Upstream Relay to Host",
        70.0,
        view().gap(px(CELL_H)).children(fields).into_element(),
        vec![
            action_btn("Cancel", Tone::Muted, false, close_overlay),
            action_btn("Add Relay", Tone::Success, false, submit),
        ],
    )
}

fn create_invite_modal(
    root_path: PathBuf,
    host_name: String,
    label: String,
    ttl_secs: String,
    error: Option<String>,
) -> AnyElement {
    let submit = {
        let root_path = root_path.clone();
        let host_name = host_name.clone();
        let label = label.clone();
        let ttl_secs = ttl_secs.clone();
        move || {
            if host_name.trim().is_empty() {
                ui_signal().update(|u| {
                    if let Overlay::CreateInvite { error, .. } = &mut u.overlay {
                        *error = Some("Host display name is required".to_owned());
                    }
                });
                return;
            }
            let ttl = if ttl_secs.trim().is_empty() {
                None
            } else {
                match ttl_secs.trim().parse::<u64>() {
                    Ok(v) if v > 0 => Some(v),
                    _ => {
                        ui_signal().update(|u| {
                            if let Overlay::CreateInvite { error, .. } = &mut u.overlay {
                                *error =
                                    Some("TTL must be a positive number of seconds".to_owned());
                            }
                        });
                        return;
                    }
                }
            };
            close_overlay();
            send_command(AdminCommand::CreatePairingInvite {
                root_path: root_path.clone(),
                host_name: host_name.clone(),
                label: (!label.trim().is_empty()).then(|| label.clone()),
                ttl_secs: ttl,
            });
        }
    };

    let mut fields: Vec<AnyElement> = Vec::new();
    if let Some(err) = error {
        fields.push(notice_banner(err, Tone::Danger));
    }
    fields.push(form_field("Host Name", host_name, "My Mac Studio", |val| {
        ui_signal().update(|u| {
            if let Overlay::CreateInvite {
                host_name, error, ..
            } = &mut u.overlay
            {
                *host_name = val.to_owned();
                *error = None;
            }
        });
    }));
    fields.push(form_field(
        "Device Label",
        label,
        "Optional (e.g. iPhone)",
        |val| {
            ui_signal().update(|u| {
                if let Overlay::CreateInvite { label, .. } = &mut u.overlay {
                    *label = val.to_owned();
                }
            });
        },
    ));
    fields.push(form_field("TTL (secs)", ttl_secs, "600", |val| {
        ui_signal().update(|u| {
            if let Overlay::CreateInvite { ttl_secs, .. } = &mut u.overlay {
                *ttl_secs = val.to_owned();
            }
        });
    }));

    modal_frame(
        "Create Native Peer Pairing Invite",
        64.0,
        view().gap(px(CELL_H)).children(fields).into_element(),
        vec![
            action_btn("Cancel", Tone::Muted, false, close_overlay),
            action_btn("Generate Invite", Tone::Peer, false, submit),
        ],
    )
}

fn init_root_modal(root_path: String, error: Option<String>) -> AnyElement {
    let submit = {
        let root_path = root_path.clone();
        move || {
            if root_path.trim().is_empty() {
                ui_signal().update(|u| {
                    if let Overlay::InitRoot { error, .. } = &mut u.overlay {
                        *error = Some("State Root path is required".to_owned());
                    }
                });
                return;
            }
            close_overlay();
            send_command(AdminCommand::InitRoot {
                root_path: PathBuf::from(root_path.trim()),
            });
        }
    };

    let mut fields: Vec<AnyElement> = Vec::new();
    if let Some(err) = error {
        fields.push(notice_banner(err, Tone::Danger));
    }
    fields.push(form_field(
        "Root Directory",
        root_path,
        "/path/to/maka-root",
        |val| {
            ui_signal().update(|u| {
                if let Overlay::InitRoot { root_path, error } = &mut u.overlay {
                    *root_path = val.to_owned();
                    *error = None;
                }
            });
        },
    ));

    modal_frame(
        "Initialize Native State Root",
        66.0,
        view().gap(px(CELL_H)).children(fields).into_element(),
        vec![
            action_btn("Cancel", Tone::Muted, false, close_overlay),
            action_btn("Initialize Root", Tone::Success, false, submit),
        ],
    )
}

fn install_host_modal(root_path: PathBuf, mode: String, error: Option<String>) -> AnyElement {
    let submit = {
        let root_path = root_path.clone();
        let mode = mode.clone();
        move || {
            close_overlay();
            send_command(AdminCommand::InstallHost {
                root_path: root_path.clone(),
                mode: mode.clone(),
            });
        }
    };

    let mut fields: Vec<AnyElement> = Vec::new();
    if let Some(err) = error {
        fields.push(notice_banner(err, Tone::Danger));
    }
    fields.push(
        text(format!("Root: {}", root_path.display()))
            .h(px(CELL_H))
            .number_of_lines(1)
            .text_color(palette::MUTED)
            .into_element(),
    );
    fields.push(
        view()
            .h(px(CELL_H))
            .flex_row()
            .items_center()
            .gap(px(CELL_W))
            .child(
                text("Launch Policy")
                    .w(px(16.0 * CELL_W))
                    .text_color(palette::MUTED),
            )
            .child(filter_chip("on-demand", mode == "on-demand", || {
                ui_signal().update(|u| {
                    if let Overlay::InstallHost { mode, .. } = &mut u.overlay {
                        *mode = "on-demand".to_owned();
                    }
                });
            }))
            .child(filter_chip("supervised", mode == "supervised", || {
                ui_signal().update(|u| {
                    if let Overlay::InstallHost { mode, .. } = &mut u.overlay {
                        *mode = "supervised".to_owned();
                    }
                });
            }))
            .into_element(),
    );

    modal_frame(
        "Install Managed Host Deployment",
        64.0,
        view().gap(px(CELL_H)).children(fields).into_element(),
        vec![
            action_btn("Cancel", Tone::Muted, false, close_overlay),
            action_btn("Install Host", Tone::Primary, false, submit),
        ],
    )
}

fn prepare_access_modal(
    root_path: PathBuf,
    principal: String,
    error: Option<String>,
) -> AnyElement {
    let submit = {
        let root_path = root_path.clone();
        let principal = principal.clone();
        move || {
            if principal.trim().is_empty() {
                ui_signal().update(|u| {
                    if let Overlay::PrepareAccess { error, .. } = &mut u.overlay {
                        *error = Some("Principal name is required".to_owned());
                    }
                });
                return;
            }
            close_overlay();
            send_command(AdminCommand::PrepareAppAccess {
                root_path: root_path.clone(),
                principal: principal.clone(),
            });
        }
    };

    let mut fields: Vec<AnyElement> = Vec::new();
    if let Some(err) = error {
        fields.push(notice_banner(err, Tone::Danger));
    }
    fields.push(form_field(
        "Principal",
        principal,
        "desktop (letters, digits, _ . : -)",
        |val| {
            ui_signal().update(|u| {
                if let Overlay::PrepareAccess {
                    principal, error, ..
                } = &mut u.overlay
                {
                    *principal = val.to_owned();
                    *error = None;
                }
            });
        },
    ));

    modal_frame(
        "Prepare Remote Application Credential",
        64.0,
        view().gap(px(CELL_H)).children(fields).into_element(),
        vec![
            action_btn("Cancel", Tone::Muted, false, close_overlay),
            action_btn("Prepare Credential", Tone::Primary, false, submit),
        ],
    )
}

fn revoke_cred_modal(
    root_path: PathBuf,
    credential_id: String,
    error: Option<String>,
) -> AnyElement {
    let submit = {
        let root_path = root_path.clone();
        let credential_id = credential_id.clone();
        move || {
            if credential_id.trim().is_empty() {
                ui_signal().update(|u| {
                    if let Overlay::RevokeCredential { error, .. } = &mut u.overlay {
                        *error = Some("Credential ID is required".to_owned());
                    }
                });
                return;
            }
            close_overlay();
            send_command(AdminCommand::RevokeAppCredential {
                root_path: root_path.clone(),
                credential_id: credential_id.clone(),
            });
        }
    };

    let mut fields: Vec<AnyElement> = Vec::new();
    if let Some(err) = error {
        fields.push(notice_banner(err, Tone::Danger));
    }
    fields.push(form_field(
        "Credential ID",
        credential_id,
        "Paste credential ID to revoke",
        |val| {
            ui_signal().update(|u| {
                if let Overlay::RevokeCredential {
                    credential_id,
                    error,
                    ..
                } = &mut u.overlay
                {
                    *credential_id = val.to_owned();
                    *error = None;
                }
            });
        },
    ));

    modal_frame(
        "Revoke Application Credential",
        64.0,
        view().gap(px(CELL_H)).children(fields).into_element(),
        vec![
            action_btn("Cancel", Tone::Muted, false, close_overlay),
            action_btn("Revoke Credential", Tone::Danger, false, submit),
        ],
    )
}
