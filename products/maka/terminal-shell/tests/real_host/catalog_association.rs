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

async fn detail(client: &maka_app_client::Client) -> Value {
    let catalog = client
        .query("settings", "connections", json!({"kind":"start"}))
        .await
        .unwrap();
    let basis = &catalog["connections"][0]["basis"];
    client.query("settings", "connection", json!({
        "connectionId":basis["connectionId"], "revision":basis["revision"], "includeEditingFacts":true
    })).await.unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn associate_change_and_clear_catalog_model_without_changing_request_identity() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let mut fixture = Fixture::open().await;
        let client = fixture.client().await;
        let catalog = client
            .query("settings", "catalogModels", json!({"query":"anthropic"}))
            .await
            .unwrap();
        let entries = catalog["models"].as_array().unwrap();
        let first = entries
            .iter()
            .find(|model| model["contextWindow"].is_number())
            .unwrap()
            .clone();
        let second = entries
            .iter()
            .find(|model| {
                model["reference"] != first["reference"] && model["contextWindow"].is_number()
            })
            .unwrap()
            .clone();
        let (mut view, bindings) = fixture.view(client.clone(), Some(fixture.session.clone()));
        wait_editable_composer(&mut view).await;
        shortcut(&mut view, 'p');
        select_command(&mut view, "Connections & models").await;
        activate(&mut view, "Edit connection NSH fixture").await;
        activate(&mut view, "Manage models").await;
        activate(&mut view, "Edit model fixture-model").await;
        fill(&mut view, "Context window (tokens)", "").await;
        for entry in [&first, &second] {
            activate(&mut view, "Associate catalog model").await;
            wait_focused_input(&mut view, "Search catalog models").await;
            let reference = &entry["reference"];
            let provider = reference["provider"].as_str().unwrap();
            let model = reference["modelId"].as_str().unwrap();
            fill(
                &mut view,
                "Search catalog models",
                &format!("{provider} {model}"),
            )
            .await;
            let label = format!("{provider} / {model}");
            activate(&mut view, &label).await;
            wait_view_state(&mut view, |view, _| {
                !view
                    .accessibility_snapshot()
                    .iter()
                    .any(|node| node.label == "Search catalog models")
            })
            .await;
            activate(&mut view, "Save model").await;
            wait_view(&mut view, |screen| {
                screen.contains("Model saved.") && screen.contains("Connection models")
            })
            .await;
            let saved = detail(&client).await;
            let overrides = &saved["editing"]["modelOverrides"]["fixture-model"];
            assert_eq!(overrides["catalogModel"], *reference);
            assert!(overrides.get("contextWindow").is_none());
            let resolved = client
                .query(
                    "settings",
                    "resolveModel",
                    json!({
                        "connectionId":saved["target"]["connectionId"], "modelId":"fixture-model"
                    }),
                )
                .await
                .unwrap();
            assert_eq!(resolved["choice"]["selection"]["modelId"], "fixture-model");
            assert_eq!(
                resolved["choice"]["limits"]["contextWindow"],
                entry["contextWindow"]
            );
            assert_eq!(resolved["defaults"]["catalogMatched"], true);
            activate(&mut view, "Edit model fixture-model").await;
            wait_view(&mut view, |screen| screen.contains(&label)).await;
        }
        activate(&mut view, "Back from connection settings").await;
        activate(&mut view, "Back from connection settings").await;
        activate(&mut view, "Fetch models").await;
        wait_view(&mut view, |screen| {
            screen.contains("Models fetched and enabled.")
        })
        .await;
        let refreshed = detail(&client).await;
        assert_eq!(
            refreshed["editing"]["modelOverrides"]["fixture-model"]["catalogModel"],
            second["reference"]
        );
        let selection = client.query("settings", "resolveModel", json!({
            "connectionId":refreshed["target"]["connectionId"], "modelId":"fixture-model"
        })).await.unwrap()["choice"]["selection"].clone();
        let sent = support::mutate(&client, "send", json!({
            "sessionId":fixture.session, "message":"Check the catalog association", "model":selection
        })).await;
        assert_eq!(sent["kind"], "started");
        let mut request = fixture.next_request().await;
        assert_eq!(request.body["model"], "fixture-model");
        request.delta("Association checked.").await;
        request.finish().await;
        fixture.idle(&client, &fixture.session).await;
        activate(&mut view, "Manage models").await;
        activate(&mut view, "Edit model fixture-model").await;
        activate(&mut view, "Clear catalog association").await;
        activate(&mut view, "Save model").await;
        wait_view(&mut view, |screen| {
            screen.contains("Model saved.") && screen.contains("Connection models")
        })
        .await;
        let cleared = detail(&client).await;
        assert!(
            cleared["editing"]["modelOverrides"]["fixture-model"]
                .get("catalogModel")
                .is_none()
        );
        let target =
            json!({"connectionId":cleared["target"]["connectionId"], "modelId":"fixture-model"});
        let resolved = client
            .query("settings", "resolveModel", target)
            .await
            .unwrap();
        assert_eq!(resolved["defaults"]["catalogMatched"], false);
        assert_eq!(resolved["choice"]["limits"]["contextWindow"], Value::Null);
        bindings.close().await.unwrap();
        drop(view);
        fixture.finish().await;
    })
    .await
    .unwrap();
}
