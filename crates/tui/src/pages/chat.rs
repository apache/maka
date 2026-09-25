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

use crate::{i18n::I18n, navigation::Route};
use maka_client::{
    Client, Error,
    transcript::{LiveText, TranscriptBatch},
};
use maka_protocol::{subscription::*, transcript::*};
use ratatui::{Frame, layout::Rect, widgets::Paragraph};
use serde_json::Value;
use std::collections::{BTreeMap, VecDeque};
pub mod context;
pub mod history;
pub(super) use crate::ui::transcript::layout;
pub mod reading;
use crate::ui::transcript as render;
pub mod presentation;
mod search;
pub mod stopping;
use crate::ui::transcript::streaming;
mod tools;

const WINDOW_ROWS: usize = 256;
const WINDOW_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone)]
pub struct OpenRequest {
    pub session: String,
    pub generation: u64,
    pub range: Option<reading::Window>,
}
pub struct Opened {
    pub snapshot: SubscriptionOpenResult,
    pub batch: TranscriptBatch,
}
#[derive(Clone)]
pub struct PageRequest {
    pub generation: u64,
    pub input: SessionTranscriptPageInput,
    tail: bool,
    automatic: bool,
    fill: bool,
}

#[derive(Default)]
pub struct Chat {
    readings: VecDeque<(String, reading::Saved)>,
    restore_range: Option<reading::Window>,
    pub stop: stopping::Stop,
    pub context: context::Context,
    pub session: Option<String>,
    generation: u64,
    opening: bool,
    requested: bool,
    pub subscription: Option<String>,
    pub snapshot: Option<SessionObservationSnapshot>,
    rows: BTreeMap<u64, Value>,
    live: Vec<(SessionAssistantStreamIdentity, LiveText)>,
    bytes: usize,
    through: Option<u64>,
    wanted: Option<u64>,
    older: Option<(Option<u64>, String)>,
    older_requested: bool,
    fill_blocked: bool,
    newer_requested: bool,
    latest_requested: bool,
    reading_history: bool,
    paging: bool,
    pub error: Option<String>,
    pub removed: bool,
    pub view: render::Transcript,
    pub presentation: presentation::Presentation,
    pub history: Option<Box<history::History>>,
    pub reader_surface: crate::ui::Surface<()>,
    live_revision: u64,
    pub area: Option<Rect>,
    dirty: bool,
    cadence: streaming::Cadence,
}
impl Chat {
    pub fn retire(&mut self) {
        if self.removed {
            return;
        }
        let session = self.session.clone();
        let generation = self.generation + 1;
        self.readings.retain(|(id, _)| Some(id) != session.as_ref());
        *self = Self {
            readings: std::mem::take(&mut self.readings),
            session,
            generation,
            removed: true,
            ..Self::default()
        };
    }
    pub fn reader(&self) -> Option<&render::Transcript> {
        if self.history_scope() {
            self.history.as_ref()?.preview.as_ref()
        } else {
            Some(&self.view)
        }
    }
    pub fn reader_mut(&mut self) -> Option<&mut render::Transcript> {
        if self.history_scope() {
            self.history.as_mut()?.preview.as_mut()
        } else {
            Some(&mut self.view)
        }
    }
    pub fn select(&mut self, route: &Route) -> Option<String> {
        let target = if let Route::Session(id) = route {
            Some(id.clone())
        } else {
            None
        };
        if self.session == target {
            return None;
        }
        let old = self.subscription.take();
        self.save_reading();
        let saved = target
            .as_ref()
            .and_then(|id| self.readings.iter().position(|(key, _)| key == id))
            .and_then(|index| self.readings.remove(index))
            .map(|(_, saved)| saved);
        *self = Self {
            readings: std::mem::take(&mut self.readings),
            restore_range: saved.as_ref().and_then(|saved| saved.range),
            view: saved.map_or_else(Default::default, |saved| {
                render::Transcript::resume(saved.view)
            }),
            session: target,
            generation: self.generation + 1,
            opening: self.opening,
            requested: true,
            ..Self::default()
        };
        old
    }
    pub fn reset(&mut self) {
        self.save_reading();
        *self = Self {
            readings: std::mem::take(&mut self.readings),
            generation: self.generation + 1,
            ..Self::default()
        };
    }
    /// An explicit refresh after a read failure retries from the current tail;
    /// healthy refreshes keep the reading window. Drafts live outside Chat.
    pub fn refresh(&mut self) -> Option<String> {
        if self.error.is_some() {
            self.restore_range = None;
            self.view.latest();
        }
        self.select(&Route::Workspace)
    }
    pub fn open_query(&mut self) -> Option<OpenRequest> {
        if self.opening || !self.requested || self.error.is_some() {
            return None;
        }
        let session = self.session.clone()?;
        self.opening = true;
        self.requested = false;
        Some(OpenRequest {
            session,
            generation: self.generation,
            range: self.restore_range,
        })
    }
    /// Return stale subscription IDs for explicit release, never install them.
    pub fn opened(
        &mut self,
        request: OpenRequest,
        result: Result<Opened, String>,
    ) -> Option<String> {
        self.opening = false;
        if request.generation != self.generation {
            return result.ok().map(|opened| opened.snapshot.subscription_id);
        }
        match result {
            Ok(opened) => {
                let newest = opened
                    .snapshot
                    .transcript
                    .as_ref()
                    .and_then(|bootstrap| bootstrap.durable.through_sequence);
                let id = opened.snapshot.subscription_id;
                self.subscription = Some(id);
                self.snapshot = Some(opened.snapshot.snapshot);
                self.context.refresh();
                self.live = opened
                    .snapshot
                    .active_assistant_streams
                    .into_iter()
                    .map(|id| (id, LiveText::default()))
                    .collect();
                self.older = opened
                    .batch
                    .next_cursor
                    .clone()
                    .map(|cursor| (opened.batch.through_sequence, cursor));
                if let Some(range) = request.range {
                    self.older = range
                        .older
                        .then_some(range.first)
                        .and_then(|first| first.checked_sub(1))
                        .map(|through| (Some(through), String::new()));
                }
                self.through = opened.batch.through_sequence;
                self.wanted = newest;
                self.reading_history = request.range.is_some() && self.through < newest;
                self.restore_range = None;
                if let Err(error) = self.merge(opened.batch, SessionTranscriptPageDirection::Newer)
                {
                    self.error = Some(error.to_string());
                }
            }
            Err(error) => self.error = Some(error),
        }
        None
    }
    pub fn can_older(&self) -> bool {
        self.older.is_some() && !self.paging && self.error.is_none()
    }
    pub fn request_older(&mut self) {
        self.older_requested = self.can_older();
        if self.older_requested {
            self.view.pause();
        }
    }
    pub fn scroll(&mut self, up: bool, amount: usize) {
        self.view.scroll(up, amount);
        if up && self.view.at_top() {
            self.request_older();
        }
    }
    pub fn can_newer(&self) -> bool {
        self.through < self.wanted && !self.paging && self.error.is_none()
    }
    pub fn request_newer(&mut self) {
        self.newer_requested = self.can_newer();
    }
    pub fn latest(&mut self) {
        if self.through < self.wanted {
            self.latest_requested = true;
            self.older_requested = false;
            self.newer_requested = false;
        } else {
            self.view.latest();
        }
    }
    pub fn page_query(&mut self) -> Option<PageRequest> {
        if self.paging || self.error.is_some() {
            return None;
        }
        let subscription_id = self.subscription.clone()?;
        let tail = self.latest_requested;
        // Raw transport bytes can be mostly provider metadata. Fill by visible
        // rows, while retaining the same bounded window and following position.
        let fill = !tail
            && !self.older_requested
            && !self.fill_blocked
            && !self.reading_history
            && self.view.following()
            && self.view.needs_fill()
            && self.can_older();
        let mut automatic = false;
        let (direction, through_sequence, cursor, anchor_sequence) = if tail {
            self.latest_requested = false;
            (
                SessionTranscriptPageDirection::Older,
                self.wanted,
                None,
                None,
            )
        } else if self.older_requested || fill {
            self.older_requested = false;
            let (through, cursor) = self.older.clone()?;
            (
                SessionTranscriptPageDirection::Older,
                through,
                (!cursor.is_empty()).then_some(cursor),
                None,
            )
        } else if self.wanted > self.through
            && (self.newer_requested || !self.reading_history || self.view.following())
        {
            automatic = !self.newer_requested && !self.reading_history;
            if self.reading_history {
                self.view.pause();
            }
            self.newer_requested = false;
            (
                SessionTranscriptPageDirection::Newer,
                self.wanted,
                None,
                self.through,
            )
        } else {
            return None;
        };
        self.paging = true;
        Some(PageRequest {
            tail,
            automatic,
            fill,
            generation: self.generation,
            input: SessionTranscriptPageInput {
                subscription_id,
                direction,
                through_sequence,
                cursor,
                anchor_sequence,
                max_bytes: 64 * 1024,
            },
        })
    }
    pub fn page(&mut self, request: PageRequest, result: Result<TranscriptBatch, String>) {
        if request.generation != self.generation {
            return;
        }
        self.paging = false;
        // A jump to the tail supersedes a slower history read, without replacing
        // the subscription or allowing that old response to move the viewport.
        if self.latest_requested {
            return;
        }
        match result {
            Ok(batch) => {
                if request.fill || (request.automatic && !self.view.following()) {
                    let additions: Vec<_> = batch
                        .rows
                        .iter()
                        .filter(|row| !self.rows.contains_key(&row.sequence))
                        .collect();
                    let extra = additions.iter().try_fold(0, |bytes, row| {
                        serde_json::to_vec(&row.value).map(|row| bytes + row.len())
                    });
                    if self.rows.len() + additions.len() > WINDOW_ROWS
                        || extra.is_ok_and(|extra| self.bytes + extra > WINDOW_BYTES)
                    {
                        if request.fill {
                            // Do not evict the current tail to fill blank space,
                            // or repeatedly fetch a single oversized prior row.
                            self.fill_blocked = true;
                            return;
                        }
                        // Background growth cannot evict the paragraph being read.
                        // Keep this contiguous window and expose newer/tail actions.
                        self.reading_history = true;
                        self.view.new_output();
                        self.dirty = true;
                        return;
                    }
                }
                if request.tail {
                    self.rows.clear();
                    self.bytes = 0;
                    self.view.latest();
                    self.through = batch.through_sequence;
                    self.reading_history = false;
                    self.fill_blocked = false;
                }
                if request.input.direction == SessionTranscriptPageDirection::Older {
                    self.older = batch
                        .next_cursor
                        .clone()
                        .map(|cursor| (batch.through_sequence, cursor));
                } else {
                    // A partial newer range must continue from the last complete row,
                    // not skip to its upper watermark.
                    self.through = if batch.next_cursor.is_none() {
                        batch.through_sequence
                    } else {
                        batch.rows.last().map(|row| row.sequence).or(self.through)
                    };
                }
                if let Err(error) = self.merge(
                    batch,
                    if request.tail {
                        SessionTranscriptPageDirection::Newer
                    } else {
                        request.input.direction
                    },
                ) {
                    self.error = Some(error.to_string());
                }
            }
            Err(error) => self.error = Some(error),
        }
    }
    fn merge(
        &mut self,
        batch: TranscriptBatch,
        direction: SessionTranscriptPageDirection,
    ) -> Result<(), Error> {
        for row in batch.rows {
            if let Some(old) = self.rows.get(&row.sequence) {
                if *old != row.value {
                    return Err("Durable transcript message changed".into());
                }
                continue;
            }
            let bytes = serde_json::to_vec(&row.value)?.len();
            validate_row(&row.value)?;
            let id = row.value["id"].as_str().expect("checked");
            let turn = row.value["turnId"].as_str().expect("checked");
            self.live
                .retain(|(stream, _)| stream.message_id != id || stream.turn_id != turn);
            if self
                .rows
                .last_key_value()
                .is_some_and(|(last, _)| row.sequence > *last)
            {
                self.view.new_output();
            }
            self.bytes += bytes;
            self.context.refresh();
            self.rows.insert(row.sequence, row.value);
        }
        while self.rows.len() > 1 && (self.rows.len() > WINDOW_ROWS || self.bytes > WINDOW_BYTES) {
            let removed = if direction == SessionTranscriptPageDirection::Older {
                let removed = self.rows.pop_last().expect("nonempty window");
                self.through = self.rows.last_key_value().map(|(sequence, _)| *sequence);
                self.reading_history = true;
                removed
            } else {
                let removed = self.rows.pop_first().expect("nonempty window");
                self.older = self
                    .rows
                    .first_key_value()
                    .and_then(|(sequence, _)| sequence.checked_sub(1))
                    .map(|through| (Some(through), String::new()));
                removed
            };
            self.view.discarded(
                removed.1["turnId"].as_str().unwrap(),
                removed.1["id"].as_str().unwrap(),
            );
            self.bytes -= serde_json::to_vec(&removed.1)?.len();
        }
        if self.through >= self.wanted {
            self.reading_history = false;
        }
        self.cadence.flush(); // Durable rows supersede any delayed live preview.
        self.dirty = true;
        Ok(())
    }
    pub fn accept(&mut self, frame: ObservationFrame) -> Result<(), Error> {
        if self.subscription.as_deref() != Some(frame.envelope().subscription_id) {
            return Ok(());
        }
        match frame {
            ObservationFrame::Projection(frame) => {
                let SessionProjectionFrame::SessionProjection { snapshot, .. } = *frame;
                self.snapshot = Some(snapshot);
                self.cadence.flush();
                self.dirty = true;
            }
            ObservationFrame::Transcript(TranscriptAdvancedFrame::TranscriptAdvanced {
                through_sequence,
                ..
            }) => {
                self.wanted = Some(through_sequence);
                self.view.new_output();
            }
            ObservationFrame::Assistant(AssistantObservationFrame::SessionDelta {
                delta, ..
            }) => {
                // A durable row may arrive before a trailing complete delta.
                if self
                    .rows
                    .values()
                    .any(|row| row["id"] == delta.message_id && row["turnId"] == delta.turn_id)
                {
                    return Ok(());
                }
                let index = self.live.iter().position(|(id, _)| {
                    id.message_id == delta.message_id
                        && id.turn_id == delta.turn_id
                        && id.kind == delta.kind
                });
                let index = match index {
                    Some(index) => index,
                    None if self.live.len() < 256 => {
                        self.live.push((
                            SessionAssistantStreamIdentity {
                                kind: delta.kind,
                                turn_id: delta.turn_id.clone(),
                                message_id: delta.message_id.clone(),
                            },
                            LiveText::default(),
                        ));
                        self.live.len() - 1
                    }
                    None => return Err("Too many live assistant streams".into()),
                };
                let total: usize = self.live.iter().map(|(_, stream)| stream.text.len()).sum();
                if total + delta.text.len() > 32 * 1024 * 1024 {
                    return Err("Live text exceeds local capacity".into());
                }
                self.live[index].1.apply(&delta)?;
                if self.live[index].1.complete {
                    self.cadence.flush();
                } else {
                    self.cadence.arrived();
                }
                self.context.refresh_stream();
                self.live_revision += 1;
                self.view.new_output();
                self.dirty = true;
            }
            ObservationFrame::Assistant(AssistantObservationFrame::Closed { reason, .. }) => {
                if reason == SubscriptionClosedReason::SessionRemoved {
                    self.retire();
                } else {
                    self.error = Some(format!("Subscription closed: {reason:?}"));
                    self.subscription = None;
                }
            }
            _ => {}
        }
        Ok(())
    }
    pub fn invalidate_layout(&mut self) {
        self.cadence.flush();
        if let Some(history) = self.history.as_mut() {
            history.invalidate_labels();
        }
        self.view.invalidate_labels();
        self.dirty = true;
    }
    pub fn context_query(&mut self) -> Option<context::Request> {
        if self.error.is_some() || self.snapshot.is_none() {
            return None;
        }
        self.context
            .request(self.session.as_deref()?, self.generation)
    }
    pub fn history_request(&mut self) -> Option<history::Request> {
        if self.error.is_some() || self.snapshot.is_none() {
            return None;
        }
        let context = history::Context {
            generation: self.generation,
            subscription: self.subscription.clone()?,
            through: self.wanted.or(self.through),
        };
        self.sync_history();
        self.history.as_mut()?.request(context)
    }
    pub fn history_completed(
        &mut self,
        request: history::Request,
        result: Result<history::Output, String>,
        i18n: &I18n,
        ascii: bool,
    ) {
        self.sync_history();
        if request.context.generation == self.generation
            && self.subscription.as_ref() == Some(&request.context.subscription)
            && let Some(history) = self.history.as_mut()
        {
            history.complete(request, result, i18n, ascii);
        }
    }
    pub fn context_completed(
        &mut self,
        request: context::Request,
        result: Result<maka_protocol::context::ContextDiagnosticsResult, String>,
    ) {
        if request.generation == self.generation && self.session.as_ref() == Some(&request.session)
        {
            self.context.complete(result);
        }
    }
    pub fn toggle_trace(&mut self) {
        self.view.trace = !self.view.trace;
        if let Some(search) = &mut self.view.search
            && let Some(history) = &mut self.history
        {
            history.changed(search.editor.text(), self.view.trace);
        }
        self.dirty = true;
    }
    pub fn draw(
        &mut self,
        frame: &mut Frame<'_>,
        area: Rect,
        i18n: &I18n,
        ascii: bool,
    ) -> Vec<crate::app::Hit> {
        self.area = Some(area);
        self.reader_surface.invalidate();
        if self.removed {
            frame.render_widget(
                Paragraph::new(i18n.text("session-removed-draft"))
                    .wrap(ratatui::widgets::Wrap { trim: false }),
                area,
            );
            return vec![];
        }
        if self.error.is_some() {
            self.view.invalidate_scrollbar();
            frame.render_widget(Paragraph::new(i18n.text("chat-failed")), area);
            return vec![];
        }
        if self.snapshot.is_none() {
            self.view.invalidate_scrollbar();
            frame.render_widget(Paragraph::new(i18n.text("chat-loading")), area);
            return vec![];
        }
        let active_turn = self
            .snapshot
            .as_ref()
            .and_then(|snapshot| snapshot.root_turn.as_ref())
            .filter(|turn| {
                matches!(
                    turn.state,
                    maka_protocol::turn::TurnState::Created(_)
                        | maka_protocol::turn::TurnState::Admitted(_)
                        | maka_protocol::turn::TurnState::Running(_)
                        | maka_protocol::turn::TurnState::WaitingForUser(_)
                )
            })
            .filter(|_| !self.reading_history)
            .map(|turn| turn.turn_id.clone());
        if self.presentation.active_turn != active_turn {
            self.presentation.active_turn = active_turn;
            self.cadence.flush();
            self.dirty = true;
        }
        // Keep text under the pointer stable until release. Incoming content is
        // still retained in the bounded model and applied on the next draw.
        if self.dirty && !self.view.text_selection.dragging() && self.stream_wait().is_none() {
            self.presentation
                .interactions(&self.snapshot.as_ref().unwrap().interactions);
            self.presentation.sync(
                &mut self.view,
                &self.rows,
                if self.reading_history {
                    &[]
                } else {
                    &self.live
                },
                self.live_revision,
                i18n,
                ascii,
            );
            self.dirty = false;
            self.cadence.rendered(std::time::Instant::now());
        }
        if self.rows.is_empty() && self.live.iter().all(|(_, stream)| stream.text.is_empty()) {
            frame.render_widget(Paragraph::new(i18n.text("chat-empty")), area);
            return vec![];
        }
        let context = crate::ui::Context {
            colors: self.view.colors,
            ascii,
            focused: self.view.focused,
        };
        self.reader_surface.render(
            frame,
            area,
            crate::ui::Node::transcript("transcript", uuid::Uuid::nil()),
            context,
        );
        match self.reader_surface.paint_transcript(
            frame,
            uuid::Uuid::nil(),
            &mut self.view,
            context,
            false,
        ) {
            Ok(hits) => hits
                .into_iter()
                .filter_map(|hit| self.hit(hit, false))
                .collect(),
            Err(error) => {
                self.error = Some(error.into());
                frame.render_widget(Paragraph::new(i18n.text("chat-failed")), area);
                vec![]
            }
        }
    }
    pub fn stream_wait(&self) -> Option<std::time::Duration> {
        self.dirty
            .then(|| self.cadence.wait(std::time::Instant::now()))
            .flatten()
    }
}

fn validate_row(row: &Value) -> Result<(), Error> {
    let record = row.as_object().ok_or("Transcript row is not a message")?;
    if ["id", "turnId", "type"].into_iter().any(|key| {
        record
            .get(key)
            .and_then(Value::as_str)
            .is_none_or(str::is_empty)
    }) {
        return Err("Transcript message identity is missing".into());
    }
    Ok(())
}

pub async fn open(client: &Client, request: &OpenRequest) -> Result<Opened, Error> {
    let snapshot = client
        .open_subscription(SubscriptionOpenInput {
            session_id: request.session.clone(),
            transcript: TranscriptPolicy::Tail { max_bytes: 16_384 },
        })
        .await?;
    let result = if let Some(range) = request.range {
        reading::restore(client, &snapshot.subscription_id, range).await
    } else {
        client
            .complete_transcript_page(
                &snapshot.subscription_id,
                snapshot
                    .transcript
                    .as_ref()
                    .ok_or("Transcript bootstrap missing")?
                    .durable
                    .clone(),
            )
            .await
    };
    match result {
        Ok(batch) => Ok(Opened { snapshot, batch }),
        Err(error) => {
            let _ = client.close_subscription(&snapshot.subscription_id).await;
            Err(error)
        }
    }
}

#[cfg(test)]
impl Chat {
    pub(crate) fn fixture_rows(&mut self, rows: BTreeMap<u64, Value>) {
        self.rows = rows;
        self.dirty = true;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_client::transcript::TranscriptRow;
    use serde_json::json;
    fn batch(start: u64, end: u64, through: u64) -> TranscriptBatch {
        TranscriptBatch { rows: (start..=end).map(|sequence| TranscriptRow { sequence, value: json!({"type":"user","id":format!("m{sequence}"),"turnId":"turn","text":format!("Row {sequence} 中文🦀")}) }).collect(), next_cursor: None, through_sequence: Some(through) }
    }
    #[test]
    fn incoming_content_waits_for_mouse_release_without_losing_the_selection() {
        use crossterm::event::{KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
        use render::selection::CopyMode;
        let mut chat = Chat::default();
        chat.select(&Route::Session("a".into()));
        let request = chat.open_query().unwrap();
        chat.opened(request, Ok(opened()));
        let body = "+literal 中文🦀";
        chat.rows.insert(1, json!({"type":"assistant","id":"m","turnId":"t","text":format!("Awaiting result\n{body}")}));
        chat.dirty = true;
        let i18n = I18n::new(
            crate::LocalePreference::Explicit(crate::Locale::En),
            crate::Locale::En,
        );
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(60, 12)).unwrap();
        let draw = |chat: &mut Chat, terminal: &mut ratatui::Terminal<_>| {
            terminal
                .draw(|frame| {
                    chat.draw(frame, frame.area(), &i18n, false);
                })
                .unwrap();
        };
        draw(&mut chat, &mut terminal);
        let cells = terminal.backend().buffer();
        let row = (0..12)
            .find(|&y| {
                (0..60)
                    .map(|x| cells[(x, y)].symbol())
                    .collect::<String>()
                    .contains("+literal")
            })
            .unwrap();
        let column = (0..60).find(|&x| cells[(x, row)].symbol() == "+").unwrap();
        let event = |kind, column| MouseEvent {
            kind,
            column,
            row,
            modifiers: KeyModifiers::NONE,
        };
        chat.view
            .text_mouse(event(MouseEventKind::Down(MouseButton::Left), column), None);
        chat.rows.clear();
        chat.rows.insert(
            2,
            json!({"type":"assistant","id":"m","turnId":"t","text":body}),
        );
        chat.dirty = true;
        draw(&mut chat, &mut terminal);
        assert!(chat.dirty, "defer the model update while dragging");
        assert!(
            chat.view
                .copy_text(CopyMode::Message, false)
                .unwrap()
                .contains("Awaiting result")
        );
        let end = column + unicode_width::UnicodeWidthStr::width(body) as u16 - 1;
        chat.view
            .text_mouse(event(MouseEventKind::Drag(MouseButton::Left), end), None);
        chat.view
            .text_mouse(event(MouseEventKind::Up(MouseButton::Left), end), None);
        draw(&mut chat, &mut terminal);
        assert!(
            !chat.dirty,
            "release applies the latest content immediately"
        );
        assert_eq!(
            chat.view.copy_text(CopyMode::Selection, false).unwrap(),
            body
        );
        assert_eq!(chat.view.copy_text(CopyMode::Message, false).unwrap(), body);
    }

    #[test]
    fn short_tail_fills_visible_space_and_scroll_loads_history_without_unbounded_prefetch() {
        let mut chat = Chat::default();
        chat.select(&Route::Session("a".into()));
        let request = chat.open_query().unwrap();
        let mut initial = opened();
        initial.batch = batch(20, 20, 20);
        initial.batch.next_cursor = Some("older".into());
        chat.opened(request, Ok(initial));
        let i18n = I18n::new(
            crate::LocalePreference::Explicit(crate::Locale::En),
            crate::Locale::En,
        );
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(60, 12)).unwrap();
        let draw = |chat: &mut Chat, terminal: &mut ratatui::Terminal<_>| {
            terminal
                .draw(|frame| {
                    chat.draw(frame, frame.area(), &i18n, false);
                })
                .unwrap();
        };
        draw(&mut chat, &mut terminal);
        let fill = chat.page_query().unwrap();
        assert!(fill.fill);
        assert!(chat.view.following());
        assert!(chat.page_query().is_none(), "one page in flight");
        let mut older = batch(10, 19, 20);
        older.next_cursor = Some("more".into());
        chat.page(fill, Ok(older));
        draw(&mut chat, &mut terminal);
        assert!(chat.view.following());
        assert!(
            chat.page_query().is_none(),
            "a full viewport stops backfill"
        );
        chat.scroll(true, 100);
        let explicit = chat.page_query().unwrap();
        assert!(!explicit.fill);
        assert!(!chat.view.following());
        chat.page(explicit, Ok(batch(1, 9, 20)));
        draw(&mut chat, &mut terminal);
        assert!(chat.page_query().is_none());
        assert_eq!(chat.rows.first_key_value().unwrap().0, &1);

        // An oversized metadata-heavy prior row must not evict the visible tail
        // or cause an endless automatic fetch loop. Explicit history still works.
        chat.select(&Route::Settings);
        chat.select(&Route::Session("b".into()));
        let request = chat.open_query().unwrap();
        let mut initial = opened();
        initial.batch = batch(20, 20, 20);
        initial.batch.next_cursor = Some("large".into());
        chat.opened(request, Ok(initial));
        draw(&mut chat, &mut terminal);
        let fill = chat.page_query().unwrap();
        let mut large = batch(19, 19, 20);
        large.rows[0].value["providerMetadata"] = json!("x".repeat(WINDOW_BYTES));
        chat.page(fill, Ok(large));
        draw(&mut chat, &mut terminal);
        assert_eq!(chat.rows.len(), 1);
        assert_eq!(chat.rows.first_key_value().unwrap().0, &20);
        assert!(chat.page_query().is_none());
        chat.scroll(true, 1);
        assert!(!chat.page_query().unwrap().fill);
    }
    #[test]
    fn moving_window_restores_reads_and_rejects_old_pages_without_chasing_unread_output() {
        let mut chat = Chat::default();
        chat.select(&Route::Session("a".into()));
        let request = chat.open_query().unwrap();
        chat.opened(request, Ok(opened()));
        chat.through = Some(600);
        chat.wanted = Some(800);
        chat.merge(batch(1, 600, 600), SessionTranscriptPageDirection::Newer)
            .unwrap();
        assert_eq!(chat.rows.len(), WINDOW_ROWS);
        assert_eq!(chat.rows.first_key_value().unwrap().0, &345);
        let i18n = I18n::new(
            crate::LocalePreference::Explicit(crate::Locale::En),
            crate::Locale::En,
        );
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(60, 12)).unwrap();
        terminal
            .draw(|frame| {
                chat.draw(frame, frame.area(), &i18n, false);
            })
            .unwrap();
        chat.view.pause();
        let automatic = chat.page_query().unwrap();
        assert!(automatic.automatic);
        chat.page(automatic, Ok(batch(601, 620, 800)));
        assert_eq!(chat.through, Some(600));
        assert_eq!(chat.rows.first_key_value().unwrap().0, &345);
        assert!(
            chat.reading_history,
            "background output must not evict a paused window"
        );
        assert!(chat.page_query().is_none());
        chat.request_older();
        let old_page = chat.page_query().unwrap();
        let mut earlier = batch(89, 344, 344);
        earlier.next_cursor = Some("older-cursor".into());
        chat.page(old_page.clone(), Ok(earlier));
        terminal
            .draw(|frame| {
                chat.draw(frame, frame.area(), &i18n, false);
            })
            .unwrap();
        assert_eq!(chat.rows.len(), WINDOW_ROWS);
        assert_eq!(chat.through, Some(344));
        assert!(chat.reading_history);
        assert!(
            chat.page_query().is_none(),
            "reading an old window must not auto-download the intervening history"
        );
        assert_eq!(chat.select(&Route::Settings).as_deref(), Some("sub"));
        assert!(chat.rows.is_empty());
        chat.select(&Route::Session("a".into()));
        let current = chat.open_query().unwrap();
        let saved_window = reading::Window {
            first: 89,
            last: 344,
            through: 344,
            older: true,
        };
        assert_eq!(current.range, Some(saved_window));
        let mut restored = opened();
        restored.snapshot.subscription_id = "new-sub".into();
        restored
            .snapshot
            .transcript
            .as_mut()
            .unwrap()
            .durable
            .through_sequence = Some(800);
        restored.batch = batch(89, 344, 344);
        chat.opened(current, Ok(restored));
        chat.page(old_page, Ok(batch(1, 88, 88)));
        assert_eq!(chat.rows.first_key_value().unwrap().0, &89);
        assert!(chat.page_query().is_none());
        chat.request_newer();
        let next = chat.page_query().unwrap();
        assert_eq!(next.input.subscription_id, "new-sub");
        assert_eq!(next.input.anchor_sequence, Some(344));
        let mut next_rows = batch(345, 600, 800);
        next_rows.next_cursor = Some("continue".into());
        chat.page(next, Ok(next_rows));
        assert_eq!(
            chat.through,
            Some(600),
            "partial ranges cannot advance to the advertised watermark"
        );
        chat.request_newer();
        let stale = chat.page_query().unwrap();
        chat.latest();
        chat.page(stale, Ok(batch(601, 610, 800)));
        assert_eq!(chat.through, Some(600));
        let tail = chat.page_query().unwrap();
        assert!(tail.tail);
        chat.page(tail, Ok(batch(790, 800, 800)));
        assert_eq!(chat.rows.len(), 11);
        assert!(chat.view.following());
        assert!(!chat.reading_history);
        chat.merge(TranscriptBatch { rows: vec![TranscriptRow { sequence: 801, value: json!({"type":"user","id":"giant","turnId":"turn","text":"x".repeat(WINDOW_BYTES + 1)}) }], next_cursor: None, through_sequence: Some(801) }, SessionTranscriptPageDirection::Newer).unwrap();
        assert_eq!(
            chat.rows.len(),
            1,
            "one supported large message can exceed the normal window budget, not grow an unbounded history"
        );
        chat.select(&Route::Settings);
        chat.select(&Route::Session("a".into()));
        chat.restore_range = Some(saved_window);
        let request = chat.open_query().unwrap();
        assert_eq!(request.range, Some(saved_window));
        chat.opened(request, Err("saved interval unavailable".into()));
        chat.refresh();
        chat.select(&Route::Session("a".into()));
        assert!(chat.open_query().unwrap().range.is_none());
    }
    fn opened() -> Opened {
        let snapshot = decode_subscription_open_result(&json!({
            "hostEpoch":"epoch","subscriptionId":"sub","nextSequence":1,
            "snapshot":{"schemaVersion":5,"session":{"sessionId":"a","metadataRevision":1,"status":"active","createdAt":0,"isArchived":false},
                "projectionRevision":1,"rootTurn":null,"goal":null,"queue":{"hostEpoch":"epoch","queueRevision":0,"steering":[],"followup":[]},"interactions":{"pending":[]}},
            "activeAssistantStreams":[],"transcript":{"durable":{"kind":"page","sessionId":"a","direction":"older","throughSequence":0,"rawBytes":0,"fragments":[],"endsAtTurnBoundary":true,"nextCursor":null}}
        })).unwrap();
        Opened {
            snapshot,
            batch: TranscriptBatch {
                rows: vec![],
                next_cursor: None,
                through_sequence: Some(0),
            },
        }
    }
    #[test]
    fn reopening_rejects_old_snapshot_and_durable_rows_replace_only_the_matching_live_stream() {
        let mut chat = Chat::default();
        chat.select(&Route::Session("a".into()));
        let stale = chat.open_query().unwrap();
        chat.select(&Route::Session("b".into()));
        chat.select(&Route::Session("a".into()));
        assert!(chat.open_query().is_none());
        assert_eq!(chat.opened(stale, Ok(opened())).as_deref(), Some("sub"));
        assert!(chat.snapshot.is_none());
        let current = chat.open_query().unwrap();
        chat.opened(current, Ok(opened()));
        let delta = decode_observation_frame(&json!({
            "kind":"subscription.session_delta","hostEpoch":"epoch","subscriptionId":"sub","sequence":1,"sessionId":"a",
            "delta":{"kind":"text","turnId":"turn","runId":"run","messageId":"msg","startOffset":0,"text":"中文🦀"}
        })).unwrap();
        chat.accept(delta).unwrap();
        assert_eq!(chat.live[0].1.text, "中文🦀");
        let row = json!({"type":"assistant","id":"msg","turnId":"turn","ts":1,"modelId":"model","text":"中文🦀"});
        chat.merge(
            TranscriptBatch {
                rows: vec![TranscriptRow {
                    sequence: 257,
                    value: row,
                }],
                through_sequence: Some(511),
                next_cursor: None,
            },
            SessionTranscriptPageDirection::Newer,
        )
        .unwrap();
        assert!(chat.live.is_empty());
        assert_eq!(chat.rows.len(), 1);
        // A trailing completion must not bring an already durable overlay back.
        let complete = decode_observation_frame(&json!({
            "kind":"subscription.session_delta","hostEpoch":"epoch","subscriptionId":"sub","sequence":2,"sessionId":"a",
            "delta":{"kind":"text","turnId":"turn","runId":"run","messageId":"msg","startOffset":4,"text":"","complete":true}
        })).unwrap();
        chat.accept(complete).unwrap();
        assert!(chat.live.is_empty());
    }
}
