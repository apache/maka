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

#[test]
fn real_host_builtin_settings_save_and_read_back_domain_values() {
    let fixture = Fixture::new();
    let mut tui = fixture.tui();
    category(&mut tui, "Subagents", "Add a subagent");
    tui.click_page_text("Add a subagent");
    tui.wait_for("Read the workspace");
    edit(&mut tui, "Name", "Acceptance reader", "Description");
    edit(
        &mut tui,
        "Description",
        "Inspect the isolated workspace",
        "Description",
    );
    edit(&mut tui, "Connection", "tui-fixture", "Description");
    edit(&mut tui, "Model", "fixture-model", "Description");
    tui.click_page_text("Save");
    tui.wait_for("Add a subagent");
    let graph = fixture.read("maka.agent-graph", "settings", json!({"kind":"read"}));
    let preset = graph["presets"]
        .as_array()
        .unwrap()
        .iter()
        .find(|preset| preset["name"] == "Acceptance reader")
        .unwrap();
    assert_eq!(preset["description"], "Inspect the isolated workspace");
    assert_eq!(preset["connectionSlug"], "tui-fixture");
    assert_eq!(preset["model"], "fixture-model");
    assert_eq!(preset["profile"], "local_read");
    assert_eq!(preset["enabled"], true);

    let before = fixture.read("maka.web", "request", json!({"kind":"read"}));
    category(&mut tui, "Web search", "Paste your Tavily key");
    tui.click_page_text("Enabled");
    edit(&mut tui, "Tavily key", "synthetic-tavily-key", "Tavily key");
    tui.click_page_text("Save");
    tui.wait_for("Saved · type to replace");
    let web = fixture.read("maka.web", "request", json!({"kind":"read"}));
    assert_eq!(
        web["snapshot"]["settings"]["enabled"],
        !before["snapshot"]["settings"]["enabled"].as_bool().unwrap()
    );
    assert_eq!(web["snapshot"]["credential"]["configured"], true);
    assert!(
        !tui.screen
            .snapshot()
            .unwrap()
            .screen
            .contains("synthetic-tavily-key")
    );
    tui.click_page_text("Remove key");
    tui.wait_for("Remove the Tavily key?");
    tui.click_last_text("Remove key");
    tui.wait_for("Paste your Tavily key");
    assert_eq!(
        fixture.read("maka.web", "request", json!({"kind":"read"}))["snapshot"]["credential"]["configured"],
        false
    );

    category(&mut tui, "Usage & pricing", "Pricing");
    tui.click_page_text("Pricing");
    // Both tabs exist in Usage; scrolling requires the returned pricing list.
    tui.wait_for("per million tokens in / out");
    reveal(&mut tui, "Price another model");
    tui.click_page_text("Price another model");
    tui.wait_for("US dollars per million tokens.");
    for (label, value) in [
        ("Model", "aaa-acceptance"),
        ("Input", "1.25"),
        ("Output", "4.5"),
        ("Cache read", "0.25"),
    ] {
        edit(&mut tui, label, value, "Cache write");
    }
    tui.click_page_text("Save");
    tui.wait_until(|screen| {
        !screen.contains("US dollars per million tokens.")
            && screen.contains("per million tokens in / out")
    });
    reveal(&mut tui, "Price another model");
    let page = fixture.read(
        "maka.insights",
        "request",
        json!({"kind":"prices","query":{"kind":"start"}}),
    );
    let entry = page["page"]["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["pricing"]["modelKey"] == "aaa-acceptance")
        .unwrap();
    assert_eq!(entry["source"], "custom");
    assert_eq!(entry["pricing"]["inputUsdPer1M"], 1.25);
    assert_eq!(entry["pricing"]["outputUsdPer1M"], 4.5);
    assert_eq!(entry["pricing"]["cacheReadUsdPer1M"], 0.25);
    fixture.finish(tui);
}

#[test]
fn real_host_jev_settings_test_the_saved_local_endpoint() {
    let fixture = Fixture::new();
    let (url, response) =
        fixture.runtime.block_on(async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!(
                "http://{}/v1/chat/completions",
                listener.local_addr().unwrap()
            );
            let response =
                tokio::spawn(async move {
                    let (stream, body, headers) = model_http_request(&listener).await;
                    assert_eq!(body["model"], "acceptance-jev");
                    assert_eq!(body["state"], json!({"test":true}));
                    assert!(
                        headers
                            .to_ascii_lowercase()
                            .contains("authorization: bearer synthetic-jev-key")
                    );
                    support::json_response(stream, "200 OK", json!({
                "model":"acceptance-jev", "answers":{"ready":{"type":"noul","noul":1.0}},
                "usage":{"input_tokens":7,"output_tokens":2}
            })).await;
                });
            (url, response)
        });
    let before = fixture.read("maka.jev", "manage", json!({"kind":"read"}));
    let mut tui = fixture.tui();
    category(&mut tui, "Jev", "Timeout (ms)");
    if !before["snapshot"]["settings"]["enabled"].as_bool().unwrap() {
        tui.click_page_text("Enabled");
    }
    edit(&mut tui, "Endpoint", &url, "Timeout (ms)");
    edit(&mut tui, "Model", "acceptance-jev", "Timeout (ms)");
    edit(&mut tui, "Timeout (ms)", "5000", "Timeout (ms)");
    edit(&mut tui, "API key", "synthetic-jev-key", "Timeout (ms)");
    tui.click_page_text("Save");
    tui.wait_for("Saved · type to replace");
    let snapshot = fixture.read("maka.jev", "manage", json!({"kind":"read"}));
    assert_eq!(
        snapshot["snapshot"]["settings"],
        json!({"enabled":true,"url":url,"model":"acceptance-jev","timeoutMs":5000})
    );
    assert_eq!(snapshot["snapshot"]["configured"], true);
    tui.click_page_text("Test");
    // A local Remote call derives authority from its current caller directly.
    tui.wait_for("Test answered:");
    fixture.runtime.block_on(response).unwrap();
    assert!(tui.screen.snapshot().unwrap().screen.contains("ready"));
    fixture.finish(tui);
}
