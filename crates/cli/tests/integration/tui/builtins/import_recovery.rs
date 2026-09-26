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
use maka_protocol::{Operation, configuration::ConnectionCatalogQueryInput};

const PACKAGE: &str = "maka.session-import";

fn manage(fixture: &Fixture, input: Value) -> Value {
    fixture.read(PACKAGE, "manage", input)
}

fn source(fixture: &Fixture, count: usize) -> Value {
    let directory = fixture.directory.path().join("recovery-source");
    std::fs::create_dir_all(directory.join("sessions")).unwrap();
    for index in 1..=count {
        let id = format!("recovery-{index:02}");
        let transcript = [
            json!({"type":"session_meta","payload":{"id":id,"cwd":fixture.directory.path(),"source":"cli"}}),
            json!({"type":"event_msg","payload":{"type":"user_message","message":format!("Recovery case {index:02}")}}),
            json!({"type":"event_msg","payload":{"type":"agent_message","message":"Historical answer"}}),
        ].iter().map(Value::to_string).collect::<Vec<_>>().join("\n") + "\n";
        std::fs::write(
            directory.join(format!("sessions/rollout-{id}.jsonl")),
            transcript,
        )
        .unwrap();
    }
    manage(fixture, json!({"kind":"save_sources","expectedRevision":null,"configuration":{"sources":[{
        "id":uuid::Uuid::new_v4(),"name":"Recovery source","location":{"kind":"codex","root":directory}
    }]}}))["snapshot"].clone()
}

fn prepare(fixture: &Fixture, source: &Value, index: usize) -> Value {
    let model = manage(fixture, json!({"kind":"models","query":{"query":""}}))["choices"]["models"]
        [0]
    .clone();
    let id = format!("recovery-{index:02}");
    let operation = uuid::Uuid::from_u128(index as u128).to_string();
    let result = manage(
        fixture,
        json!({"kind":"prepare","request":{
            "operationId":operation,
            "selection":{"sourceId":source["configuration"]["sources"][0]["id"],"sourceRevision":source["revision"],"sessionId":id,"path":format!("sessions/rollout-{id}.jsonl")},
            "workspace":{"kind":"host_path","path":fixture.directory.path()},
            "settings":{"target":{"kind":"model","model":model["model"],"thinkingLevel":model["defaultThinkingLevel"]},
                "sandboxMode":"read-only","approvalPolicy":{"kind":"on-request"},"collaborationMode":"agent","behavior":"default"}
        }}),
    );
    assert_eq!(result["copy"]["operationId"], operation);
    result["copy"].clone()
}

#[test]
fn real_host_import_recovery_pages_resume_exact_identity_and_show_abandonment() {
    let fixture = Fixture::new();
    let source = source(&fixture, 20);
    let copies: Vec<_> = (1..=20)
        .map(|index| prepare(&fixture, &source, index))
        .collect();
    let abandoned = manage(
        &fixture,
        json!({"kind":"abandon","operationId":copies[18]["operationId"]}),
    );
    assert_eq!(abandoned["copy"]["receipt"]["state"], "abandoned");
    let first = manage(&fixture, json!({"kind":"copies","after":null}));
    assert_eq!(first["page"]["copies"].as_array().unwrap().len(), 16);
    assert_eq!(first["page"]["next"], copies[15]["operationId"]);
    let mut tui = fixture.tui();
    category(&mut tui, "Conversation import", "Import history");
    reveal(&mut tui, "Recovery case 09");
    tui.click_page_text("Recovery case 09");
    tui.wait_for("Finish import");
    // Merely inspecting or restoring a pending import must never replay delivery.
    assert!(
        manage(
            &fixture,
            json!({"kind":"copy","operationId":copies[8]["operationId"]})
        )["copy"]["receipt"]
            .is_null()
    );
    tui.send(b"\x1b[1;3D");
    tui.wait_for("Import history");
    reveal(&mut tui, "More imports");
    tui.click_page_text("More imports");
    tui.wait_for("Recovery case 17");
    tui.click_page_text("Recovery case 17");
    tui.wait_for("Finish import");
    tui.close_terminal();
    tui.finish();
    let mut tui = fixture.tui();
    tui.wait_for("Recovery case 17");
    tui.wait_for("Finish import");
    assert!(
        manage(
            &fixture,
            json!({"kind":"copy","operationId":copies[16]["operationId"]})
        )["copy"]["receipt"]
            .is_null()
    );
    tui.click_page_text("Finish import");
    tui.wait_for("Import history");
    let published = manage(
        &fixture,
        json!({"kind":"copy","operationId":copies[16]["operationId"]}),
    );
    assert_eq!(published["copy"]["receipt"]["state"], "published");
    assert_eq!(
        published["copy"]["receipt"]["records"],
        copies[16]["records"]
    );
    let session = published["copy"]["receipt"]["sessionId"].as_str().unwrap();
    assert!(
        fixture
            .runtime
            .block_on(fixture.client.session(session))
            .unwrap()
            .is_some()
    );
    reveal(&mut tui, "More imports");
    tui.click_page_text("More imports");
    tui.wait_for("Recovery case 19");
    tui.click_page_text("Recovery case 19");
    tui.wait_for("This import was abandoned.");
    let screen = tui.screen.snapshot().unwrap().screen;
    assert!(
        !screen.contains("Imported 2 records")
            && !screen.contains("Finish import")
            && !screen.contains("Open session")
    );
    assert!(
        fixture
            .runtime
            .block_on(
                fixture
                    .client
                    .session(abandoned["copy"]["receipt"]["sessionId"].as_str().unwrap())
            )
            .unwrap()
            .is_none()
    );
    for copy in &copies {
        if copy["operationId"] != copies[16]["operationId"]
            && copy["operationId"] != copies[18]["operationId"]
        {
            assert!(
                manage(
                    &fixture,
                    json!({"kind":"copy","operationId":copy["operationId"]})
                )["copy"]["receipt"]
                    .is_null()
            );
        }
    }
    tui.send(b"\x1b[1;3D");
    tui.wait_for("Recovery case 17");
    tui.click_page_text("Recovery case 17");
    tui.wait_for("Imported 2 records.");
    tui.click_page_text("Open session");
    tui.wait_for("Historical answer");
    tui.close_terminal();
    tui.finish();
    let checkpoint = fixture
        .directory
        .path()
        .join("tui-state")
        .join(&fixture.client.identity.root_id)
        .join("default/state.json");
    let saved: Value = serde_json::from_slice(&std::fs::read(checkpoint).unwrap()).unwrap();
    let cursor = saved["navigation"]["cursor"].as_u64().unwrap() as usize;
    assert_eq!(
        saved["navigation"]["entries"][cursor]["route"]["id"],
        session
    );
    fixture.client.disconnect();
    let mut host = fixture.host;
    host.retire_registered();
    assert!(host.wait_for_exit().success());
}

fn models(fixture: &Fixture, count: usize) {
    fixture.runtime.block_on(async {
        let catalog = fixture.client.connection_catalog(ConnectionCatalogQueryInput::Start).await.unwrap();
        let row = &catalog["items"][0];
        let ids: Vec<_> = (0..count).map(|index| format!("choice-{index:02}")).collect();
        let overrides: serde_json::Map<_, _> = ids.iter().map(|id| (id.clone(), json!({"contextWindow":128000}))).collect();
        fixture.client.request(Operation::ConnectionCatalogUpdate, json!({
            "expected":{"connectionId":row["connectionId"],"revision":row["revision"]},
            "changes":{"name":"TUI fixture","configuration":row["configuration"],"enabled":true,"enabledModelIds":ids,"modelOverrides":overrides}
        })).await.unwrap();
        // Provider order matters: an unfetched manual default is inserted first.
        // The catalog must really put the configured default beyond option 32.
        let (fetched, ()) = tokio::join!(
            fixture.client.fetch_connection_models(row["connectionId"].as_str().unwrap()),
            async {
                let (stream, _) = support::model_list_request(fixture.listener.as_ref().unwrap()).await;
                let data: Vec<_> = (0..count).map(|index| json!({"id":format!("choice-{index:02}"),"object":"model"})).collect();
                support::json_response(stream, "200 OK", json!({"object":"list","data":data})).await;
            }
        );
        fetched.unwrap();
        let catalog = fixture.client.connection_catalog(ConnectionCatalogQueryInput::Start).await.unwrap();
        fixture.client.request(Operation::ConnectionCatalogSetDefaultTarget, json!({
            "expectedCatalogRevision":catalog["revision"],"target":{"connectionId":row["connectionId"],"modelId":"choice-40"}
        })).await.unwrap();
    });
}

#[test]
fn real_host_import_uses_late_default_pages_models_and_searches_beyond_discovery_limit() {
    let fixture = Fixture::new();
    models(&fixture, 60);
    let source = source(&fixture, 2);
    let choices = manage(&fixture, json!({"kind":"models","query":{"query":""}}));
    let default = choices["choices"]["models"]
        .as_array()
        .unwrap()
        .iter()
        .position(|model| model["isDefault"] == true)
        .unwrap();
    assert!(
        default >= 32,
        "fixture must expose the rejected-default regression"
    );
    assert_eq!(choices["choices"]["complete"], false);
    let mut tui = fixture.tui();
    category(&mut tui, "Conversation import", "Recovery source");
    tui.click_page_text("Recovery source");
    tui.wait_for("Recovery case 01");
    tui.click_page_text("Recovery case 01");
    tui.wait_for("choice-40");
    tui.click_last_text("Import");
    tui.wait_for("Import history");
    let copies = manage(&fixture, json!({"kind":"copies","after":null}));
    let session = copies["page"]["copies"][0]["receipt"]["sessionId"]
        .as_str()
        .unwrap();
    assert_eq!(
        fixture
            .runtime
            .block_on(fixture.client.session(session))
            .unwrap()
            .unwrap()
            .model,
        "choice-40"
    );
    tui.click_page_text("Recovery source");
    tui.wait_for("Recovery case 02");
    tui.click_page_text("Recovery case 02");
    tui.wait_for("choice-40");
    let destination = fixture.directory.path().join("chosen-destination");
    std::fs::create_dir(&destination).unwrap();
    edit(&mut tui, "Folder", destination.to_str().unwrap(), "Folder");
    tui.wait_for("chosen-destination");
    // The incomplete-discovery note also begins with "More models".
    tui.click_last_text("More models");
    tui.wait_for("Previous models");
    tui.wait_for("choice-31");
    tui.wait_for("chosen-destination");
    edit(&mut tui, "Find", "choice-59", "Folder");
    tui.click_page_text("Search models");
    // The query editor already contains choice-59, and Loading has neither
    // navigation nor the old hint. Observe the returned model control itself.
    tui.wait_until(|screen| {
        screen.contains("choice-59 · TUI fixture")
            && !screen.contains("Previous models")
            && !screen.contains("Refine your search")
    });
    tui.click_last_text("Import");
    tui.wait_for("Import history");
    let copies = manage(&fixture, json!({"kind":"copies","after":null}));
    let imported = copies["page"]["copies"]
        .as_array()
        .unwrap()
        .iter()
        .find(|copy| copy["sourceSessionId"] == "recovery-02")
        .unwrap();
    assert_eq!(
        imported["sourceId"],
        source["configuration"]["sources"][0]["id"]
    );
    let session = fixture
        .runtime
        .block_on(
            fixture
                .client
                .session(imported["receipt"]["sessionId"].as_str().unwrap()),
        )
        .unwrap()
        .unwrap();
    assert_eq!(session.model, "choice-59");
    assert_eq!(
        serde_json::to_value(session).unwrap()["workspace"]["target"],
        json!({"kind":"host_path","path":destination})
    );
    fixture.finish(tui);
}
