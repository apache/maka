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

use super::output::FrameWriter;
use crossterm::event::{Event, MouseEventKind};
use nsh_core::{MountBatch, platform::Environment};
use nsh_engine::{EngineConfig, LocalEngine, MountSink};
use nsh_platform_tui::{
    CellMetrics, ImageProtocol, ProtocolType, ServiceOutput, ServiceRequest, Surface, SurfaceEvent,
    TerminalTextEngine,
};
use ratatui::{
    Terminal, TerminalOptions, Viewport,
    backend::{Backend, CrosstermBackend},
    layout::Rect,
};
use std::{
    io,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::Instant,
};

#[derive(Default)]
struct Commits {
    batches: Vec<MountBatch>,
    error: Option<String>,
    frame: bool,
}

#[derive(Clone, Default)]
struct Sink(Arc<Mutex<Commits>>);

impl MountSink for Sink {
    fn submit(&self, batch: MountBatch) {
        self.0.lock().unwrap().batches.push(batch);
    }
    fn report_error(&self, message: &str) {
        self.0.lock().unwrap().error = Some(message.into());
    }
    fn request_frame(&self) {
        self.0.lock().unwrap().frame = true;
    }
}

pub(super) struct Frame {
    pub bytes: Option<Vec<u8>>,
    pub quit: bool,
    pub deadline: Option<Instant>,
    pub redraw_at: Option<Instant>,
}

pub(super) struct Advance {
    pub image_protocol: Option<ImageProtocol>,
    pub inputs: Vec<Event>,
    pub resize: Option<(u16, u16)>,
    pub cancel_pointer: bool,
    /// Output backpressure delays drawing, never ordinary native input.
    pub draw: bool,
}

impl Advance {
    pub fn is_probe(&self) -> bool {
        self.inputs.is_empty()
            && self.resize.is_none()
            && !self.cancel_pointer
            && self.image_protocol.is_none()
    }
}

type Frames = mpsc::Receiver<Result<Frame, String>>;

pub(super) fn spawn(
    config: EngineConfig,
    pending: Arc<AtomicBool>,
    driver: thread::Thread,
) -> io::Result<(mpsc::SyncSender<Advance>, Frames)> {
    let (send, commands) = mpsc::sync_channel::<Advance>(1);
    let (frames, receive) = mpsc::sync_channel(1);
    thread::Builder::new()
        .name("maka-nsh-ui".into())
        .spawn(move || {
            let mut session = match Session::new(config) {
                Ok(session) => session,
                Err(error) => {
                    let _ = frames.send(Err(error));
                    driver.unpark();
                    return;
                }
            };
            let wake = driver.clone();
            session.set_wake(Arc::new(move || {
                pending.store(true, Ordering::Release);
                wake.unpark();
            }));
            if frames.send(session.initial_frame()).is_err() {
                return;
            }
            driver.unpark();
            while let Ok(command) = commands.recv() {
                let result = session.advance(command);
                let failed = result.is_err();
                if frames.send(result).is_err() {
                    return;
                }
                driver.unpark();
                if failed {
                    return;
                }
            }
        })?;
    Ok((send, receive))
}

struct Session {
    engine: Option<LocalEngine<TerminalTextEngine>>,
    config: EngineConfig,
    reloading: Option<tokio::sync::mpsc::UnboundedReceiver<maka_workbench::reload::Request>>,
    wake: Option<Arc<dyn Fn() + Send + Sync>>,
    host: nsh_engine::HostChannel,
    surface: Surface,
    environment: Environment,
    sink: Sink,
    terminal: Terminal<CrosstermBackend<FrameWriter>>,
    area: Rect,
    dirty: bool,
    started: Instant,
    effects: Vec<u8>,
    deadline: Option<Instant>,
    frame_requested: bool,
    last_sent_focus_path: Option<Vec<nsh_core::NodeId>>,
    image_protocol: Option<ImageProtocol>,
}

impl Session {
    fn new(mut config: EngineConfig) -> Result<Self, String> {
        let metrics = CellMetrics::default();
        let columns = (config.viewport.width / metrics.width()).round() as u16;
        let rows = (config.viewport.height / metrics.height()).round() as u16;
        let area = viewport(columns, rows)?;
        let mut surface = Surface::new(area.width, area.height, metrics);
        let access = match &config.app {
            nsh_engine::App::Js(bundle) => bundle.policy.access(),
            nsh_engine::App::Rust(_) => nsh_engine::Policy::default().access(),
        };
        surface.set_access(access);
        surface.set_host_services_enabled(true);
        config.environment.fallback_key_bindings = true;
        surface.set_assets(config.assets.clone());
        let sink = Sink::default();
        let environment = config.environment;
        let host = config.host.clone();
        let reloading = config
            .context
            .get::<maka_workbench::reload::UiReload>()
            .map(|reload| reload.take_requests());
        let engine = LocalEngine::start(
            config.clone(),
            TerminalTextEngine::new(metrics),
            sink.clone(),
        )
        .ok_or("NSH UI engine failed to start")?;
        let terminal = Terminal::with_options(
            CrosstermBackend::new(FrameWriter::default()),
            TerminalOptions {
                viewport: Viewport::Fixed(area),
            },
        )
        .map_err(|error| error.to_string())?;
        Ok(Self {
            engine: Some(engine),
            config,
            reloading,
            wake: None,
            host,
            surface,
            environment,
            sink,
            terminal,
            area,
            dirty: false,
            started: Instant::now(),
            effects: Vec::new(),
            // The first advance obtains the engine's actual timer deadline.
            deadline: Some(Instant::now()),
            frame_requested: false,
            last_sent_focus_path: None,
            image_protocol: None,
        })
    }

    fn engine(&self) -> &LocalEngine<TerminalTextEngine> {
        self.engine.as_ref().expect("the UI engine is running")
    }

    fn engine_mut(&mut self) -> &mut LocalEngine<TerminalTextEngine> {
        self.engine.as_mut().expect("the UI engine is running")
    }

    fn set_wake(&mut self, wake: Arc<dyn Fn() + Send + Sync>) {
        self.engine_mut().set_wake(wake.clone());
        self.wake = Some(wake);
    }

    fn reload_requests(&mut self) -> Result<bool, String> {
        let mut changed = false;
        while let Some(request) = self
            .reloading
            .as_mut()
            .and_then(|requests| requests.try_recv().ok())
        {
            match request {
                maka_workbench::reload::Request::Pause(ready) => {
                    self.surface.set_input_paused(true);
                    self.engine()
                        .control()
                        .advance_clock(std::time::Duration::ZERO, || {});
                    self.deadline = self.engine_mut().pump();
                    changed |= self.apply_commits()?;
                    self.engine()
                        .control()
                        .advance_clock(std::time::Duration::ZERO, move || {
                            let _ = ready.send(Ok(()));
                        });
                    self.deadline = self.engine_mut().pump();
                    changed |= self.apply_commits()?;
                }
                maka_workbench::reload::Request::Resume => self.surface.set_input_paused(false),
                maka_workbench::reload::Request::Reload => {
                    self.reload()?;
                    changed = true;
                }
            }
        }
        Ok(changed)
    }

    fn reload(&mut self) -> Result<(), String> {
        let mut config = self.config.clone();
        config.viewport = self.surface.viewport();
        config.environment = self.environment;
        let metrics = self.surface.metrics();
        let sink = Sink::default();
        let mut surface = Surface::new(self.area.width, self.area.height, metrics);
        surface.set_access(match &config.app {
            nsh_engine::App::Js(bundle) => bundle.policy.access(),
            nsh_engine::App::Rust(_) => nsh_engine::Policy::default().access(),
        });
        surface.set_host_services_enabled(true);
        surface.set_assets(config.assets.clone());
        surface.set_image_protocol(self.image_protocol);
        // Detach the old VM before another attaches to the same host channel.
        drop(self.engine.take());
        let mut engine = LocalEngine::start(config, TerminalTextEngine::new(metrics), sink.clone())
            .ok_or("NSH UI engine failed to reload")?;
        if let Some(wake) = &self.wake {
            engine.set_wake(wake.clone());
        }
        self.engine = Some(engine);
        self.surface = surface;
        self.sink = sink;
        self.started = Instant::now();
        self.last_sent_focus_path = None;
        self.frame_requested = true;
        self.deadline = Some(Instant::now());
        self.dirty = true;
        Ok(())
    }

    fn initial_frame(&mut self) -> Result<Frame, String> {
        self.apply_commits()?;
        self.begin_frame();
        self.encode(true)
    }

    fn advance(&mut self, command: Advance) -> Result<Frame, String> {
        let mut changed = false;
        if command.cancel_pointer {
            self.cancel_pointer()?;
            changed = true;
        }
        if let Some((columns, rows)) = command.resize {
            self.surface.set_image_protocol(None);
            self.image_protocol = None;
            self.area = viewport(columns, rows)?;
            self.surface.resize(self.area.width, self.area.height);
            self.sync_focus_path();
            self.environment.window = self.surface.viewport();
            let control = self.engine().control();
            control.resize(self.environment.window);
            control.set_environment(self.environment);
            // The supplied area is authoritative. Ratatui's resize path queries
            // the process TTY even for a Fixed viewport, but this backend only
            // encodes into memory for the separate physical output owner.
            let mut terminal = Terminal::with_options(
                CrosstermBackend::new(FrameWriter::default()),
                TerminalOptions {
                    viewport: Viewport::Fixed(self.area),
                },
            )
            .map_err(|error| error.to_string())?;
            crossterm::queue!(
                terminal.backend_mut().writer_mut(),
                crossterm::terminal::Clear(crossterm::terminal::ClearType::All)
            )
            .map_err(|error| error.to_string())?;
            self.terminal = terminal;
            changed = true;
        }
        if let Some(protocol) = command.image_protocol {
            if protocol.protocol_type() != ProtocolType::Sixel {
                return Err("this shell only negotiates stateless Sixel images".into());
            }
            self.surface.set_image_protocol(Some(protocol));
            self.image_protocol = Some(protocol);
            changed = true;
        }
        for event in command.inputs {
            super::interrupt::activity(&self.host, &event);
            changed |= match event {
                Event::Mouse(mouse)
                    if matches!(
                        mouse.kind,
                        MouseEventKind::ScrollUp
                            | MouseEventKind::ScrollDown
                            | MouseEventKind::ScrollLeft
                            | MouseEventKind::ScrollRight
                    ) =>
                {
                    self.surface.handle_wheel(mouse, 1) != 0
                }
                event => self.surface.handle_event(event),
            };
            self.forward_events()?;
            // The next physical event sees the ordinary native tree after
            // every callback from this event has reached the application.
            self.deadline = self.engine_mut().pump();
            changed |= self.reload_requests()?;
            changed |= self.apply_commits()?;
        }
        if command.draw {
            self.begin_frame();
        }
        self.deadline = self.engine_mut().pump();
        changed |= self.reload_requests()?;
        changed |= self.apply_commits()?;
        changed |= self.surface.tick(self.started.elapsed().as_secs_f64());
        self.forward_events()?;
        self.dirty |= changed;
        if command.draw {
            let dirty = std::mem::take(&mut self.dirty);
            self.encode(dirty)
        } else {
            Ok(self.frame(None))
        }
    }

    fn cancel_pointer(&mut self) -> Result<(), String> {
        self.surface.pointer_left();
        self.forward_events()
    }

    fn begin_frame(&mut self) {
        // Paced List overscan and animation callbacks advance once per draw,
        // independently of how often input or engine work needs pumping.
        if std::mem::take(&mut self.frame_requested) {
            self.engine().control().frame();
        }
    }

    fn forward_events(&mut self) -> Result<(), String> {
        let events: Vec<_> = self.surface.drain_events().collect();
        self.dispatch_events(events)
    }

    fn dispatch_events(&mut self, events: Vec<SurfaceEvent>) -> Result<(), String> {
        self.sync_focus_path();
        let control = self.engine().control();
        for event in events {
            match event {
                SurfaceEvent::Event(id, event, payload) => {
                    control.dispatch_event(id, event, payload)
                }
                SurfaceEvent::HintObservation(observation) => control.observe_hint(observation),
                SurfaceEvent::Scroll(id, offset, applied) => control.scroll(id, offset, applied),
                SurfaceEvent::InputScroll(id, offset, content, viewport) => {
                    control.input_scroll(id, offset, content, viewport);
                }
                SurfaceEvent::ListCellRetired(id, request, retired) => {
                    control.set_focus_path(self.surface.focus_path());
                    control.retire_list_cell(id, request, retired);
                }
                SurfaceEvent::States(id, states) => control.set_states(id, states),
                SurfaceEvent::AnimationsFinished(finished) => control.animations_finished(finished),
                SurfaceEvent::ComponentSize(id, size) => control.set_component_size(id, size),
                SurfaceEvent::Zoom(id, scale) => control.zoom(id, scale),
                SurfaceEvent::RootSize(id, size, insets) => control.set_root_size(id, size, insets),
                SurfaceEvent::Service(ServiceRequest::ClipboardWrite(text)) => {
                    let sequence = ServiceOutput::Clipboard(text)
                        .terminal_sequence(std::env::var_os("TMUX").is_some());
                    self.effects.extend_from_slice(sequence.as_bytes());
                }
                SurfaceEvent::Service(ServiceRequest::ClipboardRead { id, has_only }) => {
                    self.surface.complete_clipboard(
                        id,
                        has_only,
                        Err("this shell cannot read the system clipboard".into()),
                    );
                }
                SurfaceEvent::Service(ServiceRequest::ClipboardPaste(edit)) => {
                    self.surface.complete_paste(
                        edit,
                        Err("paste through the terminal's bracketed-paste command".into()),
                    );
                }
                SurfaceEvent::Service(_) => {
                    return Err("terminal host services are unavailable in this slice".into());
                }
            }
        }
        Ok(())
    }

    fn sync_focus_path(&mut self) {
        let path = self.surface.focus_path();
        if self.last_sent_focus_path.as_ref() != Some(&path) {
            self.engine().control().set_focus_path(path.clone());
            self.last_sent_focus_path = Some(path);
        }
    }

    fn apply_commits(&mut self) -> Result<bool, String> {
        let mut commits = std::mem::take(&mut *self.sink.0.lock().unwrap());
        if let Some(error) = commits.error {
            return Err(error);
        }
        let changed = !commits.batches.is_empty();
        // Every delta is necessary. In particular Create/Insert and later
        // prop/text deltas cannot be coalesced to the last MountBatch.
        for batch in commits.batches.drain(..) {
            self.surface.apply(batch);
        }
        self.forward_events()?;
        self.frame_requested |= commits.frame;
        Ok(changed)
    }

    fn encode(&mut self, changed: bool) -> Result<Frame, String> {
        if !changed && self.effects.is_empty() {
            return Ok(self.frame(None));
        }
        // The UI paints its caret; the hidden terminal cursor still anchors IME.
        let writer = self.terminal.backend_mut().writer_mut();
        crossterm::queue!(writer, crossterm::terminal::BeginSynchronizedUpdate)
            .map_err(|error| error.to_string())?;
        self.surface
            .render(self.area, self.terminal.current_buffer_mut());
        self.terminal.flush().map_err(|error| error.to_string())?;
        self.terminal
            .hide_cursor()
            .map_err(|error| error.to_string())?;
        let cursor = self
            .surface
            .input_cursor_position(self.area)
            .unwrap_or_else(|| (self.area.x, self.area.y).into());
        self.terminal
            .set_cursor_position(cursor)
            .map_err(|error| error.to_string())?;
        crossterm::queue!(
            self.terminal.backend_mut().writer_mut(),
            crossterm::terminal::EndSynchronizedUpdate
        )
        .map_err(|error| error.to_string())?;
        self.terminal.swap_buffers();
        Backend::flush(self.terminal.backend_mut()).map_err(|error| error.to_string())?;
        let mut bytes = std::mem::take(&mut self.terminal.backend_mut().writer_mut().0);
        // Complete clipboard effects share this immutable physical write
        // and its original flush receipt.
        bytes.append(&mut self.effects);
        Ok(self.frame(Some(bytes)))
    }

    fn frame(&self, bytes: Option<Vec<u8>>) -> Frame {
        let redraw_at = if self.dirty || self.frame_requested || !self.effects.is_empty() {
            Some(Instant::now())
        } else if self.surface.animating() {
            // Native jobs expose pending work, not completion notifications.
            // An animation that produced output follows the writer receipt;
            // a silent pending job keeps the existing idle recheck interval.
            Some(
                Instant::now()
                    + if bytes.is_some() {
                        std::time::Duration::ZERO
                    } else {
                        super::TICK
                    },
            )
        } else {
            None
        };
        Frame {
            bytes,
            quit: self.surface.should_quit(),
            deadline: if self.engine().needs_pump() {
                Some(Instant::now())
            } else {
                self.deadline
            },
            redraw_at,
        }
    }
}

fn viewport(columns: u16, rows: u16) -> Result<Rect, String> {
    let area = Rect::new(0, 0, columns.max(1), rows.max(1));
    if usize::from(area.width) * usize::from(area.height) > 1_048_576 {
        return Err("terminal viewport exceeds cell limit".into());
    }
    Ok(area)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::{
        KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
    };
    use nsh_core::{MountItem, ROOT_ID, ViewKind};
    use nsh_engine::{App, Bundle, Limits};
    use std::io::Write;

    fn config(source: &str) -> EngineConfig {
        let mut config = EngineConfig::new(App::Js(Bundle::source(source.to_owned())));
        config.viewport = CellMetrics::default().viewport(40, 8);
        config.environment.renderer = nsh_core::platform::Renderer::Terminal;
        config.header_heights = nsh_core::NO_NATIVE_HEADER;
        config.limits = Limits::default();
        config.ui_sets = vec![nsh_base::registry()];
        config
    }

    #[test]
    fn background_host_reply_frame_and_timer_reach_unicode_output_without_input() {
        use nsh_core::prelude::*;

        struct HostReply(Mutex<Option<tokio::sync::oneshot::Receiver<()>>>);
        #[component]
        fn BackgroundReply() -> impl IntoElement {
            let reply = engine_context::<HostReply>()
                .unwrap()
                .0
                .lock()
                .unwrap()
                .take()
                .unwrap();
            let host = signal("");
            let frame = signal("");
            let timed = signal("");
            spawn(async move {
                reply.await.unwrap();
                host.set("HOST_REPLY");
                request_animation_frame(move |_| frame.set("FRAME_READY"));
                set_timeout(std::time::Duration::from_millis(40), move || {
                    timed.set("TIMER_READY");
                });
            });
            view()
                .child(text("WAITING"))
                .child(text(move || host.get()))
                .child(text(move || frame.get()))
                .child(text(move || timed.get()))
        }
        struct Capture {
            bytes: Vec<u8>,
            flushed: mpsc::Sender<Vec<u8>>,
        }
        impl Write for Capture {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                self.bytes.extend_from_slice(bytes);
                Ok(bytes.len())
            }
            fn flush(&mut self) -> io::Result<()> {
                let _ = self.flushed.send(std::mem::take(&mut self.bytes));
                Ok(())
            }
        }
        let (reply, response) = tokio::sync::oneshot::channel();
        let mut options = config("");
        options.app = App::Rust(nsh_core::element::Root::of::<BackgroundReply>());
        options.context = options.context.with(HostReply(Mutex::new(Some(response))));
        let (flushed, output) = mpsc::channel();
        let (started, start) = mpsc::sync_channel(1);
        let stop = Arc::new(AtomicBool::new(false));
        let driver = {
            let stop = stop.clone();
            thread::spawn(move || {
                let presentation = super::super::Presentation {
                    stop,
                    ..Default::default()
                };
                let pending = Arc::new(AtomicBool::new(false));
                let (commands, frames) =
                    super::spawn(options, pending.clone(), thread::current()).unwrap();
                let mut output = super::super::output::Output::new(Capture {
                    bytes: Vec::new(),
                    flushed,
                })
                .unwrap();
                output.submit([b"SETUP".to_vec()]).unwrap();
                started.send(thread::current()).unwrap();
                super::super::drive(&mut output, &presentation, &commands, &frames, &pending)
            })
        };
        let wake = start
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap();
        let mut bytes = Vec::new();
        let deadline = Instant::now() + std::time::Duration::from_secs(5);
        let mut await_text = |expected: &str| -> Result<(), mpsc::RecvTimeoutError> {
            while !bytes
                .windows(expected.len())
                .any(|part| part == expected.as_bytes())
            {
                bytes.extend(
                    output.recv_timeout(deadline.saturating_duration_since(Instant::now()))?,
                );
            }
            Ok(())
        };
        let observed = (|| {
            await_text("WAITING")?;
            reply.send(()).unwrap();
            await_text("HOST_REPLY")?;
            await_text("FRAME_READY")?;
            await_text("TIMER_READY")
        })();
        stop.store(true, Ordering::Release);
        wake.unpark();
        driver.join().unwrap().unwrap();
        observed.unwrap();
    }

    #[test]
    fn unchanged_and_cleared_native_focus_settle_without_idle_engine_work() {
        let mut session = Session::new(config(
            r#"
            import { mount } from "nsh";
            import { element, prop } from "nsh:rt";
            mount(() => {
                const input = element("input");
                prop(input, "autoFocus", true);
                prop(input, "value", "kept draft");
                return input;
            });
            "#,
        ))
        .unwrap();
        session.initial_frame().unwrap();
        let editor = session.surface.input_context().unwrap();
        assert_eq!(editor.text.as_deref(), Some("kept draft"));
        let deadline = Instant::now() + std::time::Duration::from_secs(2);
        for clear in [false, true] {
            if clear {
                session.sink.submit(MountBatch {
                    items: vec![MountItem::Command {
                        id: editor.node,
                        command: nsh_core::Command::Blur,
                    }],
                });
            }
            let mut frame = session.advance(command([])).unwrap();
            while session.engine().needs_pump() {
                assert!(Instant::now() < deadline, "native focus never settled");
                frame = session.advance(command([])).unwrap();
            }
            assert!(frame.deadline.is_none_or(|due| due > Instant::now()));
            assert_eq!(frame.redraw_at, None);
            assert_eq!(session.surface.focused(), (!clear).then_some(editor.node));
        }
        assert!(session.surface.focus_path().is_empty());
        assert!(session.surface.snapshot().contains("kept draft"));
    }

    #[test]
    fn production_resize_updates_the_js_window_breakpoint() {
        let mut options = config(
            r#"
            import { mount } from "nsh";
            import { windowSize } from "nsh";
            import { element, insert } from "nsh:rt";
            mount(() => {
                const label = element("text");
                insert(label, () => windowSize().width >= 800 ? "WIDE_WINDOW" : "NARROW_WINDOW");
                return label;
            });
            "#,
        );
        options.environment.window = options.viewport;
        let mut session = Session::new(options).unwrap();
        session.initial_frame().unwrap();
        assert!(session.surface.snapshot().contains("NARROW_WINDOW"));
        for (columns, rows, expected, absent) in [
            (120, 40, "WIDE_WINDOW", "NARROW_WINDOW"),
            (80, 24, "NARROW_WINDOW", "WIDE_WINDOW"),
        ] {
            session
                .advance(Advance {
                    image_protocol: None,
                    inputs: Vec::new(),
                    resize: Some((columns, rows)),
                    cancel_pointer: false,
                    draw: true,
                })
                .unwrap();
            let screen = session.surface.snapshot();
            assert!(screen.contains(expected), "{screen}");
            assert!(!screen.contains(absent), "{screen}");
        }
    }

    #[test]
    fn images_load_and_paint_through_the_production_session() {
        struct ImageAssets;
        impl nsh_engine::Assets for ImageAssets {
            fn read(&self, uri: &str) -> Result<Vec<u8>, String> {
                match uri {
                    "asset:/image.png" => {
                        Ok(include_bytes!("../../../workbench/app/assets/maka.png").to_vec())
                    }
                    _ => Err(format!("Unknown test image: {uri}")),
                }
            }
        }
        let mut options = config(
            r#"
            import { mount, signal } from "nsh";
            import { element, prop, insert, append } from "nsh:rt";
            const status = signal("loading");
            mount(() => {
                const root = element("view");
                const image = element("image");
                prop(image, "src", "asset:/image.png");
                prop(image, "style", { width: 64, height: 64, flexShrink: 0 });
                prop(image, "onLoad", e => status.set("loaded:" + e.size.width + "x" + e.size.height));
                prop(image, "onError", e => status.set("failed:" + e.message));
                const label = element("text");
                insert(label, () => status());
                append(root, image);
                append(root, label);
                return root;
            });
        "#,
        );
        options.assets = Some(Arc::new(ImageAssets));
        let mut session = Session::new(options).unwrap();
        let mut bytes = session.initial_frame().unwrap().bytes.unwrap_or_default();
        let deadline = Instant::now() + std::time::Duration::from_secs(5);
        loop {
            let frame = session
                .advance(Advance {
                    image_protocol: None,
                    inputs: Vec::new(),
                    resize: None,
                    cancel_pointer: false,
                    draw: true,
                })
                .unwrap();
            bytes.extend(frame.bytes.unwrap_or_default());
            let screen = session.surface.snapshot();
            assert!(!screen.contains("failed:"), "{screen}");
            if screen.contains("loaded:1024x1024") {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "fixture image did not load:\n{screen}"
            );
            thread::sleep(std::time::Duration::from_millis(1));
        }
        assert!(
            bytes
                .windows("▀".len())
                .any(|bytes| bytes == "▀".as_bytes()),
            "the real output frame must paint the image's Unicode fallback"
        );

        // Exercise the same image protocol with a large clipboard effect.
        // The test captures FrameWriter bytes without writing real stdout.
        let prepare = |session: &mut Session| {
            // A fresh fixed terminal resets both diff buffers without calling
            // Terminal::clear, whose cursor query would read the real stdin.
            session.terminal = Terminal::with_options(
                CrosstermBackend::new(FrameWriter::default()),
                TerminalOptions {
                    viewport: Viewport::Fixed(session.area),
                },
            )
            .unwrap();
            session
                .terminal
                .backend_mut()
                .writer_mut()
                .write_all(b"\x1b[2JPREFIX")
                .unwrap();
            session.terminal.backend().writer().0.clone()
        };
        let protocol = ImageProtocol::new(ProtocolType::Sixel, 24, 48).unwrap();
        let mut native = session
            .advance(Advance {
                image_protocol: Some(protocol),
                inputs: Vec::new(),
                resize: None,
                cancel_pointer: false,
                draw: true,
            })
            .unwrap()
            .bytes
            .unwrap_or_default();
        let deadline = Instant::now() + std::time::Duration::from_secs(3);
        while !native.windows(2).any(|bytes| bytes == b"\x1bP") {
            assert!(
                Instant::now() < deadline,
                "the real Sixel encoder did not complete"
            );
            native = session
                .advance(Advance {
                    image_protocol: None,
                    inputs: Vec::new(),
                    resize: None,
                    cancel_pointer: false,
                    draw: true,
                })
                .unwrap()
                .bytes
                .unwrap_or_default();
            thread::sleep(std::time::Duration::from_millis(1));
        }
        let resized = session
            .advance(Advance {
                image_protocol: None,
                inputs: Vec::new(),
                resize: Some((40, 8)),
                cancel_pointer: false,
                draw: true,
            })
            .unwrap()
            .bytes
            .unwrap();
        assert!(!resized.windows(2).any(|bytes| bytes == b"\x1bP"));
        assert!(
            resized
                .windows("▀".len())
                .any(|bytes| bytes == "▀".as_bytes())
        );
        let mut restored = session
            .advance(Advance {
                image_protocol: Some(ImageProtocol::new(ProtocolType::Sixel, 24, 48).unwrap()),
                inputs: Vec::new(),
                resize: Some((40, 8)),
                cancel_pointer: false,
                draw: true,
            })
            .unwrap()
            .bytes
            .unwrap_or_default();
        let deadline = Instant::now() + std::time::Duration::from_secs(3);
        while !restored.windows(2).any(|bytes| bytes == b"\x1bP") {
            assert!(
                Instant::now() < deadline,
                "Sixel did not resume after resize"
            );
            restored = session
                .advance(Advance {
                    image_protocol: None,
                    inputs: Vec::new(),
                    resize: None,
                    cancel_pointer: false,
                    draw: true,
                })
                .unwrap()
                .bytes
                .unwrap_or_default();
            thread::sleep(std::time::Duration::from_millis(1));
        }
        let prefix = prepare(&mut session);
        let original = "中😀".repeat(1_200_000);
        let effect = ServiceOutput::Clipboard(original).terminal_sequence(false);
        session.effects.extend_from_slice(effect.as_bytes());
        let frame = session.encode(true).unwrap().bytes.unwrap();
        assert!(frame.len() > 8 * 1024 * 1024);
        assert!(
            frame.starts_with(&prefix),
            "clear and preexisting output precede the complete image and effect"
        );
        assert!(frame.windows(2).any(|bytes| bytes == b"\x1bP"));
        assert!(frame.ends_with(effect.as_bytes()));
        assert_eq!(
            frame
                .windows(7)
                .filter(|bytes| *bytes == b"\x1b]52;c;")
                .count(),
            1
        );
        assert!(session.effects.is_empty());
        assert!(session.encode(false).unwrap().bytes.is_none());
    }

    fn command(events: impl IntoIterator<Item = Event>) -> Advance {
        Advance {
            image_protocol: None,
            inputs: events.into_iter().collect(),
            resize: None,
            cancel_pointer: false,
            draw: true,
        }
    }

    fn mouse(surface: &Surface, label: &str, kind: MouseEventKind, column: u16) -> Event {
        let node = surface
            .accessibility_snapshot()
            .into_iter()
            .find(|node| node.label == label)
            .unwrap_or_else(|| panic!("missing accessibility node: {label}"));
        Event::Mouse(MouseEvent {
            kind,
            column: (node.frame.origin.x.0 / 8.0) as u16 + column,
            row: (node.frame.origin.y.0 / 16.0) as u16,
            modifiers: KeyModifiers::NONE,
        })
    }

    fn click(surface: &Surface, label: &str) -> Vec<Event> {
        [
            MouseEventKind::Moved,
            MouseEventKind::Down(MouseButton::Left),
            MouseEventKind::Up(MouseButton::Left),
        ]
        .into_iter()
        .map(|kind| mouse(surface, label, kind, 0))
        .collect()
    }

    const APP: &str = r#"
        import { mount, signal } from "nsh";
        import { Button } from "nsh/base";
        import { element, prop, insert, append, list } from "nsh:rt";
        const rows = signal([{ id: "A" }]);
        const selected = signal("none");
        mount(() => {
            const root = element("view");
            prop(root, "style", { flex: 1 });
            const result = element("text");
            insert(result, () => "selected:" + selected());
            append(root, result);
            append(root, list({
                get each() { return rows(); },
                estimatedItemSize: 16,
                style: { flex: 1 },
                children: (row) => {
                    const label = element("text");
                    insert(label, () => row().id);
                    return Button({
                        style: { height: 16 },
                        get accessibilityLabel() { return "row:" + row().id; },
                        onPress: () => selected.set(row().id),
                        children: label,
                    });
                }
            }));
            return root;
        });
        requestAnimationFrame(() => rows.set([{ id: "B" }]));
    "#;

    #[test]
    fn a_retained_row_uses_its_current_value_after_a_background_update() {
        // Keep the logical owner while updating its data. Replacing the
        // source object instead deletes the assignment and needs native ACK.
        let source = APP
            .replace(
                "const rows = signal([{ id: \"A\" }]);",
                "const current = signal(\"A\"); const rows = signal([{ get id() { return current(); } }]);",
            )
            .replace(
                "requestAnimationFrame(() => rows.set([{ id: \"B\" }]));",
                "requestAnimationFrame(() => current.set(\"B\"));",
            );
        let mut session = Session::new(config(&source)).unwrap();
        session.initial_frame().unwrap();
        let events = click(&session.surface, "row:A");
        let row = session
            .surface
            .accessibility_snapshot()
            .into_iter()
            .find(|node| node.label == "row:A")
            .unwrap()
            .id;
        let mut background = command([]);
        background.draw = false;
        assert!(session.advance(background).unwrap().bytes.is_none());
        let rebound = session
            .surface
            .accessibility_snapshot()
            .into_iter()
            .find(|node| node.label == "row:B")
            .unwrap()
            .id;
        assert_eq!(
            row, rebound,
            "the virtual list retained its actual native cell"
        );
        session.advance(command(events)).unwrap();
        assert!(session.surface.snapshot().contains("selected:B"));
    }

    #[test]
    fn a_pointer_burst_reaches_the_button_without_an_intermediate_frame() {
        let source = APP.replace(
            "requestAnimationFrame(() => rows.set([{ id: \"B\" }]));",
            "",
        );
        let mut session = Session::new(config(&source)).unwrap();
        session.initial_frame().unwrap();
        let events = click(&session.surface, "row:A");
        session.advance(command(events)).unwrap();
        assert!(session.surface.snapshot().contains("selected:A"));
    }

    #[test]
    fn independent_clicks_resolve_against_the_current_retained_row() {
        let source = APP
            .replace(
                "requestAnimationFrame(() => rows.set([{ id: \"B\" }]));",
                "",
            )
            .replace(
                "onPress: () => selected.set(row().id),",
                "onPress: () => { selected.set(row().id); rows.set([{ id: \"B\" }]); },",
            );
        let mut session = Session::new(config(&source)).unwrap();
        session.initial_frame().unwrap();
        let mut events = click(&session.surface, "row:A");
        events.extend(events.clone());
        session.advance(command(events)).unwrap();
        assert!(session.surface.snapshot().contains("selected:B"));
    }

    #[test]
    fn press_up_and_press_callbacks_from_one_release_both_reach_the_application() {
        let mut session = Session::new(config(
            r#"
            import { mount, signal } from "nsh";
            import { Button } from "nsh/base";
            import { element, prop, insert, append } from "nsh:rt";
            const history = signal("");
            const record = phase => history.set(history() + phase + ";");
            mount(() => {
                const root = element("view");
                const status = element("text");
                prop(status, "style", { height: 16 });
                insert(status, () => "events:" + history());
                append(root, status);
                append(root, Button({
                    accessibilityLabel: "Run",
                    style: { height: 16 },
                    onPressDown: () => record("down"),
                    onPressUp: () => record("up"),
                    onPress: () => record("press"),
                }));
                return root;
            });
            "#,
        ))
        .unwrap();
        session.initial_frame().unwrap();
        let events = click(&session.surface, "Run");
        session.advance(command(events)).unwrap();
        assert!(session.surface.snapshot().contains("events:down;up;press;"));
    }

    #[test]
    fn ordinary_actions_continue_while_frame_callbacks_wait_for_drawing() {
        let mut session = Session::new(config(
            r#"
            import { inputAction, mount, signal } from "nsh";
            import { Button } from "nsh/base";
            import { element, prop, insert, append } from "nsh:rt";
            const status = signal("before");
            const closed = signal(0);
            mount(() => {
                const root = element("view");
                const result = element("text");
                prop(result, "style", { height: 16 });
                insert(result, () => status() + " closed:" + closed());
                append(root, result);
                append(root, Button({
                    accessibilityLabel: "Close",
                    style: { height: 16 },
                    onPress: inputAction(() => closed.update(n => n + 1), null),
                }));
                return root;
            });
            requestAnimationFrame(() => {
                status.set("first");
                requestAnimationFrame(() => {
                    status.set("second");
                    requestAnimationFrame(() => status.set("third"));
                });
            });
            "#,
        ))
        .unwrap();
        session.initial_frame().unwrap();
        assert!(session.surface.snapshot().contains("before closed:0"));
        let mut background = command([]);
        background.draw = false;
        let frame = session.advance(background).unwrap();
        assert!(frame.bytes.is_none());
        assert!(frame.redraw_at.is_some());
        assert!(session.surface.snapshot().contains("first closed:0"));
        let mut events = click(&session.surface, "Close");
        events.extend(events.clone());
        let mut input = command(events);
        input.draw = false;
        assert!(session.advance(input).unwrap().bytes.is_none());
        assert!(session.surface.snapshot().contains("first closed:2"));
        for _ in 0..3 {
            let mut background = command([]);
            background.draw = false;
            let frame = session.advance(background).unwrap();
            assert!(frame.bytes.is_none());
            assert!(frame.redraw_at.is_some());
            assert!(session.surface.snapshot().contains("first closed:2"));
        }
        let frame = session.advance(command([])).unwrap();
        assert!(frame.bytes.is_some());
        assert!(frame.redraw_at.is_some());
        assert!(session.surface.snapshot().contains("second closed:2"));
        let mut input = command(click(&session.surface, "Close"));
        input.draw = false;
        assert!(session.advance(input).unwrap().bytes.is_none());
        assert!(session.surface.snapshot().contains("second closed:3"));
        assert!(session.advance(command([])).unwrap().bytes.is_some());
        assert!(session.surface.snapshot().contains("third closed:3"));
    }

    #[test]
    fn real_click_and_paste_reach_the_application_before_blocked_stdout_completes() {
        struct FrameGate {
            bytes: Arc<Mutex<Vec<u8>>>,
            entered: mpsc::SyncSender<()>,
            release: Option<mpsc::Receiver<()>>,
            flushes: Arc<std::sync::atomic::AtomicUsize>,
        }
        impl Write for FrameGate {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                if bytes != b"SETUP"
                    && let Some(release) = self.release.take()
                {
                    let prefix = bytes.len().min(7);
                    self.bytes
                        .lock()
                        .unwrap()
                        .extend_from_slice(&bytes[..prefix]);
                    self.entered.send(()).unwrap();
                    release
                        .recv()
                        .map_err(|_| io::Error::other("test gate closed"))?;
                    return Ok(prefix);
                }
                self.bytes.lock().unwrap().extend_from_slice(bytes);
                Ok(bytes.len())
            }
            fn flush(&mut self) -> io::Result<()> {
                self.flushes
                    .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Ok(())
            }
        }
        let mut session = Session::new(config(
            r#"
            import { mount, signal } from "nsh";
            import { Button } from "nsh/base";
            import { element, prop, bindProp, insert, append } from "nsh:rt";
            const clicked = signal(0);
            const draft = signal("draft");
            mount(() => {
                const root = element("view");
                const status = element("text");
                prop(status, "style", { height: 16 });
                insert(status, () => "clicked:" + clicked() + " draft:" + draft());
                append(root, status);
                append(root, Button({
                    accessibilityLabel: "Run",
                    style: { height: 16 },
                    onPress: () => clicked.update(n => n + 1),
                }));
                const input = element("input");
                prop(input, "style", { height: 16 });
                prop(input, "accessibilityLabel", "Composer");
                prop(input, "autoFocus", true);
                bindProp(input, "value", draft);
                prop(input, "onChange", ({ value }) => draft.set(value));
                append(root, input);
                return root;
            });
            "#,
        ))
        .unwrap();
        let initial = session.initial_frame().unwrap();
        let initial_bytes = initial.bytes.clone().unwrap();
        assert!(initial_bytes.len() > 7);
        let mut events = click(&session.surface, "Run");
        for kind in [
            MouseEventKind::Moved,
            MouseEventKind::Down(MouseButton::Left),
            MouseEventKind::Up(MouseButton::Left),
        ] {
            events.push(mouse(&session.surface, "Composer", kind, 5));
        }
        events.push(Event::Paste("你好😀".into()));
        let presentation = super::super::Presentation::default();
        let state = presentation.state.clone();
        let stop = presentation.stop.clone();
        let bytes = Arc::new(Mutex::new(Vec::new()));
        let flushes = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let (entered, observing) = mpsc::sync_channel(1);
        let (release, gate) = mpsc::channel();
        let (commands, receive) = mpsc::sync_channel(1);
        let (frames, ready) = mpsc::sync_channel(1);
        frames.send(Ok(initial)).unwrap();
        let driver = {
            let bytes = bytes.clone();
            let flushes = flushes.clone();
            thread::spawn(move || {
                let mut output = super::super::output::Output::new(FrameGate {
                    bytes,
                    entered,
                    release: Some(gate),
                    flushes,
                })
                .unwrap();
                output.submit([b"SETUP".to_vec()]).unwrap();
                let result = super::super::drive(
                    &mut output,
                    &presentation,
                    &commands,
                    &ready,
                    &AtomicBool::new(false),
                );
                let restored = output.close(b"CLEANUP".to_vec()).unwrap();
                (result, restored)
            })
        };
        observing
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap();
        assert_eq!(flushes.load(std::sync::atomic::Ordering::SeqCst), 1);
        {
            let mut inbox = state.lock().unwrap();
            for event in events {
                inbox.push(event);
            }
        }
        let deadline = Instant::now() + std::time::Duration::from_secs(2);
        loop {
            let command = receive
                .recv_timeout(std::time::Duration::from_secs(2))
                .unwrap();
            assert!(
                !command.draw,
                "blocked output must defer drawing, not native input"
            );
            frames.send(session.advance(command)).unwrap();
            let editor = session.surface.input_context().unwrap();
            if editor.text.as_deref() == Some("draft你好😀") {
                assert_eq!(editor.selection, 9..9);
                assert!(
                    session
                        .surface
                        .snapshot()
                        .contains("clicked:1 draft:draft你好😀")
                );
                break;
            }
            assert!(
                Instant::now() < deadline,
                "physical input did not reach the application"
            );
        }
        assert_eq!(
            *bytes.lock().unwrap(),
            [b"SETUP".as_slice(), &initial_bytes[..7]].concat(),
            "the application has changed while the first physical UI frame is still partial",
        );
        assert_eq!(flushes.load(std::sync::atomic::Ordering::SeqCst), 1);
        stop.store(true, std::sync::atomic::Ordering::Release);
        let (result, restored) = driver.join().unwrap();
        result.unwrap();
        assert!(matches!(
            restored.try_recv(),
            Err(mpsc::TryRecvError::Empty)
        ));
        release.send(()).unwrap();
        restored
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap()
            .unwrap();
        assert_eq!(
            *bytes.lock().unwrap(),
            [
                b"SETUP".as_slice(),
                initial_bytes.as_slice(),
                b"CLEANUP".as_slice()
            ]
            .concat(),
            "the sole writer must finish the original frame before cleanup",
        );
        assert_eq!(flushes.load(std::sync::atomic::Ordering::SeqCst), 3);
    }

    #[test]
    fn a_reading_click_owns_escape_before_another_frame_is_drawn() {
        const APP: &str = r#"
            import { mount, signal } from "nsh";
            import { keymap } from "nsh";
            import { element, prop, insert, append } from "nsh:rt";
            const phase = signal("before"), returned = signal(0), stopped = signal(0);
            const useText = USE_TEXT;
            mount(() => {
                const root = element("view");
                prop(root, "style", { flex: 1 });
                const status = element("text");
                prop(status, "style", { height: 16 });
                insert(status, () => phase() + " returned:" + returned() + " stopped:" + stopped());
                append(root, status);
                const request = element("view");
                prop(request, "style", { height: 64 });
                const detail = element(useText ? "text" : "scroll");
                prop(detail, "accessibilityLabel", "Request detail");
                prop(detail, "style", { height: 32 });
                if (useText) {
                    prop(detail, "style", { height: 32, userSelect: "text" });
                    insert(detail, "Physical form decision");
                } else {
                    const content = element("text");
                    prop(content, "style", { height: 160 });
                    insert(content, "Request scroll content");
                    append(detail, content);
                }
                append(request, detail);
                append(root, request);
                const composer = element("view");
                prop(composer, "style", { height: 32 });
                const input = element("input");
                prop(input, "style", { height: 32 });
                prop(input, "value", "Unsent composer draft");
                prop(input, "autoFocus", true);
                append(composer, input);
                append(root, composer);
                keymap.bind("escape", () => returned.update(n => n + 1), {
                    when: "always", within: request,
                });
                keymap.bind("escape", () => stopped.update(n => n + 1), {
                    when: "always", within: composer,
                });
                return root;
            });
            requestAnimationFrame(() => phase.set("after"));
        "#;
        for text in [true, false] {
            let source = APP.replace("USE_TEXT", if text { "true" } else { "false" });
            let mut session = Session::new(config(&source)).unwrap();
            session.initial_frame().unwrap();
            assert_eq!(
                session.surface.input_context().unwrap().text.as_deref(),
                Some("Unsent composer draft"),
            );
            let mut background = command([]);
            background.draw = false;
            session.advance(background).unwrap();
            let mut events = click(&session.surface, "Request detail");
            events.push(Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)));
            let mut input = command(events);
            input.draw = false;
            assert!(session.advance(input).unwrap().bytes.is_none());
            let screen = session.surface.snapshot();
            assert!(
                screen.contains("after returned:1 stopped:0"),
                "text={text}:\n{screen}"
            );
            assert!(screen.contains("Unsent composer draft"), "{screen}");
        }
    }

    #[test]
    fn editor_click_and_drag_preserve_selection_and_paste_while_drawing_is_deferred() {
        const APP: &str = r#"
            import { mount, signal } from "nsh";
            import { element, prop, bindProp, insert, append } from "nsh:rt";
            const status = signal("before");
            const draft = signal("hello");
            mount(() => {
                const root = element("view");
                prop(root, "style", { flex: 1 });
                const result = element("text");
                prop(result, "style", { height: 16 });
                insert(result, () => status() + " draft:" + draft());
                append(root, result);
                const previous = element("input");
                prop(previous, "style", { height: 16 });
                prop(previous, "autoFocus", true);
                prop(previous, "value", "previous");
                append(root, previous);
                const input = element("input");
                prop(input, "style", { height: 16 });
                prop(input, "accessibilityLabel", "Composer");
                bindProp(input, "value", draft);
                prop(input, "onChange", ({ value }) => draft.set(value));
                append(root, input);
                return root;
            });
            requestAnimationFrame(() => status.set("after"));
        "#;
        for (drag, selected, expected, caret) in
            [(false, 2..2, "heXllo", 3..3), (true, 1..4, "hXo", 2..2)]
        {
            let mut session = Session::new(config(APP)).unwrap();
            session.initial_frame().unwrap();
            assert_eq!(
                session.surface.input_context().unwrap().text.as_deref(),
                Some("previous")
            );
            let mut background = command([]);
            background.draw = false;
            session.advance(background).unwrap();
            let mut events = vec![mouse(
                &session.surface,
                "Composer",
                MouseEventKind::Down(MouseButton::Left),
                if drag { 1 } else { 2 },
            )];
            if drag {
                events.push(mouse(
                    &session.surface,
                    "Composer",
                    MouseEventKind::Drag(MouseButton::Left),
                    4,
                ));
            }
            events.push(mouse(
                &session.surface,
                "Composer",
                MouseEventKind::Up(MouseButton::Left),
                if drag { 4 } else { 2 },
            ));
            let mut input = command(events);
            input.draw = false;
            assert!(session.advance(input).unwrap().bytes.is_none());
            let editor = session.surface.input_context().unwrap();
            assert_eq!(editor.text.as_deref(), Some("hello"));
            assert_eq!(editor.selection, selected);
            let mut paste = command([Event::Paste("X".into())]);
            paste.draw = false;
            assert!(session.advance(paste).unwrap().bytes.is_none());
            let editor = session.surface.input_context().unwrap();
            assert_eq!(editor.text.as_deref(), Some(expected));
            assert_eq!(editor.selection, caret);
            let screen = session.surface.snapshot();
            assert!(
                screen.contains(&format!("after draft:{expected}")),
                "{screen}"
            );
            assert!(screen.contains("previous"), "{screen}");
            assert!(session.advance(command([])).unwrap().bytes.is_some());
        }
    }

    #[test]
    fn bracketed_cjk_paste_preserves_the_literal_text_and_utf16_caret() {
        let mut session = Session::new(config(
            r#"
            import { mount, signal } from "nsh";
            import { element, prop, bindProp } from "nsh:rt";
            const draft = signal("a😀中z");
            mount(() => {
                const input = element("input");
                prop(input, "autoFocus", true);
                prop(input, "style", { height: 16 });
                bindProp(input, "value", draft);
                prop(input, "onChange", ({ value }) => draft.set(value));
                return input;
            });
            "#,
        ))
        .unwrap();
        session.initial_frame().unwrap();
        let mut input = command([
            Event::Key(KeyEvent::new(KeyCode::Char('a'), KeyModifiers::CONTROL)),
            Event::Paste("你好😀".into()),
        ]);
        input.draw = false;
        session.advance(input).unwrap();
        let editor = session.surface.input_context().unwrap();
        assert_eq!(editor.text.as_deref(), Some("你好😀"));
        assert_eq!(editor.selection, 4..4);
        let bytes = session.advance(command([])).unwrap().bytes.unwrap();
        assert!(bytes.ends_with(b"\x1b[1;7H\x1b[?2026l"));
        session.sink.submit(MountBatch {
            items: vec![MountItem::Command {
                id: editor.node,
                command: nsh_core::Command::Blur,
            }],
        });
        let bytes = session.advance(command([])).unwrap().bytes.unwrap();
        assert!(bytes.ends_with(b"\x1b[1;1H\x1b[?2026l"));
    }

    #[test]
    fn wheels_then_a_click_use_the_current_viewport_in_fifo_order() {
        let mut session = Session::new(config(
            r#"
            import { mount, signal } from "nsh";
            import { element, prop, insert, append } from "nsh:rt";
            const offset = signal(0);
            const selected = signal("none");
            mount(() => {
                const root = element("view");
                prop(root, "style", { flex: 1 });
                const result = element("text");
                insert(result, () => "offset:" + offset() + " selected:" + selected());
                append(root, result);
                const scroll = element("scroll");
                prop(scroll, "style", { flex: 1 });
                prop(scroll, "onScroll", event => offset.set(event.offset.y));
                for (let row = 0; row < 30; row++) {
                    const node = element("view");
                    prop(node, "style", { height: 16 });
                    prop(node, "accessibilityLabel", "row:" + row);
                    prop(node, "onPress", () => selected.set(String(row)));
                    const label = element("text");
                    insert(label, "Row " + row);
                    append(node, label);
                    append(scroll, node);
                }
                append(root, scroll);
                return root;
            });
            "#,
        ))
        .unwrap();
        session.initial_frame().unwrap();
        let mut events = vec![mouse(&session.surface, "row:0", MouseEventKind::ScrollDown, 0); 3];
        events.extend(click(&session.surface, "row:0"));
        session.advance(command(events)).unwrap();
        assert!(session.surface.snapshot().contains("offset:144 selected:9"));
    }

    #[test]
    fn a_wheel_reaches_the_current_reader_and_preserves_the_composer_draft() {
        const APP: &str = r#"
            import { mount, signal } from "nsh";
            import { element, prop, bindProp, insert, append } from "nsh:rt";
            const owners = signal([{ id: "A" }]);
            const status = signal("before");
            const observed = signal("none");
            const draft = signal("wheel draft");
            mount(() => {
                const root = element("view");
                prop(root, "style", { flex: 1 });
                const result = element("text");
                prop(result, "style", { height: 16 });
                insert(result, () => status() + " " + observed());
                append(root, result);
                insert(root, Each({
                    get of() { return owners(); },
                    key: owner => owner.id,
                    children: owner => {
                        const id = owner().id;
                        const scroll = element("scroll");
                        prop(scroll, "style", { flex: 1 });
                        prop(scroll, "accessibilityLabel", "owner:" + id);
                        prop(scroll, "contentOffset", { y: 144 });
                        prop(scroll, "onScroll", event => observed.set(id + ":" + event.offset.y));
                        for (let row = 0; row < 30; row++) {
                            const node = element("view");
                            prop(node, "style", { height: 16 });
                            prop(node, "accessibilityLabel", "row:" + id + ":" + row);
                            const label = element("text");
                            insert(label, "Row " + id + ":" + row);
                            append(node, label);
                            append(scroll, node);
                        }
                        return scroll;
                    },
                }));
                const input = element("input");
                prop(input, "style", { height: 16, flexShrink: 0 });
                prop(input, "autoFocus", true);
                bindProp(input, "value", draft);
                prop(input, "onChange", ({ value }) => draft.set(value));
                append(root, input);
                return root;
            });
            requestAnimationFrame(() => {
                status.set("after");
                if (REPLACE_OWNER) owners.set([{ id: "B" }]);
            });
        "#;
        for replace_owner in [false, true] {
            let source = APP.replace("REPLACE_OWNER", &replace_owner.to_string());
            let mut session = Session::new(config(&source)).unwrap();
            session.initial_frame().unwrap();
            assert!(session.surface.snapshot().contains("Row A:9"));
            let editor = session.surface.input_context().unwrap();
            let wheel = mouse(&session.surface, "row:A:9", MouseEventKind::ScrollUp, 0);
            let mut background = command([]);
            background.draw = false;
            session.advance(background).unwrap();
            let mut input = command([wheel]);
            input.draw = false;
            session.advance(input).unwrap();
            let owner = if replace_owner { "B" } else { "A" };
            let screen = session.surface.snapshot();
            assert!(screen.contains(&format!("after {owner}:96")), "{screen}");
            assert!(screen.contains(&format!("Row {owner}:6")), "{screen}");
            let current = session.surface.input_context().unwrap();
            assert_eq!(current.node, editor.node);
            assert_eq!(current.text.as_deref(), Some("wheel draft"));
            assert_eq!(current.selection, editor.selection);
        }
    }

    #[test]
    fn cancelled_capture_cannot_complete_on_a_later_release() {
        let source = APP.replace(
            "requestAnimationFrame(() => rows.set([{ id: \"B\" }]));",
            "",
        );
        let mut session = Session::new(config(&source)).unwrap();
        session.initial_frame().unwrap();
        let down = mouse(
            &session.surface,
            "row:A",
            MouseEventKind::Down(MouseButton::Left),
            0,
        );
        let up = mouse(
            &session.surface,
            "row:A",
            MouseEventKind::Up(MouseButton::Left),
            0,
        );
        session.advance(command([down])).unwrap();
        let mut inbox = crate::terminal::input::Inbox::default();
        inbox.push_terminal(termina::Event::MouseLeave);
        inbox.push(up);
        let mut cancel = command(inbox.pop_batch());
        cancel.cancel_pointer = inbox.cancel_pointer;
        session.advance(cancel).unwrap();
        assert!(session.surface.snapshot().contains("selected:none"));
        let events = click(&session.surface, "row:A");
        session.advance(command(events)).unwrap();
        assert!(session.surface.snapshot().contains("selected:A"));
    }

    #[test]
    fn mount_deltas_are_applied_in_order_including_create_and_later_value() {
        let mut session = Session::new(config("import { mount } from 'nsh'; import { element } from 'nsh:rt'; mount(() => element('view')); ")).unwrap();
        session.initial_frame().unwrap();
        session.sink.submit(MountBatch {
            items: vec![
                MountItem::Create {
                    id: 900,
                    kind: ViewKind::Input,
                },
                MountItem::Insert {
                    parent: ROOT_ID,
                    child: 900,
                    before: None,
                },
                MountItem::Frame {
                    id: 900,
                    frame: nsh_core::Bounds::new(
                        nsh_core::geometry::point(
                            nsh_core::geometry::px(0.0),
                            nsh_core::geometry::px(0.0),
                        ),
                        nsh_core::geometry::size(
                            nsh_core::geometry::px(160.0),
                            nsh_core::geometry::px(16.0),
                        ),
                    ),
                },
            ],
        });
        session.sink.submit(MountBatch {
            items: vec![MountItem::InputValue {
                id: 900,
                text: "ordered".into(),
                count: 0,
            }],
        });
        assert!(session.apply_commits().unwrap());
        assert!(session.surface.snapshot().contains("ordered"));
    }

    #[test]
    fn ctrl_c_copies_selected_unicode_through_the_same_output_frame() {
        let mut session = Session::new(config(
            r#"
            import { mount } from "nsh";
            import { element, prop, insert } from "nsh:rt";
            mount(() => {
                const node = element("text");
                prop(node, "style", { userSelect: "text" });
                insert(node, "你好A");
                return node;
            });
        "#,
        ))
        .unwrap();
        session.initial_frame().unwrap();
        let command = |key| Advance {
            image_protocol: None,
            inputs: vec![Event::Key(KeyEvent::new(
                KeyCode::Char(key),
                KeyModifiers::CONTROL,
            ))],
            resize: None,
            cancel_pointer: false,
            draw: true,
        };
        session.advance(command('a')).unwrap();
        let copied = session.advance(command('c')).unwrap();
        assert!(!copied.quit);
        let sequence = ServiceOutput::Clipboard("你好A".into())
            .terminal_sequence(std::env::var_os("TMUX").is_some());
        assert!(
            copied
                .bytes
                .unwrap()
                .windows(sequence.len())
                .any(|bytes| bytes == sequence.as_bytes())
        );
    }

    #[test]
    fn large_copy_preserves_the_draft_and_cut_delivers_the_complete_text_once() {
        let mut session = Session::new(config(
            r#"
            import { mount, signal } from "nsh";
            import { element, prop, bindProp } from "nsh:rt";
            const value = signal("x".repeat(1048577) + "😀");
            mount(() => {
                const input = element("input");
                prop(input, "autoFocus", true);
                prop(input, "style", { height: 16 });
                bindProp(input, "value", value);
                prop(input, "onChange", ({ value: text }) => value.set(text));
                return input;
            });
        "#,
        ))
        .unwrap();
        session.initial_frame().unwrap();
        let command = |key, modifiers| Advance {
            image_protocol: None,
            inputs: vec![Event::Key(KeyEvent::new(KeyCode::Char(key), modifiers))],
            resize: None,
            cancel_pointer: false,
            draw: true,
        };
        session
            .advance(command('a', KeyModifiers::CONTROL))
            .unwrap();
        let original = "x".repeat(1_048_577) + "😀";
        for key in ['c', 'x'] {
            let frame = session
                .advance(command(key, KeyModifiers::CONTROL))
                .unwrap();
            assert!(!frame.quit);
            assert_eq!(
                session.surface.input_context().unwrap().text,
                Some(if key == 'c' {
                    original.clone()
                } else {
                    String::new()
                })
            );
            let bytes = frame.bytes.unwrap();
            let sequence = ServiceOutput::Clipboard(original.clone())
                .terminal_sequence(std::env::var_os("TMUX").is_some());
            assert!(
                bytes
                    .windows(sequence.len())
                    .any(|bytes| bytes == sequence.as_bytes())
            );
        }
        session.advance(command('z', KeyModifiers::NONE)).unwrap();
        assert_eq!(
            session.surface.input_context().unwrap().text.as_deref(),
            Some("z")
        );
        session
            .advance(command('a', KeyModifiers::CONTROL))
            .unwrap();
        let cut = session
            .advance(command('x', KeyModifiers::CONTROL))
            .unwrap();
        assert_eq!(
            session.surface.input_context().unwrap().text.as_deref(),
            Some("")
        );
        let sequence = ServiceOutput::Clipboard("z".into())
            .terminal_sequence(std::env::var_os("TMUX").is_some());
        assert!(
            cut.bytes
                .unwrap()
                .windows(sequence.len())
                .any(|bytes| bytes == sequence.as_bytes())
        );
    }
}
