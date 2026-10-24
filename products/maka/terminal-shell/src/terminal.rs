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

//! Native UI input and terminal output have independent owners. Host ownership
//! and recovery stay outside this shell; blocked stdout never stalls native
//! event dispatch or the input owner’s independent cancellation path.

mod adapter;
mod frame_trace;
mod graphics;
mod input;
mod output;
mod pixels;
mod ui;

use input::Inbox;
use nsh_engine::EngineConfig;
use nsh_platform_tui::CellMetrics;
use output::Output;
use std::{
    io::{self, IsTerminal},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};
use termina::{EventReader, PlatformTerminal, Terminal as _};

const SETUP: &[u8] = b"\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?2004h";
const CLEANUP: &[u8] =
    b"\x1b[?2026l\x1b[?2004l\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[?25h\x1b[?1049l";
const TICK: Duration = Duration::from_millis(16);
// One existing best-effort restoration window, shared by IME release and IO.
const RESTORATION_WAIT: Duration = Duration::from_millis(100);

pub(crate) type GpuWorker = thread::JoinHandle<Result<(), String>>;

#[derive(Clone, Default)]
struct Presentation {
    state: Arc<Mutex<Inbox>>,
    stop: Arc<AtomicBool>,
    driver: Option<thread::Thread>,
}

impl Presentation {
    fn wake_driver(&self) {
        if let Some(driver) = &self.driver {
            driver.unpark();
        }
    }

    fn shutdown(&self) {
        self.stop.store(true, Ordering::Release);
    }
}

/// Per-engine display control. Business configuration remains with the Host.
pub(crate) struct UiScaleControl(Presentation);

impl UiScaleControl {
    pub(crate) fn preview(&self, scale: f32) -> Result<(), String> {
        let mut state = self.0.state.lock().unwrap();
        let inbox = state
            .pixels
            .as_mut()
            .ok_or("pixel display is unavailable")?;
        inbox.set_ui_scale(scale)?;
        if let Some(wake) = &inbox.wake {
            wake.unpark();
        }
        drop(state);
        self.0.wake_driver();
        Ok(())
    }
}

/// Runs the first-party terminal UI. Ctrl+Q cancels independently of the
/// UI and writer; Ctrl+C retains the surface's copy/exit behavior.
/// An error reports incomplete output restoration;
/// success means the cleanup bytes were flushed, rather than merely queued.
/// The embedding process may request graceful cancellation without acquiring
/// any UI or IO lock by setting `stop`.
pub(crate) fn run(
    mut config: EngineConfig,
    stop: Arc<AtomicBool>,
    _gpu_worker: &mut Option<GpuWorker>,
) -> Result<(), String> {
    if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
        return Err("the terminal shell requires a terminal on stdin and stdout".into());
    }
    let mut terminal = PlatformTerminal::new().map_err(|error| error.to_string())?;
    #[cfg(windows)]
    terminal.set_discard_input_on_drop(false);
    let size = terminal
        .get_dimensions()
        .map_err(|error| error.to_string())?;
    let (columns, rows) = (size.cols, size.rows);
    config.viewport = CellMetrics::default().viewport(columns.max(1), rows.max(1));
    config.environment.window = config.viewport;
    terminal
        .enter_raw_mode()
        .map_err(|error| error.to_string())?;
    let reader = terminal.event_reader();
    let mut output = Output::new(io::stdout()).map_err(|error| error.to_string())?;
    let presentation = Presentation {
        stop: stop.clone(),
        driver: Some(thread::current()),
        ..Default::default()
    };
    let setup = [SETUP, graphics::QUERY].concat();
    let setup = {
        let mut setup = setup;
        let mut state = presentation.state.lock().unwrap();
        state.trace = frame_trace::Trace::from_env();
        let tracing = state.trace.is_some();
        state.pixels = Some(pixels::Inbox::new(
            pixels::Capabilities {
                size,
                mouse: pixels::MouseCoordinates::Cells,
                protocol: None,
                synchronized: false,
                sixel_geometry: Default::default(),
                ui_scale: 1.0,
            },
            tracing,
        ));
        setup.extend(state.pixel_probe.query()?);
        setup.extend(pixels::text_input::query());
        setup
    };
    output.submit([setup])?;
    let mut input = None;
    let result = (|| {
        input = Some(start_reader(presentation.clone(), reader)?);
        {
            let capabilities = pixels::select(&mut output, &presentation, size)?;
            if presentation.stop.load(Ordering::Acquire) || presentation.state.lock().unwrap().quit
            {
                return Ok(());
            }
            if let Some(capabilities) = capabilities {
                return pixels::run(
                    &mut output,
                    &presentation,
                    config,
                    capabilities,
                    _gpu_worker,
                );
            }
        }
        let pending = Arc::new(AtomicBool::new(false));
        let (commands, frames) = ui::spawn(config, pending.clone(), thread::current())
            .map_err(|error| error.to_string())?;
        // Returning drops both channel endpoints without joining either
        // blocked owner, including startup errors after terminal mutation.
        drive(&mut output, &presentation, &commands, &frames, &pending)
    })();
    let restoration_deadline = Instant::now() + RESTORATION_WAIT;
    let text_input_cleanup = close_text_input(
        &mut output,
        &presentation,
        input.as_ref(),
        restoration_deadline,
    );
    let result = match (result, text_input_cleanup) {
        (Ok(()), cleanup) => cleanup,
        (Err(error), Ok(())) => Err(error),
        (Err(error), Err(cleanup)) => Err(format!("{error}; {cleanup}")),
    };
    presentation.shutdown();
    // The platform guard must outlive the sole reader: restoring console modes
    // or code pages while it can still decode input races shutdown on Windows.
    drop(input);
    let mut cleanup = Vec::new();
    cleanup.extend(pixels::cleanup(&presentation, result.is_err()));
    cleanup.extend_from_slice(CLEANUP);
    let cleanup = output.close(cleanup).and_then(|receipt| {
        match receipt.recv_timeout(restoration_deadline.saturating_duration_since(Instant::now())) {
            Ok(result) => result.map_err(|error| error.to_string()),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                Err("terminal output restoration is still pending behind blocked output".into())
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                Err("terminal output worker stopped before restoration".into())
            }
        }
    });
    let result = match (result, cleanup) {
        (Ok(()), result) => result,
        (Err(error), Ok(())) => Err(error),
        (Err(error), Err(cleanup)) => Err(format!("{error}; {cleanup}")),
    };
    drop(terminal);
    {
        let trace = presentation.state.lock().unwrap().trace.take();
        if let Some(trace) = trace {
            let saved = trace.write(&result);
            return match (result, saved) {
                (Ok(()), saved) => saved,
                (Err(error), Ok(())) => Err(error),
                (Err(error), Err(trace)) => Err(format!("{error}; {trace}")),
            };
        }
    }
    result
}

fn drive(
    output: &mut Output,
    presentation: &Presentation,
    commands: &mpsc::SyncSender<ui::Advance>,
    frames: &mpsc::Receiver<Result<ui::Frame, String>>,
    pending: &AtomicBool,
) -> Result<(), String> {
    let Presentation { state, stop, .. } = presentation;
    let mut setup = true;
    let mut busy = true;
    // An encoded delta remains immutable until the sole writer accepts it.
    // Later native input can advance without producing another delta.
    let mut ready = None;
    let mut deadline = None;
    let mut redraw_at = None;
    loop {
        if stop.load(Ordering::Acquire) {
            return Ok(());
        }
        {
            let inbox = state.lock().unwrap();
            if inbox.quit {
                return Ok(());
            }
            if let Some(error) = &inbox.error {
                return Err(error.clone());
            }
        }
        let mut writable = output.poll()?;
        if writable && output.take_flushed().is_some() && setup {
            state.lock().unwrap().graphics.flushed();
            setup = false;
        }
        if busy {
            match frames.try_recv() {
                Ok(frame) => {
                    let frame = frame?;
                    if frame.quit {
                        return Ok(());
                    }
                    busy = false;
                    deadline = frame.deadline;
                    redraw_at = frame.redraw_at;
                    if let Some(bytes) = frame.bytes {
                        debug_assert!(ready.is_none());
                        ready = Some(bytes);
                    }
                }
                Err(mpsc::TryRecvError::Disconnected) => return Err("NSH UI worker stopped".into()),
                Err(mpsc::TryRecvError::Empty) => {}
            }
        }
        if writable {
            if let Some(bytes) = ready.take() {
                output.submit([bytes])?;
                writable = false;
            } else if let Some(query) = state.lock().unwrap().graphics.query() {
                output.submit([query.to_vec()])?;
                setup = true;
                writable = false;
            }
        }
        if !busy {
            // Consume only the notification whose work this advance handles.
            // A wake during or after the send remains pending for the next one.
            let woken = pending.swap(false, Ordering::AcqRel);
            let mut inbox = state.lock().unwrap();
            let command = ui::Advance {
                image_protocol: inbox.graphics.take_ready(),
                inputs: inbox.pop_batch(),
                resize: inbox.resize.take(),
                cancel_pointer: std::mem::take(&mut inbox.cancel_pointer),
                draw: writable && !setup && ready.is_none(),
            };
            if !command.is_probe()
                || woken
                || deadline.is_some_and(|due| due <= Instant::now())
                || (command.draw && redraw_at.is_some_and(|due| due <= Instant::now()))
            {
                commands
                    .try_send(command)
                    .map_err(|error| error.to_string())?;
                busy = true;
            }
        }
        // Input, UI completion and writer receipts unpark this driver. Timer
        // deadlines are real engine deadlines. TICK bounds external AtomicBool
        // cancellation; silent native jobs also retain their idle recheck.
        let next = (!busy)
            .then(|| {
                deadline
                    .into_iter()
                    .chain(
                        (writable && !setup && ready.is_none())
                            .then_some(redraw_at)
                            .flatten(),
                    )
                    .min()
            })
            .flatten();
        let wait = next.map_or(TICK, |due| {
            due.saturating_duration_since(Instant::now()).min(TICK)
        });
        thread::park_timeout(wait);
    }
}

/// An opted-in sender finishes its native composition before acknowledging
/// focus0. Keep decoding that FIFO during the existing best-effort restoration
/// window. Cancellation cannot wait forever for blocked IO or a missing peer ACK;
/// an incomplete release is reported instead of claiming the FIFO was drained.
fn close_text_input(
    output: &mut Output,
    presentation: &Presentation,
    reader: Option<&Reader>,
    deadline: Instant,
) -> Result<(), String> {
    let bytes = presentation
        .state
        .lock()
        .unwrap()
        .pixels
        .as_mut()
        .and_then(pixels::Inbox::close_text_input);
    let Some(bytes) = bytes else { return Ok(()) };
    let mut release = Some(bytes);
    loop {
        let writable = output.poll()?;
        let state = presentation.state.lock().unwrap();
        if writable
            && release.is_none()
            && state
                .pixels
                .as_ref()
                .is_some_and(|inbox| inbox.text_input.closed())
        {
            return Ok(());
        }
        if reader.is_some_and(|reader| {
            reader.stop.load(Ordering::Acquire)
                || reader
                    .handle
                    .as_ref()
                    .is_none_or(thread::JoinHandle::is_finished)
        }) {
            return Err(state.error.clone().unwrap_or_else(|| {
                "terminal text-input release incomplete: input ended before acknowledgement".into()
            }));
        }
        drop(state);
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(
                "terminal text-input release is still pending; terminal restoration incomplete"
                    .into(),
            );
        }
        if writable && let Some(bytes) = release.take() {
            output.take_flushed();
            presentation
                .state
                .lock()
                .unwrap()
                .pixels
                .as_mut()
                .unwrap()
                .text_input
                .release_submitted();
            output.submit([bytes])?;
        }
        thread::park_timeout(remaining);
    }
}

fn start_reader(presentation: Presentation, reader: EventReader) -> Result<Reader, String> {
    // Reader lifetime extends through the negotiated focus0 handshake even
    // after external cancellation has stopped the UI and output driver.
    let stop = Arc::new(AtomicBool::new(false));
    let reading = stop.clone();
    let waker = reader.waker();
    let handle = thread::Builder::new()
        .name("maka-nsh-input".into())
        .spawn(move || {
            let Presentation { state, .. } = &presentation;
            while !reading.load(Ordering::Acquire) {
                {
                    let mut inbox = state.lock().unwrap();
                    // Keep polling and decoding in FIFO order, without
                    // waiting for stdin while holding the input lock.
                    for _ in 0..input::READ_BATCH {
                        let event = reader
                            .poll(Some(Duration::ZERO), |_| true)
                            .and_then(|ready| {
                                if ready {
                                    reader.read(|_| true).map(Some)
                                } else {
                                    Ok(None)
                                }
                            });
                        let event = match event {
                            Ok(Some(event)) => event,
                            Ok(None) => break,
                            Err(error) => {
                                inbox.error = Some(error.to_string());
                                reading.store(true, Ordering::Release);
                                presentation.wake_driver();
                                return;
                            }
                        };
                        presentation.wake_driver();
                        inbox.graphics.observe(&event);
                        {
                            let graphics_response =
                                inbox.pixel_probe.check_graphics_response(&event);
                            inbox.pixel_probe.observe(&event, Instant::now());
                            let sixel_geometry = inbox.pixel_probe.sixel_geometry;
                            let tracing = inbox.trace.is_some();
                            if let Some(pixels) = &mut inbox.pixels {
                                let geometry = pixels.geometry;
                                let resizing = matches!(&event, termina::Event::WindowResized(_))
                                    || pixels.capabilities.sixel_geometry != sixel_geometry;
                                let completed = (tracing
                                    && resizing
                                    && pixels.capabilities.protocol
                                        == Some(pixels::Protocol::Sixel))
                                .then(|| pixels.completed_frames().collect::<Vec<_>>());
                                let result = graphics_response
                                    .and_then(|()| pixels.set_sixel_geometry(sixel_geometry))
                                    .and_then(|()| pixels.push(event));
                                if let Some(wake) = &pixels.wake {
                                    wake.unpark();
                                }
                                let resized = pixels.geometry != geometry;
                                if resized
                                    && let (Some(completed), Some(trace)) =
                                        (completed, &mut inbox.trace)
                                {
                                    for offer in completed {
                                        trace.discard(&offer.token, offer.geometry, "resize");
                                    }
                                }
                                match result {
                                    Ok(true) => inbox.quit = true,
                                    Ok(false) => {}
                                    Err(error) => inbox.error = Some(error),
                                }
                                if inbox.quit || inbox.error.is_some() {
                                    break;
                                }
                                continue;
                            }
                        }
                        inbox.push_terminal(event);
                        if inbox.quit || inbox.error.is_some() || reading.load(Ordering::Acquire) {
                            break;
                        }
                    }
                }
                if !reading.load(Ordering::Acquire) {
                    match reader.wait_ready() {
                        Ok(()) => {}
                        Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                        Err(error) => {
                            state.lock().unwrap().error = Some(error.to_string());
                            reading.store(true, Ordering::Release);
                            presentation.wake_driver();
                            return;
                        }
                    }
                }
            }
            presentation.wake_driver();
        })
        .map_err(|error| error.to_string())?;
    Ok(Reader {
        stop,
        waker,
        handle: Some(handle),
    })
}

struct Reader {
    stop: Arc<AtomicBool>,
    waker: termina::PlatformWaker,
    handle: Option<thread::JoinHandle<()>>,
}

impl Drop for Reader {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        let _ = self.waker.wake();
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn an_idle_unicode_driver_waits_for_work_and_coalesces_engine_wakes() {
        let (started, initial) = mpsc::sync_channel(1);
        let (commands, worker) = mpsc::sync_channel(1);
        let (frames, receive) = mpsc::sync_channel(1);
        let pending = Arc::new(AtomicBool::new(false));
        let stop = Arc::new(AtomicBool::new(false));
        let driver = {
            let pending = pending.clone();
            let stop = stop.clone();
            thread::spawn(move || {
                let presentation = Presentation {
                    stop,
                    ..Default::default()
                };
                let mut output = Output::new(io::sink()).unwrap();
                output.submit([b"SETUP".to_vec()]).unwrap();
                started.send(thread::current()).unwrap();
                drive(&mut output, &presentation, &commands, &receive, &pending)
            })
        };
        let wake = initial.recv_timeout(Duration::from_secs(2)).unwrap();
        let idle = || ui::Frame {
            bytes: None,
            quit: false,
            deadline: None,
            redraw_at: None,
        };
        frames.send(Ok(idle())).unwrap();
        wake.unpark();
        assert!(matches!(
            worker.recv_timeout(Duration::from_millis(100)),
            Err(mpsc::RecvTimeoutError::Timeout)
        ));
        pending.store(true, Ordering::Release);
        wake.unpark();
        let command = worker.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(command.is_probe());
        assert!(command.draw);
        // Completions while this advance is in flight coalesce into the next
        // one, rather than being lost when its frame arrives.
        for _ in 0..3 {
            pending.store(true, Ordering::Release);
            wake.unpark();
        }
        frames.send(Ok(idle())).unwrap();
        wake.unpark();
        let command = worker.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(command.is_probe());
        assert!(command.draw);
        frames.send(Ok(idle())).unwrap();
        wake.unpark();
        assert!(matches!(
            worker.recv_timeout(Duration::from_millis(100)),
            Err(mpsc::RecvTimeoutError::Timeout)
        ));
        stop.store(true, Ordering::Release);
        wake.unpark();
        driver.join().unwrap().unwrap();
    }

    #[test]
    fn blocked_stdout_does_not_prevent_independent_cancel() {
        for external in [false, true] {
            blocked_cancel(external);
        }
    }

    fn blocked_cancel(external: bool) {
        struct Blocked {
            entered: mpsc::SyncSender<()>,
            resume: mpsc::Receiver<()>,
            bytes: Arc<Mutex<Vec<u8>>>,
        }
        impl Write for Blocked {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                if bytes == b"FRAME" {
                    let _ = self.entered.send(());
                    self.resume
                        .recv()
                        .map_err(|_| io::Error::other("gate closed"))?;
                }
                self.bytes.lock().unwrap().extend_from_slice(bytes);
                Ok(bytes.len())
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        let state = Arc::new(Mutex::new(Inbox::default()));
        let mut pixel_input = pixels::Inbox::new(
            pixels::Capabilities {
                size: termina::WindowSize {
                    cols: 80,
                    rows: 24,
                    pixel_width: Some(640),
                    pixel_height: Some(384),
                },
                mouse: pixels::MouseCoordinates::Cells,
                protocol: Some(pixels::Protocol::Sixel),
                synchronized: false,
                sixel_geometry: Default::default(),
                ui_scale: 1.0,
            },
            false,
        );
        assert!(pixel_input.text_input.enable());
        state.lock().unwrap().pixels = Some(pixel_input);
        let stop = Arc::new(AtomicBool::new(false));
        let (entered, observing) = mpsc::sync_channel(1);
        let (resume, gate) = mpsc::channel();
        let written = Arc::new(Mutex::new(Vec::new()));
        let mut output = Output::new(Blocked {
            entered,
            resume: gate,
            bytes: written.clone(),
        })
        .unwrap();
        output.submit([b"SETUP".to_vec()]).unwrap();
        let (commands, _worker) = mpsc::sync_channel(1);
        let (frames, receive) = mpsc::sync_channel(1);
        frames
            .send(Ok(ui::Frame {
                bytes: Some(b"FRAME".to_vec()),
                quit: false,
                deadline: None,
                redraw_at: None,
            }))
            .unwrap();
        let (finished, result) = mpsc::sync_channel(1);
        let presentation = Presentation {
            state: state.clone(),
            stop: stop.clone(),
            ..Default::default()
        };
        thread::spawn(move || {
            let result = drive(
                &mut output,
                &presentation,
                &commands,
                &receive,
                &AtomicBool::new(false),
            );
            let release = close_text_input(
                &mut output,
                &presentation,
                None,
                Instant::now() + RESTORATION_WAIT,
            );
            let mut cleanup = pixels::cleanup(&presentation, release.is_err());
            cleanup.extend_from_slice(CLEANUP);
            let cleanup = output.close(cleanup).unwrap();
            let _ = finished.send((result, release, cleanup));
        });
        observing.recv_timeout(Duration::from_secs(1)).unwrap();
        if external {
            stop.store(true, Ordering::Release);
        } else {
            state.lock().unwrap().quit = true;
        }
        // The caller can now run Host close/recovery while stdout is still
        // held by the test gate. No UI engine or output join is required.
        let (driver, release, cleanup) = result.recv_timeout(Duration::from_secs(2)).unwrap();
        driver.unwrap();
        assert!(
            release
                .unwrap_err()
                .contains("text-input release is still pending")
        );
        assert!(matches!(cleanup.try_recv(), Err(mpsc::TryRecvError::Empty)));
        resume.send(()).unwrap();
        cleanup
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .unwrap();
        let bytes = written.lock().unwrap();
        let release = b"\x1b]777;nsh-text-input;focus;0\x1b\\";
        assert_eq!(
            bytes
                .windows(release.len())
                .filter(|part| *part == release)
                .count(),
            1
        );
        assert!(bytes.starts_with(b"SETUPFRAME"));
        assert!(bytes.ends_with(CLEANUP));
    }
}
