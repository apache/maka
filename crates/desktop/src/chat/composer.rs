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

use super::{Chat, Delivery};
use crate::{
    theme::theme,
    ui::{self, icon},
};
use gpui_kit::{
    Context, InteractiveElement, IntoElement, ParentElement, SharedString,
    StatefulInteractiveElement, Styled, component::input::Textarea, div, prelude::FluentBuilder,
    px,
};

impl Chat {
    pub(super) fn render_composer(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = theme(cx);
        let status: Option<SharedString> = match &self.delivery {
            Some(Delivery::Failed(error)) => Some(format!("未发送：{error}").into()),
            Some(Delivery::Unknown { error, .. }) => Some(
                format!("发送结果未知（{error}）。消息出现在对话中即已送达；修改草稿可重新发送。")
                    .into(),
            ),
            _ => None,
        };
        let running = self.running().is_some();
        let sending = matches!(self.delivery, Some(Delivery::Sending));
        let draft = !self.composer.read(cx).value().trim().is_empty();
        let blocked =
            self.subscription.is_none() || matches!(self.delivery, Some(Delivery::Unknown { .. }));
        let this = cx.weak_entity();
        let (path, filled, tip) = if running {
            (
                "icons/square.svg",
                false,
                if self.stopping {
                    "正在停止…"
                } else {
                    "停止"
                },
            )
        } else if sending {
            ("icons/loader-circle.svg", false, "正在发送…")
        } else {
            ("icons/arrow-up.svg", draft && !blocked, "发送")
        };
        let action = div()
            .id("send")
            .size(px(26.))
            .flex_none()
            .rounded_full()
            .flex()
            .items_center()
            .justify_center()
            .border_1()
            .border_color(gpui_kit::transparent_black())
            .focus_visible(|style| style.border_color(theme.accent))
            .map(|this| {
                if filled {
                    this.bg(theme.accent_solid)
                        .hover(|style| style.opacity(0.9))
                } else if running {
                    this.bg(theme.text.opacity(0.09))
                        .hover(|style| style.bg(theme.danger.opacity(0.14)))
                } else {
                    this.bg(theme.text.opacity(0.09))
                }
            })
            .child(
                icon(
                    path,
                    if filled {
                        theme.on_accent
                    } else if running {
                        theme.text
                    } else {
                        theme.muted
                    },
                )
                .size(if running { px(12.) } else { px(16.) }),
            )
            .tooltip(ui::tooltip(tip));
        let action = ui::pressable(action, move |_, cx| {
            let _ = this.update(cx, |chat, cx| {
                if chat.running().is_some() {
                    chat.stop(cx);
                } else {
                    chat.send(cx);
                }
            });
        });
        div()
            .w_full()
            .flex()
            .justify_center()
            .px(px(20.))
            .pb(px(16.))
            .child(
                div()
                    .w_full()
                    .max_w(px(super::view::COLUMN))
                    .flex()
                    .flex_col()
                    .gap(px(6.))
                    .when_some(status, |this, status| {
                        this.child(
                            div()
                                .px(px(4.))
                                .text_size(px(12.5))
                                .text_color(theme.danger)
                                .child(status),
                        )
                    })
                    .child(
                        div()
                            .w_full()
                            .flex()
                            .flex_col()
                            .rounded(px(13.))
                            .border_1()
                            .border_color(theme.border)
                            .bg(theme.raised)
                            .py(px(10.))
                            .child(
                                div().px(px(14.)).pt(px(2.)).child(
                                    Textarea::new(&self.composer)
                                        .appearance(false)
                                        .text_size(px(13.5)),
                                ),
                            )
                            .child(
                                div()
                                    .mt(px(8.))
                                    .px(px(10.))
                                    .flex()
                                    .items_center()
                                    .gap(px(4.))
                                    .child(div().flex_1())
                                    .child(action),
                            ),
                    ),
            )
    }
}
