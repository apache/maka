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

use super::support::{Fixture, ModelRequest, Options, ReplyGate};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use gpui::{
    AppContext, Application, ApplicationHandle, Bounds, Focusable, Keystroke, Modifiers,
    MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, PlatformInput, TextInputTarget,
    WindowBounds, WindowHandle, WindowOptions, point, px, size,
};
use maka_app_client::Client;
use maka_plugin_core::operation::{OperationOutcome, Receipt};
use maka_workbench::bindings::Bindings;
use nsh_gpui_terminal::{CandidateFrame, TerminalPlatform};
use nsh_platform_gpui::{AppOptions, AppView};
use serde_json::{Value, json};
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
        preview: Option<(String, &str)>,
    ) -> Self {
        let client = fixture.client_at(address).await;
        let bindings = Bindings::new(client.clone(), tokio::runtime::Handle::current());
        let mut config = maka_workbench::configuration(
            bindings.registry(Some(fixture.session.clone())),
            tokio::runtime::Handle::current(),
        );
        config.assets = Some(bindings.assets());
        config.chunk_loader = Some(bindings.chunk_loader());
        let previewing = preview.is_some();
        let close_label = match preview.as_ref().map(|(_, locale)| *locale) {
            Some("zh-CN") => "关闭设置",
            Some("zh-TW") => "關閉設定",
            _ => "Close settings",
        };
        if let Some((source, locale)) = preview {
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
        if previewing {
            desktop.control(close_label).await;
        } else {
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
        for pixel in frame.pixels().chunks_exact(4) {
            ppm.extend_from_slice(&pixel[..3]);
        }
        std::fs::write(directory.join(format!("{name}.ppm")), ppm).unwrap();
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
        tokio::time::timeout(Duration::from_secs(30), async {
            loop {
                self.pump();
                if let Some(value) = read() {
                    return value;
                }
                self.wake.notified().await;
            }
        })
        .await
        .unwrap_or_else(|_| {
            self.artifact("failure");
            panic!("{stage}; observed: {:?}", self.outcome.lock().unwrap());
        })
    }

    async fn wait<T>(&self, stage: &str, future: impl Future<Output = T>) -> T {
        tokio::time::timeout(Duration::from_secs(30), async {
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
        let keystroke = Keystroke {
            key: name.into(),
            key_char: None,
            modifiers: Modifiers {
                control,
                ..Default::default()
            },
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
        self.until("the requested editor did not receive focus", || {
            self.platform
                .text_input_target()
                .filter(|target| Some(target) != previous.as_ref())
        })
        .await;
    }

    async fn input_text(&self) -> String {
        let _ = self.platform.take_clipboard_write();
        self.key("a", true);
        self.key("c", true);
        self.until("the editor did not copy its contents", || {
            self.platform
                .take_clipboard_write()
                .and_then(|item| item.text())
        })
        .await
    }

    async fn type_text(&self, text: &str) {
        self.wait("the editor did not accept the draft", async {
            loop {
                self.key("a", true);
                self.platform.paste(text).unwrap();
                if self.input_text().await == text {
                    return;
                }
                self.wake.notified().await;
            }
        })
        .await;
    }

    async fn expect_text(&self, text: &str) {
        self.wait("the expected draft did not appear in the editor", async {
            loop {
                if self.input_text().await == text {
                    return;
                }
                self.wake.notified().await;
            }
        })
        .await;
    }

    async fn new_draft(&self) {
        let previous = self.platform.text_input_target();
        self.key("n", true);
        self.target_after(previous).await;
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

    /// The card's corners stay concentric with its round buttons, and its
    /// controls stay on one center line, whatever height the card has.
    async fn assert_composer_geometry(&self) -> Bounds<gpui::Pixels> {
        let card = self.control("Focus message composer").await;
        let add = self.control("Add to message").await;
        let send = self.control("Send message").await;
        assert_eq!(add.left() - card.left(), px(8.));
        assert_eq!(card.right() - send.right(), px(8.));
        assert_eq!(card.bottom() - send.bottom(), px(8.));
        for label in ["Sandbox and approvals", "Choose model and effort"] {
            assert_eq!(self.control(label).await.center().y, send.center().y);
        }
        assert_eq!(add.center().y, send.center().y);
        card
    }

    fn press_at(&self, position: gpui::Point<gpui::Pixels>) {
        for input in [
            PlatformInput::MouseMove(MouseMoveEvent {
                position,
                pressed_button: None,
                modifiers: Modifiers::default(),
            }),
            PlatformInput::MouseDown(MouseDownEvent {
                button: MouseButton::Left,
                position,
                modifiers: Modifiers::default(),
                click_count: 1,
                first_mouse: false,
            }),
            PlatformInput::MouseUp(MouseUpEvent {
                button: MouseButton::Left,
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

    async fn close(self) {
        self.app.update(|cx| {
            self.window.update(cx, |view, _, _| view.stop()).unwrap();
        });
        self.bindings.close().await.unwrap();
    }
}

async fn images_fixture() -> Fixture {
    Fixture::configured(Options { images: true }).await
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

async fn set_model_enabled(client: &Client, enabled: bool) {
    let catalog = client
        .query("settings", "connections", json!({"kind":"start"}))
        .await
        .unwrap();
    let mutation = client
        .mutation(
            Uuid::new_v4(),
            "settings",
            "update",
            json!({"expected":catalog["connections"][0]["basis"],"changes":{"enabled":enabled}}),
            Default::default(),
            None,
            Value::Null,
        )
        .await
        .unwrap();
    mutation.prepare().await.unwrap();
    let receipt = mutation.confirm().await.unwrap().receipt;
    assert!(
        matches!(receipt, Receipt::Recorded { outcome: OperationOutcome::Returned { ref value }, .. } if value["kind"] == "committed"),
        "{receipt:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn desktop_creates_only_on_first_submission_and_preserves_the_confirmed_snapshot() {
    let mut fixture = images_fixture().await;
    let (path, bytes) = image_file(&fixture);
    let create = ReplyGate::create(fixture.directory.path(), fixture.address.clone());
    let upload = ReplyGate::upload(fixture.directory.path(), create.address.clone());
    let desktop = Desktop::open(&fixture, &upload.address).await;
    desktop.new_draft().await;
    desktop.attach(&path).await;
    std::fs::write(&path, b"changed after selection").unwrap();
    desktop.type_text("FIRST_DESKTOP_MESSAGE").await;
    assert_eq!(desktop.sessions().await.len(), 1);
    create.arm();
    desktop.key("enter", false);
    desktop.held(&create).await;
    desktop.key("enter", false);
    upload.arm();
    create.release();
    desktop.held(&upload).await;
    desktop
        .type_text("FIRST_DESKTOP_MESSAGE_CONTINUATION")
        .await;
    upload.release();
    let request = desktop.request(&mut fixture).await;
    assert_image(&request, "FIRST_DESKTOP_MESSAGE", &bytes);
    assert!(!request.body.to_string().contains("_CONTINUATION"));
    let sessions = desktop.sessions().await;
    assert_eq!(sessions.len(), 2);
    let session = sessions
        .iter()
        .find(|session| session["id"] != fixture.session)
        .unwrap()["id"]
        .as_str()
        .unwrap();
    request.finish().await;
    fixture.idle(&desktop.client, session).await;
    desktop.expect_text("_CONTINUATION").await;
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
async fn desktop_retries_a_failed_first_submission_in_the_same_session() {
    let mut fixture = images_fixture().await;
    let (path, bytes) = image_file(&fixture);
    let model = ReplyGate::resolve_model(fixture.directory.path(), fixture.address.clone());
    let upload = ReplyGate::upload(fixture.directory.path(), model.address.clone());
    let desktop = Desktop::open(&fixture, &upload.address).await;
    desktop.new_draft().await;
    desktop.attach(&path).await;
    desktop.type_text("FAILED_FIRST_MESSAGE").await;
    upload.arm();
    desktop.key("enter", false);
    desktop.held(&upload).await;
    let sessions = desktop.sessions().await;
    assert_eq!(sessions.len(), 2);
    let session = sessions
        .iter()
        .find(|session| session["id"] != fixture.session)
        .unwrap()["id"]
        .as_str()
        .unwrap();
    set_model_enabled(&desktop.client, false).await;
    model.arm();
    upload.release();
    desktop.held(&model).await;
    model.release();
    desktop.type_text("RETRIED_FIRST_MESSAGE").await;
    desktop
        .wait(
            "the session did not retain the edited draft and attachment",
            async {
                loop {
                    if let Some(draft) = desktop
                        .client
                        .load_draft("agent", session, "composer")
                        .await
                        .unwrap()
                        && draft.text == "RETRIED_FIRST_MESSAGE"
                    {
                        assert_eq!(draft.attachments.len(), 1);
                        return;
                    }
                    tokio::task::yield_now().await;
                }
            },
        )
        .await;
    set_model_enabled(&desktop.client, true).await;
    desktop.key("enter", false);
    let retry = desktop.request(&mut fixture).await;
    assert_image(&retry, "RETRIED_FIRST_MESSAGE", &bytes);
    retry.finish().await;
    fixture.idle(&desktop.client, session).await;
    let sessions = desktop.sessions().await;
    assert_eq!(sessions.len(), 2);
    assert!(sessions.iter().any(|entry| entry["id"] == session));
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
    desktop.key("enter", false);
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
async fn desktop_opens_a_conversation_beside_the_current_one() {
    let mut fixture = Fixture::open().await;
    let desktop = Desktop::open(&fixture, &fixture.address).await;
    desktop.type_text("BASE_SIDE_DRAFT").await;
    desktop.new_draft().await;
    desktop.type_text("MAIN_PANE_MESSAGE").await;
    desktop.key("enter", false);
    desktop.request(&mut fixture).await.finish().await;
    let roots = desktop
        .client
        .query("agent", "directories", json!({"kind":"roots"}))
        .await
        .unwrap();
    for index in 0..4 {
        super::support::mutate(
            &desktop.client,
            "create",
            json!({
                "title":format!("Side {index}"),"labels":[],
                "workspace":{"kind":"directory","selection":roots["roots"][0]["selection"]}
            }),
        )
        .await;
    }
    let resize = |width| {
        desktop
            .platform
            .resize(size(gpui::DevicePixels(width), gpui::DevicePixels(640)))
            .unwrap();
        desktop.pump();
    };
    resize(3072);
    for index in 0..4 {
        let original = desktop.platform.text_input_target();
        desktop.press(&format!("Actions for Side {index}")).await;
        desktop.press("Open to the side").await;
        desktop
            .until("the additional conversation did not open", || {
                (desktop.controls("Focus message composer").len() == index + 2).then_some(())
            })
            .await;
        desktop.target_after(original).await;
    }
    desktop.type_text("KEEP_RIGHT_DRAFT").await;
    let mut closes = desktop.controls("Close side pane");
    closes.sort_by_key(|bounds| bounds.origin.x);
    desktop.press_at(closes[1].center());
    desktop
        .until(
            "closing the middle pane did not keep the other panes",
            || (desktop.controls("Focus message composer").len() == 4).then_some(()),
        )
        .await;
    resize(1100);
    desktop
        .until("side panes did not hide in the narrower window", || {
            (desktop.controls("Focus message composer").len() == 2).then_some(())
        })
        .await;
    let original = desktop.platform.text_input_target();
    desktop.press("Actions for NSH real Agent").await;
    desktop.press("Open to the side").await;
    desktop.target_after(original).await;
    assert_eq!(
        desktop.input_text().await,
        "BASE_SIDE_DRAFT",
        "the requested conversation must replace a visible pane"
    );
    resize(3072);
    desktop
        .until("hidden conversations did not return", || {
            (desktop.controls("Focus message composer").len() == 4).then_some(())
        })
        .await;
    let right = desktop
        .controls("Focus message composer")
        .into_iter()
        .max_by_key(|bounds| bounds.origin.x)
        .unwrap();
    desktop.press_at(right.center());
    assert_eq!(desktop.input_text().await, "KEEP_RIGHT_DRAFT");
    while let Some(close) = desktop.controls("Close side pane").first().copied() {
        let remaining = desktop.controls("Close side pane").len() - 1;
        desktop.press_at(close.center());
        desktop
            .until("the side pane did not close", || {
                (desktop.controls("Close side pane").len() == remaining).then_some(())
            })
            .await;
    }
    assert_eq!(desktop.controls("Focus message composer").len(), 1);
    desktop.close().await;
    fixture.finish().await;
}

fn tool_names(request: &ModelRequest) -> Vec<String> {
    request.body["tools"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|tool| tool["function"]["name"].as_str().map(str::to_owned))
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn desktop_composer_keeps_one_inset() {
    let mut fixture = Fixture::open().await;
    let desktop = Desktop::open(&fixture, &fixture.address).await;
    desktop.new_draft().await;
    desktop.type_text("COMPOSER_GEOMETRY").await;
    desktop.assert_composer_geometry().await;
    desktop.key("enter", false);
    let mut reply = desktop.request(&mut fixture).await;
    reply.thinking("Thinking first.").await;
    reply.delta("Done.").await;
    reply.finish().await;
    let session = desktop
        .sessions()
        .await
        .into_iter()
        .find(|session| session["id"] != fixture.session)
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    desktop
        .wait(
            "the reply did not finish",
            fixture.idle(&desktop.client, &session),
        )
        .await;
    desktop.type_text("COMPOSER_GEOMETRY_AGAIN").await;
    let card = desktop.assert_composer_geometry().await;
    // The card's border sits outside the backdrop the window reports, and icon
    // buttons reach 8 points past the column so their glyphs land on its edges.
    let (left, right) = (card.left() - px(1.), card.right() + px(1.));
    let edit = desktop.control("Edit and resend in a fork").await;
    assert_eq!(edit.right() - px(8.), right);
    let source = desktop.controls("Copy message");
    assert_eq!(source[0].left() + px(8.), left);
    let turn = desktop.control("Turn work details").await;
    assert_eq!(turn.left() + px(8.), left);
    assert_eq!(turn.right() - px(8.), right);
    desktop.close().await;
    fixture.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn desktop_plans_first_then_runs_the_approved_plan() {
    let mut fixture = Fixture::open().await;
    let desktop = Desktop::open(&fixture, &fixture.address).await;
    desktop.new_draft().await;
    desktop.press("Planning mode").await;
    let previous = desktop.platform.text_input_target();
    desktop.press("Focus message composer").await;
    desktop.target_after(previous).await;
    desktop.type_text("PLAN_FIRST_MESSAGE").await;
    desktop.key("enter", false);
    let planning = desktop.request(&mut fixture).await;
    let tools = tool_names(&planning);
    assert!(tools.iter().any(|name| name == "SubmitPlan"), "{tools:?}");
    planning
        .tool_call(
            "SubmitPlan",
            json!({"title":"PLAN_TITLE","steps":[{"id":"one","title":"PLAN_STEP","description":"PLAN_STEP_DETAIL"}]}),
        )
        .await;
    // The submitted proposal opens for approval without a click.
    desktop.press("Approve and execute").await;
    let running = desktop.request(&mut fixture).await;
    let tools = tool_names(&running);
    assert!(tools.iter().any(|name| name == "update_plan"), "{tools:?}");
    assert!(!tools.iter().any(|name| name == "SubmitPlan"), "{tools:?}");
    assert!(running.body.to_string().contains("PLAN_STEP_DETAIL"));
    running
        .tool_call(
            "update_plan",
            json!({"steps":[{"id":"one","status":"completed"}]}),
        )
        .await;
    desktop.request(&mut fixture).await.finish().await;
    let session = desktop
        .sessions()
        .await
        .into_iter()
        .find(|session| session["id"] != fixture.session)
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    desktop
        .wait("the approved plan did not complete", async {
            loop {
                let plan = desktop
                    .client
                    .query("agent", "plan", json!({"sessionId":session}))
                    .await
                    .unwrap();
                if plan["current"]["execution"]["phase"] == "completed" {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await;
    // Approving runs the Plan without leaving planning mode.
    let observed = desktop
        .client
        .query("agent", "observe", json!({"sessionId":session}))
        .await
        .unwrap();
    assert_eq!(observed["session"]["collaborationMode"], "plan");
    desktop.close().await;
    fixture.finish().await;
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
    desktop.key("enter", false);
    let mut reply = desktop.request(&mut fixture).await;
    desktop.control("Pause response").await;
    let closing = tokio::spawn({
        let store = fixture.store.clone();
        async move { store.shutdown().await }
    });
    reply.delta("Wake the original source watcher.").await;
    desktop.control("Details").await;
    desktop.control("Retry").await;
    assert!(desktop.controls("Pause response").is_empty());
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
            for pixel in frame.pixels().chunks_exact(4) {
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
    assert!(desktop.controls("Pause response").is_empty());
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
async fn desktop_unknown_control_can_be_dismissed_and_feedback_expires() {
    let fixture = images_fixture().await;
    let (path, _) = image_file(&fixture);
    let client = fixture.client().await;
    let before = client
        .query("agent", "observe", json!({"sessionId":fixture.session}))
        .await
        .unwrap();
    let id = Uuid::new_v4();
    let mutation = client
        .control(
            id,
            "metadata",
            json!({
                "sessionId":fixture.session, "expectedRevision":before["session"]["revision"],
                "title":"THIS_RENAME_MUST_NOT_RUN", "labels":[]
            }),
        )
        .await
        .unwrap();
    let original = mutation.prepare().await.unwrap();
    let create = ReplyGate::create(fixture.directory.path(), fixture.address.clone());
    let (theme, appearance, layout, width, height) = visual_case();
    let desktop = Desktop::open_at(
        &fixture,
        &create.address,
        size(gpui::DevicePixels(width), gpui::DevicePixels(height)),
        appearance,
    )
    .await;
    desktop.type_text("DRAFT_KEPT_AFTER_DISMISSAL").await;
    desktop.press("Check action status (1)").await;
    let dismiss = format!("Dismiss action notice {}", &id.to_string()[..8]);
    desktop.control(&dismiss).await;
    assert!(
        desktop.controls("Dismiss action feedback").is_empty(),
        "an unknown result must not show success feedback"
    );
    if let Some(directory) = std::env::var_os("MAKA_UI_ARTIFACT_DIR") {
        let directory = std::path::PathBuf::from(directory);
        std::fs::create_dir_all(&directory).unwrap();
        let guard = desktop.frame.lock().unwrap();
        let frame = guard.as_ref().unwrap();
        assert_eq!(
            frame.size(),
            size(gpui::DevicePixels(width), gpui::DevicePixels(height))
        );
        let mut ppm = format!("P6\n{} {}\n255\n", width, height).into_bytes();
        for pixel in frame.pixels().chunks_exact(4) {
            ppm.extend_from_slice(&pixel[..3]);
        }
        std::fs::write(
            directory.join(format!("unconfirmed-action-{theme}-{layout}.ppm")),
            ppm,
        )
        .unwrap();
    }
    desktop.press(&dismiss).await;
    desktop.control("Dismiss action feedback").await;
    assert!(desktop.controls("Check action status (1)").is_empty());
    desktop
        .until("completed action feedback did not expire", || {
            desktop
                .controls("Dismiss action feedback")
                .is_empty()
                .then_some(())
        })
        .await;
    let retained = client.operation_for_control(id).await.unwrap();
    assert_eq!(retained.reference, original.reference);
    assert!(retained.receipt.is_none());
    assert!(!retained.abandoned);
    let after = client
        .query("agent", "observe", json!({"sessionId":fixture.session}))
        .await
        .unwrap();
    assert_eq!(after["session"]["title"], before["session"]["title"]);
    desktop.expect_text("DRAFT_KEPT_AFTER_DISMISSAL").await;
    mutation.close().await.unwrap();
    desktop.new_draft().await;
    desktop.attach(&path).await;
    desktop
        .type_text("NEW_SESSION_DRAFT_KEPT_AFTER_DISMISSAL")
        .await;
    create.arm();
    desktop.key("enter", false);
    desktop.held(&create).await;
    create.discard_reply();
    desktop.control("Check action status (1)").await;
    let controls = desktop.client.pending_controls().await.unwrap();
    assert_eq!(controls.len(), 1);
    assert_eq!(controls[0].method, "create");
    let dismiss = format!("Dismiss action notice {}", &controls[0].id.to_string()[..8]);
    desktop.press(&dismiss).await;
    desktop.control("Send message").await;
    desktop
        .expect_text("NEW_SESSION_DRAFT_KEPT_AFTER_DISMISSAL")
        .await;
    assert!(desktop.controls("Check action status (1)").is_empty());
    desktop.control("Remove attachment selected.png").await;
    assert_eq!(
        fixture.request_count.load(Ordering::SeqCst),
        0,
        "neither checking nor dismissing may send the preserved draft"
    );
    client.close().await.unwrap();
    desktop.close().await;
    drop(create);
    fixture.finish().await;
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
        Some((source, "en")),
    )
    .await;
    desktop.press("Edit connection ChatGPT Subscription").await;
    let reload = desktop.control("Reload connection").await;
    let delete = desktop.control("Delete connection").await;
    assert_eq!(
        reload.center().y,
        delete.center().y,
        "connection actions must share one baseline"
    );
    assert!(reload.bottom() <= px(height as f32) && reload.bottom() > px(height as f32 - 128.0));
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
    desktop.control("Manage models").await;
    {
        let outcome = desktop.outcome.lock().unwrap();
        assert_eq!(
            outcome["signIns"], 1,
            "retrying discovery must not repeat provider sign-in"
        );
        assert_eq!(outcome["discoveries"], 2);
    }
    desktop.artifact(&format!("connection-ready-{theme}-{layout}"));
    desktop.press("Manage models").await;
    desktop.control("Edit model gpt-4.1").await;
    desktop.press("Set default gpt-4.1").await;
    desktop
        .until("the selected default was not saved", || {
            (desktop.outcome.lock().unwrap()["defaultTarget"]["modelId"] == "gpt-4.1").then_some(())
        })
        .await;
    desktop.control("Set default gpt-4.1").await;
    desktop.artifact(&format!("connection-models-{theme}-{layout}"));
    desktop.press("Edit model gpt-4.1").await;
    let associate = desktop.control("Associate catalog model").await;
    desktop.artifact(&format!("connection-model-editor-{theme}-{layout}"));
    desktop.press("Associate catalog model").await;
    desktop.control("openai / gpt-4.1").await;
    desktop.artifact(&format!("connection-model-catalog-{theme}-{layout}"));
    desktop.press("openai / gpt-4.1").await;
    let save = desktop.control("Save model").await;
    assert_eq!(
        associate.right(),
        save.right(),
        "model controls must share the reading edge"
    );
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
        Some((source, "en")),
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
    assert!(desktop.controls("Connect Alibaba (China)").is_empty());
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
async fn desktop_settings_translate_subscription_sign_in_and_provider_search() {
    let traditional = std::env::var("MAKA_UI_LOCALE").as_deref() == Ok("zh-TW");
    let (locale, edit, sign_in, copy, cancel, add, search, connect, compatibility) = if traditional
    {
        (
            "zh-TW",
            "編輯連線 ChatGPT Subscription",
            "使用 ChatGPT 登入",
            "複製登入代碼",
            "取消供應商登入",
            "新增連線",
            "訂閱",
            "連線至 ChatGPT 訂閱",
            "連線至 Responses 相容介面",
        )
    } else {
        (
            "zh-CN",
            "编辑连接 ChatGPT Subscription",
            "使用 ChatGPT 登录",
            "复制登录代码",
            "取消提供商登录",
            "添加连接",
            "订阅",
            "连接 ChatGPT 订阅",
            "连接 Responses 兼容接口",
        )
    };
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
        Some((source, locale)),
    )
    .await;
    desktop.press(edit).await;
    desktop.control(sign_in).await;
    desktop.artifact(&format!("connection-localized-{locale}-{theme}-{layout}"));
    desktop.press(sign_in).await;
    desktop.control(copy).await;
    desktop.artifact(&format!("sign-in-localized-{locale}-{theme}-{layout}"));
    desktop.press(cancel).await;
    desktop.control(sign_in).await;
    desktop.press("返回").await;
    desktop.press(add).await;
    desktop.target_after(None).await;
    desktop.type_text(search).await;
    desktop.control(connect).await;
    desktop.artifact(&format!("provider-localized-{locale}-{theme}-{layout}"));
    desktop
        .type_text(if traditional {
            "相容介面"
        } else {
            "兼容接口"
        })
        .await;
    desktop.control(compatibility).await;
    desktop.close().await;
    fixture.finish().await;
}
