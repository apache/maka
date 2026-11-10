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

mod cursor;
mod geometry;
mod input;
mod kitty;
mod mapping;
mod probe;
mod session;
pub(super) mod text_input;

use super::{Presentation, output::Output};
pub(super) use input::Inbox;
use nsh_engine::EngineConfig;
pub(super) use probe::Probe;
pub(super) use probe::{Capabilities, MouseCoordinates, Protocol};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::Instant,
};

/// Uses the single input reader during negotiation. No engine has started, so
/// automatic selection cannot create competing applications or Host clients.
pub(super) fn select(
    output: &mut Output,
    presentation: &Presentation,
    size: termina::WindowSize,
) -> Result<Option<Capabilities>, String> {
    loop {
        if presentation.stop.load(Ordering::Acquire) {
            return Ok(None);
        }
        let flushed = if output.poll()? {
            output.take_flushed()
        } else {
            None
        };
        let mut state = presentation.state.lock().unwrap();
        if state.quit {
            return Ok(None);
        }
        if let Some(error) = &state.error {
            return Err(error.clone());
        }
        if let Some(flushed) = flushed {
            state.graphics.flushed();
            state.pixel_probe.flushed(flushed);
        }
        if let Some(decision) = state.pixel_probe.decision(Instant::now(), size) {
            if let Some(capabilities) = decision {
                state.pixels.as_mut().unwrap().capabilities = capabilities;
                if let Some(trace) = &mut state.trace {
                    trace.protocol = capabilities.protocol.map(|protocol| match protocol {
                        probe::Protocol::Kitty => "kitty",
                        probe::Protocol::Sixel => "sixel",
                        probe::Protocol::Iterm2 => "iterm2",
                    });
                }
            } else {
                restore_character_input(&mut state);
            }
            return Ok(decision);
        }
        let wait = state
            .pixel_probe
            .next_deadline()
            .map_or(super::TICK, |deadline| {
                deadline
                    .saturating_duration_since(Instant::now())
                    .min(super::TICK)
            });
        drop(state);
        thread::park_timeout(wait);
    }
}

fn restore_character_input(state: &mut super::input::Inbox) {
    if let Some(pixels) = state.pixels.take() {
        let (events, resize) = pixels.into_startup();
        for event in events {
            state.push_terminal(event);
        }
        if let Some(size) = resize {
            state.push(crossterm::event::Event::Resize(size.cols, size.rows));
        }
    }
}

enum Phase {
    Setup,
    Idle,
    Origin(input::Encoded),
    AwaitImage {
        offer: input::Offer,
        image: u32,
    },
    Publish {
        offer: input::Offer,
        image: Option<u32>,
    },
    Effect,
    Measure,
}

/// Drives terminal transport independently of native UI preparation and
/// background native snapshot transfer and encoding.
pub(super) fn run(
    output: &mut Output,
    presentation: &Presentation,
    config: EngineConfig,
    caps: Capabilities,
) -> Result<(), String> {
    let mut setup = b"\x1b[?1003h".to_vec();
    if matches!(caps.mouse, MouseCoordinates::Pixels(_)) {
        setup.extend_from_slice(b"\x1b[?1016h");
    }
    let tracing = {
        let mut state = presentation.state.lock().unwrap();
        if caps.protocol == Some(probe::Protocol::Sixel) && state.pixel_probe.needs_static_sixel() {
            setup.extend_from_slice(b"\x1b[?80h");
            // Arm restoration before submission: Close remains ordered after
            // this complete setup even if cancellation races its receipt.
            state.pixels.as_mut().unwrap().restore_sixel_mode = true;
        }
        state.trace.is_some()
    };
    output.submit([setup])?;
    let startup = session::spawn(config, presentation.clone())?;
    let mut starting = true;
    let mut phase = Phase::Setup;
    let mut submitted_cursor = None;
    loop {
        if presentation.stop.load(Ordering::Acquire) {
            return Ok(());
        }
        {
            let state = presentation.state.lock().unwrap();
            if state.quit {
                return Ok(());
            }
            if let Some(error) = &state.error {
                return Err(error.clone());
            }
        }
        let flushed = if output.poll()? {
            output.take_flushed()
        } else {
            None
        };
        if let Some(at) = flushed {
            phase = match phase {
                Phase::Setup | Phase::Effect => Phase::Idle,
                Phase::Measure => {
                    presentation
                        .state
                        .lock()
                        .unwrap()
                        .pixel_probe
                        .measurement
                        .flushed(at);
                    Phase::Idle
                }
                Phase::Origin(encoded) => {
                    presentation
                        .state
                        .lock()
                        .unwrap()
                        .pixels
                        .as_mut()
                        .unwrap()
                        .kitty
                        .flushed(at);
                    Phase::Origin(encoded)
                }
                Phase::Publish { offer, image } => {
                    let mut state = presentation.state.lock().unwrap();
                    if let Some(trace) = &mut state.trace {
                        let sample =
                            trace.record(&offer.token, offer.geometry, "upload_flushed", at, at);
                        sample.image = image;
                    }
                    let inbox = state.pixels.as_mut().unwrap();
                    if let Some(image) = image {
                        inbox.kitty.flushed(at);
                        Phase::AwaitImage { offer, image }
                    } else {
                        inbox.written(offer, None);
                        Phase::Idle
                    }
                }
                Phase::Idle | Phase::AwaitImage { .. } => {
                    return Err("unexpected terminal output receipt".into());
                }
            };
        }
        {
            let mut state = presentation.state.lock().unwrap();
            let measured = state.pixel_probe.measurement.poll(Instant::now());
            let inbox = state.pixels.as_mut().unwrap();
            let needs_pixels = inbox.resize.is_some() && inbox.capabilities.pixel_size().is_none();
            match measured {
                Ok(Some((generation, width, height)))
                    if generation == inbox.geometry && needs_pixels =>
                {
                    inbox.capabilities.size.pixel_width = Some(width);
                    inbox.capabilities.size.pixel_height = Some(height);
                    inbox.resize = Some(inbox.capabilities.size);
                    if let Some(wake) = &inbox.wake {
                        wake.unpark();
                    }
                }
                Err(error) if needs_pixels => return Err(error),
                _ => {}
            }
        }
        if matches!(phase, Phase::Origin(_) | Phase::AwaitImage { .. }) {
            let ready = presentation
                .state
                .lock()
                .unwrap()
                .pixels
                .as_mut()
                .unwrap()
                .kitty
                .poll(Instant::now())?;
            if ready {
                match std::mem::replace(&mut phase, Phase::Idle) {
                    Phase::Origin(encoded) => {
                        let (next, cursor) = publish(output, presentation, encoded, tracing)?;
                        phase = next;
                        submitted_cursor = cursor.or(submitted_cursor);
                    }
                    Phase::AwaitImage { offer, image } => {
                        presentation
                            .state
                            .lock()
                            .unwrap()
                            .pixels
                            .as_mut()
                            .unwrap()
                            .written(offer, Some(image));
                    }
                    _ => unreachable!("only Kitty transfers wait for replies"),
                }
            }
        }
        if matches!(phase, Phase::Idle) {
            if starting {
                match startup.try_recv() {
                    Ok(Ok(())) => starting = false,
                    Ok(Err(config)) => {
                        // No app was started. Return the exact original Host
                        // configuration to the character renderer.
                        let mut restore = cleanup(presentation, false);
                        // Kitty keeps one active mouse tracking/encoding
                        // value: resetting pixel modes also clears the
                        // original character modes. Re-enable those after
                        // cleanup without re-entering the alternate screen.
                        restore.extend_from_slice(b"\x1b[?1000h\x1b[?1002h\x1b[?1006h");
                        output.submit([restore])?;
                        while !output.poll()? {
                            if presentation.stop.load(Ordering::Acquire)
                                || presentation.state.lock().unwrap().quit
                            {
                                return Ok(());
                            }
                            thread::park_timeout(super::TICK);
                        }
                        output.take_flushed();
                        {
                            let mut state = presentation.state.lock().unwrap();
                            restore_character_input(&mut state);
                        }
                        if presentation.stop.load(Ordering::Acquire)
                            || presentation.state.lock().unwrap().quit
                        {
                            return Ok(());
                        }
                        let pending = Arc::new(AtomicBool::new(false));
                        let (commands, frames) = super::ui::spawn(
                            config,
                            pending.clone(),
                            thread::current(),
                            presentation.tmux,
                        )
                        .map_err(|error| error.to_string())?;
                        return super::drive(output, presentation, &commands, &frames, &pending);
                    }
                    Err(std::sync::mpsc::TryRecvError::Empty) => {}
                    Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                        return Err("terminal native renderer stopped during startup".into());
                    }
                }
            }
            let mut state = presentation.state.lock().unwrap();
            let missing = state
                .pixels
                .as_ref()
                .filter(|inbox| inbox.resize.is_some() && inbox.capabilities.pixel_size().is_none())
                .map(|inbox| inbox.geometry);
            if let Some(generation) = missing
                && state.pixel_probe.measurement.begin(generation)?
            {
                drop(state);
                output.submit([geometry::QUERY.to_vec()])?;
                phase = Phase::Measure;
                continue;
            }
            let inbox = state.pixels.as_mut().unwrap();
            if let Some(bytes) = inbox.text_input.take_control() {
                drop(state);
                output.submit([bytes])?;
                phase = Phase::Effect;
            } else if let Some(bytes) = inbox.effects.take() {
                drop(state);
                output.submit([bytes])?;
                phase = Phase::Effect;
            } else if let Some(encoded) = inbox.take_encoded() {
                if let Some(wake) = &inbox.wake {
                    wake.unpark();
                }
                let kitty = matches!(encoded.frame, input::WireFrame::Kitty(_));
                if kitty {
                    inbox.kitty.begin(kitty::Reply::Origin);
                }
                drop(state);
                if kitty {
                    output.submit([kitty::ORIGIN.to_vec()])?;
                    phase = Phase::Origin(encoded);
                } else {
                    let (next, cursor) = publish(output, presentation, encoded, tracing)?;
                    phase = next;
                    submitted_cursor = cursor.or(submitted_cursor);
                }
            } else if submitted_cursor != Some((inbox.cursor, inbox.text_input.ready_nonce()))
                && inbox.last_fully_written_geometry == Some(inbox.geometry)
                && inbox.resize.is_none()
            {
                let cursor = inbox.cursor;
                let nonce = inbox.text_input.ready_nonce();
                drop(state);
                output.submit([cursor.bytes(nonce)])?;
                submitted_cursor = Some((cursor, nonce));
                phase = Phase::Effect;
            }
        }
        let measured = presentation
            .state
            .lock()
            .unwrap()
            .pixel_probe
            .measurement
            .next_deadline();
        // IO, input and producer completions wake this driver directly. The
        // existing tick only bounds observation of external AtomicBool cancel.
        let wait = measured.map_or(super::TICK, |deadline| {
            deadline
                .saturating_duration_since(Instant::now())
                .min(super::TICK)
        });
        thread::park_timeout(wait);
    }
}

type SubmittedCursor = (cursor::Cursor, Option<std::num::NonZeroU64>);

fn publish(
    output: &mut Output,
    presentation: &Presentation,
    encoded: input::Encoded,
    tracing: bool,
) -> Result<(Phase, Option<SubmittedCursor>), String> {
    let mut state = presentation.state.lock().unwrap();
    let slots = state.pixel_probe.slots;
    let inbox = state.pixels.as_mut().unwrap();
    let offer = input::Offer {
        token: encoded.frame.token(),
        geometry: encoded.geometry,
    };
    let previous = inbox.last_fully_written_image;
    let image = if matches!(&encoded.frame, input::WireFrame::Kitty(_)) {
        let image = if previous == Some(slots.first) {
            slots.second
        } else {
            slots.first
        };
        Some(image)
    } else {
        None
    };
    let cursor = inbox.cursor;
    let nonce = inbox.text_input.ready_nonce();
    drop(state);
    let bytes = match encoded.frame {
        input::WireFrame::Kitty(frame) => frame
            .into_wire(image.expect("Kitty image slot"), previous)
            .map_err(|error| error.to_string())?,
        // Inline protocols have no image ACK; their whole flush publishes the draw.
        input::WireFrame::Inline(frame) => frame.into_bytes(),
    };
    let parts = cursor.frame_parts(bytes, nonce);
    let wire_bytes = parts.iter().map(Vec::len).sum();
    let submitted = tracing.then(Instant::now);
    let mut state = presentation.state.lock().unwrap();
    let inbox = state.pixels.as_mut().unwrap();
    if offer.geometry != inbox.geometry {
        inbox.presented(&offer.token);
        if let Some(wake) = &inbox.wake {
            wake.unpark();
        }
        if let Some(trace) = &mut state.trace {
            trace.discard(&offer.token, offer.geometry, "revoked");
        }
        return Ok((Phase::Idle, None));
    }
    if let Some(image) = image {
        inbox.kitty.begin(kitty::Reply::Image(image));
    }
    // Submission is a nonblocking channel send. Commit it under the same lock
    // as resize/reload so a revoked waiting snapshot cannot start writing.
    output.submit(parts)?;
    if let (Some(at), Some(trace)) = (submitted, &mut state.trace) {
        let sample = trace.record(&offer.token, offer.geometry, "upload_submit_begin", at, at);
        sample.bytes = Some(wire_bytes);
        sample.image = image;
    }
    Ok((Phase::Publish { offer, image }, Some((cursor, nonce))))
}

pub(super) fn cleanup(presentation: &Presentation, failed: bool) -> Vec<u8> {
    let mut state = presentation.state.lock().unwrap();
    if state.pixels.is_none() {
        return Vec::new();
    }
    if state.trace.is_some()
        && matches!(
            state.pixels.as_ref().unwrap().capabilities.protocol,
            Some(probe::Protocol::Sixel | probe::Protocol::Kitty)
        )
    {
        let inbox = state.pixels.as_ref().unwrap();
        let geometry = inbox.geometry;
        let pending: Vec<_> = inbox.pending_frames().collect();
        let failed = failed || state.error.is_some();
        if let Some(trace) = &mut state.trace {
            for offer in pending {
                // This ends eligibility for display, not execution. Running
                // readback/codecs keep their original slots until they return.
                trace.discard(
                    &offer.token,
                    offer.geometry,
                    if failed {
                        "error"
                    } else if offer.geometry != geometry {
                        "resize"
                    } else {
                        "cancel"
                    },
                );
            }
        }
    }
    let inbox = state.pixels.as_ref().unwrap();
    let mut bytes = inbox.text_input.pending_release().unwrap_or_default();
    bytes.extend_from_slice(b"\x1b[?1016l\x1b[?1003l");
    match inbox.capabilities.protocol {
        Some(probe::Protocol::Kitty) => {
            let slots = state.pixel_probe.slots;
            bytes.extend(
                nsh_terminal::kitty::cleanup(slots.first, slots.second)
                    .expect("distinct nonzero owned image slots"),
            );
        }
        Some(probe::Protocol::Sixel | probe::Protocol::Iterm2) => {
            bytes.extend_from_slice(nsh_terminal::inline::cleanup());
        }
        None => {}
    }
    if inbox.restore_sixel_mode {
        bytes.extend_from_slice(b"\x1b[?80l");
    }
    bytes
}

#[cfg(test)]
mod transport_tests {
    use super::*;
    use std::sync::Mutex;

    #[test]
    fn revoked_snapshot_waiting_for_origin_never_starts_a_write() {
        #[derive(Clone)]
        struct Writer(Arc<Mutex<Vec<u8>>>);
        impl std::io::Write for Writer {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(bytes);
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        for protocol in [Protocol::Kitty, Protocol::Sixel, Protocol::Iterm2] {
            let written = Arc::new(Mutex::new(Vec::new()));
            let mut output = Output::new(Writer(written.clone())).unwrap();
            let presentation = Presentation::default();
            let caps = Capabilities {
                size: termina::WindowSize {
                    cols: 1,
                    rows: 1,
                    pixel_width: Some(1),
                    pixel_height: Some(1),
                },
                mouse: MouseCoordinates::Cells,
                protocol: Some(protocol),
                synchronized: false,
                sixel_geometry: Default::default(),
                ui_scale: 1.0,
            };
            let mut clock = nsh_terminal::FrameClock::default();
            clock
                .set_viewport(
                    nsh_terminal::size(
                        nsh_terminal::DevicePixels(1),
                        nsh_terminal::DevicePixels(1),
                    ),
                    1.0,
                )
                .unwrap();
            let candidate = clock
                .prepare(vec![0, 0, 0, 255])
                .unwrap()
                .submit()
                .unwrap()
                .complete()
                .unwrap();
            let token = candidate.token();
            let frame = match protocol {
                Protocol::Kitty => input::WireFrame::Kitty(
                    nsh_terminal::kitty::KittyFrame::encode(&candidate, 1, 1).unwrap(),
                ),
                _ => input::WireFrame::Inline(nsh_terminal::inline::InlineFrame::inert(
                    token.clone(),
                )),
            };
            let mut inbox = Inbox::new(caps, false);
            inbox.in_flight = Some(input::Offer { token, geometry: 1 });
            inbox.reload().unwrap();
            presentation.state.lock().unwrap().pixels = Some(inbox);
            let (phase, cursor) = publish(
                &mut output,
                &presentation,
                input::Encoded { frame, geometry: 1 },
                false,
            )
            .unwrap();
            assert!(matches!(phase, Phase::Idle));
            assert!(
                cursor.is_none(),
                "a discarded frame must not claim cursor output"
            );
            assert!(
                presentation
                    .state
                    .lock()
                    .unwrap()
                    .pixels
                    .as_ref()
                    .unwrap()
                    .in_flight
                    .is_none()
            );
            output.close(Vec::new()).unwrap().recv().unwrap().unwrap();
            assert!(
                written.lock().unwrap().is_empty(),
                "revoked snapshot reached the writer"
            );
        }
    }
}
