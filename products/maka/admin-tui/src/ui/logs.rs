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
    model::{AdminCommand, LogLevel},
    ui::{
        components::{action_btn, badge, empty_state, filter_chip, short_hash},
        state::{LogFilter, copy_text, logs_signal, send_command, ui_signal},
        theme::{CELL_H, CELL_W, Tone, palette},
    },
};
use nsh_base::input;
use nsh_core::{element::AnyElement, prelude::*};

fn level_tone(level: LogLevel) -> Tone {
    match level {
        LogLevel::Error => Tone::Danger,
        LogLevel::Warn => Tone::Warning,
        LogLevel::Info => Tone::Primary,
        LogLevel::Debug => Tone::Accent,
        LogLevel::Trace | LogLevel::Other => Tone::Muted,
    }
}

pub fn logs_screen() -> AnyElement {
    let toolbar = view()
        .border_1()
        .border_color(palette::BORDER)
        .rounded(px(4.0))
        .px(px(CELL_W))
        .child(
            view()
                .h(px(CELL_H))
                .flex_row()
                .items_center()
                .justify_between()
                .gap(px(CELL_W))
                .child(dynamic(move || {
                    let current = ui_signal().with(|u| u.log_filter);
                    let chips: Vec<AnyElement> = LogFilter::ALL
                        .iter()
                        .copied()
                        .map(|f| {
                            filter_chip(f.label(), current == f, move || {
                                ui_signal().update(|u| u.log_filter = f);
                            })
                        })
                        .collect();
                    view()
                        .flex_row()
                        .items_center()
                        .gap(px(CELL_W))
                        .children(chips)
                        .into_element()
                }))
                .child(dynamic(move || {
                    let logs = logs_signal().with(|l| l.0.clone());
                    let next_follow = !logs.follow;
                    let lines_for_copy = logs
                        .lines
                        .iter()
                        .map(|l| l.text.as_str())
                        .collect::<Vec<_>>()
                        .join("\n");
                    view()
                        .flex_row()
                        .items_center()
                        .gap(px(CELL_W))
                        .child(action_btn(
                            if logs.follow {
                                "Follow: ON"
                            } else {
                                "Follow: OFF"
                            },
                            if logs.follow {
                                Tone::Success
                            } else {
                                Tone::Muted
                            },
                            false,
                            move || {
                                send_command(AdminCommand::SetLogFollow {
                                    follow: next_follow,
                                });
                            },
                        ))
                        .child(action_btn("Reload", Tone::Accent, false, || {
                            send_command(AdminCommand::RefreshLogs);
                        }))
                        .child(action_btn(
                            "Copy Tail",
                            Tone::Neutral,
                            lines_for_copy.is_empty(),
                            move || {
                                copy_text("Host logs", &lines_for_copy);
                            },
                        ))
                        .into_element()
                })),
        )
        .child(
            view()
                .h(px(CELL_H))
                .flex_row()
                .items_center()
                .gap(px(CELL_W))
                .child(
                    text("Filter:")
                        .w(px(8.0 * CELL_W))
                        .text_color(palette::MUTED),
                )
                .child(
                    input()
                        .value(move || ui_signal().with(|u| u.log_search.clone()))
                        .on_change(move |val: &str| {
                            ui_signal().update(|u| u.log_search = val.to_owned());
                        })
                        .placeholder("Type to filter log lines…")
                        .flex_1()
                        .h(px(CELL_H))
                        .text_color(palette::TEXT),
                )
                .child(dynamic(move || {
                    let logs = logs_signal().with(|l| l.0.clone());
                    let root_label = logs
                        .root_id
                        .as_deref()
                        .map(short_hash)
                        .unwrap_or_else(|| "no root".to_owned());
                    badge(
                        format!("{} lines · {root_label}", logs.lines.len()),
                        if logs.missing {
                            Tone::Muted
                        } else {
                            Tone::Accent
                        },
                    )
                })),
        );

    let log_body = view()
        .flex_1()
        .border_1()
        .border_color(palette::BORDER)
        .rounded(px(4.0))
        .child(scroll().flex_1().child(dynamic(move || {
            let logs = logs_signal().with(|l| l.0.clone());
            let (filter, search) = ui_signal().with(|u| (u.log_filter, u.log_search.clone()));
            let needle = search.trim().to_ascii_lowercase();

            if logs.missing {
                return empty_state(
                    "No Host log file captured yet",
                    logs.path.unwrap_or_else(|| {
                        "Select an initialized Host to stream its stderr log.".to_owned()
                    }),
                );
            }

            let filtered: Vec<_> = logs
                .lines
                .iter()
                .filter(|line| {
                    filter.matches(line.level)
                        && (needle.is_empty() || line.text.to_ascii_lowercase().contains(&needle))
                })
                .collect();

            if filtered.is_empty() {
                return empty_state(
                    "No matching log lines",
                    if needle.is_empty() && filter == LogFilter::All {
                        "Waiting for Host stderr output…"
                    } else {
                        "Adjust the level filter or search text."
                    },
                );
            }

            // Show newest lines at the bottom; cap rendered rows to keep terminal frames instant.
            let start = filtered.len().saturating_sub(250);
            let rows: Vec<AnyElement> = filtered[start..]
                .iter()
                .map(|line| {
                    let tone = level_tone(line.level);
                    view()
                        .h(px(CELL_H))
                        .flex_row()
                        .items_center()
                        .gap(px(CELL_W))
                        .px(px(CELL_W))
                        .child(
                            text(line.level.badge())
                                .w(px(4.0 * CELL_W))
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(tone.color()),
                        )
                        .child(
                            text(line.text.clone())
                                .flex_1()
                                .number_of_lines(1)
                                .text_color(if line.level == LogLevel::Error {
                                    palette::DANGER
                                } else if line.level == LogLevel::Warn {
                                    palette::WARNING
                                } else {
                                    palette::TEXT
                                }),
                        )
                        .into_element()
                })
                .collect();

            view().children(rows).into_element()
        })));

    view()
        .flex_1()
        .p(px(CELL_W))
        .gap(px(CELL_H))
        .child(toolbar)
        .child(log_body)
        .into_element()
}
