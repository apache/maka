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

use super::support::{Fixture, ModelRequest, Options, ReplyGate, mutate, mutate_service};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use maka_app_client::Client;
use maka_workbench::bindings::Bindings;
#[cfg(target_os = "macos")]
use nsh_platform_macos::TerminalSurface;
#[cfg(windows)]
use nsh_platform_windows::terminal::TerminalSurface;
use nsh_terminal::{
    Bounds, CandidateFrame, Keystroke, Modifiers, MouseButton, MouseDownEvent, MouseMoveEvent,
    MouseUpEvent, NativeSurface, PlatformInput, TextInputTarget, point, px, size,
};
use serde_json::{Value, json};
use sqlx::Connection;
use std::{
    future::Future,
    path::Path,
    rc::Rc,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{Notify, watch};

#[path = "desktop_new_session/rooms.rs"]
mod rooms;

macro_rules! native {
    ($ty:path { $($field:ident: $value:expr),* $(,)? }) => {{
        let mut value = <$ty>::default();
        $(value.$field = $value;)*
        value
    }};
}

const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMQNE5uAAACKAEoAfdvjgAAAABJRU5ErkJggg==";

struct Desktop {
    platform: Rc<TerminalSurface>,
    frame: Arc<Mutex<Option<CandidateFrame>>>,
    host: nsh_engine::HostChannel,
    client: Client,
    bindings: Bindings,
    outcome: Arc<Mutex<Value>>,
    _foreground: watch::Sender<bool>,
    wake: Arc<Notify>,
}

impl Desktop {
    async fn open(fixture: &Fixture, address: &Path) -> Self {
        Self::open_at(
            fixture,
            address,
            size(
                nsh_terminal::DevicePixels(960),
                nsh_terminal::DevicePixels(640),
            ),
            nsh_core::platform::Appearance::Dark,
        )
        .await
    }

    async fn open_at(
        fixture: &Fixture,
        address: &Path,
        dimensions: nsh_terminal::Size<nsh_terminal::DevicePixels>,
        appearance: nsh_core::platform::Appearance,
    ) -> Self {
        Self::open_config(fixture, address, dimensions, appearance, None).await
    }

    async fn open_config(
        fixture: &Fixture,
        address: &Path,
        dimensions: nsh_terminal::Size<nsh_terminal::DevicePixels>,
        appearance: nsh_core::platform::Appearance,
        preview: Option<(String, &str, &str)>,
    ) -> Self {
        let client = fixture.client_at(address).await;
        let bindings = Bindings::new(client.clone(), tokio::runtime::Handle::current());
        let mut config = maka_workbench::configuration(
            bindings.registry(Some(fixture.session.clone())),
            tokio::runtime::Handle::current(),
        );
        config.assets = Some(bindings.assets());
        config.chunk_loader = Some(bindings.chunk_loader());
        let preview_ready = preview.as_ref().map(|(_, _, label)| *label);
        if let Some((source, locale, _)) = preview {
            config
                .host
                .set_params(json!({"locale":locale}).as_object().unwrap().clone());
            let mut capabilities = nsh_engine::Capabilities::all();
            capabilities.host = vec!["*".into()];
            config.app = nsh_engine::Bundle::source(source)
                .with_policy(nsh_engine::Policy {
                    declared: Some(capabilities),
                    ..nsh_engine::Policy::development()
                })
                .into();
            config.host.handle_open_url(|request| request.handled());
        }
        let outcome = Arc::new(Mutex::new(Value::Null));
        let observed = outcome.clone();
        config.host.handle("fixture.outcome", move |mut call| {
            *observed.lock().unwrap() = call.take_data();
            call.resolve(Value::Null);
        });
        let (foreground, receiver) = watch::channel(true);
        config.context = config
            .context
            .with(bindings.reload())
            .with(maka_workbench::Foreground(receiver));
        let wake = Arc::new(Notify::new());
        let notification = wake.clone();
        let frame = Arc::new(Mutex::new(None));
        let captured = frame.clone();
        config.environment.color_scheme = appearance.resolve(config.environment.color_scheme);
        let host = config.host.clone();
        let platform = Rc::new(
            TerminalSurface::new(
                config,
                dimensions,
                1.0,
                Box::new(move |frame| {
                    let frame = std::thread::spawn(move || frame.submit()?.complete())
                        .join()
                        .unwrap()
                        .unwrap();
                    *captured.lock().unwrap() = Some(frame);
                }),
                Arc::new(move || notification.notify_one()),
            )
            .unwrap(),
        );
        let desktop = Self {
            platform,
            frame,
            host,
            client,
            bindings,
            outcome,
            _foreground: foreground,
            wake,
        };
        if let Some(label) = preview_ready {
            desktop.control(label).await;
        } else {
            // The native input sink can focus before the saved draft is editable.
            desktop.control("Focus message composer").await;
            desktop.target_after(None).await;
        }
        desktop
    }

    fn artifact(&self, name: &str) {
        let Some(directory) = std::env::var_os("MAKA_UI_ARTIFACT_DIR") else {
            return;
        };
        let directory = std::path::PathBuf::from(directory);
        std::fs::create_dir_all(&directory).unwrap();
        self.pump();
        let guard = self.frame.lock().unwrap();
        let Some(frame) = guard.as_ref() else {
            return;
        };
        let size = frame.size();
        let mut ppm = format!("P6\n{} {}\n255\n", size.width.0, size.height.0).into_bytes();
        for pixel in frame.pixels().as_chunks::<4>().0 {
            ppm.extend_from_slice(&pixel[..3]);
        }
        let name = match std::env::var("NEXTEST_TEST_NAME") {
            Ok(test) => {
                let test = test
                    .rsplit("::")
                    .next()
                    .expect("a test name has a final component");
                format!("{test}-{name}")
            }
            Err(_) => name.to_owned(),
        };
        std::fs::write(directory.join(format!("{name}.ppm")), ppm).unwrap();
    }

    fn pixels(&self, bounds: Bounds<nsh_terminal::Pixels>) -> Option<Vec<u8>> {
        let guard = self.frame.lock().unwrap();
        let frame = guard.as_ref()?;
        let stride = frame.size().width.0 as usize * 4;
        let left = f32::from(bounds.left()) as usize * 4;
        let right = f32::from(bounds.right()) as usize * 4;
        Some(
            (f32::from(bounds.top()) as usize..f32::from(bounds.bottom()) as usize)
                .flat_map(|y| {
                    frame.pixels()[y * stride + left..y * stride + right]
                        .iter()
                        .copied()
                })
                .collect(),
        )
    }

    fn pump(&self) {
        self.platform.pump_with_draw(true);
        let error = self.platform.take_error();
        assert!(error.is_none(), "native UI failed: {error:?}");
    }

    async fn until<T>(&self, stage: &str, mut read: impl FnMut() -> Option<T>) -> T {
        tokio::time::timeout(super::support::WAIT_TIMEOUT, async {
            loop {
                self.pump();
                if let Some(value) = read() {
                    return value;
                }
                tokio::task::yield_now().await;
                // A key sent before focus lands is lost and produces no wake, so
                // a read that sends keys has to run again on its own.
                let _ = tokio::time::timeout(Duration::from_millis(50), self.wake.notified()).await;
            }
        })
        .await
        .unwrap_or_else(|_| self.timed_out(stage))
    }

    /// Acts until `done`, slowly enough that a repeat does not undo what the
    /// last act is still doing: toggle a menu shut, or press in the dialog it opened.
    async fn retry(&self, stage: &str, done: impl Fn() -> bool, act: impl Fn()) {
        let mut acted = None::<std::time::Instant>;
        self.until(stage, || {
            if done() {
                return Some(());
            }
            if acted.is_none_or(|at| at.elapsed() >= Duration::from_secs(1)) {
                act();
                acted = Some(std::time::Instant::now());
            }
            None
        })
        .await
    }

    async fn wait<T>(&self, stage: &str, future: impl Future<Output = T>) -> T {
        tokio::time::timeout(super::support::WAIT_TIMEOUT, async {
            tokio::pin!(future);
            loop {
                self.pump();
                tokio::select! {
                    value = &mut future => return value,
                    () = self.wake.notified() => {}
                }
            }
        })
        .await
        .unwrap_or_else(|_| self.timed_out(stage))
    }

    fn timed_out(&self, stage: &str) -> ! {
        self.artifact("failure");
        let mut rendered: Vec<(&str, Vec<Bounds<nsh_terminal::Pixels>>)> = [
            "Focus message composer",
            "Send message",
            "Stop response",
            "Add to queue",
            "Edit queued message 1",
            "Retry message",
            "Continue response",
            "Messages",
        ]
        .into_iter()
        .map(|label| (label, self.controls(label)))
        .collect();
        if let Some(requested) = stage.strip_prefix("no single control labelled ")
            && !rendered.iter().any(|(label, _)| *label == requested)
        {
            rendered.push((requested, self.controls(requested)));
        }
        let frame = self
            .frame
            .lock()
            .unwrap()
            .as_ref()
            .map(|frame| (frame.token(), frame.size()));
        panic!(
            "{stage}; native target: {:?}; native editor text: {:?}; native pending: {}; native active: {}; captured frame: {frame:?}; rendered controls: {rendered:?}; preview outcome: {:?}",
            self.platform.text_input_target(),
            self.platform.editor_text(),
            self.platform.has_pending(),
            self.platform.is_active(),
            self.outcome.lock().unwrap(),
        );
    }

    fn key(&self, name: &str, control: bool) {
        self.key_with(name, native!(Modifiers { control: control }));
    }

    fn key_with(&self, name: &str, modifiers: Modifiers) {
        let keystroke = native!(Keystroke {
            key: name.into(),
            key_char: None,
            modifiers: modifiers
        });
        self.platform
            .dispatch_input(PlatformInput::KeyDown(native!(
                nsh_terminal::KeyDownEvent {
                    keystroke: keystroke.clone(),
                    is_held: false,
                    prefer_character_input: false
                }
            )))
            .unwrap();
        self.platform
            .dispatch_input(PlatformInput::KeyUp(native!(nsh_terminal::KeyUpEvent {
                keystroke: keystroke
            })))
            .unwrap();
    }

    async fn target_after(&self, previous: Option<TextInputTarget>) {
        self.until("the requested editor was not ready for text input", || {
            self.platform
                .text_input_target()
                .filter(|target| Some(target) != previous.as_ref())
        })
        .await;
    }

    async fn copy_at(
        &self,
        stage: &str,
        position: nsh_terminal::Point<nsh_terminal::Pixels>,
    ) -> String {
        let _ = self.platform.take_clipboard_write();
        self.press_at(position);
        self.until(stage, || self.platform.take_clipboard_write())
            .await
    }

    async fn copy_input(&self) -> String {
        self.target_after(None).await;
        let _ = self.platform.take_clipboard_write();
        let mut acted = None::<std::time::Instant>;
        self.until("the selected draft was not copied", || {
            if let Some(copied) = self.platform.take_clipboard_write() {
                return Some(copied);
            }
            if acted.is_none_or(|at| at.elapsed() >= Duration::from_secs(1)) {
                if self.platform.text_input_target().is_none()
                    && let [composer] = self.controls("Focus message composer").as_slice()
                {
                    self.press_at(composer.center());
                }
                self.key("a", true);
                self.key("c", true);
                acted = Some(std::time::Instant::now());
            }
            None
        })
        .await
    }

    async fn paste(&self, text: &str) {
        self.target_after(None).await;
        assert!(self.platform.paste(nsh_core::PasteEvent::new(text)));
    }

    async fn paste_image(&self, bytes: &[u8]) {
        self.target_after(None).await;
        self.platform
            .set_clipboard_text("UNRELATED_SYSTEM_CLIPBOARD");
        let mut event = nsh_core::PasteEvent::default();
        event.files = vec![nsh_core::PastedFile::image(bytes.to_vec())];
        assert!(self.platform.paste(event));
    }

    async fn replace_text(&self, text: &str) {
        self.target_after(None).await;
        self.key("a", true);
        assert!(self.platform.paste(nsh_core::PasteEvent::new(text)));
    }

    async fn type_text(&self, text: &str) {
        self.replace_text(text).await;
        self.expect_text(text).await;
    }

    async fn wait_editor_cleared(&self) {
        self.until("the composer did not clear after sending", || {
            (self.controls("Send message").is_empty()
                && self.platform.editor_text().as_deref() == Some(""))
            .then_some(())
        })
        .await;
    }

    /// Enter does nothing until the typed draft can be sent.
    async fn submit(&self) {
        self.control("Send message").await;
        self.target_after(None).await;
        self.retry(
            "the typed draft was not submitted",
            || self.controls("Send message").is_empty(),
            || {
                if self.platform.text_input_target().is_none()
                    && let [composer] = self.controls("Focus message composer").as_slice()
                {
                    self.press_at(composer.center());
                }
                self.key("enter", false);
            },
        )
        .await;
    }

    async fn expect_text(&self, text: &str) {
        self.wait(
            &format!("the expected draft {text:?} did not appear in the editor"),
            async {
                loop {
                    let copied = self.copy_input().await;
                    if copied == text {
                        break;
                    }
                }
            },
        )
        .await;
    }

    fn drop_paths(
        &self,
        paths: Vec<std::path::PathBuf>,
        position: nsh_terminal::Point<nsh_terminal::Pixels>,
    ) {
        self.platform.drop_paths(paths, position);
        self.pump();
    }

    async fn new_draft(&self) {
        let previous = self.platform.text_input_target();
        self.key("n", true);
        self.target_after(previous).await;
        self.control("Focus message composer").await;
    }

    async fn attach(&self, path: &Path) {
        let previous = self.platform.text_input_target();
        self.key("u", true);
        self.target_after(previous).await;
        self.type_text(path.to_str().unwrap()).await;
        let picker = self.platform.text_input_target();
        self.key("enter", false);
        self.target_after(picker).await;
    }

    /// Where the window shows controls labelled `label`.
    fn controls(&self, label: &str) -> Vec<Bounds<nsh_terminal::Pixels>> {
        self.platform.pressable_bounds(label)
    }

    async fn composer_height(
        &self,
        stage: &str,
        ready: impl Fn(nsh_terminal::Pixels) -> bool,
    ) -> nsh_terminal::Pixels {
        self.until(stage, || {
            let fields = self.controls("Focus message composer");
            let [field] = fields.as_slice() else {
                return None;
            };
            (field.size.height > px(0.) && ready(field.size.height)).then_some(field.size.height)
        })
        .await
    }

    /// Where the window shows the one control labelled `label`, once it does.
    async fn control(&self, label: &str) -> Bounds<nsh_terminal::Pixels> {
        self.until(&format!("no single control labelled {label}"), || {
            let found = self.controls(label);
            (found.len() == 1).then(|| found[0])
        })
        .await
    }

    /// Opens the one folded step group and returns where `step` is in it.
    async fn open_group(&self, step: &str) -> Bounds<nsh_terminal::Pixels> {
        self.press("Process group").await;
        self.control(step).await
    }

    /// Presses `label` until `shown` appears. The Room test may press while its work summary is settling.
    async fn press_until(&self, label: &str, shown: &str) {
        self.retry(
            &format!("pressing {label} did not show {shown}"),
            || !self.controls(shown).is_empty(),
            || {
                if let [bounds] = self.controls(label)[..] {
                    self.press_at(bounds.center());
                }
            },
        )
        .await;
    }

    /// Clicks the one control labelled `label` once the window shows it.
    async fn press(&self, label: &str) {
        let bounds = self.control(label).await;
        self.press_at(bounds.center());
    }

    async fn right_click(&self, label: &str) {
        let bounds = self.control(label).await;
        self.click_at(bounds.center(), MouseButton::Right);
    }

    fn hover_at(&self, position: nsh_terminal::Point<nsh_terminal::Pixels>) {
        self.platform
            .dispatch_input(PlatformInput::MouseMove(native!(MouseMoveEvent {
                position: position,
                pressed_button: None,
                modifiers: Modifiers::default(),
            })))
            .unwrap();
        self.pump();
    }

    /// Whether the last frame draws anything inside `bounds`.
    fn draws_in(&self, bounds: Bounds<nsh_terminal::Pixels>) -> bool {
        self.pixels(bounds)
            .is_some_and(|pixels| pixels.as_chunks::<4>().0.windows(2).any(|w| w[0] != w[1]))
    }

    fn press_at(&self, position: nsh_terminal::Point<nsh_terminal::Pixels>) {
        self.click_at(position, MouseButton::Left);
    }

    fn click_at(&self, position: nsh_terminal::Point<nsh_terminal::Pixels>, button: MouseButton) {
        for input in [
            PlatformInput::MouseMove(native!(MouseMoveEvent {
                position: position,
                pressed_button: None,
                modifiers: Modifiers::default()
            })),
            PlatformInput::MouseDown(native!(MouseDownEvent {
                button: button,
                position: position,
                modifiers: Modifiers::default(),
                click_count: 1,
                first_mouse: false
            })),
            PlatformInput::MouseUp(native!(MouseUpEvent {
                button: button,
                position: position,
                modifiers: Modifiers::default(),
                click_count: 1
            })),
        ] {
            self.platform.dispatch_input(input).unwrap();
            self.pump();
        }
    }

    async fn held(&self, gate: &ReplyGate) {
        self.wait(
            "the original Host result was not held",
            gate.held.notified(),
        )
        .await;
    }

    async fn sessions(&self) -> Vec<Value> {
        self.wait("the conversation catalog did not settle", async {
            loop {
                match self
                    .client
                    .query(
                        "agent",
                        "list",
                        json!({"filter":"all","position":{"kind":"start"}}),
                    )
                    .await
                {
                    Ok(page) => return page["sessions"].as_array().unwrap().clone(),
                    Err(error) if error == "agent_catalog_changed" => {
                        tokio::task::yield_now().await
                    }
                    Err(error) => panic!("listing conversations failed: {error}"),
                }
            }
        })
        .await
    }

    async fn request(&self, fixture: &mut Fixture) -> ModelRequest {
        self.wait(
            "the submitted message did not reach the provider",
            fixture.next_request(),
        )
        .await
    }

    async fn restart(
        mut self,
        fixture: &Fixture,
        appearance: nsh_core::platform::Appearance,
    ) -> Self {
        // NSH has one process-wide platform queue. Keep that executor, but
        // destroy the JS runtime, native bindings and journal connection.
        // Match desktop detach: native tasks must drain before JS disposal.
        self.wait(
            "native detach waited for JS disposal",
            self.bindings.close(),
        )
        .await
        .unwrap();
        self.platform.stop();
        self.client = fixture.client().await;
        self.bindings = Bindings::new(self.client.clone(), tokio::runtime::Handle::current());
        let mut config = maka_workbench::configuration(
            self.bindings.registry(None),
            tokio::runtime::Handle::current(),
        );
        config.assets = Some(self.bindings.assets());
        config.chunk_loader = Some(self.bindings.chunk_loader());
        let (foreground, receiver) = watch::channel(true);
        self._foreground = foreground;
        config.context = config
            .context
            .with(self.bindings.reload())
            .with(maka_workbench::Foreground(receiver));
        config.environment.color_scheme = appearance.resolve(config.environment.color_scheme);
        self.host = config.host.clone();
        self.platform.load_with_config(config);
        self
    }

    async fn close(self) {
        self.platform.stop();
        self.bindings.close().await.unwrap();
    }
}

async fn images_fixture() -> Fixture {
    Fixture::configured(Options {
        images: true,
        ..Options::default()
    })
    .await
}

async fn desktop_remembers_folders_without_restoring_unsent_drafts() {
    let mut fixture = images_fixture().await;
    let (path, _) = image_file(&fixture);
    let workspace = fixture.directory.path().join("workspace");
    let nested_workspace = workspace.join("other-project").join("workspace");
    std::fs::create_dir_all(&nested_workspace).unwrap();
    let desktop = Desktop::open(&fixture, &fixture.address).await;
    desktop.new_draft().await;
    desktop.attach(&path).await;
    desktop.type_text("UNSENT_LOCAL_ONLY").await;
    desktop.press("Choose composer workspace").await;
    desktop.press("Choose another folder…").await;
    desktop.press("Browse folder Workspace").await;
    desktop.press("Browse folder other-project").await;
    desktop.press("Browse folder workspace").await;
    desktop
        .until("subfolder navigation did not leave parent listing", || {
            desktop
                .controls("Browse folder workspace")
                .is_empty()
                .then_some(())
        })
        .await;
    desktop.press("Use this workspace folder").await;
    desktop.press("Focus message composer").await;
    desktop.expect_text("UNSENT_LOCAL_ONLY").await;
    desktop.press("Choose composer workspace").await;
    desktop
        .control(&format!("Use folder {}", nested_workspace.display()))
        .await;
    desktop
        .control(&format!("Use folder {}", workspace.display()))
        .await;
    desktop.key("home", false);
    desktop.key("down", false);
    desktop.key("enter", false);
    desktop
        .until("keyboard selection did not close recent folders", || {
            desktop
                .controls("Choose another folder…")
                .is_empty()
                .then_some(())
        })
        .await;
    desktop.press("Focus message composer").await;
    desktop.expect_text("UNSENT_LOCAL_ONLY").await;
    let recent = desktop
        .wait("selected folder was not saved", async {
            loop {
                let recent = desktop.client.recent_workspaces().await.unwrap();
                if recent
                    .first()
                    .is_some_and(|item| item.path == workspace.to_str().unwrap())
                {
                    break recent;
                }
                tokio::task::yield_now().await;
            }
        })
        .await;
    assert_eq!(desktop.sessions().await.len(), 1);

    // Fail the initial history read, then repair it while the same window is open.
    let mut disk = sqlx::SqliteConnection::connect_with(
        &sqlx::sqlite::SqliteConnectOptions::new()
            .filename(fixture.directory.path().join("client.db")),
    )
    .await
    .unwrap();
    sqlx::query("UPDATE recent_workspaces SET value='unreadable fixture'")
        .execute(&mut disk)
        .await
        .unwrap();
    let desktop = desktop
        .restart(&fixture, nsh_core::platform::Appearance::Dark)
        .await;
    desktop.control("Choose composer workspace").await;
    sqlx::query("UPDATE recent_workspaces SET value=?")
        .bind(serde_json::to_string(&recent).unwrap())
        .execute(&mut disk)
        .await
        .unwrap();
    desktop.target_after(None).await;
    assert!(desktop.controls("Send message").is_empty());
    assert!(
        desktop
            .controls(&format!(
                "Remove attachment {}",
                path.file_name().unwrap().to_str().unwrap()
            ))
            .is_empty()
    );
    assert_eq!(desktop.sessions().await.len(), 1);
    desktop.type_text("FRESH_AFTER_REOPEN").await;
    desktop.submit().await;
    let request = desktop.request(&mut fixture).await;
    let body = request.body.to_string();
    assert!(body.contains("FRESH_AFTER_REOPEN"));
    assert!(!body.contains("UNSENT_LOCAL_ONLY"));
    assert!(!body.contains("data:image"));
    desktop
        .wait("message did not finish", request.finish())
        .await;
    let sent = desktop
        .sessions()
        .await
        .into_iter()
        .find(|session| session["id"] != fixture.session)
        .unwrap();
    assert_eq!(sent["workspace"]["path"], workspace.to_str().unwrap());
    desktop.wait("finished conversation could not be removed", async {
        loop {
            let observed = desktop.client.query("agent", "observe", json!({"sessionId": sent["id"]})).await.unwrap();
            let result = mutate(&desktop.client, "changeSession", json!({"sessionId":sent["id"], "expectedRevision":observed["session"]["revision"], "action":"remove"})).await;
            if result["kind"] == "removed" { break; }
            assert!(result["kind"] == "revision_conflict" || result["reason"] == "busy", "{result}");
            tokio::task::yield_now().await;
        }
    }).await;
    let desktop = desktop
        .restart(&fixture, nsh_core::platform::Appearance::Dark)
        .await;
    desktop.target_after(None).await;
    desktop.type_text("SAME_FOLDER_AFTER_SESSION_REMOVAL").await;
    desktop.control("Send message").await;
    assert_eq!(desktop.sessions().await.len(), 1);
    desktop.close().await;
    fixture.finish().await;
}

fn image_file(fixture: &Fixture) -> (std::path::PathBuf, Vec<u8>) {
    let bytes = STANDARD.decode(PNG).unwrap();
    let path = fixture.directory.path().join("selected.png");
    std::fs::write(&path, &bytes).unwrap();
    (path, bytes)
}

fn assert_image(request: &ModelRequest, text: &str, bytes: &[u8]) {
    assert!(request.body.to_string().contains(text), "{}", request.body);
    let images: Vec<_> = request.body["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|message| message["role"] == "user")
        .filter_map(|message| message["content"].as_array())
        .flatten()
        .filter(|part| part["type"] == "image_url")
        .map(|part| {
            STANDARD
                .decode(
                    part["image_url"]["url"]
                        .as_str()
                        .unwrap()
                        .strip_prefix("data:image/png;base64,")
                        .unwrap(),
                )
                .unwrap()
        })
        .collect();
    assert_eq!(images, vec![bytes.to_vec()], "{}", request.body);
}

async fn desktop_composer_click_and_ime_follow_the_text_after_a_mention() {
    let fixture = Fixture::open().await;
    let client = fixture.client().await;
    let referenced = mutate(
        &client,
        "create",
        json!({
            "title":"删过度设计", "labels":[],
            "workspace":{"kind":"session", "sessionId":fixture.session},
        }),
    )
    .await;
    assert_eq!(referenced["kind"], "created", "{referenced}");
    let referenced = referenced["session"]["id"].as_str().unwrap();
    client.close().await.unwrap();
    let desktop = Desktop::open(&fixture, &fixture.address).await;
    let composer = desktop.control("Focus message composer").await;
    desktop.press_at(composer.center());
    desktop.paste("@删过度").await;
    desktop.press("删过度设计").await;
    let mention = format!("[@删过度设计](maka://session/{referenced}) ");
    desktop.expect_text(&mention).await;
    desktop.key("right", false);
    let before_ah = "**它刚刚提了个 PR**，你来 review 一下，你可以用";
    let prefix = format!("{mention}{before_ah}");
    desktop.paste(before_ah).await;
    desktop.expect_text(&prefix).await;
    desktop.key("right", false);
    let insertion = desktop
        .until("the caret did not reach the end of the first part", || {
            desktop
                .platform
                .input_caret_bounds()
                .filter(|bounds| bounds.left() > composer.left() + px(200.))
        })
        .await;
    let suffix = "啊，看看实现干不干净，优不优雅，测试是不是有很多低信心、低价值的测试";
    desktop.paste(suffix).await;
    desktop.expect_text(&format!("{prefix}{suffix}")).await;
    desktop.press_at(point(insertion.left(), insertion.center().y));
    let composition_bounds = Bounds::new(
        point(insertion.left() + px(3.), insertion.top()),
        size(px(9.), insertion.size.height),
    );
    let before = desktop.pixels(composition_bounds).unwrap();
    desktop.artifact("composer-ime-click");
    let target = desktop.platform.text_input_target().unwrap();
    assert!(
        desktop
            .platform
            .apply_composition(&target, "", "a", Some(1..1), true)
            .unwrap()
    );
    let preedit = desktop
        .until(
            "the input method's preedit did not appear at the clicked position",
            || {
                desktop
                    .pixels(composition_bounds)
                    .filter(|pixels| *pixels != before)
            },
        )
        .await;
    desktop.artifact("composer-ime-preedit");
    assert!(
        desktop
            .platform
            .apply_composition(&target, "阿", "", None, false)
            .unwrap()
    );
    desktop
        .until(
            "the committed character did not replace the preedit",
            || {
                desktop
                    .pixels(composition_bounds)
                    .filter(|pixels| *pixels != preedit)
            },
        )
        .await;
    desktop.artifact("composer-ime-committed");
    assert_eq!(desktop.copy_input().await, format!("{prefix}阿{suffix}"));
    desktop.close().await;
    fixture.finish().await;
}

async fn desktop_composer_previews_markdown_and_sends_its_source() {
    let mut fixture = Fixture::open().await;
    let client = fixture.client().await;
    let conversation = mutate(
        &client,
        "create",
        json!({
            "title":"Markdown preview", "labels":[],
            "workspace":{"kind":"session", "sessionId":fixture.session},
            "backend":{
                "kind":"model",
                "connectionId":fixture.selection["connectionId"],
                "modelId":fixture.selection["modelId"],
            },
        }),
    )
    .await;
    assert_eq!(conversation["kind"], "created", "{conversation}");
    client.close().await.unwrap();
    let desktop = Desktop::open(&fixture, &fixture.address).await;
    let previous = desktop.platform.text_input_target();
    desktop.press("Open conversation Markdown preview").await;
    desktop.target_after(previous).await;
    let source = "# 发布说明\n\n这是**重点：**先看[文档](https://example.org/docs)，再看 https://example.org/status。\n\n- 检查构建\n- 提交结果";
    desktop.press("Focus message composer").await;
    desktop.paste(source).await;
    desktop.expect_text(source).await;
    let selected = desktop
        .until("the composer did not settle its select-all anchor", || {
            let &[composer] = desktop.controls("Focus message composer").as_slice() else {
                return None;
            };
            desktop.platform.input_caret_bounds().filter(|bounds| {
                bounds.left() < composer.left() + px(32.) && bounds.top() < composer.top() + px(32.)
            })
        })
        .await;
    let mut collapsed = None::<std::time::Instant>;
    let mut settled = None;
    let tail = desktop
        .until("the caret did not collapse to the draft end", || {
            if collapsed.is_some()
                && !desktop.platform.has_pending()
                && let Some(bounds) = desktop.platform.input_caret_bounds()
                && bounds.left() > selected.left() + px(24.)
                && bounds.top() > selected.top()
            {
                if settled == Some(bounds) {
                    return Some(bounds);
                }
                settled = Some(bounds);
                return None;
            }
            settled = None;
            if collapsed.is_none_or(|at| at.elapsed() >= Duration::from_millis(200)) {
                desktop.key("right", false);
                collapsed = Some(std::time::Instant::now());
            }
            None
        })
        .await;
    desktop.artifact("composer-markdown-draft");

    let mut homed = None::<std::time::Instant>;
    let mut home_tries = 0usize;
    let marker = desktop
        .until("the caret did not reach the list marker", || {
            let cur = desktop.platform.input_caret_bounds();
            if home_tries >= 6 {
                panic!("PROBE_CARET selected={selected:?} tail={tail:?} after_home={cur:?}");
            }
            if let Some(bounds) = cur
                && bounds.left() < tail.left() - px(24.)
                && bounds.top() == tail.top()
            {
                return Some(bounds);
            }
            if homed.is_none_or(|at| at.elapsed() >= Duration::from_millis(200)) {
                desktop.key("home", false);
                homed = Some(std::time::Instant::now());
                home_tries += 1;
            }
            None
        })
        .await;
    let mut ended = None::<std::time::Instant>;
    desktop
        .until("the caret did not leave the list marker", || {
            if let Some(bounds) = desktop.platform.input_caret_bounds()
                && bounds.left() > marker.left() + px(24.)
            {
                return Some(());
            }
            if ended.is_none_or(|at| at.elapsed() >= Duration::from_millis(200)) {
                desktop.key("end", false);
                ended = Some(std::time::Instant::now());
            }
            None
        })
        .await;
    desktop.press_at(point(marker.left() + px(1.), marker.center().y));
    desktop.artifact("composer-markdown-edit-list-marker");
    desktop.key_with("right", native!(Modifiers { shift: true }));
    desktop.paste("+").await;
    assert_eq!(
        desktop.copy_input().await,
        source.replace("- 提交结果", "+ 提交结果")
    );
    desktop.key("z", true);
    desktop.expect_text(source).await;

    desktop.press("Send message").await;
    let mut request = desktop.request(&mut fixture).await;
    let message = request.body["messages"].as_array().unwrap().last().unwrap();
    assert_eq!(message["role"], "user");
    assert_eq!(message["content"].as_str(), Some(source));
    request.delta("Release notes received.").await;
    desktop
        .wait("the response did not finish", request.finish())
        .await;
    desktop
        .until("the response did not finish in the workbench", || {
            desktop.controls("Stop response").is_empty().then_some(())
        })
        .await;
    let copy = desktop.control("Copy user message").await;
    desktop.artifact("composer-markdown-sent");
    // The actions are revealed by hovering over the message body above them.
    desktop.hover_at(point(copy.center().x, copy.top() - px(12.)));
    let copy = desktop
        .until("the copy action did not appear", || {
            let &[copy] = desktop.controls("Copy user message").as_slice() else {
                return None;
            };
            desktop.draws_in(copy).then_some(copy)
        })
        .await;
    let copied = desktop
        .copy_at("the sent message was not copied", copy.center())
        .await;
    assert_eq!(copied, source);
    desktop.close().await;
    fixture.finish().await;
}

async fn desktop_creates_only_on_first_submission_and_preserves_the_confirmed_snapshot() {
    let mut fixture = images_fixture().await;
    let (path, bytes) = image_file(&fixture);
    let gate = ReplyGate::send(fixture.directory.path(), fixture.address.clone());
    let desktop = Desktop::open(&fixture, &gate.address).await;
    desktop.new_draft().await;
    desktop.attach(&path).await;
    std::fs::write(&path, b"changed after selection").unwrap();
    desktop.type_text("FIRST_DESKTOP_MESSAGE").await;
    assert_eq!(desktop.sessions().await.len(), 1);
    gate.arm();
    desktop.press("Send message").await;
    desktop.held(&gate).await;
    desktop.wait_editor_cleared().await;
    let sessions = desktop.sessions().await;
    assert_eq!(sessions.len(), 2);
    let session = sessions
        .iter()
        .find(|session| session["id"] != fixture.session)
        .unwrap()["id"]
        .as_str()
        .unwrap();
    desktop.type_text("NEXT_DESKTOP_DRAFT").await;
    desktop
        .wait(
            "the next draft was not saved independently of the first send",
            super::support::wait_draft(&desktop.client, session, "NEXT_DESKTOP_DRAFT"),
        )
        .await;
    desktop.artifact("first-send-clicked");
    gate.release();
    let request = desktop.request(&mut fixture).await;
    assert_image(&request, "FIRST_DESKTOP_MESSAGE", &bytes);
    assert!(!request.body.to_string().contains("NEXT_DESKTOP_DRAFT"));
    desktop
        .wait("the first model response did not finish", request.finish())
        .await;
    desktop
        .wait(
            "the first turn did not finish",
            fixture.idle(&desktop.client, session),
        )
        .await;
    desktop.expect_text("NEXT_DESKTOP_DRAFT").await;
    let observed = desktop
        .client
        .query("agent", "observe", json!({"sessionId":session}))
        .await
        .unwrap();
    let history = desktop.client.query("agent", "history", json!({"sessionId":session,"through":observed["through"],"position":{"kind":"tail"},"view":"conversation"})).await.unwrap();
    let messages: Vec<_> = history["chunks"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|row| row["role"] == "user" && row["text"] == "FIRST_DESKTOP_MESSAGE")
        .collect();
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["attachments"].as_array().unwrap().len(), 1);
    assert_eq!(fixture.request_count(), 1);
    desktop.close().await;
    fixture.finish().await;
}

async fn desktop_continues_a_failed_run_without_duplicating_the_user_message() {
    let mut fixture = Fixture::open().await;
    let desktop = Desktop::open_at(
        &fixture,
        &fixture.address,
        size(
            nsh_terminal::DevicePixels(1200),
            nsh_terminal::DevicePixels(900),
        ),
        nsh_core::platform::Appearance::Dark,
    )
    .await;
    desktop.new_draft().await;
    desktop.type_text("RETRIED_IN_PLACE_MESSAGE").await;
    desktop.submit().await;
    let failed = desktop.request(&mut fixture).await;
    failed
        .http_error(
            json!({"error":{"type":"invalid_request_error","message":"FIXTURE_TURN_FAILED"}}),
        )
        .await;
    let resume = desktop.control("Continue response").await;
    let composer = desktop.control("Focus message composer").await;
    assert!(
        resume.center().x > composer.center().x && resume.center().y > composer.center().y,
        "Continue must sit in the composer's lower right: {resume:?}, {composer:?}"
    );
    assert!(desktop.controls("Continue in a new run").is_empty());
    desktop.artifact("continue-in-composer");
    let sessions = desktop.sessions().await;
    let failed_session = sessions
        .iter()
        .find(|value| value["id"] != fixture.session)
        .unwrap();
    let session = failed_session["id"].as_str().unwrap();
    let observed = desktop
        .client
        .query("agent", "observe", json!({"sessionId":session}))
        .await
        .unwrap();
    let history = desktop
        .client
        .query(
            "agent",
            "history",
            json!({
                "sessionId":session, "through":observed["through"], "position":{"kind":"tail"},
                "view":"conversation"
            }),
        )
        .await
        .unwrap();
    let opening = history["chunks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["role"] == "user")
        .unwrap();
    let trace = desktop
        .client
        .query(
            "agent",
            "historyRequests",
            json!({
                "sessionId":session, "through":observed["through"], "position":opening["position"]
            }),
        )
        .await
        .unwrap();
    assert_eq!(trace["requests"].as_array().unwrap().len(), 1);
    assert!(trace["requests"][0]["firstTokenAt"].is_null());
    let finished = &trace["requests"][0]["finished"];
    assert_eq!(finished["outcome"], "error");
    assert!(
        finished["diagnostic"]
            .as_str()
            .unwrap()
            .contains("FIXTURE_TURN_FAILED")
    );
    desktop.press("Trajectory").await;
    desktop.press("Inspect model request fixture-model").await;
    desktop.control("Close record details").await;
    desktop.artifact("trajectory-failed-request");
    desktop.press("Chat").await;
    desktop.new_draft().await;
    let draft = desktop
        .client
        .load_draft("agent", session, super::support::EDITOR)
        .await
        .unwrap();
    desktop
        .client
        .save_draft(
            "agent",
            session,
            super::support::EDITOR,
            draft.map(|draft| draft.revision),
            serde_json::from_value(json!({"text":"","attachments":[],"settledUploads":[],
            "quotes":[{"text":"Quoted follow-up","label":"Earlier reply"}]}))
            .unwrap(),
        )
        .await
        .unwrap();
    desktop
        .press(&format!(
            "Open conversation {}",
            failed_session["title"].as_str().unwrap()
        ))
        .await;
    desktop.control("Remove quote").await;
    desktop.control("Send message").await;
    assert!(
        desktop.controls("Continue response").is_empty(),
        "the quote-only draft should be sent as a new message"
    );
    desktop.press("Remove quote").await;
    desktop.press("Continue response").await;
    let retry = desktop.request(&mut fixture).await;
    let users: Vec<_> = retry.body["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|message| message["role"] == "user")
        .collect();
    assert!(
        users
            .last()
            .is_some_and(|message| message.to_string().contains("RETRIED_IN_PLACE_MESSAGE")),
        "{}",
        retry.body
    );
    assert_eq!(
        users
            .iter()
            .filter(|message| message.to_string().contains("RETRIED_IN_PLACE_MESSAGE"))
            .count(),
        1
    );
    retry.finish().await;
    let sessions = desktop.sessions().await;
    assert_eq!(sessions.len(), 2);
    let session = sessions
        .iter()
        .find(|session| session["id"] != fixture.session)
        .unwrap()["id"]
        .as_str()
        .unwrap();
    fixture.idle(&desktop.client, session).await;
    assert_eq!(fixture.request_count(), 2);
    desktop.close().await;
    fixture.finish().await;
}

async fn desktop_history_anchors_keep_the_reader_off_live_output_until_latest() {
    let mut fixture = Fixture::open().await;
    let desktop = Desktop::open(&fixture, &fixture.address).await;
    desktop.new_draft().await;
    let body = "A long reply leaves space between prompts to test the reader. ".repeat(12);
    for turn in 1..=6 {
        desktop.type_text(&format!("History prompt {turn}")).await;
        desktop.submit().await;
        let mut reply = desktop.request(&mut fixture).await;
        reply
            .delta(&format!("History reply {turn}\n\n{body}"))
            .await;
        desktop
            .wait("the reply did not finish", reply.finish())
            .await;
        desktop
            .until(
                "the active response did not finish in the workbench",
                || desktop.controls("Stop response").is_empty().then_some(()),
            )
            .await;
    }
    desktop.control("Jump to turn: History prompt 6").await;
    desktop.press("Jump to turn: History prompt 2").await;
    desktop.control("Return to latest").await;
    let copy = desktop.control("Copy user message").await;
    desktop.hover_at(copy.center());
    desktop
        .until("the copy action did not appear on hover", || {
            desktop.draws_in(copy).then_some(())
        })
        .await;
    let copy = desktop.control("Copy user message").await;
    let copied = desktop
        .copy_at("the selected user message was not copied", copy.center())
        .await;
    assert_eq!(copied, "History prompt 2");
    desktop.artifact("history-anchor");
    desktop.press("Return to latest").await;
    desktop
        .until("the latest reply did not come into view", || {
            (desktop.controls("Return to latest").is_empty()
                && !desktop.controls("Copy message").is_empty())
            .then_some(())
        })
        .await;
    desktop.close().await;
    fixture.finish().await;
}

#[cfg(target_os = "macos")]
async fn desktop_resumes_live_activity_when_scrolling_back_to_latest() {
    let mut fixture = Fixture::configured(Options {
        responses: true,
        ..Options::default()
    })
    .await;
    let client = fixture.client().await;
    mutate(
        &client,
        "send",
        json!({"sessionId": fixture.session, "backend": {
            "kind": "model", "connectionId": fixture.selection["connectionId"],
            "modelId": fixture.selection["modelId"],
        }, "message": "Follow the activity"}),
    )
    .await;
    let mut reply = fixture.next_request().await;
    for index in 0..135 {
        reply
            .packet(json!({"type":"response.output_item.done","item":{
                "type":"reasoning","id":format!("reasoning-{index}"),
                "summary":[{"type":"summary_text","text":format!("Activity line {index}")}]
            }}))
            .await;
    }
    let desktop = Desktop::open(&fixture, &fixture.address).await;
    use nsh_terminal::ScrollWheelEvent;
    let latest = desktop.open_group("Thinking · Activity line 134").await;
    desktop
        .retry(
            "read the first activity across page boundaries",
            || !desktop.controls("Thinking · Activity line 0").is_empty(),
            || {
                desktop
                    .platform
                    .dispatch_input(PlatformInput::ScrollWheel(native!(ScrollWheelEvent {
                        position: latest.center(),
                        delta: nsh_terminal::ScrollDelta::Lines(point(0., 24.))
                    })))
                    .unwrap();
            },
        )
        .await;
    desktop.press("Return to latest").await;
    let thumb = desktop.control("Thinking · Activity line 134").await;
    assert!(desktop.controls("Return to latest").is_empty());
    let at = point(thumb.right() - px(5.), thumb.center().y);
    desktop.hover_at(at);
    let scroll = |from, to| {
        for input in [
            PlatformInput::MouseMove(native!(MouseMoveEvent { position: from })),
            PlatformInput::MouseDown(native!(MouseDownEvent {
                button: MouseButton::Left,
                position: from,
                click_count: 1,
            })),
            PlatformInput::MouseMove(native!(MouseMoveEvent {
                position: to,
                pressed_button: Some(MouseButton::Left),
            })),
            PlatformInput::MouseUp(native!(MouseUpEvent {
                button: MouseButton::Left,
                position: to,
                click_count: 1,
            })),
        ] {
            desktop.platform.dispatch_input(input).unwrap();
            desktop.pump();
        }
    };
    desktop
        .retry(
            "scroll up to pause activity following",
            || !desktop.controls("Return to latest").is_empty(),
            || scroll(at, point(at.x, at.y - px(80.))),
        )
        .await;
    let outer = point(at.x + px(16.), at.y);
    scroll(outer, point(outer.x, outer.y - px(120.)));
    let user = desktop.control("Copy user message").await;
    assert!(desktop.controls("Thinking · Activity line 134").is_empty());
    // The outer thumb now rests at the top of its track, level with the prompt.
    let outer = point(outer.x, user.top() + px(32.));
    desktop
        .retry(
            "scroll down to resume without clicking Latest",
            || {
                desktop.controls("Return to latest").is_empty()
                    && desktop.controls("Resume following").is_empty()
            },
            || {
                scroll(
                    point(outer.x, outer.y - px(32.)),
                    point(outer.x, outer.y + px(36.)),
                )
            },
        )
        .await;
    reply
        .packet(json!({"type":"response.output_item.done","item":{
            "type":"reasoning","id":"follow-up",
            "summary":[{"type":"summary_text","text":"New activity after scrolling"}]
        }}))
        .await;
    desktop
        .control("Thinking · New activity after scrolling")
        .await;
    reply
        .packet(json!({"type":"response.output_item.done","item":{
            "type":"message","id":"final-answer","role":"assistant","phase":"final_answer",
            "content":[{"type":"output_text","text":"All steps finished."}]
        }}))
        .await;
    reply
        .packet(json!({"type":"response.completed","response":{
            "id":"response-1","usage":{"input_tokens":10,"output_tokens":20}
        }}))
        .await;
    reply.finish_stream().await;
    desktop.control("Copy message").await;
    desktop.close().await;
    // Reopen cold to read a finished long group downward across page boundaries.
    let desktop = Desktop::open(&fixture, &fixture.address).await;
    desktop.press("Turn work details").await;
    let first = desktop.open_group("Thinking · Activity line 0").await;
    assert!(
        desktop
            .controls("Thinking · New activity after scrolling")
            .is_empty()
    );
    desktop
        .retry(
            "read the second page of a closed group without jumping past it",
            || !desktop.controls("Thinking · Activity line 64").is_empty(),
            || {
                desktop
                    .platform
                    .dispatch_input(PlatformInput::ScrollWheel(native!(ScrollWheelEvent {
                        position: first.center(),
                        delta: nsh_terminal::ScrollDelta::Lines(point(0., -12.))
                    })))
                    .unwrap();
            },
        )
        .await;
    assert!(
        desktop
            .controls("Thinking · New activity after scrolling")
            .is_empty()
    );
    desktop
        .retry(
            "read down to the final activity of the closed group",
            || {
                !desktop
                    .controls("Thinking · New activity after scrolling")
                    .is_empty()
            },
            || {
                desktop
                    .platform
                    .dispatch_input(PlatformInput::ScrollWheel(native!(ScrollWheelEvent {
                        position: first.center(),
                        delta: nsh_terminal::ScrollDelta::Lines(point(0., -24.))
                    })))
                    .unwrap();
            },
        )
        .await;
    desktop.close().await;
    fixture.finish().await;
}

async fn desktop_edits_a_message_in_place_and_forks_only_when_sent() {
    let mut fixture = Fixture::open().await;
    let desktop = Desktop::open(&fixture, &fixture.address).await;
    desktop.new_draft().await;
    desktop.type_text("ORIGINAL_EDIT_MESSAGE").await;
    desktop.submit().await;
    let mut reply = desktop.request(&mut fixture).await;
    reply.delta("ORIGINAL_EDIT_REPLY").await;
    desktop
        .wait("the reply did not finish", reply.finish())
        .await;
    let sessions = desktop.sessions().await;
    assert_eq!(sessions.len(), 2);
    let session = sessions
        .iter()
        .find(|session| session["id"] != fixture.session)
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    fixture.idle(&desktop.client, &session).await;

    // Editing stays in this conversation until the user sends the fork.
    desktop.press("Edit and resend in a fork").await;
    desktop.expect_text("ORIGINAL_EDIT_MESSAGE").await;
    desktop.artifact("message-editor");
    assert_eq!(desktop.sessions().await.len(), 2);
    desktop.type_text("EDITED_IN_PLACE_MESSAGE").await;
    assert_eq!(desktop.sessions().await.len(), 2);
    desktop.press("Send edited message in a fork").await;
    let edited = desktop.request(&mut fixture).await;
    let body = edited.body.to_string();
    assert!(body.contains("EDITED_IN_PLACE_MESSAGE"), "{body}");
    assert!(!body.contains("ORIGINAL_EDIT_MESSAGE"), "{body}");
    edited.finish().await;
    let sessions = desktop.sessions().await;
    assert_eq!(sessions.len(), 3);
    let fork = sessions
        .iter()
        .find(|item| item["id"] != fixture.session && item["id"] != session.as_str())
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    fixture.idle(&desktop.client, &fork).await;
    assert_eq!(fixture.request_count(), 2);
    desktop.close().await;
    fixture.finish().await;
}

async fn desktop_asks_a_side_question_beside_a_reply() {
    let mut fixture = Fixture::open().await;
    let (_, appearance, _, _, _) = visual_case();
    let desktop = Desktop::open_at(
        &fixture,
        &fixture.address,
        size(
            nsh_terminal::DevicePixels(1440),
            nsh_terminal::DevicePixels(820),
        ),
        appearance,
    )
    .await;
    desktop.new_draft().await;
    desktop.type_text("How does the cache layer work?").await;
    desktop.submit().await;
    let mut reply = desktop.request(&mut fixture).await;
    reply
        .delta(
            "The cache layer sits between the API handlers and the database.\n\n\
             Reads go through a **write-through** cache keyed by the request digest. \
             On a miss the handler loads the row, stores it for five minutes, and returns it.\n\n\
             Writes invalidate the key first and then update the row, so a reader never \
             sees a value older than the last committed write. CACHE_LAYER_EXPLAINED",
        )
        .await;
    desktop
        .wait("the reply did not finish", reply.finish())
        .await;
    let listed = desktop.sessions().await.len();

    // The card opens at once; nothing is created until the question is sent.
    let original = desktop.platform.text_input_target();
    desktop.press("Ask beside").await;
    desktop.target_after(original).await;
    desktop.control("Close side question").await;
    desktop.artifact("side-1-ask");
    assert_eq!(desktop.sessions().await.len(), listed);
    desktop.type_text("Why invalidate before the update?").await;
    desktop.artifact("side-2-typed");
    desktop.submit().await;
    let mut side = desktop.request(&mut fixture).await;
    let body = side.body.to_string();
    assert!(
        body.contains("CACHE_LAYER_EXPLAINED"),
        "the side question lacks the conversation it was asked beside: {body}"
    );
    assert!(body.contains("Why invalidate before the update?"), "{body}");
    desktop.artifact("side-3-working");
    side.delta(
        "If the row were updated first, a reader could cache the **old** value just after \
         the write and keep it for five minutes. Invalidating first closes that window: \
         the next read misses and loads the committed row. SIDE_ANSWER",
    )
    .await;
    desktop
        .wait("the side answer did not finish", side.finish())
        .await;
    // Its answer stands: the reactions are offered, and the reply names it.
    desktop.control("Simpler").await;
    desktop
        .control("Side question: Why invalidate before the update?")
        .await;
    desktop.artifact("side-4-answered");
    // A side question is not one of the listed conversations.
    assert_eq!(desktop.sessions().await.len(), listed);

    // A reaction asks on with what it says.
    desktop.press("Simpler").await;
    let mut simpler = desktop.request(&mut fixture).await;
    let body = simpler.body.to_string();
    assert!(body.contains("Explain that more simply."), "{body}");
    desktop.artifact("side-5-follow-up");
    simpler
        .delta("A reader must never keep a stale copy, so the copy is thrown away first.")
        .await;
    desktop
        .wait("the follow-up did not finish", simpler.finish())
        .await;
    desktop.control("Simpler").await;
    desktop.artifact("side-6-follow-up-answered");

    // Bringing it back puts a reference in the main draft, not its text.
    desktop.press("Bring to the main conversation").await;
    desktop
        .wait("the reference did not reach the main draft", async {
            loop {
                let draft = desktop.copy_input().await;
                if draft.starts_with("[@Why invalidate before the update?](maka://session/") {
                    break;
                }
            }
        })
        .await;
    desktop.artifact("side-7-attached");

    // Closed, the card comes back from its reply.
    desktop.press("Got it, close").await;
    desktop
        .until("the card did not close", || {
            desktop
                .controls("Close side question")
                .is_empty()
                .then_some(())
        })
        .await;
    desktop.artifact("side-8-closed");
    desktop
        .press("Side question: Why invalidate before the update?")
        .await;
    desktop.control("Close side question").await;
    desktop.control("Simpler").await;
    desktop.artifact("side-9-reopened");

    // Discarded, it leaves its reply too.
    desktop.press("Discard this side question").await;
    desktop
        .until("the discarded side question stayed on its reply", || {
            (desktop.controls("Close side question").is_empty()
                && desktop
                    .controls("Side question: Why invalidate before the update?")
                    .is_empty())
            .then_some(())
        })
        .await;
    desktop.close().await;
    fixture.finish().await;
}

async fn desktop_steering_freezes_each_message_and_queue_is_one_shot() {
    let mut fixture = Fixture::open().await;
    let gate = ReplyGate::send(fixture.directory.path(), fixture.address.clone());
    let (theme, appearance, width_name, width, height) = visual_case();
    let desktop = Desktop::open_at(
        &fixture,
        &gate.address,
        size(
            nsh_terminal::DevicePixels(width),
            nsh_terminal::DevicePixels(height),
        ),
        appearance,
    )
    .await;
    desktop.new_draft().await;
    desktop
        .type_text("Review the current implementation.")
        .await;
    desktop.submit().await;
    let original = desktop
        .wait(
            "initial submission did not reach the provider",
            fixture.next_request(),
        )
        .await;
    let session = desktop
        .sessions()
        .await
        .into_iter()
        .find(|row| row["id"] != fixture.session)
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    desktop.control("Stop response").await;

    desktop.type_text("Focus on steering in both modes.").await;
    gate.arm();
    desktop.press("Send message").await;
    desktop.held(&gate).await;
    desktop.wait_editor_cleared().await;
    desktop.type_text("Keep the sidebar compact.").await;
    desktop
        .wait(
            "next draft was not saved independently",
            super::support::wait_draft(&desktop.client, &session, "Keep the sidebar compact."),
        )
        .await;
    desktop.press("Messages").await;
    desktop.press("Focus message composer").await;
    desktop.key("right", false);
    desktop.artifact(&format!("steering-{theme}-{width_name}-sending"));
    gate.release();
    let second = desktop
        .wait(
            "frozen steering did not reach the provider after releasing the send reply",
            fixture.next_request(),
        )
        .await;
    let sent = second.body["messages"].to_string();
    assert!(
        sent.contains("Review the current implementation.")
            && sent.contains("Focus on steering in both modes."),
        "{sent}"
    );
    assert!(
        !sent.contains("Keep the sidebar compact."),
        "new typing must not join the frozen correction"
    );
    desktop.expect_text("Keep the sidebar compact.").await;
    drop(original);

    let queued_followup = "Summarize the changes afterwards for [@REA review](maka://session/ma_8b708bb06d73d5d83a9265c0464928803a7478a2a9083b6c3647cfc8c7c0f102_8fface6128fd12c727e1b3ab8e96acf2) across every remaining edge case in detail.";
    desktop.type_text(queued_followup).await;
    desktop.right_click("Send message").await;
    desktop.control("Add to queue").await;
    desktop.artifact(&format!("steering-{theme}-{width_name}-queue-menu"));
    desktop.key("escape", false);
    desktop
        .until("Escape did not dismiss the send menu", || {
            desktop.controls("Add to queue").is_empty().then_some(())
        })
        .await;
    let observed = desktop
        .wait(
            "the active turn could not be observed after dismissing the menu",
            desktop
                .client
                .query("agent", "observe", json!({"sessionId":session})),
        )
        .await
        .unwrap();
    assert_ne!(
        observed["session"]["activity"], "idle",
        "dismissing the send menu must not stop the active turn"
    );
    desktop.right_click("Send message").await;
    desktop.press("Add to queue").await;
    desktop
        .wait("explicit queue message was not accepted", async {
            loop {
                let queue = desktop
                    .client
                    .query("agent", "queue", json!({"sessionId":session}))
                    .await
                    .unwrap();
                if queue["entries"].as_array().unwrap().iter().any(|row| {
                    row["preview"].as_str().is_some_and(|preview| {
                        preview.starts_with("Summarize the changes afterwards")
                    }) && row["kind"] == "followup"
                }) {
                    return;
                }
                tokio::task::yield_now().await;
            }
        })
        .await;
    assert!(
        desktop.controls("Add to queue").is_empty(),
        "the one-shot menu closes after use"
    );

    let target = desktop.platform.text_input_target().unwrap();
    assert!(
        desktop
            .platform
            .apply_composition(&target, "", "方向", Some(2..2), true)
            .unwrap()
    );
    desktop
        .until("IME input still offered Stop as the primary action", || {
            desktop.controls("Stop response").is_empty().then_some(())
        })
        .await;
    desktop.key("enter", false);
    desktop.key("escape", false);
    desktop
        .wait("IME keys interrupted the active run", async {
            let status = desktop
                .client
                .query("agent", "observe", json!({"sessionId":session}))
                .await
                .unwrap();
            assert_ne!(status["session"]["activity"], "idle");
        })
        .await;
    assert_eq!(
        fixture.request_count(),
        2,
        "IME confirmation must not send a message"
    );
    assert!(
        desktop
            .platform
            .apply_composition(&target, "方向", "", None, false)
            .unwrap()
    );
    desktop.type_text("Check keyboard focus too.").await;
    desktop.submit().await;
    let third = desktop
        .wait(
            "steering after queue and IME did not reach the provider",
            fixture.next_request(),
        )
        .await;
    let sent = third.body["messages"].to_string();
    assert!(
        sent.contains("Check keyboard focus too."),
        "Enter after Queue returns to steering: {sent}"
    );
    assert!(
        !sent.contains("Summarize the changes afterwards."),
        "explicit followup waits until the turn ends"
    );
    drop(second);
    desktop
        .type_text("Preserve this draft after stopping.")
        .await;
    desktop.control("Send message").await;
    assert!(
        desktop.controls("Stop response").is_empty(),
        "a populated draft makes Send the primary action"
    );
    if desktop.controls("Edit queued message 1").is_empty() {
        desktop.press("Messages").await;
    }
    desktop.control("Edit queued message 1").await;
    desktop.press("Focus message composer").await;
    desktop.key("right", false);
    desktop.artifact(&format!("steering-{theme}-{width_name}-active"));
    desktop.press("Model for queued and future messages").await;
    desktop.control("Manage models").await;
    desktop.artifact(&format!("steering-{theme}-{width_name}-model-scope"));
    desktop
        .retry(
            "the model menu did not close",
            || desktop.controls("Manage models").is_empty(),
            || desktop.key("escape", false),
        )
        .await;
    desktop
        .retry(
            "the Messages panel did not close",
            || desktop.controls("Edit queued message 1").is_empty(),
            || {
                if let [messages] = desktop.controls("Messages").as_slice() {
                    desktop.press_at(messages.center());
                }
            },
        )
        .await;
    desktop.right_click("Send message").await;
    desktop.press("Stop response").await;
    desktop
        .wait(
            "Stop did not end the active turn",
            fixture.idle(&desktop.client, &session),
        )
        .await;
    drop(third);
    desktop.press("Focus message composer").await;
    desktop
        .expect_text("Preserve this draft after stopping.")
        .await;
    assert!(
        desktop.controls("Retry message").is_empty(),
        "a failed message does not force the details panel open"
    );
    desktop.control("Dismiss messages").await;
    desktop.press("Messages").await;
    let messages_strip = desktop.control("Messages").await;
    let retry = desktop.control("Retry message").await;
    let edit_in_composer = desktop.control("Edit message in composer").await;
    let dismiss_status = desktop.control("Dismiss message status").await;
    assert!(
        retry.bottom() <= messages_strip.top()
            && edit_in_composer.bottom() <= messages_strip.top()
            && dismiss_status.bottom() <= messages_strip.top(),
        "wrapped stopped message clipped its actions: strip={messages_strip:?}, retry={retry:?}, edit={edit_in_composer:?}, dismiss={dismiss_status:?}"
    );
    desktop.press("Focus message composer").await;
    desktop.key("right", false);
    desktop.artifact(&format!("steering-{theme}-{width_name}-stopped"));
    desktop.press("Edit message in composer").await;
    desktop
        .until(
            "restoring stopped message to composer did not clear Messages",
            || desktop.controls("Messages").is_empty().then_some(()),
        )
        .await;
    desktop
        .expect_text(&format!(
            "Preserve this draft after stopping.\n\n{queued_followup}"
        ))
        .await;
    assert_eq!(fixture.request_count(), 3);
    desktop.close().await;
    fixture.finish().await;
}

async fn desktop_file_gestures_preserve_drafts_and_stage_an_image() {
    let fixture = images_fixture().await;
    let desktop = Desktop::open(&fixture, &fixture.address).await;
    // Observe the wrapped path before copying: Select All would cancel an
    // insertion whose file intake is still pending.
    let directory = fixture
        .directory
        .path()
        .join(format!("{}未命名文件夹 2", "x".repeat(220)));
    std::fs::create_dir(&directory).unwrap();
    for (pending, blur) in [(false, false), (false, true), (true, true)] {
        let pending_height = if pending {
            desktop.new_draft().await;
            desktop.type_text("查看 ").await;
            desktop.key("right", false);
            let before = desktop
                .composer_height("the pending composer did not lay out", |_| true)
                .await;
            desktop.paste(&format!("'{}'", directory.display())).await;
            let height = desktop
                .composer_height("the pasted directory did not wrap", |height| {
                    height > before
                })
                .await;
            desktop
                .expect_text(&format!("查看 {}", directory.display()))
                .await;
            Some(height)
        } else {
            None
        };
        let original = "前😀待替换 后";
        desktop.type_text(original).await;
        let before = desktop
            .composer_height("the short draft did not lay out", |height| {
                pending_height.is_none_or(|pending| height < pending)
            })
            .await;
        desktop.key("home", false);
        for _ in 0..2 {
            desktop.key("right", false);
        }
        for _ in 0..3 {
            desktop.key_with("right", native!(Modifiers { shift: true }));
        }
        let _ = desktop.platform.take_clipboard_write();
        let mut acted = None::<std::time::Instant>;
        desktop
            .until("the replacement range was not selected", || {
                if desktop
                    .platform
                    .take_clipboard_write()
                    .is_some_and(|text| text == "待替换")
                {
                    return Some(());
                }
                if acted.is_none_or(|at| at.elapsed() >= Duration::from_secs(1)) {
                    desktop.key("c", true);
                    acted = Some(std::time::Instant::now());
                }
                None
            })
            .await;
        if blur {
            desktop.key("tab", false);
            desktop
                .until("Tab did not leave the composer input", || {
                    desktop.platform.text_input_target().is_none().then_some(())
                })
                .await;
        }
        let composer = desktop.control("Focus message composer").await;
        let position = if blur {
            point(
                composer.center().x,
                (composer.top() - px(120.)).max(px(64.)),
            )
        } else {
            composer.center()
        };
        desktop.platform.set_active(false).unwrap();
        desktop
            .until("the source file-manager window was not simulated", || {
                (!desktop.platform.is_active()).then_some(())
            })
            .await;
        desktop.drop_paths(vec![directory.clone()], position);
        let expanded = desktop
            .composer_height(&format!("the dropped directory did not wrap; pending={}, blur={blur}, before={before:?}", pending_height.is_some()), |height| {
                height > before
            })
            .await;
        let expected = format!("前😀{} 后", directory.display());
        desktop.expect_text(&expected).await;
        assert_eq!(desktop.sessions().await.len(), 1);
        desktop.key("z", true);
        desktop.expect_text(original).await;
        desktop
            .composer_height("the restored draft did not shrink", |height| {
                height < expanded
            })
            .await;
    }
    assert_eq!(fixture.request_count(), 0);
    let bytes = STANDARD.decode(PNG).unwrap();
    let name = "image.png";
    desktop.paste_image(&bytes).await;
    let remove = desktop.control(&format!("Remove attachment {name}")).await;
    // Below the remove button, inside the thumbnail it sits 36 points into.
    let sample = Bounds::new(
        point(remove.left() - px(20.), remove.top() + px(44.)),
        size(px(1.), px(1.)),
    );
    let surface = [0x20, 0x21, 0x23];
    desktop
        .until("the staged image did not paint", || {
            desktop.pump();
            let pixel = desktop.pixels(sample)?;
            (pixel[..3] != surface).then_some(())
        })
        .await;
    desktop.artifact("staged-image");
    desktop.press(&format!("Open attachment {name}")).await;
    desktop.control("Close full screen image").await;
    desktop.key("escape", false);
    desktop
        .until("the staged image viewer did not close", || {
            desktop
                .controls("Close full screen image")
                .is_empty()
                .then_some(())
        })
        .await;
    desktop.close().await;
    fixture.finish().await;
}

fn visual_case() -> (
    &'static str,
    nsh_core::platform::Appearance,
    &'static str,
    i32,
    i32,
) {
    let case = std::env::var("MAKA_UI_VISUAL_CASE").unwrap_or_else(|_| "dark-wide".into());
    match case.as_str() {
        "light-narrow" => (
            "light",
            nsh_core::platform::Appearance::Light,
            "narrow",
            720,
            720,
        ),
        "light-wide" => (
            "light",
            nsh_core::platform::Appearance::Light,
            "wide",
            1280,
            800,
        ),
        "dark-narrow" => (
            "dark",
            nsh_core::platform::Appearance::Dark,
            "narrow",
            720,
            720,
        ),
        "dark-wide" => (
            "dark",
            nsh_core::platform::Appearance::Dark,
            "wide",
            1280,
            800,
        ),
        _ => panic!("unsupported visual case: {case}"),
    }
}

async fn desktop_composer_large_paste_keeps_controls_on_screen() {
    let fixture = Fixture::open().await;
    let desktop = Desktop::open_at(
        &fixture,
        &fixture.address,
        size(
            nsh_terminal::DevicePixels(1280),
            nsh_terminal::DevicePixels(800),
        ),
        nsh_core::platform::Appearance::Dark,
    )
    .await;
    let before = desktop.control("Focus message composer").await;
    let mut draft = (0..200)
        .map(|i| format!("Traceback line {i}: a long pasted diagnostic with paths and details\n"))
        .collect::<String>();
    draft.push_str("请检查 /skill:review 这个问题");
    // TerminalPlatform::paste injects IME text, which strips control characters.
    // Native clipboard paste keeps the diagnostic's line breaks.
    desktop.platform.set_clipboard_text(&draft);
    let keystroke = native!(Keystroke {
        key: "v".into(),
        key_char: None,
        modifiers: native!(Modifiers {
            control: true,
            shift: true
        })
    });
    desktop
        .platform
        .dispatch_input(PlatformInput::KeyDown(native!(
            nsh_terminal::KeyDownEvent {
                keystroke: keystroke.clone(),
                is_held: false,
                prefer_character_input: false
            }
        )))
        .unwrap();
    desktop
        .platform
        .dispatch_input(PlatformInput::KeyUp(native!(nsh_terminal::KeyUpEvent {
            keystroke: keystroke
        })))
        .unwrap();
    let card = desktop
        .until("the pasted draft did not size its composer", || {
            let card = desktop
                .controls("Focus message composer")
                .into_iter()
                .next()?;
            (card.size.height > before.size.height).then_some(card)
        })
        .await;
    desktop.artifact("composer-large-paste");
    let window_height = desktop
        .frame
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .size()
        .height
        .0 as f32;
    assert!(
        card.top() >= px(0.) && card.bottom() <= px(window_height),
        "large paste escaped the composer viewport: {card:?}"
    );
    desktop.expect_text(&draft).await;
    desktop.close().await;
    fixture.finish().await;
}

async fn desktop_system_permission_guidance_uses_native_actions_without_paths() {
    let fixture = Fixture::open().await;
    let entry = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../terminal-shell/tests/real_host/permission_preview.tsx");
    let output = fixture.directory.path().join("permission-preview");
    let source = tokio::task::spawn_blocking(move || {
        let compiled = maka_ui_build::compile(
            &entry,
            &output,
            Some(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .ancestors()
                    .nth(3)
                    .unwrap(),
            ),
        )
        .unwrap();
        std::fs::read_to_string(compiled.module).unwrap()
    })
    .await
    .unwrap();
    let desktop = Desktop::open_config(
        &fixture,
        &fixture.address,
        size(
            nsh_terminal::DevicePixels(1120),
            nsh_terminal::DevicePixels(800),
        ),
        nsh_core::platform::Appearance::Dark,
        Some((source, "en", "Local Host")),
    )
    .await;
    desktop.control("Ready local").await;
    desktop.press("Enable Accessibility…").await;
    desktop.control("Requested accessibility").await;
    desktop.press("Permission still not enabled?").await;
    desktop.press("Show in Finder").await;
    desktop.control("Requested reveal_application").await;
    desktop.artifact("system-permission-native-guidance");
    desktop.press("Permission still not enabled?").await;
    desktop.press("Open Accessibility settings…").await;
    desktop.control("Requested accessibility").await;
    desktop.press("Cancel setup").await;
    desktop
        .control("Request cancelled without granting access")
        .await;
    assert!(desktop.controls("Cancel setup").is_empty());

    desktop.press("Remote Host").await;
    desktop.control("Ready remote").await;
    desktop.press("Enable Accessibility…").await;
    desktop.control("Prompted accessibility").await;
    desktop.press("Permission still not enabled?").await;
    assert!(desktop.controls("Show in Finder").is_empty());
    assert!(desktop.controls("Open Accessibility settings…").is_empty());
    desktop.control("Cancel setup").await;

    desktop.press("Older request").await;
    desktop.control("Ready old").await;
    assert!(desktop.controls("Enable Accessibility…").is_empty());
    assert!(desktop.controls("Open Accessibility settings…").is_empty());
    assert!(desktop.controls("Show in Finder").is_empty());
    desktop.press("Cancel setup").await;
    desktop
        .control("Request cancelled without granting access")
        .await;
    desktop.close().await;
    fixture.finish().await;
}

async fn desktop_workspace_stage_inspector_worktrees_and_fullscreen_review() {
    let mut fixture = Fixture::open_with_configuration(
        Options {
            session_tools: cfg!(not(windows)),
            ..Options::default()
        },
        |config, directory| {
            config["agent"]["permissions"]["access"] = json!("workspace_write");
            config["agent"]["toolDiscovery"] = json!(false);
            let linked_wt = directory.join("feature-worktree");
            let wt_parent = directory.join("worktrees");
            std::fs::create_dir_all(&wt_parent).unwrap();
            let roots = config["agent"]["workspaceRoots"].as_array_mut().unwrap();
            roots.push(json!({
                "label": "Feature Worktree",
                "path": linked_wt,
            }));
            roots.push(json!({
                "label": "Worktrees",
                "path": wt_parent,
            }));
            config["agent"]["skillLibrary"] = Value::Null;
        let workspace = directory.join("workspace");
        std::fs::create_dir_all(workspace.join("src")).unwrap();
        std::fs::write(
            workspace.join("Cargo.lock"),
            "# Automatically generated by Cargo.\nversion = 4\n\n[[package]]\nname = \"maka-engine\"\nversion = \"0.2.0\"\n",
        )
        .unwrap();
        std::fs::write(
            workspace.join("src/engine.rs"),
            "pub struct ReviewEngine {\n    pub max_files: usize,\n    pub collapse_locks: bool,\n}\n\nimpl ReviewEngine {\n    pub fn new() -> Self {\n        Self {\n            max_files: 30,\n            collapse_locks: false,\n        }\n    }\n}\n",
        )
        .unwrap();
        std::fs::write(
            workspace.join("src/stage.rs"),
            "pub fn default_stage_width() -> u32 {\n    416\n}\n",
        )
        .unwrap();
        let run_git = |cwd: &Path, args: &[&str]| {
            let result = std::process::Command::new("git")
                .arg("-C")
                .arg(cwd)
                .args(args)
                .output()
                .unwrap();
            assert!(
                result.status.success(),
                "git {:?} failed: {}",
                args,
                String::from_utf8_lossy(&result.stderr)
            );
        };
        run_git(&workspace, &["init", "-b", "main", "--quiet"]);
        run_git(
            &workspace,
            &["remote", "add", "origin", "https://github.com/apache/maka.git"],
        );
        run_git(&workspace, &["add", "."]);
        run_git(
            &workspace,
            &[
                "-c",
                "user.name=M4n5ter",
                "-c",
                "user.email=m4n5terrr@gmail.com",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "--quiet",
                "-m",
                "feat(review): initial review engine",
            ],
        );
        run_git(
            &workspace,
            &[
                "worktree",
                "add",
                "--quiet",
                "-b",
                "feat/linked-stage",
                linked_wt.to_str().unwrap(),
            ],
        );
        for (name, branch) in [
            ("agy-maka-host", "codex/agy-maka-host"),
            ("dependency-audit", "codex/dependency-audit-baseline"),
            ("external-agent-automations", "codex/external-agent-automations"),
            ("external-agent-interruption", "codex/external-agent-interruption"),
            ("goal-recovery-followup", "codex/goal-recovery-followup"),
            ("history-entry", "codex/history-entry"),
            ("history-navigation", "codex/history-navigation"),
            ("history-prompt-anchors", "codex/history-prompt-anchors"),
            ("json-render", "feat/json-render"),
            ("kimi-parallel-tool-results", "codex/kimi-parallel-tool-results"),
            ("maka-activity-edge-fade", "codex/maka-activity-edge-fade"),
            ("maka-automatic-run-recovery", "codex/maka-automatic-run-recovery"),
            ("maka-background-compaction", "codex/maka-background-compaction"),
        ] {
            let path = wt_parent.join(name);
            run_git(
                &workspace,
                &[
                    "worktree",
                    "add",
                    "--quiet",
                    "-b",
                    branch,
                    path.to_str().unwrap(),
                ],
            );
        }
        std::fs::write(
            wt_parent.join("external-agent-automations/src/stage.rs"),
            "pub fn default_stage_width() -> u32 {
    560
}
// Long branch worktree change
",
        )
        .unwrap();
        // Dirty changes in main workspace (Cargo.lock + src/engine.rs + src/stage.rs)
        std::fs::write(
            workspace.join("Cargo.lock"),
            "# Automatically generated by Cargo.\nversion = 4\n\n[[package]]\nname = \"maka-engine\"\nversion = \"0.3.0\"\n",
        )
        .unwrap();
        std::fs::write(
            workspace.join("src/engine.rs"),
            "pub struct ReviewEngine {\n    pub max_files: usize,\n    pub collapse_locks: bool,\n    pub preserve_scroll: bool,\n}\n\nimpl ReviewEngine {\n    pub fn new() -> Self {\n        Self {\n            max_files: 30,\n            collapse_locks: true,\n            preserve_scroll: true,\n        }\n    }\n}\n",
        )
        .unwrap();
        std::fs::write(
            workspace.join("src/stage.rs"),
            "pub fn default_stage_width() -> u32 {\n    496\n}\n\npub fn supports_fullscreen() -> bool {\n    true\n}\n",
        )
        .unwrap();
        // Distinct dirty change in linked worktree
        std::fs::write(
            linked_wt.join("src/stage.rs"),
            "pub fn default_stage_width() -> u32 {\n    640\n}\n// Linked worktree experiment\n",
        )
        .unwrap();
    })
    .await;

    let desktop = Desktop::open_at(
        &fixture,
        &fixture.address,
        size(
            nsh_terminal::DevicePixels(1440),
            nsh_terminal::DevicePixels(840),
        ),
        nsh_core::platform::Appearance::Dark,
    )
    .await;

    desktop.new_draft().await;
    desktop
        .type_text("Review the multi-file engine refactor and fullscreen stage UX")
        .await;
    desktop.submit().await;
    #[cfg(not(windows))]
    for title in [
        "Trace Windows and rich editor CI failures",
        "Audit Stage blur and native anchor bounds",
        "Verify multi-worktree search and scroll",
        "Check Composer dock lifecycle",
        "Run workspace-files Git engine tests",
        "Validate GitHub PR inline review threads",
        "Inspect SessionInspector overflow bounds",
        "Measure DiffView 60fps scroll preservation",
        "Verify Fullscreen Stage floating PiP",
        "Audit token allowlist security boundaries",
        "Check compact tab truncation width",
        "Verify worktree branch badge layout",
    ] {
        desktop
            .request(&mut fixture)
            .await
            .tool_call(
                "SessionCreate",
                json!({
                    "title": title,
                    "labels": [],
                    "workspace": {"kind": "directory", "path": fixture.directory.path().join("workspace")}
                }),
            )
            .await;
    }
    let mut reply = desktop.request(&mut fixture).await;
    reply
        .delta("已经核对过 `src/engine.rs` 和 `src/stage.rs` 的改动：\n\n- `Cargo.lock` 默认自动折叠，不会挡住正文代码浏览。\n- 右侧 Stage 支持可搜索、带滚动条的 Git worktree 选择器与严格受限高度的详情面板。")
        .await;
    desktop
        .wait("the model response did not finish", reply.finish())
        .await;

    let ws_btn = desktop.control("Browse workspace files").await;
    let add_btn = desktop.control("Add to message").await;
    assert!(
        ws_btn.center().y < add_btn.top(),
        "Browse workspace files must sit in Conversation header above Composer: ws={ws_btn:?}, add={add_btn:?}"
    );
    let composer_before = desktop.control("Focus message composer").await;
    assert!(
        composer_before.bottom() <= px(840.0),
        "Composer started off screen: {composer_before:?}"
    );

    let sessions = desktop.sessions().await;
    let active_sid = sessions
        .iter()
        .find(|s| s["id"] != fixture.session && s["parentSessionId"].is_null())
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let rev = desktop
        .client
        .query("agent", "gitRevisions", json!({"sessionId": active_sid}))
        .await;
    assert!(
        rev.as_ref()
            .ok()
            .and_then(|v| v["worktrees"].as_array())
            .is_some_and(|w| w.len() >= 15),
        "expected >=15 worktrees in gitRevisions, got: {rev:?}"
    );

    // Verify Conversation header layout
    let inspector_toggle = desktop.control("Toggle session details").await;
    let chat_tab = desktop.control("Chat").await;
    let trajectory_tab = desktop.control("Trajectory").await;
    let stage_toggle = desktop.control("Toggle workspace pane").await;
    assert!(
        ws_btn.right() <= inspector_toggle.left() + px(1.0)
            && inspector_toggle.right() <= chat_tab.left() + px(1.0)
            && stage_toggle.left() >= trajectory_tab.right() - px(1.0),
        "Header controls out of order: ws={ws_btn:?}, inspector={inspector_toggle:?}, chat={chat_tab:?}, trajectory={trajectory_tab:?}, stage={stage_toggle:?}"
    );
    assert!(
        (ws_btn.center().y - chat_tab.center().y).abs() <= px(2.0)
            && (inspector_toggle.center().y - chat_tab.center().y).abs() <= px(2.0)
            && (stage_toggle.center().y - chat_tab.center().y).abs() <= px(2.0),
        "Header controls misaligned vertically: ws={ws_btn:?}, inspector={inspector_toggle:?}, chat={chat_tab:?}, stage={stage_toggle:?}"
    );

    // 2. Open Session Context Inspector with 12 subagents & 15 worktrees:
    //    Composer MUST NOT move or get pushed off screen even when all subagents are expanded!
    desktop.press("Toggle session details").await;
    let inspector_wt = desktop.control("Switch worktree").await;
    let inspector_changes = desktop.control("Review workspace changes").await;
    assert!(
        inspector_wt.size.height >= px(40.0)
            && inspector_wt.size.height <= px(64.0)
            && inspector_changes.size.height >= px(24.0),
        "SessionInspector controls unexpected size: wt={inspector_wt:?}, changes={inspector_changes:?}"
    );
    #[cfg(not(windows))]
    {
        desktop.press("Show all (12)").await;
        desktop.control("Show less").await;
    }
    let composer_with_expanded_inspector = desktop.control("Focus message composer").await;
    assert!(
        (composer_with_expanded_inspector.top() - composer_before.top()).abs() <= px(2.0)
            && composer_with_expanded_inspector.bottom() <= px(840.0),
        "SessionInspector pushed Composer down! before={composer_before:?}, after={composer_with_expanded_inspector:?}"
    );
    desktop.artifact("ux-01-inspector-bounded-height");

    // Open searchable, scrollable WorktreePicker from SessionInspector:
    // verify search box + bounded popup height, then filter and select long-branch worktree
    desktop.press("Switch worktree").await;
    let wt_filter = desktop.control("Filter worktrees…").await;
    assert!(
        wt_filter.bottom() <= px(800.0),
        "Worktree filter out of bounds: {wt_filter:?}"
    );
    // Visible items inside the scrollable popover must stay strictly above window bottom (840pt)
    for visible_wt in desktop.controls("external-agent-automations") {
        assert!(
            visible_wt.bottom() <= px(820.0),
            "Worktree popover overflowed window bottom: {visible_wt:?}"
        );
    }
    desktop.artifact("ux-02-worktree-picker-scrollable");

    desktop.type_text("external-agent-automations").await;
    desktop.key("enter", false);
    desktop
        .until("Worktree popover did not close after selection", || {
            desktop
                .controls("Filter worktrees…")
                .is_empty()
                .then_some(())
        })
        .await;
    let wt_after_long = desktop.control("Switch worktree").await;
    assert!(
        wt_after_long.size.height <= px(64.0) && wt_after_long.size.width >= px(220.0),
        "Long branch name squashed or wrapped worktree card in SessionInspector: {wt_after_long:?}"
    );
    desktop.artifact("ux-03-inspector-long-branch-clean");

    // Close inspector and open Right Workspace Stage -> Launchpad -> Changes Studio
    desktop.press("Toggle session details").await;
    desktop.press("Toggle workspace pane").await;
    desktop.control("Files").await;

    // 3. Open Changes Studio while long-branch worktree is active: verify sub-header never squashes!
    desktop.press("Changes").await;
    let uncommitted_btn = desktop.control("Uncommitted").await;
    let studio_wt_pill = desktop.control("Switch worktree").await;
    assert!(
        uncommitted_btn.size.width >= px(72.0)
            && (uncommitted_btn.center().y - studio_wt_pill.center().y).abs() <= px(2.0),
        "ChangesStudio sub-header squashed by long worktree pill: uncommitted={uncommitted_btn:?}, wt={studio_wt_pill:?}"
    );
    desktop.artifact("ux-04-changes-studio-long-worktree");

    // Filter and switch back to main workspace via ChangesStudio WorktreePicker, then test compact file tab
    desktop.press("Switch worktree").await;
    desktop.control("Filter worktrees…").await;
    desktop.type_text("workspace").await;
    desktop.artifact("ux-05-worktree-picker-search");
    desktop.key("enter", false);
    desktop
        .until("Worktree picker did not close after pressing Enter", || {
            desktop
                .controls("Filter worktrees…")
                .is_empty()
                .then_some(())
        })
        .await;
    desktop.control("Changed files").await;

    let open_src = desktop
        .until("Open source file buttons did not appear", || {
            let btns = desktop.controls("Open source file");
            btns.get(1).copied().or_else(|| btns.first().copied())
        })
        .await;
    desktop.press_at(open_src.center());
    desktop.control("Go back").await;
    let file_tab = desktop
        .until("Compact file stage tab did not appear", || {
            desktop
                .controls("Preview src/engine.rs")
                .into_iter()
                .next()
                .or_else(|| desktop.controls("Preview Cargo.lock").into_iter().next())
        })
        .await;
    assert!(
        file_tab.size.width <= px(200.0),
        "Stage tab stretched abnormally wide: {file_tab:?}"
    );
    let find_button = desktop.control("Find in file").await;
    let editor_body_probe = Bounds::new(
        point(file_tab.left(), find_button.bottom() + px(24.0)),
        size(px(280.0), px(180.0)),
    );
    desktop
        .until(
            "CurrentFile Editor body collapsed to 0px or stayed blank",
            || desktop.draws_in(editor_body_probe).then_some(()),
        )
        .await;
    desktop.artifact("ux-06-file-editor-full-height");
    desktop.press("Go back").await;
    desktop.control("Changed files").await;

    // 4. Enter Fullscreen Stage + Expandable Floating Conversation PiP
    desktop.press("Enter fullscreen").await;
    desktop
        .until("Exit fullscreen control did not appear", || {
            (!desktop.controls("Exit fullscreen").is_empty()).then_some(())
        })
        .await;
    desktop.control("Expand conversation").await;
    desktop.artifact("ux-06-fullscreen-collapsed-pip");

    desktop.press("Expand conversation").await;
    desktop
        .until("Expanded conversation did not appear", || {
            (desktop.controls("Collapse conversation").len() >= 2).then_some(())
        })
        .await;
    desktop.artifact("ux-07-fullscreen-expanded-pip");

    // Optional live GitHub PR capture when MAKA_UX_CAPTURE_GITHUB_PR=1
    if std::env::var_os("MAKA_UX_CAPTURE_GITHUB_PR").is_some() {
        let new_tab = desktop
            .until("New tab control did not appear", || {
                desktop.controls("New tab").into_iter().next()
            })
            .await;
        desktop.press_at(new_tab.center());
        let search_box = desktop
            .until("Launchpad search box did not appear", || {
                desktop
                    .controls("Search files, PR #number, or branch…")
                    .into_iter()
                    .next()
            })
            .await;
        let previous = desktop.platform.text_input_target();
        desktop.press_at(search_box.center());
        desktop.target_after(previous).await;
        desktop.type_text("#6974").await;
        desktop.key("enter", false);
        desktop.control("Summary").await;
        let _ =
            tokio::time::timeout(Duration::from_secs(8), desktop.control("Open on GitHub")).await;
        tokio::time::sleep(Duration::from_millis(350)).await;
        desktop.artifact("ux-08-github-pr-summary");
    }

    let exit_fs = desktop
        .until("Exit fullscreen button missing", || {
            desktop.controls("Exit fullscreen").into_iter().next()
        })
        .await;
    desktop.press_at(exit_fs.center());
    desktop.control("Enter fullscreen").await;

    desktop.close().await;
    fixture.finish().await;
}

async fn desktop_remembers_home_model_across_reopen_and_unavailable_fallback() {
    let mut fixture = Fixture::open().await;
    let desktop = Desktop::open(&fixture, &fixture.address).await;
    desktop.new_draft().await;
    desktop
        .press_until(
            "Choose model and effort",
            "Use fixture-model-alt · NSH fixture",
        )
        .await;
    desktop.press("Use fixture-model-alt · NSH fixture").await;
    let saved = desktop
        .wait("selected home model was not saved", async {
            loop {
                if let Some(saved) = desktop.client.recent_model().await.unwrap()
                    && matches!(
                        &saved.backend,
                        maka_agent_facts::executor::BackendPreference::Model { model_id, .. }
                            if model_id == "fixture-model-alt"
                    )
                {
                    break saved;
                }
                tokio::task::yield_now().await;
            }
        })
        .await;
    assert_eq!(saved.label.as_deref(), Some("fixture-model-alt"));
    assert_eq!(desktop.sessions().await.len(), 1);

    let desktop = desktop
        .restart(&fixture, nsh_core::platform::Appearance::Dark)
        .await;
    desktop.target_after(None).await;
    desktop.type_text("HOME_MODEL_REMEMBERED").await;
    desktop.submit().await;
    let request = desktop.request(&mut fixture).await;
    assert_eq!(
        request.body["model"], "fixture-model-alt",
        "{}",
        request.body
    );
    desktop
        .wait("remembered-model message did not finish", request.finish())
        .await;

    desktop
        .press_until("Choose model and effort", "Use fixture-model · NSH fixture")
        .await;
    desktop.press("Use fixture-model · NSH fixture").await;
    desktop
        .wait("existing session did not switch to fixture-model", async {
            loop {
                let sessions = desktop.sessions().await;
                let created = sessions
                    .iter()
                    .find(|session| session["id"] != fixture.session)
                    .unwrap();
                if created["backend"]["modelId"] == "fixture-model" {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await;
    assert_eq!(
        desktop.client.recent_model().await.unwrap(),
        Some(saved.clone())
    );

    let mut stale_tier = saved.clone();
    if let maka_agent_facts::executor::BackendPreference::Model { service_tier, .. } =
        &mut stale_tier.backend
    {
        *service_tier = Some("fast".into());
    }
    desktop.client.set_recent_model(stale_tier).await.unwrap();
    let desktop = desktop
        .restart(&fixture, nsh_core::platform::Appearance::Dark)
        .await;
    desktop.target_after(None).await;
    desktop.type_text("STALE_SPEED_TIER_NORMALIZED").await;
    desktop.submit().await;
    let request = desktop.request(&mut fixture).await;
    assert_eq!(
        request.body["model"], "fixture-model-alt",
        "{}",
        request.body
    );
    desktop
        .wait("normalized-tier message did not finish", request.finish())
        .await;

    let unavailable = maka_app_client::RecentModel {
        backend: maka_agent_facts::executor::BackendPreference::Executor {
            selection: maka_agent_facts::executor::Selection {
                executor: "external".into(),
                settings: maka_agent_facts::executor::Settings {
                    runtime: Some("antigravity".into()),
                    model: Some("gemini-4-neon".into()),
                    thinking_level: Some(
                        maka_agent_facts::executor::Effort::try_from("high".to_owned()).unwrap(),
                    ),
                },
            },
        },
        label: Some("Gemini 4 Neon".into()),
    };
    desktop
        .client
        .set_recent_model(unavailable.clone())
        .await
        .unwrap();
    let desktop = desktop
        .restart(&fixture, nsh_core::platform::Appearance::Dark)
        .await;
    desktop.target_after(None).await;
    desktop.type_text("UNAVAILABLE_HOME_MODEL").await;
    desktop
        .retry(
            "unavailable remembered model did not fall back to Choose a model",
            || !desktop.controls("Manage models").is_empty(),
            || {
                if let [composer] = desktop.controls("Focus message composer").as_slice() {
                    desktop.press_at(composer.center());
                }
                desktop.key("enter", false);
            },
        )
        .await;
    assert_eq!(
        desktop.client.recent_model().await.unwrap(),
        Some(unavailable)
    );

    desktop.close().await;
    fixture.finish().await;
}

async fn desktop_renders_provider_citation_markers_as_clean_inline_chips() {
    let mut fixture = Fixture::configured(Options {
        responses: true,
        ..Options::default()
    })
    .await;
    let client = fixture.client().await;
    mutate(
        &client,
        "send",
        json!({"sessionId": fixture.session, "backend": {
            "kind": "model", "connectionId": fixture.selection["connectionId"],
            "modelId": fixture.selection["modelId"],
        }, "message": "排查 Windows VM 重启卡在 Hyper-V STIMER0 的原因，并核对 QEMU 上游记录"}),
    )
    .await;
    let mut reply = fixture.next_request().await;

    let commentary_prefix = "定位到了，卡住的 vCPU 反复在写 Hyper-V 的 `STIMER0`，和 QEMU 已记录的 AMD `hv_passthrough` 启动死锁对上了。我会只改这台 VM 的 CPU 参数，用显式的 Hyper-V 特性列表避开这个组合，保留 KVM 和现有磁盘。";
    let commentary_marker = "\u{E200}cite\u{E202}turn137145search0\u{E201}";
    let commentary_text = format!("{commentary_prefix} {commentary_marker}");
    let commentary_start = format!("{commentary_prefix} ").chars().count() as u64;
    let commentary_end = commentary_text.chars().count() as u64;

    let gitlab_url = "https://gitlab.com/qemu-project/qemu/-/work_items/3468";
    let gitlab_title = "hv-passthrough on AMD intermittently deadlocks Windows Server 2022 boot in STIMER0 re-arm loop (#3468) · Issues · QEMU / QEMU · GitLab";
    let github_url = "https://github.com/trycua/cua/commit/8caf2c5d66e8d9d4db11f5c4089a78cce";
    let github_title =
        "fix(ci): drop the linux-kvm (concurrent) quarantine · trycua/cua@8caf2c5 · GitHub";

    reply
        .packet(json!({"type":"response.output_item.done","item":{
            "type":"reasoning","id":"reason-stimer0",
            "summary":[{"type":"summary_text","text":"核对 QEMU AMD hv_passthrough 与 Hyper-V STIMER0 死锁 issue"}]
        }}))
        .await;
    reply
        .packet(json!({"type":"response.output_item.added","item":{
            "type":"message","id":"msg-commentary","role":"assistant","phase":"commentary","content":[]
        }}))
        .await;
    reply
        .packet(json!({"type":"response.output_text.delta","item_id":"msg-commentary","delta":format!("{commentary_prefix} \u{E200}ci")}))
        .await;
    reply
        .packet(json!({"type":"response.output_text.delta","item_id":"msg-commentary","delta":"te\u{E202}turn137145search0\u{E201}"}))
        .await;
    reply
        .packet(json!({"type":"response.output_item.done","item":{
            "type":"message","id":"msg-commentary","role":"assistant","phase":"commentary",
            "content":[{
                "type":"output_text",
                "text": commentary_text,
                "annotations":[{
                    "type":"url_citation",
                    "url": gitlab_url,
                    "title": gitlab_title,
                    "start_index": commentary_start,
                    "end_index": commentary_end
                }]
            }]
        }}))
        .await;

    let final_p1_a = "已定位根因：\u{E200}entity\u{E202}[\"software\",\"QEMU\",\"emulator\"]\u{E201} 在 AMD 宿主上开启 `hv_passthrough` 时会触发 \u{E203}STIMER0 re-arm loop\u{E204} 死锁";
    let final_m1 = "\u{E200}cite\u{E202}turn137145search0\u{E201}";
    let final_m2 = "\u{E200}cite\u{E202}turn903513view0\u{E201}";
    let final_p1_b = "，导致 Windows Guest 重启卡死。\n\n建议改为显式 Hyper-V 特性列表（关闭 `hv_passthrough`），保留 KVM 与现有磁盘。";
    let final_m3 = "\u{E200}cite\u{E202}turn137145search0\u{E201}";
    let final_text = format!("{final_p1_a} {final_m1} {final_m2}{final_p1_b} {final_m3}");
    let m1_start = format!("{final_p1_a} ").chars().count() as u64;
    let m1_end = m1_start + final_m1.chars().count() as u64;
    let m2_start = m1_end + 1;
    let m2_end = m2_start + final_m2.chars().count() as u64;
    let m3_start = format!("{final_p1_a} {final_m1} {final_m2}{final_p1_b} ")
        .chars()
        .count() as u64;
    let m3_end = final_text.chars().count() as u64;

    reply
        .packet(json!({"type":"response.output_item.done","item":{
            "type":"message","id":"msg-final","role":"assistant","phase":"final_answer",
            "content":[{
                "type":"output_text",
                "text": final_text,
                "annotations":[
                    {"type":"url_citation","url":gitlab_url,"title":gitlab_title,"start_index":m1_start,"end_index":m1_end},
                    {"type":"url_citation","url":github_url,"title":github_title,"start_index":m2_start,"end_index":m2_end},
                    {"type":"url_citation","url":gitlab_url,"title":gitlab_title,"start_index":m3_start,"end_index":m3_end}
                ]
            }]
        }}))
        .await;
    reply
        .packet(json!({"type":"response.completed","response":{
            "id":"response-citations","usage":{"input_tokens":42,"output_tokens":96}
        }}))
        .await;
    reply.finish_stream().await;

    let desktop = Desktop::open_at(
        &fixture,
        &fixture.address,
        size(
            nsh_terminal::DevicePixels(1080),
            nsh_terminal::DevicePixels(760),
        ),
        nsh_core::platform::Appearance::Dark,
    )
    .await;

    desktop
        .until(
            "inline citation chips did not appear on final answer",
            || {
                (desktop.controls("gitlab.com").len() == 2
                    && desktop.controls("github.com").len() == 1)
                    .then_some(())
            },
        )
        .await;

    desktop.artifact("01-final-answer");

    let copy = desktop.control("Copy message").await;
    let copied = desktop
        .copy_at("final answer was not copied", copy.center())
        .await;
    assert_eq!(
        copied,
        "已定位根因：QEMU 在 AMD 宿主上开启 `hv_passthrough` 时会触发 STIMER0 re-arm loop 死锁，导致 Windows Guest 重启卡死。\n\n建议改为显式 Hyper-V 特性列表（关闭 `hv_passthrough`），保留 KVM 与现有磁盘。"
    );

    desktop.press("Turn work details").await;
    desktop
        .until("expanded commentary citation chip did not appear", || {
            (desktop.controls("gitlab.com").len() == 3 && desktop.controls("github.com").len() == 1)
                .then_some(())
        })
        .await;
    desktop.artifact("02-expanded-commentary");

    desktop.press("Sources").await;
    desktop
        .until("sources inspector links did not appear", || {
            (!desktop.controls(gitlab_title).is_empty()
                && !desktop.controls(github_title).is_empty())
            .then_some(())
        })
        .await;
    desktop.artifact("03-sources-inspector");

    desktop.close().await;
    fixture.finish().await;
}

async fn desktop_external_agent_satisfies_new_session_connection_prompt() {
    let fixture = Fixture::open_with_configuration(
        Options {
            no_connections: true,
            ..Options::default()
        },
        |configuration, directory| {
            configuration["agent"]["external"] = json!({
                "commands": {
                    "antigravity": {
                        "executable": directory.join("missing-antigravity"),
                    }
                }
            });
        },
    )
    .await;

    let desktop = Desktop::open(&fixture, &fixture.address).await;
    desktop.control("Add a model connection").await;
    desktop.new_draft().await;
    desktop.control("Add a model connection").await;

    desktop.press("Add a model connection").await;
    desktop.control("Enable Antigravity").await;
    desktop.press("Enable Antigravity").await;
    desktop
        .control("I understand and accept the external agent permissions")
        .await;
    desktop
        .press("I understand and accept the external agent permissions")
        .await;
    desktop.press("Confirm permissions and enable").await;
    desktop.control("Disable Antigravity").await;

    desktop.press("Close settings").await;
    desktop.control("Focus message composer").await;
    desktop
        .until(
            "enabled external agent did not clear the missing-connection prompt",
            || {
                desktop
                    .controls("Add a model connection")
                    .is_empty()
                    .then_some(())
            },
        )
        .await;

    desktop.press("Open settings").await;
    desktop.control("Disable Antigravity").await;
    desktop.press("Disable Antigravity").await;
    desktop.control("Enable Antigravity").await;

    desktop.press("Close settings").await;
    desktop.control("Add a model connection").await;

    // Enabling an external agent from another client on the same Host updates
    // the visible start pane without reopening Settings.
    let other_client = desktop.wait("connect peer client", fixture.client()).await;
    let deployment = desktop
        .wait(
            "management read failed",
            other_client.query("management", "read", json!({})),
        )
        .await
        .unwrap();
    let external = desktop
        .wait(
            "externalAgents query failed",
            other_client.query("agent", "externalAgents", json!({"inspect": true})),
        )
        .await
        .unwrap();
    let mut path = external["target"]["path"].as_array().unwrap().clone();
    path.push(json!("runtimes"));
    path.push(json!("antigravity"));
    let configured = desktop
        .wait(
            "management configureBatch failed",
            mutate_service(
                &other_client,
                "management",
                "configureBatch",
                json!({
                    "expectedRevision": deployment["source"]["reference"]["revision"],
                    "edits": [{
                        "instance": external["target"]["source"]["namespace"],
                        "changes": [{
                            "path": path,
                            "value": { "kind": "boolean", "value": true },
                        }],
                    }],
                }),
            ),
        )
        .await;
    assert_eq!(configured["status"], "committed");
    desktop
        .until(
            "external agent enabled by another client did not clear the missing-connection prompt",
            || {
                desktop
                    .controls("Add a model connection")
                    .is_empty()
                    .then_some(())
            },
        )
        .await;

    desktop.close().await;
    fixture.finish().await;
}

/// Native cases run on the process main thread, required by AppKit.
pub(crate) const CASES: &[&str] = &[
    "desktop_external_agent_satisfies_new_session_connection_prompt",
    "desktop_room_reply_wakes_an_agent_without_mixing_drafts",
    "desktop_remembers_folders_without_restoring_unsent_drafts",
    "desktop_remembers_home_model_across_reopen_and_unavailable_fallback",
    "desktop_composer_click_and_ime_follow_the_text_after_a_mention",
    "desktop_composer_previews_markdown_and_sends_its_source",
    "desktop_creates_only_on_first_submission_and_preserves_the_confirmed_snapshot",
    "desktop_continues_a_failed_run_without_duplicating_the_user_message",
    "desktop_history_anchors_keep_the_reader_off_live_output_until_latest",
    #[cfg(target_os = "macos")]
    "desktop_resumes_live_activity_when_scrolling_back_to_latest",
    "desktop_edits_a_message_in_place_and_forks_only_when_sent",
    "desktop_asks_a_side_question_beside_a_reply",
    "desktop_steering_freezes_each_message_and_queue_is_one_shot",
    "desktop_file_gestures_preserve_drafts_and_stage_an_image",
    "desktop_composer_large_paste_keeps_controls_on_screen",
    "desktop_system_permission_guidance_uses_native_actions_without_paths",
    "desktop_workspace_stage_inspector_worktrees_and_fullscreen_review",
    "desktop_renders_provider_citation_markers_as_clean_inline_chips",
];

pub(crate) fn run(name: &str) {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(4)
        .enable_all()
        .build()
        .unwrap();
    match name {
        "desktop_external_agent_satisfies_new_session_connection_prompt" => {
            runtime.block_on(desktop_external_agent_satisfies_new_session_connection_prompt())
        }
        "desktop_room_reply_wakes_an_agent_without_mixing_drafts" => {
            runtime.block_on(rooms::desktop_room_reply_wakes_an_agent_without_mixing_drafts())
        }
        "desktop_remembers_folders_without_restoring_unsent_drafts" => {
            runtime.block_on(desktop_remembers_folders_without_restoring_unsent_drafts())
        }
        "desktop_remembers_home_model_across_reopen_and_unavailable_fallback" => {
            runtime.block_on(desktop_remembers_home_model_across_reopen_and_unavailable_fallback())
        }
        "desktop_composer_click_and_ime_follow_the_text_after_a_mention" => {
            runtime.block_on(desktop_composer_click_and_ime_follow_the_text_after_a_mention())
        }
        "desktop_composer_previews_markdown_and_sends_its_source" => {
            runtime.block_on(desktop_composer_previews_markdown_and_sends_its_source())
        }
        "desktop_creates_only_on_first_submission_and_preserves_the_confirmed_snapshot" => runtime
            .block_on(
                desktop_creates_only_on_first_submission_and_preserves_the_confirmed_snapshot(),
            ),
        "desktop_continues_a_failed_run_without_duplicating_the_user_message" => {
            runtime.block_on(desktop_continues_a_failed_run_without_duplicating_the_user_message())
        }
        "desktop_history_anchors_keep_the_reader_off_live_output_until_latest" => {
            runtime.block_on(desktop_history_anchors_keep_the_reader_off_live_output_until_latest())
        }
        #[cfg(target_os = "macos")]
        "desktop_resumes_live_activity_when_scrolling_back_to_latest" => {
            runtime.block_on(desktop_resumes_live_activity_when_scrolling_back_to_latest())
        }
        "desktop_edits_a_message_in_place_and_forks_only_when_sent" => {
            runtime.block_on(desktop_edits_a_message_in_place_and_forks_only_when_sent())
        }
        "desktop_asks_a_side_question_beside_a_reply" => {
            runtime.block_on(desktop_asks_a_side_question_beside_a_reply())
        }
        "desktop_steering_freezes_each_message_and_queue_is_one_shot" => {
            runtime.block_on(desktop_steering_freezes_each_message_and_queue_is_one_shot())
        }
        "desktop_file_gestures_preserve_drafts_and_stage_an_image" => {
            runtime.block_on(desktop_file_gestures_preserve_drafts_and_stage_an_image())
        }
        "desktop_composer_large_paste_keeps_controls_on_screen" => {
            runtime.block_on(desktop_composer_large_paste_keeps_controls_on_screen())
        }
        "desktop_system_permission_guidance_uses_native_actions_without_paths" => {
            runtime.block_on(desktop_system_permission_guidance_uses_native_actions_without_paths())
        }
        "desktop_workspace_stage_inspector_worktrees_and_fullscreen_review" => {
            runtime.block_on(desktop_workspace_stage_inspector_worktrees_and_fullscreen_review())
        }
        "desktop_renders_provider_citation_markers_as_clean_inline_chips" => {
            runtime.block_on(desktop_renders_provider_citation_markers_as_clean_inline_chips())
        }
        other => panic!("unknown native desktop case: {other}"),
    }
}
