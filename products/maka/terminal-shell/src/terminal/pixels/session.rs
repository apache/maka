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

use super::{
    super::{
        Presentation,
        frame_trace::{InputPumpSample, InputSample},
    },
    mapping::Mapping,
};
use gpui::{
    AppContext, Application, Bounds, Focusable, PlatformInput, WindowBounds, WindowOptions, point,
    px, size,
};
use nsh_engine::EngineConfig;
use nsh_gpui_terminal::{FrameToken, TerminalPlatform};
use nsh_platform_gpui::{AppOptions, AppView};
use std::{
    cell::{Cell, RefCell},
    rc::Rc,
    sync::{Arc, atomic::Ordering, mpsc},
    thread,
    time::{Duration, Instant},
};
use termina::{Event, event::KeyEventKind};

pub(super) fn spawn(
    config: EngineConfig,
    presentation: Presentation,
) -> Result<
    (
        mpsc::Receiver<Result<(), EngineConfig>>,
        super::super::GpuWorker,
    ),
    String,
> {
    let (ready, startup) = mpsc::sync_channel(1);
    let worker = thread::Builder::new()
        .name("maka-nsh-gpui".into())
        .spawn(move || {
            let result = run(config, &presentation, ready);
            if let Err(error) = &result {
                presentation.state.lock().unwrap().error = Some(error.clone());
            }
            presentation.wake_driver();
            result
        })
        .map_err(|error| error.to_string())?;
    Ok((startup, worker))
}

fn run(
    mut config: EngineConfig,
    presentation: &Presentation,
    ready: mpsc::SyncSender<Result<(), EngineConfig>>,
) -> Result<(), String> {
    if presentation.stop.load(Ordering::Acquire) || presentation.state.lock().unwrap().quit {
        return Ok(());
    }
    let renderer = match gpui_wgpu::WgpuHeadlessRenderer::new() {
        Ok(renderer) => renderer,
        Err(_) => {
            let _ = ready.send(Err(config));
            return Ok(());
        }
    };
    let tracing = {
        let mut state = presentation.state.lock().unwrap();
        if presentation.stop.load(Ordering::Acquire) || state.quit {
            return Ok(());
        }
        if let Some(trace) = &mut state.trace {
            trace.gpu = renderer.gpu_specs().map(|gpu| {
                serde_json::json!({
                    "is_software_emulated": gpu.is_software_emulated,
                    "device_name": gpu.device_name,
                    "driver_name": gpu.driver_name,
                    "driver_info": gpu.driver_info,
                })
            });
        }
        state.trace.is_some()
    };
    let control = super::super::UiScaleControl(presentation.clone());
    config.context = config
        .context
        .with(maka_workbench::UiScale(Box::new(move |scale| {
            control.preview(scale)
        })));
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
    let platform = TerminalPlatform::new(
        Box::new(renderer),
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
                if inbox.capabilities.protocol == Some(super::probe::Protocol::Sixel) {
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
                admitted = inbox.submitted(super::input::Candidate {
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
                    "pump_until_submission",
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
    )
    .map_err(|error| error.to_string())?;
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
    platform
        .set_viewport(viewport, scale_factor)
        .map_err(|error| error.to_string())?;
    let mut reloading = config
        .context
        .get::<maka_workbench::reload::UiReload>()
        .map(|reload| reload.take_requests());
    let reload_config = config.clone();
    let error = presentation.clone();
    let window = Rc::new(RefCell::new(None));
    let created = window.clone();
    let application = Application::with_platform(platform.clone()).run_embedded(move |cx| {
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                point(px(0.0), px(0.0)),
                size(
                    px(viewport.width.0 as f32 / scale_factor),
                    px(viewport.height.0 as f32 / scale_factor),
                ),
            ))),
            inactive_frame_interval: None,
            ..Default::default()
        };
        match cx.open_window(options, move |window, cx| {
            cx.new(|cx| {
                let view = AppView::new(
                    AppOptions {
                        title: "Maka".into(),
                        terminal_keyboard: true,
                        app_id: "org.apache.maka.terminal".into(),
                        ..Default::default()
                    },
                    window,
                    cx,
                );
                let cancelled =
                    error.stop.load(Ordering::Acquire) || error.state.lock().unwrap().quit;
                view.on_error(move |message| {
                    error.state.lock().unwrap().error = Some(message.into());
                });
                if !cancelled {
                    view.load_with_config(config);
                }
                // This surface owns the terminal keyboard from its first frame.
                // A regular embedded AppView waits for the host to focus it.
                window.focus(&view.focus_handle(cx), cx);
                view
            })
        }) {
            Ok(handle) => *created.borrow_mut() = Some(handle),
            Err(_) => cx.quit(),
        }
    });
    if window.borrow().is_none() {
        return Err("cannot open the terminal GPUI surface".into());
    }
    let background = application.update(|cx| cx.background_executor().clone());
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
                application.update(|cx| {
                    if let Some(window) = window.borrow().as_ref() {
                        let _ = window.update(cx, |view, window, cx| {
                            view.cancel_pointer();
                            window.refresh();
                            cx.notify();
                        });
                    }
                });
            }
            if let Some(offer) = ready {
                // Resize invalidates the receipt immediately, even while GPU
                // readback or an old output transaction is still finishing.
                let mut state = presentation.state.lock().unwrap();
                let inbox = state.pixels.as_ref().unwrap();
                let disposition = if caps.protocol == Some(super::probe::Protocol::Sixel)
                    && state.error.is_some()
                {
                    Some("error")
                } else if caps.protocol == Some(super::probe::Protocol::Sixel)
                    && (state.quit || presentation.stop.load(Ordering::Acquire))
                {
                    Some("cancel")
                } else if resize.is_some()
                    || offer.geometry != generation
                    || inbox.resize.is_some()
                    || inbox.geometry != offer.geometry
                {
                    Some("resize")
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
                    } else if caps.protocol == Some(super::probe::Protocol::Sixel)
                        && let Some(outcome) = disposition
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
                application.update(|cx| {
                    if let Some(window) = window.borrow().as_ref() {
                        let _ = window.update(cx, |view, window, cx| {
                            match request {
                                maka_workbench::reload::Request::Pause(ready) => {
                                    view.pause_input(window, cx, move |result| {
                                        let _ = ready.send(result);
                                    });
                                }
                                maka_workbench::reload::Request::Resume => {
                                    view.resume_input(window, cx)
                                }
                                maka_workbench::reload::Request::Reload => {
                                    view.load_with_config(reload_config.clone());
                                    window.focus(&view.focus_handle(cx), cx);
                                }
                            }
                            window.refresh();
                            cx.notify();
                        });
                    }
                });
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
                application.update(|cx| {
                    if let Some(window) = window.borrow().as_ref() {
                        let _ = window.update(cx, |view, window, cx| {
                            view.cancel_pointer();
                            window.refresh();
                            cx.notify();
                        });
                    }
                });
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
                        application.update(|cx| {
                            if let Some(window) = window.borrow().as_ref() {
                                let _ = window.update(cx, |view, window, cx| {
                                    view.paste(nsh_core::PasteEvent::new(text));
                                    window.refresh();
                                    cx.notify();
                                });
                            }
                        });
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
                                    .dispatch_input(PlatformInput::KeyUp(gpui::KeyUpEvent {
                                        keystroke: key.keystroke,
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
                    application.update(|cx| {
                        if let Some(window) = window.borrow().as_ref() {
                            let _ = window.update(cx, |view, window, cx| {
                                view.cancel_pointer();
                                window.refresh();
                                cx.notify();
                            });
                        }
                    });
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
            if let Some(text) = platform.take_clipboard_write().and_then(|item| item.text()) {
                let bytes = nsh_platform_tui::ServiceOutput::Clipboard(text)
                    .terminal_sequence(std::env::var_os("TMUX").is_some())
                    .into_bytes();
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
    application.update(|cx| {
        if let Some(window) = window.borrow().as_ref() {
            let _ = window.update(cx, |view, _, _| view.stop());
        }
    });
    let cancelled = text_input.blur(&platform, presentation);
    let result = result.and(cancelled);
    drop(application);
    platform.shutdown();
    result
}

/// Start an already reserved readback-and-encoding job on the existing executor.
/// Its Inbox slot spans executor wait, readback, codec and completed snapshot wait.
/// Native input keeps pumping; jobs and executor shutdown cannot hold cleanup.
fn encode_pending(presentation: &Presentation, background: &gpui::BackgroundExecutor) -> bool {
    if presentation.stop.load(Ordering::Acquire) {
        return false;
    }
    let work = {
        let mut state = presentation.state.lock().unwrap();
        if state.quit || state.error.is_some() {
            return false;
        }
        let slots = state.pixel_probe.slots;
        let tracing = state.trace.is_some();
        let inbox = state.pixels.as_mut().unwrap();
        let Some(candidate) = inbox.take_candidate() else {
            return false;
        };
        let previous = inbox.last_fully_written_image;
        let same_viewport_flushed = inbox.last_fully_written_geometry == Some(candidate.geometry);
        let image = if previous == Some(slots.first) {
            slots.second
        } else {
            slots.first
        };
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
        (
            candidate,
            image,
            previous,
            same_viewport_flushed,
            capabilities,
            tracing,
        )
    };
    let presentation = presentation.clone();
    background
        .spawn(async move {
            let (candidate, image, previous, same_viewport_flushed, caps, tracing) = work;
            let token = candidate.frame.token();
            let geometry = candidate.geometry;
            let size = caps.size;
            use super::{input::WireFrame, probe::Protocol};
            use nsh_gpui_terminal::inline::{InlineFrame, InlineProtocol};
            let readback_started = tracing.then(Instant::now);
            let frame = candidate
                .frame
                .complete()
                .map_err(|error| error.to_string());
            let readback_failed = frame.is_err();
            let readback_ended = readback_started.map(|_| Instant::now());
            let current = {
                let mut state = presentation.state.lock().unwrap();
                // A GPU failure is session-wide even if resize superseded the
                // frame while readback was running.
                if let Err(error) = &frame
                    && !state.quit
                    && !presentation.stop.load(Ordering::Acquire)
                {
                    state.error.get_or_insert_with(|| error.clone());
                }
                let current = !state.quit
                    && state.error.is_none()
                    && !presentation.stop.load(Ordering::Acquire)
                    && state.pixels.as_ref().unwrap().geometry == geometry;
                if let (Some(start), Some(end), Some(trace)) =
                    (readback_started, readback_ended, &mut state.trace)
                {
                    let sample = trace.record(&token, geometry, "readback", start, end);
                    sample.bytes = frame.as_ref().ok().map(|frame| frame.pixels().len());
                    sample.outcome = if frame.is_err() {
                        "error"
                    } else if !current {
                        "discarded"
                    } else {
                        "ok"
                    };
                    if let (Some(start), Ok(frame)) = (candidate.pump_started, &frame) {
                        let sample =
                            trace.record(&token, geometry, "pump_until_candidate", start, end);
                        sample.bytes = Some(frame.pixels().len());
                        let size = frame.size();
                        sample.pixel_size = Some((size.width.0, size.height.0));
                        sample.outcome = if current { "admitted" } else { "discarded" };
                    }
                }
                current
            };
            let mut started = None;
            let mut ended = None;
            let result = match frame {
                Ok(frame) if current => {
                    started = tracing.then(Instant::now);
                    let result = match caps.protocol.expect("negotiated pixel transport") {
                        Protocol::Kitty => nsh_gpui_terminal::kitty::KittyFrame::encode(
                            &frame, image, previous, size.cols, size.rows,
                        )
                        .map(WireFrame::Kitty),
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
                    .map_err(|error| error.to_string());
                    ended = started.map(|_| Instant::now());
                    Some(result)
                }
                _ => None,
            };
            let bytes = if tracing {
                result.as_ref().and_then(|result| result.as_ref().ok()).map(
                    |encoded| match &encoded.frame {
                        WireFrame::Kitty(frame) => frame.wire().len(),
                        WireFrame::Inline(frame) => frame.bytes().len(),
                    },
                )
            } else {
                None
            };
            let failed = readback_failed || result.as_ref().is_some_and(Result::is_err);
            let mut state = presentation.state.lock().unwrap();
            let cancelled =
                state.quit || state.error.is_some() || presentation.stop.load(Ordering::Acquire);
            let inbox = state.pixels.as_mut().unwrap();
            let discarded = !current || cancelled || inbox.geometry != geometry;
            let encoded = match result {
                Some(Ok(encoded)) if !discarded => Some(encoded),
                Some(Err(error))
                    if !discarded
                        || (caps.protocol == Some(Protocol::Sixel)
                            && !state.quit
                            && !presentation.stop.load(Ordering::Acquire)) =>
                {
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
                sample.image = (caps.protocol == Some(Protocol::Kitty)).then_some(image);
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
                    && caps.protocol == Some(Protocol::Sixel)
                {
                    trace.discard(&token, geometry, outcome);
                }
            }
            drop(state);
            if let Some(wake) = wake {
                wake.unpark();
            }
            presentation.wake_driver();
        })
        .detach();
    true
}
