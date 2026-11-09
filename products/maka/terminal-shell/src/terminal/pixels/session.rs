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

#[cfg(any(target_os = "macos", target_os = "windows"))]
mod submission;

use super::super::Presentation;
#[cfg(any(target_os = "macos", target_os = "windows"))]
use super::{
    super::frame_trace::{InputPumpSample, InputSample},
    mapping::Mapping,
};
use nsh_engine::EngineConfig;
#[cfg(target_os = "macos")]
use nsh_platform_macos::TerminalSurface;
#[cfg(target_os = "windows")]
use nsh_platform_windows::terminal::TerminalSurface;
#[cfg(any(target_os = "macos", target_os = "windows"))]
use nsh_terminal::{FrameToken, NativeSurface, PlatformInput};
use std::sync::mpsc;
#[cfg(any(target_os = "macos", target_os = "windows"))]
use std::{
    cell::Cell,
    rc::Rc,
    sync::{Arc, atomic::Ordering},
    thread,
    time::{Duration, Instant},
};
#[cfg(any(target_os = "macos", target_os = "windows"))]
use termina::{Event, event::KeyEventKind};

pub(super) fn spawn(
    config: EngineConfig,
    presentation: Presentation,
) -> Result<mpsc::Receiver<Result<(), EngineConfig>>, String> {
    let (ready, startup) = mpsc::sync_channel(1);
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        // GTK currently needs a display server. Select the character backend
        // before starting an engine rather than rasterizing its cell buffer.
        let _ = ready.send(Err(config));
        presentation.wake_driver();
    }
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        let jobs = presentation
            .native_jobs
            .as_ref()
            .ok_or("native renderer requires the main-thread owner")?
            .clone();
        jobs.send(Box::new(move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                run(config, &presentation, ready)
            }))
            .unwrap_or_else(|_| Err("terminal native renderer panicked".into()));
            if let Err(error) = result {
                presentation.state.lock().unwrap().error = Some(error);
            }
            presentation.wake_driver();
        }))
        .map_err(|_| "native renderer owner stopped".to_owned())?;
    }
    Ok(startup)
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn run(
    mut config: EngineConfig,
    presentation: &Presentation,
    ready: mpsc::SyncSender<Result<(), EngineConfig>>,
) -> Result<(), String> {
    if presentation.stop.load(Ordering::Acquire) || presentation.state.lock().unwrap().quit {
        return Ok(());
    }
    let tracing = presentation.state.lock().unwrap().trace.is_some();
    let control = super::super::UiScaleControl(presentation.clone());
    let current = super::super::UiScaleControl(presentation.clone());
    config.context = config.context.with(maka_workbench::UiScale {
        preview: Box::new(move |scale| control.preview(scale)),
        current: Box::new(move || current.current()),
    });
    // Admit the native owner, not a successfully initialized surface. Native
    // construction errors remain fatal and are reported through Presentation.
    if ready.send(Ok(())).is_err() {
        return Ok(());
    }
    presentation.wake_driver();
    let delivered = presentation.clone();
    let geometry = Rc::new(Cell::new(0));
    let drawn_geometry = geometry.clone();
    let owner = thread::current();
    let waker = owner.clone();
    let pump_started = tracing.then(|| Rc::new(Cell::new(None::<Instant>)));
    let drawing_started = pump_started.clone();
    // Renderer initialization can overlap a terminal resize. Wait for the
    // same reader/writer measurement to complete, then keep its size and
    // geometry together; never pair startup dimensions with a newer ticket.
    let (viewport, scale_factor) = loop {
        let measured = {
            let mut state = presentation.state.lock().unwrap();
            if presentation.stop.load(Ordering::Acquire) || state.quit {
                return Ok(());
            }
            if let Some(error) = &state.error {
                return Err(error.clone());
            }
            let inbox = state.pixels.as_mut().expect("selected pixel presentation");
            inbox.wake = Some(owner.clone());
            inbox
                .capabilities
                .viewport()
                .map(|viewport| (viewport, inbox.capabilities.scale_factor(), inbox.geometry))
        };
        if let Some((viewport, scale_factor, generation)) = measured {
            geometry.set(generation);
            break (viewport, scale_factor);
        }
        thread::park_timeout(Duration::from_millis(10));
    };
    let mut reloading = config
        .context
        .get::<maka_workbench::reload::UiReload>()
        .map(|reload| reload.take_requests());
    let reload_config = config.clone();
    let platform = TerminalSurface::new(
        config,
        viewport,
        scale_factor,
        Box::new(move |frame| {
            let timing = drawing_started
                .as_ref()
                .and_then(|started| started.get())
                .map(|start| {
                    (
                        start,
                        Instant::now(),
                        frame.token(),
                        frame.pixel_len(),
                        frame.size(),
                    )
                });
            let mut state = delivered.state.lock().unwrap();
            let stopping = state.quit || delivered.stop.load(Ordering::Acquire);
            let failed = state.error.is_some();
            let pending_frame = timing
                .as_ref()
                .and_then(|_| state.pixels.as_ref()?.oldest_frame());
            let mut admitted = false;
            let mut disposition = None;
            if let Some(inbox) = &mut state.pixels {
                if matches!(
                    inbox.capabilities.protocol,
                    Some(super::probe::Protocol::Sixel | super::probe::Protocol::Kitty)
                ) {
                    disposition = if failed {
                        Some("error")
                    } else if stopping {
                        Some("cancel")
                    } else if inbox.geometry != drawn_geometry.get() {
                        Some("resize")
                    } else {
                        None
                    };
                }
                admitted = inbox.prepared(super::input::Preparation {
                    frame,
                    geometry: drawn_geometry.get(),
                    pump_started: timing.as_ref().map(|(start, ..)| *start),
                });
            }
            if let Some((start, end, token, bytes, size)) = timing
                && let Some(trace) = &mut state.trace
            {
                let sample = trace.record(
                    &token,
                    drawn_geometry.get(),
                    "pump_until_prepared",
                    start,
                    end,
                );
                sample.bytes = Some(bytes);
                sample.pixel_size = Some((size.width.0, size.height.0));
                sample.outcome = if admitted { "admitted" } else { "discarded" };
                sample.pending_frame = pending_frame;
                if let Some(outcome) = disposition {
                    // An already entered draw may reach this sink after the
                    // shutdown snapshot. Its ticket still owns the original
                    // slot, while its eligibility for display has ended.
                    trace.discard(&token, drawn_geometry.get(), outcome);
                }
            }
        }),
        Arc::new(move || waker.unpark()),
    )?;
    let background = tokio::runtime::Handle::current();
    let mut mapping = Mapping::default();
    let mut text_input = super::text_input::Owner::new();
    let mut inputs_before_draw = 0;
    let result = (|| {
        while !presentation.stop.load(Ordering::Acquire) {
            let (resize, cancel, ready, caps, generation, quit, error) = {
                let mut state = presentation.state.lock().unwrap();
                let quit = state.quit;
                let error = state.error.clone();
                let inbox = state.pixels.as_mut().expect("selected pixel presentation");
                (
                    if inbox.capabilities.viewport().is_some() {
                        inbox.resize.take()
                    } else {
                        None
                    },
                    std::mem::take(&mut inbox.cancel_pointer),
                    inbox.ready.take(),
                    inbox.capabilities,
                    inbox.geometry,
                    quit,
                    error,
                )
            };
            if quit {
                return Ok(());
            }
            if let Some(error) = error {
                return Err(error);
            }
            if resize.is_some() {
                geometry.set(generation);
                let viewport = caps
                    .viewport()
                    .ok_or("terminal resize did not report its real pixel dimensions")?;
                platform
                    .set_viewport(viewport, caps.scale_factor())
                    .map_err(|error| error.to_string())?;
            }
            if cancel || resize.is_some() {
                platform.cancel_pointer();
            }
            if let Some(offer) = ready {
                // Resize invalidates the receipt immediately, even while native
                // capture transfer or an old output transaction is still finishing.
                let mut state = presentation.state.lock().unwrap();
                let inbox = state.pixels.as_ref().unwrap();
                let disposition = if matches!(
                    caps.protocol,
                    Some(super::probe::Protocol::Sixel | super::probe::Protocol::Kitty)
                ) && state.error.is_some()
                {
                    Some("error")
                } else if matches!(
                    caps.protocol,
                    Some(super::probe::Protocol::Sixel | super::probe::Protocol::Kitty)
                ) && (state.quit || presentation.stop.load(Ordering::Acquire))
                {
                    Some("cancel")
                } else if resize.is_some()
                    || offer.geometry != generation
                    || inbox.resize.is_some()
                    || inbox.geometry != offer.geometry
                {
                    Some("resize")
                } else if !platform.frame_is_current(&offer.token) {
                    Some("revoked")
                } else {
                    None
                };
                if disposition.is_none() {
                    // The receipt commit and shutdown snapshot share this
                    // lock, so a revoked token cannot later be published.
                    platform
                        .mark_presented(offer.token.clone())
                        .map_err(|error| error.to_string())?;
                }
                let inbox = state.pixels.as_mut().unwrap();
                if disposition.is_none() {
                    inbox.published = Some(offer.token.clone());
                }
                inbox.presented(&offer.token);
                if let Some(trace) = &mut state.trace {
                    if disposition.is_none() {
                        let at = Instant::now();
                        trace.record(&offer.token, offer.geometry, "published", at, at);
                    } else if matches!(
                        caps.protocol,
                        Some(super::probe::Protocol::Sixel | super::probe::Protocol::Kitty)
                    ) && let Some(outcome) = disposition
                    {
                        trace.discard(&offer.token, offer.geometry, outcome);
                    }
                }
                drop(state);
                presentation.wake_driver();
            }
            // Mount/focus callbacks and physical input share the native owner.
            // Apply queued native work without waiting for output or drawing.
            let mut input_pump = tracing.then(|| {
                let state = presentation.state.lock().unwrap();
                let inbox = state.pixels.as_ref().unwrap();
                let start = Instant::now();
                InputPumpSample {
                    frame: inbox.published.as_ref().map(FrameToken::sequence),
                    geometry: inbox.geometry,
                    start,
                    end: start,
                    queue_before: inbox.queue_len(),
                    queue_after: 0,
                }
            });
            let mut worked = platform.pump_with_draw(false);
            while let Some(request) = reloading
                .as_mut()
                .and_then(|requests| requests.try_recv().ok())
            {
                if matches!(request, maka_workbench::reload::Request::Reload) {
                    text_input.blur(&platform, presentation)?;
                }
                match request {
                    maka_workbench::reload::Request::Pause(ready) => {
                        platform.pause_input(Box::new(move |result| {
                            let _ = ready.send(result);
                        }));
                    }
                    maka_workbench::reload::Request::Resume => platform.resume_input(),
                    maka_workbench::reload::Request::Reload => {
                        {
                            let mut state = presentation.state.lock().unwrap();
                            let inbox = state.pixels.as_mut().unwrap();
                            let retired =
                                tracing.then(|| inbox.completed_frames().collect::<Vec<_>>());
                            inbox.reload()?;
                            if let (Some(retired), Some(trace)) = (retired, &mut state.trace) {
                                for offer in retired {
                                    trace.discard(&offer.token, offer.geometry, "reload");
                                }
                            }
                        }
                        // Both owners observe the transport generation change
                        // before native reload can revoke its frame tokens.
                        platform.load_with_config(reload_config.clone());
                        presentation.wake_driver();
                    }
                }
                worked = true;
            }
            text_input.sync(&platform, presentation)?;
            if let Some(sample) = &mut input_pump {
                sample.end = Instant::now();
            }
            let (input, late_cancel, queue_len, input_caps) = {
                let mut state = presentation.state.lock().unwrap();
                if presentation.stop.load(Ordering::Acquire) || state.quit {
                    return Ok(());
                }
                if let Some(error) = &state.error {
                    return Err(error.clone());
                }
                let inbox = state.pixels.as_mut().unwrap();
                let queue_len = inbox.queue_len();
                let input = inbox.pop();
                if input.is_some() {
                    if inputs_before_draw == 0 {
                        // Yield drawing for the current queue length only;
                        // arrivals during this turn cannot extend it.
                        inputs_before_draw = queue_len;
                    }
                    inputs_before_draw -= 1;
                } else {
                    inputs_before_draw = 0;
                }
                let late_cancel = std::mem::take(&mut inbox.cancel_pointer);
                let input_caps = inbox.capabilities;
                if let Some(mut sample) = input_pump
                    && let Some(trace) = &mut state.trace
                {
                    sample.queue_after = queue_len;
                    trace.record_input_pump(sample);
                }
                (input, late_cancel, queue_len, input_caps)
            };
            if late_cancel {
                platform.cancel_pointer();
            }
            if let Some(input) = input {
                super::super::interrupt::terminal_activity(&presentation.host, &input.event);
                let dispatch_start = input.queued_at.map(|_| Instant::now());
                let measurement =
                    if let (Some(queued), Some(start)) = (input.queued_at, dispatch_start) {
                        let mut state = presentation.state.lock().unwrap();
                        // A writer receipt identifies output in diagnostics only.
                        // It never grants or revokes physical input authority.
                        let published = state.pixels.as_ref().unwrap().published.clone();
                        state.trace.as_mut().map(|trace| {
                            trace.record_input(InputSample {
                                frame: published.as_ref().map(FrameToken::sequence),
                                viewport_generation: published
                                    .as_ref()
                                    .map(FrameToken::viewport_generation),
                                geometry: input.geometry,
                                kind: super::input::trace_kind(&input.event),
                                queued,
                                dispatch_start: start,
                                dispatch_end: None,
                                queue_len,
                                outcome: "incomplete",
                            })
                        })
                    } else {
                        None
                    };
                let mut cancel = false;
                let outcome = match &input.event {
                    Event::FocusIn => {
                        platform
                            .set_active(true)
                            .map_err(|error| error.to_string())?;
                        "focus_in"
                    }
                    Event::FocusOut => {
                        cancel = true;
                        text_input.blur(&platform, presentation)?;
                        platform
                            .set_active(false)
                            .map_err(|error| error.to_string())?;
                        "focus_out"
                    }
                    Event::Osc(termina::escape::osc::Osc::NshTextInput(packet)) => {
                        text_input.handle(packet, &platform, presentation)?;
                        "composition"
                    }
                    Event::Paste(text) => {
                        platform.paste(nsh_core::PasteEvent::new(text));
                        "paste_dispatched"
                    }
                    event => {
                        let stale =
                            super::input::pointer(event) && input.geometry != geometry.get();
                        if stale {
                            "stale_geometry"
                        } else if let Some(event) = mapping.input(event, input_caps) {
                            platform
                                .dispatch_input(event.clone())
                                .map_err(|error| error.to_string())?;
                            if matches!(&input.event, Event::Key(key) if key.kind == KeyEventKind::Press)
                                && let PlatformInput::KeyDown(key) = event
                            {
                                // Legacy terminals deliver complete strokes without
                                // key releases; preserve explicit Repeat/Release.
                                platform
                                    .dispatch_input(PlatformInput::KeyUp({
                                        let mut value = nsh_terminal::KeyUpEvent::default();
                                        value.keystroke = key.keystroke;
                                        value
                                    }))
                                    .map_err(|error| error.to_string())?;
                            }
                            "native_dispatched"
                        } else {
                            // A physical release with unrepresentable terminal
                            // coordinates still ends the current native contact.
                            cancel = super::input::released(event);
                            "unmapped"
                        }
                    }
                };
                text_input.sync(&platform, presentation)?;
                if cancel {
                    platform.cancel_pointer();
                }
                if let Some(index) = measurement {
                    let end = Instant::now();
                    let mut state = presentation.state.lock().unwrap();
                    if let Some(trace) = &mut state.trace {
                        trace.finish_input(index, end, outcome);
                    }
                }
            }
            let allow_draw = {
                let mut state = presentation.state.lock().unwrap();
                let inbox = state.pixels.as_mut().unwrap();
                inputs_before_draw == 0 && geometry.get() == inbox.geometry && inbox.reserve_frame()
            };
            if let Some(started) = &pump_started {
                started.set(allow_draw.then(Instant::now));
            }
            worked |= platform.pump_with_draw(allow_draw);
            text_input.sync(&platform, presentation)?;
            let caret = platform.input_caret_bounds();
            let candidate = platform.input_candidate_bounds();
            {
                let mut state = presentation.state.lock().unwrap();
                let inbox = state.pixels.as_mut().unwrap();
                if geometry.get() == inbox.geometry && inbox.resize.is_none() {
                    let cursor =
                        super::cursor::Cursor::from_native(caret, candidate, inbox.capabilities);
                    if inbox.cursor != cursor {
                        inbox.cursor = cursor;
                        presentation.wake_driver();
                    }
                }
            }
            presentation
                .state
                .lock()
                .unwrap()
                .pixels
                .as_mut()
                .unwrap()
                .release_reservation();
            if let Some(started) = &pump_started {
                started.set(None);
            }
            worked |= submission::submit_pending(presentation, &background);
            if inputs_before_draw == 0 {
                worked |= encode_pending(presentation, &background);
            }
            if let Some(error) = platform.take_error() {
                return Err(error);
            }
            if platform.is_quit_requested() {
                presentation.state.lock().unwrap().quit = true;
                return Ok(());
            }
            if let Some(text) = platform.take_clipboard_write() {
                let bytes = super::super::output::osc52(&text, presentation.tmux).into_bytes();
                presentation
                    .state
                    .lock()
                    .unwrap()
                    .pixels
                    .as_mut()
                    .unwrap()
                    .effects = Some(bytes);
                presentation.wake_driver();
            }
            let input_pending = presentation
                .state
                .lock()
                .unwrap()
                .pixels
                .as_ref()
                .unwrap()
                .has_pending_input();
            if !worked && !input_pending {
                let wait = platform
                    .next_deadline()
                    .map_or(Duration::from_millis(16), |deadline| {
                        deadline
                            .saturating_duration_since(Instant::now())
                            .min(Duration::from_millis(16))
                    });
                thread::park_timeout(wait);
            }
        }
        Ok(())
    })();
    platform.stop();
    let cancelled = text_input.blur(&platform, presentation);
    let result = result.and(cancelled);
    platform.shutdown();
    result
}

/// Encode a completed readback on the existing executor.
/// Its Inbox slot spans executor wait, codec and completed snapshot wait.
/// Native input keeps pumping; jobs and executor shutdown cannot hold cleanup.
#[cfg(any(target_os = "macos", target_os = "windows"))]
fn encode_pending(presentation: &Presentation, background: &tokio::runtime::Handle) -> bool {
    if presentation.stop.load(Ordering::Acquire) {
        return false;
    }
    let work = {
        let mut state = presentation.state.lock().unwrap();
        if state.quit || state.error.is_some() {
            return false;
        }
        let tracing = state.trace.is_some();
        let inbox = state.pixels.as_mut().unwrap();
        let Some(candidate) = inbox.take_candidate() else {
            return false;
        };
        let same_viewport_flushed = inbox.last_fully_written_geometry == Some(candidate.geometry);
        let capabilities = inbox.capabilities;
        if let Some(trace) = &mut state.trace {
            let at = Instant::now();
            trace.record(
                &candidate.frame.token(),
                candidate.geometry,
                "codec_queued",
                at,
                at,
            );
        }
        (candidate, same_viewport_flushed, capabilities, tracing)
    };
    let presentation = presentation.clone();
    background.spawn_blocking(move || {
        let (candidate, same_viewport_flushed, caps, tracing) = work;
        let token = candidate.frame.token();
        let geometry = candidate.geometry;
        let size = caps.size;
        use super::{input::WireFrame, probe::Protocol};
        use nsh_terminal::inline::{InlineFrame, InlineProtocol};
        let current = {
            let state = presentation.state.lock().unwrap();
            !state.quit
                && state.error.is_none()
                && !presentation.stop.load(Ordering::Acquire)
                && state.pixels.as_ref().unwrap().geometry == geometry
        };
        let mut started = None;
        let mut ended = None;
        let result = if current {
            let frame = candidate.frame;
            started = tracing.then(Instant::now);
            let result = match caps.protocol.expect("negotiated pixel transport") {
                Protocol::Kitty => {
                    nsh_terminal::kitty::KittyFrame::encode(&frame, size.cols, size.rows)
                        .map(WireFrame::Kitty)
                }
                protocol @ (Protocol::Sixel | Protocol::Iterm2) => InlineFrame::encode(
                    &frame,
                    match protocol {
                        Protocol::Sixel => InlineProtocol::Sixel,
                        _ => InlineProtocol::Iterm2,
                    },
                    size.cols,
                    size.rows,
                    caps.synchronized,
                    same_viewport_flushed,
                )
                .map(WireFrame::Inline),
            }
            .map(|frame| super::input::Encoded { frame, geometry })
            .map_err(|error| format!("{error:#}"));
            ended = started.map(|_| Instant::now());
            Some(result)
        } else {
            None
        };
        let bytes = if tracing {
            result
                .as_ref()
                .and_then(|result| result.as_ref().ok())
                .map(|encoded| match &encoded.frame {
                    WireFrame::Kitty(frame) => frame.payload_len(),
                    WireFrame::Inline(frame) => frame.bytes().len(),
                })
        } else {
            None
        };
        let failed = result.as_ref().is_some_and(Result::is_err);
        let mut state = presentation.state.lock().unwrap();
        let cancelled =
            state.quit || state.error.is_some() || presentation.stop.load(Ordering::Acquire);
        let inbox = state.pixels.as_mut().unwrap();
        let discarded = !current || cancelled || inbox.geometry != geometry;
        let encoded = match result {
            Some(Ok(encoded)) if !discarded => Some(encoded),
            Some(Err(error)) if !state.quit && !presentation.stop.load(Ordering::Acquire) => {
                state.error.get_or_insert(error);
                None
            }
            _ => None,
        };
        let disposition = if failed || state.error.is_some() {
            Some("error")
        } else if cancelled {
            Some("cancel")
        } else if discarded {
            Some("resize")
        } else {
            None
        };
        let inbox = state.pixels.as_mut().unwrap();
        let superseded = inbox.finished(&token, encoded);
        let wake = inbox.wake.clone();
        if let (Some(start), Some(end), Some(trace)) = (started, ended, &mut state.trace) {
            let sample = trace.record(&token, geometry, "codec", start, end);
            sample.bytes = bytes;
            sample.outcome = if failed {
                "error"
            } else if discarded {
                "discarded"
            } else {
                "ok"
            };
        }
        if let Some(trace) = &mut state.trace {
            if let super::input::Completion::Superseded {
                token: retired,
                replacement,
            } = superseded
            {
                let at = Instant::now();
                let sample = trace.record(&retired, geometry, "superseded", at, at);
                sample.outcome = "superseded";
                sample.pending_frame = Some(replacement.sequence());
            }
            if let Some(outcome) = disposition
                && matches!(caps.protocol, Some(Protocol::Sixel | Protocol::Kitty))
            {
                trace.discard(&token, geometry, outcome);
            }
        }
        drop(state);
        if let Some(wake) = wake {
            wake.unpark();
        }
        presentation.wake_driver();
    });
    true
}

#[cfg(all(test, target_os = "linux"))]
mod fallback_tests {
    use super::*;
    use nsh_core::element::{Root, input};
    use nsh_core::prelude::*;
    use std::sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    };
    use std::time::Duration;

    struct Admission {
        roots: Arc<AtomicUsize>,
        changes: mpsc::Sender<String>,
    }

    #[component]
    fn FallbackRoot() -> impl IntoElement {
        let admission = engine_context::<Admission>().unwrap();
        admission.roots.fetch_add(1, Ordering::SeqCst);
        let changes = admission.changes.clone();
        view().child(
            input()
                .auto_focus(true)
                .h(px(32.0))
                .on_change(move |value: &str| {
                    changes.send(value.to_owned()).unwrap();
                }),
        )
    }

    #[test]
    fn unsupported_native_fallback_keeps_admission_and_startup_input_without_starting_app() {
        let roots = Arc::new(AtomicUsize::new(0));
        let (changes, changed) = mpsc::channel();
        let mut config = EngineConfig::new(Root::of::<FallbackRoot>());
        config.context = config.context.with(Admission {
            roots: roots.clone(),
            changes,
        });
        config.viewport = crate::terminal::cell_viewport(80, 24);
        let (native_jobs, mut jobs) = tokio::sync::mpsc::unbounded_channel();
        let presentation = Presentation {
            native_jobs: Some(native_jobs),
            ..Default::default()
        };
        let size = termina::WindowSize {
            cols: 80,
            rows: 24,
            pixel_width: Some(800),
            pixel_height: Some(480),
        };
        let mut pixels = super::super::input::Inbox::new(
            super::super::Capabilities {
                size,
                mouse: super::super::MouseCoordinates::Cells,
                protocol: Some(super::super::Protocol::Kitty),
                synchronized: false,
                sixel_geometry: Default::default(),
                ui_scale: 1.0,
            },
            false,
        );
        pixels
            .push(termina::Event::Paste("queued draft".into()))
            .unwrap();
        pixels
            .push(termina::Event::WindowResized(termina::WindowSize {
                cols: 72,
                rows: 20,
                ..size
            }))
            .unwrap();
        presentation.state.lock().unwrap().pixels = Some(pixels);
        let returned = match super::spawn(config, presentation.clone())
            .unwrap()
            .recv()
            .unwrap()
        {
            Err(config) => config,
            Ok(()) => panic!("unsupported native backend claimed the app"),
        };
        assert_eq!(
            roots.load(Ordering::SeqCst),
            0,
            "fallback must precede app creation"
        );
        assert!(Arc::ptr_eq(
            &returned.context.get::<Admission>().unwrap().roots,
            &roots
        ));
        assert!(matches!(
            jobs.try_recv(),
            Err(tokio::sync::mpsc::error::TryRecvError::Empty)
        ));
        let (inputs, resize, cancel_pointer) = {
            let mut state = presentation.state.lock().unwrap();
            assert!(
                state.pixels.is_some(),
                "fallback must not consume the reader's queue"
            );
            super::super::restore_character_input(&mut state);
            assert!(state.pixels.is_none());
            (state.pop_batch(), state.resize.take(), state.cancel_pointer)
        };
        assert_eq!(
            inputs,
            vec![crossterm::event::Event::Paste("queued draft".into())]
        );
        assert_eq!(resize, Some((72, 20)));
        let (commands, frames) = crate::terminal::ui::spawn(
            returned,
            Arc::new(AtomicBool::new(false)),
            std::thread::current(),
            false,
        )
        .unwrap();
        frames
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .unwrap();
        assert_eq!(
            roots.load(Ordering::SeqCst),
            1,
            "only the character engine starts the app"
        );
        commands
            .send(crate::terminal::ui::Advance {
                image_protocol: None,
                inputs,
                resize,
                cancel_pointer,
                draw: true,
            })
            .unwrap();
        let frame = frames
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .unwrap();
        assert!(
            frame.bytes.is_some(),
            "resized character output must render"
        );
        assert_eq!(
            changed.recv_timeout(Duration::from_secs(5)).unwrap(),
            "queued draft"
        );
        assert_eq!(roots.load(Ordering::SeqCst), 1);
    }
}
