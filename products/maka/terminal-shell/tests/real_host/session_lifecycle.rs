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

async fn activate(view: &mut AppView, label: &str) {
    tab_to_label(view, label).await;
    view.handle_event(Event::Key(KeyEvent::new(
        KeyCode::Enter,
        KeyModifiers::NONE,
    )));
}

async fn fill_title(view: &mut AppView, title: &str) {
    wait_focused_input(view, "Conversation title").await;
    shortcut(view, 'a');
    view.handle_event(Event::Paste(title.into()));
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

async fn actions(view: &mut AppView, title: &str) {
    open_session_browser(view).await;
    wait_enabled_node(view, &format!("Actions for {title}")).await;
    support::click_label(view, &format!("Actions for {title}"));
    wait_enabled_node(view, "Fork conversation").await;
}

fn assert_sandbox_selection(view: &AppView, access: &str, ask: bool) {
    let nodes = view.accessibility_snapshot();
    for (label, selected) in [
        ("Read only", access == "read_only"),
        ("Workspace write", access == "workspace_write"),
        ("Full access · Sandbox off", access == "danger_full_access"),
        ("Ask for approval", ask),
        ("Do not ask for approval", !ask),
    ] {
        let choice = nodes
            .iter()
            .find(|node| node.role == nsh_core::AccessibilityRole::Button && node.label == label)
            .unwrap();
        assert!(
            !choice.state.disabled,
            "{label} must remain usable during the real run"
        );
        assert_eq!(
            choice.state.selected, selected,
            "the Host policy must select {label}"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn real_session_lifecycle_keeps_original_revisions_history_and_separate_drafts() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let mut fixture = Fixture::files("write").await;
        let client = fixture.client().await;
        let initial = client.query("agent", "observe", json!({"sessionId":fixture.session})).await.unwrap();
        assert_eq!(initial["session"]["permissions"], json!({"access":"workspace_write","requestPermissions":true}));
        assert_eq!(initial["session"]["boundaryRevision"], 0);
        let started = support::mutate(&client, "send", json!({
            "sessionId":fixture.session,"message":"History question 00","model":fixture.selection
        })).await;
        assert_eq!(started["kind"], "started");
        fixture.next_request().await.tool("WorkspaceDocument", json!({
            "path":"default-sandbox.txt","content":"DEFAULT_WORKSPACE_WRITE_ALLOWED\n"
        })).await;
        let mut request = fixture.next_request().await;
        let tool_result = request.body["messages"].as_array().unwrap().iter().rev()
            .find(|message| message["role"] == "tool").unwrap()["content"].as_str().unwrap();
        let written: Value = serde_json::from_str(tool_result).unwrap();
        assert_eq!(written["kind"], "completed", "the actual default policy must allow workspace writes: {written}");
        assert_eq!(std::fs::read_to_string(fixture.directory.path().join("workspace/default-sandbox.txt")).unwrap(), "DEFAULT_WORKSPACE_WRITE_ALLOWED\n");
        request.delta("Default workspace write completed; the original run remains active.").await;
        let (mut view, bindings) = fixture.view(client.clone(), Some(fixture.session.clone()));
        wait_view(&mut view, |screen| screen.contains("NSH real Agent")).await;
        tab_to_label(&mut view, "Message composer").await;
        wait_editable_composer(&mut view).await;
        view.handle_event(Event::Paste("Original draft stays with its owner".into()));
        support::wait_draft(&client, &fixture.session, "Original draft stays with its owner").await;

        support::click_button(&mut view, "Sandbox and approvals").await;
        wait_enabled_node(&mut view, "Close sandbox settings").await;
        assert_sandbox_selection(&view, "workspace_write", true);
        // Each axis preserves the other. The provider stream stays open so
        // these are real active-run metadata changes, rather than idle mocks.
        for (choice, access, ask, boundary) in [
            ("Read only", "read_only", true, 1),
            ("Do not ask for approval", "read_only", false, 2),
            ("Workspace write", "workspace_write", false, 3),
            ("Full access · Sandbox off", "danger_full_access", false, 4),
            ("Ask for approval", "danger_full_access", true, 5),
        ] {
            wait_enabled_node(&mut view, choice).await;
            support::click_button(&mut view, choice).await;
            wait_view_state(&mut view, |view, _| view.accessibility_snapshot().iter()
                .any(|node| node.label == choice && node.state.selected && !node.state.disabled)).await;
            assert_sandbox_selection(&view, access, ask);
            let observed = client.query("agent", "observe", json!({"sessionId":fixture.session})).await.unwrap();
            assert_eq!(observed["session"]["permissions"], json!({"access":access,"requestPermissions":ask}));
            assert_eq!(observed["session"]["boundaryRevision"], boundary);
            assert_eq!(observed["session"]["title"], initial["session"]["title"]);
            assert_eq!(observed["session"]["labels"], initial["session"]["labels"]);
            assert_eq!(observed["run"]["invocationId"], started["invocationId"], "sandbox choices must keep the same real run alive");
        }
        evidence("session-sandbox-full-access", &view.snapshot());
        // Escape belongs to the popover while the composer's Stop shortcut is
        // also live. Closing settings must not stop that original invocation.
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)));
        wait_view_state(&mut view, |view, _| !view.accessibility_snapshot().iter()
            .any(|node| node.label == "Close sandbox settings")).await;
        assert_eq!(client.query("agent", "observe", json!({"sessionId":fixture.session})).await.unwrap()["run"]["invocationId"], started["invocationId"]);
        support::wait_draft(&client, &fixture.session, "Original draft stays with its owner").await;
        drop(view);
        bindings.close().await.unwrap();
        let client = fixture.client().await;
        let (mut view, bindings) = fixture.view(client.clone(), Some(fixture.session.clone()));
        wait_editable_composer(&mut view).await;
        assert_eq!(view.surface().input_context().unwrap().text.as_deref(), Some("Original draft stays with its owner"));
        support::click_button(&mut view, "Sandbox and approvals").await;
        wait_enabled_node(&mut view, "Close sandbox settings").await;
        assert_sandbox_selection(&view, "danger_full_access", true);
        let restored = client.query("agent", "observe", json!({"sessionId":fixture.session})).await.unwrap();
        assert_eq!(restored["session"]["permissions"], json!({"access":"danger_full_access","requestPermissions":true}));
        assert_eq!(restored["session"]["boundaryRevision"], 5);
        assert_eq!(restored["run"]["invocationId"], started["invocationId"]);
        support::click_button(&mut view, "Close sandbox settings").await;
        request.finish().await;
        fixture.idle(&client, &fixture.session).await;
        wait_view_state(&mut view, |view, _| !view.accessibility_snapshot().iter()
            .any(|node| node.label == "Stop response")).await;

        // Native keyboard activation retains the original row's action anchor.
        open_session_browser(&mut view).await;
        tab_to_label(&mut view, "Actions for NSH real Agent").await;
        let original_anchor = view.surface().focused().unwrap();
        for exit in ["Back from conversation actions", "Close conversation actions"] {
            view.handle_event(Event::Key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)));
            activate(&mut view, "Rename conversation").await;
            wait_focused_input(&mut view, "Conversation title").await;
            support::click_label(&mut view, exit);
            if exit == "Back from conversation actions" {
                wait_enabled_node(&mut view, "Fork conversation").await;
                view.handle_event(Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)));
            }
            wait_view_state(&mut view, |view, _| view.accessibility_snapshot().iter().any(|node| {
                node.id == original_anchor && node.focused && node.label == "Actions for NSH real Agent"
            })).await;
        }
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)));
        activate(&mut view, "Rename conversation").await;
        fill_title(&mut view, "Renamed original").await;
        let observed = client.query("agent", "observe", json!({"sessionId":fixture.session})).await.unwrap();
        let external = support::mutate(&client, "metadata", json!({
            "sessionId":fixture.session,"expectedRevision":observed["session"]["revision"],
            "title":"Externally revised","labels":["external-label"]
        })).await;
        assert_eq!(external["kind"], "committed");
        activate(&mut view, "Save conversation title").await;
        wait_view(&mut view, |screen| screen.contains("Review its current details") && screen.contains("Externally revised")).await;
        assert_eq!(client.query("agent", "observe", json!({"sessionId":fixture.session})).await.unwrap()["session"]["title"], "Externally revised");
        // Refreshing a conflicting revision keeps the typed name. A second
        // explicit save keeps the newly observed labels rather than erasing them.
        activate(&mut view, "Save conversation title").await;
        wait_view(&mut view, |screen| screen.contains("Renamed original") && !screen.contains("Rename conversation")).await;
        let renamed = client.query("agent", "observe", json!({"sessionId":fixture.session})).await.unwrap();
        assert_eq!(renamed["session"]["title"], "Renamed original");
        assert_eq!(renamed["session"]["labels"], json!(["external-label"]));

        actions(&mut view, "Renamed original").await;
        support::click_label(&mut view, "Archive conversation");
        wait_view(&mut view, |screen| !screen.contains("Conversation actions") && !screen.contains("Updating conversation…")).await;
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)));
        wait_view(&mut view, |screen| screen.contains("This conversation is archived.")).await;
        assert_eq!(client.query("agent", "observe", json!({"sessionId":fixture.session})).await.unwrap()["session"]["archived"], true);
        support::wait_draft(&client, &fixture.session, "Original draft stays with its owner").await;
        open_session_browser(&mut view).await;
        wait_enabled_node(&mut view, "Show archived conversations").await;
        support::click_label(&mut view, "Show archived conversations");
        wait_enabled_node(&mut view, "Actions for Renamed original").await;
        support::click_label(&mut view, "Actions for Renamed original");
        wait_enabled_node(&mut view, "Restore conversation").await;
        support::click_label(&mut view, "Restore conversation");
        wait_view(&mut view, |screen| !screen.contains("Conversation actions") && !screen.contains("Updating conversation…")).await;
        support::click_label(&mut view, "Show active conversations");
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)));
        wait_view(&mut view, |screen| !screen.contains("This conversation is archived.")).await;
        assert_eq!(client.query("agent", "observe", json!({"sessionId":fixture.session})).await.unwrap()["session"]["archived"], false);

        actions(&mut view, "Renamed original").await;
        support::click_label(&mut view, "Fork conversation");
        fill_title(&mut view, "Independent fork").await;
        activate(&mut view, "Create conversation fork").await;
        wait_view(&mut view, |screen| screen.contains("Independent fork") && !screen.contains("Fork conversation")).await;
        let listed = client.query("agent", "list", json!({"filter":"all","scope":{"kind":"all"},"titleQuery":"Independent fork","position":{"kind":"start"}})).await.unwrap();
        assert_eq!(listed["sessions"].as_array().unwrap().len(), 1);
        let fork = &listed["sessions"][0];
        let fork_id = fork["id"].as_str().unwrap().to_owned();
        assert_eq!(fork["branch"]["sessionId"], fixture.session);
        assert_eq!(fork["labels"], json!(["external-label"]));
        let fork_observed = client.query("agent", "observe", json!({"sessionId":fork_id})).await.unwrap();
        let history = client.query("agent", "history", json!({"sessionId":fork_id,"through":fork_observed["through"],"position":{"kind":"tail"},"view":"conversation"})).await.unwrap();
        assert!(history.to_string().contains("History question 00"), "the fork must copy the real original history: {history}");
        tab_to_label(&mut view, "Message composer").await;
        wait_editable_composer(&mut view).await;
        assert_eq!(view.surface().input_context().unwrap().text.as_deref(), Some(""));
        view.handle_event(Event::Paste("Independent fork draft".into()));
        support::wait_draft(&client, &fork_id, "Independent fork draft").await;
        open_session_browser(&mut view).await;
        wait_enabled_node(&mut view, "Open conversation Renamed original").await;
        support::click_label(&mut view, "Open conversation Renamed original");
        wait_view(&mut view, |screen| screen.contains("Original draft stays with its owner")).await;
        tab_to_label(&mut view, "Message composer").await;
        wait_editable_composer(&mut view).await;
        assert_eq!(view.surface().input_context().unwrap().text.as_deref(), Some("Original draft stays with its owner"));

        open_session_browser(&mut view).await;
        wait_enabled_node(&mut view, "Choose workspace scope").await;
        support::click_label(&mut view, "Choose workspace scope");
        wait_enabled_node(&mut view, "Workspace scopes").await;
        support::click_text(&mut view, "Current workspace");
        wait_enabled_node(&mut view, "Conversations").await;
        actions(&mut view, "Renamed original").await;
        support::click_label(&mut view, "Delete conversation");
        wait_enabled_node(&mut view, "Confirm delete conversation").await;
        assert_eq!(client.query("agent", "observe", json!({"sessionId":fixture.session})).await.unwrap()["session"]["id"], fixture.session, "opening confirmation must not delete the source");
        activate(&mut view, "Confirm delete conversation").await;
        wait_view(&mut view, |screen| screen.contains("Make something remarkable.") && !screen.contains("Delete conversation?")).await;
        let remaining = client.query("agent", "list", json!({"filter":"all","scope":{"kind":"all"},"titleQuery":"","position":{"kind":"start"}})).await.unwrap();
        assert_eq!(remaining["sessions"].as_array().unwrap().len(), 1);
        assert_eq!(remaining["sessions"][0]["id"], fork_id);
        // The removed source no longer grants a workspace-scoped read. The
        // same browser must retire that scope and still expose the real fork.
        open_session_browser(&mut view).await;
        wait_enabled_node(&mut view, "Open conversation Independent fork").await;
        wait_view(&mut view, |screen| screen.contains("All workspaces")).await;
        support::wait_draft(&client, &fork_id, "Independent fork draft").await;
        assert!(fixture.directory.path().join("workspace").is_dir(), "deleting a conversation must retain its workspace");
        assert!(client.pending_controls().await.unwrap().is_empty());
        assert_eq!(fixture.request_count.load(Ordering::SeqCst), 2, "sandbox and lifecycle actions must not replay any real model request");
        evidence("session-lifecycle-final", &view.snapshot());
        drop(view);
        bindings.close().await.unwrap();
        fixture.finish().await;
    }).await.unwrap();
}
