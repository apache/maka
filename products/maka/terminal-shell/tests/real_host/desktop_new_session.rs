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
use gpui::{
    AppContext, Application, ApplicationHandle, Bounds, EntityInputHandler, ExternalPaths,
    FileDropEvent, Focusable, Keystroke, Modifiers, MouseButton, MouseDownEvent, MouseMoveEvent,
    MouseUpEvent, PlatformInput, TextInputTarget, WindowBounds, WindowHandle, WindowOptions, point,
    px, size,
};
use maka_app_client::Client;
use maka_workbench::bindings::Bindings;
use nsh_gpui_terminal::{CandidateFrame, TerminalPlatform};
use nsh_platform_gpui::{AppOptions, AppView};
use serde_json::{Value, json};
use sqlx::Connection;
use std::{
    cell::RefCell,
    future::Future,
    path::Path,
    rc::Rc,
    sync::{Arc, Mutex, atomic::Ordering},
    time::Duration,
};
use tokio::sync::{Notify, watch};
use uuid::Uuid;

const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMQNE5uAAACKAEoAfdvjgAAAABJRU5ErkJggg==";

struct Desktop {
    platform: Rc<TerminalPlatform>,
    frame: Arc<Mutex<Option<CandidateFrame>>>,
    app: ApplicationHandle,
    window: WindowHandle<AppView>,
    client: Client,
    bindings: Bindings,
    outcome: Arc<Mutex<Value>>,
    _foreground: watch::Sender<bool>,
    wake: Arc<Notify>,
    errors: Rc<RefCell<Option<String>>>,
}

impl Desktop {
    async fn open(fixture: &Fixture, address: &Path) -> Self {
        Self::open_at(
            fixture,
            address,
            size(gpui::DevicePixels(960), gpui::DevicePixels(640)),
            nsh_core::platform::Appearance::Dark,
        )
        .await
    }

    async fn open_at(
        fixture: &Fixture,
        address: &Path,
        dimensions: gpui::Size<gpui::DevicePixels>,
        appearance: nsh_core::platform::Appearance,
    ) -> Self {
        Self::open_config(fixture, address, dimensions, appearance, None).await
    }

    async fn open_config(
        fixture: &Fixture,
        address: &Path,
        dimensions: gpui::Size<gpui::DevicePixels>,
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
        let platform = TerminalPlatform::new(
            Box::new(gpui_wgpu::WgpuHeadlessRenderer::new().unwrap()),
            Box::new(move |frame| {
                let frame = std::thread::spawn(move || frame.submit()?.complete())
                    .join()
                    .unwrap()
                    .unwrap();
                *captured.lock().unwrap() = Some(frame);
            }),
            Arc::new(move || notification.notify_one()),
        )
        .unwrap();
        platform.set_viewport(dimensions, 1.0).unwrap();
        let errors = Rc::new(RefCell::new(None));
        let failed = errors.clone();
        let opened = Rc::new(RefCell::new(None));
        let window = opened.clone();
        let app = Application::with_platform(platform.clone()).run_embedded(move |cx| {
            *window.borrow_mut() = Some(
                cx.open_window(
                    WindowOptions {
                        window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                            point(px(0.0), px(0.0)),
                            size(
                                px(dimensions.width.0 as f32),
                                px(dimensions.height.0 as f32),
                            ),
                        ))),
                        inactive_frame_interval: None,
                        ..Default::default()
                    },
                    move |window, cx| {
                        cx.new(|cx| {
                            let view = AppView::new(
                                AppOptions {
                                    host: config.host.clone(),
                                    terminal_keyboard: true,
                                    ..Default::default()
                                },
                                window,
                                cx,
                            );
                            view.on_error(move |message| {
                                *failed.borrow_mut() = Some(message.to_owned())
                            });
                            view.set_appearance(appearance, cx);
                            view.load_with_config(config);
                            window.focus(&view.focus_handle(cx), cx);
                            view
                        })
                    },
                )
                .unwrap(),
            );
        });
        let window = opened.borrow_mut().take().unwrap();
        let desktop = Self {
            platform,
            frame,
            app,
            window,
            client,
            bindings,
            outcome,
            _foreground: foreground,
            wake,
            errors,
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
        self.app.update(|cx| {
            self.window
                .update(cx, |view, _, _| view.host().send(name, value).unwrap())
                .unwrap();
        });
    }

    fn artifact(&self, name: &str) {
        let Some(directory) = std::env::var_os("MAKA_UI_ARTIFACT_DIR") else {
            return;
        };
        let directory = std::path::PathBuf::from(directory);
        std::fs::create_dir_all(&directory).unwrap();
        self.app.update(|cx| cx.refresh_windows());
        self.pump();
        let guard = self.frame.lock().unwrap();
        let frame = guard.as_ref().unwrap();
        let size = frame.size();
        let mut ppm = format!("P6\n{} {}\n255\n", size.width.0, size.height.0).into_bytes();
        for pixel in frame.pixels().as_chunks::<4>().0 {
            ppm.extend_from_slice(&pixel[..3]);
        }
        std::fs::write(directory.join(format!("{name}.ppm")), ppm).unwrap();
    }

    fn pixels(&self, bounds: Bounds<gpui::Pixels>) -> Option<Vec<u8>> {
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
        self.platform.pump();
        assert!(
            self.errors.borrow().is_none(),
            "UI error: {:?}",
            self.errors.borrow()
        );
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
        .unwrap_or_else(|_| {
            self.artifact("failure");
            panic!("{stage}; observed: {:?}", self.outcome.lock().unwrap());
        })
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
        .unwrap_or_else(|_| {
            self.artifact("failure");
            panic!("{stage}; observed: {:?}", self.outcome.lock().unwrap());
        })
    }

    fn key(&self, name: &str, control: bool) {
        self.key_with(
            name,
            Modifiers {
                control,
                ..Default::default()
            },
        );
    }

    fn key_with(&self, name: &str, modifiers: Modifiers) {
        let keystroke = Keystroke {
            key: name.into(),
            key_char: None,
            modifiers,
        };
        self.platform
            .dispatch_input(PlatformInput::KeyDown(gpui::KeyDownEvent {
                keystroke: keystroke.clone(),
                is_held: false,
                prefer_character_input: false,
            }))
            .unwrap();
        self.platform
            .dispatch_input(PlatformInput::KeyUp(gpui::KeyUpEvent { keystroke }))
            .unwrap();
    }

    async fn target_after(&self, previous: Option<TextInputTarget>) {
        self.until("the requested editor was not ready for text input", || {
            let editable = self.app.update(|cx| {
                self.window
                    .update(cx, |view, window, cx| view.accepts_text_input(window, cx))
                    .unwrap()
            });
            if !editable {
                return None;
            }
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
            self.platform
                .take_clipboard_write()
                .and_then(|item| item.text())
        })
        .await
    }

    async fn type_text(&self, text: &str) {
        self.target_after(None).await;
        self.key("a", true);
        self.platform.paste(text).unwrap();
        self.expect_text(text).await;
    }

    /// Enter does nothing until the typed draft can be sent.
    async fn submit(&self) {
        self.control("Send message").await;
        self.key("enter", false);
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

    fn drop_paths(&self, paths: Vec<std::path::PathBuf>, position: gpui::Point<gpui::Pixels>) {
        self.platform
            .dispatch_input(PlatformInput::MouseMove(MouseMoveEvent {
                position,
                pressed_button: Some(MouseButton::Left),
                modifiers: Modifiers::default(),
            }))
            .unwrap();
        self.pump();
        self.app.update(|cx| {
            cx.update_window(self.window.into(), |_, window, cx| {
                window.dispatch_event(
                    PlatformInput::FileDrop(FileDropEvent::Entered {
                        position,
                        paths: ExternalPaths(paths.into()),
                    }),
                    cx,
                );
            })
            .unwrap();
            self.window.update(cx, |_, _, cx| cx.notify()).unwrap();
            cx.update_window(self.window.into(), |_, window, cx| {
                window.refresh();
                window.draw(cx).clear(cx);
                for event in [
                    FileDropEvent::Pending { position },
                    FileDropEvent::Submit { position },
                ] {
                    window.dispatch_event(PlatformInput::FileDrop(event), cx);
                }
            })
            .unwrap();
        });
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
    fn controls(&self, label: &str) -> Vec<Bounds<gpui::Pixels>> {
        self.app.update(|cx| {
            self.window
                .update(cx, |view, _, _| view.pressable_bounds(label))
                .unwrap()
        })
    }

    async fn composer_height(
        &self,
        stage: &str,
        ready: impl Fn(gpui::Pixels) -> bool,
    ) -> gpui::Pixels {
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
    async fn control(&self, label: &str) -> Bounds<gpui::Pixels> {
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

    fn press_at(&self, position: gpui::Point<gpui::Pixels>) {
        self.click_at(position, MouseButton::Left);
    }

    fn click_at(&self, position: gpui::Point<gpui::Pixels>, button: MouseButton) {
        for input in [
            PlatformInput::MouseMove(MouseMoveEvent {
                position,
                pressed_button: None,
                modifiers: Modifiers::default(),
            }),
            PlatformInput::MouseDown(MouseDownEvent {
                button,
                position,
                modifiers: Modifiers::default(),
                click_count: 1,
                first_mouse: false,
            }),
            PlatformInput::MouseUp(MouseUpEvent {
                button,
                position,
                modifiers: Modifiers::default(),
                click_count: 1,
            }),
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
        self.app.update(|cx| {
            self.window.update(cx, |view, _, _| view.stop()).unwrap();
        });
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
        self.app.update(|cx| {
            self.window
                .update(cx, |view, window, cx| {
                    view.set_appearance(appearance, cx);
                    view.load_with_config(config);
                    window.focus(&view.focus_handle(cx), cx);
                })
                .unwrap();
        });
        self
    }

    async fn close(self) {
        self.app.update(|cx| {
            self.window.update(cx, |view, _, _| view.stop()).unwrap();
        });
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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn desktop_remembers_folders_without_restoring_unsent_drafts() {
    let mut fixture = images_fixture().await;
    let (path, _) = image_file(&fixture);
    let workspace = fixture.directory.path().join("workspace");
    std::fs::create_dir_all(workspace.join("other-project/workspace")).unwrap();
    let desktop = Desktop::open(&fixture, &fixture.address).await;
    desktop.new_draft().await;
    desktop.attach(&path).await;
    desktop.type_text("UNSENT_LOCAL_ONLY").await;
    desktop.press("Choose composer workspace").await;
    desktop.press("Choose another folder…").await;
    desktop.press("Browse folder Workspace").await;
    desktop.press("Browse folder other-project").await;
    desktop.press("Browse folder workspace").await;
    desktop.press("Use this workspace folder").await;
    desktop.press("Focus message composer").await;
    desktop.expect_text("UNSENT_LOCAL_ONLY").await;
    desktop.press("Choose composer workspace").await;
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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
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
    desktop.press("Choose composer workspace").await;
    desktop.artifact("recent-folders-remove");
    desktop.press("Remove this folder from recents").await;
    desktop
        .wait("removed folder was still remembered", async {
            while !desktop.client.recent_workspaces().await.unwrap().is_empty() {
                tokio::task::yield_now().await;
            }
        })
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
    let desktop = desktop
        .restart(&fixture, nsh_core::platform::Appearance::Dark)
        .await;
    desktop.press("Choose composer workspace").await;
    desktop.control("Choose another folder…").await;
    assert!(
        desktop
            .controls(&format!("Use folder {}", workspace.display()))
            .is_empty()
    );
    assert!(desktop.client.recent_workspaces().await.unwrap().is_empty());
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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
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
    desktop.platform.paste("/set").unwrap();
    desktop.control("/settings").await;
    desktop.control("Send message").await;
    desktop.artifact("new-draft-slash-menu");
    desktop.press("/settings").await;
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
    desktop.platform.paste("AFTER_SLASH_COMMAND").unwrap();
    desktop.expect_text("AFTER_SLASH_COMMAND").await;
    desktop.type_text("/draft").await;
    desktop.key("right", false);
    desktop.control("draft-guide").await;
    desktop.artifact("new-draft-skill-menu");
    desktop.press("draft-guide").await;
    desktop.expect_text("/skill:draft-guide ").await;
    desktop.key("right", false);
    desktop.platform.paste("@draft-ref").unwrap();
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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn desktop_retries_a_failed_turn_in_place() {
    let mut fixture = Fixture::open().await;
    let desktop = Desktop::open(&fixture, &fixture.address).await;
    desktop.new_draft().await;
    desktop.type_text("RETRIED_IN_PLACE_MESSAGE").await;
    desktop.submit().await;
    let failed = desktop.request(&mut fixture).await;
    failed
        .http_error(
            json!({"error":{"type":"invalid_request_error","message":"FIXTURE_TURN_FAILED"}}),
        )
        .await;
    desktop.press("Retry").await;
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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
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
    let answer = desktop.request(&mut fixture).await;
    desktop.press("Process group").await;
    let group = desktop.control("Process group").await;
    let nested = desktop.control("Toggle tool GetGoal").await;
    // A turn has two lanes and no indent: each step's icon sits under the
    // group's chevron, and an open tool card starts on that same lane.
    assert_eq!(nested.left(), group.left());
    assert!(desktop.controls("Toggle tool exec").is_empty());
    desktop.press("Toggle tool GetGoal").await;
    let lane = nested.left() + px(8.);
    let below = nested.bottom() + px(24.);
    desktop
        .until("the tool card did not start on the icon lane", || {
            desktop.app.update(|cx| cx.refresh_windows());
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
    answer.finish().await;
    let sessions = desktop.sessions().await;
    let session = sessions
        .iter()
        .find(|session| session["id"] != fixture.session)
        .unwrap()["id"]
        .as_str()
        .unwrap();
    fixture.idle(&desktop.client, session).await;
    desktop.close().await;
    fixture.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn desktop_side_pane_keeps_its_draft_separate_when_closed_and_reopened() {
    let fixture = Fixture::open().await;
    let desktop = Desktop::open_at(
        &fixture,
        &fixture.address,
        size(gpui::DevicePixels(1440), gpui::DevicePixels(800)),
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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn desktop_steering_freezes_each_message_and_queue_is_one_shot() {
    let mut fixture = Fixture::open().await;
    let gate = ReplyGate::send(fixture.directory.path(), fixture.address.clone());
    let (theme, appearance, width_name, width, height) = visual_case();
    let desktop = Desktop::open_at(
        &fixture,
        &gate.address,
        size(gpui::DevicePixels(width), gpui::DevicePixels(height)),
        appearance,
    )
    .await;
    desktop.new_draft().await;
    desktop
        .type_text("Review the current implementation.")
        .await;
    desktop.submit().await;
    let original = desktop.request(&mut fixture).await;
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
    let second = desktop.request(&mut fixture).await;
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
    let third = desktop.request(&mut fixture).await;
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
    desktop.key("escape", false);
    desktop.press("Messages").await;
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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
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
            assert!(desktop.app.update(|cx| {
                desktop
                    .window
                    .update(cx, |view, _, _| {
                        AppView::paste(
                            view,
                            nsh_core::PasteEvent::new(format!("'{}'", directory.display())),
                        )
                    })
                    .unwrap()
            }));
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
            desktop.key_with(
                "right",
                Modifiers {
                    shift: true,
                    ..Default::default()
                },
            );
        }
        let _ = desktop.platform.take_clipboard_write();
        desktop
            .until("the replacement range was not selected", || {
                desktop.key("c", true);
                desktop
                    .platform
                    .take_clipboard_write()
                    .and_then(|item| item.text())
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
                desktop.app.update(|cx| {
                    desktop
                        .window
                        .update(cx, |_, window, _| {
                            (!window.is_window_active()).then_some(())
                        })
                        .unwrap()
                })
            })
            .await;
        desktop.drop_paths(vec![directory.clone()], position);
        let expanded = desktop
            .composer_height("the dropped directory did not wrap", |height| {
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
            desktop.app.update(|cx| cx.refresh_windows());
            desktop.pump();
            let pixel = desktop.pixels(sample)?;
            (pixel[..3] != surface).then_some(())
        })
        .await;
    desktop.artifact("staged-image");
    desktop.close().await;
    fixture.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
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
    let dimensions = size(gpui::DevicePixels(width), gpui::DevicePixels(height));
    let desktop = Desktop::open_at(&fixture, &fixture.address, dimensions, appearance).await;
    desktop.new_draft().await;
    desktop.type_text("Start a response").await;
    desktop.submit().await;
    let mut reply = desktop.request(&mut fixture).await;
    desktop.control("Stop response").await;
    shell_shares_its_lines(&desktop, layout == "wide").await;
    let closing = tokio::spawn({
        let store = fixture.store.clone();
        async move { store.shutdown().await }
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
        .unwrap()
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
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn desktop_connection_failure_has_one_status_below_the_workspace() {
    let (theme, appearance, layout, width, height) = visual_case();
    disconnected_desktop(theme, appearance, layout, width, height).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn desktop_model_settings_keeps_successful_sign_in_and_retries_models() {
    let fixture = Fixture::open().await;
    let entry = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../terminal-shell/tests/real_host/model_settings_preview.tsx");
    let output = fixture.directory.path().join("settings-preview");
    let source = tokio::task::spawn_blocking(move || {
        let compiled = maka_ui_build::compile(&entry, &output).unwrap();
        std::fs::read_to_string(compiled.module).unwrap()
    })
    .await
    .unwrap();
    let (theme, appearance, layout, width, height) = visual_case();
    let desktop = Desktop::open_config(
        &fixture,
        &fixture.address,
        size(gpui::DevicePixels(width), gpui::DevicePixels(height)),
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
            desktop
                .platform
                .take_clipboard_write()
                .and_then(|item| item.text())
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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn desktop_provider_picker_searches_real_catalog_and_preserves_selection() {
    let fixture = Fixture::open().await;
    let entry = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../terminal-shell/tests/real_host/model_settings_preview.tsx");
    let output = fixture.directory.path().join("settings-preview");
    let source = tokio::task::spawn_blocking(move || {
        let compiled = maka_ui_build::compile(&entry, &output).unwrap();
        std::fs::read_to_string(compiled.module).unwrap()
    })
    .await
    .unwrap();
    let (theme, appearance, layout, width, height) = visual_case();
    let desktop = Desktop::open_config(
        &fixture,
        &fixture.address,
        size(gpui::DevicePixels(width), gpui::DevicePixels(height)),
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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn desktop_mermaid_renders_markdown_and_toggles_its_source() {
    let fixture = Fixture::open().await;
    let (theme, appearance, layout, width, height) = visual_case();
    let entry = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../terminal-shell/tests/real_host/mermaid_preview.tsx");
    let output = fixture.directory.path().join("mermaid-preview");
    let source = tokio::task::spawn_blocking(move || {
        let compiled = maka_ui_build::compile(&entry, &output).unwrap();
        std::fs::read_to_string(compiled.module).unwrap()
    })
    .await
    .unwrap();
    let desktop = Desktop::open_config(
        &fixture,
        &fixture.address,
        size(gpui::DevicePixels(width), gpui::DevicePixels(height)),
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
            desktop
                .platform
                .take_clipboard_write()
                .and_then(|item| item.text())
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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn desktop_goal_commands_create_pause_resume_and_finish_without_losing_the_draft() {
    let mut fixture = Fixture::open().await;
    let (theme, appearance, layout, width, height) = visual_case();
    let desktop = Desktop::open_at(
        &fixture,
        &fixture.address,
        size(gpui::DevicePixels(width), gpui::DevicePixels(height)),
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
            || !desktop.controls("Close Goal").is_empty(),
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
    desktop.app.update(|cx| {
        cx.write_to_clipboard(gpui::ClipboardItem::new_string(
            "Read the project\nFix the actual problem and verify it".into(),
        ))
    });
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
    running
        .tool_call(
            "GoalStatus",
            json!({"status":"achieved", "note":"Verified the requested result"}),
        )
        .await;
    desktop.request(&mut fixture).await.finish().await;
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
    desktop.request(&mut fixture).await.finish().await;
    desktop.press("Focus message composer").await;
    desktop.type_text("/goal").await;
    // "/goal" opens a completion menu, and an Enter on the binding of a menu
    // that just closed is lost.
    desktop
        .retry(
            "/goal did not open the Goal dialog",
            || !desktop.controls("Close Goal").is_empty(),
            || desktop.key("enter", false),
        )
        .await;
    desktop.control("New Goal").await;
    desktop.key("escape", false);
    desktop
        .until("the Goal dialog did not close", || {
            desktop.controls("Close Goal").is_empty().then_some(())
        })
        .await;
    drop(first);
    desktop.close().await;
    fixture.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn desktop_todo_strip_keeps_its_row_in_place_and_closes_until_the_list_changes() {
    let mut fixture = Fixture::open().await;
    let (theme, appearance, layout, width, height) = visual_case();
    let desktop = Desktop::open_at(
        &fixture,
        &fixture.address,
        size(gpui::DevicePixels(width), gpui::DevicePixels(height)),
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
    let sample = |at: gpui::Point<gpui::Pixels>| {
        desktop.app.update(|cx| cx.refresh_windows());
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
    desktop.press("Process group").await;
    desktop.control("Toggle tool todo_write").await;
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
            || (desktop.controls("Toggle tool todo_write").len() == 2).then_some(()),
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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn desktop_parent_reviews_child_access_and_opens_attributed_sender_beside() {
    use super::support::mutate;
    use maka_agent_api::session::StoredSessionConfiguration;
    use maka_agent_facts::interaction::{InteractionRecord, InteractionRequest, PermissionRequest};

    let mut fixture = Fixture::configured(Options {
        session_tools: true,
        ..Options::default()
    })
    .await;
    let parent = fixture.session.clone();
    let (_, appearance, _, width, height) = visual_case();
    let desktop = Desktop::open_at(
        &fixture,
        &fixture.address,
        size(gpui::DevicePixels(1280), gpui::DevicePixels(900)),
        appearance,
    )
    .await;
    let backend = json!({
        "kind": "model",
        "connectionId": fixture.selection["connectionId"],
        "modelId": fixture.selection["modelId"],
    });
    mutate(&desktop.client, "send", json!({
        "sessionId":parent, "message":"Delegate sandbox verification and review any access request.",
        "backend":backend,
    })).await;
    desktop
        .request(&mut fixture)
        .await
        .tool_call("tool_search", json!({"query":"Session"}))
        .await;
    let discovered = desktop.request(&mut fixture).await;
    for name in ["SessionCreate", "SessionSend", "SessionRespond"] {
        assert!(
            discovered.body["tools"]
                .as_array()
                .unwrap()
                .iter()
                .any(|tool| tool["function"]["name"] == name),
            "missing {name}: {}",
            discovered.body
        );
    }
    discovered
        .tool_call(
            "SessionCreate",
            json!({
                "title":"Verify sandbox delegation","labels":[],
                "workspace":{"kind":"session","sessionId":parent},
            }),
        )
        .await;
    let created_reply = desktop.request(&mut fixture).await;
    let created: Value = serde_json::from_str(
        created_reply.body["messages"]
            .as_array()
            .unwrap()
            .last()
            .unwrap()["content"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(created["kind"], "created", "{created}");
    let child = created["session"]["id"].as_str().unwrap().to_owned();
    created_reply.tool_call("SessionSend", json!({
        "sessionId":child, "message":"Verify the sandbox boundary. Write the verification report only after approval.",
        "backend":backend,
    })).await;
    let first = desktop.request(&mut fixture).await;
    let second = desktop.request(&mut fixture).await;
    let (parent_reply, mut child_reply) =
        if first.body["messages"].as_array().unwrap().last().unwrap()["role"] == "tool" {
            (first, second)
        } else {
            (second, first)
        };
    let store = fixture.store.session(&child).await.unwrap();
    let projection = store
        .session_projection::<StoredSessionConfiguration>(&child)
        .await
        .unwrap()
        .unwrap();
    let binding = projection
        .session
        .workspace_binding
        .as_ref()
        .unwrap()
        .stamp();
    let basis = maka_agent_facts::workspace::PermissionBasis {
        boundary_revision: projection
            .session
            .configuration
            .workspace
            .boundary_revision(projection.session.configuration.boundary_revision, binding)
            .unwrap(),
        binding,
    };
    let invocation = projection.root_turn.unwrap().invocation;
    let permissions = json!({"filesystem":[{
        "path":fixture.directory.path().join("workspace/report.md"),"scope":"exact","access":"write"
    }],"network":"denied"});
    let record = InteractionRecord {
        session_id: child.clone(),
        turn_id: invocation.turn_id.clone(),
        run_id: invocation.run_id.clone(),
        request_id: Uuid::new_v4().to_string(),
        created_at: 1,
        request: InteractionRequest::Permissions {
            tool_use_id: Some("write-report".into()),
            basis,
            request: PermissionRequest {
                reason: "Write the sandbox verification report.".into(),
                command: None,
                permissions: serde_json::from_value(permissions.clone()).unwrap(),
            },
        },
        outcome: None,
    };
    assert!(
        store
            .establish_run_interaction(&invocation, &record)
            .await
            .unwrap()
            .matches
    );
    desktop.press("Waiting for you").await;
    desktop
        .control("Actions for Verify sandbox delegation")
        .await;
    desktop.artifact("child-needs-you-inbox");
    desktop.press("Waiting for you").await;
    desktop
        .until("child remained in the normal root sidebar", || {
            desktop
                .controls("Actions for Verify sandbox delegation")
                .is_empty()
                .then_some(())
        })
        .await;
    parent_reply.tool_call("SessionRespond", json!({
        "sessionId":child,"requestId":record.request_id,
        "answer":{"kind":"permissions","decision":{"decision":"allow","scope":"once","permissions":permissions}}
    })).await;
    desktop.control("Approve child decision").await;
    desktop.control("Verify sandbox delegation").await;
    desktop.artifact("parent-child-approval");
    desktop.press("Approve child decision").await;
    let mut parent_reply = desktop.request(&mut fixture).await;
    let settled = desktop
        .client
        .query(
            "agent",
            "interaction",
            json!({
                "sessionId":child,"requestId":record.request_id
            }),
        )
        .await
        .unwrap();
    assert_eq!(settled["outcome"]["kind"], "permissions_decision");
    assert_eq!(settled["outcome"]["decision"]["decision"], "allow");
    parent_reply
        .delta("Approved this report write for one call after your confirmation.")
        .await;
    parent_reply.finish().await;
    child_reply
        .delta("Sandbox verification is complete. The report write was approved for one call only.")
        .await;
    child_reply.finish().await;
    desktop
        .wait(
            "parent did not finish",
            fixture.idle(&desktop.client, &parent),
        )
        .await;
    desktop
        .wait(
            "child did not finish",
            fixture.idle(&desktop.client, &child),
        )
        .await;
    if !desktop.controls("Expand session browser").is_empty() {
        desktop.press("Expand session browser").await;
    }
    assert!(
        desktop
            .controls("Actions for Verify sandbox delegation")
            .is_empty(),
        "child conversations must not appear as sidebar roots"
    );
    desktop.press("Actions for NSH real Agent").await;
    desktop.press("Child conversations").await;
    desktop.press("Open Verify sandbox delegation").await;
    assert!(
        desktop
            .controls("Open source conversation beside this one")
            .is_empty()
    );
    desktop
        .retry(
            "the completed child work details did not open",
            || !desktop.controls("Agent message").is_empty(),
            || {
                let controls = desktop.controls("Turn work details");
                if controls.len() == 1 {
                    desktop.press_at(controls[0].center());
                }
            },
        )
        .await;
    // The finished turn's summary is its only disclosure; its steps share its icon lane.
    assert!(desktop.controls("Process group").is_empty());
    let summary = desktop.control("Turn work details").await;
    let message = desktop.control("Agent message").await;
    assert_eq!(message.left(), summary.left());
    assert!(
        desktop
            .controls("Open source conversation beside this one")
            .is_empty()
    );
    desktop.press("Agent message").await;
    desktop
        .control("Open source conversation beside this one")
        .await;
    desktop
        .press("Open source conversation beside this one")
        .await;
    desktop.control("Close side pane").await;
    desktop
        .until(
            "source conversation did not load its reply beside the child",
            || (desktop.controls("Copy message").len() == 2).then_some(()),
        )
        .await;
    desktop.artifact("source-conversation-beside");
    desktop.press("Close side pane").await;
    desktop
        .platform
        .set_viewport(
            size(gpui::DevicePixels(width), gpui::DevicePixels(height)),
            1.0,
        )
        .unwrap();
    desktop
        .until("activity lanes did not settle after resize", || {
            let summaries = desktop.controls("Turn work details");
            let messages = desktop.controls("Agent message");
            let ([summary], [message]) = (summaries.as_slice(), messages.as_slice()) else {
                return None;
            };
            (message.right() <= px(width as f32) && message.left() == summary.left()).then_some(())
        })
        .await;
    desktop.artifact("agent-message-expanded");
    desktop.press("Agent message").await;
    desktop.artifact("agent-message-collapsed");
    desktop.press("Turn work details").await;
    desktop.artifact("agent-message-default");
    desktop.close().await;
    fixture.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn desktop_child_conversations_manage_nested_and_archived_workers() {
    use maka_agent_api::session::StoredSessionConfiguration;
    let fixture = Fixture::open().await;
    let original = fixture
        .store
        .session(&fixture.session)
        .await
        .unwrap()
        .get_session::<StoredSessionConfiguration>(&fixture.session)
        .await
        .unwrap()
        .unwrap()
        .configuration;
    let prefix = fixture.session.rsplit_once('_').unwrap().0;
    let child = format!("{prefix}_{}", Uuid::new_v4().simple());
    let grandchild = format!("{prefix}_{}", Uuid::new_v4().simple());
    let disposable = format!("{prefix}_{}", Uuid::new_v4().simple());
    for (id, parent, title) in [
        (&child, &fixture.session, "Archived worker"),
        (&grandchild, &child, "Verification worker"),
        (&disposable, &fixture.session, "Disposable worker"),
    ] {
        let mut configuration = original.clone();
        configuration.parent_session_id = Some(parent.clone());
        configuration.title = title.into();
        configuration.backend = Some(
            serde_json::from_value(json!({
                "kind":"model", "connectionId":fixture.selection["connectionId"],
                "modelId":fixture.selection["modelId"], "thinkingLevel":null,
            }))
            .unwrap(),
        );
        fixture
            .store
            .create_session(id, id, &configuration, 1)
            .await
            .unwrap();
    }
    fixture
        .store
        .session(&child)
        .await
        .unwrap()
        .change_session_archived::<StoredSessionConfiguration>(&child, None, true, 2)
        .await
        .unwrap();
    let (theme, appearance, layout, width, height) = visual_case();
    let width = if layout == "narrow" { 640 } else { width };
    let desktop = Desktop::open_at(
        &fixture,
        &fixture.address,
        size(gpui::DevicePixels(width), gpui::DevicePixels(height)),
        appearance,
    )
    .await;
    if !desktop.controls("Expand session browser").is_empty() {
        desktop.press("Expand session browser").await;
    }
    desktop.press("Actions for NSH real Agent").await;
    desktop.press("Child conversations").await;
    let first = desktop.control("Open Archived worker").await;
    desktop.press("Expand Archived worker").await;
    let last = desktop.control("Open Verification worker").await;
    assert!(
        last.left() > first.left(),
        "a grandchild must be visibly nested beneath its parent"
    );
    assert!(
        last.right() <= px(width as f32 - 16.0),
        "deep rows stay inside the dialog's viewport"
    );
    desktop.artifact(&format!("child-conversations-{theme}-{layout}"));
    for (id, title, action, archived) in [
        (
            &grandchild,
            "Verification worker",
            "Archive conversation",
            true,
        ),
        (
            &grandchild,
            "Verification worker",
            "Restore conversation",
            false,
        ),
        (&child, "Archived worker", "Restore conversation", false),
        (
            &disposable,
            "Disposable worker",
            "Archive conversation",
            true,
        ),
    ] {
        desktop.right_click(&format!("Open {title}")).await;
        desktop.control(action).await;
        desktop.artifact(&format!(
            "child-menu-{}-{theme}-{layout}",
            if archived { "archive" } else { "restore" }
        ));
        desktop.press(action).await;
        desktop
            .wait("tree action did not change the targeted worker", async {
                loop {
                    let observed = desktop
                        .client
                        .query("agent", "observe", json!({"sessionId":id}))
                        .await
                        .unwrap();
                    if observed["session"]["archived"] == archived {
                        break;
                    }
                    tokio::task::yield_now().await;
                }
            })
            .await;
        desktop
            .until("tree action menu did not settle", || {
                (desktop.controls(action).is_empty()
                    && desktop.controls("Close child conversations").len() == 1)
                    .then_some(())
            })
            .await;
        desktop.control("Open Verification worker").await;
    }
    desktop.press("Actions for Disposable worker").await;
    desktop.press("Delete conversation").await;
    desktop.control("Confirm delete conversation").await;
    assert!(
        fixture
            .store
            .get_session::<StoredSessionConfiguration>(&disposable)
            .await
            .unwrap()
            .is_some(),
        "opening delete confirmation must not delete the worker"
    );
    desktop.artifact(&format!("child-delete-confirmation-{theme}-{layout}"));
    desktop.press("Confirm delete conversation").await;
    desktop
        .until("deleted worker remained in the tree", || {
            (desktop.controls("Open Disposable worker").is_empty()
                && desktop.controls("Close child conversations").len() == 1)
                .then_some(())
        })
        .await;
    assert!(
        fixture
            .store
            .get_session::<StoredSessionConfiguration>(&disposable)
            .await
            .unwrap()
            .is_none()
    );
    let previous = desktop.platform.text_input_target();
    desktop.press("Open Verification worker").await;
    desktop.target_after(previous).await;
    desktop.type_text("OPENED_TREE_GRANDCHILD").await;
    desktop
        .wait(
            "opening a descendant did not bind its draft to that conversation",
            super::support::wait_draft(&desktop.client, &grandchild, "OPENED_TREE_GRANDCHILD"),
        )
        .await;
    desktop.close().await;
    fixture.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn desktop_composer_large_paste_keeps_controls_on_screen() {
    let fixture = Fixture::open().await;
    let desktop = Desktop::open_at(
        &fixture,
        &fixture.address,
        size(gpui::DevicePixels(1280), gpui::DevicePixels(800)),
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
    desktop
        .app
        .update(|cx| cx.write_to_clipboard(gpui::ClipboardItem::new_string(draft.clone())));
    let keystroke = Keystroke {
        key: "v".into(),
        key_char: None,
        modifiers: Modifiers {
            control: true,
            shift: true,
            ..Default::default()
        },
    };
    desktop
        .platform
        .dispatch_input(PlatformInput::KeyDown(gpui::KeyDownEvent {
            keystroke: keystroke.clone(),
            is_held: false,
            prefer_character_input: false,
        }))
        .unwrap();
    desktop
        .platform
        .dispatch_input(PlatformInput::KeyUp(gpui::KeyUpEvent { keystroke }))
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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn desktop_system_permission_guidance_uses_native_actions_without_paths() {
    let fixture = Fixture::open().await;
    let entry = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../terminal-shell/tests/real_host/permission_preview.tsx");
    let output = fixture.directory.path().join("permission-preview");
    let source = tokio::task::spawn_blocking(move || {
        let compiled = maka_ui_build::compile(&entry, &output).unwrap();
        std::fs::read_to_string(compiled.module).unwrap()
    })
    .await
    .unwrap();
    let desktop = Desktop::open_config(
        &fixture,
        &fixture.address,
        size(gpui::DevicePixels(1120), gpui::DevicePixels(800)),
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
