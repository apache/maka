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

//! The message queue above the composer: messages sent while a turn runs,
//! waiting for the Host to deliver them.

use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::{Disableable as _, Icon, Sizable as _, h_flex, v_flex};
use gpui_kit::{
    AnyElement, App, AppContext as _, Context, Entity, FontWeight, InteractiveElement as _,
    IntoElement, KeyBinding, ParentElement as _, Render, Role, SharedString,
    StatefulInteractiveElement as _, Styled as _, Subscription, Task, TestSupportExt as _, Window,
    div, prelude::FluentBuilder as _,
};
use host_protocol::{MessagePlacement, MessageQueueEntrySnapshot, MessageQueueEntryState};
use shared::copy::Locale;
use shared::copy::conversation as copy;
use shared::domain_element_id;
use shared::icons::MakaIcon;
use shared::theme::ActiveMakaPalette as _;

use crate::state::ConversationState;
use crate::style::{BODY_SIZE, RADIUS_CHAT, RADIUS_CONTROL, SUPPORTING_SIZE, dp, dp_px};

/// Key context of a queued message's edit field.
const QUEUE_EDIT_CONTEXT: &str = "QueueEdit";

gpui_kit::actions!(
    queue,
    [
        /// Leave a queued message's edit field without saving.
        CancelQueueEdit,
    ]
);

/// Binds the queue keys. Called by [`crate::init`].
pub(crate) fn init(cx: &mut App) {
    cx.bind_keys([KeyBinding::new("escape", CancelQueueEdit, Some(QUEUE_EDIT_CONTEXT))]);
}

/// The `ElementId` of the queue row of entry `entry_id`.
pub fn queue_entry_element_id(entry_id: &str) -> gpui_kit::ElementId {
    domain_element_id("queue-entry", entry_id)
}

/// The queued messages of the selected session, in the Host's order:
/// steering for the running turn first, then the follow-ups that each run as
/// their own turn, as `SessionMessageQueueProjection` lists them. It is
/// hidden while the queue is empty.
///
/// Behavior owner of the per-entry commands, which go through
/// [`ConversationState`]: Send now moves a follow-up into the running turn
/// (`queue.entry.promote`), Edit replaces the text in place
/// (`queue.entry.update` at the queue revision the edit started from, sent
/// once more at the latest revision when the Host refuses it as stale; see
/// [`ConversationState::edit_queued`]), and
/// Remove takes the message back (`queue.entry.retract`). One command at a
/// time; its failure shows under the list. The Host's projection is the only
/// order shown, so nothing is changed locally before it answers.
///
/// Keyboard: every action is a Button (Tab stop; Enter and Space activate).
/// In the edit field Enter saves and Escape cancels.
pub struct QueuePlate {
    state: Entity<ConversationState>,
    editing: Option<Editing>,
    error: Option<SharedString>,
    _command: Option<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

struct Editing {
    entry_id: String,
    /// The queue revision the next save names: the one the edit started
    /// from, or the latest one after a save failed.
    revision: u64,
    /// The entry's text when the edit started.
    original: String,
    input: Entity<InputState>,
    _events: Subscription,
}

impl std::fmt::Debug for QueuePlate {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("QueuePlate")
            .field("editing", &self.editing.as_ref().map(|editing| &editing.entry_id))
            .finish_non_exhaustive()
    }
}

impl QueuePlate {
    pub fn new(state: Entity<ConversationState>, cx: &mut Context<Self>) -> Self {
        let subscriptions = vec![cx.observe(&state, |this, state, cx| {
            // An entry that left the queue can no longer be edited.
            let gone = this.editing.as_ref().is_some_and(|editing| {
                state.read(cx).queue().is_none_or(|queue| {
                    !queue.entries().any(|entry| entry.entry_id == editing.entry_id)
                })
            });
            if gone {
                this.editing = None;
            }
            cx.notify();
        })];
        Self { state, editing: None, error: None, _command: None, _subscriptions: subscriptions }
    }

    /// The last command's failure, if any.
    pub fn error(&self) -> Option<&SharedString> {
        self.error.as_ref()
    }

    /// Moves follow-up `entry_id` into the running turn.
    pub fn promote(&mut self, entry_id: &str, cx: &mut Context<Self>) {
        let command = self.state.update(cx, |state, cx| state.promote_queued(entry_id, cx));
        self.run(command, false, cx);
    }

    /// Takes `entry_id` back out of the queue.
    pub fn remove(&mut self, entry_id: &str, cx: &mut Context<Self>) {
        let command = self.state.update(cx, |state, cx| state.retract_queued(entry_id, cx));
        self.run(command, false, cx);
    }

    /// Opens the edit field of `entry_id` with its text, focused.
    pub fn edit(&mut self, entry_id: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Some((text, revision)) = self.state.read(cx).queue().and_then(|queue| {
            let entry = queue.entries().find(|entry| entry.entry_id == entry_id)?;
            Some((entry.content.user_facing_text().to_owned(), queue.queue_revision))
        }) else {
            return;
        };
        let input = cx.new(|cx| InputState::new(window, cx).default_value(text.clone()));
        let events = cx.subscribe_in(&input, window, |this, _, event: &InputEvent, window, cx| {
            if let InputEvent::PressEnter { .. } = event {
                this.save(window, cx);
            }
        });
        input.update(cx, |input, cx| {
            input.focus(window, cx);
            input.select_all(window, cx);
        });
        self.error = None;
        self.editing = Some(Editing {
            entry_id: entry_id.to_owned(),
            revision,
            original: text,
            input,
            _events: events,
        });
        cx.notify();
    }

    /// Saves the edit field's text; a blank text is not sent.
    pub fn save(&mut self, _: &mut Window, cx: &mut Context<Self>) {
        let Some(editing) = &self.editing else {
            return;
        };
        let text = editing.input.read(cx).value().trim().to_owned();
        if text.is_empty() {
            return;
        }
        let (entry_id, revision) = (editing.entry_id.clone(), editing.revision);
        let original = editing.original.clone();
        let command = self
            .state
            .update(cx, |state, cx| state.edit_queued(&entry_id, revision, &original, &text, cx));
        self.run(command, true, cx);
    }

    fn cancel_edit(&mut self, _: &CancelQueueEdit, _: &mut Window, cx: &mut Context<Self>) {
        self.editing = None;
        cx.notify();
    }

    fn run(
        &mut self,
        command: Task<Result<(), SharedString>>,
        closes_edit: bool,
        cx: &mut Context<Self>,
    ) {
        self.error = None;
        self._command = Some(cx.spawn(async move |this, cx| {
            let result = command.await;
            this.update(cx, |this, cx| {
                match result {
                    Ok(()) if closes_edit => this.editing = None,
                    Ok(()) => {}
                    Err(message) => {
                        this.error = Some(message);
                        // The field stays open with the typed text. The next
                        // save names the latest revision instead of the one
                        // the Host may have just refused as stale.
                        let latest = this.state.read(cx).queue().map(|queue| queue.queue_revision);
                        if let (Some(editing), Some(latest)) = (this.editing.as_mut(), latest) {
                            editing.revision = editing.revision.max(latest);
                        }
                    }
                }
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    fn render_entry(
        &self,
        entry: &MessageQueueEntrySnapshot,
        busy: bool,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let maka = cx.maka();
        let entry_id = entry.entry_id.clone();
        let queued = entry.state == MessageQueueEntryState::Queued;
        let editing = self.editing.as_ref().filter(|editing| editing.entry_id == entry_id);
        let text = SharedString::from(entry.content.user_facing_text().to_owned());
        let body = match editing {
            Some(editing) => div()
                .flex_1()
                .min_w_0()
                .key_context(QUEUE_EDIT_CONTEXT)
                .on_action(cx.listener(Self::cancel_edit))
                .child(
                    Input::new(&editing.input).small().aria_label(copy::QUEUE_EDIT_FIELD.get(cx)),
                )
                .into_any_element(),
            None => div()
                .flex_1()
                .min_w_0()
                .truncate()
                .text_color(maka.ink)
                .child(text.clone())
                .into_any_element(),
        };
        let icon_button = |id: &'static str, icon: MakaIcon, label: &'static str| {
            Button::new(id)
                .ghost()
                .size(dp(24.))
                .p_0()
                .rounded(dp_px(RADIUS_CONTROL, window))
                .child(Icon::new(icon).with_size(dp_px(14., window)).text_color(maka.ink_muted))
                .accessibility_label(label)
                .tooltip(label)
        };
        let actions = if editing.is_some() {
            h_flex()
                .flex_shrink_0()
                .gap_1()
                .child(
                    Button::new("queue-save")
                        .ghost()
                        .xsmall()
                        .label(copy::QUEUE_SAVE.get(cx))
                        .loading(busy)
                        .disabled(busy)
                        .on_click(cx.listener(|this, _, window, cx| this.save(window, cx))),
                )
                .child(
                    Button::new("queue-cancel")
                        .ghost()
                        .xsmall()
                        .label(shared::copy::CANCEL.get(cx))
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.cancel_edit(&CancelQueueEdit, window, cx)
                        })),
                )
        } else if !queued {
            // Taken by the running turn: on its way, no longer changeable.
            h_flex()
                .flex_shrink_0()
                .text_size(dp(SUPPORTING_SIZE))
                .text_color(maka.ink_muted)
                .child(copy::QUEUE_SENDING.get(cx))
        } else {
            let (promote, edit, remove) = (entry_id.clone(), entry_id.clone(), entry_id.clone());
            h_flex()
                .flex_shrink_0()
                .gap(dp(2.))
                .when(entry.placement == MessagePlacement::NextTurn, |this| {
                    this.child(
                        icon_button("queue-promote", MakaIcon::Send, copy::QUEUE_PROMOTE.get(cx))
                            .tooltip(copy::QUEUE_PROMOTE_HINT.get(cx))
                            .disabled(busy)
                            .on_click(
                                cx.listener(move |this, _, _, cx| this.promote(&promote, cx)),
                            ),
                    )
                })
                .child(
                    icon_button("queue-edit", MakaIcon::Compose, copy::QUEUE_EDIT.get(cx))
                        .disabled(busy)
                        .on_click(
                            cx.listener(move |this, _, window, cx| this.edit(&edit, window, cx)),
                        ),
                )
                .child(
                    icon_button("queue-remove", MakaIcon::Close, copy::QUEUE_REMOVE.get(cx))
                        .disabled(busy)
                        .on_click(cx.listener(move |this, _, _, cx| this.remove(&remove, cx))),
                )
        };
        h_flex()
            .id(queue_entry_element_id(&entry_id))
            .test_support()
            .role(Role::ListItem)
            .aria_label(text)
            .w_full()
            .h(dp(32.))
            .gap(dp(8.))
            .child(
                Icon::new(MakaIcon::Queue).with_size(dp_px(14., window)).text_color(maka.ink_muted),
            )
            .child(body)
            .child(actions)
            .into_any_element()
    }
}

impl Render for QueuePlate {
    /// The dock's top section (review round 3): queued entries are user
    /// messages waiting to go, so they sit in the bubble tone inside the
    /// composer dock, above the draft, the fill step as the one separator;
    /// the dock's radius-28 corners clip them. A 12/500 muted caption per
    /// group (steering the running turn, then queued after it) over 32px rows.
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let maka = cx.maka();
        let state = self.state.read(cx);
        let entries: Vec<MessageQueueEntrySnapshot> =
            state.queue().map(|queue| queue.entries().cloned().collect()).unwrap_or_default();
        let busy_entry = state.queue_action().map(str::to_owned);
        if entries.is_empty() {
            return div().id("message-queue").into_any_element();
        }
        let mut groups: Vec<(MessagePlacement, Vec<&MessageQueueEntrySnapshot>)> = Vec::new();
        for placement in [MessagePlacement::CurrentTurn, MessagePlacement::NextTurn] {
            let group: Vec<_> =
                entries.iter().filter(|entry| entry.placement == placement).collect();
            if !group.is_empty() {
                groups.push((placement, group));
            }
        }
        let mut plate = v_flex()
            .id("message-queue")
            .test_support()
            .role(Role::List)
            .aria_label(copy::queued_messages(Locale::current(cx), entries.len()))
            .w_full()
            .px(dp(20.))
            .pt(dp(12.))
            .pb(dp(6.))
            .bg(maka.bubble)
            // GPUI clips children to a rectangle, not to the dock's rounded
            // corners, so the section rounds its own top to the chat rung.
            .rounded_t(dp(RADIUS_CHAT))
            // The fill step to the draft below is the separator; a line on
            // the same edge would be a second one (DESIGN.md §4).
            .text_size(dp(BODY_SIZE));
        for (ix, (placement, group)) in groups.into_iter().enumerate() {
            let title = match placement {
                MessagePlacement::CurrentTurn => copy::QUEUE_STEERING_TITLE.get(cx),
                _ => copy::QUEUE_FOLLOWUP_TITLE.get(cx),
            };
            plate = plate.child(
                div()
                    .when(ix > 0, |this| this.pt(dp(6.)))
                    .pb(dp(2.))
                    .text_size(dp(SUPPORTING_SIZE))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(maka.ink_muted)
                    .child(title),
            );
            for entry in group {
                let busy = busy_entry.is_some();
                plate = plate.child(self.render_entry(entry, busy, window, cx));
            }
        }
        plate
            .when_some(self.error.clone(), |this, error| {
                this.child(
                    div()
                        .id("queue-error")
                        .test_support()
                        .aria_label(error.clone())
                        .pb(dp(6.))
                        .text_size(dp(SUPPORTING_SIZE))
                        .text_color(maka.destructive)
                        .child(error),
                )
            })
            .into_any_element()
    }
}
