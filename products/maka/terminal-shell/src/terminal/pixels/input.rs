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

use super::probe::{Capabilities, Protocol, SixelGeometry};
use nsh_gpui_terminal::{FrameToken, SubmittedFrame};
use std::{collections::VecDeque, time::Instant};
use termina::{
    Event, WindowSize,
    event::{KeyCode, KeyEventKind, Modifiers, MouseEventKind},
};

pub(super) struct Input {
    pub event: Event,
    pub geometry: u64,
    pub queued_at: Option<Instant>,
}

#[derive(Clone)]
pub(in crate::terminal) struct Offer {
    pub token: FrameToken,
    pub geometry: u64,
}

pub(super) struct Preparation {
    pub frame: nsh_gpui_terminal::PreparedFrame,
    pub geometry: u64,
    pub pump_started: Option<Instant>,
}

pub(super) struct Candidate {
    pub frame: SubmittedFrame,
    pub geometry: u64,
    /// Present only for the existing opt-in frame trace.
    pub pump_started: Option<Instant>,
}

pub(super) enum WireFrame {
    Kitty(nsh_gpui_terminal::kitty::KittyFrame),
    Inline(nsh_gpui_terminal::inline::InlineFrame),
}

impl WireFrame {
    pub fn token(&self) -> FrameToken {
        match self {
            Self::Kitty(frame) => frame.token(),
            Self::Inline(frame) => frame.token(),
        }
    }
}

pub(super) struct Encoded {
    pub frame: WireFrame,
    pub geometry: u64,
}

pub(super) enum Completion {
    Finished,
    Superseded {
        token: FrameToken,
        replacement: FrameToken,
    },
}

/// GPU submission, readback and codec work keep their slots until completion.
/// Complete snapshots can supersede another completed snapshot before writing.
struct FrameJob {
    geometry: u64,
    work: FrameWork,
}

enum FrameWork {
    Reserved,
    Prepared(Preparation),
    Rendering(FrameToken),
    Submitted(Candidate),
    Encoding(FrameToken),
    Ready(Encoded),
}

impl FrameWork {
    fn token(&self) -> Option<FrameToken> {
        match self {
            Self::Reserved => None,
            Self::Prepared(preparation) => Some(preparation.frame.token()),
            Self::Rendering(token) => Some(token.clone()),
            Self::Submitted(candidate) => Some(candidate.frame.token()),
            Self::Encoding(token) => Some(token.clone()),
            Self::Ready(encoded) => Some(encoded.frame.token()),
        }
    }
}

/// Send-only physical input and output state; native contacts stay on the UI owner.
pub(crate) struct Inbox {
    pub capabilities: Capabilities,
    events: VecDeque<Input>,
    tracing: bool,
    /// Last current-viewport writer receipt; also rejects late older snapshots.
    pub published: Option<FrameToken>,
    frames: VecDeque<FrameJob>,
    frame_capacity: usize,
    /// Last image whose upload was flushed and acknowledged by the terminal.
    pub last_fully_written_image: Option<u32>,
    /// The terminal geometry of the last whole image transaction's flush.
    pub last_fully_written_geometry: Option<u64>,
    /// Sole writer transaction, retained until the native owner consumes its receipt.
    pub(super) in_flight: Option<Offer>,
    pub(super) ready: Option<Offer>,
    pub geometry: u64,
    pub resize: Option<WindowSize>,
    pub cancel_pointer: bool,
    pub wake: Option<std::thread::Thread>,
    pub effects: Option<Vec<u8>>,
    pub(in crate::terminal) text_input: super::text_input::Wire,
    pub(super) cursor: super::cursor::Cursor,
    pub restore_sixel_mode: bool,
    pub(super) kitty: super::kitty::Transfer,
}

impl Inbox {
    pub fn new(capabilities: Capabilities, tracing: bool) -> Self {
        Self {
            kitty: super::kitty::Transfer::default(),
            capabilities,
            events: VecDeque::new(),
            tracing,
            published: None,
            frames: VecDeque::new(),
            // A five-process whole-frame codec scout exceeded 120 encodes/s.
            // Keep that finite candidate width; GUI/writer throughput is separate.
            // Smaller hosts use the same hardware width as the native executor.
            // Capacity gates GPU draws; it never rejects input or application data.
            frame_capacity: std::thread::available_parallelism()
                .map(usize::from)
                .unwrap_or(1)
                .saturating_sub(1)
                .clamp(1, 5),
            last_fully_written_image: None,
            last_fully_written_geometry: None,
            in_flight: None,
            ready: None,
            geometry: 1,
            resize: None,
            cancel_pointer: false,
            wake: None,
            effects: None,
            text_input: super::text_input::Wire::default(),
            cursor: super::cursor::Cursor::default(),
            restore_sixel_mode: false,
        }
    }

    /// Admission is checked before drawing, so the native dirty bit coalesces
    /// changes while these finite readback/codec/result slots are occupied.
    pub(super) fn can_submit(&self) -> bool {
        let protocol = self.capabilities.protocol;
        let capacity = match protocol {
            Some(Protocol::Sixel) => self.frame_capacity,
            // One codec owner and one GPU lookahead/completed-result position.
            Some(Protocol::Kitty) => 2,
            _ => 1,
        };
        if self.resize.is_some()
            || self.capabilities.viewport().is_none()
            || self.frames.len() >= capacity
            || (protocol == Some(Protocol::Iterm2) && self.in_flight.is_some())
            || self.frames.iter().any(|job| {
                matches!(
                    job.work,
                    FrameWork::Reserved | FrameWork::Prepared(_) | FrameWork::Rendering(_)
                )
            })
            || (protocol == Some(Protocol::Kitty)
                && self
                    .frames
                    .iter()
                    .any(|job| matches!(job.work, FrameWork::Submitted(_))))
        {
            return false;
        }
        // The first complete flush establishes opaque replacement eligibility
        // for this geometry. Do not encode a speculative initial parallel burst.
        self.last_fully_written_geometry == Some(self.geometry)
            || (self.in_flight.is_none()
                && !self.frames.iter().any(|job| job.geometry == self.geometry))
    }

    pub(super) fn reserve_frame(&mut self) -> bool {
        if !self.can_submit() {
            return false;
        }
        self.frames.push_back(FrameJob {
            geometry: self.geometry,
            work: FrameWork::Reserved,
        });
        true
    }

    pub(super) fn prepared(&mut self, preparation: Preparation) -> bool {
        let Some(job) = self.frames.iter_mut().find(|job| {
            job.geometry == preparation.geometry && matches!(job.work, FrameWork::Reserved)
        }) else {
            return false;
        };
        job.work = FrameWork::Prepared(preparation);
        true
    }

    pub(super) fn take_preparation(&mut self) -> Option<Preparation> {
        let job = self
            .frames
            .iter_mut()
            .find(|job| matches!(job.work, FrameWork::Prepared(_)))?;
        let token = job.work.token().expect("prepared native frame");
        let FrameWork::Prepared(preparation) =
            std::mem::replace(&mut job.work, FrameWork::Rendering(token))
        else {
            unreachable!()
        };
        Some(preparation)
    }

    pub(super) fn submitted(&mut self, candidate: Candidate) -> bool {
        let token = candidate.frame.token();
        let Some(job) = self.frames.iter_mut().find(|job| {
            job.geometry == candidate.geometry
                && matches!(&job.work, FrameWork::Rendering(active) if active == &token)
        }) else {
            return false;
        };
        job.work = FrameWork::Submitted(candidate);
        true
    }

    pub(super) fn submission_failed(&mut self, token: &FrameToken) {
        self.frames
            .retain(|job| !matches!(&job.work, FrameWork::Rendering(active) if active == token));
    }

    pub(super) fn release_reservation(&mut self) {
        // A pump can produce no draw, or fail before producing a ticket.
        self.frames
            .retain(|job| !matches!(job.work, FrameWork::Reserved));
    }

    pub(super) fn oldest_frame(&self) -> Option<u64> {
        self.frames
            .front()?
            .work
            .token()
            .map(|token| token.sequence())
    }

    pub(super) fn take_candidate(&mut self) -> Option<Candidate> {
        if self.capabilities.protocol == Some(Protocol::Kitty)
            && self
                .frames
                .iter()
                .any(|job| matches!(job.work, FrameWork::Encoding(_)))
        {
            return None;
        }
        let job = self
            .frames
            .iter_mut()
            .find(|job| matches!(job.work, FrameWork::Submitted(_)))?;
        let token = job.work.token().expect("submitted native frame");
        let FrameWork::Submitted(candidate) =
            std::mem::replace(&mut job.work, FrameWork::Encoding(token))
        else {
            unreachable!()
        };
        Some(candidate)
    }

    /// A worker can only finish its own immutable token. Stale and cancelled
    /// jobs release capacity here, after their readback/codec actually returned.
    pub(super) fn finished(&mut self, token: &FrameToken, encoded: Option<Encoded>) -> Completion {
        let Some(index) = self
            .frames
            .iter()
            .position(|job| matches!(&job.work, FrameWork::Encoding(active) if active == token))
        else {
            return Completion::Finished;
        };
        let Some(encoded) = encoded.filter(|encoded| encoded.geometry == self.geometry) else {
            self.frames.remove(index);
            return Completion::Finished;
        };
        if matches!(
            self.capabilities.protocol,
            Some(Protocol::Sixel | Protocol::Kitty)
        ) {
            let replacement = self
                .frames
                .iter()
                .filter_map(|job| match &job.work {
                    FrameWork::Ready(ready) if job.geometry == self.geometry => {
                        Some(ready.frame.token())
                    }
                    _ => None,
                })
                .chain(
                    self.in_flight
                        .iter()
                        .filter(|offer| offer.geometry == self.geometry)
                        .map(|offer| offer.token.clone()),
                )
                .chain(self.published.iter().cloned())
                .filter(|ready| ready.sequence() > token.sequence())
                .max_by_key(FrameToken::sequence);
            if let Some(replacement) = replacement {
                self.frames.remove(index);
                return Completion::Superseded {
                    token: token.clone(),
                    replacement,
                };
            }
            // At most one complete snapshot waits for the sole writer. Active
            // workers remain in their own slots even when a newer draw is ready.
            let previous = self
                .frames
                .iter()
                .position(|job| matches!(job.work, FrameWork::Ready(_)));
            self.frames[index].work = FrameWork::Ready(encoded);
            if let Some(previous) = previous {
                let retired = self.frames.remove(previous).unwrap();
                return Completion::Superseded {
                    token: retired.work.token().unwrap(),
                    replacement: token.clone(),
                };
            }
        } else {
            self.frames[index].work = FrameWork::Ready(encoded);
        }
        Completion::Finished
    }

    /// An idle writer takes the latest independent snapshot. Kitty binds image
    /// slots only after this claim; every handoff waits for the native receipt.
    pub(super) fn take_encoded(&mut self) -> Option<Encoded> {
        if self.in_flight.is_some() {
            return None;
        }
        let index = if matches!(
            self.capabilities.protocol,
            Some(Protocol::Sixel | Protocol::Kitty)
        ) {
            self.frames
                .iter()
                .position(|job| matches!(job.work, FrameWork::Ready(_)))?
        } else {
            self.frames
                .front()
                .filter(|job| matches!(job.work, FrameWork::Ready(_)))?;
            0
        };
        let FrameWork::Ready(encoded) = self.frames.remove(index)?.work else {
            unreachable!()
        };
        self.in_flight = Some(Offer {
            token: encoded.frame.token(),
            geometry: encoded.geometry,
        });
        Some(encoded)
    }

    pub(super) fn presented(&mut self, token: &FrameToken) {
        if self
            .in_flight
            .as_ref()
            .is_some_and(|offer| &offer.token == token)
        {
            self.in_flight = None;
        }
    }

    /// Actual unfinished presentation work, sampled only by the existing trace.
    /// Inspecting it neither cancels a worker nor releases its capacity.
    pub(super) fn pending_frames(&self) -> impl Iterator<Item = Offer> + '_ {
        self.frames
            .iter()
            .filter_map(|job| {
                job.work.token().map(|token| Offer {
                    token,
                    geometry: job.geometry,
                })
            })
            .chain(self.in_flight.iter().cloned())
    }

    pub(in crate::terminal) fn completed_frames(&self) -> impl Iterator<Item = Offer> + '_ {
        self.frames.iter().filter_map(|job| match &job.work {
            FrameWork::Ready(encoded) => Some(Offer {
                token: encoded.frame.token(),
                geometry: encoded.geometry,
            }),
            _ => None,
        })
    }

    pub(in crate::terminal) fn set_ui_scale(&mut self, scale: f32) -> Result<(), String> {
        if !scale.is_finite() || scale <= 0.0 {
            return Err("interface scale must be a finite positive number".into());
        }
        let capabilities = Capabilities {
            ui_scale: scale,
            ..self.capabilities
        };
        let density = capabilities.scale_factor();
        if !density.is_finite()
            || density <= 0.0
            || capabilities.logical_viewport().is_some_and(|viewport| {
                !f32::from(viewport.width).is_finite()
                    || f32::from(viewport.width) <= 0.0
                    || !f32::from(viewport.height).is_finite()
                    || f32::from(viewport.height) <= 0.0
            })
        {
            return Err("interface scale exceeds the renderer's numeric range".into());
        }
        if self.capabilities.ui_scale != scale {
            self.capabilities = capabilities;
            self.invalidate_geometry()?;
        }
        Ok(())
    }

    pub fn push(&mut self, event: Event) -> Result<bool, String> {
        self.kitty.observe(&event, Instant::now())?;
        if self.text_input.consume(&event) {
            return Ok(false);
        }
        if let Event::Key(key) = &event
            && key.kind != KeyEventKind::Release
            && key.modifiers.contains(Modifiers::CONTROL)
            && key.code == KeyCode::Char('q')
        {
            return Ok(true);
        }
        if let Event::WindowResized(size) = event {
            self.capabilities.size = size;
            self.invalidate_geometry()?;
            return Ok(false);
        }
        if !matches!(
            &event,
            Event::Osc(termina::escape::osc::Osc::NshTextInput(_))
        ) && matches!(
            event,
            Event::Csi(_)
                | Event::Osc(_)
                | Event::Dcs(_)
                | Event::Iterm2Capabilities(_)
                | Event::KittyGraphicsResponse(_)
        ) {
            return Ok(false);
        }
        if matches!(event, Event::MouseLeave | Event::FocusOut) {
            self.lose_pointer();
        }
        let mouse = match &event {
            Event::SgrMouse(mouse) => Some(mouse.kind),
            Event::Mouse(mouse) => Some(mouse.kind),
            _ => None,
        };
        if let Some(kind) = mouse
            && !super::mapping::mouse_position(&event, self.capabilities)
                .is_some_and(|position| self.capabilities.contains(position))
        {
            match kind {
                MouseEventKind::Down(_)
                | MouseEventKind::ScrollUp
                | MouseEventKind::ScrollDown
                | MouseEventKind::ScrollLeft
                | MouseEventKind::ScrollRight => return Ok(false),
                MouseEventKind::Moved => {
                    // Leaving the native canvas ends the current contact just
                    // like a physical leave, independently of output progress.
                    self.lose_pointer();
                    return Ok(false);
                }
                MouseEventKind::Drag(_) | MouseEventKind::Up(_) => {}
            }
        }
        if matches!(event, Event::MouseLeave) {
            return Ok(false);
        }
        let input = Input {
            event,
            geometry: self.geometry,
            queued_at: self.tracing.then(Instant::now),
        };
        if let Some(previous) = self.events.back_mut()
            && previous.geometry == input.geometry
            && match (&previous.event, &input.event) {
                (Event::SgrMouse(old), Event::SgrMouse(new)) => {
                    old.kind == MouseEventKind::Moved
                        && new.kind == MouseEventKind::Moved
                        && old.modifiers == new.modifiers
                }
                (Event::Mouse(old), Event::Mouse(new)) => {
                    old.kind == MouseEventKind::Moved
                        && new.kind == MouseEventKind::Moved
                        && old.modifiers == new.modifiers
                }
                _ => false,
            }
        {
            *previous = input;
        } else {
            self.events.push_back(input);
        }
        Ok(false)
    }

    pub fn set_sixel_geometry(&mut self, geometry: SixelGeometry) -> Result<(), String> {
        if self.capabilities.sixel_geometry == geometry {
            return Ok(());
        }
        let viewport = self.capabilities.viewport();
        self.capabilities.sixel_geometry = geometry;
        if viewport != self.capabilities.viewport() {
            self.invalidate_geometry()?;
        }
        Ok(())
    }

    /// Records a complete writer receipt, independently of whether resize has
    /// changed this frame's viewport. Only the native worker can publish.
    pub(super) fn written(&mut self, offer: Offer, image: Option<u32>) {
        self.last_fully_written_geometry = Some(offer.geometry);
        if let Some(image) = image {
            self.last_fully_written_image = Some(image);
        }
        self.ready = Some(offer);
        if let Some(wake) = &self.wake {
            wake.unpark();
        }
    }

    fn invalidate_geometry(&mut self) -> Result<(), String> {
        self.geometry = self
            .geometry
            .checked_add(1)
            .ok_or("terminal geometry generation exhausted")?;
        self.resize = Some(self.capabilities.size);
        self.published = None;
        self.cursor = super::cursor::Cursor::default();
        // A submitted readback or codec still consumes its original slot.
        // Completed stale wire is safe to retire immediately.
        self.frames
            .retain(|job| !matches!(job.work, FrameWork::Ready(_)));
        self.lose_pointer();
        Ok(())
    }

    fn lose_pointer(&mut self) {
        self.cancel_pointer = true;
        self.events.retain(|input| !pointer(&input.event));
    }

    pub(super) fn has_pending_input(&self) -> bool {
        !self.events.is_empty() && self.resize.is_none()
    }

    pub(super) fn pop(&mut self) -> Option<Input> {
        if !self.has_pending_input() {
            return None;
        }
        self.events.pop_front()
    }

    pub(super) fn queue_len(&self) -> usize {
        self.events.len()
    }

    pub(in crate::terminal) fn close_text_input(&mut self) -> Option<Vec<u8>> {
        let bytes = self.text_input.begin_close()?;
        self.events.clear();
        Some(bytes)
    }

    pub fn into_startup(self) -> (Vec<Event>, Option<WindowSize>) {
        (
            self.events.into_iter().map(|input| input.event).collect(),
            self.resize,
        )
    }
}

/// Classification only: diagnostics retain no typed characters or pasted text.
pub(super) fn trace_kind(event: &Event) -> &'static str {
    let mouse = match event {
        Event::SgrMouse(mouse) => Some(mouse.kind),
        Event::Mouse(mouse) => Some(mouse.kind),
        _ => None,
    };
    if let Some(kind) = mouse {
        return match kind {
            MouseEventKind::Down(_) => "mouse_down",
            MouseEventKind::Up(_) => "mouse_up",
            MouseEventKind::Drag(_) => "mouse_drag",
            MouseEventKind::Moved => "mouse_move",
            MouseEventKind::ScrollUp => "wheel_up",
            MouseEventKind::ScrollDown => "wheel_down",
            MouseEventKind::ScrollLeft => "wheel_left",
            MouseEventKind::ScrollRight => "wheel_right",
        };
    }
    match event {
        Event::Key(key) => match key.kind {
            KeyEventKind::Press => "key_press",
            KeyEventKind::Repeat => "key_repeat",
            KeyEventKind::Release => "key_release",
        },
        Event::Paste(_) => "paste",
        Event::FocusIn => "focus_in",
        Event::FocusOut => "focus_out",
        _ => "other",
    }
}

pub(super) fn pointer(event: &Event) -> bool {
    matches!(
        event,
        Event::SgrMouse(_) | Event::Mouse(_) | Event::MouseLeave
    )
}

pub(super) fn released(event: &Event) -> bool {
    match event {
        Event::SgrMouse(mouse) => matches!(mouse.kind, MouseEventKind::Up(_)),
        Event::Mouse(mouse) => matches!(mouse.kind, MouseEventKind::Up(_)),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::num::NonZeroU32;
    use termina::event::KeyEvent;

    fn maximum(width: u32, height: u32) -> SixelGeometry {
        SixelGeometry::Finite {
            width: NonZeroU32::new(width).unwrap(),
            height: NonZeroU32::new(height).unwrap(),
        }
    }

    fn capabilities() -> Capabilities {
        Capabilities {
            size: WindowSize {
                cols: 120,
                rows: 40,
                pixel_width: Some(1200),
                pixel_height: Some(800),
            },
            mouse: super::super::probe::MouseCoordinates::Cells,
            protocol: Some(super::super::probe::Protocol::Sixel),
            synchronized: false,
            sixel_geometry: SixelGeometry::Unknown,
            ui_scale: 1.0,
        }
    }

    fn encoded(geometry: u64) -> Encoded {
        Encoded {
            frame: WireFrame::Inline(Default::default()),
            geometry,
        }
    }

    #[test]
    fn iterm2_waits_for_the_predecessor_and_native_writer_receipt() {
        {
            let mut caps = capabilities();
            caps.protocol = Some(Protocol::Iterm2);
            let mut inbox = Inbox::new(caps, false);
            let token = FrameToken::default();
            inbox.frames.push_back(FrameJob {
                geometry: 1,
                work: FrameWork::Encoding(token.clone()),
            });
            inbox.frames.push_back(FrameJob {
                geometry: 1,
                work: FrameWork::Ready(encoded(1)),
            });
            assert!(
                inbox.take_encoded().is_none(),
                "the completed tail cannot pass the head"
            );
            assert_eq!(inbox.frames.len(), 2);
            inbox.finished(&token, Some(encoded(1)));
            let first = inbox.take_encoded().unwrap();
            assert_eq!(inbox.frames.len(), 1);
            assert!(inbox.take_encoded().is_none());
            inbox.written(
                Offer {
                    token: first.frame.token(),
                    geometry: 1,
                },
                None,
            );
            assert!(
                inbox.take_encoded().is_none(),
                "a flush cannot overwrite an unconsumed receipt"
            );
            let receipt = inbox.ready.take().unwrap();
            inbox.presented(&receipt.token);
            assert!(inbox.take_encoded().is_some());
            assert!(inbox.frames.is_empty());
        }
    }

    // Use authentic, ordered native tokens without widening FrameToken's API.
    // Only completion order is controlled below; no scheduler API is replaced.
    fn native_frames(count: usize) -> Vec<nsh_gpui_terminal::CandidateFrame> {
        use gpui::{
            AppContext, Application, Bounds, Context, IntoElement, Render, Styled, Window,
            WindowBounds, WindowOptions, div, point, px, rgb, size,
        };
        use std::{cell::RefCell, rc::Rc, sync::Arc};

        struct Solid;
        impl Render for Solid {
            fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
                div().size_full().bg(rgb(0xff0000))
            }
        }
        let frames = Rc::new(RefCell::new(Vec::new()));
        let received = frames.clone();
        let platform = nsh_gpui_terminal::TerminalPlatform::new(
            Box::new(gpui_wgpu::WgpuHeadlessRenderer::new().unwrap()),
            Box::new(move |frame| received.borrow_mut().push(frame.submit().unwrap())),
            Arc::new(|| {}),
        )
        .unwrap();
        let window = Rc::new(RefCell::new(None));
        let created = window.clone();
        let application = Application::with_platform(platform.clone()).run_embedded(move |cx| {
            *created.borrow_mut() = Some(
                cx.open_window(
                    WindowOptions {
                        window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                            point(px(0.0), px(0.0)),
                            size(px(32.0), px(12.0)),
                        ))),
                        inactive_frame_interval: None,
                        ..Default::default()
                    },
                    |_, cx| cx.new(|_| Solid),
                )
                .unwrap(),
            );
        });
        let mut completed = Vec::new();
        for _ in 0..count {
            application.update(|cx| {
                window
                    .borrow()
                    .as_ref()
                    .unwrap()
                    .update(cx, |_, window, _| window.refresh())
                    .unwrap();
            });
            assert!(platform.pump());
            let frame = frames.borrow_mut().remove(0).complete().unwrap();
            assert_eq!(&frame.pixels()[..4], &[255, 0, 0, 255]);
            assert!(frames.borrow().is_empty());
            completed.push(frame);
        }
        assert!(
            completed
                .windows(2)
                .all(|pair| pair[0].token().sequence() < pair[1].token().sequence())
        );
        drop(application);
        platform.shutdown();
        completed
    }

    fn native_encoded(frame: &nsh_gpui_terminal::CandidateFrame, geometry: u64) -> Encoded {
        use nsh_gpui_terminal::inline::{InlineFrame, InlineProtocol};
        Encoded {
            frame: WireFrame::Inline(
                InlineFrame::encode(frame, InlineProtocol::Sixel, 4, 2, false, true).unwrap(),
            ),
            geometry,
        }
    }

    fn encoding(inbox: &mut Inbox, frame: &nsh_gpui_terminal::CandidateFrame) {
        assert!(inbox.reserve_frame());
        inbox.frames.back_mut().unwrap().work = FrameWork::Encoding(frame.token());
    }

    fn consume_flush(inbox: &mut Inbox, encoded: &Encoded) {
        let token = encoded.frame.token();
        inbox.written(
            Offer {
                token: token.clone(),
                geometry: encoded.geometry,
            },
            None,
        );
        assert!(
            inbox.take_encoded().is_none(),
            "native consumption owns the writer receipt"
        );
        let receipt = inbox.ready.take().unwrap();
        assert_eq!(receipt.token, token);
        inbox.published = Some(token);
        inbox.presented(&receipt.token);
    }

    #[test]
    fn sixel_latest_ready_bypasses_slow_work_and_never_publishes_an_unwritten_frame() {
        let frames = native_frames(3);
        let mut inbox = Inbox::new(capabilities(), false);
        inbox.frame_capacity = 5;
        inbox.last_fully_written_geometry = Some(1);
        for frame in &frames {
            encoding(&mut inbox, frame);
        }
        inbox.finished(&frames[1].token(), Some(native_encoded(&frames[1], 1)));
        let current = inbox
            .take_encoded()
            .expect("a complete scene must pass an older active codec");
        assert_eq!(current.frame.token(), frames[1].token());
        assert!(inbox.published.is_none());
        assert_eq!(
            inbox.frames.len(),
            2,
            "active workers keep their original capacity"
        );

        inbox.finished(&frames[0].token(), Some(native_encoded(&frames[0], 1)));
        assert_eq!(
            inbox.frames.len(),
            1,
            "late older completion cannot become another transaction"
        );
        assert!(inbox.take_encoded().is_none());
        consume_flush(&mut inbox, &current);
        assert_eq!(inbox.published, Some(frames[1].token()));

        inbox.finished(&frames[2].token(), Some(native_encoded(&frames[2], 1)));
        let final_scene = inbox
            .take_encoded()
            .expect("a final quiet scene must remain visible");
        assert_eq!(final_scene.frame.token(), frames[2].token());
        consume_flush(&mut inbox, &final_scene);
        assert_eq!(inbox.published, Some(frames[2].token()));
        assert!(inbox.frames.is_empty());
        assert!(inbox.in_flight.is_none());
    }

    #[test]
    fn sixel_latest_ready_coalesces_behind_a_blocked_writer_without_starving_updates() {
        let frames = native_frames(5);
        let mut inbox = Inbox::new(capabilities(), false);
        inbox.frame_capacity = 5;
        inbox.last_fully_written_geometry = Some(1);
        for frame in &frames {
            encoding(&mut inbox, frame);
        }
        inbox.finished(&frames[0].token(), Some(native_encoded(&frames[0], 1)));
        let writing = inbox.take_encoded().unwrap();
        for frame in &frames[1..] {
            inbox.finished(&frame.token(), Some(native_encoded(frame, 1)));
            assert!(
                inbox.take_encoded().is_none(),
                "a writing transaction is indivisible"
            );
            assert_eq!(
                inbox
                    .frames
                    .iter()
                    .filter(|job| matches!(job.work, FrameWork::Ready(_)))
                    .count(),
                1,
                "only the newest completed scene waits behind the writer"
            );
        }
        assert_eq!(inbox.frames.len(), 1);
        assert!(inbox.published.is_none());
        consume_flush(&mut inbox, &writing);
        let latest = inbox.take_encoded().unwrap();
        assert_eq!(latest.frame.token(), frames[4].token());
        consume_flush(&mut inbox, &latest);

        // An idle writer must start each ready scene even if a still newer
        // codec has not finished. New arrivals cannot postpone that handoff.
        let mut inbox = Inbox::new(capabilities(), false);
        inbox.frame_capacity = 5;
        inbox.last_fully_written_geometry = Some(1);
        for frame in &frames {
            encoding(&mut inbox, frame);
        }
        for frame in &frames {
            inbox.finished(&frame.token(), Some(native_encoded(frame, 1)));
            let next = inbox
                .take_encoded()
                .expect("continuous updates cannot starve a ready scene");
            assert_eq!(next.frame.token(), frame.token());
            consume_flush(&mut inbox, &next);
        }
        assert_eq!(inbox.published, Some(frames[4].token()));
        assert!(inbox.frames.is_empty());
    }

    #[test]
    fn sixel_latest_ready_rejects_late_work_after_publication_and_resize() {
        let frames = native_frames(3);
        let mut inbox = Inbox::new(capabilities(), false);
        inbox.frame_capacity = 5;
        inbox.last_fully_written_geometry = Some(1);
        encoding(&mut inbox, &frames[0]);
        encoding(&mut inbox, &frames[1]);
        inbox.finished(&frames[1].token(), Some(native_encoded(&frames[1], 1)));
        let current = inbox.take_encoded().unwrap();
        consume_flush(&mut inbox, &current);
        inbox.finished(&frames[0].token(), Some(native_encoded(&frames[0], 1)));
        assert!(
            inbox.frames.is_empty(),
            "late work cannot roll back an already visible scene"
        );
        assert!(inbox.take_encoded().is_none());
        assert_eq!(inbox.published, Some(frames[1].token()));

        encoding(&mut inbox, &frames[2]);
        inbox
            .push(Event::WindowResized(capabilities().size))
            .unwrap();
        inbox.resize.take();
        assert_eq!(
            inbox.frames.len(),
            1,
            "the unfinished old task retains its original slot"
        );
        assert!(
            inbox.can_submit(),
            "spare capacity can admit the new geometry's first frame"
        );
        inbox.finished(&frames[2].token(), Some(native_encoded(&frames[2], 1)));
        assert!(inbox.frames.is_empty());
        assert!(inbox.published.is_none());
        assert!(inbox.can_submit());
        assert!(inbox.reserve_frame());
        assert!(
            !inbox.can_submit(),
            "new geometry must first complete a clean whole flush"
        );
        inbox.release_reservation();
        assert!(inbox.frames.is_empty());
        assert!(inbox.ready.is_none());

        let mut inbox = Inbox::new(capabilities(), false);
        inbox.frame_capacity = 5;
        inbox.last_fully_written_geometry = Some(1);
        encoding(&mut inbox, &frames[0]);
        encoding(&mut inbox, &frames[2]);
        inbox.finished(&frames[2].token(), Some(native_encoded(&frames[2], 1)));
        inbox.finished(&frames[0].token(), None);
        assert_eq!(
            inbox.frames.len(),
            1,
            "failure/cancel releases only the finished worker's slot"
        );
        assert!(
            inbox.ready.is_none(),
            "a failed worker cannot manufacture a flush receipt"
        );
        let surviving = inbox.take_encoded().unwrap();
        assert_eq!(surviving.frame.token(), frames[2].token());
        consume_flush(&mut inbox, &surviving);
        assert_eq!(inbox.published, Some(frames[2].token()));
    }

    #[test]
    fn sixel_latest_ready_keeps_a_newer_pending_scene_when_older_work_finishes_last() {
        let frames = native_frames(3);
        let mut inbox = Inbox::new(capabilities(), false);
        inbox.frame_capacity = 5;
        inbox.last_fully_written_geometry = Some(1);
        for frame in &frames {
            encoding(&mut inbox, frame);
        }
        inbox.finished(&frames[0].token(), Some(native_encoded(&frames[0], 1)));
        let writing = inbox.take_encoded().unwrap();
        assert_eq!(writing.frame.token(), frames[0].token());

        // A is writing while C completes before B. The newest scene is C,
        // regardless of which codec finishes last.
        inbox.finished(&frames[2].token(), Some(native_encoded(&frames[2], 1)));
        assert_eq!(
            inbox.frames.len(),
            2,
            "the unfinished older worker retains its original slot"
        );
        assert!(inbox.take_encoded().is_none());
        inbox.finished(&frames[1].token(), Some(native_encoded(&frames[1], 1)));
        assert_eq!(
            inbox.frames.len(),
            1,
            "an older completion cannot replace the newer pending scene"
        );
        assert!(inbox.take_encoded().is_none());
        assert!(inbox.published.is_none());

        consume_flush(&mut inbox, &writing);
        let latest = inbox.take_encoded().unwrap();
        assert_eq!(latest.frame.token(), frames[2].token());
        consume_flush(&mut inbox, &latest);
        assert_eq!(inbox.published, Some(frames[2].token()));
        assert!(inbox.frames.is_empty());
        assert!(inbox.in_flight.is_none());
    }

    #[test]
    fn font_zoom_with_the_same_physical_canvas_revokes_old_input_geometry() {
        let mut inbox = Inbox::new(capabilities(), false);
        let original = inbox.capabilities;
        let old = FrameToken::default();
        inbox.published = Some(old);
        let mut zoomed = original.size;
        zoomed.cols /= 2;
        zoomed.rows /= 2;
        inbox.push(Event::WindowResized(zoomed)).unwrap();
        assert_eq!(inbox.geometry, 2);
        assert!(inbox.published.is_none());
        assert!(inbox.cancel_pointer);
        assert_eq!(inbox.capabilities.viewport(), original.viewport());
        assert_eq!(
            inbox.capabilities.scale_factor(),
            2.0 * original.scale_factor()
        );
        assert_eq!(
            inbox.capabilities.logical_viewport().unwrap(),
            original.logical_viewport().unwrap() / 2.0
        );

        // A saved 125% UI zoom composes with the terminal's own font density.
        // The same physical target now has a 384 by 256 logical viewport.
        inbox.published = Some(FrameToken::default());
        inbox.set_ui_scale(1.25).unwrap();
        assert_eq!(inbox.geometry, 3);
        assert!(inbox.published.is_none());
        assert_eq!(inbox.capabilities.viewport(), original.viewport());
        assert_eq!(inbox.capabilities.scale_factor(), 3.125);
        assert_eq!(
            inbox.capabilities.logical_viewport().unwrap(),
            gpui::size(gpui::px(384.0), gpui::px(256.0))
        );
        inbox.set_ui_scale(1.0).unwrap();
        assert_eq!(inbox.geometry, 4);
        assert_eq!(inbox.capabilities.scale_factor(), 2.5);
    }

    #[test]
    fn stale_ready_wire_retires_but_failure_and_cancel_return_only_the_finished_slot() {
        let mut inbox = Inbox::new(capabilities(), false);
        let token = FrameToken::default();
        inbox.frames.push_back(FrameJob {
            geometry: 1,
            work: FrameWork::Ready(encoded(1)),
        });
        inbox.frames.push_back(FrameJob {
            geometry: 1,
            work: FrameWork::Encoding(token.clone()),
        });
        inbox
            .push(Event::WindowResized(capabilities().size))
            .unwrap();
        assert_eq!(
            inbox.frames.len(),
            1,
            "only already completed wire is disposable"
        );
        inbox.finished(&token, None);
        assert!(inbox.frames.is_empty());
        assert!(inbox.take_encoded().is_none());
        assert!(inbox.in_flight.is_none());
        assert!(
            inbox.ready.is_none(),
            "failure/cancel cannot manufacture a writer receipt"
        );
    }

    #[test]
    fn late_sixel_maxima_resize_the_same_canvas_without_changing_terminal_units() {
        let mut inbox = Inbox::new(capabilities(), false);
        assert_eq!(inbox.last_fully_written_geometry, None);
        let token = FrameToken::default();
        inbox.published = Some(token.clone());
        let draft = Event::Paste("unfinished 你好 draft".into());
        inbox.push(draft.clone()).unwrap();
        inbox.set_sixel_geometry(maximum(1000, 1000)).unwrap();
        assert_eq!(inbox.geometry, 2);
        assert_eq!(inbox.resize, Some(capabilities().size));
        assert_eq!(inbox.capabilities.size.pixel_width, Some(1200));
        assert_eq!(inbox.capabilities.size.pixel_height, Some(800));
        assert_eq!(
            inbox.capabilities.viewport(),
            Some(gpui::size(
                gpui::DevicePixels(1000),
                gpui::DevicePixels(800)
            ))
        );
        assert!(inbox.published.is_none());
        assert!(inbox.cancel_pointer);
        // Coordinates wait for the native owner to apply resize, while the
        // complete draft remains queued independently of output receipts.
        assert!(inbox.pop().is_none());
        inbox.resize = None;
        assert_eq!(inbox.pop().unwrap().event, draft);

        // The already-started old viewport transaction must finish physically;
        // its receipt records the old output geometry only.
        inbox.written(
            Offer {
                token: token.clone(),
                geometry: 1,
            },
            Some(41),
        );
        assert_eq!(inbox.last_fully_written_image, Some(41));
        assert_eq!(inbox.last_fully_written_geometry, Some(1));
        assert_eq!(inbox.ready.as_ref().unwrap().geometry, 1);
        assert!(inbox.published.is_none());

        // A new fact that does not change this canvas must not cancel a contact.
        inbox.resize = None;
        inbox.cancel_pointer = false;
        inbox.published = Some(token.clone());
        inbox.set_sixel_geometry(maximum(1000, 1200)).unwrap();
        assert_eq!(inbox.geometry, 2);
        assert_eq!(inbox.published, Some(token.clone()));
        assert!(!inbox.cancel_pointer);

        // Actual terminal resize always revokes old coordinates, even if the
        // effective canvas happens to stay unchanged.
        let mut size = capabilities().size;
        size.cols = 140;
        size.pixel_width = Some(1400);
        inbox.push(Event::WindowResized(size)).unwrap();
        assert_eq!(inbox.geometry, 3);
        assert!(inbox.published.is_none());
        assert!(inbox.cancel_pointer);
        assert_eq!(inbox.capabilities.size.pixel_width, Some(1400));
        assert_eq!(
            inbox.capabilities.viewport(),
            Some(gpui::size(
                gpui::DevicePixels(1000),
                gpui::DevicePixels(800)
            ))
        );
        size.cols = 80;
        size.pixel_width = Some(800);
        size.pixel_height = Some(600);
        inbox.push(Event::WindowResized(size)).unwrap();
        assert_eq!(inbox.geometry, 4);
        assert_eq!(inbox.last_fully_written_geometry, Some(1));
        assert_eq!(
            inbox.capabilities.viewport(),
            Some(gpui::size(gpui::DevicePixels(800), gpui::DevicePixels(600)))
        );
    }

    #[test]
    fn resizing_back_to_the_same_pixels_does_not_reuse_an_old_write() {
        let mut inbox = Inbox::new(capabilities(), false);
        let token = FrameToken::default();
        inbox.written(
            Offer {
                token: token.clone(),
                geometry: 1,
            },
            None,
        );
        assert_eq!(inbox.last_fully_written_geometry, Some(1));

        let mut size = capabilities().size;
        size.cols = 80;
        size.pixel_width = Some(800);
        inbox.push(Event::WindowResized(size)).unwrap();
        inbox
            .push(Event::WindowResized(capabilities().size))
            .unwrap();
        assert_eq!(inbox.geometry, 3);
        assert_eq!(inbox.last_fully_written_geometry, Some(1));
        // An old viewport can finish after resize without certifying the new one.
        inbox.written(
            Offer {
                token: token.clone(),
                geometry: 1,
            },
            None,
        );
        assert_eq!(inbox.last_fully_written_geometry, Some(1));
        inbox.written(Offer { token, geometry: 3 }, None);
        assert_eq!(inbox.last_fully_written_geometry, Some(3));
    }

    #[test]
    fn letterbox_presses_and_wheels_do_not_capture_and_hover_leaves_without_a_frame() {
        let mut caps = capabilities();
        caps.sixel_geometry = maximum(1000, 600);
        let mut inbox = Inbox::new(caps, false);
        let pointer = |kind, x, y| {
            Event::SgrMouse(termina::event::SgrMouseEvent {
                kind,
                x,
                y,
                modifiers: Modifiers::NONE,
            })
        };
        // Real cells remain 10x20 pixels. The right/bottom margins begin at
        // cell 101/31, independently of the smaller native canvas dimensions.
        for (x, y) in [(101, 1), (1, 31), (0, 1)] {
            inbox
                .push(pointer(
                    MouseEventKind::Down(termina::event::MouseButton::Left),
                    x,
                    y,
                ))
                .unwrap();
            inbox
                .push(pointer(MouseEventKind::ScrollDown, x, y))
                .unwrap();
            assert_eq!(inbox.queue_len(), 0);
            assert!(!inbox.cancel_pointer);
            inbox.push(pointer(MouseEventKind::Moved, x, y)).unwrap();
            assert!(inbox.cancel_pointer);
            inbox.cancel_pointer = false;
        }
        // The adjacent visible cell reaches the native FIFO even before any
        // output frame is published.
        inbox
            .push(pointer(
                MouseEventKind::Down(termina::event::MouseButton::Left),
                100,
                30,
            ))
            .unwrap();
        assert_eq!(inbox.queue_len(), 1);
        assert!(inbox.pop().is_some());
    }

    #[test]
    fn hover_keeps_the_latest_position_and_ordered_input_survives_output_and_resize() {
        let mut inbox = Inbox::new(capabilities(), false);
        inbox.in_flight = Some(Offer {
            token: FrameToken::default(),
            geometry: 1,
        });
        let pointer = |kind, x, y| {
            Event::SgrMouse(termina::event::SgrMouseEvent {
                kind,
                x,
                y,
                modifiers: Modifiers::NONE,
            })
        };
        let down = pointer(
            MouseEventKind::Down(termina::event::MouseButton::Left),
            4,
            5,
        );
        let wheel = pointer(MouseEventKind::ScrollDown, 4, 5);
        let up = pointer(MouseEventKind::Up(termina::event::MouseButton::Left), 4, 5);
        let events = [
            pointer(MouseEventKind::Moved, 3, 4),
            pointer(MouseEventKind::Moved, 4, 5),
            down,
            pointer(
                MouseEventKind::Drag(termina::event::MouseButton::Left),
                5,
                6,
            ),
            pointer(
                MouseEventKind::Drag(termina::event::MouseButton::Left),
                6,
                7,
            ),
            wheel,
            up,
            pointer(MouseEventKind::Moved, 6, 7),
            Event::Key(KeyEvent::new(KeyCode::Char('a'), Modifiers::NONE)),
            pointer(MouseEventKind::Moved, 3, 4),
            Event::SgrMouse(termina::event::SgrMouseEvent {
                kind: MouseEventKind::Moved,
                x: 4,
                y: 5,
                modifiers: Modifiers::SHIFT,
            }),
            Event::Paste("complete draft".into()),
            pointer(MouseEventKind::Moved, 4, 5),
        ];
        for event in &events {
            inbox.push(event.clone()).unwrap();
        }
        for event in &events[1..] {
            assert_eq!(&inbox.pop().unwrap().event, event);
        }
        assert!(inbox.pop().is_none());
        assert!(inbox.in_flight.is_some());
        assert!(inbox.published.is_none());

        let old = pointer(
            MouseEventKind::Down(termina::event::MouseButton::Left),
            4,
            5,
        );
        inbox.push(old).unwrap();
        inbox
            .push(Event::WindowResized(capabilities().size))
            .unwrap();
        let current = pointer(
            MouseEventKind::Down(termina::event::MouseButton::Left),
            6,
            7,
        );
        inbox.push(current.clone()).unwrap();
        assert_eq!(inbox.queue_len(), 1, "resize retires only old coordinates");
        assert!(
            inbox.pop().is_none(),
            "apply native resize before mapping the new pointer"
        );
        inbox.resize.take();
        let input = inbox.pop().unwrap();
        assert_eq!(input.event, current);
        assert_eq!(input.geometry, 2);
    }

    #[test]
    fn keyboard_bursts_and_large_paste_survive_startup_and_resize_in_order() {
        let mut inbox = Inbox::new(
            Capabilities {
                size: WindowSize {
                    cols: 120,
                    rows: 40,
                    pixel_width: Some(1200),
                    pixel_height: Some(800),
                },
                mouse: super::super::probe::MouseCoordinates::Cells,
                protocol: None,
                synchronized: false,
                sixel_geometry: Default::default(),
                ui_scale: 1.0,
            },
            false,
        );
        let mut expected = Vec::new();
        for character in "a你b界".repeat(1024).chars() {
            let event = Event::Key(KeyEvent::new(KeyCode::Char(character), Modifiers::NONE));
            assert!(!inbox.push(event.clone()).unwrap());
            expected.push(event);
        }
        let paste = Event::Paste("你好\nworld".repeat(16384));
        assert!(!inbox.push(paste.clone()).unwrap());
        expected.push(paste);
        assert!(
            inbox.has_pending_input(),
            "native input does not wait for pixels"
        );
        let size = WindowSize {
            cols: 80,
            rows: 24,
            pixel_width: Some(800),
            pixel_height: Some(480),
        };
        assert!(!inbox.push(Event::WindowResized(size)).unwrap());
        let (events, resize) = inbox.into_startup();
        assert_eq!(events, expected);
        assert_eq!(resize, Some(size));
    }
}
