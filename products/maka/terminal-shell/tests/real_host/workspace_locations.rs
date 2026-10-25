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
use maka_app_client::Client;
use maka_capabilities::call::Attachments;

async fn fill(view: &mut AppView, label: &str, value: &str) {
    tab_to_label(view, label).await;
    shortcut(view, 'a');
    view.handle_event(Event::Paste(value.into()));
    let (done, committed) = tokio::sync::oneshot::channel();
    view.control()
        .unwrap()
        .advance_clock(Duration::ZERO, move || {
            let _ = done.send(());
        });
    committed.await.unwrap();
}

async fn update(client: &Client, source: &Value, roots: Value) -> Value {
    let operation = client
        .settings_mutation(
            Uuid::new_v4(),
            "settings",
            "updateWorkspaceLocations",
            json!({"source":source,"roots":roots}),
            Attachments::new(),
        )
        .await
        .unwrap();
    operation.prepare().await.unwrap();
    let reply = operation.confirm().await.unwrap();
    let Receipt::Recorded {
        outcome: OperationOutcome::Returned { value },
        ..
    } = reply.receipt
    else {
        panic!("workspace locations result is not recorded: {reply:?}");
    };
    value
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn workspace_locations_save_browse_remove_and_preserve_conflicting_drafts() {
    tokio::time::timeout(Duration::from_secs(120), async {
        let fixture = Fixture::open().await;
        let project = fixture.directory.path().join("projects ");
        let draft = fixture.directory.path().join("draft-project");
        std::fs::create_dir(&project).unwrap();
        std::fs::create_dir(&draft).unwrap();
        let client = fixture.client().await;
        let initial = client
            .query("settings", "workspaceLocations", json!({}))
            .await
            .unwrap();
        let (mut view, bindings) =
            fixture.view(fixture.client().await, Some(fixture.session.clone()));
        view.resize(120, 45);
        wait_focused_input(&mut view, "Message composer").await;
        open_workspace_picker(&mut view).await;
        support::click_button(&mut view, "Manage workspace locations").await;
        wait_view(&mut view, |screen| screen.contains("Remove")).await;
        fill(&mut view, "Workspace location name", "Projects").await;
        fill(
            &mut view,
            "Workspace location path",
            project.to_str().unwrap(),
        )
        .await;
        support::click_button(&mut view, "Add workspace location").await;
        wait_enabled_node(&mut view, "Remove location Projects").await;
        support::evidence_cells("workspace-locations-add", &view);
        support::click_button(&mut view, "Save workspace locations").await;
        wait_enabled_node(&mut view, "Browse folder Projects").await;
        client.refresh().await.unwrap();
        let saved = client
            .query("settings", "workspaceLocations", json!({}))
            .await
            .unwrap();
        assert_eq!(saved["roots"].as_array().unwrap().len(), 2);
        assert_eq!(
            saved["roots"][1]["path"],
            json!(
                maka_fs_tools::workspace::project::host_path(&project.canonicalize().unwrap())
                    .unwrap()
            )
        );
        assert_eq!(
            update(&client, &initial["source"], json!([])).await["status"],
            "conflict"
        );
        assert_eq!(
            update(
                &client,
                &saved["source"],
                json!([{"label":"Missing","path":fixture.directory.path().join("missing")}])
            )
            .await["status"],
            "rejected"
        );
        assert_eq!(
            client
                .query("settings", "workspaceLocations", json!({}))
                .await
                .unwrap(),
            saved
        );

        support::click_button(&mut view, "Manage workspace locations").await;
        wait_enabled_node(&mut view, "Remove location Workspace").await;
        support::click_button(&mut view, "Remove location Workspace").await;
        support::click_button(&mut view, "Save workspace locations").await;
        wait_enabled_node(&mut view, "Browse folder Projects").await;
        client.refresh().await.unwrap();
        let saved = client
            .query("settings", "workspaceLocations", json!({}))
            .await
            .unwrap();
        assert_eq!(saved["roots"].as_array().unwrap().len(), 1);
        assert!(fixture.directory.path().join("workspace").is_dir());
        support::click_button(&mut view, "Manage workspace locations").await;
        wait_enabled_node(&mut view, "Remove location Projects").await;
        fill(&mut view, "Workspace location name", "Unsaved project").await;
        fill(
            &mut view,
            "Workspace location path",
            draft.to_str().unwrap(),
        )
        .await;
        support::click_button(&mut view, "Add workspace location").await;
        wait_enabled_node(&mut view, "Remove location Unsaved project").await;
        let elsewhere = update(
            &client,
            &saved["source"],
            json!([{"label":"Elsewhere","path":project}]),
        )
        .await;
        assert_eq!(elsewhere["status"], "committed");
        support::click_button(&mut view, "Save workspace locations").await;
        wait_view(&mut view, |screen| screen.contains("changed elsewhere")).await;
        assert!(
            view.accessibility_snapshot()
                .iter()
                .any(|node| node.label == "Remove location Unsaved project")
        );
        support::evidence_cells("workspace-locations-conflict-preserves-draft", &view);
        support::click_button(&mut view, "Reload").await;
        wait_enabled_node(&mut view, "Remove location Elsewhere").await;
        assert!(
            !view
                .accessibility_snapshot()
                .iter()
                .any(|node| node.label == "Remove location Unsaved project")
        );
        support::click_button(&mut view, "Back").await;
        wait_enabled_node(&mut view, "Browse folder Elsewhere").await;
        drop(view);
        bindings.close().await.unwrap();
        client.close().await.unwrap();
        fixture.finish().await;
    })
    .await
    .expect("workspace locations UI timed out");
}
