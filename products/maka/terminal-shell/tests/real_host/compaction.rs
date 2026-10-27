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
use std::time::{Instant, SystemTime, UNIX_EPOCH};

fn duration_seconds(label: &str) -> Option<f64> {
    let (minutes, seconds) = label.split_once("m ").unwrap_or(("0", label));
    Some(minutes.parse::<f64>().ok()? * 60.0 + seconds.strip_suffix('s')?.parse::<f64>().ok()?)
}

fn compacting_seconds(screen: &str) -> Option<f64> {
    let (_, duration) = screen.split_once("Compacting context… (")?;
    duration_seconds(duration.split_once(')')?.0)
}

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
async fn manual_compaction_timer_keeps_its_start_after_reopen() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let mut fixture = Fixture::open().await;
        fixture.seed_history(1).await;
        let client = fixture.client().await;
        let (mut view, bindings) =
            fixture.view(fixture.client().await, Some(fixture.session.clone()));
        wait_editable_composer(&mut view).await;
        open_compact(&mut view).await;
        support::click_button(&mut view, "Compact now").await;
        let running = wait_view(&mut view, |screen| {
            compacting_seconds(screen).is_some() && !screen.contains("One-time compaction prompt")
        })
        .await;
        let initial_duration = compacting_seconds(&running).unwrap();
        let advancing = wait_view(&mut view, |screen| {
            compacting_seconds(screen).is_some_and(|seconds| seconds >= initial_duration + 1.0)
        })
        .await;
        let before_reopen = compacting_seconds(&advancing).unwrap();
        evidence("compaction-manual-running-divider", &advancing);
        let original = client
            .query("agent", "observe", json!({"sessionId": fixture.session}))
            .await
            .unwrap()["compacting"]
            .clone();
        let (mut reopened, reopened_bindings) =
            fixture.view(fixture.client().await, Some(fixture.session.clone()));
        let reopened_screen =
            wait_view(&mut reopened, |screen| compacting_seconds(screen).is_some()).await;
        assert!(
            compacting_seconds(&reopened_screen).unwrap() >= before_reopen,
            "reopening reset the compaction duration:\n{reopened_screen}"
        );
        assert_eq!(
            client
                .query("agent", "observe", json!({"sessionId": fixture.session}))
                .await
                .unwrap()["compacting"],
            original
        );
        drop(reopened);
        reopened_bindings.close().await.unwrap();
        let mut request = fixture.next_request().await;
        request
            .delta("Compacted context for the next request.")
            .await;
        request.finish().await;
        fixture.idle(&client, &fixture.session).await;
        wait_view(&mut view, |screen| !screen.contains("Compacting context…")).await;
        drop(view);
        bindings.close().await.unwrap();
        client.close().await.unwrap();
        fixture.finish().await;
    })
    .await
    .expect("manual compaction UI did not preserve the elapsed duration");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn automatic_compaction_shows_its_background_duration_only_when_the_turn_must_wait() {
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
        let background = Instant::now();
        let background_wall = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis();
        let observed = client.query("agent", "observe", json!({"sessionId": fixture.session})).await.unwrap();
        assert!(observed["compacting"].is_null(), "{observed}");
        main.delta("Automatic compaction runs alongside this response.").await;
        main.thinking("Still working while the background summary is unfinished.").await;
        let running = wait_view(&mut view, |screen| screen.contains("Automatic compaction runs alongside this response.")).await;
        assert!(!running.contains("Compacting context…"));
        assert!(!running.contains("Context compacted ("));

        let activity_duration = |view: &AppView| {
            view.accessibility_snapshot().iter().filter_map(|node| duration_seconds(&node.label)).fold(0.0, f64::max)
        };
        let initial_activity = activity_duration(&view);
        // The live turn advances while the provider still holds the summary.
        let background_screen = wait_view_state(&mut view, |view, _| activity_duration(view) >= initial_activity + 2.0).await;
        assert!(!background_screen.contains("Compacting context…"));
        main.tool("WorkspaceDocument", json!({"path": "auto-note.txt", "content": "written"})).await;
        fixture.next_request().await.context_overflow().await;
        let before_wait = background.elapsed().as_secs();
        let observed = loop {
            let observed = client.query("agent", "observe", json!({"sessionId": fixture.session})).await.unwrap();
            if observed["compacting"].is_object() { break observed; }
            assert!(!observed["run"].is_null(), "the turn ended instead of waiting for its background summary: {observed}");
            tokio::task::yield_now().await;
        };
        let started_at = observed["compacting"]["startedAt"].as_u64().expect("the waiting summary must expose its original start");
        assert!(u128::from(started_at) <= background_wall, "waiting replaced the original compaction start: {observed}");
        let waiting = wait_view(&mut view, |screen| compacting_seconds(screen).is_some()).await;
        assert!(compacting_seconds(&waiting).unwrap() >= before_wait as f64, "the waiting divider omitted the background duration ({before_wait}s):\n{waiting}");
        evidence("compaction-automatic-waiting-divider", &waiting);
        summary.delta("Preserved history for the next provider request.").await;
        summary.finish().await;
        let mut continuation = fixture.next_request().await;
        continuation.delta("AUTO_COMPACTION_UI_FINISHED").await;
        continuation.finish().await;
        fixture.idle(&client, &fixture.session).await;
        wait_view(&mut view, |screen| !screen.contains("Compacting context…")).await;
        drop(view);
        bindings.close().await.unwrap();
        client.close().await.unwrap();
        fixture.finish().await;
    }).await.expect("automatic compaction did not display its background duration while waiting");
}
