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
use maka_fs_tools::workspace::MARKER_FILE;

fn write_lines(path: &std::path::Path, rows: &[Value]) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let bytes = rows
        .iter()
        .map(|value| format!("{value}\n"))
        .collect::<String>();
    std::fs::write(path, bytes).unwrap();
}
fn codex_rows() -> Vec<Value> {
    vec![
        json!({"type":"session_meta","payload":{"id":"source","cwd":"/untrusted/source/path","model_provider":"not-selected","api_key":"must-not-import"}}),
        json!({"type":"event_msg","payload":{"type":"user_message","message":"Imported question"}}),
        json!({"type":"event_msg","payload":{"type":"agent_message","message":"Imported answer"}}),
        json!({"type":"response_item","payload":{"type":"function_call","call_id":"foreign","name":"shell","arguments":"{\"command\":\"must not execute\"}"}}),
    ]
}
async fn saved_source(fixture: &Fixture, kind: &str, revision: u64) -> Value {
    let roots = fixture
        .query("importDirectories", json!({"kind":"roots"}))
        .await
        .unwrap();
    let mut location = json!({"kind":kind,"path":roots["roots"][0]["path"]});
    if kind == "open_code" {
        location["database"] = json!("opencode.db");
    }
    let result=fixture.mutation(2,"import",json!({"kind":"save_source","revision":revision,"id":null,"name":kind,"location":location}),Uuid::new_v4()).await.unwrap();
    assert_eq!(result["kind"], "sources", "{result}");
    json!({"id":result["sources"].as_array().unwrap().last().unwrap()["id"],"revision":result["revision"]})
}
async fn catalog(fixture: &Fixture, source: &Value) -> Value {
    fixture.query("imports",json!({"kind":"catalog","source":source,"query":{"text":"","includeArchived":false,"cursor":null}})).await.unwrap()
}
async fn preview(fixture: &Fixture, source: &Value, entry: &Value) -> Value {
    fixture.query("imports",json!({"kind":"preview","source":source,"entry":{"sessionId":entry["id"],"path":entry["path"]},"digest":null,"after":0})).await.unwrap()
}
#[tokio::test]
async fn imports_original_codex_history_requires_preview_and_keeps_receipt_across_reactivation() {
    let mut fixture = Fixture::new("http://127.0.0.1:1/v1", None).await;
    let path = fixture.workspace.join("sessions/2026/rollout-source.jsonl");
    write_lines(&path, &codex_rows());
    let roots = fixture
        .query("importDirectories", json!({"kind":"roots"}))
        .await
        .unwrap();
    let saved = fixture
        .mutation(
            2,
            "import",
            json!({
                "kind":"save_source", "revision":0, "id":null,
                "name":"完整".repeat(9000),
                "location":{"kind":"codex","path":roots["roots"][0]["path"]}
            }),
            Uuid::new_v4(),
        )
        .await
        .unwrap();
    assert_eq!(saved["kind"], "sources");
    assert_eq!(saved["sources"][0]["name"], "完整".repeat(9000));
    let source = json!({"id":saved["sources"][0]["id"],"revision":saved["revision"]});
    let requery = fixture
        .query("imports", json!({"kind":"sources"}))
        .await
        .unwrap();
    assert_eq!(requery["revision"], saved["revision"]);
    assert_eq!(requery["sources"], saved["sources"]);
    assert!(!fixture.workspace.join(MARKER_FILE).exists());
    let page = catalog(&fixture, &source).await;
    assert_eq!(page["entries"].as_array().unwrap().len(), 1, "{page}");
    let review = preview(&fixture, &source, &page["entries"][0]).await;
    assert_eq!(review["kind"], "preview", "{review}");
    assert_eq!(review["preview"]["records"], 3);
    assert_eq!(review["preview"]["cwd"], "/untrusted/source/path");
    assert!(!review.to_string().contains("must-not-import"));
    let destinations = fixture
        .query("directories", json!({"kind":"roots"}))
        .await
        .unwrap();
    let input = json!({"kind":"copy","selection":review["preview"]["selection"],"path":destinations["roots"][1]["path"],"title":"My imported conversation"});
    let mut rows = codex_rows();
    rows.push(json!({"type":"event_msg","payload":{"type":"agent_message","message":"Appended after review"}}));
    write_lines(&path, &rows);
    assert_eq!(
        fixture
            .mutation(2, "import", input.clone(), Uuid::new_v4())
            .await
            .unwrap()["kind"],
        "changed"
    );
    assert_eq!(
        fixture
            .query("imports", json!({"kind":"copies","after":null}))
            .await
            .unwrap()["sessions"],
        json!([])
    );
    write_lines(&path, &codex_rows());
    let operation = Uuid::new_v4();
    let imported = fixture
        .mutation(2, "import", input.clone(), operation)
        .await
        .unwrap();
    assert_eq!(imported["kind"], "imported", "{imported}");
    let session_id = imported["session"]["id"].as_str().unwrap();
    assert_eq!(
        imported["session"]["workspace"]["path"],
        destinations["roots"][1]["path"]
    );
    assert!(
        fixture
            .session(session_id)
            .await
            .unfinished_invocations(0, 16)
            .await
            .unwrap()
            .invocations
            .is_empty()
    );
    assert!(
        fixture
            .store
            .pending_message_sessions(&fixture.owner.prefix, None)
            .await
            .unwrap()
            .is_empty()
    );
    let history = fixture
        .query(
            "history",
            json!({"sessionId":session_id,"position":{"kind":"start"}}),
        )
        .await
        .unwrap();
    assert!(
        history.to_string().contains("Imported question"),
        "{history}"
    );
    assert!(history.to_string().contains("Imported answer"), "{history}");
    let original_source = fixture.app.source().unwrap().clone();
    let reference = fixture
        .store
        .application_intents(original_source.deployment, id(2), 0, 16)
        .await
        .unwrap()
        .into_iter()
        .find(|entry| entry.reference.operation == operation)
        .unwrap()
        .reference;
    let fence = fixture.through(session_id).await;
    let roots = fixture.owner.settings.workspace_roots.clone();
    let policy = Arc::new(Grant(fixture.issuer.clone(), None));
    workspaces::publish_with_policy(&mut fixture, roots, policy).await;
    std::fs::remove_file(&path).unwrap();
    // The original operation is recovered from the real Host journal. No source
    // read, conversion, or second Session is needed after reactivation.
    let client = fixture.app.client();
    let recovered = client
        .recover(
            client.activation(&id(2)).unwrap(),
            reference,
            scope(&fixture.issuer, true),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        recovered.outcome,
        OperationOutcome::Returned {
            value: imported.clone()
        }
    );
    assert_eq!(fixture.through(session_id).await, fence);
    let copies = fixture
        .query("imports", json!({"kind":"copies","after":null}))
        .await
        .unwrap();
    assert_eq!(copies["sessions"].as_array().unwrap().len(), 1);
    assert_eq!(copies["sessions"][0]["id"], session_id);
    let sources = fixture
        .query("imports", json!({"kind":"sources"}))
        .await
        .unwrap();
    assert_eq!(sources["sources"].as_array().unwrap().len(), 1);
    assert_eq!(sources["revision"], saved["revision"]);
    assert_eq!(sources["sources"], saved["sources"]);
    assert_eq!(sources["sources"][0]["name"], "完整".repeat(9000));
    let removed = fixture
        .mutation(
            2,
            "import",
            json!({"kind":"remove_source","revision":sources["revision"],"id":source["id"]}),
            Uuid::new_v4(),
        )
        .await
        .unwrap();
    assert_eq!(removed["sources"], json!([]));
    assert_eq!(
        fixture
            .query("imports", json!({"kind":"copies","after":null}))
            .await
            .unwrap()["sessions"][0]["id"],
        session_id
    );
    fixture.app.shutdown().await.unwrap();
}
#[tokio::test]
async fn imports_reject_stale_sources_foreign_entries_and_replaced_physical_directories() {
    let fixture = Fixture::new("http://127.0.0.1:1/v1", None).await;
    write_lines(&fixture.workspace.join("sessions/a.jsonl"), &codex_rows());
    std::fs::write(fixture.workspace.join(MARKER_FILE), "Not a Maka workspace").unwrap();
    let source = saved_source(&fixture, "codex", 0).await;
    let other = fixture
        .query("directories", json!({"kind":"roots"}))
        .await
        .unwrap()["roots"][1]["path"]
        .clone();
    assert_eq!(fixture.mutation(2,"import",json!({"kind":"save_source","revision":1,"id":null,"name":"Unpublished","location":{"kind":"codex","path":other}}),Uuid::new_v4()).await.unwrap()["kind"],"unavailable");
    assert_eq!(
        fixture
            .mutation(
                2,
                "import",
                json!({"kind":"remove_source","revision":0,"id":source["id"]}),
                Uuid::new_v4()
            )
            .await
            .unwrap()["kind"],
        "changed"
    );
    let denied=fixture.query("imports",json!({"kind":"preview","source":source,"entry":{"sessionId":"source","path":"../root/data.sqlite"},"digest":null,"after":0})).await.unwrap();
    assert_ne!(denied["kind"], "preview");
    let before = catalog(&fixture, &source).await;
    assert_eq!(before["kind"], "catalog");
    let replaced = fixture.workspace.with_file_name("previous-source");
    std::fs::rename(&fixture.workspace, &replaced).unwrap();
    std::fs::create_dir(&fixture.workspace).unwrap();
    write_lines(&fixture.workspace.join("sessions/a.jsonl"), &codex_rows());
    assert_eq!(catalog(&fixture, &source).await["kind"], "unavailable");
    assert!(!fixture.workspace.join(MARKER_FILE).exists());
    assert_eq!(
        fixture
            .query("imports", json!({"kind":"copies","after":null}))
            .await
            .unwrap()["sessions"],
        json!([])
    );
    fixture.app.shutdown().await.unwrap();
}

#[tokio::test]
#[ignore = "Requires MAKA_TEST_CLAUDE_TRANSCRIPT from the real interactive MCP probe"]
async fn imports_real_interactive_claude_transcript_through_preview_copy_and_history() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let original = std::path::PathBuf::from(std::env::var("MAKA_TEST_CLAUDE_TRANSCRIPT").expect("Set MAKA_TEST_CLAUDE_TRANSCRIPT to the captured native JSONL"));
        let session_id = original.file_stem().unwrap().to_str().unwrap();
        let bytes = std::fs::read(&original).unwrap();
        let fixture = Fixture::new("http://127.0.0.1:1/v1", None).await;
        let captured = fixture.workspace.join("projects/native-claude").join(format!("{session_id}.jsonl"));
        std::fs::create_dir_all(captured.parent().unwrap()).unwrap();
        std::fs::write(&captured, &bytes).unwrap();
        let source = saved_source(&fixture, "claude_code", 0).await;
        let page = catalog(&fixture, &source).await;
        let entry = page["entries"].as_array().unwrap().iter().find(|entry| entry["id"] == session_id).expect("Native Claude session must be discoverable");
        let review = preview(&fixture, &source, entry).await;
        assert_eq!(review["kind"], "preview", "{review}");
        assert!(review["preview"]["records"].as_u64().unwrap() >= 6, "{review}");
        let destinations = fixture.query("directories", json!({"kind":"roots"})).await.unwrap();
        let input = json!({"kind":"copy","selection":review["preview"]["selection"],"directory":destinations["roots"][1]["selection"],"title":"Real Claude Code via Codex Luna"});
        let operation = Uuid::new_v4();
        let imported = fixture.mutation(2, "import", input.clone(), operation).await.unwrap();
        assert_eq!(imported["kind"], "imported", "{imported}");
        let copied = imported["session"]["id"].as_str().unwrap();
        assert_eq!(imported["session"]["workspace"]["path"], destinations["roots"][1]["path"]);
        let history = fixture.query("history", json!({"sessionId":copied,"position":{"kind":"start"}})).await.unwrap();
        let text = history.to_string();
        for expected in ["CLAUDE_NATIVE_MCP_83b62f", "mcp__maka_probe__read_marker", "gpt-6-luna"] {
            assert!(text.contains(expected), "Imported history must retain {expected}: {history}");
        }
        use maka_agent_facts::{event::Fact, import::Content};
        let prefix = fixture.prefix(copied, 128, 1024 * 1024).await;
        let records: Vec<_> = prefix.events.iter().filter_map(|row| match &row.event.fact {
            Fact::MessageImported { record, .. } => Some(record),
            _ => None,
        }).collect();
        let answers = records.iter().filter(|record| matches!(&record.content,
            Content::Assistant { text, model, .. }
                if text == "CLAUDE_NATIVE_MCP_83b62f" && model.as_deref() == Some("codex/gpt-6-luna")
        )).count();
        assert_eq!(answers, 3, "All three native replies, including the resumed turn, must retain model provenance");
        for expected in ["Verification task.", "Without calling any tools,", "This process has resumed our saved conversation."] {
            assert!(records.iter().any(|record| matches!(&record.content,
                Content::User { text } if text.starts_with(expected)
            )), "Missing original user turn: {expected}");
        }
        let mcp_call = records.iter().find_map(|record| match &record.content {
            Content::ToolCall { call_id, name, .. } if name == "mcp__maka_probe__read_marker" => Some(call_id),
            _ => None,
        }).expect("Missing original MCP call");
        assert!(records.iter().any(|record| matches!(&record.content,
            Content::ToolResult { call_id, output, is_error: false }
                if call_id == mcp_call && output.to_string().contains("CLAUDE_NATIVE_MCP_83b62f")
        )), "Original MCP result must retain its call correlation");
        println!("Imported {} native records; all three turns, requested model and correlated MCP result preserved", records.len());
        assert!(fixture.session(copied).await.unfinished_invocations(0, 16).await.unwrap().invocations.is_empty());
        assert!(fixture.store.pending_message_sessions(&fixture.owner.prefix, None).await.unwrap().is_empty());
        assert_eq!(fixture.mutation(2, "import", input, operation).await.unwrap(), imported);
        let copies = fixture.query("imports", json!({"kind":"copies","after":null})).await.unwrap();
        assert_eq!(copies["sessions"].as_array().unwrap().len(), 1);
        assert_eq!(std::fs::read(&captured).unwrap(), bytes);
        println!("LIVE_CLAUDE_IMPORT_VERIFIED: catalog, preview, copy, native text/tool/model history, no execution, original receipt");
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
    }).await.unwrap();
}
