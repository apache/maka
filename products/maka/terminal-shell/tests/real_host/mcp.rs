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
#[tokio::test(flavor = "current_thread")]
async fn project_mcp_confirmation_preserves_draft_and_starts_only_after_trust() {
    tokio::time::timeout(Duration::from_secs(120), async {
        let mut fixture = Fixture::open().await;
        let client = fixture.client().await;
        let selected = support::mutate(&client,"selectBackend",json!({"sessionId":fixture.session,"backend":{"kind":"model","connectionId":fixture.selection["connectionId"],"modelId":"fixture-model","thinkingLevel":null}})).await;
        assert_eq!(selected["kind"],"committed");
        let file = fixture.directory.path().join("workspace/.maka/mcp.json");
        let record = fixture.directory.path().join("mcp-record");
        let server = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../plugins/agent/mcp/tests/server.mjs");
        let mut config = json!({"mcpServers":{"local_fixture":{"command":"node","args":[server,"normal",record],"tools":["echo"],"readOnlyTools":["echo"],"preapproved":true,"env":{"SECRET":"HIDDEN_CREDENTIAL"}}}});
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file,serde_json::to_vec(&config).unwrap()).unwrap();
        let (mut view, bindings) = fixture.view(fixture.client().await,Some(fixture.session.clone()));
        view.resize(150,60);
        wait_editable_composer(&mut view).await;
        tab_to_label(&mut view,"Message composer").await;
        view.handle_event(Event::Paste("MCP_DRAFT_KEEP".into()));
        support::wait_draft(&client,&fixture.session,"MCP_DRAFT_KEEP").await;
        support::click_button(&mut view,"Send message").await;
        let screen = wait_view(&mut view,|screen| screen.contains("Trust project MCP configuration?") && screen.contains("Trust configuration")).await;
        evidence("mcp-trust-before-start",&screen);
        assert!(!screen.contains("HIDDEN_CREDENTIAL"));
        assert!(!record.exists());
        assert_eq!(fixture.request_count.load(Ordering::SeqCst),0);
        support::wait_draft(&client,&fixture.session,"MCP_DRAFT_KEEP").await;
        config["mcpServers"]["local_fixture"]["env"]["VERSION"] = json!("changed");
        std::fs::write(&file,serde_json::to_vec(&config).unwrap()).unwrap();
        support::click_button(&mut view,"Trust configuration").await;
        wait_view(&mut view,|screen| screen.contains("The MCP configuration changed.")).await;
        assert!(!record.exists());
        support::click_button(&mut view,"Trust configuration").await;
        wait_view(&mut view,|screen| screen.contains("Project MCP configuration trusted.")).await;
        assert!(!record.exists(),"trust mutation does not start servers");
        support::click_button(&mut view,"Send message").await;
        let request = fixture.next_request().await;
        assert!(record.exists());
        request.tool("mcp__local_fixture__echo",json!({"marker":"MCP_UI_RESULT"})).await;
        let mut result = fixture.next_request().await;
        result.delta("MCP_UI_RESULT received").await;
        result.finish().await;
        let completed = wait_view(&mut view,|screen| screen.contains("MCP_UI_RESULT received")).await;
        evidence("mcp-trust-completed",&completed);
        let calls = std::fs::read_to_string(&record).unwrap().lines().filter(|line| serde_json::from_str::<Value>(line).unwrap()["method"] == "tools/call").count();
        assert_eq!(calls,1);
        let status = client.query("agent","projectMcp",json!({"sessionId":fixture.session})).await.unwrap();
        assert_eq!(status["trusted"],true);
        drop(view);
        drop(bindings);
        client.close().await.unwrap();
        fixture.finish().await;
    }).await.unwrap();
}
