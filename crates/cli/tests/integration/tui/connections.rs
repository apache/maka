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
use maka_protocol::{Operation, configuration::ConnectionCatalogQueryInput as Query};
use serde_json::json;

#[test]
fn connections_directory_pages_reopens_and_manages_fixed_targets_with_cas() {
    let directory = tempfile::tempdir().unwrap();
    let mut host = super::super::candidate::CandidateFixture::new(directory.path().join("root"));
    host.child = Some(
        Command::new(env!("CARGO_BIN_EXE_maka"))
            .args(["host", "serve", "--root"])
            .arg(&host.root)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap(),
    );
    host.wait_for_registration();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let (client, targets, revision) = runtime.block_on(async {
        let client = support::client(&host.root).await;
        let mut revision = client.connection_catalog(Query::Start).await.unwrap()["revision"].as_u64().unwrap();
        let mut targets = Vec::new();
        for index in 0..18 {
            // The first connection alone exceeds one wire page; the overview must skip its inventory.
            let models:Vec<_> = if index == 0 { (0..128).map(|i| format!("model-{i}")).collect() } else { vec![] };
            let result = client.request(Operation::ConnectionCatalogCreate, json!({
                "expectedCatalogRevision":revision,
                "connection":{"name":format!("Directory {index:02}"),"slug":format!("directory-{index}"),
                    "provider":support::provider(&client,"openai-compatible").await,"configuration":{"baseUrl":"http://127.0.0.1:9/v1"},
                    "enabled":index != 1,"enabledModelIds":models}
            })).await.unwrap();
            revision = result["catalogRevision"].as_u64().unwrap();
            targets.push(result["connection"].clone());
        }
        (client, targets, revision)
    });
    let mut tui = Pty::spawn(&["--root", host.root.to_str().unwrap()]);
    tui.wait_for("Workspace");
    tui.click_text("⛭  Settings");
    tui.wait_for("Models"); // Connections live in the Models category.
    tui.click_text("Models");
    tui.wait_for("Model connections");
    tui.click_text("Model connections");
    tui.wait_for("Directory 00");
    tui.wait_for("128 enabled models");
    tui.wait_for("Disabled");
    tui.click_text("›"); // First occurrence is the header's next-page control.
    tui.wait_for("Directory 17");
    tui.click_text("Directory 17");
    tui.wait_for("› Directory 17");
    runtime.block_on(async {
        assert_eq!(client.connection_catalog(Query::Start).await.unwrap()["revision"], revision,
            "navigation and overview reads must not write configuration");
        client.request(Operation::ConnectionCatalogUpdate, json!({
            "expected":targets[17],"changes":{"name":"Updated elsewhere","configuration":{"baseUrl":"http://127.0.0.1:9/v1"},
            "enabled":false,"enabledModelIds":[]}
        })).await.unwrap();
    });
    tui.wait_for("Directory 00"); // Notification restarts revision-scoped indices.
    tui.click_text("›");
    tui.wait_for("Updated elsewhere");
    assert!(
        !tui.screen
            .snapshot()
            .unwrap()
            .screen
            .contains("› Updated elsewhere"),
        "a disappeared selection cannot rebind by row position"
    );
    tui.click_text("Updated elsewhere");
    tui.wait_for("› Updated elsewhere");
    // Follow the visible keyboard hint through the shared header controls.
    // Sidebar and Back are now real focus stops; ordinals are not identities.
    for _ in 0..16 {
        let screen = tui.screen.snapshot().unwrap().screen;
        let hint = screen.lines().last().unwrap_or("").trim().to_owned();
        if hint == "Previous page" {
            break;
        }
        tui.send(b"\t");
        tui.wait_until(|screen| screen.lines().last().unwrap_or("").trim() != hint);
    }
    assert_eq!(
        tui.screen
            .snapshot()
            .unwrap()
            .screen
            .lines()
            .last()
            .unwrap_or("")
            .trim(),
        "Previous page",
        "previous page is reachable by keyboard"
    );
    tui.send(b"\r");
    tui.wait_for("Directory 00");
    tui.send(b"\x1b"); // Back to Settings, not a fabricated connection/session route.
    tui.wait_until(|s| s.lines().next().is_some_and(|l| l.contains("Settings")));
    tui.send(b"\x1b[1;3C"); // Alt+Right restores nested route.
    tui.wait_for("Directory 00");
    tui.close_terminal();
    tui.finish();
    let mut reopened = Pty::spawn(&["--root", host.root.to_str().unwrap()]);
    reopened.wait_for("Directory 00");
    assert!(
        reopened
            .screen
            .snapshot()
            .unwrap()
            .screen
            .lines()
            .next()
            .unwrap()
            .contains("Model connections")
    );
    runtime.block_on(async {
        let catalog = client.connection_catalog(Query::Start).await.unwrap();
        assert_eq!(catalog["revision"], revision + 1);
        assert_eq!(catalog["connectionCount"], 18);
        assert!(catalog["defaultTarget"].is_null());
    });
    let (expected, locator, default, credential) = runtime.block_on(async {
        let mut changes = changes("Managed connection", true);
        changes["modelOverrides"] = json!({"model-0":{"contextWindow":64000}});
        changes["requestBodyOverlay"] = json!({"temperature":0.3});
        let updated = client.request(Operation::ConnectionCatalogUpdate,
            json!({"expected":targets[0],"changes":changes})).await.unwrap();
        support::authenticate(&client, &updated["connection"]["connectionId"], "directory-test-secret").await;
        let current = client.connection_catalog(Query::Start).await.unwrap();
        let row = &current["items"][0];
        let expected = json!({"connectionId":row["connectionId"],"revision":row["revision"]});
        let locator = json!({"scope":"connection","connectionId":expected["connectionId"],"kind":"provider"});
        let default = json!({"connectionId":expected["connectionId"],"modelId":"model-0"});
        client.request(Operation::ConnectionCatalogSetDefaultTarget,json!({
            "expectedCatalogRevision":current["revision"],"target":default
        })).await.unwrap();
        client.create_session(maka_protocol::session::decode_session_create_input(&json!({
            "sessionId":"retained-history","name":"History stays","workspace":{"kind":"host_path","path":directory.path()},
            "modelTarget":{"kind":"default"}
        })).unwrap()).await.unwrap();
        let credential = client.request(Operation::CredentialVaultQuery,json!({"locator":locator})).await.unwrap();
        (expected,locator,default,credential)
    });
    reopened.wait_for("Managed connection");
    reopened.click_text("Managed connection");
    reopened.send(b"\r");
    reopened.wait_for("Rename connection");
    reopened.wait_for("Save");
    reopened.send(b"stale name");
    runtime.block_on(async {
        client
            .request(
                Operation::ConnectionCatalogUpdate,
                json!({
                    "expected":expected,"changes":changes("Changed elsewhere",true)
                }),
            )
            .await
            .unwrap();
    });
    reopened.send(b"\r");
    reopened.wait_for("This connection changed elsewhere.");
    reopened.send(b"\x1b");
    reopened.wait_until(|s| !s.contains("Cancel") && s.contains("Changed elsewhere"));
    reopened.click_text("Changed elsewhere");
    reopened.send(b"\r");
    reopened.wait_for("Save");
    reopened.send("连接已改名\r".as_bytes());
    reopened.wait_until(|s| !s.contains("Cancel") && s.contains("连接已改名"));
    runtime.block_on(async {
        let catalog = client.connection_catalog(Query::Start).await.unwrap();
        let row = &catalog["items"][0];
        assert_eq!(row["connectionId"], expected["connectionId"]);
        assert_eq!(row["name"], "连接已改名");
        assert_eq!(
            row["enabledModelIdCount"], 128,
            "renaming preserves every enabled model across wire pages"
        );
        assert_eq!(row["requestBodyOverlay"], json!({"temperature":0.3}));
        assert_eq!(row["configuration"]["baseUrl"], "http://127.0.0.1:9/v1");
        assert_eq!(catalog["defaultTarget"], default);
        let model = client
            .connection_catalog(Query::Continue {
                revision: catalog["revision"].as_u64().unwrap(),
                cursor: maka_protocol::configuration::ConnectionCatalogCursor::CatalogEntry {
                    connection_index: 0,
                    item_index: 0,
                },
            })
            .await
            .unwrap();
        assert!(
            model["items"]
                .as_array()
                .unwrap()
                .iter()
                .any(|item| item["modelOverride"]["contextWindow"] == 64000)
        );
        assert_eq!(
            client
                .request(Operation::CredentialVaultQuery, json!({"locator":locator}))
                .await
                .unwrap(),
            credential
        );
    });
    let before_endpoint = runtime
        .block_on(client.connection_catalog(Query::Start))
        .unwrap()["revision"]
        .clone();
    reopened.filter_command("Edit provider configuration");
    reopened.click_text("Edit provider configuration");
    reopened.wait_for("Review");
    reopened.send(b"not a URL\r");
    reopened.wait_for("Enter a valid provider configuration");
    reopened.send(b"\x01{\"baseUrl\":\"http://127.0.0.1:9/v2\"}\r");
    reopened.wait_for("Use this provider configuration?");
    reopened.wait_for("Apply configuration");
    reopened.send(b"\r"); // Review defaults to Cancel; no mutation yet.
    reopened.wait_until(|s| !s.contains("Cancel") && s.contains("连接已改名"));
    assert_eq!(
        runtime
            .block_on(client.connection_catalog(Query::Start))
            .unwrap()["revision"],
        before_endpoint
    );
    reopened.filter_command("Edit provider configuration");
    reopened.click_text("Edit provider configuration");
    reopened.wait_for("Review");
    reopened.send(b"{\"baseUrl\":\"http://127.0.0.1:9/v2\"}\r");
    reopened.wait_for("Use this provider configuration?");
    reopened.wait_for("Apply configuration");
    reopened.click_last_text("Apply configuration");
    reopened.wait_until(|s| !s.contains("Cancel") && s.contains("连接已改名"));
    runtime.block_on(async {
        let catalog = client.connection_catalog(Query::Start).await.unwrap();
        assert_eq!(
            catalog["items"][0]["configuration"]["baseUrl"],
            "http://127.0.0.1:9/v2"
        );
        assert_eq!(catalog["items"][0]["enabledModelIdCount"], 128);
        assert_eq!(
            catalog["items"][0]["requestBodyOverlay"],
            json!({"temperature":0.3})
        );
        assert_eq!(catalog["defaultTarget"], default);
        let models = client
            .connection_catalog(Query::Continue {
                revision: catalog["revision"].as_u64().unwrap(),
                cursor: maka_protocol::configuration::ConnectionCatalogCursor::CatalogEntry {
                    connection_index: 0,
                    item_index: 0,
                },
            })
            .await
            .unwrap();
        assert!(
            models["items"]
                .as_array()
                .unwrap()
                .iter()
                .all(|item| item.get("modelOverride").is_none()),
            "Host clears endpoint-specific overrides"
        );
        assert_eq!(
            client
                .request(Operation::CredentialVaultQuery, json!({"locator":locator}))
                .await
                .unwrap(),
            credential
        );
        assert_eq!(
            client
                .session("retained-history")
                .await
                .unwrap()
                .unwrap()
                .revision,
            1
        );
    });
    for (command, enabled) in [("Disable connection", false), ("Enable connection", true)] {
        reopened.filter_command(command);
        reopened.click_text(command);
        reopened.wait_for("Cancel");
        reopened.send(b"\t\r");
        reopened.wait_until(|s| !s.contains("Cancel") && s.contains("连接已改名"));
        runtime.block_on(async {
            let catalog = client.connection_catalog(Query::Start).await.unwrap();
            assert_eq!(catalog["items"][0]["enabled"], enabled);
            assert_eq!(catalog["items"][0]["enabledModelIdCount"], 128);
            assert!(
                catalog["defaultTarget"].is_null(),
                "re-enabling does not silently restore a default"
            );
            assert_eq!(
                client
                    .request(Operation::CredentialVaultQuery, json!({"locator":locator}))
                    .await
                    .unwrap(),
                credential
            );
        });
    }
    runtime.block_on(async {
        let catalog = client.connection_catalog(Query::Start).await.unwrap();
        client
            .request(
                Operation::ConnectionCatalogSetDefaultTarget,
                json!({
                    "expectedCatalogRevision":catalog["revision"],"target":default
                }),
            )
            .await
            .unwrap();
    });
    reopened.wait_for("Default: model-0");
    reopened.filter_command("Remove connection");
    reopened.click_text("Remove connection");
    reopened.wait_for("Permanently removes");
    reopened.wait_for("Cancel");
    reopened.send(b"\r"); // Destructive confirmation defaults to Cancel.
    reopened.wait_until(|s| !s.contains("Cancel") && s.contains("连接已改名"));
    assert_eq!(
        runtime
            .block_on(client.connection_catalog(Query::Start))
            .unwrap()["connectionCount"],
        18
    );
    reopened.filter_command("Remove connection");
    reopened.click_text("Remove connection");
    reopened.wait_for("Cancel");
    reopened.send(b"\t\r");
    reopened.wait_until(|s| {
        !s.contains("Cancel") && s.contains("Directory 01") && !s.contains("连接已改名")
    });
    runtime.block_on(async {
        let catalog = client.connection_catalog(Query::Start).await.unwrap();
        assert_eq!(catalog["connectionCount"], 17);
        assert!(catalog["defaultTarget"].is_null());
        assert_eq!(
            catalog["items"][0]["connectionId"],
            targets[1]["connectionId"]
        );
        assert_eq!(catalog["items"][0]["revision"], 1, "neighbour is untouched");
        assert_eq!(
            client
                .request(Operation::CredentialVaultQuery, json!({"locator":locator}))
                .await
                .unwrap()["kind"],
            "connection_not_found"
        );
        let retained = client.session("retained-history").await.unwrap().unwrap();
        assert_eq!(retained.revision, 1);
        assert_eq!(
            retained.llm_connection_id.as_deref(),
            expected["connectionId"].as_str()
        );
    });
    assert!(!String::from_utf8_lossy(&reopened.output).contains("directory-test-secret"));
    reopened.close_terminal();
    reopened.finish();
    client.disconnect();
    host.retire_registered();
    assert!(host.wait_for_exit().success());
}

fn changes(name: &str, enabled: bool) -> serde_json::Value {
    json!({"name":name,"configuration":{"baseUrl":"http://127.0.0.1:9/v1"},"enabled":enabled,
        "enabledModelIds":(0..128).map(|i|format!("model-{i}")).collect::<Vec<_>>()})
}
