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

use crate::support::native::NativeFixture;
use maka_agent_api::{Configuration, session::StoredSessionConfiguration};
use maka_agent_facts::{
    durable::{BackendSpec, Fact, RunId, RunOrigin, Terminal},
    history_snapshot::{HistoricalRole, HistoryCut, ImportedMessage, ImportedPart},
    input::RunInput,
    model::{ModelPart, TextKind, ToolInput},
};
use maka_agent_state::{
    fold::RunView,
    session_history::{
        snapshot::Snapshot,
        source_tree::{SourceItem, SourceTree},
    },
};
use maka_plugin_core::operation::{OperationOutcome, OperationReply, OperationResult, Receipt};
use serde_json::{Value, json};
use std::{path::Path, time::Duration};
use uuid::Uuid;

fn configuration(workspace: &Path, source: &Path) -> Configuration {
    serde_json::from_value(json!({
        "locale":"en", "tools":[], "automaticTitles":false,
        "workspaceRoots":[{"label":"Destination","path":workspace}],
        "importRoots":[{"label":"Original transcripts","path":source}],
        "permissions":{"access":"workspace_write","requestPermissions":false},
    }))
    .unwrap()
}
fn returned(reply: &OperationReply) -> &Value {
    match &reply.receipt {
        Receipt::Recorded {
            outcome:
                OperationOutcome::Returned {
                    result: OperationResult::Success { value },
                },
            ..
        } => value,
        other => panic!("actual import did not return its original receipt: {other:?}"),
    }
}
async fn imported(f: &NativeFixture, session: &str) -> (RunView, HistoryCut, Snapshot) {
    let runs = f.state.runs(session.into(), None, 16).await.unwrap();
    assert_eq!(
        runs.len(),
        1,
        "one original historical publication, not a local execution"
    );
    let view = f.state.frontier(runs[0]).await.unwrap();
    assert!(matches!(&view.spec.backend, BackendSpec::Historical {}));
    assert!(matches!(&view.spec.origin, RunOrigin::Imported { .. }));
    assert_eq!(view.terminal, Some(Terminal::Completed));
    assert!(view.attempts.is_empty());
    assert!(
        view.tools.is_empty(),
        "foreign calls are inert history, not tool dispatches"
    );
    assert!(view.spec.budget_basis.is_none());
    assert!(
        f.state
            .queue()
            .read(session.into())
            .await
            .unwrap()
            .entries
            .is_empty()
    );
    let input: RunInput = serde_json::from_slice(
        &f.state
            .content(view.run, view.spec.input.clone())
            .await
            .unwrap(),
    )
    .unwrap();
    let RunInput::HistorySource { source: reference } = input else {
        panic!("actual inert HistorySource input")
    };
    let history = f
        .state
        .session_history(view.spec.owner.clone(), session.into());
    let cut = history.capture().await.unwrap();
    let source = history.snapshot(&cut, view.run).await.unwrap();
    assert_eq!(&reference, source.reference());
    (view, cut, source)
}
async fn parts(source: &Snapshot) -> Vec<(ImportedMessage, Vec<ImportedPart>)> {
    let mut after = None;
    let mut result = Vec::new();
    loop {
        let page = source.imported(after, 1).await.unwrap();
        for (ordinal, message) in page.items {
            let mut parts = Vec::new();
            for reference in &message.parts {
                parts.push(
                    source
                        .with_imported_content(ordinal, reference, |reader| {
                            Ok(serde_json::from_reader::<_, ImportedPart>(reader)?)
                        })
                        .await
                        .unwrap(),
                );
            }
            result.push((message, parts));
        }
        match page.next {
            Some(next) => after = Some(next),
            None => return result,
        }
    }
}
async fn copied_messages(source: &Snapshot) -> Vec<ImportedMessage> {
    let tree = SourceTree::snapshot(source).await.unwrap();
    let rows = tree.positions(None, false, false, 16).await.unwrap();
    assert_eq!(rows.len(), 5);
    let mut messages = Vec::new();
    for row in rows {
        let SourceItem::Imported {
            message,
            part_ordinal,
            ..
        } = tree.item(&row.address).await.unwrap()
        else {
            panic!(
                "the copied source must contain original imported rows, not fabricated model facts"
            )
        };
        assert_eq!(part_ordinal, 0);
        messages.push(message);
    }
    messages
}

#[tokio::test]
async fn import_is_retryable_history_not_an_execution_and_survives_copy_and_restart() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let directory = tempfile::tempdir().unwrap();
        let workspace = directory.path().join("workspace");
        let original_directory = directory.path().join("foreign");
        let file = original_directory.join("sessions/2026/rollout-source.jsonl");
        tokio::fs::create_dir_all(&workspace).await.unwrap();
        tokio::fs::create_dir_all(file.parent().unwrap()).await.unwrap();
        let rows = [
            json!({"type":"session_meta","payload":{"id":"foreign-session","cwd":"/untrusted/source","model_provider":"foreign-provider","api_key":"never-a-local-credential"}}),
            json!({"type":"event_msg","payload":{"type":"agent_message","message":"retained, not a prefill"}}),
            json!({"type":"turn_context","payload":{"turn_id":"foreign-turn","model":"foreign-model"}}),
            json!({"type":"event_msg","payload":{"type":"user_message","message":"the original question"}}),
            json!({"type":"response_item","payload":{"type":"function_call","call_id":"foreign-call","name":"old-command","arguments":"{\"command\":\"do not run\"}"}}),
            json!({"type":"event_msg","payload":{"type":"agent_message","message":"the original answer"}}),
            json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"foreign-call","output":{"result":"historical"}}}),
        ];
        let bytes = rows.iter().map(|row| format!("{row}\n")).collect::<String>();
        tokio::fs::write(&file, &bytes).await.unwrap();
        let configuration = configuration(&workspace, &original_directory);
        let f = NativeFixture::open(directory.path(), configuration.clone()).await.unwrap();
        let roots = f.query("importDirectories", json!({"kind":"roots"})).await.unwrap();
        let saved = f.mutation_value("import", json!({
            "kind":"save_source", "revision":0, "id":null, "name":"Original five messages",
            "location":{"kind":"codex","path":roots["roots"][0]["path"]},
        })).await.unwrap();
        assert_eq!(saved["kind"], "sources");
        let source = json!({"id":saved["sources"][0]["id"],"revision":saved["revision"]});
        let catalog = f.query("imports", json!({"kind":"catalog","source":source,
            "query":{"text":"","includeArchived":false,"cursor":null}})).await.unwrap();
        let entries = catalog["entries"].as_array().unwrap();
        assert_eq!(entries.len(), 1);
        let preview = f.query("imports", json!({"kind":"preview","source":source,
            "entry":{"sessionId":entries[0]["id"],"path":entries[0]["path"]},"digest":null,"after":0})).await.unwrap();
        assert_eq!(preview["kind"], "preview");
        assert_eq!(preview["preview"]["records"], 5);
        assert!(!preview.to_string().contains("never-a-local-credential"));
        let destinations = f.query("directories", json!({"kind":"roots"})).await.unwrap();
        let canonical_workspace = tokio::fs::canonicalize(&workspace).await.unwrap();
        let target_root = destinations["roots"].as_array().unwrap().iter()
            .find(|root| root["path"].as_str() == canonical_workspace.to_str())
            .expect("the configured destination is an actual current Root directory")["path"].clone();
        let input = json!({"kind":"copy","selection":preview["preview"]["selection"],
            "path":target_root,"title":"Imported conversation"});
        let operation = Uuid::new_v4();
        let receipt = f.mutation("import", input.clone(), operation).await.unwrap();
        let accepted = returned(&receipt).clone();
        assert_eq!(accepted["kind"], "imported");
        let session = accepted["session"]["id"].as_str().unwrap().to_owned();
        let (view, cut, snapshot) = imported(&f, &session).await;
        let manifest = snapshot.reference().clone();
        let records = parts(&snapshot).await;
        assert_eq!(records.len(), 5);
        assert_eq!(records.iter().map(|(message, _)| message.role).collect::<Vec<_>>(), vec![
            HistoricalRole::Assistant, HistoricalRole::User, HistoricalRole::Assistant,
            HistoricalRole::Assistant, HistoricalRole::Tool,
        ]);
        for (message, part) in &records {
            assert_eq!(part.len(), 1);
            assert_eq!(message.artifact_scope.owner, view.spec.owner);
            assert_eq!(message.artifact_scope.session, session);
            assert!(message.media.is_empty());
        }
        assert!(matches!(&records[0].1[0], ImportedPart::Model { part: ModelPart::Text { text_kind: TextKind::Text, text, .. } }
            if text.chunks().collect::<String>() == "retained, not a prefill"));
        assert!(matches!(&records[1].1[0], ImportedPart::Input { content } if content.text == "the original question"));
        assert!(matches!(&records[2].1[0], ImportedPart::Model { part: ModelPart::ToolCall { call } }
            if call.id == "foreign-call" && call.name == "old-command" && call.input == ToolInput::Json(json!({"command":"do not run"}))));
        assert!(matches!(&records[3].1[0], ImportedPart::Model { part: ModelPart::Text { text_kind: TextKind::Text, text, .. } }
            if text.chunks().collect::<String>() == "the original answer"));
        let ImportedPart::ToolReturn { call_id, result, .. } = &records[4].1[0]
        else { panic!("the result stays after the intervening assistant answer") };
        assert_eq!(call_id, "foreign-call");
        result.validate().unwrap();
        assert!(!result.body.is_error);
        assert_eq!(result.body.output.clone().into_json(), json!({"result":"historical"}));
        let metadata = f.root.session(&session).await.unwrap().get::<StoredSessionConfiguration>().await.unwrap().unwrap();
        assert!(metadata.configuration.backend.is_none());
        assert!(metadata.configuration.parent_session_id.is_none());
        let visible = f.query("history", json!({"sessionId":session,"position":{"kind":"start"}})).await.unwrap();
        assert!(visible.to_string().contains("retained, not a prefill"));
        assert!(visible.to_string().contains("the original answer"));

        let changed_bytes = format!("{bytes}{}\n", json!({"type":"event_msg","payload":{"type":"agent_message","message":"later unrelated source append"}}));
        tokio::fs::write(&file, changed_bytes).await.unwrap();
        assert_eq!(f.mutation_value("import", input.clone()).await.unwrap()["kind"], "changed");
        assert_eq!(f.query("imports", json!({"kind":"copies","after":null})).await.unwrap()["sessions"].as_array().unwrap().len(), 1,
            "a stale source selection cannot publish another target");
        assert_eq!(parts(&snapshot).await, records, "a changed file cannot mutate the frozen reviewed source");
        let revision = accepted["session"]["revision"].clone();
        let fork = f.mutation_value("fork", json!({"sessionId":session,"expectedRevision":revision,
            "position":{"kind":"end"},"title":"Independent copy","labels":[]})).await.unwrap();
        assert_eq!(fork["kind"], "forked");
        let copy = fork["session"]["id"].as_str().unwrap().to_owned();
        assert_ne!(copy, session);
        let (_, _, inherited) = imported(&f, &copy).await;
        let copied = copied_messages(&inherited).await;
        assert_eq!(copied, records.iter().map(|(message, _)| message.clone()).collect::<Vec<_>>(),
            "copy keeps qualified original parts and artifact ownership, not target-ID aliases");
        assert_eq!(f.state.session_history(view.spec.owner.clone(), session.clone()).capture().await.unwrap(), cut);
        let before = f.state.history(view.run, 0, 256).await.unwrap();
        assert!(!before.iter().any(|record| matches!(&record.fact,
            Fact::ModelAttemptAdmitted { .. } | Fact::ToolAdmitted { .. })));
        let original_run: RunId = view.run;
        drop(snapshot);
        drop(inherited);
        f.shutdown().await.unwrap();
        tokio::fs::remove_file(&file).await.unwrap();

        let f = NativeFixture::open(directory.path(), configuration).await.unwrap();
        let retry = f.mutation("import", input, operation).await.unwrap();
        assert_eq!(retry.reference, receipt.reference);
        assert_eq!(returned(&retry), &accepted, "same intent returns the original receipt without reading the removed source");
        let (reopened, reopened_cut, snapshot) = imported(&f, &session).await;
        assert_eq!(reopened.run, original_run);
        assert_eq!(reopened.spec, view.spec);
        assert_eq!(reopened_cut, cut);
        assert_eq!(snapshot.reference(), &manifest);
        assert_eq!(parts(&snapshot).await, records);
        assert_eq!(f.state.history(original_run, 0, 256).await.unwrap(), before);
        let (_, _, inherited) = imported(&f, &copy).await;
        assert_eq!(copied_messages(&inherited).await, copied);
        assert_eq!(f.query("history", json!({"sessionId":session,"position":{"kind":"start"}})).await.unwrap(), visible);
        drop(snapshot);
        drop(inherited);
        f.shutdown().await.unwrap();
    }).await.unwrap();
}
