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

use super::support::{Fixture, ModelRequest, Options, ReplyGate, mutate};
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
    sync::{Arc, Mutex, atomic::Ordering},
    time::Duration,
};
use tokio::sync::{Notify, watch};

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

    fn event(&self, name: &str, value: Value) {
        self.host.send(name, value).unwrap();
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
        let rendered = [
            "Focus message composer",
            "Send message",
            "Stop response",
            "Add to queue",
            "Edit queued message 1",
            "Retry message",
            "Continue response",
            "Messages",
        ]
        .map(|label| (label, self.controls(label)));
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

    async fn copy_input(&self) -> String {
        self.target_after(None).await;
        let _ = self.platform.take_clipboard_write();
        self.key("a", true);
        self.key("c", true);
        self.until("the selected draft was not copied", || {
            self.platform.take_clipboard_write()
        })
        .await
    }

    async fn paste(&self, text: &str) {
        self.target_after(None).await;
        assert!(self.platform.paste(nsh_core::PasteEvent::new(text)));
    }

    async fn type_text(&self, text: &str) {
        self.target_after(None).await;
        self.key("a", true);
        assert!(self.platform.paste(nsh_core::PasteEvent::new(text)));
        self.expect_text(text).await;
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

    fn drag(
        &self,
        from: nsh_terminal::Point<nsh_terminal::Pixels>,
        to: nsh_terminal::Point<nsh_terminal::Pixels>,
    ) {
        self.platform
            .dispatch_input(PlatformInput::MouseDown(native!(MouseDownEvent {
                button: MouseButton::Left,
                position: from,
                click_count: 1,
            })))
            .unwrap();
        self.pump();
        for part in 1..=5 {
            self.platform
                .dispatch_input(PlatformInput::MouseMove(native!(MouseMoveEvent {
                    pressed_button: Some(MouseButton::Left),
                    position: point(from.x + (to.x - from.x) * (part as f32 / 5.), from.y),
                })))
                .unwrap();
            self.pump();
        }
        self.platform
            .dispatch_input(PlatformInput::MouseUp(native!(MouseUpEvent {
                button: MouseButton::Left,
                position: to,
                click_count: 1,
            })))
            .unwrap();
        self.pump();
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
    let _ = desktop.platform.take_clipboard_write();
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

async fn desktop_new_conversation_preserves_an_owned_worktree() {
    let mut fixture = Fixture::open_with_configuration(Options::default(), |config, directory| {
        config["agent"]["permissions"]["access"] = json!("workspace_write");
        config["agent"]["workspaceRoots"]
            .as_array_mut()
            .unwrap()
            .push(json!({
                "label":"Parent", "path":directory
            }));
        // Project skill discovery currently excludes the Host's private worktree directory.
        config["agent"]["skillLibrary"] = Value::Null;
        let workspace = directory.join("workspace");
        std::fs::write(workspace.join("tracked.txt"), "base").unwrap();
        for args in [
            vec!["init", "--quiet"],
            vec!["add", "tracked.txt"],
            vec![
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "--quiet",
                "-m",
                "base",
            ],
        ] {
            let result = std::process::Command::new("git")
                .arg("-C")
                .arg(&workspace)
                .args(args)
                .output()
                .unwrap();
            assert!(
                result.status.success(),
                "{}",
                String::from_utf8_lossy(&result.stderr)
            );
        }
    })
    .await;
    let client = fixture.client().await;
    let roots = client
        .query("agent", "directories", json!({"kind":"roots"}))
        .await
        .unwrap();
    let created = mutate(
        &client,
        "create",
        json!({
            "title":"Isolated", "labels":[],
            "workspace":{"kind":"isolated_git", "path":roots["roots"][0]["path"]}
        }),
    )
    .await;
    assert_eq!(created["kind"], "created", "{created}");
    fixture.session = created["session"]["id"].as_str().unwrap().to_owned();
    let workspace = created["session"]["workspace"].clone();
    assert!(!workspace["worktree"].is_null());
    client.close().await.unwrap();
    let desktop = Desktop::open(&fixture, &fixture.address).await;
    desktop.new_draft().await;
    desktop.type_text("SAME_OWNED_WORKTREE").await;
    desktop.submit().await;
    let request = desktop.request(&mut fixture).await;
    assert!(request.body.to_string().contains("SAME_OWNED_WORKTREE"));
    desktop
        .wait("message did not finish", request.finish())
        .await;
    let sessions = desktop.sessions().await;
    assert_eq!(sessions.len(), 3);
    let sent = sessions
        .iter()
        .find(|session| {
            session["id"] != fixture.session && session["workspace"]["path"] == workspace["path"]
        })
        .unwrap();
    assert_eq!(sent["workspace"]["worktree"], workspace["worktree"]);
    assert!(desktop.client.recent_workspaces().await.unwrap().is_empty());
    desktop.close().await;
    fixture.finish().await;
}

async fn desktop_recovers_an_unavailable_remembered_folder() {
    let fixture = images_fixture().await;
    let desktop = Desktop::open(&fixture, &fixture.address).await;
    let previous = desktop.platform.text_input_target();
    desktop.press("New conversation in workspace").await;
    desktop.target_after(previous).await;
    let workspace = fixture.directory.path().join("workspace");
    desktop
        .wait("folder selection was not saved", async {
            while desktop.client.recent_workspaces().await.unwrap().is_empty() {
                tokio::task::yield_now().await;
            }
        })
        .await;
    std::fs::rename(&workspace, fixture.directory.path().join("moved-workspace")).unwrap();
    let desktop = desktop
        .restart(&fixture, nsh_core::platform::Appearance::Dark)
        .await;
    desktop.target_after(None).await;
    desktop.type_text("KEEP_CURRENT_WINDOW_DRAFT").await;
    desktop.control("Retry folder").await;
    desktop.key("enter", false);
    assert_eq!(desktop.sessions().await.len(), 1);
    assert_eq!(fixture.request_count.load(Ordering::SeqCst), 0);
    std::fs::rename(fixture.directory.path().join("moved-workspace"), &workspace).unwrap();
    desktop
        .retry(
            "restored folder did not become usable",
            || !desktop.controls("Send message").is_empty(),
            || {
                if let Some(bounds) = desktop.controls("Retry folder").first() {
                    desktop.press_at(bounds.center());
                }
            },
        )
        .await;
    desktop.press("Focus message composer").await;
    desktop.expect_text("KEEP_CURRENT_WINDOW_DRAFT").await;
    assert!(workspace.is_dir());
    let sessions = desktop.sessions().await;
    assert_eq!(sessions.len(), 1);
    assert_eq!(
        sessions[0]["workspace"]["path"],
        workspace.to_str().unwrap()
    );
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

async fn desktop_new_draft_completes_commands_skills_and_files_without_creating_a_session() {
    let fixture = Fixture::open_with_configuration(Options::default(), |_, directory| {
        let skill = directory.join("assistant-home/.maka/skills/draft-guide");
        std::fs::create_dir_all(&skill).unwrap();
        std::fs::write(
            skill.join("SKILL.md"),
            "---\nname: draft-guide\ndescription: Guide for a new draft\n---\nReview the workspace.",
        )
        .unwrap();
        std::fs::write(directory.join("workspace/draft-reference.md"), "Reference").unwrap();
    })
    .await;
    let desktop = Desktop::open(&fixture, &fixture.address).await;
    desktop.new_draft().await;
    desktop.paste("/set").await;
    desktop.control("/settings").await;
    desktop.control("Send message").await;
    desktop.artifact("new-draft-slash-menu");
    desktop
        .retry(
            "the slash command did not open settings",
            || !desktop.controls("Close settings").is_empty(),
            || {
                if let [bounds] = desktop.controls("/settings").as_slice() {
                    desktop.press_at(bounds.center());
                }
            },
        )
        .await;
    desktop.control("Close settings").await;
    desktop.artifact("new-draft-slash-settings");
    desktop.press("Close settings").await;
    desktop.press("Focus message composer").await;
    desktop
        .until("the command did not leave an empty new draft", || {
            desktop.controls("Send message").is_empty().then_some(())
        })
        .await;
    desktop.artifact("new-draft-slash-consumed");
    desktop.paste("AFTER_SLASH_COMMAND").await;
    desktop.expect_text("AFTER_SLASH_COMMAND").await;
    desktop.type_text("/draft").await;
    desktop.key("right", false);
    desktop.control("draft-guide").await;
    desktop.artifact("new-draft-skill-menu");
    desktop.press("draft-guide").await;
    desktop.expect_text("/skill:draft-guide ").await;
    desktop.key("right", false);
    desktop.paste("@draft-ref").await;
    desktop.control("draft-reference.md").await;
    desktop.artifact("new-draft-file-menu");
    desktop.press("draft-reference.md").await;
    desktop
        .expect_text("/skill:draft-guide @draft-reference.md ")
        .await;
    desktop.press("Add to message").await;
    desktop.press("Use a skill").await;
    desktop.control("draft-guide").await;
    desktop.artifact("new-draft-add-skill-menu");
    desktop.press("draft-guide").await;
    desktop.expect_text("/skill:draft-guide ").await;
    assert_eq!(desktop.sessions().await.len(), 1);
    assert_eq!(fixture.request_count.load(Ordering::SeqCst), 0);
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
    assert_eq!(fixture.request_count.load(Ordering::SeqCst), 1);
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
    desktop.control("Continue response").await;
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
    assert_eq!(fixture.request_count.load(Ordering::SeqCst), 2);
    desktop.close().await;
    fixture.finish().await;
}

async fn desktop_message_actions_show_on_hover_or_focus_and_in_a_context_menu() {
    let mut fixture = Fixture::open().await;
    let desktop = Desktop::open(&fixture, &fixture.address).await;
    desktop.new_draft().await;
    desktop.type_text("ACTIONS_QUESTION").await;
    desktop.submit().await;
    let mut reply = desktop.request(&mut fixture).await;
    reply.delta("ACTIONS_REPLY").await;
    desktop
        .wait("the reply did not finish", reply.finish())
        .await;
    let copy = desktop.control("Copy message").await;
    let composer = desktop.control("Focus message composer").await.center();
    // Inside the reply, above its row of actions.
    let body = point(copy.center().x + px(64.), copy.top() - px(16.));
    desktop.hover_at(composer);
    desktop
        .until("the reply's actions showed at rest", || {
            (!desktop.draws_in(copy)).then_some(())
        })
        .await;
    desktop.hover_at(body);
    desktop
        .until("the reply's actions did not show on hover", || {
            desktop.draws_in(copy).then_some(())
        })
        .await;
    assert_eq!(desktop.control("Copy message").await, copy);
    desktop.hover_at(composer);
    desktop
        .until("the reply's actions stayed after the pointer left", || {
            (!desktop.draws_in(copy)).then_some(())
        })
        .await;
    desktop
        .retry(
            "keyboard focus did not reveal the reply's actions",
            || desktop.draws_in(copy),
            || desktop.key_with("tab", native!(Modifiers { shift: true })),
        )
        .await;

    // On a control rather than the text, which offers its own Copy menu natively.
    desktop.click_at(copy.center(), MouseButton::Right);
    let menu = desktop
        .until(
            "the reply's context menu did not offer its commands",
            || {
                let copies = desktop.controls("Copy message");
                (copies.len() == 2
                    && desktop.controls("Fork from this turn").len() == 2
                    && desktop.controls("Regenerate in a fork").len() == 2
                    && desktop.controls("Show message source").len() == 2)
                    .then(|| copies.into_iter().find(|item| *item != copy).unwrap())
            },
        )
        .await;
    let _ = desktop.platform.take_clipboard_write();
    desktop.press_at(menu.center());
    let copied = desktop
        .until("the context menu did not copy the reply", || {
            desktop.platform.take_clipboard_write()
        })
        .await;
    assert_eq!(copied, "ACTIONS_REPLY");

    let own = desktop.control("Copy user message").await;
    desktop.click_at(own.center(), MouseButton::Right);
    desktop
        .until(
            "the user message's context menu did not offer its commands",
            || {
                (desktop.controls("Copy user message").len() == 2
                    && desktop.controls("Edit and resend in a fork").len() == 2
                    && desktop.controls("Show message source").len() == 1)
                    .then_some(())
            },
        )
        .await;
    desktop.key("escape", false);
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

    // Opening the editor and leaving it creates nothing.
    let pencil = desktop.control("Edit and resend in a fork").await;
    desktop.hover_at(pencil.center());
    desktop
        .retry(
            "the pencil did not open the message editor",
            || !desktop.controls("Send edited message in a fork").is_empty(),
            || desktop.press_at(pencil.center()),
        )
        .await;
    desktop.expect_text("ORIGINAL_EDIT_MESSAGE").await;
    desktop.artifact("message-editor");
    assert!(desktop.controls("Edit and resend in a fork").is_empty());
    assert_eq!(desktop.sessions().await.len(), 2);
    desktop.key("escape", false);
    desktop
        .until("escape did not close the message editor", || {
            desktop
                .controls("Send edited message in a fork")
                .is_empty()
                .then_some(())
        })
        .await;
    assert_eq!(desktop.sessions().await.len(), 2);

    // Sending the edit forks once, before the edited turn, and sends the new text there.
    let pencil = desktop.control("Edit and resend in a fork").await;
    desktop.hover_at(pencil.center());
    desktop
        .retry(
            "the pencil did not open the message editor",
            || !desktop.controls("Send edited message in a fork").is_empty(),
            || desktop.press_at(pencil.center()),
        )
        .await;
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
    assert_eq!(fixture.request_count.load(Ordering::SeqCst), 2);
    desktop.close().await;
    fixture.finish().await;
}

async fn desktop_lists_a_scripts_tool_calls_in_place_of_the_script() {
    let mut fixture = Fixture::configured(Options {
        code_mode: true,
        ..Options::default()
    })
    .await;
    let desktop = Desktop::open(&fixture, &fixture.address).await;
    desktop.new_draft().await;
    desktop.type_text("Check the goal").await;
    desktop.submit().await;
    desktop
        .request(&mut fixture)
        .await
        .tool_call("exec", json!({"code":"text(await tools.GetGoal({}));"}))
        .await;
    let mut answer = desktop.request(&mut fixture).await;
    // A running turn is open under its summary row, with no group header of its own.
    let summary = desktop.control("Turn work details").await;
    let nested = desktop.control("Toggle tool Read goal").await;
    assert!(desktop.controls("Process group").is_empty());
    // A turn has two lanes and no indent: each step's icon sits under the
    // summary's chevron, and an open tool card starts on that same lane.
    assert_eq!(nested.left(), summary.left());
    assert!(desktop.controls("Toggle tool Run script").is_empty());
    desktop.press("Toggle tool Read goal").await;
    let lane = nested.left() + px(8.);
    let below = nested.bottom() + px(24.);
    desktop
        .until("the tool card did not start on the icon lane", || {
            desktop.pump();
            let strip = desktop.pixels(Bounds::new(
                point(lane - px(2.), below),
                size(px(4.), px(1.)),
            ))?;
            let [outside, before, edge, inside] = strip.as_chunks::<4>().0 else {
                return None;
            };
            (outside == before && before != edge && edge == inside).then_some(())
        })
        .await;
    desktop.artifact("script-tools");
    answer
        .thinking("Checking the log\n\nLook for the next step.")
        .await;
    let thinking = desktop.control("Thinking · Checking the log").await;
    let user = desktop.control("Copy user message").await;
    let tool = desktop.control("Toggle tool Read goal").await;
    let [working] = desktop
        .controls("Turn work details")
        .try_into()
        .expect("the running summary remains visible and expandable while thinking streams");
    assert!(user.bottom() < working.top());
    assert!(working.bottom() <= tool.top());
    assert!(tool.bottom() <= thinking.top());
    desktop.artifact("streaming-thinking-order");
    let sessions = desktop.sessions().await;
    let session = sessions
        .iter()
        .find(|session| session["id"] != fixture.session)
        .unwrap()["id"]
        .as_str()
        .unwrap();
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
    let read_requests = |through: u64| {
        desktop.client.query(
            "agent",
            "historyRequests",
            json!({
                "sessionId":session, "through":through, "position":opening["position"]
            }),
        )
    };
    let live_first_token = desktop
        .wait(
            "the streaming request has no first-token timestamp",
            async {
                loop {
                    let observed = desktop
                        .client
                        .query("agent", "observe", json!({"sessionId":session}))
                        .await
                        .unwrap();
                    let live = read_requests(observed["through"].as_u64().unwrap())
                        .await
                        .unwrap();
                    let streaming = &live["requests"][1];
                    if let Some(at) = streaming["firstTokenAt"].as_u64() {
                        assert!(streaming["finished"].is_null());
                        break at;
                    }
                }
            },
        )
        .await;
    answer.delta("The goal is unchanged.").await;
    answer.finish().await;
    fixture.idle(&desktop.client, session).await;
    desktop.control("Copy message").await;
    desktop
        .until("completed answer did not fold the turn's work", || {
            (desktop.controls("Toggle tool Read goal").is_empty()
                && desktop.controls("Thinking · Checking the log").is_empty())
            .then_some(())
        })
        .await;
    desktop.artifact("completed-answer-folded-work");
    desktop.press("Turn work details").await;
    desktop.control("Toggle tool Read goal").await;
    assert_eq!(
        desktop.control("Turn work details").await.origin,
        summary.origin
    );
    let observed = desktop
        .client
        .query("agent", "observe", json!({"sessionId":session}))
        .await
        .unwrap();
    let trace = read_requests(observed["through"].as_u64().unwrap())
        .await
        .unwrap();
    let attempts = trace["requests"].as_array().unwrap();
    assert_eq!(attempts.len(), 2);
    assert_eq!(attempts[1]["firstTokenAt"], live_first_token);
    for attempt in attempts {
        assert_eq!(attempt["finished"]["outcome"], "success");
        assert_eq!(attempt["finished"]["usage"]["input_tokens"], 1);
        let started = attempt["startedAt"].as_u64().unwrap();
        let first_token = attempt["firstTokenAt"].as_u64().unwrap();
        assert!(
            started <= first_token && first_token <= attempt["finished"]["at"].as_u64().unwrap()
        );
        assert!(attempt["estimatedInputTokens"].is_number());
    }
    let after = attempts[0]["order"]["path"]
        .as_array()
        .unwrap()
        .last()
        .unwrap();
    let tail = desktop.client.query("agent", "historyRequests", json!({
        "sessionId":session, "through":observed["through"], "position":opening["position"], "after":after
    })).await.unwrap();
    assert_eq!(tail["requests"], json!([attempts[1]]));
    desktop.press("Turn work details").await;
    desktop.press("Trajectory").await;
    desktop.control("Inspect User input").await;
    desktop.control("Inspect Run script").await;
    desktop.control("Inspect Assistant output").await;
    let parent = desktop.control("Inspect Run script").await;
    let child = desktop.control("Inspect Read goal").await;
    assert!(parent.bottom() <= child.top());
    let requests = desktop
        .until(
            "both model requests must be visible, including the tool-only request",
            || {
                let rows = desktop.controls("Inspect model request fixture-model");
                (rows.len() == 2).then_some(rows)
            },
        )
        .await;
    assert!(requests[0].bottom() <= parent.top());
    desktop.artifact("trajectory-ledger");
    desktop.press_at(requests[0].center());
    desktop.control("Close record details").await;
    desktop.artifact("trajectory-model-request");
    desktop.press("Close record details").await;

    let started = attempts[0]["startedAt"].as_i64().unwrap();
    let local = jiff::Timestamp::from_millisecond(started)
        .unwrap()
        .to_zoned(jiff::tz::TimeZone::system());
    let timeline_label = format!(
        "Go to request at {:02}:{:02}:{:02}.{:03}",
        local.hour(),
        local.minute(),
        local.second(),
        started % 1000
    );
    let full_bar = desktop.control(&timeline_label).await;
    let from = full_bar.center();
    let to = point(from.x + full_bar.size.width * 0.3, from.y);
    desktop.drag(from, to);
    desktop.control("Clear timeline selection").await;
    desktop.control("Inspect model request fixture-model").await;
    assert!(desktop.controls("Inspect Assistant output").is_empty());
    desktop.artifact("trajectory-selected-range");

    desktop.press("Zoom in timeline").await;
    desktop.control("Zoom out timeline").await;
    let zoomed = desktop.control(&timeline_label).await;
    assert!(zoomed.size.width > full_bar.size.width);
    desktop.press_at(zoomed.center());
    desktop.control("Close record details").await;
    desktop.artifact("trajectory-zoomed-request");
    desktop.press("Close record details").await;
    desktop.press("Zoom out timeline").await;
    desktop.press("Fit timeline").await;
    assert_eq!(desktop.control(&timeline_label).await, full_bar);
    desktop.press("Clear timeline selection").await;
    desktop.control("Inspect Assistant output").await;

    desktop.press("Collapse all subcalls").await;
    desktop.control("Expand all subcalls").await;
    assert!(desktop.controls("Inspect Read goal").is_empty());
    desktop.press("Collapse all turns").await;
    let fold = desktop.control("Expand all turns").await;
    assert!(desktop.controls("Inspect Read goal").is_empty());
    let previous = desktop.platform.text_input_target();
    desktop.press_at(point(fold.left() - px(32.), fold.center().y));
    desktop.target_after(previous).await;
    assert!(desktop.platform.paste(nsh_core::PasteEvent::new("GetGoal")));
    desktop.press("Inspect Read goal").await;
    desktop.control("Close record details").await;
    desktop.control("Toggle original tool details").await;
    desktop.artifact("trajectory-record-inspector");

    desktop.press("Chat").await;
    desktop.control("Copy message").await;
    assert!(desktop.controls("Toggle tool Read goal").is_empty());

    desktop.press("Turn work details").await;
    desktop.control("Toggle tool Read goal").await;
    if desktop.controls("Inspect in execution process").is_empty() {
        desktop.press("Toggle tool Read goal").await;
    }
    desktop.press("Inspect in execution process").await;
    desktop.control("Inspect Read goal").await;
    desktop.control("Close record details").await;
    desktop.close().await;
    fixture.finish().await;
}

async fn desktop_presents_session_tools_in_chat_and_trajectory() {
    let mut fixture = Fixture::open_with_configuration(
        Options {
            session_tools: true,
            ..Options::default()
        },
        |configuration, _| configuration["agent"]["toolDiscovery"] = json!(false),
    )
    .await;
    let desktop = Desktop::open(&fixture, &fixture.address).await;
    desktop.new_draft().await;
    desktop.type_text("Ask the worker for an update.").await;
    desktop.submit().await;
    desktop
        .request(&mut fixture)
        .await
        .tool_call(
            "SessionSend",
            json!({
                "sessionId": "00000000-0000-4000-8000-000000000001",
                "message": "Check the compiler output."
            }),
        )
        .await;
    let answer = desktop.request(&mut fixture).await;
    assert!(
        answer
            .body
            .to_string()
            .contains("agent_session_unavailable"),
        "{}",
        answer.body
    );
    let title = "Send message to agent · Check the compiler output.";
    let row = format!("Toggle tool {title}");
    desktop.control(&row).await;
    desktop.artifact("session-send-collapsed");
    desktop.press(&row).await;
    desktop.control("Toggle original tool details").await;
    desktop.artifact("session-send-expanded");
    desktop.press("Toggle original tool details").await;
    desktop.control("Toggle original tool details").await;
    desktop.press(&row).await;

    let session = desktop
        .sessions()
        .await
        .into_iter()
        .find(|item| item["id"] != fixture.session)
        .unwrap();
    let observed = desktop
        .client
        .query("agent", "observe", json!({"sessionId": session["id"]}))
        .await
        .unwrap();
    answer
        .tool_call(
            "SessionWork",
            json!({
                "sessionId": session["id"],
                "target": {"kind": "run", "runId": observed["run"]["runId"]}
            }),
        )
        .await;
    let final_answer = desktop.request(&mut fixture).await;
    assert!(
        final_answer.body.to_string().contains("delivered"),
        "{}",
        final_answer.body
    );
    desktop
        .press("Toggle tool Check conversation progress")
        .await;
    desktop.control("Toggle original tool details").await;
    desktop.artifact("session-work-expanded");

    desktop.press("Trajectory").await;
    desktop.control(&format!("Inspect {title}")).await;
    desktop.control("Inspect Check conversation progress").await;
    final_answer.finish().await;
    desktop.close().await;
    fixture.finish().await;
}

async fn desktop_previews_an_incoming_session_message() {
    let mut fixture = Fixture::open_with_configuration(
        Options {
            session_tools: true,
            ..Options::default()
        },
        |configuration, _| configuration["agent"]["toolDiscovery"] = json!(false),
    )
    .await;
    let desktop = Desktop::open_at(
        &fixture,
        &fixture.address,
        size(
            nsh_terminal::DevicePixels(1440),
            nsh_terminal::DevicePixels(800),
        ),
        nsh_core::platform::Appearance::Dark,
    )
    .await;
    let roots = desktop
        .client
        .query("agent", "directories", json!({"kind":"roots"}))
        .await
        .unwrap();
    let backend = json!({
        "kind": "model",
        "connectionId": fixture.selection["connectionId"],
        "modelId": fixture.selection["modelId"],
    });
    let recipient = mutate(
        &desktop.client,
        "create",
        json!({
            "title": "Build review", "labels": [],
            "backend": backend,
            "workspace": {"kind":"directory", "path":roots["roots"][0]["path"]}
        }),
    )
    .await;
    mutate(
        &desktop.client,
        "send",
        json!({"sessionId": fixture.session, "backend": backend, "message": "Tell the build reviewer what to check."}),
    )
    .await;
    desktop
        .request(&mut fixture)
        .await
        .tool_call(
            "SessionSend",
            json!({
                "sessionId": recipient["session"]["id"],
                "message": "**The build passed.**\nPlease review the compiler warnings."
            }),
        )
        .await;
    desktop.press("Open conversation Build review").await;
    let summary = "From NSH real Agent · The build passed. Please review the compiler warnings.";
    desktop.control(summary).await;
    desktop.artifact("incoming-session-message-collapsed");
    desktop.press(summary).await;
    desktop.control("From NSH real Agent").await;
    desktop.artifact("incoming-session-message-expanded");
    desktop
        .press("Open source conversation beside this one")
        .await;
    desktop.control("Close side pane").await;
    desktop.request(&mut fixture).await.finish().await;
    desktop.request(&mut fixture).await.finish().await;
    desktop.close().await;
    fixture.finish().await;
}

async fn desktop_folds_work_when_responses_starts_the_final_answer() {
    let mut fixture = Fixture::configured(Options {
        responses: true,
        ..Options::default()
    })
    .await;
    let desktop = Desktop::open(&fixture, &fixture.address).await;
    desktop.new_draft().await;
    desktop.type_text("Check the log").await;
    desktop.submit().await;
    let mut reply = desktop.request(&mut fixture).await;
    reply
        .packet(json!({"type":"response.output_item.done","item":{
            "type":"reasoning","id":"reasoning-1",
            "summary":[{"type":"summary_text","text":"Checking the log"}]
        }}))
        .await;
    let thought = "Thinking · Checking the log";
    desktop.control(thought).await;
    let message = |id, phase, content| json!({"type":"message","role":"assistant","id":id,"phase":phase,"content":content});
    let added = |id, phase| json!({"type":"response.output_item.added","item":message(id, phase, json!([]))});
    let delta = |id, text| json!({"type":"response.output_text.delta","item_id":id,"delta":text});
    let done = |id, phase, text| {
        json!({"type":"response.output_item.done","item":
            message(id, phase, json!([{"type":"output_text","text":text}]))})
    };
    reply.packet(added("progress", "commentary")).await;
    reply.packet(delta("progress", "I found the log.")).await;
    reply
        .packet(done("progress", "commentary", "I found the log."))
        .await;
    reply.packet(added("answer", "final_answer")).await;
    reply.packet(delta("answer", "The log is clean.")).await;
    desktop
        .until(
            "the final answer did not fold the work while streaming",
            || {
                (desktop.controls(thought).is_empty()
                    && !desktop.controls("Stop response").is_empty())
                .then_some(())
            },
        )
        .await;
    desktop.artifact("streaming-final-answer-folded-work");
    assert!(desktop.controls("Return to latest").is_empty());

    reply
        .packet(done("answer", "final_answer", "The log is clean."))
        .await;
    reply
        .packet(json!({"type":"response.completed","response":{
            "id":"response-1","usage":{"input_tokens":10,"output_tokens":20}
        }}))
        .await;
    reply.finish_stream().await;
    desktop.control("Copy message").await;
    assert!(desktop.controls(thought).is_empty());
    desktop.press("Turn work details").await;
    desktop.control(thought).await;
    desktop.close().await;
    fixture.finish().await;
}

async fn desktop_side_pane_keeps_its_draft_separate_when_closed_and_reopened() {
    let fixture = Fixture::open().await;
    let desktop = Desktop::open_at(
        &fixture,
        &fixture.address,
        size(
            nsh_terminal::DevicePixels(1440),
            nsh_terminal::DevicePixels(800),
        ),
        nsh_core::platform::Appearance::Dark,
    )
    .await;
    desktop.type_text("MAIN_DRAFT").await;
    let roots = desktop
        .client
        .query("agent", "directories", json!({"kind":"roots"}))
        .await
        .unwrap();
    super::support::mutate(
        &desktop.client,
        "create",
        json!({
            "title":"Side conversation","labels":[],
            "workspace":{"kind":"directory","path":roots["roots"][0]["path"]}
        }),
    )
    .await;
    let original = desktop.platform.text_input_target();
    desktop.press("Actions for Side conversation").await;
    desktop.press("Open to the side").await;
    desktop.target_after(original).await;
    desktop.type_text("SIDE_DRAFT").await;
    desktop.press("Close side pane").await;
    desktop.press("Focus message composer").await;
    desktop.expect_text("MAIN_DRAFT").await;
    assert_eq!(desktop.controls("Focus message composer").len(), 1);

    let original = desktop.platform.text_input_target();
    desktop.press("Actions for Side conversation").await;
    desktop.press("Open to the side").await;
    desktop.target_after(original).await;
    desktop
        .until("both restored drafts did not become sendable", || {
            (desktop.controls("Send message").len() == 2).then_some(())
        })
        .await;
    desktop.expect_text("SIDE_DRAFT").await;
    assert_eq!(desktop.controls("Focus message composer").len(), 2);
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

    desktop.type_text("Summarize the changes afterwards.").await;
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
                    row["preview"] == "Summarize the changes afterwards."
                        && row["kind"] == "followup"
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
        fixture.request_count.load(Ordering::SeqCst),
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
    desktop.control("Choose model").await;
    desktop.artifact(&format!("steering-{theme}-{width_name}-model-scope"));
    desktop
        .retry(
            "the model menu did not close",
            || desktop.controls("Choose model").is_empty(),
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
    desktop.press("Messages").await;
    desktop.control("Retry message").await;
    desktop.press("Focus message composer").await;
    desktop.key("right", false);
    desktop.artifact(&format!("steering-{theme}-{width_name}-stopped"));
    assert_eq!(fixture.request_count.load(Ordering::SeqCst), 3);
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
        desktop
            .until("the replacement range was not selected", || {
                desktop.key("c", true);
                desktop
                    .platform
                    .take_clipboard_write()
                    .filter(|text| text == "待替换")
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
    assert_eq!(fixture.request_count.load(Ordering::SeqCst), 0);
    let (path, _) = image_file(&fixture);
    desktop.attach(&path).await;
    let name = path.file_name().unwrap().to_str().unwrap();
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

async fn desktop_new_draft_falls_back_to_a_file_for_an_undecodable_image() {
    let fixture = images_fixture().await;
    let path = fixture.directory.path().join("corrupt.png");
    std::fs::write(&path, b"\x89PNG\r\n\x1a\nnot an image").unwrap();
    let desktop = Desktop::open(&fixture, &fixture.address).await;
    desktop.new_draft().await;
    desktop.attach(&path).await;
    let start = desktop.control("Add to message").await.left();
    let label = "Remove attachment corrupt.png";
    desktop
        .until("the undecodable image stayed a thumbnail", || {
            let found = desktop.controls(label);
            // The file tile keeps its remove button past the thumbnail's 64 points.
            (found.len() == 1 && found[0].left() - start > px(64.)).then_some(())
        })
        .await;
    desktop.press(label).await;
    desktop
        .until("the undecodable image was not removed", || {
            desktop.controls(label).is_empty().then_some(())
        })
        .await;
    desktop.close().await;
    fixture.finish().await;
}

/// The window's shell lines its parts up (DESIGN.md "Alignment"): the panel's
/// one header row is centered on the window controls' line with the sidebar's
/// toggle, and the sidebar's icons, workspace names and conversation titles
/// start at one left edge.
async fn shell_shares_its_lines(desktop: &Desktop, docked: bool) {
    // The panel's 8-point top inset plus half its 32-point header: the middle
    // of the 48-point title bar the window controls are centered in.
    let center = px(24.0);
    let toggle = if docked {
        if !desktop.controls("Expand session browser").is_empty() {
            desktop.press("Expand session browser").await;
        }
        desktop.control("Collapse session browser").await
    } else {
        desktop.control("Expand session browser").await
    };
    for (name, bounds) in [
        ("sidebar toggle", toggle),
        ("Chat view", desktop.control("Chat").await),
        ("Trajectory view", desktop.control("Trajectory").await),
        ("workspace", desktop.control("Browse workspace files").await),
    ] {
        assert_eq!(
            bounds.center().y,
            center,
            "the {name} must sit on the window controls' center line: {bounds:?}"
        );
    }
    if docked {
        let new = desktop.control("New conversation").await;
        let group = desktop.control("Collapse workspace").await;
        let row = desktop.control("Open conversation NSH real Agent").await;
        assert_eq!(
            (group.left(), row.left()),
            (new.left(), new.left()),
            "sidebar rows must share one left edge: new={new:?}, group={group:?}, row={row:?}"
        );
    }
}

async fn disconnected_desktop(
    theme: &str,
    appearance: nsh_core::platform::Appearance,
    layout: &str,
    width: i32,
    height: i32,
) {
    let mut fixture = Fixture::open().await;
    let dimensions = size(
        nsh_terminal::DevicePixels(width),
        nsh_terminal::DevicePixels(height),
    );
    let desktop = Desktop::open_at(&fixture, &fixture.address, dimensions, appearance).await;
    desktop.new_draft().await;
    desktop.type_text("Start a response").await;
    desktop.submit().await;
    let mut reply = desktop.request(&mut fixture).await;
    desktop.control("Stop response").await;
    shell_shares_its_lines(&desktop, layout == "wide").await;
    let closing = tokio::spawn({
        let store = fixture.store.clone();
        async move { store.drain().await }
    });
    reply.delta("Wake the original source watcher.").await;
    desktop.control("Details").await;
    desktop.control("Retry").await;
    assert!(desktop.controls("Stop response").is_empty());
    desktop.type_text("DRAFT_KEPT_WHILE_DISCONNECTED").await;
    desktop.expect_text("DRAFT_KEPT_WHILE_DISCONNECTED").await;
    let retry = desktop.control("Retry").await;
    let composer = desktop.control("Focus message composer").await;
    {
        let guard = desktop.frame.lock().unwrap();
        let frame = guard.as_ref().unwrap();
        assert_eq!(frame.size(), dimensions);
        if let Some(directory) = std::env::var_os("MAKA_UI_ARTIFACT_DIR") {
            let directory = std::path::PathBuf::from(directory);
            std::fs::create_dir_all(&directory).unwrap();
            let mut ppm = format!("P6\n{} {}\n255\n", width, height).into_bytes();
            for pixel in frame.pixels().as_chunks::<4>().0 {
                ppm.extend_from_slice(&pixel[..3]);
            }
            std::fs::write(
                directory.join(format!("disconnected-{theme}-{layout}.ppm")),
                ppm,
            )
            .unwrap();
        }
        let pixel = ((height as usize / 3) * width as usize + width as usize - 2) * 4;
        assert_eq!(
            frame.pixels()[pixel] > 128,
            theme == "light",
            "the requested theme must actually be rendered"
        );
    }
    assert!(
        retry.top() >= composer.bottom(),
        "connection feedback overlaps the workspace: retry={retry:?}, composer={composer:?}"
    );
    assert!(
        retry.right() <= px(width as f32) && retry.bottom() <= px(height as f32),
        "connection actions must stay within the window: {retry:?}"
    );
    assert!(
        retry.bottom() > px(height as f32 - 64.0),
        "connection status must use the bottom of the actual viewport: {retry:?}"
    );
    assert_eq!(
        desktop.controls("Retry").len(),
        1,
        "one connection failure needs one retry action"
    );
    assert!(desktop.controls("Stop response").is_empty());
    reply.finish().await;
    desktop
        .wait("the closed store did not drain", closing)
        .await
        .unwrap();
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

// GPUI owns process-wide application state; visual cases run in separate processes.
async fn desktop_connection_failure_has_one_status_below_the_workspace() {
    let (theme, appearance, layout, width, height) = visual_case();
    disconnected_desktop(theme, appearance, layout, width, height).await;
}

async fn desktop_model_settings_keeps_successful_sign_in_and_retries_models() {
    let fixture = Fixture::open().await;
    let entry = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../terminal-shell/tests/real_host/model_settings_preview.tsx");
    let output = fixture.directory.path().join("settings-preview");
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
    let (theme, appearance, layout, width, height) = visual_case();
    let desktop = Desktop::open_config(
        &fixture,
        &fixture.address,
        size(
            nsh_terminal::DevicePixels(width),
            nsh_terminal::DevicePixels(height),
        ),
        appearance,
        Some((source, "en", "Close settings")),
    )
    .await;
    desktop.press("Edit connection ChatGPT Subscription").await;
    desktop.control("Sign in with ChatGPT").await;
    desktop.artifact(&format!("connection-before-login-{theme}-{layout}"));
    desktop.press("Sign in with ChatGPT").await;
    desktop.control("Copy sign-in code").await;
    desktop.artifact(&format!("connection-signing-in-{theme}-{layout}"));
    desktop.press("Copy sign-in code").await;
    let copied = desktop
        .until("the sign-in code was not copied", || {
            desktop.platform.take_clipboard_write()
        })
        .await;
    assert_eq!(copied, "ABCD-EFGH");
    desktop.event("fixture.finishLogin", json!({"result":"saved"}));
    desktop.control("Sign in again").await;
    desktop.control("Fetch models").await;
    assert_eq!(
        desktop.outcome.lock().unwrap()["configured"],
        true,
        "model discovery failure must not undo a completed sign-in"
    );
    desktop.artifact(&format!("connection-model-retry-{theme}-{layout}"));
    desktop.press("Fetch models").await;
    desktop.control("Edit model gpt-4.1").await;
    {
        let outcome = desktop.outcome.lock().unwrap();
        assert_eq!(
            outcome["signIns"], 1,
            "retrying discovery must not repeat provider sign-in"
        );
        assert_eq!(outcome["discoveries"], 2);
    }
    desktop.artifact(&format!("connection-ready-{theme}-{layout}"));
    desktop.press("Edit model gpt-4.1").await;
    desktop.press("Default for new conversations: Off").await;
    desktop
        .until("the selected default was not saved", || {
            (desktop.outcome.lock().unwrap()["defaultTarget"]["modelId"] == "gpt-4.1").then_some(())
        })
        .await;
    desktop.control("Default for new conversations: On").await;
    desktop.control("Associate catalog model").await;
    desktop.artifact(&format!("connection-model-editor-{theme}-{layout}"));
    desktop.press("Associate catalog model").await;
    desktop.control("openai / gpt-4.1").await;
    desktop.artifact(&format!("connection-model-catalog-{theme}-{layout}"));
    desktop.press("openai / gpt-4.1").await;
    desktop.control("Save model").await;
    desktop.press("Back").await;
    desktop.control("Keep editing").await;
    desktop.artifact(&format!("connection-unsaved-model-{theme}-{layout}"));
    desktop.press("Keep editing").await;
    desktop.press("Save model").await;
    desktop.control("Edit model gpt-4.1").await;
    assert_eq!(
        desktop.outcome.lock().unwrap()["overrides"]["gpt-4.1"]["catalogModel"]["modelId"],
        "gpt-4.1"
    );
    desktop.close().await;
    fixture.finish().await;
}

async fn desktop_provider_picker_searches_real_catalog_and_preserves_selection() {
    let fixture = Fixture::open().await;
    let entry = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../terminal-shell/tests/real_host/model_settings_preview.tsx");
    let output = fixture.directory.path().join("settings-preview");
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
    let (theme, appearance, layout, width, height) = visual_case();
    let desktop = Desktop::open_config(
        &fixture,
        &fixture.address,
        size(
            nsh_terminal::DevicePixels(width),
            nsh_terminal::DevicePixels(height),
        ),
        appearance,
        Some((source, "en", "Close settings")),
    )
    .await;
    desktop.press("Add connection").await;
    desktop.target_after(None).await;
    desktop.control("Connect ChatGPT Subscription").await;
    desktop.artifact(&format!("provider-picker-{theme}-{layout}"));
    desktop.type_text("alibaba china").await;
    desktop
        .until("search retained unrelated providers", || {
            desktop
                .controls("Connect ChatGPT Subscription")
                .is_empty()
                .then_some(())
        })
        .await;
    let first = desktop.control("Connect Alibaba (China)").await;
    let second = desktop.control("Connect Alibaba Coding Plan (China)").await;
    assert_eq!(first.left(), second.left());
    assert_eq!(first.right(), second.right());
    assert_eq!(first.size.height, px(40.));
    assert_eq!(second.top() - first.top(), px(40.));
    desktop.artifact(&format!("provider-search-{theme}-{layout}"));
    desktop.key("down", false);
    desktop.key("enter", false);
    desktop.control("Save connection").await;
    assert_eq!(
        desktop.outcome.lock().unwrap()["selectedProviders"]
            .as_array()
            .unwrap()
            .last()
            .unwrap(),
        "alibaba-coding-plan-cn"
    );
    desktop.press("Back").await;
    desktop.control("Clear provider search").await;
    desktop.expect_text("alibaba china").await;
    desktop.artifact(&format!("provider-back-{theme}-{layout}"));
    desktop.type_text("no-such-provider-1793500567423").await;
    desktop.key("enter", false);
    desktop.control("Clear provider search").await;
    desktop
        .until("search retained a provider it does not match", || {
            desktop
                .controls("Connect Alibaba (China)")
                .is_empty()
                .then_some(())
        })
        .await;
    desktop.artifact(&format!("provider-empty-{theme}-{layout}"));
    desktop.key("escape", false);
    desktop.control("Connect ChatGPT Subscription").await;
    assert!(desktop.controls("Clear provider search").is_empty());
    desktop.key("escape", false);
    desktop.control("Add connection").await;
    desktop.event("fixture.failProviders", Value::Null);
    desktop.press("Add connection").await;
    desktop.control("Retry loading providers").await;
    desktop.artifact(&format!("provider-error-{theme}-{layout}"));
    desktop.press("Retry loading providers").await;
    desktop.control("Connect ChatGPT Subscription").await;
    desktop.type_text("responses").await;
    desktop.control("Connect Responses").await;
    desktop.artifact(&format!("provider-custom-{theme}-{layout}"));
    desktop.event("fixture.failProvider", Value::Null);
    desktop.key("enter", false);
    desktop.control("Retry opening provider").await;
    desktop.artifact(&format!("provider-opening-error-{theme}-{layout}"));
    desktop.press("Retry opening provider").await;
    desktop.control("Save connection").await;
    assert_eq!(
        desktop.outcome.lock().unwrap()["selectedProviders"]
            .as_array()
            .unwrap()
            .last()
            .unwrap(),
        "openai-responses-compatible"
    );
    desktop.press("Back").await;
    desktop.target_after(None).await;
    desktop.type_text("chatgpt").await;
    desktop.event("fixture.holdProvider", Value::Null);
    desktop.key("enter", false);
    desktop
        .until("provider read did not start", || {
            (desktop.outcome.lock().unwrap()["selectedProviders"]
                .as_array()
                .unwrap()
                .last()
                .unwrap()
                == "chatgpt")
                .then_some(())
        })
        .await;
    desktop
        .until("the opening provider remained actionable", || {
            desktop
                .controls("Connect ChatGPT Subscription")
                .is_empty()
                .then_some(())
        })
        .await;
    desktop.artifact(&format!("provider-opening-{theme}-{layout}"));
    desktop.press("Back").await;
    desktop.event("fixture.releaseProvider", Value::Null);
    desktop.control("Add connection").await;
    desktop.close().await;
    fixture.finish().await;
}

async fn desktop_mermaid_renders_markdown_and_toggles_its_source() {
    let fixture = Fixture::open().await;
    let (theme, appearance, layout, width, height) = visual_case();
    let entry = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../terminal-shell/tests/real_host/mermaid_preview.tsx");
    let output = fixture.directory.path().join("mermaid-preview");
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
            nsh_terminal::DevicePixels(width),
            nsh_terminal::DevicePixels(height),
        ),
        appearance,
        Some((source, "en", "Show diagram source")),
    )
    .await;
    desktop
        .until(
            "the diagram's image never reached the desktop frame",
            || {
                let guard = desktop.frame.lock().unwrap();
                let frame = guard.as_ref()?;
                let filled = frame
                    .pixels()
                    .as_chunks::<4>()
                    .0
                    .iter()
                    .filter(|pixel| pixel[..3] == [0x1d, 0x74, 0x5a])
                    .count();
                (filled > 500).then_some(())
            },
        )
        .await;
    desktop.artifact(&format!("mermaid-workbench-{theme}-{layout}"));
    desktop.press("Show diagram source").await;
    desktop.control("Hide diagram source").await;
    desktop.press("Copy code block").await;
    let copied = desktop
        .until("the diagram source was not copied", || {
            desktop.platform.take_clipboard_write()
        })
        .await;
    assert_eq!(
        copied,
        "flowchart LR\n  A[源码] --> B[图表]\n  style B fill:#1d745a,stroke:#24c483,color:#ffffff"
    );
    desktop.artifact(&format!("mermaid-workbench-source-{theme}-{layout}"));
    desktop.press("Hide diagram source").await;
    desktop.control("Show diagram source").await;
    assert!(desktop.controls("Copy code block").is_empty());
    desktop.close().await;
    fixture.finish().await;
}

async fn desktop_goal_commands_create_pause_resume_and_finish_without_losing_the_draft() {
    let mut fixture = Fixture::open().await;
    let (theme, appearance, layout, width, height) = visual_case();
    let desktop = Desktop::open_at(
        &fixture,
        &fixture.address,
        size(
            nsh_terminal::DevicePixels(width),
            nsh_terminal::DevicePixels(height),
        ),
        appearance,
    )
    .await;
    let active_goal = "Goal progress: Working";
    let finished_goal = "Goal progress: Achieved";
    desktop.new_draft().await;
    desktop.type_text("KEEP_MY_DRAFT").await;
    let previous = desktop.platform.text_input_target();
    // A new draft can still move its composer, which closes the menu.
    desktop
        .retry(
            "the Goal dialog did not open",
            || !desktop.controls("Cancel editing").is_empty(),
            || {
                let goal = desktop.controls("Goal");
                let add = desktop.controls("Add to message");
                if let [control] = if goal.is_empty() { &add[..] } else { &goal[..] } {
                    desktop.press_at(control.center());
                }
            },
        )
        .await;
    desktop.target_after(previous).await;
    desktop.artifact("goal-before-objective");
    desktop
        .platform
        .set_clipboard_text("Read the project\nFix the actual problem and verify it");
    desktop.key("v", true);
    desktop.artifact("goal-objective-entered");
    let start = desktop.control("Start Goal").await;
    assert!(start.right() <= px(width as f32) && start.bottom() <= px(height as f32));
    desktop.artifact(&format!("goal-create-{theme}-{layout}"));
    desktop.press("Start Goal").await;
    desktop.control(active_goal).await;
    let first = desktop.request(&mut fixture).await;
    assert!(
        first.body["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(
                |message| message["content"].as_str().is_some_and(|content| content
                    .contains("Read the project\nFix the actual problem and verify it"))
            )
    );
    first
        .tool_call("tool_search", json!({"query":"todo_write"}))
        .await;
    let first = desktop.request(&mut fixture).await;
    first
        .tool_call(
            "todo_write",
            json!({"todos":[{"content":"Verify the Goal and Todo tabs", "status":"in_progress"}]}),
        )
        .await;
    let first = desktop.request(&mut fixture).await;
    desktop.control("Toggle conversation todo").await;
    desktop.press(active_goal).await;
    desktop.control("Pause Goal").await;
    desktop.press("Toggle conversation todo").await;
    desktop
        .until("Goal controls remained visible in the Todo tab", || {
            desktop.controls("Pause Goal").is_empty().then_some(())
        })
        .await;
    desktop.artifact(&format!("goal-todo-tabs-{theme}-{layout}"));
    desktop.press(active_goal).await;
    desktop.control("Pause Goal").await;
    desktop.artifact(&format!("goal-running-{theme}-{layout}"));
    desktop.press("Change budget").await;
    desktop.target_after(None).await;
    desktop.type_text("250000").await;
    desktop.press("Toggle conversation todo").await;
    desktop.press(active_goal).await;
    desktop.target_after(None).await;
    desktop.expect_text("250000").await;
    desktop.artifact(&format!("goal-budget-editor-{theme}-{layout}"));
    desktop.key("escape", false);
    desktop.press("Pause Goal").await;
    // A paused Goal can still be cancelling its iteration.
    desktop.control("Complete Goal").await;
    desktop.press("Resume Goal").await;
    desktop.control("Pause Goal").await;
    let running = desktop.request(&mut fixture).await;
    desktop.press("Change budget").await;
    desktop.control("Cancel editing").await;
    assert!(
        running.body["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|tool| tool["function"]["name"] == "GoalStatus"),
        "{}",
        running.body
    );
    running
        .tool_call(
            "GoalStatus",
            json!({"status":"achieved", "note":"Verified the requested result"}),
        )
        .await;
    let finished = desktop.request(&mut fixture).await;
    let result: Value = serde_json::from_str(
        finished.body["messages"]
            .as_array()
            .unwrap()
            .last()
            .unwrap()["content"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(result["current"]["status"], "achieved", "{result}");
    finished.finish().await;
    desktop
        .until("a finished Goal still offers budget updates", || {
            desktop.controls("Apply budget").is_empty().then_some(())
        })
        .await;
    desktop.press("Cancel editing").await;
    desktop.control("New Goal").await;
    desktop.artifact(&format!("goal-completed-{theme}-{layout}"));
    desktop.press("New Goal").await;
    desktop.target_after(None).await;
    desktop
        .type_text("Keep this unfinished Goal objective")
        .await;
    desktop.press("Toggle conversation todo").await;
    desktop.press(finished_goal).await;
    desktop.target_after(None).await;
    desktop
        .expect_text("Keep this unfinished Goal objective")
        .await;
    desktop.artifact(&format!("goal-draft-preserved-{theme}-{layout}"));
    desktop.press("Cancel editing").await;
    desktop.press("New Goal").await;
    desktop.target_after(None).await;
    desktop
        .type_text("Unsubmitted draft for the previous Goal")
        .await;
    desktop.press(finished_goal).await;
    desktop.press("Focus message composer").await;
    desktop.expect_text("KEEP_MY_DRAFT").await;
    desktop.type_text("/goal Finish the follow-up").await;
    desktop.submit().await;
    let next = desktop.request(&mut fixture).await;
    assert!(next.body.to_string().contains("Finish the follow-up"));
    desktop.press(active_goal).await;
    desktop.control("Pause Goal").await;
    desktop.press(active_goal).await;
    next.tool_call(
        "GoalStatus",
        json!({"status":"achieved", "note":"Follow-up verified"}),
    )
    .await;
    let finished = desktop.request(&mut fixture).await;
    let result: Value = serde_json::from_str(
        finished.body["messages"]
            .as_array()
            .unwrap()
            .last()
            .unwrap()["content"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(result["current"]["status"], "achieved", "{result}");
    finished.finish().await;
    desktop.press("Focus message composer").await;
    desktop.type_text("/goal").await;
    // "/goal" opens a completion menu, and an Enter on the binding of a menu
    // that just closed is lost.
    desktop
        .retry(
            "/goal did not open the Goal dialog",
            || !desktop.controls("New Goal").is_empty(),
            || desktop.key("enter", false),
        )
        .await;
    let previous = desktop.platform.text_input_target();
    desktop.press("New Goal").await;
    desktop.target_after(previous).await;
    desktop.type_text("Cancel this unsubmitted Goal").await;
    desktop.control("Start Goal").await;
    desktop.key("escape", false);
    desktop
        .until("the Goal dialog did not close", || {
            desktop.controls("Start Goal").is_empty().then_some(())
        })
        .await;
    drop(first);
    desktop.close().await;
    fixture.finish().await;
}

async fn desktop_todo_strip_keeps_its_row_in_place_and_closes_until_the_list_changes() {
    let mut fixture = Fixture::open().await;
    let (theme, appearance, layout, width, height) = visual_case();
    let desktop = Desktop::open_at(
        &fixture,
        &fixture.address,
        size(
            nsh_terminal::DevicePixels(width),
            nsh_terminal::DevicePixels(height),
        ),
        appearance,
    )
    .await;
    let toggle = "Toggle conversation todo";
    let release = |statuses: [&str; 4]| {
        let items = [
            "Read the release notes",
            "Update the changelog",
            "Build the release candidate",
            "Tag the release",
        ];
        json!({"todos": items.iter().zip(statuses).map(|(content, status)| {
            json!({"content": content, "status": status})
        }).collect::<Vec<_>>()})
    };
    desktop.new_draft().await;
    desktop.type_text("Prepare the release").await;
    desktop.submit().await;
    desktop
        .request(&mut fixture)
        .await
        .tool_call("tool_search", json!({"query":"todo_write"}))
        .await;
    desktop
        .request(&mut fixture)
        .await
        .tool_call(
            "todo_write",
            release(["completed", "completed", "in_progress", "pending"]),
        )
        .await;
    let running = desktop.request(&mut fixture).await;
    let row = desktop.control(toggle).await;
    desktop.artifact(&format!("todo-strip-collapsed-{theme}-{layout}"));

    // The list opens above the row, so the row can be pressed again where it was.
    // One point lies in the strip's padding beside the row, the other above the row:
    // the strip's surface reaches it only once the list is open.
    let sample = |at: nsh_terminal::Point<nsh_terminal::Pixels>| {
        desktop.pump();
        desktop.pixels(Bounds::new(at, size(px(1.), px(1.))))
    };
    let beside = point(row.left() - px(2.), row.center().y);
    let above = point(row.left() - px(2.), row.top() - px(20.));
    let surface = sample(beside).unwrap();
    assert_ne!(
        sample(above).unwrap(),
        surface,
        "the closed strip reached above its row"
    );
    desktop.press(toggle).await;
    desktop
        .until("the todo list did not open above its row", || {
            (sample(above)? == surface).then_some(())
        })
        .await;
    desktop.artifact(&format!("todo-strip-expanded-{theme}-{layout}"));
    assert_eq!(desktop.control(toggle).await, row);
    desktop.press(toggle).await;
    desktop
        .until("the todo list did not close above its row", || {
            (sample(above)? != surface).then_some(())
        })
        .await;

    desktop.press("Hide todo").await;
    desktop
        .until("the closed todo strip remained", || {
            desktop.controls(toggle).is_empty().then_some(())
        })
        .await;
    desktop.control("Toggle tool Update checklist").await;
    // Progress on the same list leaves it closed, fenced on the rendered tool disclosure.
    running
        .tool_call(
            "todo_write",
            release(["completed", "completed", "completed", "in_progress"]),
        )
        .await;
    let running = desktop.request(&mut fixture).await;
    desktop
        .until(
            "the progress todo_write did not render in the transcript",
            || (desktop.controls("Toggle tool Update checklist").len() == 2).then_some(()),
        )
        .await;
    assert!(
        desktop.controls(toggle).is_empty(),
        "a progress update reopened the closed todo"
    );
    // A >20-item checklist opens above the row, hides cleanly, and re-shows when an item past page 1 changes.
    let long_list = |step_25: &str, all_done: bool| {
        json!({"todos": (1..=25).map(|index| {
            let content = if index == 25 {
                step_25.to_owned()
            } else {
                format!("Release step {index}")
            };
            let status = if all_done || index < 23 {
                "completed"
            } else if index == 23 {
                "in_progress"
            } else {
                "pending"
            };
            json!({"content": content, "status": status})
        }).collect::<Vec<_>>()})
    };
    running
        .tool_call("todo_write", long_list("Verify checksums", false))
        .await;
    let running = desktop.request(&mut fixture).await;
    desktop.press(toggle).await;
    desktop
        .until(
            "the multi-page todo list did not open above its row",
            || (sample(above)? == surface).then_some(()),
        )
        .await;
    desktop.press("Hide todo").await;
    desktop
        .until("the hidden multi-page todo strip remained", || {
            desktop.controls(toggle).is_empty().then_some(())
        })
        .await;
    running
        .tool_call("todo_write", long_list("Publish signed checksums", true))
        .await;
    let running = desktop.request(&mut fixture).await;
    desktop.control(toggle).await;
    desktop.artifact(&format!("todo-strip-complete-{theme}-{layout}"));
    desktop.press("Hide todo").await;
    desktop
        .until("the completed todo strip remained", || {
            desktop.controls(toggle).is_empty().then_some(())
        })
        .await;
    // Writing the earlier 4-item list again is fresh work (ABA) and must show again.
    running
        .tool_call(
            "todo_write",
            release(["in_progress", "pending", "pending", "pending"]),
        )
        .await;
    let answer = desktop.request(&mut fixture).await;
    desktop.control(toggle).await;
    answer.finish().await;
    desktop.close().await;
    fixture.finish().await;
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

async fn desktop_composer_sandbox_choice_becomes_the_default() {
    let fixture = Fixture::open().await;
    let desktop = Desktop::open(&fixture, &fixture.address).await;
    desktop.new_draft().await;
    desktop.press("Sandbox and approvals").await;
    desktop.press("Full access · Sandbox off").await;
    desktop
        .wait(
            "the composer's sandbox choice did not become the Host default",
            async {
                loop {
                    let preferences = desktop
                        .client
                        .query("settings", "assistantPreferences", json!({}))
                        .await
                        .unwrap();
                    if preferences["defaultSandboxMode"] == "danger-full-access" {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            },
        )
        .await;
    desktop.close().await;
    fixture.finish().await;
}

/// Native cases run on the process main thread, required by AppKit.
pub(crate) const CASES: &[&str] = &[
    "desktop_remembers_folders_without_restoring_unsent_drafts",
    "desktop_new_conversation_preserves_an_owned_worktree",
    "desktop_recovers_an_unavailable_remembered_folder",
    "desktop_new_draft_completes_commands_skills_and_files_without_creating_a_session",
    "desktop_creates_only_on_first_submission_and_preserves_the_confirmed_snapshot",
    "desktop_continues_a_failed_run_without_duplicating_the_user_message",
    "desktop_message_actions_show_on_hover_or_focus_and_in_a_context_menu",
    "desktop_edits_a_message_in_place_and_forks_only_when_sent",
    "desktop_lists_a_scripts_tool_calls_in_place_of_the_script",
    "desktop_presents_session_tools_in_chat_and_trajectory",
    "desktop_previews_an_incoming_session_message",
    "desktop_folds_work_when_responses_starts_the_final_answer",
    "desktop_side_pane_keeps_its_draft_separate_when_closed_and_reopened",
    "desktop_steering_freezes_each_message_and_queue_is_one_shot",
    "desktop_file_gestures_preserve_drafts_and_stage_an_image",
    "desktop_new_draft_falls_back_to_a_file_for_an_undecodable_image",
    "desktop_connection_failure_has_one_status_below_the_workspace",
    "desktop_model_settings_keeps_successful_sign_in_and_retries_models",
    "desktop_provider_picker_searches_real_catalog_and_preserves_selection",
    "desktop_mermaid_renders_markdown_and_toggles_its_source",
    "desktop_goal_commands_create_pause_resume_and_finish_without_losing_the_draft",
    "desktop_todo_strip_keeps_its_row_in_place_and_closes_until_the_list_changes",
    "desktop_composer_large_paste_keeps_controls_on_screen",
    "desktop_system_permission_guidance_uses_native_actions_without_paths",
    "desktop_composer_sandbox_choice_becomes_the_default",
];

pub(crate) fn run(name: &str) {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(4)
        .enable_all()
        .build()
        .unwrap();
    match name {
        "desktop_remembers_folders_without_restoring_unsent_drafts" => {
            runtime.block_on(desktop_remembers_folders_without_restoring_unsent_drafts())
        }
        "desktop_new_conversation_preserves_an_owned_worktree" => {
            runtime.block_on(desktop_new_conversation_preserves_an_owned_worktree())
        }
        "desktop_recovers_an_unavailable_remembered_folder" => {
            runtime.block_on(desktop_recovers_an_unavailable_remembered_folder())
        }
        "desktop_new_draft_completes_commands_skills_and_files_without_creating_a_session" => {
            runtime.block_on(
                desktop_new_draft_completes_commands_skills_and_files_without_creating_a_session(),
            )
        }
        "desktop_creates_only_on_first_submission_and_preserves_the_confirmed_snapshot" => runtime
            .block_on(
                desktop_creates_only_on_first_submission_and_preserves_the_confirmed_snapshot(),
            ),
        "desktop_continues_a_failed_run_without_duplicating_the_user_message" => {
            runtime.block_on(desktop_continues_a_failed_run_without_duplicating_the_user_message())
        }
        "desktop_message_actions_show_on_hover_or_focus_and_in_a_context_menu" => {
            runtime.block_on(desktop_message_actions_show_on_hover_or_focus_and_in_a_context_menu())
        }
        "desktop_edits_a_message_in_place_and_forks_only_when_sent" => {
            runtime.block_on(desktop_edits_a_message_in_place_and_forks_only_when_sent())
        }
        "desktop_lists_a_scripts_tool_calls_in_place_of_the_script" => {
            runtime.block_on(desktop_lists_a_scripts_tool_calls_in_place_of_the_script())
        }
        "desktop_presents_session_tools_in_chat_and_trajectory" => {
            runtime.block_on(desktop_presents_session_tools_in_chat_and_trajectory())
        }
        "desktop_previews_an_incoming_session_message" => {
            runtime.block_on(desktop_previews_an_incoming_session_message())
        }
        "desktop_folds_work_when_responses_starts_the_final_answer" => {
            runtime.block_on(desktop_folds_work_when_responses_starts_the_final_answer())
        }
        "desktop_side_pane_keeps_its_draft_separate_when_closed_and_reopened" => {
            runtime.block_on(desktop_side_pane_keeps_its_draft_separate_when_closed_and_reopened())
        }
        "desktop_steering_freezes_each_message_and_queue_is_one_shot" => {
            runtime.block_on(desktop_steering_freezes_each_message_and_queue_is_one_shot())
        }
        "desktop_file_gestures_preserve_drafts_and_stage_an_image" => {
            runtime.block_on(desktop_file_gestures_preserve_drafts_and_stage_an_image())
        }
        "desktop_new_draft_falls_back_to_a_file_for_an_undecodable_image" => {
            runtime.block_on(desktop_new_draft_falls_back_to_a_file_for_an_undecodable_image())
        }
        "desktop_connection_failure_has_one_status_below_the_workspace" => {
            runtime.block_on(desktop_connection_failure_has_one_status_below_the_workspace())
        }
        "desktop_model_settings_keeps_successful_sign_in_and_retries_models" => {
            runtime.block_on(desktop_model_settings_keeps_successful_sign_in_and_retries_models())
        }
        "desktop_provider_picker_searches_real_catalog_and_preserves_selection" => runtime
            .block_on(desktop_provider_picker_searches_real_catalog_and_preserves_selection()),
        "desktop_mermaid_renders_markdown_and_toggles_its_source" => {
            runtime.block_on(desktop_mermaid_renders_markdown_and_toggles_its_source())
        }
        "desktop_goal_commands_create_pause_resume_and_finish_without_losing_the_draft" => runtime
            .block_on(
                desktop_goal_commands_create_pause_resume_and_finish_without_losing_the_draft(),
            ),
        "desktop_todo_strip_keeps_its_row_in_place_and_closes_until_the_list_changes" => runtime
            .block_on(
                desktop_todo_strip_keeps_its_row_in_place_and_closes_until_the_list_changes(),
            ),
        "desktop_composer_large_paste_keeps_controls_on_screen" => {
            runtime.block_on(desktop_composer_large_paste_keeps_controls_on_screen())
        }
        "desktop_system_permission_guidance_uses_native_actions_without_paths" => {
            runtime.block_on(desktop_system_permission_guidance_uses_native_actions_without_paths())
        }
        "desktop_composer_sandbox_choice_becomes_the_default" => {
            runtime.block_on(desktop_composer_sandbox_choice_becomes_the_default())
        }
        _ => panic!("unknown native test: {name}"),
    }
}
