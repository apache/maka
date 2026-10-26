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

async fn open_compact(view: &mut AppView) {
    shortcut(view, 'p');
    select_palette(
        view,
        "Search commands…",
        "Compact conversation",
        "Compact conversation",
    )
    .await;
    wait_focused_input(view, "One-time compaction prompt").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn manual_compaction_edits_once_and_retains_completed_divider_after_reopen() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let mut fixture = Fixture::open().await;
        fixture.seed_history(1).await;
        let client = fixture.client().await;
        let preferences = client
            .query("settings", "assistantPreferences", json!({}))
            .await
            .unwrap();
        let prompt = client
            .query(
                "agent",
                "compactionPrompt",
                json!({"sessionId": fixture.session}),
            )
            .await
            .unwrap();
        let (mut view, bindings) =
            fixture.view(fixture.client().await, Some(fixture.session.clone()));
        wait_editable_composer(&mut view).await;
        open_compact(&mut view).await;
        assert_eq!(
            view.surface().input_context().unwrap().text.as_deref(),
            prompt["compactionPrompt"].as_str()
        );
        evidence("compaction-prompt-dialog", &view.snapshot());
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)));
        wait_editable_composer(&mut view).await;
        assert_eq!(fixture.request_count.load(Ordering::SeqCst), 1);
        open_compact(&mut view).await;
        shortcut(&mut view, 'a');
        view.handle_event(Event::Paste(
            "Keep the decisions and paths. ONE_TIME_COMPACTION_PROMPT".into(),
        ));
        wait_view_state(&mut view, |view, _| {
            view.surface().input_context().is_some_and(|input| {
                input
                    .text
                    .as_deref()
                    .is_some_and(|text| text.contains("ONE_TIME_COMPACTION_PROMPT"))
            })
        })
        .await;
        support::click_button(&mut view, "Compact now").await;
        let running = wait_view(&mut view, |screen| {
            screen.contains("Compacting context…") && !screen.contains("One-time compaction prompt")
        })
        .await;
        evidence("compaction-manual-running-divider", &running);
        let (mut reopened, reopened_bindings) = fixture.view(fixture.client().await, Some(fixture.session.clone()));
        wait_view(&mut reopened, |screen| screen.contains("Compacting context…")).await;
        drop(reopened);
        reopened_bindings.close().await.unwrap();
        let mut request = fixture.next_request().await;
        assert!(
            request
                .body
                .to_string()
                .contains("ONE_TIME_COMPACTION_PROMPT"),
            "{}",
            request.body
        );
        request
            .delta("Compacted context for the next request.")
            .await;
        request.finish().await;
        fixture.idle(&client, &fixture.session).await;
        let completed = wait_view(&mut view, |screen| {
            screen.contains("Context compacted (") && !screen.contains("Compacting context…")
        })
        .await;
        let observed = client.query("agent", "observe", json!({"sessionId": fixture.session})).await.unwrap();
        let history = client.query("agent", "history", json!({"sessionId": fixture.session, "through": observed["through"], "position": {"kind": "tail"}, "view": "conversation"})).await.unwrap();
        let duration = history["chunks"].as_array().unwrap().iter().find(|chunk| chunk["role"] == "compaction").unwrap()["compaction"]["durationMs"].as_u64().unwrap();
        let completed_label = format!("Context compacted ({:.1}s)", duration as f64 / 1000.0);
        assert!(completed.contains(&completed_label), "{completed}");
        evidence("compaction-completed-divider", &completed);
        assert!(!completed.contains("Compacted context for the next request."));
        assert_eq!(
            client
                .query("settings", "assistantPreferences", json!({}))
                .await
                .unwrap(),
            preferences
        );
        drop(view);
        bindings.close().await.unwrap();
        let (mut view, bindings) =
            fixture.view(fixture.client().await, Some(fixture.session.clone()));
        wait_view(&mut view, |screen| screen.contains(&completed_label)).await;
        open_compact(&mut view).await;
        assert_eq!(
            view.surface().input_context().unwrap().text.as_deref(),
            prompt["compactionPrompt"].as_str()
        );
        support::click_button(&mut view, "Cancel compaction").await;
        wait_editable_composer(&mut view).await;
        view.handle_event(Event::Paste("/compact Keep exact paths. INLINE_COMPACT_PROMPT".into()));
        wait_view_state(&mut view, |view, _| view.surface().input_context().is_some_and(|input| input.text.as_deref() == Some("/compact Keep exact paths. INLINE_COMPACT_PROMPT"))).await;
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)));
        wait_focused_input(&mut view, "One-time compaction prompt").await;
        assert_eq!(view.surface().input_context().unwrap().text.as_deref(), Some("Keep exact paths. INLINE_COMPACT_PROMPT"));
        support::click_button(&mut view, "Cancel compaction").await;
        assert_eq!(fixture.request_count.load(Ordering::SeqCst), 2);
        drop(view);
        bindings.close().await.unwrap();
        client.close().await.unwrap();
        fixture.finish().await;
    })
    .await
    .expect("manual compaction UI did not preserve the one-time prompt and durable divider");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn automatic_compaction_displays_only_the_completed_divider() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let mut fixture = Fixture::files("write").await;
        let client = fixture.client().await;
        let mutation = client.mutation(Uuid::new_v4(), "settings", "updateModelSettings", json!({
            "selection": fixture.selection,
            "tools": {"codeMode": false, "codeModeLanguage": null, "applyPatch": false},
            "limits": {"contextWindow": 200000, "inputLimit": null, "maxOutputTokens": null, "compactionThreshold": 1}
        }), Default::default(), None, Value::Null).await.unwrap();
        mutation.prepare().await.unwrap();
        let receipt = mutation.confirm().await.unwrap().receipt;
        assert!(matches!(receipt, Receipt::Recorded { outcome: OperationOutcome::Returned { ref value }, .. } if value["kind"] == "committed"), "{receipt:?}");
        let current = client.query("settings", "resolveModel", json!({
            "connectionId": fixture.selection["connectionId"], "modelId": fixture.selection["modelId"]
        })).await.unwrap();
        fixture.selection = current["choice"]["selection"].clone();
        fixture.seed_history(1).await;
        let (mut view, bindings) = fixture.view(fixture.client().await, Some(fixture.session.clone()));
        wait_editable_composer(&mut view).await;
        let started = support::mutate(&client, "send", json!({
            "sessionId": fixture.session, "model": fixture.selection, "message": "AUTO_COMPACTION_UI_ACTIVE: write a note, then continue."
        })).await;
        assert_eq!(started["kind"], "started", "{started}");
        let first = fixture.next_request().await;
        let second = fixture.next_request().await;
        let (mut main, mut summary) = if first.body.to_string().contains("AUTO_COMPACTION_UI_ACTIVE") { (first, second) } else { (second, first) };
        let observed = client.query("agent", "observe", json!({"sessionId": fixture.session})).await.unwrap();
        assert!(!observed["compacting"].as_bool().unwrap_or(false));
        main.delta("Automatic compaction runs alongside this response.").await;
        let running = wait_view(&mut view, |screen| screen.contains("Automatic compaction runs alongside this response.")).await;
        assert!(!running.contains("Compacting context…"));
        assert!(!running.contains("Context compacted ("));
        summary.delta("Preserved history for the next provider request.").await;
        summary.finish().await;
        main.tool("WorkspaceDocument", json!({"path": "auto-note.txt", "content": "written"})).await;
        let mut continuation = fixture.next_request().await;
        continuation.delta("AUTO_COMPACTION_UI_FINISHED").await;
        continuation.finish().await;
        fixture.idle(&client, &fixture.session).await;
        let completed = wait_view(&mut view, |screen| screen.contains("Context compacted (") && screen.contains("AUTO_COMPACTION_UI_FINISHED")).await;
        assert!(!completed.contains("Compacting context…"));
        evidence("compaction-automatic-completed-divider", &completed);
        drop(view);
        bindings.close().await.unwrap();
        client.close().await.unwrap();
        fixture.finish().await;
    }).await.expect("automatic compaction did not display its completed divider");
}
