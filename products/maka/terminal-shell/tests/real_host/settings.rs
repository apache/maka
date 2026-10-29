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

use super::*;

async fn assert_input(view: &mut AppView, label: &str, value: &str) {
    tab_to_label(view, label).await;
    wait_focused_input(view, label).await;
    assert_eq!(
        view.surface().input_context().unwrap().text.as_deref(),
        Some(value),
        "the native {label:?} draft changed"
    );
}
fn painted_control(view: &AppView, label: &str) -> String {
    use ratatui::{buffer::CellWidth, layout::Rect};
    let node = view
        .accessibility_snapshot()
        .into_iter()
        .find(|node| node.focused && node.label == label)
        .unwrap();
    let metrics = view.surface().metrics();
    let viewport = view.surface().viewport();
    let columns = (viewport.width.0 / metrics.width().0).round() as u16;
    let rows = (viewport.height.0 / metrics.height().0).round() as u16;
    let project = |point: f32, cell: f32, limit: u16| {
        (point / cell - 0.5).ceil().clamp(0.0, f32::from(limit)) as u16
    };
    let left = project(node.frame.origin.x.0, metrics.width().0, columns);
    let right = project(
        node.frame.origin.x.0 + node.frame.size.width.0,
        metrics.width().0,
        columns,
    );
    let top = project(node.frame.origin.y.0, metrics.height().0, rows);
    let bottom = project(
        node.frame.origin.y.0 + node.frame.size.height.0,
        metrics.height().0,
        rows,
    );
    let area = Rect::new(0, 0, columns, rows);
    let mut buffer = ratatui::buffer::Buffer::empty(area);
    view.render(area, &mut buffer);
    let mut text = String::new();
    for y in top..bottom {
        let mut x = left;
        while x < right {
            let cell = &buffer[(x, y)];
            text.push_str(cell.symbol());
            x += cell.cell_width().max(1);
        }
        text.push('\n');
    }
    text
}
async fn assert_default_input(view: &mut AppView, label: &str, default: &str) {
    assert_input(view, label, "").await;
    wait_view_state(view, |view, _| {
        painted_control(view, label).contains(default)
    })
    .await;
    assert_eq!(
        view.surface().input_context().unwrap().text.as_deref(),
        Some(""),
        "the {label:?} placeholder must not become editable content"
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
        .find(|node| node.role == nsh_core::AccessibilityRole::Button && node.label == save_label)
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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn empty_settings_configure_a_real_connection_and_manual_reasoning_model_before_one_send() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let mut fixture = Fixture::configured(support::Options {
            registered: cfg!(unix),
            catalog: support::Catalog::Empty,
            ..Default::default()
        }).await;
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
        fill(&mut view, "Search providers", "OPENROUTER").await;
        wait_view(&mut view, |screen| screen.contains("OpenRouter") && !screen.contains("Loading settings…")).await;
        assert_input(&mut view, "Search providers", "OPENROUTER").await;
        support::click_button(&mut view, "Connect OpenRouter").await;
        wait_view(&mut view, |screen| screen.contains("Connection settings") && screen.contains("Connection name")).await;
        fill(&mut view, "Connection name", "UI 连接").await;
        fill(&mut view, "Connection ID", "ui-connection").await;
        fill(&mut view, "Base URL", &fixture.base_url).await;
        fill(&mut view, "API key", support::PROVIDER_KEY).await;
        assert!(!view.snapshot().contains(support::PROVIDER_KEY), "the raw key was painted by the form");
        fill(&mut view, "Advanced request JSON", r#"{"provider":{"only":["openrouter","deepseek"]},"temperature":0.22}"#).await;
        activate(&mut view, "Save connection").await;
        // Saving the key advances the connection revision. The same editor must
        // discover models automatically using that committed credential basis.
        wait_view(&mut view, |screen| screen.contains("Connection and API key saved.")).await;
        assert_eq!(fixture.request_count.load(Ordering::SeqCst), 0);
        activate(&mut view, "Manage models").await;
        wait_view(&mut view, |screen| screen.contains("Connection models") && screen.contains("fixture-discovered-model")).await;
        assert_eq!(fixture.discovery_count.load(Ordering::SeqCst), 1, "saving the connection must automatically perform exactly one real discovery request");
        let discovered = client.query("settings", "models", json!({"kind":"start","query":"fixture-discovered-model"})).await.unwrap();
        let discovered_choice = &discovered["choices"][0];
        assert_eq!(discovered_choice["thinkingLevels"], json!(["max","high","low","off"]));
        assert_eq!(discovered_choice["defaultThinkingLevel"], "high");
        activate(&mut view, "Edit model fixture-discovered-model").await;
        for (label, default) in [
            ("Model display name", "Discovered UI Model"),
            ("Context window (tokens)", "131072"),
            ("Input limit (tokens)", "131072"),
            ("Maximum output (tokens)", "4096"),
            ("Compaction threshold (tokens)", "111411"),
        ] {
            assert_default_input(&mut view, label, default).await;
        }
        tab_to_label(&mut view, "Support effort high").await;
        let node = support::wait_enabled_button(&mut view, "Support effort high").await;
        assert!(node.state.selected, "provider-discovered efforts must be visible without an override");
        for label in ["Code Mode: Model default", "Apply Patch: Model default", "Code Mode language: JavaScript"] {
            tab_to_label(&mut view, label).await;
            assert!(support::wait_enabled_button(&mut view, label).await.state.selected, "omitted tool overrides must retain model defaults");
            if label != "Code Mode language: JavaScript" {
                assert!(painted_control(&view, label).contains("Model default (Disabled)"));
            }
        }
        for label in ["Use provider defaults (max, high, low, off)", "Provider default (high)"] {
            tab_to_label(&mut view, label).await;
            assert!(support::wait_enabled_button(&mut view, label).await.state.selected);
        }
        fill(&mut view, "Maximum output (tokens)", "0").await;
        fill(&mut view, "Context window (tokens)", "6000").await;
        fill(&mut view, "Input limit (tokens)", "4000").await;
        fill(&mut view, "Maximum output (tokens)", "").await;
        assert_default_input(&mut view, "Compaction threshold (tokens)", "3400").await;
        fill(&mut view, "Context window (tokens)", "").await;
        fill(&mut view, "Input limit (tokens)", "").await;
        assert_default_input(&mut view, "Compaction threshold (tokens)", "111411").await;
        activate(&mut view, "Save model").await;
        wait_view(&mut view, |screen| screen.contains("Connection models") && screen.contains("Model saved.")).await;
        activate(&mut view, "Add model manually").await;
        wait_view(&mut view, |screen| screen.contains("Model settings") && screen.contains("Model ID")).await;
        fill(&mut view, "Model ID", "manual-ui-agent").await;
        fill(&mut view, "Model display name", "Manual UI Agent").await;
        fill(&mut view, "Context window (tokens)", "65536").await;
        fill(&mut view, "Input limit (tokens)", "32768").await;
        fill(&mut view, "Maximum output (tokens)", "2048").await;
        fill(&mut view, "Compaction threshold (tokens)", "18000").await;
        activate(&mut view, "Code Mode: Enabled").await;
        activate(&mut view, "Apply Patch: Disabled").await;
        activate(&mut view, "Code Mode language: Python").await;
        activate(&mut view, "Support effort high").await;
        activate(&mut view, "Default effort high").await;
        activate(&mut view, "Save model").await;
        wait_view(&mut view, |screen| screen.contains("Connection models") && screen.contains("Model saved.") && screen.contains("Manual UI Agent")).await;
        fill(&mut view, "Search models", "MANUAL UI").await;
        wait_view_state(&mut view, |view, screen| screen.contains("Manual UI Agent") && !view.accessibility_snapshot().iter().any(|node| node.label == "Edit model fixture-discovered-model")).await;
        assert_input(&mut view, "Search models", "MANUAL UI").await;
        fill(&mut view, "Search models", "fixture-discovered-model").await;
        wait_view_state(&mut view, |view, screen| screen.contains("fixture-discovered-model") && !view.accessibility_snapshot().iter().any(|node| node.label == "Edit model manual-ui-agent")).await;
        fill(&mut view, "Search models", "").await;
        wait_view(&mut view, |screen| screen.contains("Manual UI Agent") && screen.contains("fixture-discovered-model")).await;
        activate(&mut view, "Set default manual-ui-agent").await;
        wait_view(&mut view, |screen| screen.contains("Default model saved.")).await;
        let catalog = client.query("settings", "connections", json!({"kind":"start"})).await.unwrap();
        let basis = &catalog["connections"][0]["basis"];
        let target = json!({"connectionId":basis["connectionId"],"modelId":"manual-ui-agent"});
        assert_eq!(catalog["defaultTarget"], target);
        let detail = client.query("settings", "connection", json!({"connectionId":basis["connectionId"],"revision":basis["revision"],"includeEditingFacts":true})).await.unwrap();
        // Put the searched connection beyond the public catalog's first page.
        // Empty inventories keep these rows out of the real model/send flow.
        let mut catalog_revision = catalog["revision"].clone();
        for index in 0..16 {
            let last = index == 15;
            let mutation = client.mutation(
                Uuid::new_v4(), "settings", "create",
                json!({"expectedCatalogRevision":catalog_revision,"connection":{
                    "slug":if last { "last-page-connection".to_owned() } else { format!("search-filler-{index}") },
                    "name":if last { "Later 中文 connection".to_owned() } else { format!("Search filler {index}") },
                    "provider":detail["target"]["provider"],"configuration":{"baseUrl":fixture.base_url},
                    "enabled":false,"enabledModelIds":[]
                }}), Default::default(), None, Value::Null,
            ).await.unwrap();
            mutation.prepare().await.unwrap();
            let reply = mutation.confirm().await.unwrap();
            let Receipt::Recorded { outcome: OperationOutcome::Returned { value }, .. } = reply.receipt else {
                panic!("the real settings catalog mutation was not recorded")
            };
            assert_eq!(value["kind"], "committed");
            catalog_revision = value["catalogRevision"].clone();
        }
        let first_page = client.query("settings", "connections", json!({"kind":"start"})).await.unwrap();
        assert_eq!(first_page["connections"].as_array().unwrap().len(), 16);
        assert_eq!(first_page["next"], 16);
        assert!(!first_page["connections"].as_array().unwrap().iter().any(|row| row["slug"] == "last-page-connection"));
        activate(&mut view, "Back from connection settings").await;
        wait_view(&mut view, |screen| screen.contains("Connection settings") && screen.contains("Connection name")).await;
        activate(&mut view, "Back from connection settings").await;
        wait_view_state(&mut view, |view, screen| screen.contains("Connections & models") && screen.contains("Refresh connections") && view.accessibility_snapshot().iter().any(|node| node.role == nsh_core::AccessibilityRole::Button && node.label == "Close settings" && !node.state.disabled) && !view.accessibility_snapshot().iter().any(|node| node.role == nsh_core::AccessibilityRole::Button && node.label == "Back from connection settings")).await;
        fill(&mut view, "Search connections", "later 中文 OPENROUTER").await;
        wait_view_state(&mut view, |view, screen| screen.contains("Later 中文 connection") && !screen.contains("Loading settings…") && !view.accessibility_snapshot().iter().any(|node| node.label == "Edit connection UI 连接")).await;
        assert_input(&mut view, "Search connections", "later 中文 OPENROUTER").await;
        activate(&mut view, "Edit connection Later 中文 connection").await;
        wait_view(&mut view, |screen| screen.contains("Connection settings") && screen.contains("Connection name")).await;
        assert_input(&mut view, "Connection ID", "last-page-connection").await;
        activate(&mut view, "Back from connection settings").await;
        fill(&mut view, "Search connections", "UI-CONNECTION").await;
        wait_view_state(&mut view, |view, screen| screen.contains("UI 连接") && !screen.contains("Loading settings…") && !view.accessibility_snapshot().iter().any(|node| node.label == "Edit connection Later 中文 connection")).await;
        activate(&mut view, "Close settings").await;
        wait_view_state(&mut view, |view, screen| screen.contains("Make something remarkable.") && !view.accessibility_snapshot().iter().any(|node| node.role == nsh_core::AccessibilityRole::Button && node.label == "Close settings")).await;
        support::click_button(&mut view, "Choose composer workspace").await;
        wait_view_state(&mut view, |view, screen| screen.contains("Workspace locations") && !screen.contains("Loading folders…") && view.accessibility_snapshot().iter().any(|node| node.role == nsh_core::AccessibilityRole::Button && node.label == "Browse folder Workspace" && !node.state.disabled)).await;
        support::click_button(&mut view, "Browse folder Workspace").await;
        wait_view(&mut view, |screen| screen.contains("Folder · Workspace") && !screen.contains("Loading folders…")).await;
        wait_enabled_node(&mut view, "Use this workspace folder").await;
        support::click_button(&mut view, "Use this workspace folder").await;
        wait_view(&mut view, |screen| screen.contains("Search models…") && !screen.contains("Loading…")).await;
        select_palette(&mut view, "Search models…", "fixture-discovered-model", "Discovered UI Model").await;
        wait_view_state(&mut view, |view, screen| screen.contains("Discovered UI Model · high") && model_menu_closed(view)).await;
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
        for (label, value) in [("Context window (tokens)", "65536"), ("Input limit (tokens)", "32768"), ("Maximum output (tokens)", "2048"), ("Compaction threshold (tokens)", "18000")] {
            assert_input(&mut view, label, value).await;
        }
        fill(&mut view, "Maximum output (tokens)", "").await;
        assert_default_input(&mut view, "Maximum output (tokens)", "8000").await;
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
        assert_eq!(cancelled_policy["choice"]["limits"], saved_policy["choice"]["limits"], "closing the editor must retain the saved explicit output budget");
        tab_to_label(&mut view, "Message composer").await;
        editable(&mut view, "Message composer").await;
        view.handle_event(Event::Paste("Use my new connection exactly once".into()));
        support::wait_draft(&client, &session, "Use my new connection exactly once").await;
        let composer = view.surface().focused().unwrap();
        support::wait_enabled_button(&mut view, "Send message").await;
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)));
        let mut request = fixture.next_request().await;
        assert_eq!(request.body["model"], "manual-ui-agent");
        assert_eq!(request.body["max_tokens"], 2048);
        assert_eq!(request.body["reasoning_effort"], "high");
        assert_eq!(request.body["provider"], json!({"only":["openrouter","deepseek"]}));
        assert_eq!(request.body["temperature"], 0.22);
        assert!(request.body["tools"].as_array().unwrap().iter().any(|tool| tool["function"]["name"] == "exec"), "the model's saved Code Mode policy must reach the actual provider request");
        assert!(request.body["messages"].as_array().unwrap().iter().any(|message| message["role"] == "user" && message["content"].to_string().contains("Use my new connection exactly once")));
        request.thinking("SETTINGS_CONNECTION_REASONING").await;
        request.delta("SETTINGS_CONNECTION_SINGLE_SEND_DONE").await;
        request.finish().await;
        fixture.idle(&client, &session).await;
        let completed = wait_view(&mut view, |screen| screen.contains("SETTINGS_CONNECTION_SINGLE_SEND_DONE")).await;
        evidence("settings-empty-to-real-provider", &completed);
        support::evidence_cells("settings-empty-to-real-provider", &view);
        assert_eq!(fixture.request_count.load(Ordering::SeqCst), 1);
        assert_eq!(fixture.discovery_count.load(Ordering::SeqCst), 1);
        assert_eq!(view.surface().focused(), Some(composer));
        drop(view);
        bindings.close().await.unwrap();
        client.close().await.unwrap();
        #[cfg(unix)]
        {
            let mut terminal = support::pty::Pty::spawn(env!("CARGO_BIN_EXE_maka"), &fixture.directory.path().join("host"), Some(&session));
            terminal.wait_for("SETTINGS_CONNECTION_SINGLE_SEND_DONE").await;
            let restored = terminal.wait_for("Manual UI Agent · high").await;
            assert!(!restored.contains(support::PROVIDER_KEY));
            assert_eq!(fixture.request_count.load(Ordering::SeqCst), 1);
            assert_eq!(fixture.discovery_count.load(Ordering::SeqCst), 1);
            terminal.send(b"\x11");
            terminal.finish().await;
        }
        fixture.finish().await;
    }).await.expect("empty settings must configure and send through the actual model");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn network_and_personalization_keep_independent_drafts_and_commit_the_selected_locale() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let fixture = Fixture::open().await;
        let client = fixture.client().await;
        let session = fixture.session.clone();
        let (mut view, bindings) = fixture.view(client.clone(), Some(session.clone()));
        wait_editable_composer(&mut view).await;
        view.handle_event(Event::Paste("SETTINGS_KEEP_RESIDENT_DRAFT".into()));
        support::wait_draft(&client, &session, "SETTINGS_KEEP_RESIDENT_DRAFT").await;
        let composer = view.surface().focused().unwrap();
        shortcut(&mut view, 'p');
        select_palette(
            &mut view,
            "Search commands…",
            "Connections & models",
            "Connections & models",
        )
        .await;
        activate(&mut view, "Settings section General").await;
        wait_view(&mut view, |screen| {
            screen.contains("General settings") && !screen.contains("Reading preferences…")
        })
        .await;
        let original_preferences = client
            .query("settings", "assistantPreferences", json!({}))
            .await
            .unwrap();
        activate(&mut view, "Edit personalization").await;
        fill(&mut view, "Display name", "界面草稿用户").await;
        activate(&mut view, "Settings section Network").await;
        wait_view(&mut view, |screen| {
            screen.contains("Network settings") && !screen.contains("Loading network settings…")
        })
        .await;
        let initial_network = client
            .query("settings", "network", json!({}))
            .await
            .unwrap();
        assert_eq!(initial_network["proxy"]["enabled"], false);
        assert_eq!(initial_network["proxy"]["authEnabled"], false);
        assert!(
            !support::wait_enabled_button(&mut view, "Enable Host proxy")
                .await
                .state
                .selected
        );
        activate(&mut view, "Proxy protocol http").await;
        fill(&mut view, "Proxy host", "proxy.invalid").await;
        fill(&mut view, "Proxy port", "8080").await;
        activate(&mut view, "Enable proxy authentication").await;
        fill(&mut view, "Proxy username", "proxy-user").await;
        activate(&mut view, "Replace proxy password").await;
        let proxy_secret = "代理密码原值";
        fill(&mut view, "Proxy password", proxy_secret).await;
        assert!(
            !view.snapshot().contains(proxy_secret),
            "the proxy password was painted by the form"
        );
        activate(&mut view, "Save network settings").await;
        wait_view(&mut view, |screen| {
            screen.contains("Network settings saved.")
                && !screen.contains("Loading network settings…")
        })
        .await;
        let saved_network = client
            .query("settings", "network", json!({}))
            .await
            .unwrap();
        let mut expected_proxy = initial_network["proxy"].clone();
        expected_proxy["protocol"] = json!("http");
        expected_proxy["host"] = json!("proxy.invalid");
        expected_proxy["port"] = json!(8080);
        expected_proxy["authEnabled"] = json!(true);
        expected_proxy["username"] = json!("proxy-user");
        assert_eq!(saved_network["proxy"], expected_proxy);
        assert_eq!(saved_network["credential"]["configured"], true);
        assert!(!saved_network.to_string().contains(proxy_secret));
        assert!(
            saved_network["revision"].as_u64().unwrap()
                > original_preferences["revision"].as_u64().unwrap()
        );
        activate(&mut view, "Settings section General").await;
        wait_view(&mut view, |screen| {
            screen.contains("Personalization") && screen.contains("Display name")
        })
        .await;
        assert_input(&mut view, "Display name", "界面草稿用户").await;
        activate(&mut view, "Save this preference").await;
        wait_view(&mut view, |screen| {
            screen.contains("Preferences changed elsewhere.") && screen.contains("界面草稿用户")
        })
        .await;
        let save = view
            .accessibility_snapshot()
            .into_iter()
            .find(|node| {
                node.role == nsh_core::AccessibilityRole::Button
                    && node.label == "Save this preference"
            })
            .expect("the stale preference editor lost its actual Save button");
        assert!(
            save.state.disabled,
            "a stale preference draft must require explicit discard before another save"
        );
        let conflicted = client
            .query("settings", "assistantPreferences", json!({}))
            .await
            .unwrap();
        assert_eq!(conflicted["revision"], saved_network["revision"]);
        assert_eq!(
            conflicted["displayName"],
            original_preferences["displayName"]
        );
        // Cancel explicitly discards this stale draft and reads the Host's
        // current shared policy before another personalization edit is opened.
        activate(&mut view, "Cancel").await;
        activate(&mut view, "Edit personalization").await;
        fill(&mut view, "Display name", "已保存的中文用户").await;
        activate(&mut view, "Save this preference").await;
        wait_view(&mut view, |screen| {
            screen.contains("General settings") && screen.contains("Preferences saved.")
        })
        .await;
        let settings_close = support::wait_enabled_button(&mut view, "Close settings")
            .await
            .id;
        activate(&mut view, "Language: 简体中文").await;
        wait_view_state(&mut view, |view, screen| {
            screen.contains("常规设置")
                && screen.contains("偏好已保存。")
                && view.accessibility_snapshot().iter().any(|node| {
                    node.role == nsh_core::AccessibilityRole::Button
                        && node.label == "语言：简体中文"
                        && node.state.selected
                })
                && view
                    .accessibility_snapshot()
                    .iter()
                    .any(|node| node.id == settings_close && node.label == "关闭设置")
        })
        .await;
        let saved_preferences = client
            .query("settings", "assistantPreferences", json!({}))
            .await
            .unwrap();
        assert_eq!(saved_preferences["displayName"], "已保存的中文用户");
        assert_eq!(
            saved_preferences["language"], "zh-CN",
            "the interface and assistant must share the committed Host language"
        );
        activate(&mut view, "语言：繁體中文").await;
        wait_view_state(&mut view, |view, screen| {
            screen.contains("一般設定")
                && screen.contains("偏好已儲存。")
                && view.accessibility_snapshot().iter().any(|node| {
                    node.role == nsh_core::AccessibilityRole::Button
                        && node.label == "語言：繁體中文"
                        && node.state.selected
                })
                && view
                    .accessibility_snapshot()
                    .iter()
                    .any(|node| node.id == settings_close && node.label == "關閉設定")
        })
        .await;
        let traditional_preferences = client
            .query("settings", "assistantPreferences", json!({}))
            .await
            .unwrap();
        assert_eq!(traditional_preferences["language"], "zh-TW");
        assert!(
            traditional_preferences["revision"].as_u64().unwrap()
                > saved_preferences["revision"].as_u64().unwrap()
        );
        assert_eq!(
            traditional_preferences["displayName"],
            saved_preferences["displayName"]
        );
        activate(&mut view, "語言：English").await;
        wait_view_state(&mut view, |view, screen| {
            screen.contains("General settings")
                && screen.contains("Preferences saved.")
                && view.accessibility_snapshot().iter().any(|node| {
                    node.role == nsh_core::AccessibilityRole::Button
                        && node.label == "Language: English"
                        && node.state.selected
                })
                && view
                    .accessibility_snapshot()
                    .iter()
                    .any(|node| node.id == settings_close && node.label == "Close settings")
        })
        .await;
        let saved_preferences = client
            .query("settings", "assistantPreferences", json!({}))
            .await
            .unwrap();
        assert_eq!(saved_preferences["language"], "en");
        assert!(
            saved_preferences["revision"].as_u64().unwrap()
                > traditional_preferences["revision"].as_u64().unwrap()
        );
        let final_network = client
            .query("settings", "network", json!({}))
            .await
            .unwrap();
        assert_eq!(final_network["proxy"], saved_network["proxy"]);
        assert_eq!(final_network["credential"], saved_network["credential"]);
        assert!(!final_network.to_string().contains(proxy_secret));
        activate(&mut view, "Close settings").await;
        editable(&mut view, "Message composer").await;
        assert_eq!(view.surface().focused(), Some(composer));
        assert_eq!(
            view.surface().input_context().unwrap().text.as_deref(),
            Some("SETTINGS_KEEP_RESIDENT_DRAFT")
        );
        drop(view);
        bindings.close().await.unwrap();
        client.close().await.unwrap();
        fixture.finish().await;
    })
    .await
    .expect("network, preference CAS and language changes retain the original editor");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn global_and_compaction_documents_keep_literal_drafts_receipts_and_scroll_ownership() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let mut fixture = Fixture::open().await;
        let instruction_path = fixture.directory.path().join("assistant-home/.maka/AGENTS.md");
        std::fs::create_dir_all(instruction_path.parent().unwrap()).unwrap();
        let initial_instructions = "  INITIAL GLOBAL UTF-8 指令 🦀\r\n\r\n\tKeep user-owned whitespace.  \r\n\r\n";
        std::fs::write(&instruction_path, initial_instructions).unwrap();
        let client = fixture.client().await;
        let session = fixture.session.clone();
        let selected = support::mutate(&client, "selectBackend", json!({
            "sessionId":session,
            "backend":{"kind":"model","connectionId":fixture.selection["connectionId"],"modelId":fixture.selection["modelId"],"thinkingLevel":null}
        })).await;
        assert_eq!(selected["kind"], "committed");
        let (mut view, bindings) = fixture.view(client.clone(), Some(session.clone()));
        wait_editable_composer(&mut view).await;
        view.handle_event(Event::Paste("SETTINGS_KEEP_RESIDENT_DRAFT".into()));
        support::wait_draft(&client, &session, "SETTINGS_KEEP_RESIDENT_DRAFT").await;
        let composer = view.surface().focused().unwrap();
        shortcut(&mut view, 'p');
        select_palette(&mut view, "Search commands…", "Connections & models", "Connections & models").await;
        activate(&mut view, "Settings section General").await;
        wait_view(&mut view, |screen| screen.contains("General settings") && !screen.contains("Reading preferences…")).await;
        let saved_preferences = client.query("settings", "assistantPreferences", json!({})).await.unwrap();
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
        activate(&mut view, "Close settings").await;
        editable(&mut view, "Message composer").await;
        assert_eq!(view.surface().focused(), Some(composer));
        assert_eq!(view.surface().input_context().unwrap().text.as_deref(), Some("SETTINGS_KEEP_RESIDENT_DRAFT"));
        support::wait_enabled_button(&mut view, "Send message").await;
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)));
        let request = fixture.next_request().await;
        let system_prompt = request.body["messages"].as_array().unwrap().iter()
            .filter(|message| message["role"] == "system")
            .filter_map(|message| message["content"].as_str()).collect::<Vec<_>>().join("\n");
        assert_eq!(system_prompt.matches("GLOBAL_UI_INSTRUCTIONS_UNIQUE").count(), 1, "admission must capture the saved global file once");
        assert!(system_prompt.contains(final_instructions.trim()), "the provider did not receive the saved full global instructions");
        assert!(!system_prompt.contains("INITIAL GLOBAL UTF-8"));
        assert!(!system_prompt.contains("EXTERNAL GLOBAL UPDATE"));
        assert!(!system_prompt.contains("REMOTE SAVED GLOBAL INSTRUCTIONS"));

        request.finish().await;
        fixture.idle(&client, &session).await;
        drop(view);
        bindings.close().await.unwrap();
        client.close().await.unwrap();
        fixture.finish().await;
    }).await.expect("document editors must preserve full original text and settle original saves");
}
