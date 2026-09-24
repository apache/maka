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

//! The card that asks before the agent acts, between the transcript and
//! the composer. Unless the user is typing, its first choice takes focus
//! when it appears, so Enter answers it and Tab moves between the choices.

use super::Chat;
use crate::{
    theme::theme,
    ui::{Tone, button, icon},
};
use gpui_kit::{
    AnyElement, Context, Focusable, FontWeight, InteractiveElement, IntoElement, ParentElement,
    Role, SharedString, StatefulInteractiveElement, Styled, Window, div, prelude::FluentBuilder,
    px,
};
use maka_protocol::interaction::{self, InteractionRequest};
use serde_json::{Value, json};

impl Chat {
    pub(super) fn render_permission(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let Some(pending) = self
            .snapshot
            .as_ref()
            .and_then(|snapshot| snapshot.interactions.pending().first())
            .cloned()
        else {
            // The answered card took its focus with it; hand it to the
            // composer unless the reader has since moved it elsewhere.
            if self.focused_interaction.take().is_some()
                && (window.focused(cx).is_none() || self.permission_focus.is_focused(window))
            {
                let handle = self.composer.read(cx).focus_handle(cx);
                window.on_next_frame(move |window, cx| window.focus(&handle, cx));
            }
            return None;
        };
        let id = pending.interaction_id().to_owned();
        if self.focused_interaction.as_deref() != Some(id.as_str()) {
            self.focused_interaction = Some(id.clone());
            // Taking focus from the composer would turn the next typed space
            // into an answer.
            let typing = self.composer.read(cx).focus_handle(cx).is_focused(window);
            if !typing {
                let handle = self.permission_focus.clone();
                window.on_next_frame(move |window, cx| window.focus(&handle, cx));
            }
        }
        let busy = self.answering.as_deref() == Some(id.as_str());
        let (title, detail, choices): (&str, String, Vec<(&str, &str, Value)>) = match pending
            .request()
        {
            InteractionRequest::Permissions {
                tool_use_id,
                request,
                ..
            } => {
                let allow = |scope: &str| json!({"decision": "allow", "permissions": request.permissions, "scope": scope});
                let mut choices = Vec::new();
                if tool_use_id.is_some() {
                    choices.push(("once", "允许一次", allow("once")));
                }
                choices.push(("session", "本会话允许", allow("session")));
                choices.push(("deny", "拒绝", json!({"decision": "deny"})));
                let detail = match &request.command {
                    Some(command) => format!("{}\n$ {}", request.reason, command.command),
                    None => request.reason.clone(),
                };
                (
                    "需要额外权限",
                    detail,
                    choices
                        .into_iter()
                        .map(|(id, label, decision)| {
                            (
                                id,
                                label,
                                json!({"kind": "permissions", "decision": decision}),
                            )
                        })
                        .collect(),
                )
            }
            InteractionRequest::ClientCapability { target, .. } => (
                "客户端能力请求",
                serde_json::to_string_pretty(target).unwrap_or_default(),
                vec![
                    (
                        "allow",
                        "允许",
                        json!({"kind": "client_capability", "decision": "allow"}),
                    ),
                    (
                        "deny",
                        "拒绝",
                        json!({"kind": "client_capability", "decision": "deny"}),
                    ),
                ],
            ),
            _ => ("有待回答的问题", "请在其他客户端中回答。".into(), vec![]),
        };
        let theme = theme(cx);
        let this = cx.weak_entity();
        let buttons = choices
            .into_iter()
            .enumerate()
            .map(|(ix, (choice, label, value))| {
                let pending = pending.clone();
                let this = this.clone();
                // Only a one-time allow is the default; a session-wide grant
                // must be chosen deliberately.
                let tone = if ix == 0 && choice != "session" {
                    Tone::Primary
                } else {
                    Tone::Outline
                };
                let control = button(
                    SharedString::from(format!("interaction-{choice}")),
                    label,
                    tone,
                    busy,
                    move |_, cx| {
                        let _ =
                            this.update(cx, |chat, cx| match interaction::decode_answer(&value) {
                                Ok(answer) => chat.answer(pending.clone(), answer, cx),
                                Err(error) => {
                                    chat.interaction_error = Some(error.to_string().into());
                                    cx.notify();
                                }
                            });
                    },
                    cx,
                );
                if ix == 0 {
                    control.track_focus(&self.permission_focus)
                } else {
                    control
                }
            });
        Some(
            div()
                .w_full()
                .flex()
                .justify_center()
                .px(px(20.))
                .pb(px(8.))
                .child(
                    div()
                        .id("interaction")
                        .role(Role::Group)
                        .aria_label(title)
                        .aria_description(detail.clone())
                        .w_full()
                        .max_w(px(super::view::COLUMN))
                        .p(px(12.))
                        .flex()
                        .flex_col()
                        .rounded(px(12.))
                        .border_1()
                        .border_color(theme.border)
                        .bg(theme.raised)
                        .shadow_md()
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(8.))
                                .child(
                                    icon("icons/triangle-alert.svg", theme.warning).size(px(13.)),
                                )
                                .child(
                                    div()
                                        .text_size(px(12.5))
                                        .font_weight(FontWeight::MEDIUM)
                                        .child(title),
                                ),
                        )
                        .child(
                            div()
                                .id("interaction-detail")
                                .mt(px(8.))
                                .max_h(px(92.))
                                .overflow_y_scroll()
                                .p(px(8.))
                                .rounded(px(7.))
                                .bg(theme.sunken)
                                .font_family(theme.mono_font.clone())
                                .text_size(px(12.5))
                                .line_height(px(16.))
                                .text_color(theme.muted)
                                .child(detail),
                        )
                        .when_some(self.interaction_error.clone(), |this, error| {
                            this.child(
                                div()
                                    .mt(px(8.))
                                    .text_size(px(12.5))
                                    .text_color(theme.danger)
                                    .child(error),
                            )
                        })
                        .child(div().mt(px(10.)).flex().gap(px(8.)).children(buttons)),
                )
                .into_any_element(),
        )
    }
}
