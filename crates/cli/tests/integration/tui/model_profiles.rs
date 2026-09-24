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

use super::enabled_models::catalog;
use super::*;
use maka_protocol::Operation;
use serde_json::{Value, json};

fn open(tui: &mut Pty) {
    tui.filter_command("Model settings");
    tui.click_text("Model settings");
    tui.wait_for("Choose a model");
    tui.send(b"fixture-model");
    tui.wait_for("⌕ fixture-model");
    tui.click_last_text("fixture-model");
    tui.wait_for("Context window");
}
fn set(tui: &mut Pty, label: &str, value: &str) {
    tui.click_text(label);
    tui.send(b"\x01");
    tui.send(value.as_bytes());
    tui.wait_for(value);
}
fn focus(tui: &mut Pty, label: &str) {
    for _ in 0..32 {
        if tui.screen.snapshot().unwrap().screen.contains(label) {
            tui.click_text(label);
            return;
        }
        tui.output.clear();
        tui.send(b"\t");
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            tui.read();
            if !tui.output.is_empty() && tui.frames.ready() {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "model field navigation did not render"
            );
        }
    }
    panic!("model field {label:?} is unreachable");
}
fn overrides(items: &[Value]) -> serde_json::Map<String, Value> {
    items
        .iter()
        .filter(|item| item["kind"] == "catalog_entry" && item.get("modelOverride").is_some())
        .map(|item| {
            (
                item["entry"]["id"].as_str().unwrap().into(),
                item["modelOverride"].clone(),
            )
        })
        .collect()
}

#[test]
fn model_profiles_preserve_full_table_validate_inherited_limits_and_reject_concurrent_writes() {
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
    let (client,original,key,neighbor_profiles)=runtime.block_on(async {
        let client=support::model_client(&host.root,"http://127.0.0.1:9/v1").await;
        let (_,items)=catalog(&client).await;
        let mut profiles:serde_json::Map<String,Value>=(0..130).map(|i|(format!("other-{i:03}"),json!({"contextWindow":32000,"codeMode":false,"capabilities":{"reasoning":true}}))).collect();
        let neighbors=profiles.clone();
        profiles.insert("fixture-model".into(),json!({"contextWindow":128000,"inputLimit":64000,"maxOutputTokens":512,"codeMode":false,"vision":false,"thinkingLevels":["high"],"capabilities":{"parallelToolCalls":false},"modalities":{"input":["text","image"],"output":["text"]}}));
        let result=client.request(Operation::ConnectionCatalogUpdate,json!({"expected":{"connectionId":items[0]["connectionId"],"revision":items[0]["revision"]},"changes":{"name":"Profile fixture","configuration":{"baseUrl":"http://127.0.0.1:9/v1"},"enabled":true,"enabledModelIds":["fixture-model"],"modelOverrides":profiles,"requestBodyOverlay":{"temperature":0.3}}})).await.unwrap();
        client.create_session(maka_protocol::session::decode_session_create_input(&json!({"sessionId":"history","name":"History","workspace":{"kind":"host_path","path":directory.path()},"modelTarget":{"kind":"default"}})).unwrap()).await.unwrap();
        let key=client.request(Operation::CredentialVaultQuery,json!({"locator":{"scope":"connection","connectionId":items[0]["connectionId"],"kind":"provider"}})).await.unwrap();
        (client,result["connection"].clone(),key,neighbors)
    });
    let mut tui = Pty::spawn(&["--root", host.root.to_str().unwrap()]);
    tui.wait_for("Workspace");
    tui.click_text("⛭  Settings");
    tui.wait_for("Models"); // Connections live in the Models category.
    tui.click_text("Models");
    tui.wait_for("Model connections");
    tui.click_text("Model connections");
    tui.wait_for("Profile fixture");
    tui.click_text("Profile fixture");
    open(&mut tui);
    set(&mut tui, "Context window", "1.001K");
    tui.wait_for("Input limit cannot exceed");
    set(&mut tui, "Context window", "256K");
    set(&mut tui, "Input limit", "192K");
    set(&mut tui, "Display name", "Precise model");
    tui.click_text("Vision");
    tui.send(b" "); // Explicit false -> inherit; no implicit true.
    tui.click_text("Thinking · Off");
    tui.send(b" ");
    tui.click_last_text("Save");
    tui.wait_until(|s| !s.contains("Cancel") && s.contains("Profile fixture"));
    runtime.block_on(async {
        let (default,items)=catalog(&client).await;
        let mut profiles=overrides(&items);let current=profiles.remove("fixture-model").unwrap();
        assert_eq!(profiles,neighbor_profiles,"all 130 other profiles survive pagination and save");
        assert_eq!(current["contextWindow"],256000);assert_eq!(current["inputLimit"],192000);
        assert_eq!(current["displayName"],"Precise model");assert_eq!(current["thinkingLevels"],json!(["off","high"]));
        assert!(current.get("vision").is_none());assert_eq!(current["codeMode"],false);assert_eq!(current["maxOutputTokens"],512);
        assert_eq!(current["capabilities"],json!({"parallelToolCalls":false}));assert_eq!(current["modalities"],json!({"input":["text","image"],"output":["text"]}));
        assert_eq!(items[0]["requestBodyOverlay"]["temperature"],0.3);assert_eq!(default["modelId"],"fixture-model");
        assert_eq!(items[0]["revision"],original["revision"].as_u64().unwrap()+1);
        assert_eq!(client.request(Operation::CredentialVaultQuery,json!({"locator":{"scope":"connection","connectionId":original["connectionId"],"kind":"provider"}})).await.unwrap(),key);
        assert_eq!(client.session("history").await.unwrap().unwrap().revision,1);
        items[0].clone()
    });
    open(&mut tui);
    focus(&mut tui, "Advanced");
    tui.send(b"\r"); // Expand Advanced, retaining the existing draft.
    tui.wait_until(|screen| {
        screen
            .lines()
            .any(|line| line.contains("Advanced") && line.contains('⌄'))
    });
    focus(&mut tui, "Parallel tools");
    tui.send(b"  "); // Parallel tool calls: explicit false -> inherit -> true.
    tui.wait_until(|screen| {
        screen
            .lines()
            .any(|line| line.contains("Parallel tools") && line.contains("Enabled"))
    });
    focus(&mut tui, "Output · Audio");
    tui.send(b" "); // Add output audio, preserving both original modality lists.
    tui.wait_until(|screen| {
        screen
            .lines()
            .any(|line| line.contains("Output · Audio") && line.contains("[✓]"))
    });
    focus(&mut tui, "Service tier");
    tui.send(b" "); // Explicit fast service tier.
    tui.wait_for("fast");
    tui.click_last_text("Save");
    tui.wait_until(|s| !s.contains("Cancel") && s.contains("Profile fixture"));
    let saved = runtime.block_on(async {
        let (_, items) = catalog(&client).await;
        let mut profiles = overrides(&items);
        let current = profiles.remove("fixture-model").unwrap();
        assert_eq!(profiles, neighbor_profiles);
        assert_eq!(current["capabilities"], json!({"parallelToolCalls":true}));
        assert_eq!(
            current["modalities"],
            json!({"input":["text","image"],"output":["text","audio"]})
        );
        assert_eq!(current["serviceTier"], "fast");
        assert_eq!(current["contextWindow"], 256000);
        assert_eq!(
            client.session("history").await.unwrap().unwrap().revision,
            1
        );
        items[0].clone()
    });
    open(&mut tui);
    set(&mut tui, "Context window", "512K");
    runtime.block_on(async {client.request(Operation::ConnectionCatalogUpdate,json!({"expected":{"connectionId":saved["connectionId"],"revision":saved["revision"]},"changes":{"name":"External profile edit","configuration":{"baseUrl":"http://127.0.0.1:9/v1"},"enabled":true,"enabledModelIds":["fixture-model"]}})).await.unwrap();});
    tui.click_last_text("Save");
    tui.wait_for("This connection changed");
    tui.click_text("⛭  Settings");
    tui.wait_until(|s| !s.contains("Cancel") && s.contains("External profile edit"));
    runtime.block_on(async {
        let (_, items) = catalog(&client).await;
        assert_eq!(overrides(&items)["fixture-model"]["contextWindow"], 256000);
        assert_eq!(
            client.session("history").await.unwrap().unwrap().revision,
            1
        );
    });
    tui.close_terminal();
    tui.finish();
    client.disconnect();
    host.retire_registered();
    assert!(host.wait_for_exit().success());
}
