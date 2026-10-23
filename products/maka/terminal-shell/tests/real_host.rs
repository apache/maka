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

#[path = "real_host/attachment_draft.rs"]
mod attachment_draft;
#[path = "real_host/attachment_intake.rs"]
mod attachment_intake;
#[path = "real_host/attachments.rs"]
mod attachments;
#[path = "real_host/final_actions.rs"]
mod final_actions;
#[path = "real_host/interactions.rs"]
mod interactions;
#[path = "real_host/keyboard.rs"]
mod keyboard;
#[path = "real_host/markdown_links.rs"]
mod markdown_links;
#[path = "real_host/mcp.rs"]
mod mcp;
#[path = "real_host/oauth.rs"]
mod oauth;
#[path = "real_host/plugin_settings.rs"]
mod plugin_settings;
#[path = "real_host/queue.rs"]
mod queue;
#[path = "real_host/request_metrics.rs"]
mod request_metrics;
#[path = "real_host/session_lifecycle.rs"]
mod session_lifecycle;
mod support;
#[cfg(unix)]
#[path = "real_host/terminal_workbench.rs"]
mod terminal_workbench;
#[path = "real_host/tool_cards.rs"]
mod tool_cards;

use crossterm::event::{
    Event, KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
};
use maka_plugin_core::operation::{OperationOutcome, Receipt};
use nsh_platform_tui::{AccessibleNode, AppView};
use serde_json::{Value, json};
#[cfg(unix)]
use std::time::Instant;
use std::{sync::atomic::Ordering, time::Duration};
use support::{EDITOR, Fixture, ReplyGate, evidence, wait_view, wait_view_state};
use uuid::Uuid;

fn shortcut(view: &mut AppView, key: char) {
    view.handle_event(Event::Key(KeyEvent::new(
        KeyCode::Char(key),
        KeyModifiers::CONTROL,
    )));
}

async fn wait_enabled_node(view: &mut AppView, label: &str) {
    // Model policy loads asynchronously. A visible disabled button accepts
    // neither keyboard nor pointer activation until its metadata arrives.
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            support::tick(view);
            if view
                .accessibility_snapshot()
                .iter()
                .any(|node| node.label == label && !node.state.disabled)
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap_or_else(|_| {
        let matching: Vec<_> = view
            .accessibility_snapshot()
            .into_iter()
            .filter(|node| node.label.contains(label))
            .collect();
        panic!(
            "the native target {label:?} did not become enabled; app error: {:?}; containing AX nodes: {matching:#?}\n{}",
            view.last_error(),
            view.snapshot()
        )
    });
}

async fn tab_to_label(view: &mut AppView, label: &str) {
    wait_enabled_node(view, label).await;
    for _ in 0..=view.accessibility_snapshot().len() {
        if view
            .accessibility_snapshot()
            .iter()
            .any(|node| node.focused && node.label == label)
        {
            return;
        }
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE)));
    }
    panic!("native Tab did not reach {label:?}");
}

fn model_menu_button(view: &AppView, label: &str) -> Option<nsh_platform_tui::AccessibleNode> {
    let viewport = view.surface().viewport();
    view.accessibility_snapshot().into_iter().find(|node| {
        let frame = node.frame;
        node.role == nsh_core::AccessibilityRole::Button
            && node.label == label
            && frame.size.width.0 > 0.0
            && frame.size.height.0 > 0.0
            && frame.origin.x.0 < viewport.width.0
            && frame.origin.y.0 < viewport.height.0
            && frame.origin.x.0 + frame.size.width.0 > 0.0
            && frame.origin.y.0 + frame.size.height.0 > 0.0
    })
}

fn model_menu_ready(view: &AppView, label: &str) -> bool {
    let viewport = view.surface().viewport();
    model_menu_button(view, label).is_some_and(|node| {
        let frame = node.frame;
        !node.state.disabled
            && frame.origin.x.0 >= 0.0
            && frame.origin.y.0 >= 0.0
            && frame.origin.x.0 + frame.size.width.0 <= viewport.width.0
            && frame.origin.y.0 + frame.size.height.0 <= viewport.height.0
    })
}

fn model_menu_closed(view: &AppView) -> bool {
    // The resident model trigger also exists while open. Only the menu's
    // actual close/back controls establish whether its content has gone away.
    model_menu_button(view, "Close model selection").is_none()
        && model_menu_button(view, "Back to model settings").is_none()
}

fn model_trigger_caption(view: &AppView, model: &str, effort: &str) -> bool {
    let Some(trigger) = model_menu_button(view, "Choose model and effort") else {
        return false;
    };
    let nodes = view.accessibility_snapshot();
    [model, &format!(" · {effort}")].iter().all(|label| {
        nodes.iter().any(|node| {
            node.label == *label
                && node.frame.size.width.0 > 0.0
                && node.frame.size.height.0 > 0.0
                && node.frame.origin.x.0 >= trigger.frame.origin.x.0
                && node.frame.origin.y.0 >= trigger.frame.origin.y.0
                && node.frame.origin.x.0 + node.frame.size.width.0
                    <= trigger.frame.origin.x.0 + trigger.frame.size.width.0
                && node.frame.origin.y.0 + node.frame.size.height.0
                    <= trigger.frame.origin.y.0 + trigger.frame.size.height.0
        })
    })
}

fn assert_effort_choices(view: &AppView, choice: &Value, selected: Option<&str>) {
    let nodes = view.accessibility_snapshot();
    let mut advertised = choice["thinkingLevels"]
        .as_array()
        .unwrap()
        .iter()
        .map(|level| level.as_str().unwrap())
        .collect::<Vec<_>>();
    let mut rendered = nodes
        .iter()
        .filter_map(|node| node.label.strip_prefix("Use effort "))
        .collect::<Vec<_>>();
    advertised.sort_unstable();
    rendered.sort_unstable();
    assert_eq!(
        rendered, advertised,
        "efforts must come from this model's metadata"
    );
    assert!(
        !nodes
            .iter()
            .any(|node| node.label == "Use connection default"),
        "connection inheritance must not appear as another reasoning effort",
    );
    let effective = selected.or_else(|| choice["defaultThinkingLevel"].as_str());
    for level in advertised {
        assert_eq!(
            nodes
                .iter()
                .find(|node| node.label == format!("Use effort {level}"))
                .unwrap()
                .state
                .selected,
            effective == Some(level),
            "the effective reasoning effort must select {level}",
        );
    }
}

async fn wait_focused_input(view: &mut AppView, label: &str) {
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            support::tick(view);
            if view.surface().input_context().is_some_and(|input| {
                view.accessibility_snapshot()
                    .iter()
                    .any(|node| node.id == input.node && node.focused && node.label == label)
            }) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("the native Input {label:?} did not receive focus"));
}

async fn wait_editable_composer(view: &mut AppView) {
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            view.poll().unwrap();
            support::tick(view);
            if let Some(input) = view.surface().input_context()
                && input.editable
                && view.accessibility_snapshot().iter().any(|node| {
                    node.id == input.node && node.focused && node.label == "Message composer"
                })
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("the original native message composer did not become editable and focused");
}

fn selected_command<'a>(nodes: &'a [AccessibleNode], title: &str) -> Option<&'a AccessibleNode> {
    nodes.iter().find(|button| {
        button.role == nsh_core::AccessibilityRole::Button
            && !button.state.disabled
            && button.state.selected
            && nodes.iter().any(|text| {
                text.label == title
                    && text.frame.origin.x.0 >= button.frame.origin.x.0
                    && text.frame.origin.y.0 >= button.frame.origin.y.0
                    && text.frame.origin.x.0 < button.frame.origin.x.0 + button.frame.size.width.0
                    && text.frame.origin.y.0 < button.frame.origin.y.0 + button.frame.size.height.0
            })
    })
}

async fn select_palette(view: &mut AppView, placeholder: &str, search: &str, choice: &str) {
    let input_label = match placeholder {
        "Search models…" => "Search models",
        "Search workspaces…" => "Search workspace folders",
        "Search sessions…" => "Search session titles",
        "Search commands…" => "Search commands",
        _ => panic!("unknown native search field {placeholder:?}"),
    };
    wait_focused_input(view, input_label).await;
    view.handle_event(Event::Paste(search.into()));
    assert_eq!(
        view.surface().input_context().unwrap().text.as_deref(),
        Some(search)
    );
    // The native field updates before its queued JS change handler. Commit
    // that handler so an old matching row cannot admit Enter for a new query.
    let (done, committed) = tokio::sync::oneshot::channel();
    view.control()
        .expect("the native app engine must be running")
        .advance_clock(Duration::ZERO, move || {
            let _ = done.send(());
        });
    tokio::time::timeout(Duration::from_secs(20), committed)
        .await
        .expect("the search input change did not commit")
        .expect("the search engine stopped");
    wait_view(view, |screen| {
        !screen.contains("Loading…") && !screen.contains("Loading folders…")
    })
    .await;
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            view.poll().unwrap();
            support::tick(view);
            let nodes = view.accessibility_snapshot();
            let mut first = nodes.iter().filter(|node| {
                node.role == nsh_core::AccessibilityRole::Button && !node.state.disabled
            });
            let ready = match placeholder {
                // The saved model/session is distinct from keyboard selection.
                // Both search owners reset their keyboard index to the first result.
                "Search models…" => first
                    .find(|node| node.label.starts_with("Use "))
                    .is_some_and(|node| node.label.starts_with(&format!("Use {choice} · "))),
                "Search sessions…" => first
                    .find(|node| node.label.starts_with("Open conversation "))
                    .is_some_and(|node| node.label == format!("Open conversation {choice}")),
                "Search workspaces…" => first.any(|node| {
                    node.label == format!("Browse folder {choice}") && node.state.selected
                }),
                "Search commands…" => selected_command(&nodes, choice).is_some(),
                _ => unreachable!(),
            };
            if ready {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("the native search did not select its enabled target {choice:?}"));
    view.handle_event(Event::Key(KeyEvent::new(
        KeyCode::Enter,
        KeyModifiers::NONE,
    )));
}

async fn open_workspace_picker(view: &mut AppView) {
    shortcut(view, 'p');
    select_palette(
        view,
        "Search commands…",
        "Choose workspace",
        "Choose workspace",
    )
    .await;
    wait_focused_input(view, "Search workspace folders").await;
}

async fn browse_workspace_folder(view: &mut AppView, name: &str) {
    select_palette(view, "Search workspaces…", name, name).await;
    let folder = format!("Folder · {name}");
    wait_view(view, |screen| {
        screen.contains(&folder) && !screen.contains("Loading folders…")
    })
    .await;
    wait_enabled_node(view, "Use this workspace folder").await;
    wait_focused_input(view, "Search workspace folders").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn empty_settings_configure_a_real_connection_and_manual_reasoning_model_before_one_send() {
    async fn editable(view: &mut AppView, label: &str) {
        tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                support::tick(view);
                if view
                    .surface()
                    .input_context()
                    .is_some_and(|input| input.editable)
                    && view
                        .accessibility_snapshot()
                        .iter()
                        .any(|node| node.focused && node.label == label)
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("the native Input {label:?} did not become editable"));
    }
    async fn activate(view: &mut AppView, label: &str) {
        // A keyboard target may be below the scroll viewport. Wait for the
        // actual Button owner, then let native Tab reveal it before Enter.
        tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                view.poll().unwrap();
                support::tick(view);
                let mut buttons = view.accessibility_snapshot().into_iter().filter(|node| {
                    node.role == nsh_core::AccessibilityRole::Button && node.label == label
                });
                let button = buttons.next();
                assert!(
                    buttons.next().is_none(),
                    "ambiguous native button {label:?}"
                );
                if button.is_some_and(|button| !button.state.disabled) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("native keyboard button {label:?} did not become enabled"));
        tab_to_label(view, label).await;
        let button = support::wait_enabled_button(view, label).await;
        assert!(
            button.focused,
            "native Tab did not focus the actual button {label:?}"
        );
        view.handle_event(Event::Key(KeyEvent::new(
            KeyCode::Enter,
            KeyModifiers::NONE,
        )));
        commit_native_events(view).await;
    }
    async fn commit_native_events(view: &mut AppView) {
        // Commit native callbacks before the next interaction uses their view.
        let (done, committed) = tokio::sync::oneshot::channel();
        view.control()
            .unwrap()
            .advance_clock(Duration::ZERO, move || {
                let _ = done.send(());
            });
        tokio::time::timeout(Duration::from_secs(20), committed)
            .await
            .unwrap()
            .unwrap();
    }
    async fn fill(view: &mut AppView, label: &str, value: &str) {
        tab_to_label(view, label).await;
        editable(view, label).await;
        shortcut(view, 'a');
        view.handle_event(Event::Paste(value.into()));
        commit_native_events(view).await;
    }
    async fn assert_input(view: &mut AppView, label: &str, value: &str) {
        tab_to_label(view, label).await;
        wait_focused_input(view, label).await;
        assert_eq!(
            view.surface().input_context().unwrap().text.as_deref(),
            Some(value),
            "the native {label:?} draft changed"
        );
    }
    async fn assert_document_viewport(
        view: &mut AppView,
        label: &str,
        save_label: &str,
        first_line: &str,
    ) {
        wait_focused_input(view, label).await;
        let input_id = view.surface().focused().unwrap();
        let save_id = view
            .accessibility_snapshot()
            .into_iter()
            .find(|node| {
                node.role == nsh_core::AccessibilityRole::Button && node.label == save_label
            })
            .unwrap()
            .id;
        let node = |view: &AppView, id| {
            view.accessibility_snapshot()
                .into_iter()
                .find(|node| node.id == id)
                .unwrap()
        };
        let input = node(view, input_id).frame;
        let save = node(view, save_id).frame;
        assert!(
            input.size.height.0 > view.surface().viewport().height.0 / 2.0,
            "the document editor must use the free settings space instead of a small fixed box: input {input:?}, save {save:?}, viewport {:?}",
            view.surface().viewport()
        );
        assert!(save.origin.y.0 >= input.origin.y.0 + input.size.height.0);
        assert!(
            save.origin.y.0 + save.size.height.0 <= view.surface().viewport().height.0,
            "document actions must remain visible while its text scrolls"
        );
        view.handle_event(Event::Key(KeyEvent::new(
            KeyCode::Home,
            KeyModifiers::CONTROL,
        )));
        commit_native_events(view).await;
        wait_view(view, |screen| screen.contains(first_line)).await;
        view.handle_event(Event::Mouse(MouseEvent {
            kind: MouseEventKind::ScrollDown,
            column: ((save.origin.x.0 + save.size.width.0 / 2.0) / 8.0) as u16,
            row: ((save.origin.y.0 + save.size.height.0 / 2.0) / 16.0) as u16,
            modifiers: KeyModifiers::NONE,
        }));
        commit_native_events(view).await;
        support::tick(view);
        assert_eq!(
            node(view, input_id).frame,
            input,
            "an outer wheel moved the editor into blank space"
        );
        assert_eq!(
            node(view, save_id).frame,
            save,
            "an outer wheel scrolled away the actions"
        );
        assert!(view.snapshot().contains(first_line));
        support::scroll_text(view, first_line, MouseEventKind::ScrollDown);
        commit_native_events(view).await;
        wait_view(view, |screen| !screen.contains(first_line)).await;
        assert_eq!(node(view, input_id).frame, input);
        assert_eq!(node(view, save_id).frame, save);
    }
    tokio::time::timeout(Duration::from_secs(90), async {
        #[cfg(unix)]
        let mut fixture = Fixture::registered_empty_settings().await;
        #[cfg(not(unix))]
        let mut fixture = Fixture::empty_settings().await;
        let instruction_path = fixture.directory.path().join("assistant-home/.maka/AGENTS.md");
        std::fs::create_dir(instruction_path.parent().unwrap()).unwrap();
        let initial_instructions = "  INITIAL GLOBAL UTF-8 指令 🦀\r\n\r\n\tKeep user-owned whitespace.  \r\n\r\n";
        std::fs::write(&instruction_path, initial_instructions).unwrap();
        let client = fixture.client().await;
        let empty = client.query("settings", "connections", json!({"kind":"start"})).await.unwrap();
        assert_eq!(empty["kind"], "ready");
        assert_eq!(empty["connections"], json!([]));
        assert_eq!(empty["defaultTarget"], Value::Null);
        let sessions = client.query("agent", "list", json!({"filter":"all","position":{"kind":"start"}})).await.unwrap();
        assert_eq!(sessions["sessions"], json!([]));
        let (mut view, bindings) = fixture.view(client.clone(), None);
        wait_view(&mut view, |screen| screen.contains("Make something remarkable.")).await;
        support::click_button(&mut view, "Connections & models").await;
        wait_view(&mut view, |screen| screen.contains("Add your first connection, then fetch or add a model.")).await;
        activate(&mut view, "Add connection").await;
        wait_view(&mut view, |screen| screen.contains("Choose the API provider for this connection.") && !screen.contains("Loading settings…")).await;
        // Provider inventory uses the production virtual List. Wheel its real
        // painted rows until the OpenRouter provider is physically available.
        tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                support::tick(&mut view);
                let screen = view.snapshot();
                if screen.contains("OpenRouter") {
                    break;
                }
                let anchor = view.accessibility_snapshot().into_iter().find_map(|node| {
                    let label = node.label.strip_prefix("Connect ")?;
                    screen.lines().any(|line| line.contains(label)).then(|| label.to_owned())
                });
                if let Some(anchor) = anchor {
                    support::scroll_text(&mut view, &anchor, MouseEventKind::ScrollDown);
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        }).await.expect("the real provider inventory did not reveal OpenRouter");
        support::click_button(&mut view, "Connect OpenRouter").await;
        wait_view(&mut view, |screen| screen.contains("Connection settings") && screen.contains("Connection name")).await;
        fill(&mut view, "Connection name", "UI 连接").await;
        fill(&mut view, "Connection ID", "ui-connection").await;
        fill(&mut view, "Base URL", &fixture.base_url).await;
        fill(&mut view, "API key", support::PROVIDER_KEY).await;
        assert!(!view.snapshot().contains(support::PROVIDER_KEY), "the raw key was painted by the form");
        fill(&mut view, "Advanced request JSON", r#"{"provider":{"only":["openrouter","deepseek"]},"temperature":0.22}"#).await;
        activate(&mut view, "Save connection").await;
        wait_view(&mut view, |screen| screen.contains("Connection and API key saved.") && !screen.contains("Saving…")).await;
        // Saving the key advances the connection revision. Fetch immediately
        // through the same editor, without reopening or refreshing its basis.
        activate(&mut view, "Fetch models").await;
        wait_view(&mut view, |screen| screen.contains("Models fetched and enabled.") && screen.contains("Models · 1")).await;
        tokio::time::timeout(Duration::from_secs(20), async {
            while fixture.discovery_count.load(Ordering::SeqCst) != 1 {
                support::tick(&mut view);
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        }).await.expect("Fetch models did not perform exactly one real discovery request");
        assert_eq!(fixture.request_count.load(Ordering::SeqCst), 0);
        activate(&mut view, "Manage models").await;
        wait_view(&mut view, |screen| screen.contains("Connection models") && screen.contains("fixture-discovered-model")).await;
        let discovered = client.query("settings", "models", json!({"kind":"start","query":"fixture-discovered-model"})).await.unwrap();
        let discovered_choice = &discovered["choices"][0];
        assert_eq!(discovered_choice["thinkingLevels"], json!(["max","high","low","off"]));
        assert_eq!(discovered_choice["defaultThinkingLevel"], "high");
        activate(&mut view, "Edit model fixture-discovered-model").await;
        tab_to_label(&mut view, "Support effort high").await;
        wait_view(&mut view, |screen| screen.contains("Current saved reasoning efforts: max, high, low, off. Default: high.") && !screen.contains("Loading settings…")).await;
        let node = support::wait_enabled_button(&mut view, "Support effort high").await;
        assert!(node.state.selected, "provider-discovered efforts must be visible without an override");
        for label in ["Code Mode: Model default", "Apply Patch: Model default", "Code Mode language: JavaScript"] {
            tab_to_label(&mut view, label).await;
            assert!(support::wait_enabled_button(&mut view, label).await.state.selected, "omitted tool overrides must retain model defaults");
        }
        activate(&mut view, "Back from connection settings").await;
        wait_view(&mut view, |screen| screen.contains("Connection models")).await;
        activate(&mut view, "Add model manually").await;
        wait_view(&mut view, |screen| screen.contains("Model settings") && screen.contains("Model ID")).await;
        fill(&mut view, "Model ID", "manual-ui-agent").await;
        fill(&mut view, "Model display name", "Manual UI Agent").await;
        activate(&mut view, "Code Mode: Enabled").await;
        activate(&mut view, "Apply Patch: Disabled").await;
        activate(&mut view, "Code Mode language: Python").await;
        activate(&mut view, "Support effort high").await;
        activate(&mut view, "Default effort high").await;
        activate(&mut view, "Save model").await;
        wait_view(&mut view, |screen| screen.contains("Connection models") && screen.contains("Model saved.") && screen.contains("Manual UI Agent")).await;
        activate(&mut view, "Set default manual-ui-agent").await;
        wait_view(&mut view, |screen| screen.contains("Default model saved.")).await;
        let catalog = client.query("settings", "connections", json!({"kind":"start"})).await.unwrap();
        assert_eq!(catalog["connections"].as_array().unwrap().len(), 1);
        assert_eq!(catalog["connections"][0]["name"], "UI 连接");
        let basis = &catalog["connections"][0]["basis"];
        let target = json!({"connectionId":basis["connectionId"],"modelId":"manual-ui-agent"});
        assert_eq!(catalog["defaultTarget"], target);
        let detail = client.query("settings", "connection", json!({"connectionId":basis["connectionId"],"revision":basis["revision"],"includeEditingFacts":true})).await.unwrap();
        assert_eq!(detail["target"]["configuration"], json!({"baseUrl":fixture.base_url}));
        assert_eq!(detail["editing"], json!({"enabledModelIds":["fixture-discovered-model","manual-ui-agent"],"modelOverrides":{"manual-ui-agent":{"displayName":"Manual UI Agent","codeMode":true,"codeModeLanguage":"python","applyPatch":false,"thinkingLevels":["high"],"defaultThinkingLevel":"high"}},"requestBodyOverlay":{"provider":{"only":["openrouter","deepseek"]},"temperature":0.22}}));
        let models = client.query("settings", "models", json!({"kind":"start","query":"manual-ui-agent"})).await.unwrap();
        assert_eq!(models["choices"].as_array().unwrap().len(), 1);
        assert_eq!(models["choices"][0]["thinkingLevels"], json!(["high"]));
        assert_eq!(models["choices"][0]["defaultThinkingLevel"], "high");
        assert_eq!(models["defaultModel"]["kind"], "ready");
        assert_eq!(models["defaultModel"]["choice"]["selection"]["modelId"], "manual-ui-agent");
        activate(&mut view, "Back from connection settings").await;
        wait_view(&mut view, |screen| screen.contains("Connection settings") && screen.contains("Connection name")).await;
        activate(&mut view, "Back from connection settings").await;
        wait_view_state(&mut view, |view, screen| screen.contains("Connections & models") && screen.contains("Refresh connections") && view.accessibility_snapshot().iter().any(|node| node.role == nsh_core::AccessibilityRole::Button && node.label == "Close settings" && !node.state.disabled) && !view.accessibility_snapshot().iter().any(|node| node.role == nsh_core::AccessibilityRole::Button && node.label == "Back from connection settings")).await;
        activate(&mut view, "Close settings").await;
        wait_view_state(&mut view, |view, screen| screen.contains("Make something remarkable.") && !view.accessibility_snapshot().iter().any(|node| node.role == nsh_core::AccessibilityRole::Button && node.label == "Close settings")).await;
        support::click_button(&mut view, "Choose composer workspace").await;
        wait_view_state(&mut view, |view, screen| screen.contains("Workspace locations") && !screen.contains("Loading folders…") && view.accessibility_snapshot().iter().any(|node| node.role == nsh_core::AccessibilityRole::Button && node.label == "Browse folder Workspace" && !node.state.disabled)).await;
        support::click_button(&mut view, "Browse folder Workspace").await;
        wait_view(&mut view, |screen| screen.contains("Folder · Workspace") && !screen.contains("Loading folders…")).await;
        wait_enabled_node(&mut view, "Use this workspace folder").await;
        support::click_button(&mut view, "Use this workspace folder").await;
        wait_view(&mut view, |screen| screen.contains("Search models…") && !screen.contains("Loading…")).await;
        select_palette(&mut view, "Search models…", "fixture-discovered-model", "fixture-discovered-model").await;
        wait_view_state(&mut view, |view, screen| screen.contains("fixture-discovered-model · high") && model_menu_closed(view)).await;
        activate(&mut view, "Choose model and effort").await;
        activate(&mut view, "Choose reasoning effort").await;
        wait_view_state(&mut view, |view, _| model_menu_ready(view, "Use effort high") && model_menu_ready(view, "Back to model settings")).await;
        assert_effort_choices(&view, discovered_choice, None);
        activate(&mut view, "Back to model settings").await;
        activate(&mut view, "Choose model").await;
        wait_focused_input(&mut view, "Search models").await;
        select_palette(&mut view, "Search models…", "manual-ui-agent", "Manual UI Agent").await;
        wait_view_state(&mut view, |view, screen| screen.contains("Manual UI Agent · high") && model_menu_closed(view)).await;
        let sessions = client.query("agent", "list", json!({"filter":"all","position":{"kind":"start"}})).await.unwrap();
        assert_eq!(sessions["sessions"].as_array().unwrap().len(), 1);
        let session = sessions["sessions"][0]["id"].as_str().unwrap().to_owned();
        let observed = client.query("agent", "observe", json!({"sessionId":session})).await.unwrap();
        assert_eq!(observed["session"]["backend"], json!({"kind":"model","connectionId":basis["connectionId"],"modelId":"manual-ui-agent","thinkingLevel":null}));
        let saved_policy = client.query("settings", "resolveModel", target.clone()).await.unwrap();
        assert_eq!(saved_policy["choice"]["tools"], json!({"codeMode":true,"codeModeLanguage":"python","applyPatch":false}));
        activate(&mut view, "Choose model and effort").await;
        activate(&mut view, "Edit current model settings").await;
        wait_view(&mut view, |screen| screen.contains("Model settings") && screen.contains("Model ID") && !screen.contains("Loading settings…")).await;
        assert_input(&mut view, "Model display name", "Manual UI Agent").await;
        for label in ["Code Mode: Enabled", "Apply Patch: Disabled", "Code Mode language: Python"] {
            tab_to_label(&mut view, label).await;
            assert!(support::wait_enabled_button(&mut view, label).await.state.selected, "current model settings must show the saved tool policy");
        }
        activate(&mut view, "Code Mode: Disabled").await;
        activate(&mut view, "Apply Patch: Enabled").await;
        activate(&mut view, "Code Mode language: JavaScript").await;
        activate(&mut view, "Close settings").await;
        wait_view_state(&mut view, |view, _| !view.accessibility_snapshot().iter().any(|node| node.label == "Close settings")).await;
        let cancelled_policy = client.query("settings", "resolveModel", target.clone()).await.unwrap();
        assert_eq!(cancelled_policy["choice"]["selection"], saved_policy["choice"]["selection"], "closing settings must not commit the unsaved tool policy");
        assert_eq!(cancelled_policy["choice"]["tools"], json!({"codeMode":true,"codeModeLanguage":"python","applyPatch":false}));
        tab_to_label(&mut view, "Message composer").await;
        editable(&mut view, "Message composer").await;
        view.handle_event(Event::Paste("Use my new connection exactly once".into()));
        support::wait_draft(&client, &session, "Use my new connection exactly once").await;
        let composer = view.surface().focused().unwrap();
        shortcut(&mut view, 'p');
        select_palette(&mut view, "Search commands…", "Connections & models", "Connections & models").await;
        activate(&mut view, "Settings section General").await;
        wait_view(&mut view, |screen| screen.contains("General settings") && !screen.contains("Reading preferences…")).await;
        let original_preferences = client.query("settings", "assistantPreferences", json!({})).await.unwrap();
        activate(&mut view, "Edit personalization").await;
        fill(&mut view, "Display name", "界面草稿用户").await;
        activate(&mut view, "Settings section Network").await;
        wait_view(&mut view, |screen| screen.contains("Network settings") && !screen.contains("Loading network settings…")).await;
        let initial_network = client.query("settings", "network", json!({})).await.unwrap();
        assert_eq!(initial_network["proxy"]["enabled"], false);
        assert_eq!(initial_network["proxy"]["authEnabled"], false);
        assert!(!support::wait_enabled_button(&mut view, "Enable Host proxy").await.state.selected);
        activate(&mut view, "Proxy protocol http").await;
        fill(&mut view, "Proxy host", "proxy.invalid").await;
        fill(&mut view, "Proxy port", "8080").await;
        activate(&mut view, "Enable proxy authentication").await;
        fill(&mut view, "Proxy username", "proxy-user").await;
        activate(&mut view, "Replace proxy password").await;
        let proxy_secret = "代理密码原值";
        fill(&mut view, "Proxy password", proxy_secret).await;
        assert!(!view.snapshot().contains(proxy_secret), "the proxy password was painted by the form");
        activate(&mut view, "Save network settings").await;
        wait_view(&mut view, |screen| screen.contains("Network settings saved.") && !screen.contains("Loading network settings…")).await;
        let saved_network = client.query("settings", "network", json!({})).await.unwrap();
        let mut expected_proxy = initial_network["proxy"].clone();
        expected_proxy["protocol"] = json!("http");
        expected_proxy["host"] = json!("proxy.invalid");
        expected_proxy["port"] = json!(8080);
        expected_proxy["authEnabled"] = json!(true);
        expected_proxy["username"] = json!("proxy-user");
        assert_eq!(saved_network["proxy"], expected_proxy);
        assert_eq!(saved_network["credential"]["configured"], true);
        assert!(!saved_network.to_string().contains(proxy_secret));
        assert!(saved_network["revision"].as_u64().unwrap() > original_preferences["revision"].as_u64().unwrap());
        activate(&mut view, "Settings section General").await;
        wait_view(&mut view, |screen| screen.contains("Personalization") && screen.contains("Display name")).await;
        assert_input(&mut view, "Display name", "界面草稿用户").await;
        activate(&mut view, "Save this preference").await;
        wait_view(&mut view, |screen| screen.contains("Preferences changed elsewhere.") && screen.contains("界面草稿用户")).await;
        let save = view.accessibility_snapshot().into_iter().find(|node| node.role == nsh_core::AccessibilityRole::Button && node.label == "Save this preference").expect("the stale preference editor lost its actual Save button");
        assert!(save.state.disabled, "a stale preference draft must require explicit discard before another save");
        let conflicted = client.query("settings", "assistantPreferences", json!({})).await.unwrap();
        assert_eq!(conflicted["revision"], saved_network["revision"]);
        assert_eq!(conflicted["displayName"], original_preferences["displayName"]);
        // Cancel explicitly discards this stale draft and reads the Host's
        // current shared policy before another personalization edit is opened.
        activate(&mut view, "Cancel").await;
        activate(&mut view, "Edit personalization").await;
        fill(&mut view, "Display name", "已保存的中文用户").await;
        activate(&mut view, "Save this preference").await;
        wait_view(&mut view, |screen| screen.contains("General settings") && screen.contains("Preferences saved.")).await;
        let settings_close = support::wait_enabled_button(&mut view, "Close settings").await.id;
        activate(&mut view, "Language: 简体中文").await;
        wait_view_state(&mut view, |view, screen| screen.contains("常规设置") && screen.contains("偏好已保存。") && view.accessibility_snapshot().iter().any(|node| node.role == nsh_core::AccessibilityRole::Button && node.label == "语言：简体中文" && node.state.selected) && view.accessibility_snapshot().iter().any(|node| node.id == settings_close && node.label == "关闭设置")).await;
        let saved_preferences = client.query("settings", "assistantPreferences", json!({})).await.unwrap();
        assert_eq!(saved_preferences["displayName"], "已保存的中文用户");
        assert_eq!(saved_preferences["language"], "zh-CN", "the interface and assistant must share the committed Host language");
        activate(&mut view, "语言：繁體中文").await;
        wait_view_state(&mut view, |view, screen| screen.contains("一般設定") && screen.contains("偏好已儲存。") && view.accessibility_snapshot().iter().any(|node| node.role == nsh_core::AccessibilityRole::Button && node.label == "語言：繁體中文" && node.state.selected) && view.accessibility_snapshot().iter().any(|node| node.id == settings_close && node.label == "關閉設定")).await;
        let traditional_preferences = client.query("settings", "assistantPreferences", json!({})).await.unwrap();
        assert_eq!(traditional_preferences["language"], "zh-TW");
        assert!(traditional_preferences["revision"].as_u64().unwrap() > saved_preferences["revision"].as_u64().unwrap());
        assert_eq!(traditional_preferences["displayName"], saved_preferences["displayName"]);
        activate(&mut view, "語言：English").await;
        wait_view_state(&mut view, |view, screen| screen.contains("General settings") && screen.contains("Preferences saved.") && view.accessibility_snapshot().iter().any(|node| node.role == nsh_core::AccessibilityRole::Button && node.label == "Language: English" && node.state.selected) && view.accessibility_snapshot().iter().any(|node| node.id == settings_close && node.label == "Close settings")).await;
        let saved_preferences = client.query("settings", "assistantPreferences", json!({})).await.unwrap();
        assert_eq!(saved_preferences["language"], "en");
        assert!(saved_preferences["revision"].as_u64().unwrap() > traditional_preferences["revision"].as_u64().unwrap());
        let final_network = client.query("settings", "network", json!({})).await.unwrap();
        assert_eq!(final_network["proxy"], saved_network["proxy"]);
        assert_eq!(final_network["credential"], saved_network["credential"]);
        assert!(!final_network.to_string().contains(proxy_secret));
        // This editor writes the Host-selected global AGENTS.md, independently
        // of the shared runtime-policy revision and without changing its bytes.
        let initial_global = client.query("agent", "globalInstructions", json!({})).await.unwrap();
        assert_eq!(initial_global["kind"], "available");
        assert_eq!(initial_global["source"], "maka");
        assert_eq!(initial_global["path"], instruction_path.to_str().unwrap());
        assert_eq!(initial_global["content"], initial_instructions);
        let original_size = (view.surface().viewport().width.0 / 8.0, view.surface().viewport().height.0 / 16.0);
        view.resize(120, 50);
        activate(&mut view, "Edit global instructions").await;
        // The complete native text remains one label even when a long Host
        // path wraps across multiple terminal rows.
        wait_view_state(&mut view, |view, _| view.accessibility_snapshot().iter().any(|node| node.label == instruction_path.to_str().unwrap())).await;
        assert_input(&mut view, "Global instructions", initial_instructions).await;
        editable(&mut view, "Global instructions").await;
        let global_editor = view.surface().focused().unwrap();
        let save = view.accessibility_snapshot().into_iter().find(|node| node.role == nsh_core::AccessibilityRole::Button && node.label == "Save global instructions").expect("the unchanged global file lost its Save button");
        assert!(save.state.disabled, "loading and focusing the CRLF file must not make it dirty");
        assert_eq!(std::fs::read_to_string(&instruction_path).unwrap(), initial_instructions);
        // Edit the resident document instead of replacing it: existing CRLF,
        // tabs and whitespace remain literal; physical Enter uses its first EOL.
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::End, KeyModifiers::CONTROL)));
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::Char('改'), KeyModifiers::NONE)));
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)));
        commit_native_events(&mut view).await;
        let locally_edited = format!("{initial_instructions}改\r\n");
        assert_input(&mut view, "Global instructions", &locally_edited).await;
        assert_eq!(view.surface().focused(), Some(global_editor), "local editing replaced the resident global file input");
        support::wait_enabled_button(&mut view, "Save global instructions").await;
        assert_eq!(std::fs::read_to_string(&instruction_path).unwrap(), initial_instructions, "local typing must not save the file implicitly");
        let instruction_draft = "  GLOBAL_DRAFT_PRESERVED\r\n\t未保存的完整草稿 🦀。\n保留独立回车\r末行\r\n\r\n";
        fill(&mut view, "Global instructions", instruction_draft).await;
        // A different shell can leave an original saved action unresolved.
        // Recover its actual receipt without taking ownership of this draft.
        let remote_instructions = "REMOTE SAVED GLOBAL INSTRUCTIONS\r\n\t另一终端已保存。\r\n\r\n";
        {
            let gate = ReplyGate::global_instructions(fixture.directory.path(), fixture.address.clone());
            let remote = fixture.client_at(&gate.address).await;
            let remote_id = Uuid::new_v4();
            let mutation = remote.settings_mutation(remote_id, "agent", "updateGlobalInstructions", json!({
                "source":initial_global["source"], "revision":initial_global["revision"], "content":remote_instructions
            }), Default::default()).await.unwrap();
            let original = mutation.prepare().await.unwrap();
            gate.arm();
            let mut confirmation = Box::pin(mutation.confirm());
            tokio::select! {
                result = &mut confirmation => panic!("the global save receipt escaped its physical gate: {result:?}"),
                () = gate.held.notified() => {},
            }
            assert_eq!(std::fs::read_to_string(&instruction_path).unwrap(), remote_instructions);
            drop(confirmation);
            mutation.disconnect().await;
            gate.release();
            remote.close().await.unwrap();
            let pending = client.pending_settings().await.unwrap();
            assert_eq!(pending.iter().map(|operation| operation.id).collect::<Vec<_>>(), [remote_id]);
            assert_eq!(pending[0].reference, original.reference);
            assert!(pending[0].receipt.is_none());
            // The local owner discovers the shared journal's unresolved action
            // when its own attempted Save is refused before dispatch.
            activate(&mut view, "Save global instructions").await;
            wait_view(&mut view, |screen| screen.contains("Recover original settings actions")).await;
            activate(&mut view, "Recover settings actions").await;
            wait_view(&mut view, |screen| screen.contains("Source changed. Your draft is preserved.") && !screen.contains("Recover original settings actions")).await;
            assert_input(&mut view, "Global instructions", instruction_draft).await;
            let save = view.accessibility_snapshot().into_iter().find(|node| node.role == nsh_core::AccessibilityRole::Button && node.label == "Save global instructions").expect("receipt recovery removed the independent draft's Save button");
            assert!(save.state.disabled, "recovered other-shell saves must not make this unrelated draft repeatable");
            assert_eq!(std::fs::read_to_string(&instruction_path).unwrap(), remote_instructions);
            let settled = client.operation_for_settings(remote_id).await.unwrap();
            assert_eq!(settled.reference, original.reference);
            assert!(matches!(settled.receipt, Some(Receipt::Recorded { outcome: OperationOutcome::Returned { ref value }, .. }) if value == &json!({"kind":"saved"})));
            assert!(client.pending_settings().await.unwrap().is_empty());
        }
        activate(&mut view, "Reload (discard edits)").await;
        wait_view(&mut view, |screen| screen.contains("REMOTE SAVED GLOBAL INSTRUCTIONS") && !screen.contains("Reading global instructions…")).await;
        assert_input(&mut view, "Global instructions", remote_instructions).await;
        fill(&mut view, "Global instructions", instruction_draft).await;
        let external_instructions = "EXTERNAL GLOBAL UPDATE\r\n\t外部编辑不能被覆盖。\r\n\r\n";
        std::fs::write(&instruction_path, external_instructions).unwrap();
        activate(&mut view, "Save global instructions").await;
        wait_view(&mut view, |screen| screen.contains("Source changed. Your draft is preserved.")).await;
        assert_input(&mut view, "Global instructions", instruction_draft).await;
        let save = view.accessibility_snapshot().into_iter().find(|node| node.role == nsh_core::AccessibilityRole::Button && node.label == "Save global instructions").expect("the global instruction draft lost its actual Save button");
        assert!(save.state.disabled, "a changed file must require explicit reload before another save");
        assert_eq!(std::fs::read_to_string(&instruction_path).unwrap(), external_instructions);
        activate(&mut view, "Reload (discard edits)").await;
        wait_view(&mut view, |screen| screen.contains("EXTERNAL GLOBAL UPDATE") && !screen.contains("Reading global instructions…")).await;
        assert_input(&mut view, "Global instructions", external_instructions).await;
        let final_instructions = format!("  GLOBAL_UI_INSTRUCTIONS_UNIQUE\r\n{}\n\tMixed LF line 🦀\rStandalone CR line\r\n\r\n", "\t保留完整 UTF-8 指令，遵循实际用户需求。  \r\n".repeat(40));
        fill(&mut view, "Global instructions", &final_instructions).await;
        assert_input(&mut view, "Global instructions", &final_instructions).await;
        assert_document_viewport(&mut view, "Global instructions", "Save global instructions", "GLOBAL_UI_INSTRUCTIONS_UNIQUE").await;
        view.resize(80, 24);
        assert_input(&mut view, "Global instructions", &final_instructions).await;
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::Home, KeyModifiers::CONTROL)));
        commit_native_events(&mut view).await;
        wait_view(&mut view, |screen| screen.contains("GLOBAL_UI_INSTRUCTIONS_UNIQUE")).await;
        activate(&mut view, "Save global instructions").await;
        wait_view(&mut view, |screen| screen.contains("Global instructions saved.")).await;
        let saved_global = client.query("agent", "globalInstructions", json!({})).await.unwrap();
        assert_eq!(saved_global["source"], initial_global["source"]);
        assert_eq!(saved_global["path"], initial_global["path"]);
        assert_eq!(saved_global["content"], final_instructions);
        assert_eq!(saved_global["exists"], true);
        assert_ne!(saved_global["revision"], initial_global["revision"]);
        assert_eq!(std::fs::read_to_string(&instruction_path).unwrap(), final_instructions);
        assert_eq!(client.query("settings", "assistantPreferences", json!({})).await.unwrap(), saved_preferences, "editing AGENTS.md must not mutate display name, language or the policy revision");
        // Return from the file editor before continuing the original name and
        // composer identity checks; saving may retain the fresh file editor.
        view.resize(120, 50);
        activate(&mut view, "Back from general settings").await;
        activate(&mut view, "Edit compaction prompt").await;
        let compaction_draft = format!("COMPACTION_EDITOR_FIRST_LINE\n{}", "Complete unsaved compaction instructions.\n".repeat(50));
        fill(&mut view, "Compaction prompt", &compaction_draft).await;
        assert_document_viewport(&mut view, "Compaction prompt", "Save this preference", "COMPACTION_EDITOR_FIRST_LINE").await;
        view.resize(80, 24);
        assert_input(&mut view, "Compaction prompt", &compaction_draft).await;
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::Home, KeyModifiers::CONTROL)));
        commit_native_events(&mut view).await;
        wait_view(&mut view, |screen| screen.contains("COMPACTION_EDITOR_FIRST_LINE")).await;
        activate(&mut view, "Cancel").await;
        assert_eq!(client.query("settings", "assistantPreferences", json!({})).await.unwrap(), saved_preferences, "leaving the compaction editor must not save the draft");
        view.resize(original_size.0 as u16, original_size.1 as u16);
        activate(&mut view, "Edit personalization").await;
        assert_input(&mut view, "Display name", "已保存的中文用户").await;
        support::wait_enabled_button(&mut view, "Back from general settings").await;
        support::click_button(&mut view, "Close settings").await;
        editable(&mut view, "Message composer").await;
        assert_eq!(view.surface().focused(), Some(composer), "settings replaced the resident native composer");
        assert_eq!(view.surface().input_context().unwrap().text.as_deref(), Some("Use my new connection exactly once"));
        support::wait_draft(&client, &session, "Use my new connection exactly once").await;
        support::wait_enabled_button(&mut view, "Send message").await;
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)));
        let mut request = fixture.next_request().await;
        assert_eq!(request.body["model"], "manual-ui-agent");
        assert_eq!(request.body["reasoning_effort"], "high");
        assert_eq!(request.body["provider"], json!({"only":["openrouter","deepseek"]}));
        assert_eq!(request.body["temperature"], 0.22);
        assert!(request.body["tools"].as_array().unwrap().iter().any(|tool| tool["function"]["name"] == "exec"), "the model's saved Code Mode policy must reach the actual provider request");
        assert!(request.body["messages"].as_array().unwrap().iter().any(|message| message["role"] == "user" && message["content"].to_string().contains("Use my new connection exactly once")));
        let system_prompt = request.body["messages"].as_array().unwrap().iter()
            .filter(|message| message["role"] == "system")
            .filter_map(|message| message["content"].as_str()).collect::<Vec<_>>().join("\n");
        assert_eq!(system_prompt.matches("GLOBAL_UI_INSTRUCTIONS_UNIQUE").count(), 1, "admission must capture the saved global file once");
        assert!(system_prompt.contains(final_instructions.trim()), "the provider did not receive the saved full global instructions");
        assert!(!system_prompt.contains("INITIAL GLOBAL UTF-8"));
        assert!(!system_prompt.contains("EXTERNAL GLOBAL UPDATE"));
        assert!(!system_prompt.contains("REMOTE SAVED GLOBAL INSTRUCTIONS"));

        request.thinking("SETTINGS_CONNECTION_REASONING").await;
        request.delta("SETTINGS_CONNECTION_SINGLE_SEND_DONE").await;
        request.finish().await;
        fixture.idle(&client, &session).await;
        let completed = wait_view(&mut view, |screen| screen.contains("SETTINGS_CONNECTION_SINGLE_SEND_DONE")).await;
        evidence("settings-empty-to-real-provider", &completed);
        support::evidence_cells("settings-empty-to-real-provider", &view);
        assert_eq!(fixture.request_count.load(Ordering::SeqCst), 1);
        assert_eq!(fixture.discovery_count.load(Ordering::SeqCst), 1);
        // This copy notice belongs to the still-mounted conversation. Changing
        // language must translate it without replacing the resident composer.
        support::click_button(&mut view, "Copy message").await;
        wait_view(&mut view, |screen| screen.contains("Message copied")).await;
        shortcut(&mut view, 'p');
        select_palette(&mut view, "Search commands…", "Connections & models", "Connections & models").await;
        activate(&mut view, "Settings section General").await;
        wait_view(&mut view, |screen| screen.contains("General settings") && !screen.contains("Reading preferences…")).await;
        activate(&mut view, "Language: 简体中文").await;
        wait_view(&mut view, |screen| screen.contains("常规设置") && screen.contains("偏好已保存。")).await;
        support::click_button(&mut view, "关闭设置").await;
        wait_view(&mut view, |screen| screen.contains("消息已复制") && screen.contains("发送消息，或开始一项任务…")).await;
        // The second Settings dialog was opened from the copy action, so its
        // native restoration belongs to that action. Explicitly focus the same
        // resident composer before checking its identity and editing context.
        tab_to_label(&mut view, "消息输入区").await;
        editable(&mut view, "消息输入区").await;
        assert_eq!(view.surface().focused(), Some(composer), "language changes replaced the resident composer");
        assert_eq!(view.surface().input_context().unwrap().text.as_deref(), Some(""));
        let startup_preferences = client.query("settings", "assistantPreferences", json!({})).await.unwrap();
        assert_eq!(startup_preferences["language"], "zh-CN");
        assert_eq!(startup_preferences["displayName"], saved_preferences["displayName"]);
        drop(view);
        bindings.close().await.unwrap();
        drop(client);
        #[cfg(unix)]
        {
            let mut terminal = support::pty::Pty::spawn(&fixture.directory.path().join("host"), Some(&session));
            terminal.wait_for("SETTINGS_CONNECTION_SINGLE_SEND_DONE").await;
            terminal.wait_for("发送消息，或开始一项任务…").await;
            let restored = terminal.wait_for("Manual UI Agent · high").await;
            assert!(!restored.contains(support::PROVIDER_KEY));
            assert!(!restored.contains(proxy_secret));
            let restarted = fixture.client().await;
            assert_eq!(restarted.query("settings", "assistantPreferences", json!({})).await.unwrap(), startup_preferences);
            assert_eq!(restarted.query("agent", "globalInstructions", json!({})).await.unwrap(), saved_global, "the selected file and full content must survive terminal restart");
            let persisted_network = restarted.query("settings", "network", json!({})).await.unwrap();
            // Language and network settings share the runtime policy revision.
            // The final UI language change advances that revision while every
            // proxy, credential and Root field must remain exactly as saved.
            let mut expected_network = final_network.clone();
            expected_network["revision"] = startup_preferences["revision"].clone();
            assert_eq!(persisted_network, expected_network);
            assert!(!persisted_network.to_string().contains(proxy_secret));
            restarted.close().await.unwrap();
            assert_eq!(fixture.request_count.load(Ordering::SeqCst), 1, "restoring the configured session must not resend");
            assert_eq!(fixture.discovery_count.load(Ordering::SeqCst), 1, "restoring the configured session must not rediscover models");
            evidence("settings-real-pty-restores-manual-model", &restored);
            terminal.send(b"\x11");
            terminal.finish().await;
        }
        fixture.finish().await;
    }).await.expect("empty settings real Host/PTY flow timed out");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_home_palette_creates_switches_models_and_stops_a_real_session_without_mixing_drafts() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let mut fixture = Fixture::reasoning_models().await;
        let client = fixture.client().await;
        let models = client.query("settings", "models", json!({"kind":"start","query":""})).await.unwrap();
        let choices = models["choices"].as_array().unwrap();
        let primary = choices.iter().find(|choice| choice["selection"]["modelId"] == "fixture-model").unwrap();
        let alternative = choices.iter().find(|choice| choice["selection"]["modelId"] == "fixture-model-alt").unwrap();
        let unknown_default = choices.iter().find(|choice| choice["selection"]["modelId"] == "fixture-model-unknown").unwrap();
        assert_eq!(unknown_default["thinkingLevels"], json!(["off", "high"]));
        assert!(unknown_default["defaultThinkingLevel"].is_null());
        assert_eq!(primary["thinkingLevels"], json!(["off", "low", "high"]));
        assert_eq!(primary["defaultThinkingLevel"], "low");
        assert_eq!(alternative["thinkingLevels"], json!(["off", "high"]));
        assert_eq!(alternative["defaultThinkingLevel"], "high");
        let selected = support::mutate(&client, "selectBackend", json!({
            "sessionId":fixture.session,"backend":{"kind":"model","connectionId":fixture.selection["connectionId"],"modelId":"fixture-model","thinkingLevel":null}
        })).await;
        assert_eq!(selected["kind"], "committed");
        let (mut view, bindings) = fixture.view(client.clone(), None);
        let home = wait_view(&mut view, |screen| screen.contains("Make something remarkable.")).await;
        evidence("workbench-home", &home);
        support::evidence_cells("workbench-home", &view);

        support::click_text(&mut view, "Commands");
        wait_view_state(&mut view, |view, screen| {
            screen.contains("Search commands…")
                && view.accessibility_snapshot().iter().any(|node| {
                    node.role == nsh_core::AccessibilityRole::Button
                        && node.label == "Close commands"
                        && !node.state.disabled
                })
        }).await;
        support::click_button(&mut view, "Close commands").await;
        wait_view(&mut view, |screen| screen.contains("Make something remarkable.") && !screen.contains("Search commands…")).await;
        support::click_text(&mut view, "Commands");
        wait_view_state(&mut view, |view, screen| screen.contains("Search commands…") && selected_command(&view.accessibility_snapshot(), "Sessions").is_some()).await;
        let nodes = view.accessibility_snapshot();
        support::click_node(&mut view, selected_command(&nodes, "Sessions").unwrap().clone());
        wait_view(&mut view, |screen| screen.contains("Search sessions…") && screen.contains("NSH real Agent") && !screen.contains("Loading…")).await;
        wait_focused_input(&mut view, "Search session titles").await;
        support::click_button(&mut view, "Open conversation NSH real Agent").await;
        wait_view(&mut view, |screen| screen.contains("NSH real Agent")).await;
        wait_editable_composer(&mut view).await;
        view.handle_event(Event::Paste("Draft A stays in its own conversation".into()));
        support::wait_draft(&client, &fixture.session, "Draft A stays in its own conversation").await;

        let composer = view.surface().focused().unwrap();
        support::wait_enabled_button(&mut view, "Collapse session browser").await;
        assert!(!view.accessibility_snapshot().iter().any(|node| node.label == "Close session browser"), "the sidebar must not expose a second toggle beside the Header control");
        support::click_button(&mut view, "Collapse session browser").await;
        wait_view(&mut view, |screen| screen.contains("Draft A stays in its own conversation") && !screen.contains("Search sessions…")).await;
        support::wait_enabled_button(&mut view, "Expand session browser").await;
        wait_editable_composer(&mut view).await;
        assert_eq!(view.surface().focused(), Some(composer));

        // Header search operates the resident title search, independently of
        // the command palette and the conversation's saved native draft.
        support::click_button(&mut view, "Search sessions").await;
        wait_focused_input(&mut view, "Search session titles").await;
        let search = view.surface().focused().unwrap();
        shortcut(&mut view, 'a');
        view.handle_event(Event::Paste("NSH real".into()));
        wait_view_state(&mut view, |view, screen| !screen.contains("Loading…") && view.accessibility_snapshot().iter().any(|node| node.label == "Open conversation NSH real Agent")).await;
        support::click_button(&mut view, "Search sessions").await;
        wait_focused_input(&mut view, "Search session titles").await;
        assert_eq!(view.surface().focused(), Some(search), "Header search must retain the mounted search Input");
        assert_eq!(view.surface().input_context().unwrap().text.as_deref(), Some("NSH real"));
        shortcut(&mut view, 'a');
        view.handle_event(Event::Paste("HEADER_SEARCH_HAS_NO_SESSION_MATCH".into()));
        wait_view_state(&mut view, |view, screen| screen.contains("No matching conversations.") && !screen.contains("Loading…") && !view.accessibility_snapshot().iter().any(|node| node.label == "Open conversation NSH real Agent")).await;
        support::click_button(&mut view, "Clear session search").await;
        wait_focused_input(&mut view, "Search session titles").await;
        wait_view_state(&mut view, |view, screen| !screen.contains("Loading…") && view.accessibility_snapshot().iter().any(|node| node.label == "Open conversation NSH real Agent")).await;
        support::click_button(&mut view, "Collapse session browser").await;
        wait_editable_composer(&mut view).await;
        assert_eq!(view.surface().focused(), Some(composer));
        assert_eq!(view.surface().input_context().unwrap().text.as_deref(), Some("Draft A stays in its own conversation"));
        support::wait_draft(&client, &fixture.session, "Draft A stays in its own conversation").await;
        assert_eq!(fixture.request_count.load(Ordering::SeqCst), 0);
        support::click_button(&mut view, "Expand session browser").await;
        wait_focused_input(&mut view, "Search session titles").await;
        tab_to_label(&mut view, "Message composer").await;

        // Both presses can be admitted by the same native frame before the
        // settings modal reaches it. The old Header action must not dismiss
        // or replace the newer modal when the engine processes that FIFO.
        let settings = support::wait_enabled_button(&mut view, "Open settings").await;
        let toggle = support::wait_enabled_button(&mut view, "Collapse session browser").await;
        let control = view.control().unwrap();
        for id in [settings.id, toggle.id] {
            control.dispatch_event(id, nsh_core::EventKind::Press, nsh_core::EventPayload::None);
        }
        let (done, committed) = tokio::sync::oneshot::channel();
        control.advance_clock(Duration::ZERO, move || { let _ = done.send(()); });
        committed.await.expect("the admitted Header actions did not commit");
        support::wait_enabled_button(&mut view, "Close settings").await;
        support::click_button(&mut view, "Close settings").await;
        wait_editable_composer(&mut view).await;
        assert_eq!(view.surface().focused(), Some(composer));
        assert_eq!(view.surface().input_context().unwrap().text.as_deref(), Some("Draft A stays in its own conversation"));

        // A historical Ctrl+O request must not replay when an inactive sidebar
        // remounts. The center keeps its native Input and exact saved draft.
        view.resize(80, 24);
        let narrow = wait_view(&mut view, |screen| screen.contains("Draft A stays in its own conversation") && !screen.contains("Search sessions…")).await;
        assert_eq!(view.surface().focused(), Some(composer));
        assert_eq!(view.surface().input_context().unwrap().text.as_deref(), Some("Draft A stays in its own conversation"));
        evidence("workbench-narrow-preserves-editor", &narrow);
        support::evidence_cells("workbench-narrow-preserves-editor", &view);
        view.resize(120, 40);
        let wide = wait_view(&mut view, |screen| screen.contains("Draft A stays in its own conversation") && screen.contains("Search sessions…")).await;
        assert_eq!(view.surface().focused(), Some(composer));
        assert_eq!(view.surface().input_context().unwrap().text.as_deref(), Some("Draft A stays in its own conversation"));
        evidence("workbench-wide-preserves-editor", &wide);
        support::evidence_cells("workbench-wide-preserves-editor", &view);

        // Drag the real native divider in both directions without leaving the
        // editor or changing its draft. A viewport resize does not exercise it.
        for delta in [4_i16, -4] {
            let nodes = view.accessibility_snapshot();
            let divider = nodes.iter().find(|node| node.label == "Resize session browser").unwrap().frame;
            let editor = nodes.iter().find(|node| node.id == composer).unwrap().frame;
            let column = (divider.origin.x.0 / 8.0).round() as u16;
            let target = (column as i16 + delta) as u16;
            for (kind, column) in [
                (MouseEventKind::Down(MouseButton::Left), column),
                (MouseEventKind::Drag(MouseButton::Left), target),
                (MouseEventKind::Up(MouseButton::Left), target),
            ] {
                view.handle_event(Event::Mouse(MouseEvent {kind,column,row:1,modifiers:KeyModifiers::NONE}));
            }
            tokio::time::timeout(Duration::from_secs(20), async {
                loop {
                    support::tick(&mut view);
                    if view.accessibility_snapshot().iter().any(|node| node.label == "Resize session browser" && node.frame.origin.x.0 == divider.origin.x.0 + f32::from(delta) * 8.0) {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            }).await.expect("the physical browser divider drag did not resize the center");
            assert_eq!(view.surface().focused(), Some(composer), "divider drag moved editor focus");
            assert_eq!(view.surface().input_context().unwrap().text.as_deref(), Some("Draft A stays in its own conversation"));
            let resized = view.accessibility_snapshot().into_iter().find(|node| node.id == composer).unwrap().frame;
            assert_eq!(resized.origin.x.0, editor.origin.x.0 + f32::from(delta) * 8.0);
            assert_eq!(resized.size.width.0, editor.size.width.0 - f32::from(delta) * 8.0);
        }

        // A height-only resize ends the native gesture at its applied width.
        // The next button step must start there, not at the pre-drag preference.
        let nodes = view.accessibility_snapshot();
        let divider = nodes.iter().find(|node| node.label == "Resize session browser").unwrap().frame;
        let editor = nodes.iter().find(|node| node.id == composer).unwrap().frame;
        let selection = view.surface().input_context().unwrap().selection;
        let viewport = view.surface().viewport();
        let column = (divider.origin.x.0 / 8.0).round() as u16;
        let target = column + 3;
        let dragged_x = divider.origin.x.0 + 24.0;
        for (kind, column) in [
            (MouseEventKind::Down(MouseButton::Left), column),
            (MouseEventKind::Drag(MouseButton::Left), target),
        ] {
            view.handle_event(Event::Mouse(MouseEvent {kind,column,row:1,modifiers:KeyModifiers::NONE}));
        }
        wait_view_state(&mut view, |view, _| view.accessibility_snapshot().iter().any(|node| node.label == "Resize session browser" && node.frame.origin.x.0 == dragged_x)).await;
        assert_eq!(view.surface().focused(), Some(composer));
        assert_eq!(view.surface().input_context().unwrap().selection, selection);
        view.resize((viewport.width.0 / 8.0) as u16, (viewport.height.0 / 16.0) as u16 + 1);
        // The full-height divider proves the new native layout was applied;
        // the empty conversation's composer is vertically centered.
        wait_view_state(&mut view, |view, _| view.accessibility_snapshot().iter().any(|node| node.label == "Resize session browser" && node.frame.size.height.0 == divider.size.height.0 + 16.0)).await;
        assert!(view.accessibility_snapshot().iter().any(|node| node.label == "Resize session browser" && node.frame.origin.x.0 == dragged_x));
        view.handle_event(Event::Mouse(MouseEvent {kind:MouseEventKind::Up(MouseButton::Left),column:target,row:1,modifiers:KeyModifiers::NONE}));
        assert_eq!(view.surface().focused(), Some(composer));
        let context = view.surface().input_context().unwrap();
        assert_eq!(context.text.as_deref(), Some("Draft A stays in its own conversation"));
        assert_eq!(context.selection, selection);
        let wider = support::wait_enabled_button(&mut view, "Wider session browser").await;
        support::click_node(&mut view, wider.clone());
        wait_view_state(&mut view, |view, _| view.accessibility_snapshot().iter().any(|node| node.label == "Resize session browser" && node.frame.origin.x.0 != dragged_x)).await;
        let nodes = view.accessibility_snapshot();
        let widened = nodes.iter().find(|node| node.label == "Resize session browser").unwrap().frame;
        assert_eq!(widened.origin.x.0, dragged_x + 16.0, "Wider must continue from the width applied before the native gesture ended");
        let resized = nodes.iter().find(|node| node.id == composer).unwrap().frame;
        assert_eq!(resized.origin.x.0, editor.origin.x.0 + 40.0);
        assert_eq!(resized.size.width.0, editor.size.width.0 - 40.0);
        assert_eq!(view.surface().focused(), Some(wider.id), "the activated Wider button must receive normal pointer focus");
        view.resize((viewport.width.0 / 8.0) as u16, (viewport.height.0 / 16.0) as u16);
        wait_view_state(&mut view, |view, _| view.accessibility_snapshot().iter().any(|node| node.label == "Resize session browser" && node.frame.size.height.0 == divider.size.height.0)).await;
        support::wait_draft(&client, &fixture.session, "Draft A stays in its own conversation").await;

        shortcut(&mut view, 'p');
        select_palette(&mut view, "Search commands…", "New con", "New conversation").await;
        wait_view(&mut view, |screen| screen.contains("Models") && screen.contains("Search models…")).await;
        let catalog = client.query("agent", "list", json!({"filter":"all","position":{"kind":"start"}})).await.unwrap();
        let sessions = catalog["sessions"].as_array().unwrap();
        assert_eq!(sessions.len(), 2);
        let original = sessions.iter().find(|session| session["id"] == fixture.session).unwrap();
        let created = sessions.iter().find(|session| session["id"] != fixture.session).unwrap();
        let created_id = created["id"].as_str().unwrap().to_owned();
        assert_eq!(created["workspace"], original["workspace"]);
        assert_eq!(created["workspace"]["path"], fixture.directory.path().join("workspace").canonicalize().unwrap().to_str().unwrap());
        wait_view(&mut view, |screen| screen.contains("Search models…")).await;
        wait_focused_input(&mut view, "Search models").await;
        let model_query = format!("{}fixture-model-alt", "model-alt ".repeat(30));
        view.handle_event(Event::Paste(model_query.clone()));
        support::tick(&mut view);
        assert_eq!(view.surface().input_context().unwrap().text.as_deref(), Some(model_query.as_str()));
        wait_view(&mut view, |screen| screen.contains("fixture-model-alt") && screen.contains("1 model") && !screen.contains("Loading…")).await;
        let missing_model_tail = format!("{}fixture-model-alX", "model-alt ".repeat(30));
        shortcut(&mut view, 'a');
        view.handle_event(Event::Paste(missing_model_tail.clone()));
        support::tick(&mut view);
        assert_eq!(view.surface().input_context().unwrap().text.as_deref(), Some(missing_model_tail.as_str()));
        tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                view.poll().unwrap();
                support::tick(&mut view);
                assert!(view.last_error().is_none(), "model-query view failed: {:?}", view.last_error());
                let screen = view.snapshot();
                let viewport = view.surface().viewport();
                // Virtualized list cells retain their old accessibility labels
                // while parked offscreen. Reject an old choice only when its
                // positive-area frame actually intersects the viewport.
                let original_choice_visible = view.accessibility_snapshot().iter().any(|node| {
                    let frame = node.frame;
                    node.label == "Use fixture-model-alt · NSH fixture"
                        && frame.size.width.0 > 0.0
                        && frame.size.height.0 > 0.0
                        && frame.origin.x.0 < viewport.width.0
                        && frame.origin.y.0 < viewport.height.0
                        && frame.origin.x.0 + frame.size.width.0 > 0.0
                        && frame.origin.y.0 + frame.size.height.0 > 0.0
                });
                let original_query = view.surface().input_context().and_then(|input| input.text.clone());
                if original_query.as_deref() == Some(missing_model_tail.as_str())
                    && screen.contains("0 models")
                    && !screen.contains("Loading…")
                    && !original_choice_visible
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        }).await.expect("the complete negative query did not settle without a visible old model choice");
        for query in ["fixture-model", "no-such-model", model_query.as_str()] {
            shortcut(&mut view, 'a');
            view.handle_event(Event::Paste(query.into()));
            support::tick(&mut view);
        }
        wait_view(&mut view, |screen| screen.contains("fixture-model-alt") && screen.contains("1 model") && !screen.contains("Loading…")).await;
        assert_eq!(view.surface().input_context().unwrap().text.as_deref(), Some(model_query.as_str()));
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)));
        wait_view_state(&mut view, |view, screen| screen.contains("New conversation") && screen.contains("fixture-model-alt · high") && model_menu_closed(view)).await;
        let observed = client.query("agent", "observe", json!({"sessionId":created_id})).await.unwrap();
        assert_eq!(observed["session"]["backend"], json!({"kind":"model","connectionId":fixture.selection["connectionId"],"modelId":"fixture-model-alt","thinkingLevel":null}));
        wait_editable_composer(&mut view).await;
        view.handle_event(Event::Paste("Message B uses the selected model".into()));
        support::wait_draft(&client, &created_id, "Message B uses the selected model").await;

        // The remaining footer space belongs to the layout, not the model
        // trigger. Its actual native frame hugs the caption in both layouts.
        let viewport = view.surface().viewport();
        for (columns, rows) in [(160, 40), (80, 24)] {
            view.resize(columns, rows);
            wait_view_state(&mut view, |view, _| model_trigger_caption(view, "fixture-model-alt", "high") && model_menu_closed(view)).await;
            let model = model_menu_button(&view, "Choose model and effort").unwrap().frame;
            let sandbox = support::wait_enabled_button(&mut view, "Sandbox and approvals").await.frame;
            let left = sandbox.origin.x.0 + sandbox.size.width.0;
            let column = ((left + model.origin.x.0) / 16.0).floor() as u16;
            let row = ((model.origin.y.0 + model.size.height.0 / 2.0) / 16.0).floor() as u16;
            let center = f32::from(column) * 8.0 + 4.0;
            assert!(center > left && center < model.origin.x.0, "the model trigger consumed the footer's blank space at {columns} columns");
            for kind in [MouseEventKind::Down(MouseButton::Left), MouseEventKind::Up(MouseButton::Left)] {
                view.handle_event(Event::Mouse(MouseEvent { kind, column, row, modifiers: KeyModifiers::NONE }));
            }
            let (done, committed) = tokio::sync::oneshot::channel();
            view.control().unwrap().advance_clock(Duration::ZERO, move || { let _ = done.send(()); });
            tokio::time::timeout(Duration::from_secs(20), committed).await.unwrap().unwrap();
            support::tick(&mut view);
            assert!(model_menu_closed(&view), "blank footer space opened the model chooser at {columns} columns");
            support::click_button(&mut view, "Choose model and effort").await;
            wait_view_state(&mut view, |view, _| model_menu_ready(view, "Close model selection")).await;
            view.handle_event(Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)));
            wait_view_state(&mut view, |view, _| model_menu_closed(view)).await;
        }
        view.resize((viewport.width.0 / 8.0) as u16, (viewport.height.0 / 16.0) as u16);
        tab_to_label(&mut view, "Message composer").await;
        wait_editable_composer(&mut view).await;

        let created_editor = view.surface().focused().unwrap();
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::Left, KeyModifiers::NONE)));
        let caret = view.surface().input_context().unwrap().selection;
        shortcut(&mut view, 'g');
        wait_view_state(&mut view, |view, screen| screen.contains("Models") && model_menu_ready(view, "Choose reasoning effort") && model_menu_ready(view, "Close model selection")).await;
        tab_to_label(&mut view, "Choose reasoning effort").await;
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)));
        wait_view_state(&mut view, |view, _| model_menu_ready(view, "Back to model settings") && model_menu_ready(view, "Use effort high")).await;
        assert_effort_choices(&view, alternative, None);
        tab_to_label(&mut view, "Use effort off").await;
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)));
        wait_view_state(&mut view, |view, screen| screen.contains("fixture-model-alt · off") && model_menu_closed(view)).await;
        wait_focused_input(&mut view, "Message composer").await;
        assert_eq!(view.surface().focused(), Some(created_editor));
        assert_eq!(view.surface().input_context().unwrap().selection, caret);
        let observed = client.query("agent", "observe", json!({"sessionId":created_id})).await.unwrap();
        assert_eq!(observed["session"]["backend"]["thinkingLevel"], "off");

        // Re-selecting the same route preserves an explicit policy. A mouse
        // Menu returns focus to its actual model trigger, not the editor.
        let model_trigger = view.accessibility_snapshot().into_iter().find(|node| node.label == "Choose model and effort").unwrap().id;
        support::click_label(&mut view, "Choose model and effort");
        wait_view_state(&mut view, |view, _| model_menu_ready(view, "Choose reasoning effort") && model_menu_ready(view, "Close model selection")).await;
        support::click_label(&mut view, "Choose model");
        wait_focused_input(&mut view, "Search models").await;
        wait_view(&mut view, |screen| screen.contains("fixture-model-alt") && !screen.contains("Loading…")).await;
        support::click_label(&mut view, "Use fixture-model-alt · NSH fixture");
        wait_view_state(&mut view, |view, screen| screen.contains("fixture-model-alt · off") && model_menu_closed(view)).await;
        assert_eq!(view.surface().focused(), Some(model_trigger));
        let observed = client.query("agent", "observe", json!({"sessionId":created_id})).await.unwrap();
        assert_eq!(observed["session"]["backend"]["thinkingLevel"], "off");

        support::click_label(&mut view, "Choose model and effort");
        wait_view_state(&mut view, |view, _| model_menu_ready(view, "Choose reasoning effort") && model_menu_ready(view, "Close model selection")).await;
        wait_enabled_node(&mut view, "Choose reasoning effort").await;
        support::click_label(&mut view, "Choose reasoning effort");
        wait_view_state(&mut view, |view, _| model_menu_ready(view, "Back to model settings") && model_menu_ready(view, "Use effort high")).await;
        assert_effort_choices(&view, alternative, Some("off"));
        support::evidence_cells("workbench-model-effort-explicit-off", &view);
        // Hold an Off press across a keyboard selection of the actual default high.
        // Its later release must not replace the newer policy.
        let off = view.accessibility_snapshot().into_iter().find(|node| node.label == "Use effort off").unwrap().frame;
        let column = (off.origin.x.0 / 8.0 - 0.5).ceil().max(0.0) as u16;
        let row = (off.origin.y.0 / 16.0 - 0.5).ceil().max(0.0) as u16;
        view.handle_event(Event::Mouse(MouseEvent {
            kind: MouseEventKind::Down(MouseButton::Left),
            column,
            row,
            modifiers: KeyModifiers::NONE,
        }));
        tab_to_label(&mut view, "Use effort high").await;
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)));
        wait_view_state(&mut view, |view, screen| screen.contains("fixture-model-alt · high") && model_menu_closed(view)).await;
        let observed = client.query("agent", "observe", json!({"sessionId":created_id})).await.unwrap();
        assert!(observed["session"]["backend"]["thinkingLevel"].is_null());
        view.handle_event(Event::Mouse(MouseEvent {
            kind: MouseEventKind::Up(MouseButton::Left),
            column,
            row,
            modifiers: KeyModifiers::NONE,
        }));
        let (done, committed) = tokio::sync::oneshot::channel();
        view.control().expect("the native app engine must be running").advance_clock(Duration::ZERO, move || {
            let _ = done.send(());
        });
        tokio::time::timeout(Duration::from_secs(20), committed).await
            .expect("the old chooser release did not commit")
            .expect("the chooser engine stopped");
        let observed = client.query("agent", "observe", json!({"sessionId":created_id})).await.unwrap();
        assert_eq!(observed["session"]["backend"], json!({"kind":"model","connectionId":fixture.selection["connectionId"],"modelId":"fixture-model-alt","thinkingLevel":null}), "the old Off release changed the newer inherited high policy");
        assert_eq!(fixture.request_count.load(Ordering::SeqCst), 0);
        support::click_label(&mut view, "Choose model and effort");
        wait_view_state(&mut view, |view, _| model_menu_ready(view, "Choose reasoning effort") && model_menu_ready(view, "Close model selection")).await;
        wait_enabled_node(&mut view, "Choose reasoning effort").await;
        support::click_label(&mut view, "Choose reasoning effort");
        wait_view_state(&mut view, |view, _| model_menu_ready(view, "Back to model settings") && model_menu_ready(view, "Use effort high")).await;
        assert_effort_choices(&view, alternative, None);
        support::click_label(&mut view, "Use effort off");
        wait_view_state(&mut view, |view, screen| screen.contains("fixture-model-alt · off") && model_menu_closed(view)).await;
        let observed = client.query("agent", "observe", json!({"sessionId":created_id})).await.unwrap();
        assert_eq!(observed["session"]["backend"]["thinkingLevel"], "off");

        // Different routes inherit their own metadata. Inspect both policies
        // before the one existing send, rather than sending once per choice.
        support::click_label(&mut view, "Choose model and effort");
        wait_view_state(&mut view, |view, _| model_menu_ready(view, "Choose reasoning effort") && model_menu_ready(view, "Close model selection")).await;
        wait_enabled_node(&mut view, "Choose reasoning effort").await;
        support::click_label(&mut view, "Choose reasoning effort");
        wait_view_state(&mut view, |view, _| model_menu_ready(view, "Back to model settings") && model_menu_ready(view, "Use effort high")).await;
        assert_effort_choices(&view, alternative, Some("off"));
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)));
        wait_view_state(&mut view, |view, _| model_menu_ready(view, "Choose reasoning effort") && model_menu_ready(view, "Close model selection") && model_menu_button(view, "Back to model settings").is_none()).await;
        support::click_label(&mut view, "Choose model");
        wait_focused_input(&mut view, "Search models").await;
        wait_view(&mut view, |screen| screen.contains("fixture-model-alt") && !screen.contains("Loading…")).await;
        support::click_label(&mut view, "Use fixture-model · NSH fixture");
        wait_view_state(&mut view, |view, screen| screen.contains("fixture-model · low") && model_menu_closed(view)).await;
        let observed = client.query("agent", "observe", json!({"sessionId":created_id})).await.unwrap();
        assert_eq!(observed["session"]["backend"]["modelId"], "fixture-model");
        assert!(observed["session"]["backend"]["thinkingLevel"].is_null());
        support::click_label(&mut view, "Choose model and effort");
        wait_view_state(&mut view, |view, _| model_menu_ready(view, "Choose reasoning effort") && model_menu_ready(view, "Close model selection")).await;
        wait_enabled_node(&mut view, "Choose reasoning effort").await;
        support::click_label(&mut view, "Choose reasoning effort");
        wait_view_state(&mut view, |view, _| model_menu_ready(view, "Back to model settings") && model_menu_ready(view, "Use effort high")).await;
        assert_effort_choices(&view, primary, None);
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)));
        wait_view_state(&mut view, |view, _| model_menu_ready(view, "Choose reasoning effort") && model_menu_ready(view, "Close model selection") && model_menu_button(view, "Back to model settings").is_none()).await;
        support::click_label(&mut view, "Choose model");
        wait_focused_input(&mut view, "Search models").await;
        wait_view(&mut view, |screen| screen.contains("fixture-model-unknown") && !screen.contains("Loading…")).await;
        support::click_label(&mut view, "Use fixture-model-unknown · NSH fixture");
        wait_view_state(&mut view, |view, screen| screen.contains("Provider controlled") && model_trigger_caption(view, "fixture-model-unknown", "Provider controlled") && model_menu_closed(view)).await;
        let observed = client.query("agent", "observe", json!({"sessionId":created_id})).await.unwrap();
        assert_eq!(observed["session"]["backend"], json!({"kind":"model","connectionId":fixture.selection["connectionId"],"modelId":"fixture-model-unknown","thinkingLevel":null}), "choosing the route must preserve its inherited provider-controlled policy");
        support::click_button(&mut view, "Choose model and effort").await;
        support::click_button(&mut view, "Choose reasoning effort").await;
        wait_view_state(&mut view, |view, _| model_menu_ready(view, "Use effort high") && model_menu_ready(view, "Back to model settings")).await;
        assert_effort_choices(&view, unknown_default, None);
        assert!(model_menu_button(&view, "Use provider settings").is_none());
        support::click_button(&mut view, "Use effort high").await;
        wait_view_state(&mut view, |view, screen| screen.contains("fixture-model-unknown · high") && model_menu_closed(view)).await;
        let observed = client.query("agent", "observe", json!({"sessionId":created_id})).await.unwrap();
        assert_eq!(observed["session"]["backend"]["thinkingLevel"], "high");
        support::click_button(&mut view, "Choose model and effort").await;
        support::click_button(&mut view, "Choose reasoning effort").await;
        wait_view_state(&mut view, |view, _| model_menu_ready(view, "Use provider settings") && model_menu_ready(view, "Back to model settings")).await;
        assert_effort_choices(&view, unknown_default, Some("high"));
        support::click_button(&mut view, "Use provider settings").await;
        wait_view_state(&mut view, |view, screen| screen.contains("Provider controlled") && model_trigger_caption(view, "fixture-model-unknown", "Provider controlled") && model_menu_closed(view)).await;
        let observed = client.query("agent", "observe", json!({"sessionId":created_id})).await.unwrap();
        assert_eq!(observed["session"]["backend"], json!({"kind":"model","connectionId":fixture.selection["connectionId"],"modelId":"fixture-model-unknown","thinkingLevel":null}), "resetting provider control must clear the saved override while preserving its route");
        assert_eq!(fixture.request_count.load(Ordering::SeqCst), 0);
        support::click_button(&mut view, "Choose model and effort").await;
        support::click_button(&mut view, "Choose model").await;
        wait_focused_input(&mut view, "Search models").await;
        wait_view(&mut view, |screen| screen.contains("fixture-model-alt") && !screen.contains("Loading…")).await;
        support::click_label(&mut view, "Use fixture-model-alt · NSH fixture");
        wait_view_state(&mut view, |view, screen| screen.contains("fixture-model-alt · high") && model_menu_closed(view)).await;
        support::click_label(&mut view, "Choose model and effort");
        wait_view_state(&mut view, |view, _| model_menu_ready(view, "Choose reasoning effort") && model_menu_ready(view, "Close model selection")).await;
        wait_enabled_node(&mut view, "Choose reasoning effort").await;
        support::click_label(&mut view, "Choose reasoning effort");
        wait_view_state(&mut view, |view, _| model_menu_ready(view, "Back to model settings") && model_menu_ready(view, "Use effort high")).await;
        assert_effort_choices(&view, alternative, None);
        support::click_label(&mut view, "Use effort off");
        wait_view_state(&mut view, |view, screen| screen.contains("fixture-model-alt · off") && model_menu_closed(view)).await;
        let observed = client.query("agent", "observe", json!({"sessionId":created_id})).await.unwrap();
        assert_eq!(observed["session"]["backend"], json!({"kind":"model","connectionId":fixture.selection["connectionId"],"modelId":"fixture-model-alt","thinkingLevel":"off"}));
        assert_eq!(view.surface().focused(), Some(model_trigger));
        tab_to_label(&mut view, "Message composer").await;
        assert_eq!(view.surface().focused(), Some(created_editor));
        // Tab entry preserves the multiline composer's original caret, just as
        // menu restoration above does.
        assert_eq!(view.surface().input_context().unwrap().selection, caret);
        assert_eq!(view.surface().input_context().unwrap().text.as_deref(), Some("Message B uses the selected model"));
        support::wait_draft(&client, &created_id, "Message B uses the selected model").await;
        assert_eq!(fixture.request_count.load(Ordering::SeqCst), 0);

        shortcut(&mut view, 'o');
        select_palette(&mut view, "Search sessions…", "NSH real", "NSH real Agent").await;
        wait_editable_composer(&mut view).await;
        let restored = wait_view(&mut view, |screen| screen.contains("NSH real Agent") && screen.contains("Draft A stays in its own conversation")).await;
        assert!(!restored.contains("Message B uses the selected model"));
        evidence("workbench-draft-after-switch", &restored);
        support::evidence_cells("workbench-draft-after-switch", &view);
        shortcut(&mut view, 'o');
        select_palette(&mut view, "Search sessions…", "New conversation", "New conversation").await;
        wait_view(&mut view, |screen| screen.contains("New conversation") && screen.contains("Message B uses the selected model")).await;
        wait_editable_composer(&mut view).await;
        support::wait_enabled_button(&mut view, "Send message").await;
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)));
        let mut request = fixture.next_request().await;
        assert_eq!(request.body["model"], "fixture-model-alt");
        assert_eq!(request.body["reasoning_effort"], "none");
        assert!(request.body["messages"].as_array().unwrap().iter().any(|message| message["role"] == "user" && message["content"].to_string().contains("Message B uses the selected model")));
        assert!(!request.body.to_string().contains("Draft A stays in its own conversation"));
        request.delta("REAL_WORKBENCH_RUN_TO_STOP").await;
        let writing = wait_view(&mut view, |screen| screen.contains("REAL_WORKBENCH_RUN_TO_STOP") && screen.contains("Writing response")).await;
        assert_eq!(writing.matches("REAL_WORKBENCH_RUN_TO_STOP").count(), 1);
        support::evidence_cells("workbench-streaming", &view);
        request.tool_prefix("todo_write", "{\"todos\":[").await;
        let preparing = wait_view(&mut view, |screen| screen.contains("Preparing tool · todo_write · {\"todos\":[")).await;
        evidence("workbench-tool-input-before-stop", &preparing);
        support::evidence_cells("workbench-tool-input-before-stop", &view);
        let observed = client.query("agent", "observe", json!({"sessionId":created_id})).await.unwrap();
        let invocation = observed["run"]["invocationId"].as_str().filter(|id| !id.is_empty()).unwrap();

        // A visible browser never takes the composer's native Enter or arrow
        // handling. Native Tab into a browser Button scopes Escape without a
        // JS focus mirror, and Enter must still activate that exact Button.
        shortcut(&mut view, 'o');
        wait_view(&mut view, |screen| screen.contains("All workspaces")).await;
        wait_focused_input(&mut view, "Search session titles").await;
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::BackTab, KeyModifiers::SHIFT)));
        assert!(view.accessibility_snapshot().iter().any(|node| node.focused && node.label == "Choose workspace scope"));
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)));
        wait_view(&mut view, |screen| screen.contains("Choose a workspace below")).await;
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)));
        wait_view(&mut view, |screen| screen.contains("All workspaces") && !screen.contains("Choose a workspace below")).await;
        tab_to_label(&mut view, "New conversation").await;
        // The resize decision uses native subtree focus, including Tabbed
        // Buttons that never emitted an application focus callback.
        view.resize(80, 24);
        let transferred = wait_view(&mut view, |screen| screen.contains("All workspaces")).await;
        wait_focused_input(&mut view, "Search session titles").await;
        assert!(!view.accessibility_snapshot().iter().any(|node| node.label == "Narrower session browser"));
        evidence("workbench-focused-browser-transfers-to-dialog", &transferred);
        support::evidence_cells("workbench-focused-browser-transfers-to-dialog", &view);
        view.resize(120, 40);
        wait_enabled_node(&mut view, "Narrower session browser").await;
        wait_view(&mut view, |screen| screen.contains("All workspaces")).await;
        wait_focused_input(&mut view, "Search session titles").await;
        tab_to_label(&mut view, "New conversation").await;
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)));
        wait_view(&mut view, |screen| !screen.contains("All workspaces") && screen.contains("Preparing tool · todo_write")).await;

        view.resize(80, 24);
        // Resize publishes the new viewport and device environment asynchronously.
        // Compare both Headers after that same native layout has committed.
        let (done, resized) = tokio::sync::oneshot::channel();
        view.control().unwrap().advance_clock(Duration::ZERO, move || { let _ = done.send(()); });
        resized.await.expect("the Header resize did not commit");
        let collapsed_toggle = support::wait_enabled_button(&mut view, "Expand session browser").await.frame;
        let header_search = support::wait_enabled_button(&mut view, "Search sessions").await.frame;
        support::click_button(&mut view, "Search sessions").await;
        let narrow_browser = wait_view(&mut view, |screen| screen.contains("All workspaces")).await;
        wait_focused_input(&mut view, "Search session titles").await;
        assert!(!view.accessibility_snapshot().iter().any(|node| node.label == "Close session browser"), "the dialog must use the same Header toggle without another sidebar control");
        assert_eq!(support::wait_enabled_button(&mut view, "Collapse session browser").await.frame, collapsed_toggle, "the foreground dialog must retain the Header toggle's position");
        assert_eq!(support::wait_enabled_button(&mut view, "Search sessions").await.frame, header_search, "search must remain in the same Header position while the browser is open");
        evidence("workbench-narrow-session-dialog", &narrow_browser);
        support::evidence_cells("workbench-narrow-session-dialog", &view);
        support::click_button(&mut view, "Collapse session browser").await;
        wait_view(&mut view, |screen| !screen.contains("All workspaces") && screen.contains("Preparing tool · todo_write")).await;
        support::click_button(&mut view, "Search sessions").await;
        wait_focused_input(&mut view, "Search session titles").await;
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)));
        wait_view(&mut view, |screen| !screen.contains("All workspaces") && screen.contains("Preparing tool · todo_write")).await;
        request.delta("BROWSER_ESCAPE_LEFT_THE_RUN_ALIVE").await;
        wait_view(&mut view, |screen| screen.contains("BROWSER_ESCAPE_LEFT_THE_RUN_ALIVE") && screen.contains("Preparing tool · todo_write")).await;
        let still_running = client.query("agent", "observe", json!({"sessionId":created_id})).await.unwrap();
        assert_eq!(still_running["run"]["invocationId"], invocation);
        assert_eq!(fixture.request_count.load(Ordering::SeqCst), 1);
        view.resize(120, 40);
        wait_view(&mut view, |screen| screen.contains("BROWSER_ESCAPE_LEFT_THE_RUN_ALIVE") && screen.contains("Preparing tool · todo_write")).await;
        shortcut(&mut view, 'p');
        select_palette(&mut view, "Search commands…", "Sto", "Stop").await;
        // The SSE is still held. Only the UI's exact-run Stop may cancel it.
        tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                let execution = client.query("agent", "execution", json!({"sessionId":created_id,"invocationId":invocation})).await.unwrap();
                if execution["execution"]["state"] == "cancelled" {
                    assert_eq!(execution["kind"], "found");
                    assert_eq!(execution["execution"]["invocationId"], invocation);
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        }).await.expect("the UI did not cancel its original execution");
        drop(request);
        fixture.idle(&client, &created_id).await;
        let stopped = wait_view(&mut view, |screen| screen.contains("Stopped") && screen.contains("REAL_WORKBENCH_RUN_TO_STOP") && !screen.contains("Preparing tool") && !screen.contains("Running tool")).await;
        assert_eq!(stopped.matches("REAL_WORKBENCH_RUN_TO_STOP").count(), 1);
        evidence("workbench-stopped-clears-tool-input", &stopped);
        support::evidence_cells("workbench-stopped-clears-tool-input", &view);
        assert_eq!(fixture.request_count.load(Ordering::SeqCst), 1);
        assert_eq!(client.load_draft("agent", &fixture.session, EDITOR).await.unwrap().unwrap().text, "Draft A stays in its own conversation");

        // The native search callback must deliver the complete original query
        // to the Host subscription, including a distinguishing final character.
        let long_query = format!("{}終", "界".repeat(257));
        let long_title = format!("LONG_QUERY_MATCH {long_query}");
        let long_created = support::mutate(&client, "create", json!({
            "title":long_title,"automaticTitle":false,"labels":[],
            "workspace":{"kind":"session","sessionId":fixture.session}
        })).await;
        assert_eq!(long_created["kind"], "created");
        assert_eq!(long_created["session"]["title"], long_title);
        shortcut(&mut view, 'o');
        wait_view(&mut view, |screen| screen.contains("All workspaces")).await;
        wait_focused_input(&mut view, "Search session titles").await;
        shortcut(&mut view, 'a');
        view.handle_event(Event::Paste(long_query.clone()));
        support::tick(&mut view);
        assert_eq!(view.surface().input_context().unwrap().text.as_deref(), Some(long_query.as_str()));
        wait_view(&mut view, |screen| screen.contains("LONG_QUERY_MATCH") && !screen.contains("Loading…")).await;
        assert!(view.accessibility_snapshot().iter().any(|node| node.label == format!("Open conversation {long_title}")));
        let missing_tail = format!("{}異", "界".repeat(257));
        shortcut(&mut view, 'a');
        view.handle_event(Event::Paste(missing_tail.clone()));
        support::tick(&mut view);
        assert_eq!(view.surface().input_context().unwrap().text.as_deref(), Some(missing_tail.as_str()));
        wait_view(&mut view, |screen| screen.contains("No matching conversations.") && !screen.contains("LONG_QUERY_MATCH") && !screen.contains("Loading…")).await;
        let original_search = view.surface().focused();
        support::click_button(&mut view, "Clear session search").await;
        wait_focused_input(&mut view, "Search session titles").await;
        assert_eq!(view.surface().focused(), original_search, "clearing must retain the resident search input");
        assert_eq!(view.surface().input_context().unwrap().text.as_deref(), Some(""));
        wait_view(&mut view, |screen| screen.contains("LONG_QUERY_MATCH") && !screen.contains("No matching conversations.") && !screen.contains("Loading…")).await;
        assert!(view.accessibility_snapshot().iter().all(|node| node.label != "Clear session search"));
        // Preserve the original keyboard-clear path after exercising the
        // mouse affordance through the same real title-search subscription.
        view.handle_event(Event::Paste(missing_tail.clone()));
        wait_view(&mut view, |screen| screen.contains("No matching conversations.") && !screen.contains("LONG_QUERY_MATCH") && !screen.contains("Loading…")).await;
        shortcut(&mut view, 'a');
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::Backspace, KeyModifiers::NONE)));
        wait_view(&mut view, |screen| screen.contains("LONG_QUERY_MATCH") && !screen.contains("No matching conversations.") && !screen.contains("Loading…")).await;
        support::click_button(&mut view, "Collapse session browser").await;
        wait_editable_composer(&mut view).await;
        wait_view(&mut view, |screen| !screen.contains("No matching conversations.") && !screen.contains("All workspaces")).await;

        // The target belongs to the Host's second matching page. Physical
        // wheel scrolling must obtain it without a manual continuation action.
        for index in 0..33 {
            let created = support::mutate(&client, "create", json!({
                "title":format!("Browser page {index:02}"),"automaticTitle":false,"labels":[],
                "workspace":{"kind":"session","sessionId":fixture.session}
            })).await;
            assert_eq!(created["kind"], "created");
        }
        let first_page = client.query("agent", "list", json!({"filter":"all","scope":{"kind":"all"},"titleQuery":"Browser page","position":{"kind":"start"}})).await.unwrap();
        assert_eq!(first_page["sessions"].as_array().unwrap().len(), 32);
        let next_page = client.query("agent", "list", json!({"filter":"all","scope":{"kind":"all"},"titleQuery":"Browser page","position":{"kind":"after","revision":first_page["revision"],"cursor":first_page["after"]}})).await.unwrap();
        let target = &next_page["sessions"][0];
        let target_title = target["title"].as_str().unwrap();
        let target_id = target["id"].as_str().unwrap();
        assert!(!first_page["sessions"].as_array().unwrap().iter().any(|session| session["id"] == target_id));
        shortcut(&mut view, 'o');
        wait_focused_input(&mut view, "Search session titles").await;
        view.handle_event(Event::Paste("Browser page".into()));
        assert_eq!(view.surface().input_context().unwrap().text.as_deref(), Some("Browser page"));
        // The unfiltered catalog can already contain first_title. Settle the
        // queued change handler before accepting that row for the new query,
        // using the same native barrier as select_palette above.
        let (done, committed) = tokio::sync::oneshot::channel();
        view.control().unwrap().advance_clock(Duration::ZERO, move || { let _ = done.send(()); });
        tokio::time::timeout(Duration::from_secs(20), committed).await.expect("the browser query did not commit").expect("the browser engine stopped");
        let first_title = first_page["sessions"][0]["title"].as_str().unwrap();
        wait_view(&mut view, |screen| screen.contains(first_title) && !screen.contains("Loading…")).await;
        tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                support::tick(&mut view);
                let screen = view.snapshot();
                if screen.contains(target_title) {
                    break;
                }
                let row = first_page["sessions"].as_array().unwrap().iter()
                    .filter_map(|session| session["title"].as_str())
                    .find(|title| screen.contains(title))
                    .unwrap_or_else(|| panic!("the browser must show a matching session row before its next page; app error: {:?}\n{}", view.last_error(), screen));
                support::scroll_text(&mut view, row, MouseEventKind::ScrollDown);
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        }).await.expect("native browser scrolling did not load the second Host page");
        support::evidence_cells("workbench-automatic-browser-pagination", &view);

        // Read at the end before a real external metadata commit. Renaming
        // preserves this session's ID, timestamp and query membership, so a
        // catalog revision must not remove the tail or move its screen row.
        support::scroll_text(&mut view, target_title, MouseEventKind::ScrollDown);
        support::tick(&mut view);
        let tail_y = view.accessibility_snapshot().into_iter()
            .find(|node| node.label == format!("Open conversation {target_title}"))
            .unwrap().frame.origin.y.0;
        let original = client.query("agent", "observe", json!({"sessionId":target_id})).await.unwrap();
        let updated_title = format!("{target_title} v2");
        let renamed = support::mutate(&client, "metadata", json!({
            "sessionId":target_id,"expectedRevision":original["session"]["revision"],
            "title":updated_title,"labels":original["session"]["labels"]
        })).await;
        assert_eq!(renamed["kind"], "committed");
        assert_eq!(renamed["session"]["id"], target_id);
        assert_eq!(renamed["session"]["updatedAt"], original["session"]["updatedAt"]);
        // A new title proves the new revision reached this UI. No wheel or
        // other navigation action is allowed to recover the original row.
        wait_view(&mut view, |screen| screen.contains(&updated_title)).await;
        let tail_after = view.accessibility_snapshot().into_iter()
            .find(|node| node.label == format!("Open conversation {updated_title}"))
            .unwrap().frame.origin.y.0;
        assert_eq!(tail_after, tail_y);
        support::evidence_cells("workbench-browser-revision-preserves-tail", &view);
        let target_title = updated_title.as_str();
        support::click_text(&mut view, &format!("Open conversation {target_title}"));
        wait_view(&mut view, |screen| screen.lines().any(|line| line.contains("Commands") && line.contains(target_title))).await;
        assert_eq!(view.surface().input_context().unwrap().text.as_deref(), Some(""));
        assert_eq!(client.load_draft("agent", &fixture.session, EDITOR).await.unwrap().unwrap().text, "Draft A stays in its own conversation");
        assert_eq!(fixture.request_count.load(Ordering::SeqCst), 1);
        drop(view);
        bindings.close().await.unwrap();
        fixture.finish().await;
    }).await.expect("real Host workbench navigation timed out");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn workspace_folders_page_navigate_and_reject_replaced_directory_authority() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let fixture = Fixture::open().await;
        let workspace = fixture.directory.path().join("workspace");
        for index in 0..36 {
            std::fs::create_dir(workspace.join(format!("ascii-{index:02}"))).unwrap();
        }
        let child_path = workspace.join("中文工程/子目录");
        std::fs::create_dir_all(&child_path).unwrap();
        let client = fixture.client().await;
        let roots = client.query("agent", "directories", json!({"kind":"roots"})).await.unwrap();
        let first = client.query("agent", "directories", json!({"kind":"children","selection":roots["roots"][0]["selection"],"after":null})).await.unwrap();
        assert_eq!(first["children"].as_array().unwrap().len(), 32);
        assert!(!first["children"].as_array().unwrap().iter().any(|entry| entry["name"] == "中文工程"));
        let second = client.query("agent", "directories", json!({"kind":"children","selection":roots["roots"][0]["selection"],"after":first["after"]})).await.unwrap();
        let project = second["children"].as_array().unwrap().iter().find(|entry| entry["name"] == "中文工程").unwrap().clone();
        let old_child_page = client.query("agent", "directories", json!({"kind":"children","selection":project["selection"],"after":null})).await.unwrap();
        let old_identity = old_child_page["children"][0]["selection"]["directoryIdentity"].clone();
        const DRAFT: &str = "ORIGINAL_FOLDER_DRAFT_你好";
        client.save_draft("agent", &fixture.session, EDITOR, None, DRAFT.into()).await.unwrap();
        let gate = ReplyGate::directories(fixture.directory.path(), fixture.address.clone());
        let gated = fixture.client_at(&gate.address).await;
        let (mut view, bindings) = fixture.view(gated, Some(fixture.session.clone()));
        view.resize(120, 40);
        wait_view(&mut view, |screen| screen.contains(DRAFT)).await;
        wait_focused_input(&mut view, "Message composer").await;
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::Left, KeyModifiers::NONE)));
        let editor = view.surface().focused().unwrap();
        let selection = view.surface().input_context().unwrap().selection;

        open_workspace_picker(&mut view).await;
        wait_enabled_node(&mut view, "Browse folder Workspace").await;
        gate.arm();
        support::click_label(&mut view, "Browse folder Workspace");
        wait_view(&mut view, |screen| screen.contains("Folder · Workspace") && screen.contains("Loading folders…")).await;
        tokio::time::timeout(Duration::from_secs(20), gate.held.notified()).await.expect("the real child-directory reply did not reach its gate");
        assert!(view.accessibility_snapshot().iter().find(|node| node.label == "Use this workspace folder").unwrap().state.disabled);
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::Enter, KeyModifiers::CONTROL)));
        support::click_label(&mut view, "Use this workspace folder");
        assert_eq!(client.query("agent", "list", json!({"filter":"all","position":{"kind":"start"}})).await.unwrap()["sessions"].as_array().unwrap().len(), 1);
        support::click_label(&mut view, "Workspace locations");
        wait_enabled_node(&mut view, "Browse folder Workspace").await;
        gate.release();
        browse_workspace_folder(&mut view, "Workspace").await;
        // A Chinese match after the first 32 real Host children must load
        // automatically; Enter only browses, never creates a conversation.
        browse_workspace_folder(&mut view, "中文工程").await;
        browse_workspace_folder(&mut view, "子目录").await;
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::Up, KeyModifiers::ALT)));
        wait_enabled_node(&mut view, "Browse folder 子目录").await;
        for (columns, rows) in [(80, 24), (120, 40)] {
            view.resize(columns, rows);
            wait_view(&mut view, |screen| screen.contains("Folder · 中文工程") && screen.contains("子目录")).await;
            support::wait_enabled_button(&mut view, "Use this workspace folder").await;
            wait_focused_input(&mut view, "Search workspace folders").await;
        }
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)));
        wait_focused_input(&mut view, "Message composer").await;
        assert_eq!(view.surface().focused(), Some(editor));
        let restored = view.surface().input_context().unwrap();
        assert_eq!(restored.text.as_deref(), Some(DRAFT));
        assert_eq!(restored.selection, selection);

        open_workspace_picker(&mut view).await;
        for name in ["Workspace", "中文工程", "子目录"] {
            browse_workspace_folder(&mut view, name).await;
        }
        // Keep the observed inode alive under another name, then replace
        // its path. The original opaque selection must not retarget it.
        std::fs::rename(&child_path, workspace.join("retired-child")).unwrap();
        std::fs::create_dir(&child_path).unwrap();
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::Enter, KeyModifiers::CONTROL)));
        wait_view(&mut view, |screen| screen.contains("workspace_unavailable") && screen.contains(DRAFT)).await;
        assert_eq!(client.query("agent", "list", json!({"filter":"all","position":{"kind":"start"}})).await.unwrap()["sessions"].as_array().unwrap().len(), 1);
        wait_focused_input(&mut view, "Message composer").await;
        assert_eq!(view.surface().focused(), Some(editor));
        assert_eq!(view.surface().input_context().unwrap().selection, selection);

        let fresh_page = client.query("agent", "directories", json!({"kind":"children","selection":project["selection"],"after":null})).await.unwrap();
        let fresh_child = fresh_page["children"].as_array().unwrap().iter().find(|entry| entry["name"] == "子目录").unwrap();
        assert_ne!(fresh_child["selection"]["directoryIdentity"], old_identity);
        open_workspace_picker(&mut view).await;
        for name in ["Workspace", "中文工程", "子目录"] {
            browse_workspace_folder(&mut view, name).await;
        }
        support::click_label(&mut view, "Use this workspace folder");
        wait_focused_input(&mut view, "Search models").await;
        let catalog = client.query("agent", "list", json!({"filter":"all","position":{"kind":"start"}})).await.unwrap();
        let sessions = catalog["sessions"].as_array().unwrap();
        assert_eq!(sessions.len(), 2);
        let created = sessions.iter().find(|session| session["id"] != fixture.session).unwrap();
        assert_eq!(created["workspace"]["path"], fresh_child["path"]);
        assert_eq!(
            std::fs::canonicalize(created["workspace"]["path"].as_str().unwrap()).unwrap(),
            child_path.canonicalize().unwrap()
        );
        assert_eq!(created["workspace"]["directoryIdentity"], fresh_child["selection"]["directoryIdentity"]);
        let created_id = created["id"].as_str().unwrap();
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)));
        wait_enabled_node(&mut view, "Close model selection").await;
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)));
        wait_editable_composer(&mut view).await;
        assert_ne!(view.surface().focused(), Some(editor));
        assert_eq!(view.surface().input_context().unwrap().text.as_deref(), Some(""));
        view.handle_event(Event::Paste("NEW_FOLDER_DRAFT".into()));
        support::wait_draft(&client, created_id, "NEW_FOLDER_DRAFT").await;
        support::wait_draft(&client, &fixture.session, DRAFT).await;
        // An empty selected session keeps its actual workspace chip interactive.
        // Pointer-opened dialogs return to that opener while preserving the draft.
        support::click_button(&mut view, "Choose composer workspace").await;
        wait_focused_input(&mut view, "Search workspace folders").await;
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)));
        wait_view_state(&mut view, |view, screen| screen.contains("NEW_FOLDER_DRAFT") && view.accessibility_snapshot().iter().any(|node| node.role == nsh_core::AccessibilityRole::Button && node.label == "Choose composer workspace" && node.focused)).await;
        assert_eq!(fixture.request_count.load(Ordering::SeqCst), 0);
        support::evidence_cells("workspace-picker-deep-directory-and-draft-isolation", &view);
        drop(view);
        bindings.close().await.unwrap();
        client.close().await.unwrap();
        drop(gate);
        fixture.finish().await;
    }).await.expect("real Host workspace folder selection timed out");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_resident_composer_keeps_its_session_editor_and_isolates_native_undo() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let mut fixture = Fixture::open().await;
        let client = fixture.client().await;
        let roots = client
            .query("agent", "directories", json!({"kind":"roots"}))
            .await
            .unwrap();
        let root = &roots["roots"][0];
        let root_name = root["name"].as_str().unwrap();
        let (mut view, bindings) = fixture.view(client.clone(), None);
        wait_view(&mut view, |screen| {
            screen.contains("Make something remarkable.")
                && screen.contains("Choose a workspace to begin…")
        })
        .await;
        assert_eq!(
            view.accessibility_snapshot()
                .iter()
                .filter(|node| node.label == "Message composer")
                .count(),
            1
        );
        tab_to_label(&mut view, "Choose workspace from composer card").await;
        view.handle_event(Event::Paste("COLD_INPUT_MUST_STAY_INERT".into()));
        assert!(view.surface().input_context().is_none());
        assert!(!view.snapshot().contains("COLD_INPUT_MUST_STAY_INERT"));
        assert_eq!(fixture.request_count.load(Ordering::SeqCst), 0);
        support::evidence_cells("resident-composer-cold-start", &view);

        // The readonly placeholder and the card's keyboard target both open
        // the original picker; neither creates a session just by opening it.
        support::click_text(&mut view, "Message composer");
        wait_view(&mut view, |screen| screen.contains("Search workspaces…")).await;
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)));
        wait_view(&mut view, |screen| {
            screen.contains("Choose a workspace to begin…")
        })
        .await;
        for key in [KeyCode::Enter, KeyCode::Char(' ')] {
            tab_to_label(&mut view, "Choose workspace from composer card").await;
            view.handle_event(Event::Key(KeyEvent::new(key, KeyModifiers::NONE)));
            wait_view(&mut view, |screen| screen.contains("Search workspaces…")).await;
            view.handle_event(Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)));
            wait_view(&mut view, |screen| {
                screen.contains("Choose a workspace to begin…")
            })
            .await;
        }

        support::click_text(&mut view, "Choose composer workspace");
        select_palette(&mut view, "Search workspaces…", root_name, root_name).await;
        wait_enabled_node(&mut view, "Use this workspace folder").await;
        assert_eq!(
            client
                .query(
                    "agent",
                    "list",
                    json!({"filter":"all","position":{"kind":"start"}})
                )
                .await
                .unwrap()["sessions"]
                .as_array()
                .unwrap()
                .len(),
            1,
            "opening a folder must not create a conversation"
        );
        support::click_label(&mut view, "Use this workspace folder");
        wait_view(&mut view, |screen| screen.contains("Search models…")).await;
        assert!(
            !view
                .accessibility_snapshot()
                .iter()
                .any(|node| node.focused && node.label == "Message composer"),
            "the new resident editor must not steal an open model menu's focus"
        );
        let catalog = client
            .query(
                "agent",
                "list",
                json!({"filter":"all","position":{"kind":"start"}}),
            )
            .await
            .unwrap();
        let sessions = catalog["sessions"].as_array().unwrap();
        assert_eq!(sessions.len(), 2);
        let created = sessions
            .iter()
            .find(|session| session["id"] != fixture.session)
            .unwrap();
        let created_id = created["id"].as_str().unwrap().to_owned();
        assert_eq!(created["workspace"]["path"], root["path"]);
        select_palette(
            &mut view,
            "Search models…",
            "model-alt",
            "fixture-model-alt",
        )
        .await;
        wait_view_state(&mut view, |view, screen| {
            screen.contains("fixture-model-alt") && model_menu_closed(view)
        })
        .await;
        wait_editable_composer(&mut view).await;
        let editor = view.surface().focused().unwrap();
        assert!(
            view.accessibility_snapshot()
                .iter()
                .any(|node| node.id == editor && node.label == "Message composer")
        );
        view.handle_event(Event::Paste("RESIDENT_FIRST_MESSAGE".into()));
        support::wait_draft(&client, &created_id, "RESIDENT_FIRST_MESSAGE").await;

        // Card padding restores the same native editor and its interior caret.
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::Left, KeyModifiers::NONE)));
        let selection = view.surface().input_context().unwrap().selection;
        tab_to_label(&mut view, "Open commands").await;
        assert_ne!(view.surface().focused(), Some(editor));
        support::click_label(&mut view, "Focus message composer");
        wait_focused_input(&mut view, "Message composer").await;
        assert_eq!(view.surface().focused(), Some(editor));
        assert_eq!(view.surface().input_context().unwrap().selection, selection);
        view.handle_event(Event::Paste("你好".into()));
        support::wait_draft(&client, &created_id, "RESIDENT_FIRST_MESSAG你好E").await;
        for _ in 0..2 {
            view.handle_event(Event::Key(KeyEvent::new(
                KeyCode::Backspace,
                KeyModifiers::NONE,
            )));
        }
        support::wait_draft(&client, &created_id, "RESIDENT_FIRST_MESSAGE").await;
        assert_eq!(view.surface().focused(), Some(editor));
        assert_eq!(view.surface().input_context().unwrap().selection, selection);
        assert_eq!(fixture.request_count.load(Ordering::SeqCst), 0);
        // Opening and cancelling a model choice cannot replace this editor,
        // discard its draft, or move a native caret that is inside the text.
        shortcut(&mut view, 'g');
        wait_view_state(&mut view, |view, _| {
            model_menu_ready(view, "Choose model")
                && model_menu_button(view, "Choose reasoning effort").is_none()
                && model_menu_ready(view, "Close model selection")
        })
        .await;
        support::click_label(&mut view, "Choose model");
        wait_view(&mut view, |screen| screen.contains("Search models…")).await;
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)));
        wait_view_state(&mut view, |view, _| {
            model_menu_ready(view, "Choose model")
                && model_menu_button(view, "Choose reasoning effort").is_none()
                && model_menu_ready(view, "Close model selection")
                && model_menu_button(view, "Back to model settings").is_none()
        })
        .await;
        assert!(
            view.accessibility_snapshot()
                .iter()
                .any(|node| node.focused && node.label == "Choose model")
        );
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)));
        wait_view_state(&mut view, |view, screen| {
            screen.contains("RESIDENT_FIRST_MESSAGE") && model_menu_closed(view)
        })
        .await;
        assert_eq!(view.surface().focused(), Some(editor));
        assert_eq!(view.surface().input_context().unwrap().selection, selection);
        support::wait_enabled_button(&mut view, "Send message").await;
        view.handle_event(Event::Key(KeyEvent::new(
            KeyCode::Enter,
            KeyModifiers::NONE,
        )));
        let mut request = fixture.next_request().await;
        assert_eq!(request.body["model"], "fixture-model-alt");
        assert_eq!(
            request.body["messages"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|message| message["role"] == "user"
                    && message["content"]
                        .to_string()
                        .contains("RESIDENT_FIRST_MESSAGE"))
                .count(),
            1
        );
        request.delta("RESIDENT_FIRST_ANSWER").await;
        request.finish().await;
        fixture.idle(&client, &created_id).await;
        wait_view(&mut view, |screen| {
            screen.contains("RESIDENT_FIRST_ANSWER")
                && !screen.contains("Make something remarkable.")
        })
        .await;
        assert!(
            view.accessibility_snapshot()
                .iter()
                .any(|node| node.id == editor && node.label == "Message composer"),
            "hero-to-history must keep the same native editor"
        );
        assert_eq!(fixture.request_count.load(Ordering::SeqCst), 1);
        support::evidence_cells("resident-composer-first-answer", &view);

        // Equal draft strings still have different native editing owners.
        // Leave a real undo entry behind while the source draft is empty.
        support::click_text(&mut view, "Message composer");
        view.handle_event(Event::Paste("PREVIOUS_SESSION_UNDO_MUST_NOT_ESCAPE".into()));
        view.handle_event(Event::Key(KeyEvent::new(
            KeyCode::Char('a'),
            KeyModifiers::CONTROL,
        )));
        view.handle_event(Event::Key(KeyEvent::new(
            KeyCode::Backspace,
            KeyModifiers::NONE,
        )));
        support::wait_draft(&client, &created_id, "").await;
        shortcut(&mut view, 'o');
        select_palette(&mut view, "Search sessions…", "NSH real", "NSH real Agent").await;
        wait_view(&mut view, |screen| {
            screen
                .lines()
                .any(|line| line.contains("Commands") && line.contains("NSH real Agent"))
                && !screen.contains("Close")
        })
        .await;
        wait_focused_input(&mut view, "Message composer").await;
        assert_ne!(
            view.surface().focused(),
            Some(editor),
            "a different session must own a fresh native undo history"
        );
        assert_eq!(
            view.surface().input_context().unwrap().text.as_deref(),
            Some("")
        );
        view.handle_event(Event::Key(KeyEvent::new(
            KeyCode::Char('z'),
            KeyModifiers::CONTROL,
        )));
        support::tick(&mut view);
        assert_eq!(
            view.surface().input_context().unwrap().text.as_deref(),
            Some("")
        );
        assert!(
            client
                .load_draft("agent", &fixture.session, EDITOR)
                .await
                .unwrap()
                .is_none(),
            "native undo in an untouched session must not write a draft"
        );
        assert_eq!(
            client
                .load_draft("agent", &created_id, EDITOR)
                .await
                .unwrap()
                .unwrap()
                .text,
            ""
        );
        assert_eq!(fixture.request_count.load(Ordering::SeqCst), 1);
        support::evidence_cells("resident-composer-session-undo-isolation", &view);
        drop(view);
        bindings.close().await.unwrap();
        fixture.finish().await;
    })
    .await
    .expect("the resident composer workflow timed out");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn real_agent_history_and_live_stream_render_and_the_app_sends_once() {
    // Later phases browse the outer history explicitly. Hit visible transcript
    // text with the existing physical wheel helper, never the focused List.
    async fn wheel_history_up_to(view: &mut AppView, marker: &str) -> String {
        let started = std::time::Instant::now();
        loop {
            support::tick(view);
            let screen = view.snapshot();
            if screen.contains(marker) {
                return screen;
            }
            assert!(
                started.elapsed() < Duration::from_secs(20),
                "history wheel did not reveal {marker:?}:\n{screen}"
            );
            // Exclude the fixed checklist's
            // NATIVE_TODO labels so the pointer always hits transcript content.
            let text = screen
                .lines()
                .find_map(|line| {
                    [
                        "History ",
                        "NATIVE_THINK_SOURCE_",
                        "NATIVE_ACTIVITY_HEADER_",
                        "TITLE_",
                        "NATIVE_INTERMEDIATE_RESPONSE_OUTSIDE_PROCESS",
                        "REAL_PROVIDER_STREAM_VISIBLE",
                        "NEXT_MESSAGE_AFTER_COMPLETED_PROCESS",
                        "SECOND_TURN_FINAL",
                        "todo_write",
                        "Completed",
                    ]
                    .into_iter()
                    .find(|marker| line.contains(*marker))
                })
                .expect("the viewport must contain painted fixture transcript text");
            support::scroll_snapshot_text(view, &screen, text, MouseEventKind::ScrollUp);
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }
    async fn commit_native_events(view: &AppView) {
        let (done, committed) = tokio::sync::oneshot::channel();
        view.control()
            .unwrap()
            .advance_clock(Duration::ZERO, move || {
                let _ = done.send(());
            });
        committed.await.unwrap();
    }
    async fn focus_history(view: &mut AppView) {
        let composer = view.surface().focused();
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::Up, KeyModifiers::ALT)));
        commit_native_events(view).await;
        wait_view_state(view, |view, _| {
            view.surface().focused().is_some()
                && view.surface().focused() != composer
                && view.surface().input_context().is_none()
                && !view.surface().animating()
        })
        .await;
    }
    tokio::time::timeout(Duration::from_secs(120), async {
        let mut fixture = Fixture::open().await;
        fixture.seed_history(16).await;
        let client = fixture.client().await;
        let observed = client.query("agent", "observe", json!({"sessionId":fixture.session})).await.unwrap();
        let tail = client.query("agent", "history", json!({"sessionId":fixture.session,"through":observed["through"],"position":{"kind":"tail"},"view":"conversation"})).await.unwrap();
        assert!(!tail["before"].is_null(), "the original history must exceed one page");

        // One physical Home must reach the canonical beginning, including pages
        // which this fresh mount has never loaded. Keep its unsent draft intact.
        const HOME_DRAFT: &str = "HISTORY_HOME_UNSENT_你好";
        let home_client = fixture.client().await;
        let (mut home, home_bindings) = fixture.view(home_client.clone(), Some(fixture.session.clone()));
        wait_editable_composer(&mut home).await;
        home.handle_event(Event::Paste(HOME_DRAFT.into()));
        support::wait_draft(&home_client, &fixture.session, HOME_DRAFT).await;
        wait_view(&mut home, |screen| screen.contains("History 15 paragraph")).await;
        focus_history(&mut home).await;
        home.handle_event(Event::Key(KeyEvent::new(KeyCode::Home, KeyModifiers::CONTROL)));
        let beginning = wait_view(&mut home, |screen| screen.contains("History question 00") && screen.contains("History 00 paragraph 00")).await;
        assert!(beginning.lines().position(|line| line.contains("History question 00"))
            < beginning.lines().position(|line| line.contains("History 00 paragraph 00")));
        assert!(!beginning.contains("Load earlier messages"));
        support::wait_draft(&home_client, &fixture.session, HOME_DRAFT).await;
        evidence("history-home-canonical-beginning", &beginning);
        drop(home);
        home_bindings.close().await.unwrap();

        // Identify the actual final page using the same immutable Host fence.
        // The gate withholds that real reply, not a fabricated history result.
        let mut final_cursor = tail["before"].clone();
        let final_page = loop {
            let page = client.query("agent", "history", json!({"sessionId":fixture.session,"through":observed["through"],"position":{"kind":"before","cursor":final_cursor},"view":"conversation"})).await.unwrap();
            if page["before"].is_null() { break page; }
            final_cursor = page["before"].clone();
        };
        let boundary = final_page["chunks"].as_array().unwrap().iter().rev()
            .find(|chunk| chunk["role"] == "assistant" && chunk["field"] == "body").unwrap();
        let added = boundary["text"].as_str().unwrap();
        let boundary_turn = (0..16).find(|turn| added.contains(&format!("History {turn:02} paragraph 00"))).unwrap();
        let added_marker = format!("History {boundary_turn:02} paragraph 00");
        let wheel_marker = format!("History {:02} paragraph 01", boundary_turn + 1);
        let boundary_tail = format!("History {boundary_turn:02} paragraph 29:");
        let gate = ReplyGate::before_history(fixture.directory.path(), fixture.address.clone(), final_cursor);
        let cancel_client = fixture.client_at(&gate.address).await;
        let (mut cancelled, cancel_bindings) = fixture.view(cancel_client.clone(), Some(fixture.session.clone()));
        wait_editable_composer(&mut cancelled).await;
        assert_eq!(cancelled.surface().input_context().unwrap().text.as_deref(), Some(HOME_DRAFT));
        wait_view(&mut cancelled, |screen| screen.contains("History 15 paragraph")).await;
        assert!(!cancelled.accessibility_snapshot().iter().any(|node| node.label.contains(&added_marker)));
        gate.arm();
        focus_history(&mut cancelled).await;
        cancelled.handle_event(Event::Key(KeyEvent::new(KeyCode::Home, KeyModifiers::CONTROL)));
        gate.held.notified().await;
        // Repeating Home moves to the now-loaded prefix while joining the same
        // held older read. A wheel then owns the viewport, even at this boundary.
        cancelled.handle_event(Event::Key(KeyEvent::new(KeyCode::Home, KeyModifiers::CONTROL)));
        commit_native_events(&cancelled).await;
        let local_start = wait_view_state(&mut cancelled, |view, screen| !view.surface().animating() && screen.contains("History ")).await;
        support::scroll_snapshot_text(&mut cancelled, &local_start, "History ", MouseEventKind::ScrollDown);
        let scrolling = std::time::Instant::now();
        loop {
            support::tick(&mut cancelled);
            let screen = cancelled.snapshot();
            if screen.contains(&wheel_marker) { break; }
            assert!(scrolling.elapsed() < Duration::from_secs(20), "the cancelling wheel did not reach its adjacent complete row:\n{screen}");
            support::scroll_snapshot_text(&mut cancelled, &screen, "History ", MouseEventKind::ScrollDown);
            tokio::task::yield_now().await;
        }
        commit_native_events(&cancelled).await;
        let wheel = wait_view_state(&mut cancelled, |view, screen| !view.surface().animating() && screen.contains(&wheel_marker)).await;
        let wheel_row = wheel.lines().position(|line| line.contains(&wheel_marker)).unwrap();
        let reading_row = wheel.lines().position(|line| line.contains(&boundary_tail)).unwrap();
        assert!(!cancelled.accessibility_snapshot().iter().any(|node| node.label.contains(&added_marker)));
        assert!(cancelled.accessibility_snapshot().iter().any(|node| node.label.contains(&boundary_tail) && node.label.contains("**bold**")), "the held prefix must still leave the reading source literal");
        evidence("history-home-wheel-before-final-page", &wheel);
        evidence("history-home-wheel-before-final-page-ax", &format!("{:#?}", cancelled.accessibility_snapshot()));
        support::evidence_cells("history-home-wheel-before-final-page", &cancelled);
        gate.release();
        // The completed prefix either mounts its first paragraph or formats
        // the visible original tail. Both prove a real native publication;
        // virtualized paragraphs outside the reader need not be mounted.
        let retained = wait_view_state(&mut cancelled, |view, _| view.accessibility_snapshot().iter().any(|node| node.label.contains(&added_marker) || (node.label.starts_with(&boundary_tail) && !node.label.contains("**bold**")))).await;
        evidence("history-home-wheel-final-page-published", &retained);
        evidence("history-home-wheel-final-page-published-ax", &format!("{:#?}", cancelled.accessibility_snapshot()));
        support::evidence_cells("history-home-wheel-final-page-published", &cancelled);
        assert_eq!(retained.lines().position(|line| line.contains(&boundary_tail)), Some(reading_row), "a completed, cancelled Home moved the user's reading source:\n{retained}");
        // Promise delivery may already include rich layout. While still raw,
        // also retain the original downstream-row check; rich layout removes
        // the source's two trailing blank lines below the reading position.
        if cancelled.accessibility_snapshot().iter().any(|node| node.label.contains(&boundary_tail) && node.label.contains("**bold**")) {
            assert_eq!(retained.lines().position(|line| line.contains(&wheel_marker)), Some(wheel_row), "a completed, cancelled Home moved the user's wheel anchor:\n{retained}");
        }
        assert!(!retained.contains("History question 00"), "the cancelled Home snapped to canonical start:\n{retained}");
        let formatted = wait_view_state(&mut cancelled, |view, _| view.accessibility_snapshot().iter().any(|node| node.label.starts_with(&boundary_tail) && !node.label.contains("**bold**"))).await;
        evidence("history-home-wheel-after-formatting", &formatted);
        evidence("history-home-wheel-after-formatting-ax", &format!("{:#?}", cancelled.accessibility_snapshot()));
        support::evidence_cells("history-home-wheel-after-formatting", &cancelled);
        assert_eq!(formatted.lines().position(|line| line.contains(&boundary_tail)), Some(reading_row), "formatting the newly completed prefix moved the same original reading anchor:\n{formatted}");
        assert!(!formatted.contains("History question 00"), "formatting restored an obsolete Home target:\n{formatted}");
        support::wait_draft(&cancel_client, &fixture.session, HOME_DRAFT).await;
        assert_eq!(client.query("agent", "observe", json!({"sessionId":fixture.session})).await.unwrap()["through"], observed["through"], "history navigation must not change the Host range");
        evidence("history-home-wheel-cancels-late-reply", &retained);
        shortcut(&mut cancelled, 'l');
        wait_editable_composer(&mut cancelled).await;
        cancelled.handle_event(Event::Key(KeyEvent::new(KeyCode::Char('a'), KeyModifiers::CONTROL)));
        cancelled.handle_event(Event::Key(KeyEvent::new(KeyCode::Backspace, KeyModifiers::NONE)));
        support::wait_draft(&cancel_client, &fixture.session, "").await;
        drop(cancelled);
        cancel_bindings.close().await.unwrap();
        drop(gate);

        // A fresh tail mount retains the original wheel-across-unloaded-pages
        // coverage independently of the full-history Home checks above.
        let (mut view, bindings) = fixture.view(client.clone(), Some(fixture.session.clone()));
        wait_editable_composer(&mut view).await;
        let history = wait_view(&mut view, |screen| screen.contains("History 15 paragraph")).await;
        assert!(history.contains("original provider text"));
        evidence("history", &history);
        let previous = view.surface().focused();
        assert!(view.surface().input_context().is_some(), "the history wheel must start with composer focus, so a missed pointer cannot scroll the focused List");
        // Wheel events over the conversation cross the actual history page boundary.
        let scrolling = std::time::Instant::now();
        let mut screen = history;
        loop {
            support::scroll_snapshot_text(&mut view, &screen, "History ", MouseEventKind::ScrollUp);
            support::tick(&mut view);
            screen = view.snapshot();
            if screen.contains("History 00 paragraph") {
                assert!(!screen.contains("Load earlier messages"));
                evidence("history-automatically-prepended", &screen);
                break;
            }
            assert!(scrolling.elapsed() < Duration::from_secs(20), "scrolling did not load original history:\n{screen}");
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        support::click_button(&mut view, "Return to latest").await;
        let returned = wait_view_state(&mut view, |view, screen| screen.contains("History 15 paragraph 29") && message_source_available(view, false)).await;
        tokio::time::timeout(Duration::from_secs(20), async {
            while view.surface().focused() != previous {
                support::tick(&mut view);
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        }).await.expect("the visible return button did not restore composer focus");
        evidence("history-visible-return-to-latest", &returned);
        // Retain the original shortcut check from older transcript content.
        wheel_history_up_to(&mut view, "History 00 paragraph").await;
        shortcut(&mut view, 'l');
        wait_view_state(&mut view, |view, screen| screen.contains("History 15 paragraph 29") && message_source_available(view, false)).await;
        tokio::time::timeout(Duration::from_secs(20), async {
            while view.surface().focused() != previous {
                view.poll().unwrap();
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        }).await.expect("jump to latest did not restore composer focus");

        view.handle_event(Event::Paste("NSH user send, exactly once".into()));
        wait_view(&mut view, |screen| screen.contains("NSH user send, exactly once")).await;
        // Native editor text can paint before its change reaches the app and enables Send.
        tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                view.poll().unwrap();
                if view.accessibility_snapshot().iter().any(|node| node.label == "Send message" && !node.state.disabled) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        }).await.expect("the presented Send button did not become enabled");
        support::click_button(&mut view, "Send message").await;
        // AppView's engine continues independently while this awaits the real HTTP request.
        let mut request = fixture.next_request().await;
        assert!(request.body["messages"].as_array().unwrap().iter().any(|message| message["role"] == "user" && message["content"].to_string().contains("NSH user send, exactly once")));
        let thinking = std::iter::once("NATIVE_THINK_SOURCE_FIRST".to_owned())
            .chain((1..63).map(|index| format!("NATIVE_THINK_SOURCE_{index:02}")))
            .chain(["NATIVE_THINK_SOURCE_LAST".to_owned(), "\nNATIVE_ACTIVITY_HEADER_TAIL_INITIAL".to_owned()])
            .collect::<Vec<_>>()
            .join("\n");
        request.thinking(&thinking).await;
        let grouped = wait_view(&mut view, |screen| screen.contains("Analyzing the request · NATIVE_ACTIVITY_HEADER_TAIL_INITIAL") && !screen.contains("Thinking")).await;
        evidence("live-group-collapsed", &grouped);
        assert!(!grouped.contains("Details ·"));
        // The one live group's button has a stable semantic label; its text
        // includes a disclosure glyph before the source-backed activity title.
        support::click_text(&mut view, "Process group");
        wait_view(&mut view, |screen| screen.contains("Thinking · NATIVE_THINK_SOURCE_FIRST")).await;
        support::click_text(&mut view, "Thinking · NATIVE_THINK_SOURCE_FIRST");
        // Either end of the actual expanded source must paint before keyboard scrolling.
        wait_view(&mut view, |screen| screen.contains("NATIVE_THINK_SOURCE_01") || screen.contains("NATIVE_THINK_SOURCE_62")).await;
        support::focus_activity(&mut view).await;
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::Home, KeyModifiers::NONE)));
        let at_source_start = |screen: &str| screen.matches("NATIVE_THINK_SOURCE_FIRST").count() == 2 && !screen.contains("NATIVE_THINK_SOURCE_LAST");
        let source_top = wait_view(&mut view, &at_source_start).await;
        evidence("activity-source-top", &source_top);
        support::evidence_cells("activity-source-top", &view);

        // Keep focus outside the activity List so the wheel cannot pass via focus fallback.
        let activity_focus = view.surface().focused();
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::Up, KeyModifiers::ALT)));
        tokio::time::timeout(Duration::from_secs(20), async {
            while view.surface().focused().is_none() || view.surface().focused() == activity_focus {
                view.poll().unwrap();
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        }).await.expect("history did not receive native focus");
        let header_row = source_top.lines().position(|line| line.contains("Analyzing the request")).expect("the activity header must be visible above its source");
        let source_row = source_top.lines().position(|line| line.contains("NATIVE_THINK_SOURCE_01")).unwrap();
        support::scroll_text(&mut view, "NATIVE_THINK_SOURCE_01", MouseEventKind::ScrollDown);
        let wheeled = wait_view(&mut view, |screen| screen.lines().position(|line| line.contains("NATIVE_THINK_SOURCE_01")) == Some(source_row - 3)).await;
        assert!(wheeled.contains("NATIVE_THINK_SOURCE_03"));
        assert_eq!(wheeled.lines().position(|line| line.contains("Analyzing the request")), Some(header_row), "the body wheel must not move the fixed turn header");
        evidence("activity-mouse-wheel", &wheeled);
        support::evidence_cells("activity-mouse-wheel", &view);
        support::focus_activity(&mut view).await;
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::Home, KeyModifiers::NONE)));
        // Alt+Down explicitly reveals the group. Freeze its settled pose before
        // streaming; the earlier mouse-wheel assertions retain their own anchor.
        let cadence_source_top = wait_view(&mut view, &at_source_start).await;
        let cadence_header_row = cadence_source_top.lines().position(|line| line.contains("Analyzing the request")).expect("the navigated activity header must be visible above its source");
        let cadence_source_row = cadence_source_top.lines().position(|line| line.contains("NATIVE_THINK_SOURCE_01")).expect("the navigated original source must be visible");

        // Rapid paragraphs must update during the stream, at a bounded cadence,
        // while the expanded source and its reader anchor stay put.
        let cadence = std::time::Instant::now();
        let mut titles = vec![(Duration::ZERO, support::painted_text(&view, "Analyzing the request", cadence_header_row))];
        let mut paragraph = 0;
        while cadence.elapsed() < Duration::from_millis(650) {
            paragraph += 1;
            request.thinking(&format!("\n\nTITLE_{paragraph:02} 规划 e\u{301} {}", "界e\u{301}".repeat(48))).await;
            for _ in 0..4 {
                view.poll().unwrap();
                support::tick(&mut view);
                let screen = view.snapshot();
                assert!(at_source_start(&screen), "a title update moved the source reader:\n{screen}");
                assert_eq!(screen.lines().position(|line| line.contains("NATIVE_THINK_SOURCE_01")), Some(cadence_source_row), "a title update moved the original source row:\n{screen}");
                assert!(screen.lines().nth(cadence_header_row).unwrap().contains("Analyzing the request"), "the fixed activity header moved:\n{screen}");
                let title = support::painted_text(&view, "Analyzing the request", cadence_header_row);
                if title != titles.last().unwrap().1 {
                    titles.push((cadence.elapsed(), title));
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        }
        assert!(titles.len() >= 3, "continuous input postponed every intermediate title: {titles:?}; paragraphs={paragraph}; elapsed={:?}", cadence.elapsed());
        let latest = format!("TITLE_{paragraph:02} 规划 e\u{301}");
        wait_view(&mut view, |screen| at_source_start(screen) && screen.lines().nth(cadence_header_row).is_some_and(|line| line.contains(&latest))).await;
        let last = support::painted_text(&view, "Analyzing the request", cadence_header_row);
        assert!(last.ends_with('…') && !last.ends_with("e…"), "the long title must ellipsize without splitting a combining grapheme: {last}");
        if last != titles.last().unwrap().1 {
            titles.push((cadence.elapsed(), last));
        }
        // An interval-wide bound avoids confusing poll scheduling with the JS
        // presentation timestamp, while still catching a title for every delta.
        assert!(titles.len() <= cadence.elapsed().as_millis() as usize / 150 + 2, "the header changed faster than its minimum lifetime: {titles:?}");
        evidence("activity-title-cadence", &titles.iter().map(|(at, title)| format!("{}ms {title}", at.as_millis())).collect::<Vec<_>>().join("\n"));
        support::evidence_cells("activity-title-unicode", &view);

        // The elapsed-time label keeps advancing while deltas continuously
        // refresh this same turn and the user keeps its source reader anchored.
        let duration_seconds = |text: &str| {
            let (minutes, seconds) = text.split_once("m ").unwrap_or(("0", text));
            Some(minutes.parse::<u64>().ok()? * 60 + seconds.strip_suffix('s')?.parse::<u64>().ok()?)
        };
        // Read the actual duration Text frame. The whole row also includes
        // the turn panel's border and the outer List's scrollbar.
        let painted_duration = |view: &AppView| {
            let metrics = view.surface().metrics();
            view.accessibility_snapshot().into_iter().find_map(|node| {
                if (node.frame.origin.y.0 / metrics.height().0 - 0.5).ceil() != cadence_header_row as f32 {
                    return None;
                }
                duration_seconds(&node.label)?;
                duration_seconds(&support::painted_text(view, &node.label, cadence_header_row))
            })
        };
        let previous_duration = painted_duration(&view)
            .unwrap_or_else(|| panic!("the active turn must paint its elapsed-time label:\n{}", view.snapshot()));
        let advancing = tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                request.thinking(" ").await;
                view.poll().unwrap();
                support::tick(&mut view);
                let screen = view.snapshot();
                assert!(at_source_start(&screen), "continuous thinking moved the source reader:\n{screen}");
                assert_eq!(screen.lines().position(|line| line.contains("NATIVE_THINK_SOURCE_01")), Some(cadence_source_row));
                if painted_duration(&view).is_some_and(|seconds| seconds > previous_duration) {
                    break screen;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        }).await.expect("continuous thinking deltas postponed the turn's elapsed-time updates");
        evidence("activity-duration-advances-during-stream", &advancing);

        request.thinking("\n\nNATIVE_ACTIVITY_HEADER_TAIL_APPENDED").await;
        let anchored = wait_view(&mut view, |screen| at_source_start(screen) && screen.matches("NATIVE_ACTIVITY_HEADER_TAIL_APPENDED").count() == 1).await;
        evidence("activity-append-keeps-source-top", &anchored);
        support::evidence_cells("activity-append-keeps-source-top", &view);

        let todos = json!([
            {"content":"NATIVE_TODO_DONE","status":"completed"},
            {"content":"NATIVE_TODO_ACTIVE","status":"in_progress"},
            {"content":"NATIVE_TODO_PENDING","status":"pending"}
        ]);
        assert!(request.body["tools"].as_array().unwrap().iter().any(|tool| tool["function"]["name"] == "todo_write"));
        let tool_input = json!({"todos":todos.clone()});
        let arguments = tool_input.to_string();
        let prefix = "{\"todos\":[";
        let suffix = arguments.strip_prefix(prefix).unwrap();
        request.delta("NATIVE_INTERMEDIATE_RESPONSE_OUTSIDE_PROCESS").await;
        // A reply closes only this contiguous process segment. The same native
        // source reader stays at its original row while later work gets a group.
        let cut = wait_view(&mut view, |screen| at_source_start(screen) && screen.contains("1 thought")).await;
        assert_eq!(cut.lines().position(|line| line.contains("1 thought")), Some(cadence_header_row));
        let header_y = (cadence_header_row as f32 + 0.5) * view.surface().metrics().height().0;
        assert!(view.accessibility_snapshot().iter().any(|node| {
            node.label == "Process group" && node.state.selected
                && node.frame.origin.y.0 <= header_y
                && header_y < node.frame.origin.y.0 + node.frame.size.height.0
        }), "the same thought group must stay expanded at its original header row");
        assert_eq!(cut.lines().position(|line| line.contains("NATIVE_THINK_SOURCE_01")), Some(cadence_source_row));
        evidence("intermediate-response-cuts-process-group", &cut);
        support::evidence_cells("intermediate-response-cuts-process-group", &view);
        // Leave the old source reader explicitly, then select the new segment
        // only after its actual preparation has reached the UI projection.
        shortcut(&mut view, 'l');
        let intermediate = wait_view(&mut view, |screen| screen.contains("NATIVE_INTERMEDIATE_RESPONSE_OUTSIDE_PROCESS")).await;
        evidence("intermediate-response-outside-process", &intermediate);
        support::evidence_cells("intermediate-response-outside-process", &view);
        request.tool_prefix("todo_write", prefix).await;
        let preparing = wait_view(&mut view, |screen| screen.contains("Preparing tool · todo_write") && screen.contains(prefix)).await;
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::Down, KeyModifiers::ALT)));
        let pending = client.query("agent", "observe", json!({"sessionId":fixture.session})).await.unwrap();
        let pending_history = client.query("agent", "history", json!({"sessionId":fixture.session,"through":pending["through"],"position":{"kind":"tail"},"view":"conversation"})).await.unwrap();
        assert!(pending_history["chunks"].as_array().unwrap().iter().all(|chunk| chunk["tool"]["call"]["name"] != "todo_write"), "an unfinished argument prefix must not become a canonical tool call");
        evidence("activity-preparing-tool-input", &preparing);
        support::evidence_cells("activity-preparing-tool-input", &view);
        request.tool_suffix(suffix).await;
        // A real tool result causes exactly one additional model HTTP request.
        let mut request = fixture.next_request().await;
        let working = wait_view(&mut view, |screen| screen.contains("Working…") && !screen.contains("Running tool")).await;
        let working_row = working.lines().position(|line| line.contains("Working…")).unwrap();
        let working_y = (working_row as f32 + 0.5) * view.surface().metrics().height().0;
        assert!(view.accessibility_snapshot().iter().any(|node| {
            node.label == "Process group" && node.state.selected
                && node.frame.origin.y.0 <= working_y
                && working_y < node.frame.origin.y.0 + node.frame.size.height.0
        }), "the new working group must remain expanded after its original Alt+Down");
        let complete_call = request.body["messages"].as_array().unwrap().iter()
            .filter_map(|message| message["tool_calls"].as_array()).flatten()
            .find(|call| call["id"] == "nsh-native-todo-call").unwrap();
        assert_eq!(complete_call["function"]["name"], "todo_write");
        assert_eq!(serde_json::from_str::<Value>(complete_call["function"]["arguments"].as_str().unwrap()).unwrap(), tool_input);
        let tool_result = request.body["messages"].as_array().unwrap().iter().find(|message| message["role"] == "tool" && message["tool_call_id"] == "nsh-native-todo-call").unwrap();
        assert_eq!(tool_result["content"], "1. [completed] \"NATIVE_TODO_DONE\"\n2. [in_progress] \"NATIVE_TODO_ACTIVE\"\n3. [pending] \"NATIVE_TODO_PENDING\"");
        let checklist = client.query("agent", "checklist", json!({"sessionId":fixture.session,"offset":0})).await.unwrap();
        assert_eq!(checklist["enabled"], true);
        assert_eq!(checklist["items"], todos);
        assert_eq!(checklist["total"], 3);
        assert_eq!(checklist["completed"], 1);
        assert_eq!(checklist["current"], todos[1]);
        assert!(checklist["nextOffset"].is_null());
        wait_view_state(&mut view, |view, screen| screen.contains("Todo 1/3") && view.accessibility_snapshot().iter().any(|node| node.role == nsh_core::AccessibilityRole::Button && node.label == "Toggle conversation todo" && !node.state.selected)).await;
        let nodes = view.accessibility_snapshot();
        let dock = nodes.iter().find(|node| node.label == "Conversation todo dock").unwrap().frame;
        let composer = nodes.iter().find(|node| node.label == "Conversation composer").unwrap().frame;
        assert_eq!(dock.origin.x.0, composer.origin.x.0);
        assert_eq!(dock.size.width.0, composer.size.width.0);
        assert!(dock.origin.y.0 + dock.size.height.0 <= composer.origin.y.0, "Todo must dock immediately above the resident composer");
        // The canonical tool segment now owns a different native activity List.
        support::focus_activity(&mut view).await;
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::End, KeyModifiers::NONE)));
        support::wait_enabled_button(&mut view, "Toggle tool todo_write").await;
        assert_eq!(view.accessibility_snapshot().iter().filter(|node| node.label == "Toggle tool todo_write").count(), 1);
        support::click_button(&mut view, "Toggle conversation todo").await;
        let checklist_visible = wait_view_state(&mut view, |view, screen| screen.contains("Todo 1/3") && screen.contains("NATIVE_TODO_DONE") && screen.contains("NATIVE_TODO_PENDING") && view.accessibility_snapshot().iter().any(|node| node.role == nsh_core::AccessibilityRole::Button && node.label == "Toggle conversation todo" && node.state.selected)).await;
        evidence("real-tool-and-checklist", &checklist_visible);
        support::evidence_cells("real-tool-and-checklist", &view);

        request.delta("REAL_PROVIDER_STREAM_VISIBLE").await;
        let streaming = wait_view(&mut view, |screen| screen.contains("REAL_PROVIDER_STREAM_VISIBLE") && screen.contains("Writing response")).await;
        evidence("streaming", &streaming);
        request.delta(" and committed.").await;
        let appended = wait_view(&mut view, |screen| screen.contains("REAL_PROVIDER_STREAM_VISIBLE") && screen.contains("committed.") && screen.contains("Writing response")).await;
        evidence("streaming-second-fragment", &appended);
        request.finish().await;
        fixture.idle(&client, &fixture.session).await;
        let committed = wait_view(&mut view, |screen| screen.contains("Completed") && screen.matches("REAL_PROVIDER_STREAM_VISIBLE").count() == 1 && screen.contains("committed.") && !screen.contains("NATIVE_THINK_SOURCE_FIRST") && !screen.contains("NATIVE_ACTIVITY_HEADER_TAIL_APPENDED")).await;
        evidence("committed", &committed);
        support::evidence_cells("committed", &view);

        // Completion folds the work immediately. Manual reopening retains the
        // original thinking disclosure and starts the independent activity at top.
        let folded = wheel_history_up_to(&mut view, "Completed").await;
        assert_eq!(folded.matches("REAL_PROVIDER_STREAM_VISIBLE").count(), 1);
        assert!(!folded.contains("NATIVE_INTERMEDIATE_RESPONSE_OUTSIDE_PROCESS"));
        support::click_text(&mut view, "Completed");
        wait_view(&mut view, |screen| screen.contains("1 thought")).await;
        support::click_text(&mut view, "1 thought");
        let reopened = wait_view(&mut view, &at_source_start).await;
        evidence("completed-activity-source-reopened-at-top", &reopened);
        support::evidence_cells("completed-activity-source-reopened-at-top", &view);
        shortcut(&mut view, 'l');
        tokio::time::timeout(Duration::from_secs(20), async {
            while view.surface().input_context().is_none() {
                support::tick(&mut view);
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        }).await.expect("Jump latest did not focus the composer");
        view.handle_event(Event::Paste("NEXT_MESSAGE_AFTER_COMPLETED_PROCESS".into()));
        support::wait_draft(&client, &fixture.session, "NEXT_MESSAGE_AFTER_COMPLETED_PROCESS").await;
        tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                support::tick(&mut view);
                if view.accessibility_snapshot().iter().any(|node| node.label == "Send message" && !node.state.disabled) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        }).await.expect("the next presented Send button did not become enabled");
        support::click_button(&mut view, "Send message").await;
        let mut next = fixture.next_request().await;
        wait_view(&mut view, |screen| screen.contains("NEXT_MESSAGE_AFTER_COMPLETED_PROCESS")).await;
        next.delta("SECOND_TURN_FINAL").await;
        next.finish().await;
        fixture.idle(&client, &fixture.session).await;
        wait_view(&mut view, |screen| screen.contains("SECOND_TURN_FINAL")).await;

        support::load_application(&mut view);
        let reloaded = wait_view(&mut view, |screen| screen.contains("SECOND_TURN_FINAL")).await;
        assert!(!reloaded.contains("Details ·") && !reloaded.contains("NATIVE_THINK_SOURCE_FIRST"));
        evidence("single-work-presentation-after-reload", &reloaded);
        // Reload starts with a fresh tail window. The first real Turn is not in
        // that page, so its rail mark must navigate across unloaded history.
        let current = client.query("agent", "observe", json!({"sessionId":fixture.session})).await.unwrap();
        let first = client.query("agent", "history", json!({"sessionId":fixture.session,"through":current["through"],"position":{"kind":"start"},"view":"conversation"})).await.unwrap();
        assert_eq!(first["chunks"][0]["text"], "History question 00");
        let fresh_tail = client.query("agent", "history", json!({"sessionId":fixture.session,"through":current["through"],"position":{"kind":"tail"},"view":"conversation"})).await.unwrap();
        assert!(!fresh_tail["before"].is_null());
        assert!(fresh_tail["chunks"].as_array().unwrap().iter().all(|chunk| chunk["turnId"] != first["chunks"][0]["turnId"]));
        assert!(!view.snapshot().contains("History 00 paragraph"));
        let composer = view.accessibility_snapshot().into_iter().find(|node| node.label == "Message composer").expect("the reloaded app must keep its native composer").id;
        let scrolling = std::time::Instant::now();
        loop {
            support::tick(&mut view);
            let nodes = view.accessibility_snapshot();
            let rail = nodes.iter().find(|node| node.label == "Turn navigation").expect("the real history must expose its native turn rail").frame;
            if nodes.iter().any(|node| node.role == nsh_core::AccessibilityRole::Button
                && node.label == "Jump to turn: History question 00"
                && node.frame.origin.y.0 >= rail.origin.y.0
                && node.frame.origin.y.0 + node.frame.size.height.0 <= rail.origin.y.0 + rail.size.height.0) {
                break;
            }
            assert!(scrolling.elapsed() < Duration::from_secs(20), "the native turn rail did not reveal its first mark:\n{}", view.snapshot());
            let column = ((rail.origin.x.0 + rail.size.width.0 / 2.0) / 8.0).floor().max(0.0) as u16;
            let row = ((rail.origin.y.0 + rail.size.height.0 / 2.0) / 16.0).floor().max(0.0) as u16;
            // The active turn is unchanged, so the nested rail keeps the
            // position reached by its wheel rather than centering again.
            for kind in [MouseEventKind::Moved, MouseEventKind::ScrollUp] {
                view.handle_event(Event::Mouse(MouseEvent {kind,column,row,modifiers:KeyModifiers::NONE}));
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        support::click_button(&mut view, "Jump to turn: History question 00").await;
        // Leave the native rail tooltip so its label cannot stand in for
        // the actual user message in the transcript visibility assertion.
        view.handle_event(Event::Mouse(MouseEvent {kind:MouseEventKind::Moved,column:0,row:0,modifiers:KeyModifiers::NONE}));
        let jumped = wait_view(&mut view, |screen| screen.contains("History question 00") && screen.contains("History 00 paragraph 00")).await;
        assert!(!jumped.contains("Load earlier messages"));
        evidence("turn-rail-loads-unloaded-history", &jumped);
        support::click_button(&mut view, "Return to latest").await;
        let returned = wait_view(&mut view, |screen| screen.contains("SECOND_TURN_FINAL")).await;
        tokio::time::timeout(Duration::from_secs(20), async {
            while view.surface().focused() != Some(composer) || view.surface().input_context().is_none() {
                support::tick(&mut view);
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        }).await.expect("returning from a turn jump did not restore composer focus");
        evidence("turn-rail-return-to-latest", &returned);
        assert_eq!(fixture.request_count.load(Ordering::SeqCst), 19);
        assert!(client.pending_operations("agent", &fixture.session, EDITOR).await.unwrap().is_empty());
        drop(view);
        bindings.close().await.unwrap();
        fixture.finish().await;
    }).await.expect("real Host/Agent UI integration timed out");
}

fn message_source_available(view: &AppView, selected: bool) -> bool {
    let label = if selected {
        "Show formatted message"
    } else {
        "Show message source"
    };
    let nodes = view.accessibility_snapshot();
    let Some(composer) = nodes
        .iter()
        .find(|node| node.label == "Conversation composer")
    else {
        return false;
    };
    nodes.iter().any(|node| {
        node.role == nsh_core::AccessibilityRole::Button
            && node.label == label
            && node.state.selected == selected
            && !node.state.disabled
            && node.frame.origin.y.0 >= 0.0
            && node.frame.origin.y.0 + node.frame.size.height.0 <= composer.frame.origin.y.0
    })
}

#[track_caller]
fn wait_mode_layout(view: &mut AppView) -> impl std::future::Future<Output = ()> {
    let caller = std::panic::Location::caller();
    async move {
        let started = std::time::Instant::now();
        loop {
            support::tick(view);
            assert!(
                view.last_error().is_none(),
                "NSH app error at {caller}: {:?}",
                view.last_error()
            );
            if !view.surface().animating() {
                return;
            }
            assert!(
                started.elapsed() < Duration::from_secs(20),
                "Markdown mode layout did not settle at {caller}:\n{}",
                view.snapshot()
            );
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn live_markdown_source_mode_survives_canonical_handoff() {
    use base64::Engine as _;
    use nsh_platform_tui::ServiceOutput;
    tokio::time::timeout(Duration::from_secs(90), async {
        let mut fixture = Fixture::open().await;
        let client = fixture.client().await;
        let (mut view, bindings) = fixture.view(client.clone(), Some(fixture.session.clone()));
        view.surface_mut().set_host_services_enabled(true);
        wait_editable_composer(&mut view).await;
        let original_user = "Keep the live source mode 中文😀\n\tbefore and after handoff  \n";
        let sent = support::mutate(&client, "send", json!({
            "sessionId":fixture.session,"message":original_user, "model":fixture.selection
        })).await;
        assert_eq!(sent["kind"], "started");
        let mut request = fixture.next_request().await;
        let source = "# LIVE_HEADING\n\n**LIVE_BOLD**\n\n```txt\nLIVE_CODE_BLOCK\n```";
        request.delta(source).await;
        wait_view_state(&mut view, |view, screen| screen.contains("LIVE_CODE_BLOCK") && message_source_available(view, false) && !screen.contains("```txt") && !screen.contains("**LIVE_BOLD**")).await;
        wait_mode_layout(&mut view).await;
        support::click_button(&mut view, "Show message source").await;
        let literal = |view: &AppView, screen: &str| screen.contains("# LIVE_HEADING") && screen.contains("**LIVE_BOLD**") && screen.contains("```txt") && screen.contains("LIVE_CODE_BLOCK") && message_source_available(view, true);
        // Keep the provider physically open until the actual native click
        // has selected source mode; then exercise that same row's handoff.
        let live = wait_view_state(&mut view, literal).await;
        evidence("live-markdown-source-selected", &live);
        request.finish().await;
        fixture.idle(&client, &fixture.session).await;
        let settled = wait_view_state(&mut view, |view, screen| literal(view, screen) && screen.contains("Completed")).await;
        evidence("live-markdown-source-settled", &settled);
        wait_mode_layout(&mut view).await;
        view.drain_service_output().for_each(drop);
        support::click_button(&mut view, "Copy user message").await;
        wait_view(&mut view, |screen| screen.contains("User message copied")).await;
        let clipboard = view.drain_service_output().filter(|effect| matches!(effect, ServiceOutput::Clipboard(_))).collect::<Vec<_>>();
        assert_eq!(clipboard.len(), 1, "canonical assistant handoff must retain the original user copy action");
        let ServiceOutput::Clipboard(copied) = &clipboard[0] else { unreachable!() };
        assert_eq!(copied, original_user);
        let sequence = clipboard[0].terminal_sequence(false);
        let payload = sequence.strip_prefix("\u{1b}]52;c;").and_then(|sequence| sequence.strip_suffix("\u{1b}\\")).expect("the original user must retain a complete OSC52 sequence after handoff");
        assert_eq!(base64::engine::general_purpose::STANDARD.decode(payload).unwrap(), original_user.as_bytes());
        let observed = client.query("agent", "observe", json!({"sessionId":fixture.session})).await.unwrap();
        let history = client.query("agent", "history", json!({"sessionId":fixture.session,"through":observed["through"],"position":{"kind":"tail"},"view":"conversation"})).await.unwrap();
        let response = history["chunks"].as_array().unwrap().iter().find(|chunk| chunk["role"] == "assistant" && chunk["field"] == "body").unwrap();
        assert_eq!(response["text"], source);
        assert_eq!(fixture.request_count.load(Ordering::SeqCst), 1);
        drop(view);
        bindings.close().await.unwrap();
        fixture.finish().await;
    }).await.expect("real Host live source handoff timed out");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn streamed_markdown_keeps_inline_styles_and_the_original_selectable_source() {
    use base64::Engine as _;
    use nsh_platform_tui::ServiceOutput;
    use ratatui::{buffer::Buffer, layout::Rect, style::Modifier};
    tokio::time::timeout(Duration::from_secs(90), async {
        let mut fixture = Fixture::open().await;
        let client = fixture.client().await;
        let (mut view, bindings) = fixture.view(client.clone(), Some(fixture.session.clone()));
        view.surface_mut().set_host_services_enabled(true);
        wait_editable_composer(&mut view).await;
        let original_user = format!("USER_COPY_BEGIN 中文😀\n{}USER_COPY_END 尾部\n\ttrailing whitespace  \n  ", "分页原文😀\tkeep spaces  \n".repeat(1600));
        let sent = support::mutate(&client, "send", json!({
            "sessionId":fixture.session,"message":original_user, "model":fixture.selection
        })).await;
        assert_eq!(sent["kind"], "started");
        let mut request = fixture.next_request().await;
        // The canonical user source exceeds both the history tail and source
        // query pages. Keep the real provider open with no assistant delta yet.
        let observed = client.query("agent", "observe", json!({"sessionId":fixture.session})).await.unwrap();
        let history = client.query("agent", "history", json!({"sessionId":fixture.session,"through":observed["through"],"position":{"kind":"tail"},"view":"conversation"})).await.unwrap();
        let user = history["chunks"].as_array().unwrap().iter().find(|chunk| chunk["role"] == "user" && chunk["field"] == "body").unwrap();
        assert_eq!(user["totalBytes"].as_u64(), Some(original_user.len() as u64));
        assert!(user["offset"].as_u64().unwrap() > 0, "this real history page must omit the beginning of the user message");
        assert!(original_user.ends_with(user["text"].as_str().unwrap()));
        view.drain_service_output().for_each(drop);
        support::click_button(&mut view, "Copy user message").await;
        let copied_user = wait_view(&mut view, |screen| screen.contains("User message copied")).await;
        let clipboard = view.drain_service_output().filter(|effect| matches!(effect, ServiceOutput::Clipboard(_))).collect::<Vec<_>>();
        assert_eq!(clipboard.len(), 1, "one user copy must emit exactly one native clipboard effect");
        let ServiceOutput::Clipboard(copied) = &clipboard[0] else { unreachable!() };
        assert_eq!(copied, &original_user, "copy must reread the whole canonical user message instead of its loaded tail");
        let sequence = clipboard[0].terminal_sequence(false);
        let payload = sequence.strip_prefix("\u{1b}]52;c;").and_then(|sequence| sequence.strip_suffix("\u{1b}\\")).expect("user copy must encode one complete OSC52 command");
        assert_eq!(base64::engine::general_purpose::STANDARD.decode(payload).unwrap(), original_user.as_bytes());
        evidence("rich-response-copies-complete-original-user", &copied_user);
        assert_eq!(fixture.request_count.load(Ordering::SeqCst), 1, "copying the user message must not start another model request");
        let prefix = "# RICH_HEADING\n\n**RICH_BOLD** *RICH_ITALIC* ~~RICH_STRIKE~~ `RICH_CODE`";
        request.delta(prefix).await;
        let rendered = wait_view(&mut view, |screen| {
            screen.contains("RICH_HEADING") && screen.contains("RICH_STRIKE")
                && !screen.contains("# RICH_HEADING") && !screen.contains("**RICH_BOLD**")
        }).await;
        evidence("rich-response-live-inline", &rendered);
        support::evidence_cells("rich-response-live-inline", &view);
        // Inspect the actual terminal cells, rather than the Markdown DTO or
        // parser internals: these styles must survive nested NSH Text shaping.
        let viewport = view.surface().viewport();
        let area = Rect::new(0, 0, (viewport.width.0 / 8.0) as u16, (viewport.height.0 / 16.0) as u16);
        let mut buffer = Buffer::empty(area);
        view.render(area, &mut buffer);
        for (token, expected) in [
            ("RICH_HEADING", Modifier::BOLD),
            ("RICH_BOLD", Modifier::BOLD),
            ("RICH_ITALIC", Modifier::ITALIC),
            ("RICH_STRIKE", Modifier::CROSSED_OUT),
        ] {
            let cells = (0..area.height).find_map(|y| {
                (0..=area.width.saturating_sub(token.len() as u16)).find_map(|x| {
                    let text: String = (0..token.len()).map(|index| buffer[(x + index as u16, y)].symbol()).collect();
                    (text == token).then_some((x, y))
                })
            }).unwrap_or_else(|| panic!("formatted token {token} is not visible:\n{rendered}"));
            assert!((0..token.len()).all(|index| buffer[(cells.0 + index as u16, cells.1)].modifier.contains(expected)), "terminal cells for {token} lost {expected:?}");
        }
        let cell = |token: &str| {
            (0..area.height).find_map(|y| {
                (0..=area.width.saturating_sub(token.len() as u16)).find_map(|x| {
                    let text: String = (0..token.len()).map(|index| buffer[(x + index as u16, y)].symbol()).collect();
                    (text == token).then_some((x, y))
                })
            }).unwrap_or_else(|| panic!("copy target {token} is not visible:\n{rendered}"))
        };
        let first = cell("RICH_HEADING");
        let last = cell("RICH_CODE");
        view.drain_service_output().for_each(drop);
        for (kind, (column, row)) in [
            (MouseEventKind::Down(MouseButton::Left), (last.0 + "RICH_CODE".len() as u16, last.1)),
            (MouseEventKind::Drag(MouseButton::Left), (first.0.saturating_sub(1), first.1)),
            (MouseEventKind::Up(MouseButton::Left), (first.0.saturating_sub(1), first.1)),
        ] {
            view.handle_event(Event::Mouse(MouseEvent { kind, column, row, modifiers: KeyModifiers::NONE }));
        }
        shortcut(&mut view, 'c');
        let selected = view.drain_service_output().filter_map(|effect| match effect {
            ServiceOutput::Clipboard(text) => Some(text),
            _ => None,
        }).collect::<Vec<_>>();
        assert_eq!(selected, ["RICH_HEADING\nRICH_BOLD RICH_ITALIC RICH_STRIKE RICH_CODE"], "dragging across Markdown blocks must copy all visible lines with their formatting text intact; first={first:?}; last={last:?}; text frames={:?}", view.accessibility_snapshot().into_iter().filter(|node| node.label.contains("RICH_HEADING") || node.label.contains("RICH_BOLD")).map(|node| (node.id, node.frame, node.label)).collect::<Vec<_>>());
        let table = "\n\n- RICH_LIST\n\n> RICH_QUOTE\n\n| RICH_TABLE_NAME | RICH_TABLE_VALUE |\n| :--- | ---: |\n| 中文表格 | 42 |\n| 完整单元格 | 8 |";
        request.delta(table).await;
        let rendered_table = wait_view_state(&mut view, |view, screen| {
            view.accessibility_snapshot().iter().any(|node| node.label == "Markdown table")
                && screen.contains("RICH_TABLE_NAME") && screen.contains("RICH_TABLE_VALUE")
                && screen.lines().any(|line| line.contains("中文表格") && line.contains("42"))
                && screen.lines().any(|line| line.contains("完整单元格") && line.contains("8"))
                && !screen.contains("| RICH_TABLE_NAME")
        }).await;
        evidence("rich-response-live-table", &rendered_table);
        let reference = "\n\n[RICH_REFERENCE][later]";
        request.delta(reference).await;
        wait_view(&mut view, |screen| screen.contains("[RICH_REFERENCE][later]")).await;
        let definition = "\n\n[later]: https://example.test/streamed-reference";
        request.delta(definition).await;
        wait_view_state(&mut view, |view, _| {
            view.accessibility_snapshot().iter().any(|node| {
                node.role == nsh_core::AccessibilityRole::Link && node.label == "RICH_REFERENCE"
            })
        }).await;
        let code = "\n\n```txt\nRICH_CODE_BLOCK 中文原文\n\tkeep trailing  \n\n```";
        let suffix = format!("{table}{reference}{definition}{code}");
        request.delta("\n\n```txt\nRICH_CODE_BLOCK 中文原文\n").await;
        // The stream remains physically open: parsing cannot wait for final.
        // Copying the long user message can leave its reader anchored above
        // this new block. Reveal it through the actual native Latest action.
        let code_readable = |view: &AppView, screen: &str| {
            if !screen.contains("RICH_CODE_BLOCK") || screen.contains("```txt") || !message_source_available(view, false) {
                return false;
            }
            let nodes = view.accessibility_snapshot();
            let Some(chat) = nodes.iter().find(|node| node.role == nsh_core::AccessibilityRole::Tab && node.label == "Chat") else { return false; };
            let Some(composer) = nodes.iter().find(|node| node.label == "Conversation composer") else { return false; };
            nodes.iter().any(|node| node.role == nsh_core::AccessibilityRole::Button && node.label == "Copy code block" && !node.state.disabled
                && node.frame.origin.y.0 >= chat.frame.origin.y.0 + chat.frame.size.height.0
                && node.frame.origin.y.0 + node.frame.size.height.0 <= composer.frame.origin.y.0)
        };
        wait_view_state(&mut view, |view, screen| {
            code_readable(view, screen)
                || view.accessibility_snapshot().iter().any(|node| node.role == nsh_core::AccessibilityRole::Button && node.label == "Return to latest" && !node.state.disabled)
        }).await;
        if !code_readable(&view, &view.snapshot()) {
            support::click_button(&mut view, "Return to latest").await;
        }
        wait_view_state(&mut view, code_readable).await;
        let wrap = support::wait_enabled_button(&mut view, "Wrap code").await;
        assert!(wrap.state.selected, "new code blocks must wrap long lines by default");
        support::click_button(&mut view, "Wrap code").await;
        wait_view_state(&mut view, |view, _| view.accessibility_snapshot().iter().any(|node| node.id == wrap.id && node.label == "Wrap code" && !node.state.selected)).await;
        // The same live fence grows after a real wrap action. Keep the native
        // control and the reader's choice while the Rust projection updates.
        request.delta("\tkeep trailing  \n\n```").await;
        wait_view_state(&mut view, |view, screen| code_readable(view, screen) && screen.contains("keep trailing")
            && view.accessibility_snapshot().iter().any(|node| node.id == wrap.id && node.label == "Wrap code" && !node.state.selected)).await;
        view.drain_service_output().for_each(drop);
        support::click_button(&mut view, "Copy code block").await;
        let copied_code = wait_view(&mut view, |screen| screen.contains("Copied") && screen.contains("RICH_CODE_BLOCK")).await;
        let clipboard = view.drain_service_output().filter(|effect| matches!(effect, ServiceOutput::Clipboard(_))).collect::<Vec<_>>();
        assert_eq!(clipboard.len(), 1, "one code copy must emit exactly one native clipboard effect");
        let ServiceOutput::Clipboard(copied) = &clipboard[0] else { unreachable!() };
        assert_eq!(copied, "RICH_CODE_BLOCK 中文原文\n\tkeep trailing  \n");
        let sequence = clipboard[0].terminal_sequence(false);
        let payload = sequence.strip_prefix("\u{1b}]52;c;").and_then(|sequence| sequence.strip_suffix("\u{1b}\\")).expect("code copy must encode one complete OSC 52 command");
        assert_eq!(base64::engine::general_purpose::STANDARD.decode(payload).unwrap(), "RICH_CODE_BLOCK 中文原文\n\tkeep trailing  \n".as_bytes());
        evidence("rich-response-copies-exact-code", &copied_code);
        request.finish().await;
        fixture.idle(&client, &fixture.session).await;
        // Host idle may precede the completed reply's canonical actions. Its
        // earlier summary can be above the viewport while this reader shows
        // the answer tail, so observe the actual final-only Usage button here.
        let complete = wait_view_state(&mut view, |view, screen| {
            if !screen.contains("RICH_CODE_BLOCK") || !message_source_available(view, false) {
                return false;
            }
            let nodes = view.accessibility_snapshot();
            let Some(chat) = nodes.iter().find(|node| node.role == nsh_core::AccessibilityRole::Tab && node.label == "Chat") else { return false; };
            let Some(composer) = nodes.iter().find(|node| node.label == "Conversation composer") else { return false; };
            nodes.iter().any(|node| node.role == nsh_core::AccessibilityRole::Button && node.label == "View this turn's model usage" && !node.state.disabled
                && node.frame.origin.y.0 >= chat.frame.origin.y.0 + chat.frame.size.height.0
                && node.frame.origin.y.0 + node.frame.size.height.0 <= composer.frame.origin.y.0)
        }).await;
        evidence("rich-response-complete", &complete);
        wait_mode_layout(&mut view).await;
        support::click_button(&mut view, "Show message source").await;
        let original = wait_view_state(&mut view, |view, screen| screen.contains("```txt") && screen.contains("RICH_CODE_BLOCK") && message_source_available(view, true)).await;
        evidence("rich-response-original-source", &original);
        // Source has a different native height. Observe the original text
        // first, then let its scroll/layout motion finish before one click.
        wait_mode_layout(&mut view).await;
        support::click_button(&mut view, "Show formatted message").await;
        wait_view_state(&mut view, |view, screen| screen.contains("RICH_CODE_BLOCK") && message_source_available(view, false) && !screen.contains("```txt")).await;
        let observed = client.query("agent", "observe", json!({"sessionId":fixture.session})).await.unwrap();
        let history = client.query("agent", "history", json!({"sessionId":fixture.session,"through":observed["through"],"position":{"kind":"tail"},"view":"conversation"})).await.unwrap();
        let response = history["chunks"].as_array().unwrap().iter().find(|chunk| chunk["role"] == "assistant" && chunk["field"] == "body").unwrap();
        assert_eq!(response["text"], format!("{prefix}{suffix}"));
        wait_mode_layout(&mut view).await;
        view.drain_service_output().for_each(drop);
        support::click_button(&mut view, "Copy message").await;
        let sent_to_clipboard = wait_view(&mut view, |screen| screen.contains("Message copied")).await;
        let clipboard = view.drain_service_output().filter(|effect| matches!(effect, ServiceOutput::Clipboard(_))).collect::<Vec<_>>();
        assert_eq!(clipboard.len(), 1, "one copy action must emit exactly one native clipboard effect");
        let ServiceOutput::Clipboard(copied) = &clipboard[0] else { unreachable!() };
        assert_eq!(copied, &format!("{prefix}{suffix}"));
        let sequence = clipboard[0].terminal_sequence(false);
        let payload = sequence.strip_prefix("\u{1b}]52;c;").and_then(|sequence| sequence.strip_suffix("\u{1b}\\")).expect("the real clipboard effect must encode a complete OSC 52 command");
        assert_eq!(base64::engine::general_purpose::STANDARD.decode(payload).unwrap(), format!("{prefix}{suffix}").as_bytes());
        evidence("rich-response-copies-exact-original-source", &sent_to_clipboard);
        assert_eq!(fixture.request_count.load(Ordering::SeqCst), 1);
        // A long response stays formatted while its real stream remains open.
        // Its original source remains selectable and copyable without reducing
        // the supported document to a literal presentation after a size threshold.
        let sent = support::mutate(&client, "send", json!({
            "sessionId":fixture.session,"message":"Render a complete long code source", "model":fixture.selection
        })).await;
        assert_eq!(sent["kind"], "started");
        let mut request = fixture.next_request().await;
        let source = format!("```txt\n{}\n# RICH_TAIL_HEADING\n**RICH_TAIL_MARK**\n```", "filler 中文😀\n".repeat(60_000));
        assert!(source.len() > 1024 * 1024);
        request.delta(&source).await;
        let long_formatted = wait_view_state(&mut view, |view, screen| screen.contains("**RICH_TAIL_MARK**") && message_source_available(view, false) && !screen.contains("```") && !screen.contains("Formatting unavailable")).await;
        evidence("rich-response-long-formatted", &long_formatted);
        wait_mode_layout(&mut view).await;
        support::click_button(&mut view, "Show message source").await;
        wait_view_state(&mut view, |view, screen| screen.contains("**RICH_TAIL_MARK**") && message_source_available(view, true) && screen.contains("```") && !screen.contains("Formatting unavailable")).await;
        request.finish().await;
        fixture.idle(&client, &fixture.session).await;
        drop(view);
        bindings.close().await.unwrap();

        // A fresh history tail omits the opening fence. Its heading-looking
        // lines must stay original source until offset zero has been loaded.
        let client = fixture.client().await;
        let observed = client.query("agent", "observe", json!({"sessionId":fixture.session})).await.unwrap();
        let tail = client.query("agent", "history", json!({"sessionId":fixture.session,"through":observed["through"],"position":{"kind":"tail"},"view":"conversation"})).await.unwrap();
        let response = tail["chunks"].as_array().unwrap().iter().find(|chunk| chunk["role"] == "assistant" && chunk["field"] == "body").unwrap();
        assert_eq!(response["totalBytes"].as_u64(), Some(source.len() as u64));
        assert!(source.ends_with(response["text"].as_str().unwrap()));
        assert!(response["offset"].as_u64().unwrap() > 0, "this history must omit the original opening fence");
        let (mut view, bindings) = fixture.view(client, Some(fixture.session.clone()));
        view.surface_mut().set_host_services_enabled(true);
        let literal = wait_view_state(&mut view, |view, screen| screen.contains("# RICH_TAIL_HEADING") && screen.contains("**RICH_TAIL_MARK**") && message_source_available(view, false)).await;
        evidence("rich-response-incomplete-history", &literal);
        wait_mode_layout(&mut view).await;
        view.drain_service_output().for_each(drop);
        support::click_button(&mut view, "Copy message").await;
        let copied_large = wait_view(&mut view, |screen| screen.contains("Message copied")).await;
        let clipboard = view.drain_service_output().filter(|effect| matches!(effect, ServiceOutput::Clipboard(_))).collect::<Vec<_>>();
        assert_eq!(clipboard.len(), 1, "the exact long canonical body must be copied once");
        let ServiceOutput::Clipboard(copied) = &clipboard[0] else { unreachable!() };
        assert!(copied == &source, "copy must reread the original source instead of copying its loaded tail");
        let sequence = clipboard[0].terminal_sequence(false);
        let payload = sequence.strip_prefix("\u{1b}]52;c;").and_then(|sequence| sequence.strip_suffix("\u{1b}\\")).expect("the large source must produce one complete OSC52 sequence");
        assert!(base64::engine::general_purpose::STANDARD.decode(payload).unwrap() == source.as_bytes());
        evidence("rich-response-copies-complete-large-source", &copied_large);
        assert_eq!(fixture.request_count.load(Ordering::SeqCst), 2);
        drop(view);
        bindings.close().await.unwrap();
        fixture.finish().await;
    }).await.expect("real Host rich response workflow timed out");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn current_workspace_previews_keep_real_contents_drafts_and_session_ownership() {
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    use image::{ExtendedColorType, ImageEncoder, codecs::png};
    use nsh_platform_tui::ServiceOutput;
    tokio::time::timeout(Duration::from_secs(90), async {
        let mut fixture = Fixture::open().await;
        let client = fixture.client().await;
        let workspace = fixture.directory.path().join("workspace");
        let text_path = workspace.join("000-preview.txt");
        std::fs::write(&text_path, "BEFORE_CURRENT_EDIT\n").unwrap();
        for arguments in [
            vec!["init", "--quiet"],
            vec!["add", "000-preview.txt"],
            vec!["-c", "user.name=Preview fixture", "-c", "user.email=preview@example.invalid", "commit", "--quiet", "-m", "baseline"],
        ] {
            let output = std::process::Command::new("git").args(arguments).current_dir(&workspace).output().unwrap();
            assert!(output.status.success(), "git fixture failed: {}", String::from_utf8_lossy(&output.stderr));
        }
        let long_line = format!("{}e\u{301}{}", "a".repeat(255), "中文😀".repeat(40));
        let captured_contents = format!("AFTER_CURRENT_EDIT\r\n原文\t保留空白  \r\n{long_line}\r\n");
        std::fs::write(&text_path, &captured_contents).unwrap();
        let pixels: Vec<u8> = (0..64 * 48).flat_map(|index| if index % 64 < 32 { [255, 64, 32, 255] } else { [32, 220, 96, 255] }).collect();
        let mut png_bytes = Vec::new();
        png::PngEncoder::new(&mut png_bytes).write_image(&pixels, 64, 48, ExtendedColorType::Rgba8).unwrap();
        std::fs::write(workspace.join("001-scene.data"), png_bytes).unwrap();
        support::mutate(&client, "send", json!({"sessionId":fixture.session,"message":"Keep running during workspace inspection","model":fixture.selection})).await;
        let mut request = fixture.next_request().await;
        let observed = client.query("agent", "observe", json!({"sessionId":fixture.session})).await.unwrap();
        let invocation = observed["run"]["invocationId"].clone();
        let (mut view, bindings) = fixture.view(client.clone(), Some(fixture.session.clone()));
        view.surface_mut().set_host_services_enabled(true);
        view.resize(120, 40);
        wait_focused_input(&mut view, "Message composer").await;
        tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                support::tick(&mut view);
                if view.surface().input_context().is_some_and(|context| context.editable) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        }).await.expect("the focused composer did not finish loading its saved draft");
        view.handle_event(Event::Paste("UNSENT_PREVIEW_DRAFT".into()));
        assert_eq!(view.surface().input_context().unwrap().text.as_deref(), Some("UNSENT_PREVIEW_DRAFT"));
        support::wait_draft(&client, &fixture.session, "UNSENT_PREVIEW_DRAFT").await;
        let composer = view.surface().focused().unwrap();
        support::click_label(&mut view, "Browse workspace files");
        wait_view(&mut view, |screen| screen.contains("000-preview.txt") && screen.contains("001-scene.data") && !screen.contains("Loading files…") && !screen.contains("Updating files…")).await;
        support::click_label(&mut view, "File: 000-preview.txt");
        let first = wait_view_state(&mut view, |view, screen| screen.contains("AFTER_CURRENT_EDIT") && screen.contains("Captured version") && !screen.contains("Reading current file…") && view.accessibility_snapshot().iter().any(|node| node.label == long_line && node.frame.size.height.0 > 16.0)).await;
        assert!(!first.contains("BEFORE_CURRENT_EDIT"));
        // One original line stays one native Text, including a combining
        // sequence across the old scalar-block boundary. Its soft-wrapped
        // body has one source line number rather than a repeated gutter.
        let nodes = view.accessibility_snapshot();
        let source_line = nodes.iter().find(|node| node.label == long_line).unwrap();
        let reader_frame = nodes.iter().find(|node| node.label == "Captured file text").unwrap().frame;
        assert!(nodes.iter().any(|node| node.label == "3" && node.frame.origin.y.0 == source_line.frame.origin.y.0 && node.frame.origin.x.0 >= reader_frame.origin.x.0 && node.frame.origin.x.0 < source_line.frame.origin.x.0));
        let first_version = view.accessibility_snapshot().into_iter().find(|node| node.label.starts_with("Captured version ")).unwrap().label;

        // Resize the actual right divider with both side panes docked. Its
        // drag changes layout without replacing the captured reader or editor.
        view.resize(160, 40);
        wait_view_state(&mut view, |view, screen| screen.contains("AFTER_CURRENT_EDIT") && view.accessibility_snapshot().iter().any(|node| node.label == "Resize session browser")).await;
        tab_to_label(&mut view, "Message composer").await;
        assert_eq!(view.surface().focused(), Some(composer));
        let selection = view.surface().input_context().unwrap().selection;
        let reader = view.accessibility_snapshot().into_iter().find(|node| node.label == "Captured file text").unwrap().id;
        for delta in [-4_i16, 4] {
            let nodes = view.accessibility_snapshot();
            let divider = nodes.iter().find(|node| node.label == "Resize workspace preview").unwrap().frame;
            let browser = nodes.iter().find(|node| node.label == "Resize session browser").unwrap().frame;
            let editor = nodes.iter().find(|node| node.id == composer).unwrap().frame;
            let column = (divider.origin.x.0 / 8.0).round() as u16;
            let target = (column as i16 + delta) as u16;
            for (kind, column) in [
                (MouseEventKind::Down(MouseButton::Left), column),
                (MouseEventKind::Drag(MouseButton::Left), target),
                (MouseEventKind::Up(MouseButton::Left), target),
            ] {
                view.handle_event(Event::Mouse(MouseEvent {kind,column,row:1,modifiers:KeyModifiers::NONE}));
            }
            wait_view_state(&mut view, |view, screen| screen.contains("AFTER_CURRENT_EDIT") && view.accessibility_snapshot().iter().any(|node| node.label == "Resize workspace preview" && node.frame.origin.x.0 == divider.origin.x.0 + f32::from(delta) * 8.0)).await;
            let nodes = view.accessibility_snapshot();
            let resized = nodes.iter().find(|node| node.id == composer).unwrap().frame;
            assert_eq!(resized.origin.x.0, editor.origin.x.0);
            assert_eq!(resized.size.width.0, editor.size.width.0 + f32::from(delta) * 8.0);
            assert_eq!(nodes.iter().find(|node| node.label == "Resize session browser").unwrap().frame, browser);
            assert!(nodes.iter().any(|node| node.id == reader && node.label == "Captured file text"));
            assert!(nodes.iter().any(|node| node.label == first_version));
            assert_eq!(view.surface().focused(), Some(composer));
            let context = view.surface().input_context().unwrap();
            assert_eq!(context.text.as_deref(), Some("UNSENT_PREVIEW_DRAFT"));
            assert_eq!(context.selection, selection);
        }
        support::evidence_cells("workspace-preview-physical-divider", &view);

        // A viewport change invalidates the captured drag origin. Continuing
        // that old physical gesture must not overwrite the width preference.
        let divider = view.accessibility_snapshot().into_iter().find(|node| node.label == "Resize workspace preview").unwrap().frame;
        let column = (divider.origin.x.0 / 8.0).round() as u16;
        view.handle_event(Event::Mouse(MouseEvent {kind:MouseEventKind::Down(MouseButton::Left),column,row:1,modifiers:KeyModifiers::NONE}));
        let (committed, received) = tokio::sync::oneshot::channel();
        view.control().unwrap().advance_clock(Duration::ZERO, move || { let _ = committed.send(()); });
        received.await.unwrap();
        view.resize(152, 40);
        wait_view_state(&mut view, |view, screen| screen.contains("AFTER_CURRENT_EDIT") && view.accessibility_snapshot().iter().any(|node| node.label == "Resize workspace preview" && node.frame.origin.x.0 == 840.0)).await;
        let before_move = view.accessibility_snapshot().into_iter().find(|node| node.label == "Resize workspace preview").unwrap().frame;
        for kind in [MouseEventKind::Drag(MouseButton::Left), MouseEventKind::Up(MouseButton::Left)] {
            view.handle_event(Event::Mouse(MouseEvent {kind,column:column + 4,row:1,modifiers:KeyModifiers::NONE}));
        }
        let (committed, received) = tokio::sync::oneshot::channel();
        view.control().unwrap().advance_clock(Duration::ZERO, move || { let _ = committed.send(()); });
        received.await.unwrap();
        support::tick(&mut view);
        assert_eq!(view.accessibility_snapshot().into_iter().find(|node| node.label == "Resize workspace preview").unwrap().frame, before_move);
        assert_eq!(view.surface().focused(), Some(composer));
        assert_eq!(view.surface().input_context().unwrap().selection, selection);
        view.resize(120, 40);
        wait_view(&mut view, |screen| screen.contains("AFTER_CURRENT_EDIT") && screen.contains("Captured version")).await;
        std::fs::write(&text_path, "REFRESHED_CURRENT_EDIT\n").unwrap();
        wait_view(&mut view, |screen| screen.contains("workspace may have changed")).await;
        assert!(view.snapshot().contains("AFTER_CURRENT_EDIT"), "a capture must not silently become current contents");
        // Copy the complete original capture even after the workspace has changed.
        // One physical click emits one native clipboard effect, without rereading.
        view.drain_service_output().for_each(drop);
        let copy = support::wait_enabled_button(&mut view, "Copy captured file").await.id;
        support::click_button(&mut view, "Copy captured file").await;
        wait_view_state(&mut view, |view, screen| screen.contains("File copied") && view.accessibility_snapshot().iter().any(|node| node.id == copy && node.focused && !node.state.disabled)).await;
        let clipboard = view.drain_service_output().filter(|effect| matches!(effect, ServiceOutput::Clipboard(_))).collect::<Vec<_>>();
        assert_eq!(clipboard.len(), 1, "one captured-file copy must emit exactly one native clipboard effect");
        let ServiceOutput::Clipboard(copied) = &clipboard[0] else { unreachable!() };
        assert_eq!(copied.as_bytes(), captured_contents.as_bytes());
        let sequence = clipboard[0].terminal_sequence(false);
        let payload = sequence.strip_prefix("\u{1b}]52;c;").and_then(|sequence| sequence.strip_suffix("\u{1b}\\")).expect("captured-file copy must encode one complete OSC52 sequence");
        assert_eq!(STANDARD.decode(payload).unwrap(), captured_contents.as_bytes());
        assert!(view.accessibility_snapshot().iter().any(|node| node.id == reader && node.label == "Captured file text"));
        assert!(view.accessibility_snapshot().iter().any(|node| node.id == composer));
        assert!(view.accessibility_snapshot().iter().any(|node| node.label == first_version));
        support::wait_draft(&client, &fixture.session, "UNSENT_PREVIEW_DRAFT").await;
        support::click_label(&mut view, "Refresh current file");
        wait_view(&mut view, |screen| screen.contains("REFRESHED_CURRENT_EDIT") && !screen.contains("Reading current file…")).await;
        let next_version = view.accessibility_snapshot().into_iter().find(|node| node.label.starts_with("Captured version ")).unwrap().label;
        assert_ne!(first_version, next_version);
        assert!(view.accessibility_snapshot().iter().any(|node| node.id == copy && !node.state.disabled));
        assert!(!view.snapshot().contains("File copied"), "copy feedback must belong to its captured version");
        support::click_label(&mut view, "Browse current changes");
        wait_view(&mut view, |screen| screen.contains("Current changes") && screen.contains("000-preview.txt") && !screen.contains("Reading current changes…")).await;
        support::click_label(&mut view, "Open Worktree diff: 000-preview.txt");
        let diff = wait_view(&mut view, |screen| screen.contains("Current worktree diff") && screen.contains("-BEFORE_CURRENT_EDIT") && screen.contains("+REFRESHED_CURRENT_EDIT")).await;
        evidence("workspace-current-diff-dock", &diff);
        support::evidence_cells("workspace-current-diff-dock", &view);
        assert!(view.accessibility_snapshot().iter().any(|node| node.id == composer));
        view.resize(80, 24);
        // The dock has the same text and close button. Wait until the native
        // Dialog input scope hides the still-resident composer before Escape.
        let narrow = wait_view_state(&mut view, |view, screen| screen.contains("Current worktree diff") && screen.contains("+REFRESHED_CURRENT_EDIT") && view.accessibility_snapshot().iter().any(|node| node.role == nsh_core::AccessibilityRole::Button && node.label == "Close workspace preview" && !node.state.disabled) && !view.accessibility_snapshot().iter().any(|node| node.id == composer)).await;
        evidence("workspace-current-diff-dialog", &narrow);
        support::evidence_cells("workspace-current-diff-dialog", &view);
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)));
        wait_view(&mut view, |screen| !screen.contains("Current worktree diff") && screen.contains("UNSENT_PREVIEW_DRAFT")).await;
        assert!(view.accessibility_snapshot().iter().any(|node| node.id == composer));
        support::click_label(&mut view, "Browse workspace files");
        wait_view(&mut view, |screen| screen.contains("001-scene.data") && !screen.contains("Loading files…") && !screen.contains("Updating files…")).await;
        support::click_label(&mut view, "File: 001-scene.data");
        let image = wait_view(&mut view, |screen| screen.contains("64 × 48 · Captured image") && screen.contains('▀')).await;
        evidence("workspace-current-image-dialog", &image);
        support::evidence_cells("workspace-current-image-dialog", &view);
        let captured_version = view.accessibility_snapshot().into_iter().find(|node| node.label.starts_with("Captured version ")).unwrap().label;
        assert!(view.accessibility_snapshot().iter().any(|node| node.label == "Copy captured file" && node.state.disabled), "an image must not advertise text-copy capability");
        support::click_button(&mut view, "Open image full screen").await;
        wait_view_state(&mut view, |view, screen| screen.contains('▀') && view.accessibility_snapshot().iter().any(|node| node.label == "Full screen image viewer")).await;
        let viewer = view.accessibility_snapshot().into_iter().find(|node| node.label == "Full screen image viewer").unwrap().id;
        for (columns, rows) in [(120, 40), (80, 24)] {
            view.resize(columns, rows);
            wait_view_state(&mut view, |view, screen| screen.contains('▀') && view.accessibility_snapshot().iter().any(|node| node.id == viewer && node.label == "Full screen image viewer" && node.frame.size.width.0 == f32::from(columns) * 8.0 && node.frame.size.height.0 == f32::from(rows) * 16.0)).await;
        }
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)));
        wait_view_state(&mut view, |view, screen| screen.contains("64 × 48 · Captured image") && !view.accessibility_snapshot().iter().any(|node| node.label == "Full screen image viewer")).await;
        assert!(view.accessibility_snapshot().iter().any(|node| node.label == captured_version));
        assert!(view.accessibility_snapshot().iter().any(|node| node.focused && node.label == "Browse files"), "closing the full-screen image must restore the preview navigation; focused native nodes: {:?}", view.accessibility_snapshot().into_iter().filter(|node| node.focused).map(|node| (node.label, node.frame)).collect::<Vec<_>>());
        view.resize(120, 40);
        wait_view_state(&mut view, |view, screen| screen.contains("64 × 48 · Captured image") && screen.contains("UNSENT_PREVIEW_DRAFT") && view.accessibility_snapshot().iter().any(|node| node.label == "Resize workspace preview")).await;
        support::click_button(&mut view, "Close workspace preview").await;
        wait_view_state(&mut view, |view, screen| !screen.contains("Captured image") && !view.accessibility_snapshot().iter().any(|node| node.role == nsh_core::AccessibilityRole::Button && node.label == "Close workspace preview")).await;
        assert!(view.accessibility_snapshot().iter().any(|node| node.focused && node.label == "Browse workspace files"));
        tab_to_label(&mut view, "Message composer").await;
        assert_eq!(view.surface().focused(), Some(composer));
        assert_eq!(view.surface().input_context().unwrap().text.as_deref(), Some("UNSENT_PREVIEW_DRAFT"));
        request.delta("WORKSPACE_RUN_CONTINUES").await;
        wait_view(&mut view, |screen| screen.contains("WORKSPACE_RUN_CONTINUES")).await;
        let continuing = client.query("agent", "observe", json!({"sessionId":fixture.session})).await.unwrap();
        assert_eq!(continuing["run"]["invocationId"], invocation);
        assert_eq!(fixture.request_count.load(Ordering::SeqCst), 1);
        request.finish().await;
        fixture.idle(&client, &fixture.session).await;

        // Cross the real 128-entry Host page by native wheel input, then let
        // its watch replace the listing while the reader remains at the tail.
        for index in 0..140 {
            std::fs::write(workspace.join(format!("page-{index:03}.txt")), "file\n").unwrap();
        }
        support::click_label(&mut view, "Browse workspace files");
        wait_view(&mut view, |screen| screen.contains("page-000.txt") && !screen.contains("Loading files…") && !screen.contains("Updating files…")).await;
        tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                support::tick(&mut view);
                let screen = view.snapshot();
                if screen.contains("page-139.txt") { break; }
                support::scroll_text(&mut view, "page-", MouseEventKind::ScrollDown);
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        }).await.expect("native file scrolling did not load the second Host page");
        let tail_y = view.accessibility_snapshot().into_iter().find(|node| node.label == "File: page-139.txt").unwrap().frame.origin.y.0;
        std::fs::rename(workspace.join("page-139.txt"), workspace.join("page-139v2.txt")).unwrap();
        wait_view(&mut view, |screen| screen.contains("page-139v2.txt")).await;
        let refreshed_y = view.accessibility_snapshot().into_iter().find(|node| node.label == "File: page-139v2.txt").unwrap().frame.origin.y.0;
        assert_eq!(tail_y, refreshed_y, "a watch refresh discarded the already requested prefix");
        support::evidence_cells("workspace-files-automatic-pagination-and-watch", &view);
        support::click_button(&mut view, "Close workspace preview").await;
        wait_view_state(&mut view, |view, screen| !screen.contains("page-139v2.txt") && !view.accessibility_snapshot().iter().any(|node| node.role == nsh_core::AccessibilityRole::Button && node.label == "Close workspace preview")).await;
        let roots = client.query("agent", "directories", json!({"kind":"roots"})).await.unwrap();
        let other = support::mutate(&client, "create", json!({"title":"Other preview owner","labels":[],"workspace":{"kind":"directory","selection":roots["roots"][0]["selection"]}})).await;
        shortcut(&mut view, 'o');
        select_palette(&mut view, "Search sessions…", "Other preview owner", "Other preview owner").await;
        wait_view(&mut view, |screen| screen.contains("Other preview owner") && !screen.contains("UNSENT_PREVIEW_DRAFT")).await;
        support::click_label(&mut view, "Browse workspace files");
        wait_view(&mut view, |screen| screen.contains("000-preview.txt") && !screen.contains("Loading files…") && !screen.contains("Updating files…")).await;
        assert!(!view.accessibility_snapshot().iter().any(|node| node.label == "Preview 000-preview.txt" || node.label == "Preview 001-scene.data"), "resource tabs moved to another session");
        assert_ne!(other["session"]["id"], fixture.session);
        support::wait_draft(&client, &fixture.session, "UNSENT_PREVIEW_DRAFT").await;
        drop(view);
        bindings.close().await.unwrap();
        fixture.finish().await;
    }).await.expect("real Host current workspace preview workflow timed out");
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn immutable_tool_images_render_and_preview_without_stopping_the_running_turn() {
    use base64::{
        Engine as _,
        engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    };
    use image::{ExtendedColorType, ImageEncoder, codecs::png};
    tokio::time::timeout(Duration::from_secs(90), async {
        let mut fixture = Fixture::registered_images().await;
        let client = fixture.client().await;
        let path = fixture.directory.path().join("workspace/scene.png");
        let pixels: Vec<u8> = (0..192 * 128).flat_map(|index| {
            if index % 192 < 64 { [255, 64, 32, 255] }
            else if index % 192 < 128 { [32, 220, 96, 255] }
            else { [64, 128, 255, 255] }
        }).collect();
        let mut bytes = Vec::new();
        png::PngEncoder::new_with_quality(&mut bytes, png::CompressionType::Uncompressed, png::FilterType::NoFilter)
            .write_image(&pixels, 192, 128, ExtendedColorType::Rgba8).unwrap();
        assert!(bytes.len() > 2 * 32768, "the real PNG must cross multiple Host page boundaries");
        std::fs::write(&path, &bytes).unwrap();
        support::mutate(&client, "send", json!({"sessionId":fixture.session,"message":"Read the image", "model":fixture.selection})).await;
        let request = fixture.next_request().await;
        request.tool("Read", json!({"path":"scene.png"})).await;
        let mut request = fixture.next_request().await;
        let image_url = request.body["messages"].as_array().unwrap().iter()
            .filter_map(|message| message["content"].as_array()).flatten()
            .find(|part| part["type"] == "image_url").unwrap_or_else(|| panic!("missing actual image in model request: {}", request.body["messages"]))["image_url"]["url"].as_str().unwrap();
        assert_eq!(STANDARD.decode(image_url.strip_prefix("data:image/png;base64,").unwrap()).unwrap(), bytes);
        // The live Read tool has settled. Neither viewer may reopen its original file.
        std::fs::write(&path, b"the workspace image was replaced").unwrap();
        let observed = client.query("agent", "observe", json!({"sessionId":fixture.session})).await.unwrap();
        let history = client.query("agent", "history", json!({"sessionId":fixture.session,"through":observed["through"],"position":{"kind":"tail"},"view":"conversation"})).await.unwrap();
        let result = history["chunks"].as_array().unwrap().iter()
            .find(|chunk| chunk["tool"]["result"]["image"] == true).unwrap()["tool"]["result"]["position"].clone();

        // The full-window reader uses this same immutable selector even though
        // the workspace path no longer contains an image. Inspect painted image
        // columns so zoom controls cannot pass by changing only their captions.
        let (mut view, bindings) = fixture.view(fixture.client().await, Some(fixture.session.clone()));
        view.resize(120, 40);
        wait_editable_composer(&mut view).await;
        let composer = view.surface().focused().unwrap();
        view.handle_event(Event::Paste("IMAGE_VIEWER_UNSENT_DRAFT".into()));
        support::wait_draft(&client, &fixture.session, "IMAGE_VIEWER_UNSENT_DRAFT").await;
        // The composer remains editable while history loads. Wait for the
        // actual activity target before asking the shortcut to focus it.
        wait_enabled_node(&mut view, "Process group").await;
        support::focus_activity(&mut view).await;
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::Home, KeyModifiers::NONE)));
        support::click_button(&mut view, "Toggle tool Read").await;
        support::click_button(&mut view, "Open image preview").await;
        let opener = support::wait_enabled_button(&mut view, "Open image full screen").await.id;
        support::click_button(&mut view, "Open image full screen").await;
        let image_columns = |view: &AppView| {
            use ratatui::{buffer::Buffer, layout::Rect, style::Color};
            let mut buffer = Buffer::empty(Rect::new(0, 0, 120, 40));
            view.render(buffer.area, &mut buffer);
            (0..120_u16).filter(|column| (0..40_u16).any(|row| {
                let cell = &buffer[(*column, row)];
                [cell.fg, cell.bg].iter().any(|color| matches!(color,
                    Color::Rgb(255, 64, 32) | Color::Rgb(32, 220, 96) | Color::Rgb(64, 128, 255)))
            })).count()
        };
        wait_view_state(&mut view, |view, _| image_columns(view) == 24 && view.accessibility_snapshot().iter().any(|node| node.label == "Full screen image viewer")).await;
        let original_image = view.accessibility_snapshot().into_iter().find(|node| node.role == nsh_core::AccessibilityRole::Image && node.label == "Original image").unwrap().id;
        support::click_button(&mut view, "Fit image to window").await;
        let full = wait_view_state(&mut view, |view, _| image_columns(view) == 120 && view.accessibility_snapshot().iter().any(|node| node.id == original_image && node.frame.size.width.0 == 960.0)).await;
        evidence("tool-image-full-window-fit", &full);
        support::click_button(&mut view, "Show image at actual size").await;
        wait_view_state(&mut view, |view, _| image_columns(view) == 24 && view.accessibility_snapshot().iter().any(|node| node.id == original_image && node.frame.size.width.0 == 192.0)).await;
        support::click_button(&mut view, "Zoom image out").await;
        wait_view_state(&mut view, |view, _| image_columns(view) < 24 && view.accessibility_snapshot().iter().any(|node| node.id == original_image && node.frame.size.width.0 < 192.0)).await;
        support::click_button(&mut view, "Show image at actual size").await;
        wait_view_state(&mut view, |view, _| image_columns(view) == 24 && view.accessibility_snapshot().iter().any(|node| node.id == original_image && node.frame.size.width.0 == 192.0)).await;
        support::click_button(&mut view, "Zoom image in").await;
        let zoomed = wait_view_state(&mut view, |view, _| image_columns(view) == 30 && view.accessibility_snapshot().iter().any(|node| node.id == original_image && node.frame.size.width.0 == 240.0)).await;
        evidence("tool-image-full-window-zoom", &zoomed);
        support::click_label(&mut view, "Zoom image in");
        support::click_label(&mut view, "Zoom image in");
        wait_view_state(&mut view, |view, _| view.accessibility_snapshot().iter().any(|node| node.id == original_image && node.frame.size.width.0 == 375.0)).await;
        view.handle_event(Event::Mouse(MouseEvent {kind:MouseEventKind::ScrollUp,column:60,row:20,modifiers:KeyModifiers::CONTROL}));
        wait_view_state(&mut view, |view, _| view.accessibility_snapshot().iter().any(|node| node.id == original_image && node.frame.size.width.0 == 412.5)).await;
        let before_pan = view.accessibility_snapshot().into_iter().find(|node| node.id == original_image).unwrap().frame;
        for (kind, column, row) in [
            (MouseEventKind::Down(MouseButton::Left), 60, 20),
            (MouseEventKind::Drag(MouseButton::Left), 64, 22),
            (MouseEventKind::Up(MouseButton::Left), 64, 22),
        ] {
            view.handle_event(Event::Mouse(MouseEvent {kind,column,row,modifiers:KeyModifiers::NONE}));
        }
        wait_view_state(&mut view, |view, _| view.accessibility_snapshot().iter().any(|node| node.id == original_image && node.frame.origin.x.0 == before_pan.origin.x.0 + 32.0 && node.frame.origin.y.0 == before_pan.origin.y.0 + 32.0 && node.frame.size == before_pan.size)).await;
        let continuing = client.query("agent", "observe", json!({"sessionId":fixture.session})).await.unwrap();
        assert_eq!(continuing["run"]["invocationId"], observed["run"]["invocationId"]);
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)));
        wait_view_state(&mut view, |view, screen| screen.contains("Image preview") && !view.accessibility_snapshot().iter().any(|node| node.label == "Full screen image viewer")).await;
        assert_eq!(view.surface().focused(), Some(opener));
        support::click_button(&mut view, "Close workspace preview").await;
        tab_to_label(&mut view, "Message composer").await;
        assert_eq!(view.surface().focused(), Some(composer));
        assert_eq!(view.surface().input_context().unwrap().text.as_deref(), Some("IMAGE_VIEWER_UNSENT_DRAFT"));
        support::wait_draft(&client, &fixture.session, "IMAGE_VIEWER_UNSENT_DRAFT").await;
        drop(view);
        bindings.close().await.unwrap();

        let mut terminal = support::pty::Pty::spawn(&fixture.directory.path().join("host"), Some(&fixture.session));
        terminal.wait_for("fixture-model").await;
        terminal.wait_for_absent("Loading session history").await;
        terminal.wait_for("Working…").await;
        terminal.send(b"\x1b[1;3B");
        terminal.wait_for("Recorded").await;
        terminal.click_text_in_row("Read", "Recorded");
        let inline = terminal.wait_for("Open image · 192 × 128").await;
        assert!(inline.contains('▀'), "the actual PNG must paint in the production terminal");
        evidence("tool-image-inline", &inline);
        terminal.click_text("Open image");
        let preview = terminal.wait_for("Original image").await;
        assert!(preview.contains("Image preview") && preview.contains("192 × 128") && preview.contains('▀'));
        evidence("tool-image-preview", &preview);
        terminal.send(b"\x1b");
        terminal.wait_for_absent("Image preview").await;
        terminal.wait_for("Open image · 192 × 128").await;
        // Closing either presentation returns focus to the original opener.
        terminal.send(b"\r");
        terminal.wait_for("Original image").await;
        terminal.resize(80, 24);
        let narrow = terminal.wait_for("192 × 128 · Original image").await;
        assert!(narrow.contains("Image preview") && narrow.contains('▀'));
        evidence("tool-image-preview-dialog", &narrow);
        terminal.send(b"\x1b");
        terminal.wait_for_absent("Image preview").await;
        terminal.send(b"\r");
        terminal.wait_for("192 × 128 · Original image").await;
        terminal.resize(120, 40);
        terminal.wait_for("Open image · 192 × 128").await;
        terminal.wait_for("192 × 128 · Original image").await;
        terminal.click_text_in_row("×", "Changes");
        terminal.wait_for_absent("Image preview").await;
        terminal.wait_for("Open image · 192 × 128").await;
        request.delta("IMAGE_RUN_CONTINUES_AFTER_ESCAPE").await;
        // Closing the preview preserves its opener's reading position. The
        // response is outside that reader; Ctrl+L explicitly returns to latest.
        terminal.send(b"\x0c");
        terminal.wait_for("Writing response").await;
        terminal.wait_for("IMAGE_RUN_CONTINUES_AFTER_ESCAPE").await;
        request.finish().await;
        fixture.idle(&client, &fixture.session).await;
        terminal.send(b"\x11");
        terminal.finish().await;

        // A source selector cannot move retained image bytes to another Session.
        let roots = client.query("agent", "directories", json!({"kind":"roots"})).await.unwrap();
        let other = support::mutate(&client, "create", json!({"title":"Other image owner","labels":[],"workspace":{"kind":"directory","selection":roots["roots"][0]["selection"]}})).await;
        let other_id = other["session"]["id"].as_str().unwrap();
        let fence = client.query("agent", "observe", json!({"sessionId":other_id})).await.unwrap();
        let uri = format!("asset:/tool-image/{}", URL_SAFE_NO_PAD.encode(serde_json::to_vec(&json!({"sessionId":other_id,"through":fence["through"],"position":result,"offset":0})).unwrap()));
        let bindings = maka_terminal_shell::bindings::Bindings::new(client, tokio::runtime::Handle::current());
        let assets = bindings.assets();
        assert!(tokio::task::spawn_blocking(move || assets.read(&uri)).await.unwrap().is_err());
        bindings.close().await.unwrap();
        fixture.finish().await;
    }).await.expect("real Host tool image workflow timed out");
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn production_sixel_negotiates_from_real_queries_and_resize_keeps_unicode_and_input() {
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    use image::{ExtendedColorType, ImageEncoder, codecs::png};
    use maka_app_client::{Client, Journal};
    use maka_host_runtime::application::host::Client as HostClient;
    const SIXEL: &[u8] = b"\x1bP9;1;0q\"1;1;";
    tokio::time::timeout(Duration::from_secs(90), async {
        let mut fixture = Fixture::registered_images().await;
        let client = fixture.client().await;
        let path = fixture.directory.path().join("workspace/graphics-scene.png");
        let pixels: Vec<u8> = (0..64 * 48).flat_map(|index| {
            if index % 64 < 21 { [255, 64, 32, 255] }
            else if index % 64 < 42 { [32, 220, 96, 255] }
            else { [64, 128, 255, 255] }
        }).collect();
        let mut bytes = Vec::new();
        png::PngEncoder::new_with_quality(&mut bytes, png::CompressionType::Uncompressed, png::FilterType::NoFilter)
            .write_image(&pixels, 64, 48, ExtendedColorType::Rgba8).unwrap();
        std::fs::write(&path, &bytes).unwrap();
        support::mutate(&client, "send", json!({"sessionId":fixture.session,"message":"Read the graphics image", "model":fixture.selection})).await;
        fixture.next_request().await.tool("Read", json!({"path":"graphics-scene.png"})).await;
        let mut request = fixture.next_request().await;
        let image_url = request.body["messages"].as_array().unwrap().iter()
            .filter_map(|message| message["content"].as_array()).flatten()
            .find(|part| part["type"] == "image_url").expect("real Read must reach the provider")["image_url"]["url"].as_str().unwrap();
        assert_eq!(STANDARD.decode(image_url.strip_prefix("data:image/png;base64,").unwrap()).unwrap(), bytes);
        std::fs::write(&path, b"the original image is no longer a PNG").unwrap();

        // Only the simulated terminal's response changes. The actual binary
        // must first emit DA1 + CSI 16t and choose Sixel through its sole reader.
        let mut terminal = support::pty::Pty::spawn_sixel(&fixture.directory.path().join("host"), Some(&fixture.session));
        // The emulator appends this ordinary Ctrl+P to its cell-size reply.
        terminal.wait_for("Search commands…").await;
        let palette = terminal.wait_for("Resume a conversation").await;
        assert!(palette.contains("Search commands…") && palette.contains("Sessions") && palette.contains('×'));
        terminal.send(b"\x1b");
        terminal.wait_for_absent("×").await;
        terminal.wait_for_absent("Loading session history").await;
        // Drafts belong to the client journal, not the Host. Observe the actual
        // binary's journal rather than the fixture client's separate client.db.
        let terminal_client = Client::new(
            HostClient::connect(&fixture.address, None).await.unwrap(),
            Journal::open(&fixture.directory.path().join("host/clients/terminal.sqlite")).await.unwrap(),
            "receipts".into(),
        ).unwrap();
        assert_eq!(terminal_client.source(), client.source());
        // Complete late metadata interleaved between two literal paste events
        // must stay out of the durable editor without swallowing either paste.
        terminal.send("\x1b[200~GRAPHICS_INPUT_你\x1b[201~\x1b[?62;4c\x1b[6;17;9t\x1b[200~好_PRESERVED\x1b[201~".as_bytes());
        terminal.wait_for("GRAPHICS_INPUT_你好_PRESERVED").await;
        support::wait_draft(&terminal_client, &fixture.session, "GRAPHICS_INPUT_你好_PRESERVED").await;
        assert_eq!(fixture.request_count.load(Ordering::SeqCst), 2);
        terminal.send(b"\x1b[1;3B");
        terminal.wait_for("Recorded").await;
        let image_start = terminal.wire().len();
        terminal.click_text_in_row("Read", "Recorded");
        terminal.wait_for("Open image · 64 × 48").await;
        terminal.wait_for_wire(SIXEL, image_start).await;
        let native_wire = &terminal.wire()[image_start..];
        assert!(native_wire.contains(&b'#'), "Sixel must carry the real image palette");
        assert!(native_wire.windows(2).any(|bytes| bytes == b"\x1b\\"), "native DCS must be complete before presenting its frame");
        evidence("production-sixel-native-wire", std::str::from_utf8(native_wire).unwrap());
        evidence("production-sixel-real-image", &terminal.snapshot());

        let before_resize = terminal.wire().len();
        terminal.resize(80, 40);
        terminal.wait_for_wire(b"\x1b[?2026l", before_resize).await;
        terminal.wait_for_wire(b"\x1b[c\x1b[16t", before_resize).await;
        // Keep height unchanged: Screen's local resize cannot scroll away the
        // old left sidebar. New complete output must remove this control.
        terminal.wait_for_absent("Search sessions…").await;
        let narrow = terminal.wait_for("Open image · 64 × 48").await;
        let has_image_cells = |screen: &str| {
            let lines: Vec<_> = screen.lines().collect();
            let (row, label) = lines.iter().enumerate().find(|(_, line)| line.contains("Open image · 64 × 48")).unwrap();
            let column = ratatui::text::Line::from(&label[..label.find("Open image").unwrap()]).width();
            // The fixture's broad uniform stripe interiors prefer half blocks.
            // Inspect only the 40-cell image box below its label; scrollbar ▐
            // elsewhere in the conversation cannot stand in for missing pixels.
            lines.iter().skip(row + 1).take(14).any(|line|
                line.chars().skip(column).take(40).filter(|character| *character == '▀').count() >= 8)
        };
        assert!(has_image_cells(&narrow), "resize must paint the actual image through Unicode");
        // Leave the second measurement unanswered while resizing again. Its
        // original replies must be drained before another untagged query.
        let before_wide = terminal.wire().len();
        terminal.resize(120, 40);
        terminal.wait_for_wire(b"\x1b[?2026l", before_wide).await;
        terminal.wait_for("Search sessions…").await;
        let wide = terminal.wait_for("Open image · 64 × 48").await;
        assert!(has_image_cells(&wide));
        assert_eq!(terminal.wire().windows(3).filter(|bytes| *bytes == b"\x1b[c").count(), 2, "resize must not issue a new query before consuming the original replies");
        assert_eq!(terminal.wire().windows(5).filter(|bytes| *bytes == b"\x1b[16t").count(), 2);
        let after_resize = terminal.wire().len();
        terminal.send(b"\x1b[?62;4c\x1b[6;17;9t");
        terminal.wait_for_wire(b"\x1b[c\x1b[16t", after_resize).await;
        assert!(!terminal.wire()[after_resize..].windows(SIXEL.len()).any(|bytes| bytes == SIXEL), "late original replies must not restore native images after resize");
        let before_fresh = terminal.wire().len();
        terminal.send(b"\x1b[?61;4c\x1b[6;21;11t");
        terminal.wait_for_wire(SIXEL, before_fresh).await;
        assert_eq!(terminal.wire().windows(3).filter(|bytes| *bytes == b"\x1b[c").count(), 3);
        assert_eq!(terminal.wire().windows(5).filter(|bytes| *bytes == b"\x1b[16t").count(), 3);
        support::wait_draft(&terminal_client, &fixture.session, "GRAPHICS_INPUT_你好_PRESERVED").await;
        evidence("production-sixel-resize-wire", std::str::from_utf8(&terminal.wire()[after_resize..]).unwrap());
        evidence("production-sixel-resize-unicode", &wide);
        request.delta("GRAPHICS_RUN_CONTINUES_AFTER_RESIZE").await;
        // End belongs to the inner reader. Ctrl+L returns to the outer response
        // and resumes following even if the provider delta has not arrived yet.
        terminal.send(b"\x0c");
        terminal.wait_for("GRAPHICS_RUN_CONTINUES_AFTER_RESIZE").await;
        request.finish().await;
        fixture.idle(&client, &fixture.session).await;
        assert_eq!(fixture.request_count.load(Ordering::SeqCst), 2, "metadata, resize and draft input must not send or stop the real turn");
        terminal.send(b"\x11");
        terminal.finish().await;
        terminal_client.close().await.unwrap();
        client.close().await.unwrap();
        fixture.finish().await;
    }).await.expect("production Sixel negotiation and resize workflow timed out");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_lost_confirmation_recovers_its_original_reference_and_reload_keeps_a_later_draft() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let mut fixture = Fixture::open().await;
        fixture.seed_history(1).await;
        let gate = ReplyGate::start(fixture.directory.path(), fixture.address.clone());
        let client = fixture.client_at(&gate.address).await;
        let first = client.save_draft("agent", &fixture.session, EDITOR, None, "Original accepted message A".into()).await.unwrap();
        let id = Uuid::new_v4();
        let mutation = client.send_draft(id, "agent", &fixture.session, EDITOR, first.revision, json!({"model":fixture.selection})).await.unwrap();
        let original = mutation.prepare().await.unwrap();
        assert!(original.reference.is_some());
        assert_eq!(client.operation(id).await.unwrap().reference, original.reference);

        gate.arm();
        let mut confirmation = Box::pin(mutation.confirm());
        tokio::select! {
            result = &mut confirmation => panic!("the real send receipt escaped its physical gate: {result:?}"),
            () = gate.held.notified() => {},
        }
        // The Agent returned a real receipt, but this observer has not received it.
        // A newer durable editor revision must remain independent of that attempt.
        let later = client.save_draft("agent", &fixture.session, EDITOR, Some(first.revision), "Later unsent draft B survives recovery".into()).await.unwrap();
        assert!(later.revision > first.revision);
        drop(confirmation);
        assert!(mutation.confirm().await.is_err(), "the same attempt cannot confirm twice");
        mutation.disconnect().await;
        gate.release();
        let mut request = fixture.next_request().await;
        assert!(request.body.to_string().contains("Original accepted message A"));
        request.delta("REAL_RECOVERED_PROVIDER_ANSWER").await;
        request.finish().await;
        client.close().await.unwrap();

        let restarted = fixture.client().await;
        fixture.idle(&restarted, &fixture.session).await;
        assert_eq!(restarted.operation(id).await.unwrap().reference, original.reference);
        assert!(restarted.operation(id).await.unwrap().receipt.is_none(), "only the new UI's original-ref recovery may settle the journal");
        let (mut view, bindings) = fixture.view(restarted.clone(), Some(fixture.session.clone()));
        let recovered = wait_view(&mut view, |screen| screen.contains("Later unsent draft B survives recovery") && screen.contains("REAL_RECOVERED_PROVIDER_ANSWER") && screen.contains("Message accepted.")).await;
        evidence("recovered-original-receipt", &recovered);
        let settled = restarted.operation(id).await.unwrap();
        assert_eq!(settled.reference, original.reference);
        assert!(matches!(settled.receipt, Some(Receipt::Recorded {outcome:OperationOutcome::Returned {ref value},..}) if value["kind"] == "started" && value["sessionId"] == fixture.session));
        assert_eq!(restarted.load_draft("agent", &fixture.session, EDITOR).await.unwrap().unwrap().text, later.text);
        assert!(restarted.pending_operations("agent", &fixture.session, EDITOR).await.unwrap().is_empty());
        assert_eq!(fixture.request_count.load(Ordering::SeqCst), 2, "recovering a receipt must never send A or draft B again");

        support::load_application(&mut view);
        wait_editable_composer(&mut view).await;
        let reloaded = wait_view(&mut view, |screen| screen.contains("Later unsent draft B survives recovery") && screen.contains("REAL_RECOVERED_PROVIDER_ANSWER")).await;
        evidence("reloaded-draft", &reloaded);
        assert_eq!(fixture.request_count.load(Ordering::SeqCst), 2);
        let history = restarted.query("agent", "history", json!({"sessionId":fixture.session,"position":{"kind":"tail"},"view":"conversation"})).await.unwrap();
        assert_eq!(history["chunks"].as_array().unwrap().iter().filter(|chunk| chunk["role"] == "user" && chunk["text"] == "Original accepted message A").count(), 1);
        assert!(restarted.mutation(id, "agent", "send", Value::Null, Default::default(), None, Value::Null).await.is_err());
        drop(view);
        bindings.close().await.unwrap();
        drop(gate);
        fixture.finish().await;
    }).await.expect("real original-receipt recovery timed out");
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn production_workspace_picker_browses_deep_folders_and_restores_the_real_terminal() {
    use maka_app_client::{Client, Journal};
    use maka_host_runtime::application::host::Client as HostClient;
    async fn wait_folder_row(terminal: &mut support::pty::Pty, name: &str) {
        tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                // Use a complete synchronized frame, then distinguish an actual
                // folder row from the same label in the search field or heading.
                let screen = terminal.wait_for(name).await;
                if screen
                    .lines()
                    .any(|line| line.contains(name) && line.contains('›'))
                {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
        })
        .await
        .unwrap_or_else(|_| {
            panic!(
                "production terminal did not show folder {name:?}:\n{}",
                terminal.snapshot()
            )
        });
    }
    tokio::time::timeout(Duration::from_secs(90), async {
        let fixture = Fixture::registered().await;
        let child_path = fixture.directory.path().join("workspace/中文工程/子目录");
        std::fs::create_dir_all(&child_path).unwrap();
        let client = fixture.client().await;
        let mut terminal = support::pty::Pty::spawn(
            &fixture.directory.path().join("host"),
            Some(&fixture.session),
        );
        terminal.wait_for("Message or run a task…").await;
        terminal.wait_for_absent("Loading session history").await;
        terminal.wait_for_absent("Loading the saved draft").await;
        terminal.click_text("Message or run a task…");
        terminal.paste("PTY_FOLDER_DRAFT_你好");
        terminal.wait_for("PTY_FOLDER_DRAFT_你好").await;
        let terminal_client = Client::new(
            HostClient::connect(&fixture.address, None).await.unwrap(),
            Journal::open(
                &fixture
                    .directory
                    .path()
                    .join("host/clients/terminal.sqlite"),
            )
            .await
            .unwrap(),
            "receipts".into(),
        )
        .unwrap();
        support::wait_draft(&terminal_client, &fixture.session, "PTY_FOLDER_DRAFT_你好").await;

        for choose in [false, true] {
            terminal.send(b"\x10");
            terminal.wait_for("Search commands…").await;
            let palette = terminal.wait_for("Resume a conversation").await;
            assert!(
                palette.contains("Search commands…")
                    && palette.contains("Sessions")
                    && palette.contains('×')
            );
            terminal.paste("Choose workspace");
            // Removing the old first result proves the query reset keyboard
            // selection to the sole command row, not just the native Input.
            let choice = terminal.wait_for_absent("Resume a conversation").await;
            assert!(
                choice.contains("Choose workspace")
                    && choice.contains("Start a conversation in another folder")
                    && choice.contains('×')
            );
            terminal.send(b"\r");
            terminal.wait_for("Search workspaces…").await;
            terminal.wait_for("Workspace locations").await;
            wait_folder_row(&mut terminal, "Workspace").await;
            terminal.click_text_in_row("Workspace", "›");
            terminal.wait_for("Folder · Workspace").await;
            terminal.wait_for("Use this folder").await;
            // Click the actual new native search field before typing. A first
            // paint alone does not authorize Enter against its predecessor.
            terminal.wait_for("Search workspaces…").await;
            terminal.click_text("Search workspaces…");
            terminal.paste("中文工程");
            wait_folder_row(&mut terminal, "中文工程").await;
            terminal.send(b"\r");
            terminal.wait_for("Folder · 中文工程").await;
            wait_folder_row(&mut terminal, "子目录").await;
            terminal.click_text_in_row("子目录", "›");
            terminal.wait_for("Folder · 子目录").await;
            terminal.wait_for("This folder has no subfolders.").await;
            if choose {
                terminal.click_text("Use this folder");
            } else {
                terminal.send(b"\x1b[1;3A");
                terminal.wait_for("Folder · 中文工程").await;
                wait_folder_row(&mut terminal, "子目录").await;
                terminal.click_text_in_row("子目录", "›");
                terminal.wait_for("Folder · 子目录").await;
                for (columns, rows) in [(80, 24), (120, 40)] {
                    let before = terminal.wire().len();
                    terminal.resize(columns, rows);
                    terminal.wait_for_wire(b"\x1b[?2026l", before).await;
                    terminal.wait_for("Folder · 子目录").await;
                }
                terminal.send(b"\x1b");
                terminal.wait_for_absent("Search workspaces…").await;
                terminal.wait_for("PTY_FOLDER_DRAFT_你好").await;
                support::wait_draft(&terminal_client, &fixture.session, "PTY_FOLDER_DRAFT_你好")
                    .await;
                assert_eq!(
                    client
                        .query(
                            "agent",
                            "list",
                            json!({"filter":"all","position":{"kind":"start"}})
                        )
                        .await
                        .unwrap()["sessions"]
                        .as_array()
                        .unwrap()
                        .len(),
                    1
                );
            }
        }
        terminal.wait_for("Search models…").await;
        let catalog = client
            .query(
                "agent",
                "list",
                json!({"filter":"all","position":{"kind":"start"}}),
            )
            .await
            .unwrap();
        let sessions = catalog["sessions"].as_array().unwrap();
        assert_eq!(sessions.len(), 2);
        let created = sessions
            .iter()
            .find(|session| session["id"] != fixture.session)
            .unwrap();
        assert_eq!(
            std::fs::canonicalize(created["workspace"]["path"].as_str().unwrap()).unwrap(),
            child_path.canonicalize().unwrap()
        );
        terminal.send(b"\x1b");
        let model_menu = terminal.wait_for("Choose a model ›").await;
        assert!(model_menu.contains("Models") && !model_menu.contains("Search models…"));
        assert!(
            !model_menu.contains("Reasoning effort"),
            "an unselected backend must not expose an empty effort pane"
        );
        let observed = client
            .query("agent", "observe", json!({"sessionId":created["id"]}))
            .await
            .unwrap();
        assert!(
            observed["session"]["backend"].is_null(),
            "browsing and dismissing choices must not select a model"
        );
        terminal.send(b"\x1b");
        terminal.wait_for_absent("Models").await;
        terminal.wait_for("Message or run a task…").await;
        terminal.click_text("Message or run a task…");
        terminal.paste("PTY_NEW_FOLDER_DRAFT");
        terminal.wait_for("PTY_NEW_FOLDER_DRAFT").await;
        support::wait_draft(
            &terminal_client,
            created["id"].as_str().unwrap(),
            "PTY_NEW_FOLDER_DRAFT",
        )
        .await;
        support::wait_draft(&terminal_client, &fixture.session, "PTY_FOLDER_DRAFT_你好").await;
        assert_eq!(fixture.request_count.load(Ordering::SeqCst), 0);
        evidence(
            "production-workspace-picker-deep-folder",
            &terminal.snapshot(),
        );
        terminal.send(b"\x11");
        terminal.finish().await;
        terminal_client.close().await.unwrap();
        client.close().await.unwrap();
        fixture.finish().await;
    })
    .await
    .expect("production workspace folder selection timed out");
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn production_binary_sends_renders_provider_text_and_restores_its_actual_terminal() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let mut fixture = Fixture::registered().await;
        fixture.seed_history(1).await;
        let gate = ReplyGate::history(fixture.directory.path(), fixture.address.clone());
        gate.arm();
        fixture.register_at(&gate.address);
        let mut terminal = support::pty::Pty::spawn(&fixture.directory.path().join("host"), None);
        let home = terminal.wait_for("Make something remarkable.").await;
        evidence("production-pty-home", &home);
        // A held navigation key can arrive as a burst in one reader turn.
        // Crossing its fairness slice must not terminate the application.
        let mut input = b"\x1b[D".repeat(256);
        input.push(0x10);
        terminal.send(&input);
        terminal.wait_for("Search commands…").await;
        let palette = terminal.wait_for("Resume a conversation").await;
        assert!(palette.contains("Search commands…") && palette.contains("Sessions") && palette.contains('×'));
        terminal.click_text("×");
        terminal.wait_for_absent("×").await;
        terminal.wait_for("Make something remarkable.").await;
        terminal.send(b"\x10");
        terminal.wait_for("Search commands…").await;
        terminal.paste("Sess");
        terminal.wait_for_absent("Search commands…").await;
        // Removing another command proves the actual query handler committed,
        // rather than treating a native Input border as an app-ready marker.
        terminal.wait_for_absent("A fresh start in your workspace").await;
        let choice = terminal.wait_for("Resume a conversation").await;
        assert!(choice.contains("Sessions") && choice.contains('×'));
        terminal.send(b"\r");
        terminal.wait_for_absent("×").await;
        terminal.wait_for("Search sessions…").await;
        terminal.paste("NSH real");
        terminal.wait_for_absent("Search sessions…").await;
        terminal.wait_for("NSH real").await;
        terminal.wait_for("NSH real Agent").await;
        terminal.send(b"\r");
        let mut held = Box::pin(gate.held.notified());
        let awaiting = Instant::now();
        loop {
            terminal.read();
            tokio::select! {() = &mut held => break, () = tokio::time::sleep(Duration::from_millis(2)) => {}}
            assert!(awaiting.elapsed() < Duration::from_secs(20), "real first history did not reach its gate");
        }
        drop(held);
        let loading = terminal.wait_for("Loading session history").await;
        assert!(loading.contains("Loading session history… Your draft is kept."));
        terminal.paste("Production PTY user message");
        terminal.wait_for("Production PTY user message").await;
        terminal.send(b"\r");
        let blocked = terminal.wait_for("This message was not sent.").await;
        assert!(blocked.contains("Production PTY user message"));
        assert!(blocked.contains("Loading session history"));
        assert!(blocked.contains("Loading session history… Your draft is kept."));
        assert_eq!(fixture.request_count.load(Ordering::SeqCst), 1);
        evidence("production-pty-loading-keeps-draft", &blocked);
        gate.release();
        terminal.wait_for_absent("Loading session history").await;
        assert_eq!(fixture.request_count.load(Ordering::SeqCst), 1, "history recovery must not replay the early Enter");
        terminal.click_send("fixture-model").await;
        // A real terminal keeps reading stdout while waiting for the provider.
        // This also exercises the production LocalEngine presentation acknowledgements.
        let awaiting = Instant::now();
        let mut request = loop {
            terminal.read();
            if let Ok(request) = fixture.requests.try_recv() {
                break request;
            }
            assert!(
                awaiting.elapsed() < Duration::from_secs(20),
                "physical Send click never reached the real provider:\n{}",
                terminal.snapshot()
            );
            tokio::time::sleep(Duration::from_millis(2)).await;
        };
        assert!(
            request
                .body
                .to_string()
                .contains("Production PTY user message")
        );
        request.thinking("PRODUCTION_PTY_REASONING").await;
        request.delta("REAL_PRODUCTION_PTY_STREAM").await;
        let streamed = terminal.wait_for("REAL_PRODUCTION_PTY_STREAM").await;
        evidence("production-pty-streaming", &streamed);
        request.delta(" completed.").await;
        request.finish().await;
        let committed = terminal.wait_for("completed.").await;
        evidence("production-pty-committed", &committed);
        let control = fixture.client().await;
        fixture.idle(&control, &fixture.session).await;
        control.close().await.unwrap();
        assert_eq!(fixture.request_count.load(Ordering::SeqCst), 2);
        terminal.wait_for("Completed").await;
        assert!(!terminal.snapshot().contains("Thinking · PRODUCTION_PTY_REASONING"));
        terminal.send(b"\x11");
        terminal.finish().await;
        drop(terminal);
        // A new OS process uses the same original Root and the same single
        // presentation: completed work is folded, and the source opens on request.
        let mut restarted = support::pty::Pty::spawn(&fixture.directory.path().join("host"), Some(&fixture.session));
        let folded = restarted.wait_for("REAL_PRODUCTION_PTY_STREAM").await;
        assert!(folded.contains("completed.") && !folded.contains("Details ·"));
        restarted.wait_for("Completed").await;
        restarted.click_text("Completed");
        restarted.wait_for("1 thought").await;
        restarted.click_text("1 thought");
        let reopened = restarted.wait_for("Thinking · PRODUCTION_PTY_REASONING").await;
        assert!(reopened.contains("REAL_PRODUCTION_PTY_STREAM"));
        assert_eq!(fixture.request_count.load(Ordering::SeqCst), 2, "reopening recorded work must not send another message");
        evidence("production-pty-work-after-restart", &reopened);
        restarted.send(b"\x11");
        restarted.finish().await;
        drop(restarted);
        let reconnected = fixture.client().await;
        let observed = reconnected.query("agent", "observe", json!({"sessionId":fixture.session})).await.unwrap();
        assert_eq!(observed["session"]["id"], fixture.session, "quitting the shell must detach without stopping its service Host");
        reconnected.close().await.unwrap();
        drop(gate);
        fixture.finish().await;
    })
    .await
    .expect("production binary PTY verification timed out");
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn production_history_retry_and_live_reconnect_preserve_the_draft_receipt_and_reader() {
    use maka_app_client::{Client, Journal};
    use maka_host_runtime::application::host::Client as HostClient;
    tokio::time::timeout(Duration::from_secs(90), async {
        let mut fixture = Fixture::registered().await;
        fixture.seed_history(1).await;
        let history = ReplyGate::disconnect_history(fixture.directory.path(), fixture.address.clone());
        let catchup = ReplyGate::history(fixture.directory.path(), history.address.clone());
        let watch = ReplyGate::disconnect_watch(fixture.directory.path(), catchup.address.clone());
        let send = ReplyGate::start(fixture.directory.path(), watch.address.clone());
        history.arm();
        fixture.register_at(&send.address);
        maka_event_log::root::private_directory(&fixture.directory.path().join("host/clients")).unwrap();
        let terminal_client = Client::new(
            HostClient::connect(&fixture.address, None).await.unwrap(),
            Journal::open(&fixture.directory.path().join("host/clients/terminal.sqlite")).await.unwrap(),
            "receipts".into(),
        ).unwrap();
        terminal_client.save_draft("agent", &fixture.session, EDITOR, None, "RECOVERY_ORIGINAL_A".into()).await.unwrap();
        let mut terminal = support::pty::Pty::spawn(&fixture.directory.path().join("host"), Some(&fixture.session));
        let failed = terminal.wait_for("Retry loading conversation").await;
        assert!(failed.contains("History unavailable."));
        assert!(failed.contains("History unavailable. Retrying automatically; your draft is kept."));
        terminal.wait_for("RECOVERY_ORIGINAL_A").await;
        support::wait_draft(&terminal_client, &fixture.session, "RECOVERY_ORIGINAL_A").await;
        terminal.click_text("Retry loading conversation");
        terminal.wait_for_absent("History unavailable.").await;
        terminal.wait_for_absent("Loading session history").await;
        assert_eq!(fixture.request_count.load(Ordering::SeqCst), 1, "retry must not send the retained draft");

        send.arm();
        terminal.click_send("fixture-model").await;
        let started = Instant::now();
        let mut request = loop {
            terminal.read();
            if let Ok(request) = fixture.requests.try_recv() { break request; }
            assert!(started.elapsed() < Duration::from_secs(20), "real Send did not reach the provider");
            tokio::time::sleep(Duration::from_millis(2)).await;
        };
        assert!(request.body.to_string().contains("RECOVERY_ORIGINAL_A"));
        terminal.wait_for("Confirming send").await;
        let pending = terminal_client.pending_operations("agent", &fixture.session, EDITOR).await.unwrap();
        assert_eq!(pending.len(), 1);
        let original = pending[0].clone();
        assert!(original.reference.is_some());
        assert!(original.receipt.is_none());
        let focus_frame = terminal.wire().len();
        terminal.send(b"\x0c");
        terminal.wait_for_wire(b"\x1b[?2026l", focus_frame).await;
        terminal.paste(" + LATER_UNSENT_B");
        terminal.wait_for("RECOVERY_ORIGINAL_A + LATER_UNSENT_B").await;
        support::wait_draft(&terminal_client, &fixture.session, "RECOVERY_ORIGINAL_A + LATER_UNSENT_B").await;
        request.delta("ACTIVE_PREFIX_ABCD").await;
        terminal.wait_for("ACTIVE_PREFIX_ABCD").await;

        // Move the reader to old history while the same model part stays open.
        // Recovery must preserve both this anchor and its already shown prefix.
        let focus_frame = terminal.wire().len();
        terminal.send(b"\x1b[1;3A");
        terminal.wait_for_wire(b"\x1b[?2026l", focus_frame).await;
        terminal.send(b"\x1b[H");
        terminal.wait_for("History 00 paragraph 00").await;
        catchup.arm();
        watch.arm_times(3);
        request.delta("MISSED_WHILE_DISCONNECTED\n\n").await;
        let reconnecting = terminal.wait_for("Reconnecting updates").await;
        assert!(reconnecting.contains("Reconnecting updates… Your draft is kept."));
        assert!(!reconnecting.contains("Reconnect updates"), "one transient loss must recover without a button");
        request.delta(" ACTIVE_OFFLINE_SUFFIX").await;
        let control = fixture.client().await;
        catchup.release();
        // Three real losses span more than four seconds. Returning service
        // still resumes automatically, with no mandatory Reconnect click.
        let started = Instant::now();
        while watch.remaining() != 0 {
            terminal.read();
            assert!(started.elapsed() < Duration::from_secs(20), "expected real watch disconnections did not occur");
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        terminal.wait_for("Updates disconnected.").await;
        terminal.wait_for("Confirming send").await;
        let restored = terminal.wait_for("History 00 paragraph 00").await;
        assert!(!restored.contains("ACTIVE_OFFLINE_SUFFIX"), "reconnect must not jump an old reader to the new tail");
        let retained = terminal_client.operation(original.id).await.unwrap();
        assert_eq!(retained.reference, original.reference);
        assert!(retained.receipt.is_none(), "reconnecting a watch must not settle or replace the held send receipt");
        assert_eq!(terminal_client.pending_operations("agent", &fixture.session, EDITOR).await.unwrap().len(), 1);
        support::wait_draft(&terminal_client, &fixture.session, "RECOVERY_ORIGINAL_A + LATER_UNSENT_B").await;
        assert_eq!(fixture.request_count.load(Ordering::SeqCst), 2);
        evidence("production-reconnect-retains-reader", &restored);
        terminal.send(b"\x0c");
        let active = terminal.wait_for("ACTIVE_OFFLINE_SUFFIX").await;
        assert_eq!(active.matches("ACTIVE_PREFIX_ABCD").count(), 1, "replaying an unfinished part must not repeat its visible prefix");
        request.delta(" OFFLINE_CANONICAL_FINAL").await;
        request.finish().await;
        fixture.idle(&control, &fixture.session).await;

        send.release();
        terminal.wait_for_absent("Confirming send").await;
        let settled = terminal_client.operation(original.id).await.unwrap();
        assert_eq!(settled.reference, original.reference);
        assert!(matches!(settled.receipt, Some(Receipt::Recorded {outcome:OperationOutcome::Returned {ref value},..}) if value["kind"] == "started"));
        support::wait_draft(&terminal_client, &fixture.session, "RECOVERY_ORIGINAL_A + LATER_UNSENT_B").await;
        let focus_frame = terminal.wire().len();
        terminal.send(b"\x0c");
        terminal.wait_for_wire(b"\x1b[?2026l", focus_frame).await;
        terminal.wait_for("OFFLINE_CANONICAL_FINAL").await;
        // The editor must retain the later draft in the presented UI too.
        terminal.wait_for("RECOVERY_ORIGINAL_A + LATER_UNSENT_B").await;
        // A new deliberate send proves the new live subscription receives
        // subsequent facts, rather than merely displaying its recovery snapshot.
        terminal.click_send("fixture-model").await;
        let started = Instant::now();
        let mut next = loop {
            terminal.read();
            if let Ok(request) = fixture.requests.try_recv() { break request; }
            assert!(started.elapsed() < Duration::from_secs(20), "new Send did not reach the provider:\n{}", terminal.snapshot());
            tokio::time::sleep(Duration::from_millis(2)).await;
        };
        assert!(next.body.to_string().contains("RECOVERY_ORIGINAL_A + LATER_UNSENT_B"));
        next.delta("RECONNECTED_LIVE_RESPONSE").await;
        terminal.wait_for("RECONNECTED_LIVE_RESPONSE").await;
        next.finish().await;
        fixture.idle(&control, &fixture.session).await;
        assert_eq!(fixture.request_count.load(Ordering::SeqCst), 3);
        let canonical = control.query("agent", "history", json!({"sessionId":fixture.session,"position":{"kind":"tail"},"view":"conversation"})).await.unwrap();
        assert_eq!(canonical["chunks"].as_array().unwrap().iter().filter(|chunk| chunk["role"] == "user" && chunk["text"] == "RECOVERY_ORIGINAL_A + LATER_UNSENT_B").count(), 1);
        terminal.send(b"\x11");
        terminal.finish().await;
        terminal_client.close().await.unwrap();
        control.close().await.unwrap();
        drop(send);
        drop(watch);
        drop(catchup);
        drop(history);
        fixture.finish().await;
    }).await.expect("production transcript recovery timed out");
}
