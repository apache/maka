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

use super::support::{Fixture, ReplyGate};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use gpui::{
    AppContext, Application, Bounds, Focusable, Keystroke, Modifiers, PlatformInput, WindowBounds,
    WindowOptions, point, px, size,
};
use nsh_gpui_terminal::TerminalPlatform;
use nsh_platform_gpui::{AppOptions, AppView};
use serde_json::json;
use std::{
    cell::{Cell, RefCell},
    rc::Rc,
    sync::{Arc, atomic::Ordering},
    time::Duration,
};

fn key(platform: &TerminalPlatform, name: &str, control: bool) {
    let keystroke = Keystroke {
        key: name.into(),
        key_char: None,
        modifiers: Modifiers {
            control,
            ..Default::default()
        },
    };
    platform
        .dispatch_input(PlatformInput::KeyDown(gpui::KeyDownEvent {
            keystroke: keystroke.clone(),
            is_held: false,
            prefer_character_input: false,
        }))
        .unwrap();
    platform
        .dispatch_input(PlatformInput::KeyUp(gpui::KeyUpEvent { keystroke }))
        .unwrap();
}

async fn assert_input(platform: &TerminalPlatform, expected: &str) {
    let _ = platform.take_clipboard_write();
    key(platform, "a", true);
    key(platform, "c", true);
    let text = tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            platform.pump();
            if let Some(text) = platform.take_clipboard_write().and_then(|item| item.text()) {
                break text;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("the editor did not copy its contents");
    assert_eq!(text, expected);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn desktop_creates_the_session_only_when_the_first_message_is_sent() {
    let mut fixture = Fixture::images().await;
    let bytes = STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMQNE5uAAACKAEoAfdvjgAAAABJRU5ErkJggg==").unwrap();
    let attachment = fixture.directory.path().join("first-send.png");
    std::fs::write(&attachment, &bytes).unwrap();
    let gate = ReplyGate::create(fixture.directory.path(), fixture.address.clone());
    let client = fixture.client_at(&gate.address).await;
    let bindings =
        maka_workbench::bindings::Bindings::new(client.clone(), tokio::runtime::Handle::current());
    let registry = bindings.registry(Some(fixture.session.clone()));
    let mut config = maka_workbench::configuration(registry, tokio::runtime::Handle::current());
    config.assets = Some(bindings.assets());
    config.chunk_loader = Some(bindings.chunk_loader());
    let (_foreground, foreground) = tokio::sync::watch::channel(true);
    config.context = config
        .context
        .with(bindings.reload())
        .with(maka_workbench::Foreground(foreground));

    let frames = Rc::new(Cell::new(0));
    let rendered = frames.clone();
    let platform = TerminalPlatform::new(
        Box::new(gpui_wgpu::WgpuHeadlessRenderer::new().unwrap()),
        Box::new(move |frame| {
            std::thread::spawn(move || frame.submit()?.complete())
                .join()
                .unwrap()
                .unwrap();
            rendered.set(rendered.get() + 1);
        }),
        Arc::new(|| {}),
    )
    .unwrap();
    let errors = Rc::new(RefCell::new(None));
    let failed = errors.clone();
    let window = Rc::new(RefCell::new(None));
    let opened = window.clone();
    let app = Application::with_platform(platform.clone()).run_embedded(move |cx| {
        *opened.borrow_mut() = Some(
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
    let original = tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            platform.pump();
            assert!(errors.borrow().is_none(), "UI error: {:?}", errors.borrow());
            if let Some(target) = platform.text_input_target() {
                break target;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("existing composer did not receive focus");
    key(&platform, "n", true);
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            platform.pump();
            assert!(errors.borrow().is_none(), "UI error: {:?}", errors.borrow());
            if platform
                .text_input_target()
                .is_some_and(|target| target != original)
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("new conversation did not open its local composer");
    let list = client
        .query(
            "agent",
            "list",
            json!({"filter":"all","position":{"kind":"start"}}),
        )
        .await
        .unwrap();
    assert_eq!(
        list["sessions"].as_array().unwrap().len(),
        1,
        "opening a new conversation persisted a session"
    );

    key(&platform, "n", true);
    let previous_frame = frames.get();
    platform.paste("/new").unwrap();
    tokio::time::timeout(Duration::from_secs(20), async {
        while frames.get() == previous_frame {
            platform.pump();
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("the command was not rendered");
    assert_input(&platform, "/new").await;
    let previous_frame = frames.get();
    key(&platform, "enter", false);
    tokio::time::timeout(Duration::from_secs(20), async {
        while frames.get() == previous_frame {
            platform.pump();
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("the command did not finish");
    let composer = platform.text_input_target().unwrap();
    key(&platform, "u", true);
    let picker = tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            platform.pump();
            if let Some(target) = platform.text_input_target()
                && target != composer
            {
                break target;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("attachment picker did not open");
    let previous_frame = frames.get();
    platform.paste(attachment.to_str().unwrap()).unwrap();
    tokio::time::timeout(Duration::from_secs(20), async {
        while frames.get() == previous_frame {
            platform.pump();
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("attachment path was not rendered");
    assert_input(&platform, attachment.to_str().unwrap()).await;
    key(&platform, "enter", false);
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            platform.pump();
            if platform
                .text_input_target()
                .is_some_and(|target| target != picker)
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("attachment was not staged");
    std::fs::write(&attachment, b"changed after selection").unwrap();
    let list = client
        .query(
            "agent",
            "list",
            json!({"filter":"all","position":{"kind":"start"}}),
        )
        .await
        .unwrap();
    assert_eq!(
        list["sessions"].as_array().unwrap().len(),
        1,
        "selecting an attachment persisted a session"
    );
    let previous_frame = frames.get();
    platform.paste("FIRST_DESKTOP_MESSAGE").unwrap();
    tokio::time::timeout(Duration::from_secs(20), async {
        while frames.get() == previous_frame {
            platform.pump();
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("the typed draft was not rendered");
    assert_input(&platform, "FIRST_DESKTOP_MESSAGE").await;
    gate.arm();
    key(&platform, "enter", false);
    tokio::time::timeout(Duration::from_secs(20), async {
        let held = gate.held.notified();
        tokio::pin!(held);
        loop {
            platform.pump();
            tokio::select! {
                () = &mut held => break,
                () = tokio::time::sleep(Duration::from_millis(5)) => {}
            }
        }
    })
    .await
    .expect("the original create receipt was not held");
    key(&platform, "enter", false);
    gate.release();
    let request = tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            platform.pump();
            assert!(errors.borrow().is_none(), "UI error: {:?}", errors.borrow());
            if let Ok(request) = fixture.requests.try_recv() {
                break request;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await;
    let request = match request {
        Ok(request) => request,
        Err(_) => {
            let catalog = client
                .query(
                    "agent",
                    "list",
                    json!({"filter":"all","position":{"kind":"start"}}),
                )
                .await
                .unwrap();
            panic!("the first message was not sent; catalog: {catalog}");
        }
    };
    assert!(request.body.to_string().contains("FIRST_DESKTOP_MESSAGE"));
    let image_url = request.body["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|message| message["role"] == "user")
        .filter_map(|message| message["content"].as_array())
        .flatten()
        .find(|part| part["type"] == "image_url")
        .and_then(|part| part["image_url"]["url"].as_str())
        .expect("the staged image was not sent");
    assert_eq!(
        STANDARD
            .decode(image_url.strip_prefix("data:image/png;base64,").unwrap())
            .unwrap(),
        bytes
    );
    let list = client
        .query(
            "agent",
            "list",
            json!({"filter":"all","position":{"kind":"start"}}),
        )
        .await
        .unwrap();
    assert_eq!(
        list["sessions"].as_array().unwrap().len(),
        2,
        "first send must create exactly one session"
    );
    let session_id = list["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|session| session["id"] != fixture.session)
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    request.finish().await;
    fixture.idle(&client, &session_id).await;
    let observed = client
        .query("agent", "observe", json!({"sessionId":session_id}))
        .await
        .unwrap();
    let history = client.query("agent", "history", json!({"sessionId":session_id,"through":observed["through"],"position":{"kind":"tail"},"view":"conversation"})).await.unwrap();
    let messages: Vec<_> = history["chunks"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|row| row["role"] == "user" && row["text"] == "FIRST_DESKTOP_MESSAGE")
        .collect();
    assert_eq!(messages.len(), 1, "the first message must be recorded once");
    assert_eq!(messages[0]["attachments"].as_array().unwrap().len(), 1);
    assert_eq!(fixture.request_count.load(Ordering::SeqCst), 1);
    app.update(|cx| {
        window
            .borrow()
            .as_ref()
            .unwrap()
            .update(cx, |view, _, _| view.stop())
            .unwrap();
    });
    bindings.close().await.unwrap();
    fixture.finish().await;
}
