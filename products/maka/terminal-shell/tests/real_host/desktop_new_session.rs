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
use nsh_gpui_terminal::TerminalPlatform;
use nsh_platform_gpui::{AppOptions, AppView};
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    future::Future,
    path::Path,
    rc::Rc,
    sync::{Arc, atomic::Ordering},
    time::Duration,
};
use tokio::sync::{Notify, watch};
use uuid::Uuid;

const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMQNE5uAAACKAEoAfdvjgAAAABJRU5ErkJggg==";

struct Desktop {
    platform: Rc<TerminalPlatform>,
    app: ApplicationHandle,
    window: WindowHandle<AppView>,
    client: Client,
    bindings: Bindings,
    _foreground: watch::Sender<bool>,
    wake: Arc<Notify>,
    errors: Rc<RefCell<Option<String>>>,
}

impl Desktop {
    async fn open(fixture: &Fixture, address: &Path) -> Self {
        let client = fixture.client_at(address).await;
        let bindings = Bindings::new(client.clone(), tokio::runtime::Handle::current());
        let mut config = maka_workbench::configuration(
            bindings.registry(Some(fixture.session.clone())),
            tokio::runtime::Handle::current(),
        );
        config.assets = Some(bindings.assets());
        config.chunk_loader = Some(bindings.chunk_loader());
        let (foreground, receiver) = watch::channel(true);
        config.context = config
            .context
            .with(bindings.reload())
            .with(maka_workbench::Foreground(receiver));
        let wake = Arc::new(Notify::new());
        let notification = wake.clone();
        let platform = TerminalPlatform::new(
            Box::new(gpui_wgpu::WgpuHeadlessRenderer::new().unwrap()),
            Box::new(|frame| {
                std::thread::spawn(move || frame.submit()?.complete())
                    .join()
                    .unwrap()
                    .unwrap();
            }),
            Arc::new(move || notification.notify_one()),
        )
        .unwrap();
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
                            size(px(960.0), px(640.0)),
                        ))),
                        inactive_frame_interval: None,
                        ..Default::default()
                    },
                    move |window, cx| {
                        cx.new(|cx| {
                            let view = AppView::new(
                                AppOptions {
                                    terminal_keyboard: true,
                                    ..Default::default()
                                },
                                window,
                                cx,
                            );
                            view.on_error(move |message| {
                                *failed.borrow_mut() = Some(message.to_owned())
                            });
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
            app,
            window,
            client,
            bindings,
            _foreground: foreground,
            wake,
            errors,
        };
        desktop.target_after(None).await;
        desktop
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
        .unwrap_or_else(|_| panic!("{stage}"))
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
        .unwrap_or_else(|_| panic!("{stage}"))
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

    /// Clicks the one control labelled `label` once the window shows it.
    async fn press(&self, label: &str) {
        let bounds = self
            .until(&format!("no single control labelled {label}"), || {
                let found = self.controls(label);
                (found.len() == 1).then(|| found[0])
            })
            .await;
        self.press_at(bounds.center());
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
