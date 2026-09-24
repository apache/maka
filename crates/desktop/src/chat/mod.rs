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

mod composer;
mod permission;
mod rows;
mod tools;
mod view;

use crate::{
    host::Host,
    md::view::Body,
    ui::{self, Copied, scrollbar::Scrollbar, select::Selection},
};
use gpui_kit::base::input::{InputEvent, TextareaState};
use gpui_kit::{
    AnyWindowHandle, AppContext, Context, Entity, FocusHandle, FollowMode, ListAlignment,
    ListOffset, ListState, Pixels, SharedString, Subscription, Window, px,
};
use maka_client::{
    Client, RequestFailure,
    transcript::{LiveText, TranscriptBatch},
};
use maka_protocol::{
    interaction::{InteractionAnswer, InteractionSnapshot},
    message::{Placement, SubmitInput, SubmitResult},
    subscription::{
        AssistantObservationFrame, AssistantStreamKind, ObservationFrame,
        SessionAssistantStreamIdentity, SessionObservationSnapshot, SessionProjectionFrame,
        SubscriptionClosedReason, SubscriptionOpenInput, TranscriptAdvancedFrame, TranscriptPolicy,
    },
    transcript::{SessionTranscriptPageDirection, SessionTranscriptPageInput},
    turn::{MessageContent as TurnContent, TurnState, TurnStopInput},
};
use rows::{Entry, Row, Transcript};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    time::{Duration, Instant},
};

const TAIL_BYTES: u64 = 16 * 1024;
const PAGE_BYTES: u64 = 64 * 1024;
/// Streaming changes the height of the reply and of the rows around it.
const TAIL_ROWS: usize = 3;

gpui_kit::actions!(transcript, [CopySelection]);

enum Delivery {
    Sending,
    Failed(SharedString),
    /// The request may have landed. Sending stays blocked until the prompt
    /// shows up in the transcript or the user changes the draft, so the
    /// same text is never sent twice by accident.
    Unknown {
        error: SharedString,
        text: String,
    },
}

/// Keeps a just-sent prompt at the top of the view while its reply grows
/// below it, until the reply fills the view and the list follows its end.
struct Anchor {
    row: String,
    pinning: bool,
}

pub struct Chat {
    client: Client,
    session: String,
    subscription: Option<String>,
    error: Option<SharedString>,
    rows: BTreeMap<u64, Value>,
    through: Option<u64>,
    wanted: Option<u64>,
    paging: bool,
    live: Vec<(SessionAssistantStreamIdentity, LiveText)>,
    snapshot: Option<SessionObservationSnapshot>,
    transcript: Transcript,
    fold: Vec<Row>,
    keys: Vec<String>,
    bodies: HashMap<String, Body>,
    list: ListState,
    scrollbar: Scrollbar,
    selection: Selection,
    copied: Entity<Copied>,
    /// Settled turns whose folded work is shown.
    open_turns: HashSet<String>,
    /// Groups and calls the reader opened or closed, overriding the default.
    toggled: HashMap<String, bool>,
    hovered_turn: Option<String>,
    sent: Option<String>,
    anchor: Option<Anchor>,
    end_space: Pixels,
    jump: bool,
    composer: Entity<TextareaState>,
    window: AnyWindowHandle,
    delivery: Option<Delivery>,
    stopping: bool,
    answering: Option<String>,
    interaction_error: Option<SharedString>,
    focus: FocusHandle,
    permission_focus: FocusHandle,
    focused_interaction: Option<String>,
    /// Animation time for this frame; `None` when nothing moves or motion
    /// is reduced.
    elapsed: Option<Duration>,
    now: Option<Instant>,
    _subscriptions: Vec<Subscription>,
}

impl Chat {
    pub fn new(
        client: Client,
        session: String,
        copied: Entity<Copied>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let list = ListState::new(0, ListAlignment::Top, px(2048.));
        list.set_follow_mode(FollowMode::Tail);
        let weak = cx.weak_entity();
        list.set_scroll_handler(move |event, _, cx| {
            if !event.is_scrolled {
                return;
            }
            let _ = weak.update(cx, |chat, cx| {
                if let Some(anchor) = &mut chat.anchor
                    && anchor.pinning
                {
                    anchor.pinning = false;
                    cx.notify();
                }
            });
        });
        let composer = cx.new(|cx| {
            TextareaState::new(window, cx)
                .auto_grow(1, 13)
                .submit_on_enter(true)
                .placeholder("给 Maka 发消息")
        });
        let submit = cx.subscribe(&composer, |this, composer, event, cx| match event {
            InputEvent::PressEnter { shift: false, .. } => this.send(cx),
            InputEvent::Change => {
                if let Some(Delivery::Unknown { text, .. }) = &this.delivery
                    && composer.read(cx).value() != text.as_str()
                {
                    this.delivery = None;
                    this.sent = None;
                }
                cx.notify();
            }
            _ => {}
        });
        let redraw = cx.observe(&copied, |_, _, cx| cx.notify());
        let mut this = Self {
            client,
            session,
            subscription: None,
            error: None,
            rows: BTreeMap::new(),
            through: None,
            wanted: None,
            paging: false,
            live: Vec::new(),
            snapshot: None,
            transcript: Transcript::default(),
            fold: Vec::new(),
            keys: Vec::new(),
            bodies: HashMap::new(),
            list,
            scrollbar: Scrollbar::default(),
            selection: Selection::default(),
            copied,
            open_turns: HashSet::new(),
            toggled: HashMap::new(),
            hovered_turn: None,
            sent: None,
            anchor: None,
            end_space: px(0.),
            jump: false,
            composer,
            window: window.window_handle(),
            delivery: None,
            stopping: false,
            answering: None,
            interaction_error: None,
            focus: cx.focus_handle(),
            permission_focus: cx.focus_handle(),
            focused_interaction: None,
            elapsed: None,
            now: None,
            _subscriptions: vec![submit, redraw],
        };
        this.open(cx);
        this
    }

    pub fn session(&self) -> &str {
        &self.session
    }

    pub fn focus_composer(&self, window: &mut Window, cx: &mut Context<Self>) {
        self.composer
            .update(cx, |composer, cx| composer.focus(window, cx));
    }

    fn open(&mut self, cx: &mut Context<Self>) {
        let client = self.client.clone();
        let session = self.session.clone();
        let opening = cx.global::<Host>().spawn(async move {
            let opened = client
                .open_subscription(SubscriptionOpenInput {
                    session_id: session,
                    transcript: TranscriptPolicy::Tail {
                        max_bytes: TAIL_BYTES,
                    },
                })
                .await
                .map_err(|error| error.to_string())?;
            let durable = match &opened.transcript {
                Some(bootstrap) => bootstrap.durable.clone(),
                None => {
                    let _ = client.close_subscription(&opened.subscription_id).await;
                    return Err("Transcript bootstrap missing".to_string());
                }
            };
            match client
                .complete_transcript_page(&opened.subscription_id, durable)
                .await
            {
                Ok(batch) => Ok((opened, batch)),
                Err(error) => {
                    let _ = client.close_subscription(&opened.subscription_id).await;
                    Err(error.to_string())
                }
            }
        });
        cx.spawn(async move |this, cx| {
            let result = opening.await.and_then(|result| result);
            let _ = this.update(cx, |this, cx| match result {
                Ok((opened, batch)) => {
                    this.snapshot = Some(opened.snapshot);
                    this.install(batch);
                    this.through = this.wanted;
                    this.rebuild(cx);
                    // The Host starts pushing frames only after ready, so the
                    // snapshot above must already be installed.
                    this.subscription = Some(opened.subscription_id.clone());
                    this.ready(opened.subscription_id, cx);
                }
                Err(error) => {
                    this.error = Some(error.into());
                    cx.notify();
                }
            });
        })
        .detach();
    }

    fn ready(&mut self, subscription: String, cx: &mut Context<Self>) {
        let client = self.client.clone();
        let ready = cx
            .global::<Host>()
            .spawn(async move { client.ready_subscription(&subscription).await });
        cx.spawn(async move |this, cx| {
            if let Err(error) = ready.await.and_then(|r| r.map_err(|e| e.to_string())) {
                let _ = this.update(cx, |this, cx| {
                    this.error = Some(error.into());
                    cx.notify();
                });
            }
        })
        .detach();
    }

    pub fn close(&mut self, cx: &mut Context<Self>) {
        if let Some(subscription) = self.subscription.take() {
            let client = self.client.clone();
            let closing = cx
                .global::<Host>()
                .spawn(async move { client.close_subscription(&subscription).await });
            cx.background_executor()
                .spawn(async move {
                    let _ = closing.await;
                })
                .detach();
        }
    }

    fn install(&mut self, batch: TranscriptBatch) {
        for row in batch.rows {
            if row.value["type"] == "assistant" {
                let id = row.value["id"].as_str().unwrap_or_default();
                self.live.retain(|(stream, _)| stream.message_id != id);
            }
            self.rows.insert(row.sequence, row.value);
        }
        if let Some(through) = batch.through_sequence {
            self.wanted = self.wanted.max(Some(through));
        }
    }

    pub fn accept(&mut self, frames: Vec<ObservationFrame>, cx: &mut Context<Self>) {
        let mut changed = false;
        for frame in frames {
            if self.subscription.as_deref() != Some(frame.envelope().subscription_id) {
                continue;
            }
            match frame {
                ObservationFrame::Projection(frame) => {
                    let SessionProjectionFrame::SessionProjection { snapshot, .. } = *frame;
                    self.snapshot = Some(snapshot);
                    self.stopping &= self.running().is_some();
                    changed = true;
                }
                ObservationFrame::Transcript(TranscriptAdvancedFrame::TranscriptAdvanced {
                    through_sequence,
                    ..
                }) => {
                    self.wanted = self.wanted.max(Some(through_sequence));
                }
                ObservationFrame::Assistant(AssistantObservationFrame::SessionDelta {
                    delta,
                    ..
                }) => {
                    // A durable row may arrive before a trailing complete delta.
                    if self
                        .rows
                        .values()
                        .any(|row| row["id"] == delta.message_id && row["turnId"] == delta.turn_id)
                    {
                        continue;
                    }
                    let index = self.live.iter().position(|(id, _)| {
                        id.message_id == delta.message_id
                            && id.turn_id == delta.turn_id
                            && id.kind == delta.kind
                    });
                    let index = index.unwrap_or_else(|| {
                        self.live.push((
                            SessionAssistantStreamIdentity {
                                kind: delta.kind,
                                turn_id: delta.turn_id.clone(),
                                message_id: delta.message_id.clone(),
                            },
                            LiveText::default(),
                        ));
                        self.live.len() - 1
                    });
                    if let Err(error) = self.live[index].1.apply(&delta) {
                        self.error = Some(error.to_string().into());
                    }
                    changed = true;
                }
                ObservationFrame::Assistant(AssistantObservationFrame::Closed {
                    reason, ..
                }) => {
                    self.subscription = None;
                    self.error = Some(
                        match reason {
                            SubscriptionClosedReason::SessionRemoved => "会话已删除",
                            SubscriptionClosedReason::AccessRevoked => "访问权限已撤销",
                            SubscriptionClosedReason::SlowConsumer => "订阅因处理过慢被 Host 关闭",
                        }
                        .into(),
                    );
                    changed = true;
                }
                _ => {}
            }
        }
        self.fetch_newer(cx);
        if changed {
            self.rebuild(cx);
        }
    }

    fn fetch_newer(&mut self, cx: &mut Context<Self>) {
        let (Some(subscription), Some(wanted)) = (self.subscription.clone(), self.wanted) else {
            return;
        };
        if self.paging || self.through >= Some(wanted) {
            return;
        }
        self.paging = true;
        let client = self.client.clone();
        let anchor = self.through;
        let fetching = cx.global::<Host>().spawn(async move {
            let mut cursor = None;
            let mut batches = Vec::new();
            loop {
                let page = client
                    .transcript_page(SessionTranscriptPageInput {
                        subscription_id: subscription.clone(),
                        direction: SessionTranscriptPageDirection::Newer,
                        through_sequence: Some(wanted),
                        cursor: cursor.take(),
                        anchor_sequence: anchor,
                        max_bytes: PAGE_BYTES,
                    })
                    .await
                    .map_err(|error| error.to_string())?;
                let batch = client
                    .complete_transcript_page(&subscription, page)
                    .await
                    .map_err(|error| error.to_string())?;
                cursor = batch.next_cursor.clone();
                batches.push(batch);
                if cursor.is_none() {
                    return Ok::<_, String>(batches);
                }
            }
        });
        cx.spawn(async move |this, cx| {
            let result = fetching.await.and_then(|result| result);
            let _ = this.update(cx, |this, cx| {
                this.paging = false;
                match result {
                    Ok(batches) => {
                        for batch in batches {
                            this.install(batch);
                        }
                        this.through = this.through.max(Some(wanted));
                        this.rebuild(cx);
                        this.fetch_newer(cx);
                    }
                    Err(error) => {
                        this.error = Some(error.into());
                        cx.notify();
                    }
                }
            });
        })
        .detach();
    }

    /// The live root turn, if one is running.
    fn running(&self) -> Option<&maka_protocol::turn::TurnSnapshot> {
        self.snapshot
            .as_ref()
            .and_then(|snapshot| snapshot.root_turn.as_ref())
            .filter(|turn| {
                matches!(
                    turn.state,
                    TurnState::Admitted(_)
                        | TurnState::Created(_)
                        | TurnState::Running(_)
                        | TurnState::WaitingForUser(_)
                )
            })
    }

    fn rebuild(&mut self, cx: &mut Context<Self>) {
        let now = Instant::now();
        let live = self
            .live
            .iter()
            .filter(|(_, text)| !text.text.is_empty())
            .map(|(stream, text)| match stream.kind {
                AssistantStreamKind::Text => Entry::Text {
                    id: stream.message_id.clone(),
                    turn: stream.turn_id.clone(),
                    text: text.text.clone(),
                    streaming: true,
                },
                AssistantStreamKind::Thinking => Entry::Thought {
                    id: stream.message_id.clone(),
                    turn: stream.turn_id.clone(),
                    text: text.text.clone(),
                    streaming: true,
                },
            });
        self.transcript = rows::transcript(self.rows.values(), live.collect::<Vec<_>>());
        let running = self.running().map(|turn| turn.turn_id.clone());
        let fold = rows::fold(&self.transcript, running.as_deref(), &self.open_turns);
        let keys: Vec<String> = fold
            .iter()
            .map(|row| row.key(&self.transcript.entries))
            .collect();

        let mut seen = HashSet::new();
        for entry in &self.transcript.entries {
            let (key, text, streaming) = match entry {
                Entry::Prompt { id, text, .. } => (format!("prompt:{id}"), text, false),
                Entry::Text {
                    id,
                    text,
                    streaming,
                    ..
                } => (format!("text:{id}"), text, *streaming),
                Entry::Thought {
                    id,
                    text,
                    streaming,
                    ..
                } => (format!("thought:{id}"), text, *streaming),
                Entry::Tool { .. } => continue,
            };
            match self.bodies.get_mut(&key) {
                Some(body) => body.update(text, streaming, now),
                None => {
                    self.bodies.insert(key.clone(), Body::new(text, streaming));
                }
            }
            seen.insert(key);
        }
        self.bodies.retain(|key, _| seen.contains(key));

        if let Some(sent) = &self.sent {
            let row = format!("prompt:{sent}");
            if keys.contains(&row) {
                self.sent = None;
                if let Some(Delivery::Unknown { text, .. }) = self.delivery.take() {
                    self.clear_sent_draft(text, cx);
                }
                self.anchor = Some(Anchor { row, pinning: true });
                // Room for the reply before anything is measured, so the
                // prompt never shows at the bottom first.
                self.end_space = self.list.viewport_bounds().size.height;
                self.list.pause_following_tail();
            }
        }

        let old = std::mem::replace(&mut self.keys, keys);
        ui::splice(&self.list, &old, &self.keys);
        let tail = self.keys.len().saturating_sub(TAIL_ROWS)..self.keys.len();
        if !tail.is_empty() {
            self.list.remeasure_items(tail);
        }
        self.fold = fold;
        cx.notify();
    }

    /// Keeps the list where the reader is while a row changes height under
    /// them, instead of snapping to the end.
    fn toggle(&mut self, key: String, open: bool, row: usize, cx: &mut Context<Self>) {
        self.list.pause_following_tail();
        if let Some(anchor) = &mut self.anchor {
            anchor.pinning = false;
        }
        self.toggled.insert(key, open);
        self.list.remeasure_items(row..row + 1);
        cx.notify();
    }

    fn toggle_turn(&mut self, turn: String, cx: &mut Context<Self>) {
        self.list.pause_following_tail();
        if let Some(anchor) = &mut self.anchor {
            anchor.pinning = false;
        }
        if !self.open_turns.remove(&turn) {
            self.open_turns.insert(turn);
        }
        self.rebuild(cx);
    }

    /// Before layout: size the room under the anchored prompt and hold the
    /// prompt at the top while that room remains.
    fn place(&mut self, window: &Window) {
        let Some(anchor) = &mut self.anchor else {
            self.end_space = px(0.);
            return;
        };
        let Some(ix) = self.keys.iter().position(|key| *key == anchor.row) else {
            self.anchor = None;
            self.end_space = px(0.);
            return;
        };
        let viewport = match self.list.viewport_bounds().size.height {
            height if height > px(0.) => height,
            _ => window.viewport_size().height,
        };
        let last = self.keys.len() - 1;
        // Unmeasured rows are unknown, not empty: keep the last answer.
        if let (Some(top), Some(bottom)) = (
            self.list.bounds_for_item(ix),
            self.list.bounds_for_item(last),
        ) {
            self.end_space = (viewport - (bottom.bottom() - top.top())).max(px(0.));
        }
        if !anchor.pinning {
            return;
        }
        if self.end_space > px(0.) {
            self.list.pause_following_tail();
            self.list.scroll_to(ListOffset {
                item_ix: ix,
                offset_in_item: px(0.),
            });
        } else {
            anchor.pinning = false;
            self.list.set_follow_mode(FollowMode::Tail);
        }
    }

    fn jump_to_latest(&mut self, cx: &mut Context<Self>) {
        if let Some(anchor) = &mut self.anchor {
            anchor.pinning = true;
        }
        self.list.set_follow_mode(FollowMode::Tail);
        self.jump = false;
        cx.notify();
    }

    /// Empties the composer if it still holds the sent text; anything typed
    /// since is kept.
    fn clear_sent_draft(&self, text: String, cx: &mut Context<Self>) {
        let composer = self.composer.clone();
        let window = self.window;
        cx.defer(move |cx| {
            let _ = window.update(cx, |_, window, cx| {
                composer.update(cx, |composer, cx| {
                    if composer.value() == text.as_str() {
                        composer.set_value("", window, cx);
                    }
                })
            });
        });
    }

    fn send(&mut self, cx: &mut Context<Self>) {
        if matches!(
            self.delivery,
            Some(Delivery::Sending | Delivery::Unknown { .. })
        ) || self.subscription.is_none()
        {
            return;
        }
        let text = self.composer.read(cx).value().to_string();
        if text.trim().is_empty() {
            return;
        }
        self.delivery = Some(Delivery::Sending);
        let client = self.client.clone();
        let message_id = uuid::Uuid::new_v4().to_string();
        let input = SubmitInput {
            origin_host_epoch: client.identity.host_epoch.clone(),
            session_id: self.session.clone(),
            message_id: message_id.clone(),
            content: TurnContent {
                text: text.clone(),
                display_text: None,
                attachments: None,
                directory_references: None,
                quotes: None,
                inline_references: None,
            },
            placement: Placement::NextTurn,
            input_selections: Default::default(),
            turn_orchestration: None,
        };
        self.sent = Some(message_id);
        let sending = cx
            .global::<Host>()
            .spawn(async move { client.submit_message(input).await });
        cx.spawn(async move |this, cx| {
            let result = sending.await;
            let _ = this.update(cx, |this, cx| {
                this.delivery = match result {
                    Ok(Ok(SubmitResult::Blocked { message, .. })) => {
                        Some(Delivery::Failed(message.into()))
                    }
                    Ok(Ok(_)) => {
                        this.clear_sent_draft(text, cx);
                        None
                    }
                    Ok(Err(RequestFailure::NotDispatched(error))) => {
                        Some(Delivery::Failed(error.to_string().into()))
                    }
                    Ok(Err(error)) => Some(Delivery::Unknown {
                        error: error.to_string().into(),
                        text,
                    }),
                    Err(error) => Some(Delivery::Unknown {
                        error: error.into(),
                        text,
                    }),
                };
                if matches!(this.delivery, Some(Delivery::Failed(_))) {
                    this.sent = None;
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn stop(&mut self, cx: &mut Context<Self>) {
        let Some(turn) = self.running() else {
            return;
        };
        let input = TurnStopInput {
            session_id: turn.session_id.clone(),
            turn_id: turn.turn_id.clone(),
            run_id: turn.run_id.clone(),
        };
        if self.stopping {
            return;
        }
        self.stopping = true;
        let client = self.client.clone();
        let stopping = cx
            .global::<Host>()
            .spawn(async move { client.stop_turn(input).await });
        cx.spawn(async move |this, cx| {
            let result = stopping.await.and_then(|r| r.map_err(|e| e.to_string()));
            let _ = this.update(cx, |this, cx| {
                if let Err(error) = result {
                    this.stopping = false;
                    this.error = Some(format!("无法停止：{error}").into());
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn answer(
        &mut self,
        pending: InteractionSnapshot,
        answer: InteractionAnswer,
        cx: &mut Context<Self>,
    ) {
        if self.answering.is_some() {
            return;
        }
        self.answering = Some(pending.interaction_id().to_owned());
        self.interaction_error = None;
        let client = self.client.clone();
        let answering = cx
            .global::<Host>()
            .spawn(async move { client.answer_interaction(&pending, answer).await });
        cx.spawn(async move |this, cx| {
            let result = answering.await.and_then(|r| r.map_err(|e| e.to_string()));
            let _ = this.update(cx, |this, cx| {
                this.answering = None;
                if let Err(error) = result {
                    this.interaction_error = Some(error.into());
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn copy_selection(&mut self, _: &CopySelection, _: &mut Window, cx: &mut Context<Self>) {
        if let Some(text) = self.selection.copied() {
            cx.write_to_clipboard(gpui_kit::ClipboardItem::new_string(text));
        }
    }
}
