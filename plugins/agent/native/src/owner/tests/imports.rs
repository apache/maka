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
use maka_agent_facts::{
    durable::{BackendSpec, ContentRef, RunOrigin, Terminal},
    history_snapshot::{
        ImportedMessage, ImportedPart, ImportedProviderMetadata, Origin, OriginalRecordsPage,
        OriginalSource,
    },
    model::{ModelPart, TextKind, ToolInput},
};
use maka_agent_state::session_history::snapshot::Snapshot;
use maka_fs_tools::workspace::MARKER_FILE;

struct ImportFaultSql(String);
impl maka_event_log::writeback::Statement for ImportFaultSql {
    type Value = ();
    type Output = ();
    fn execute(
        self,
        connection: &rusqlite::Connection,
    ) -> Result<maka_event_log::writeback::Prepared<()>, maka_event_log::StoreError> {
        connection.execute_batch(&self.0)?;
        Ok(maka_event_log::writeback::Prepared {
            value: (),
            changed: true,
            notification: maka_event_log::writeback::Notification::NONE,
        })
    }
    fn committed((): ()) {}
    fn isolated_rejection(_: &maka_event_log::StoreError) -> bool {
        false
    }
}
async fn fault_sql(fixture: &Fixture, sql: String) {
    fixture
        .store
        .data_writer()
        .unwrap()
        .write(ImportFaultSql(sql))
        .await
        .unwrap();
}
fn sql_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}
fn original_returned(reference: &maka_plugin_core::operation::RecoveryRef) -> String {
    format!(
        "EXISTS(SELECT 1 FROM application_operations WHERE deployment={} AND namespace={} AND operation={} AND json_extract(outcome_json,'$.kind')='returned')",
        sql_literal(&reference.source.deployment.to_string()),
        sql_literal(&serde_json::to_string(&reference.namespace).unwrap()),
        sql_literal(&reference.operation.to_string())
    )
}
struct TargetRows {
    owner: String,
    session: String,
}
impl maka_event_log::connection::Query for TargetRows {
    type Output = (u64, u64, u64);
    fn execute(
        self,
        connection: &rusqlite::Connection,
    ) -> Result<Self::Output, maka_event_log::StoreError> {
        let runs: i64 = connection.query_row(
            "SELECT count(*) FROM agent_run_specs WHERE owner=?1 AND session=?2",
            rusqlite::params![self.owner, self.session],
            |row| row.get(0),
        )?;
        let adoptions: i64 = connection.query_row("SELECT count(*) FROM agent_history_snapshot_adoptions a JOIN agent_run_specs r ON r.run=a.run WHERE r.owner=?1 AND r.session=?2", rusqlite::params![self.owner, self.session], |row| row.get(0))?;
        let captured: i64 = connection.query_row(
            "SELECT count(*) FROM agent_history_snapshots WHERE owner=?1 AND session=?2",
            rusqlite::params![self.owner, self.session],
            |row| row.get(0),
        )?;
        Ok((
            runs.try_into().unwrap(),
            adoptions.try_into().unwrap(),
            captured.try_into().unwrap(),
        ))
    }
}

async fn imported_snapshot(fixture: &Fixture, session: &str) -> Snapshot {
    let history = fixture.history(session);
    let cut = history.capture().await.unwrap();
    let marker = history
        .latest(&cut)
        .await
        .unwrap()
        .expect("actual imported marker");
    assert!(matches!(marker.spec.backend, BackendSpec::Historical {}));
    assert!(matches!(marker.spec.origin, RunOrigin::Imported { .. }));
    let view = fixture.owner.durable.frontier(marker.run).await.unwrap();
    assert_eq!(view.terminal, Some(Terminal::Completed));
    assert!(view.attempts.is_empty(), "import must not dispatch a model");
    assert!(
        view.tools.is_empty(),
        "foreign calls must remain inert source data"
    );
    assert!(
        fixture
            .owner
            .durable
            .queue()
            .read(session.into())
            .await
            .unwrap()
            .entries
            .is_empty()
    );
    history.snapshot(&cut, marker.run).await.unwrap()
}

async fn source_json<T: serde::de::DeserializeOwned + std::marker::Send + 'static>(
    source: &Snapshot,
    reference: &ContentRef,
) -> T {
    source
        .with_payload(reference, |reader| Ok(serde_json::from_reader(reader)?))
        .await
        .unwrap()
}

async fn original_bytes(source: &Snapshot) -> Vec<u8> {
    let Origin::Imported { fingerprint, .. } = source.manifest().await.unwrap().origin else {
        panic!("CLI import must retain an actual imported source")
    };
    let original: OriginalSource = source_json(source, &fingerprint).await;
    let mut previous = original.records;
    let mut pages = Vec::new();
    while let Some(reference) = previous {
        let page: OriginalRecordsPage = source_json(source, &reference).await;
        previous = page.previous;
        pages.push(page.records);
    }
    let mut bytes = Vec::new();
    for page in pages.into_iter().rev() {
        for reference in page {
            bytes.extend(
                source
                    .with_payload(&reference, |reader| {
                        let mut bytes = Vec::new();
                        reader.read_to_end(&mut bytes)?;
                        Ok(bytes)
                    })
                    .await
                    .unwrap(),
            );
        }
    }
    bytes
}

async fn imported_parts(
    source: &Snapshot,
) -> Vec<(
    ImportedMessage,
    Vec<ImportedPart>,
    Option<ImportedProviderMetadata>,
)> {
    let mut after = None;
    let mut result = Vec::new();
    loop {
        let page = source.imported(after, 256).await.unwrap();
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
            let metadata = match &message.provider_metadata {
                Some(reference) => Some(
                    source
                        .with_imported_content(ordinal, reference, |reader| {
                            Ok(serde_json::from_reader::<_, ImportedProviderMetadata>(
                                reader,
                            )?)
                        })
                        .await
                        .unwrap(),
                ),
                None => None,
            };
            result.push((message, parts, metadata));
        }
        match page.next {
            Some(next) => after = Some(next),
            None => return result,
        }
    }
}

fn write_lines(path: &std::path::Path, rows: &[Value]) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let mut bytes = b"\xef\xbb\xbf".to_vec();
    for (index, value) in rows.iter().enumerate() {
        bytes.extend_from_slice(value.to_string().as_bytes());
        if index + 1 != rows.len() {
            bytes.extend_from_slice(b"\r\n");
        }
        if index == 1 {
            bytes.extend_from_slice(b"\n");
        }
    }
    std::fs::write(path, bytes).unwrap();
}
async fn import_without_result_ack(
    fixture: &Fixture,
    input: Value,
    operation: Uuid,
) -> (Value, maka_plugin_core::operation::RecoveryRef) {
    let client = fixture.app.client();
    let prepared = client
        .prepare_mutation(
            fixture.binding(2).await,
            "import".into(),
            input.clone(),
            scope(&fixture.issuer, true),
            operation,
            Attachments::new().into(),
        )
        .await
        .unwrap();
    let reference = prepared.reference().clone();
    let mut changes = fixture
        .store
        .data_writer()
        .unwrap()
        .subscribe_changes()
        .unwrap();
    let mutation = client.mutate_owned(prepared, input).await.unwrap();
    drop(mutation);
    let value = tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            changes.borrow_and_update();
            let observed = client
                .recover(
                    client.activation(&id(2)).unwrap(),
                    reference.clone(),
                    scope(&fixture.issuer, true),
                )
                .await
                .unwrap();
            match observed.map(|observation| observation.outcome) {
                Some(OperationOutcome::Returned {
                    result: maka_plugin_core::operation::OperationResult::Success { value },
                }) => break value,
                Some(OperationOutcome::Unresolved) | None => changes.changed().await.unwrap(),
                outcome => panic!("original import did not commit: {outcome:?}"),
            }
        }
    })
    .await
    .expect("original import must settle without its result observer");
    (value, reference)
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
    let changed_operation = Uuid::new_v4();
    assert_eq!(
        fixture
            .mutation(2, "import", input.clone(), changed_operation)
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
    let rejected_reference = fixture
        .store
        .application_intents(fixture.app.source().unwrap().deployment, id(2), 0, 16)
        .await
        .unwrap()
        .into_iter()
        .find(|entry| entry.reference.operation == changed_operation)
        .unwrap()
        .reference;
    let unpublished = fixture.owner.operation_id(&rejected_reference);
    assert!(
        fixture
            .store
            .get_session::<StoredSessionConfiguration>(&unpublished)
            .await
            .unwrap()
            .is_none(),
        "a changed source must not leave a partially published target"
    );
    write_lines(&path, &codex_rows());
    let operation = Uuid::new_v4();
    let (imported, original_reference) =
        import_without_result_ack(&fixture, input.clone(), operation).await;
    assert_eq!(imported["kind"], "imported", "{imported}");
    let session_id = imported["session"]["id"].as_str().unwrap();
    assert_eq!(
        imported["session"]["workspace"]["path"],
        destinations["roots"][1]["path"]
    );
    let snapshot = imported_snapshot(&fixture, session_id).await;
    let original = std::fs::read(&path).unwrap();
    assert_eq!(original_bytes(&snapshot).await, original);
    let metadata = fixture
        .store
        .get_session::<StoredSessionConfiguration>(session_id)
        .await
        .unwrap()
        .unwrap();
    assert!(
        metadata.configuration.backend.is_none(),
        "foreign provider selection is not target configuration"
    );
    assert!(
        metadata.configuration.parent_session_id.is_none(),
        "a foreign session is not a Root parent"
    );
    let records = imported_parts(&snapshot).await;
    assert_eq!(records.len(), 3);
    for (index, (message, _, _)) in records.iter().enumerate() {
        assert_eq!(message.original_ordinal, [1, 3, 4][index]);
        assert_eq!(
            message.source_message_id, None,
            "missing source ID is not a row-number ID"
        );
        assert_eq!(
            message.source_turn_id, None,
            "derived grouping is not a foreign Turn ID"
        );
        assert_eq!(message.turn_ordinal.0, 0);
        assert_eq!(message.artifact_scope.owner, fixture.owner.run_owner());
        assert_eq!(message.artifact_scope.session, session_id);
    }
    assert!(records.iter().flat_map(|(_, parts, _)| parts).any(|part| matches!(part,
        ImportedPart::Model { part: ModelPart::ToolCall { call } }
            if call.id == "foreign" && call.name == "shell" && call.input == ToolInput::Json(json!({"command":"must not execute"}))
    )));
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
    assert_eq!(reference, original_reference);
    let fence = fixture.through(session_id).await;
    let roots = fixture.owner.settings.workspace_roots.clone();
    let policy = Arc::new(Grant(fixture.issuer.clone(), None));
    workspaces::publish_with_policy(&mut fixture, roots, policy).await;
    std::fs::remove_file(&path).unwrap();
    assert_eq!(original_bytes(&snapshot).await, original);
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
            result: maka_plugin_core::operation::OperationResult::Success {
                value: imported.clone()
            }
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
async fn import_state_failure_rolls_back_original_returned_and_never_replays_unknown() {
    let fixture = Fixture::new("http://127.0.0.1:1/v1", None).await;
    let path = fixture.workspace.join("sessions/atomic-source.jsonl");
    write_lines(&path, &codex_rows());
    let source = saved_source(&fixture, "codex", 0).await;
    let baseline = fixture
        .query("imports", json!({"kind":"sources"}))
        .await
        .unwrap();
    let location = baseline["sources"][0]["location"].clone();
    let namespace = maka_plugin_core::storage::Namespace::new(
        IMPLEMENTATION,
        maka_plugin_core::scope::Scope::Profile,
    )
    .unwrap();
    let key = format!("{}import_sources", fixture.owner.prefix);
    let client = fixture.app.client();
    for input in [
        json!({"kind":"save_source","revision":baseline["revision"],"id":source["id"],"name":"must roll back","location":location}),
        json!({"kind":"remove_source","revision":baseline["revision"],"id":source["id"]}),
    ] {
        let prepared = client
            .prepare_mutation(
                fixture.binding(2).await,
                "import".into(),
                input.clone(),
                scope(&fixture.issuer, true),
                Uuid::new_v4(),
                Attachments::new().into(),
            )
            .await
            .unwrap();
        let reference = prepared.reference().clone();
        // WithOutcome stages Returned first. Fail only after this original S writes.
        let predicate = format!(
            "NEW.package_id={} AND NEW.scope_id={} AND NEW.key={} AND {}",
            sql_literal(namespace.package()),
            sql_literal(&String::from(namespace.scope().clone())),
            sql_literal(&key),
            original_returned(&reference)
        );
        fault_sql(&fixture, format!(
            "CREATE TEMP TRIGGER import_kv_insert AFTER INSERT ON plugin_data WHEN {predicate} BEGIN SELECT RAISE(ABORT,'fixture import KV rollback'); END;
             CREATE TEMP TRIGGER import_kv_update AFTER UPDATE ON plugin_data WHEN {predicate} BEGIN SELECT RAISE(ABORT,'fixture import KV rollback'); END;"
        )).await;
        let completion = client
            .mutate_owned(prepared, input)
            .await
            .unwrap()
            .completion()
            .await;
        completion.cleanup.unwrap();
        fault_sql(
            &fixture,
            "DROP TRIGGER import_kv_insert; DROP TRIGGER import_kv_update;".into(),
        )
        .await;
        let observed = client
            .recover(
                client.activation(&id(2)).unwrap(),
                reference.clone(),
                scope(&fixture.issuer, true),
            )
            .await
            .unwrap()
            .unwrap();
        assert!(
            matches!(observed.outcome, OperationOutcome::Unknown { .. }),
            "SQL failure must retain actual uncertainty, not successful Returned: {observed:?}"
        );
        assert_eq!(
            fixture
                .query("imports", json!({"kind":"sources"}))
                .await
                .unwrap(),
            baseline
        );
        let recovered = client
            .recover(
                client.activation(&id(2)).unwrap(),
                reference,
                scope(&fixture.issuer, true),
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(recovered.outcome, observed.outcome);
        assert_eq!(
            fixture
                .query("imports", json!({"kind":"sources"}))
                .await
                .unwrap(),
            baseline
        );
    }
    let page = catalog(&fixture, &source).await;
    let review = preview(&fixture, &source, &page["entries"][0]).await;
    assert_eq!(review["kind"], "preview");
    let destinations = fixture
        .query("directories", json!({"kind":"roots"}))
        .await
        .unwrap();
    let input = json!({"kind":"copy","selection":review["preview"]["selection"],"path":destinations["roots"][1]["path"],"title":"Atomic source"});
    let prepared = client
        .prepare_mutation(
            fixture.binding(2).await,
            "import".into(),
            input.clone(),
            scope(&fixture.issuer, true),
            Uuid::new_v4(),
            Attachments::new().into(),
        )
        .await
        .unwrap();
    let reference = prepared.reference().clone();
    let target = fixture.owner.operation_id(&reference);
    let owner = serde_json::to_string(&fixture.owner.run_owner()).unwrap();
    let predicate = format!(
        "EXISTS(SELECT 1 FROM agent_run_specs WHERE run=NEW.run AND owner={} AND session={}) AND {}",
        sql_literal(&owner),
        sql_literal(&target),
        original_returned(&reference)
    );
    fault_sql(&fixture, format!("CREATE TEMP TRIGGER import_adoption AFTER INSERT ON agent_history_snapshot_adoptions WHEN {predicate} BEGIN SELECT RAISE(ABORT,'fixture import adoption rollback'); END;")).await;
    let completion = client
        .mutate_owned(prepared, input)
        .await
        .unwrap()
        .completion()
        .await;
    completion.cleanup.unwrap();
    fault_sql(&fixture, "DROP TRIGGER import_adoption;".into()).await;
    let observed = client
        .recover(
            client.activation(&id(2)).unwrap(),
            reference.clone(),
            scope(&fixture.issuer, true),
        )
        .await
        .unwrap()
        .unwrap();
    assert!(
        matches!(observed.outcome, OperationOutcome::Unknown { .. }),
        "{observed:?}"
    );
    assert!(
        fixture
            .store
            .get_session::<StoredSessionConfiguration>(&target)
            .await
            .unwrap()
            .is_none()
    );
    let writer = fixture.store.data_writer().unwrap();
    let before = writer
        .query(TargetRows {
            owner: owner.clone(),
            session: target.clone(),
        })
        .await
        .unwrap();
    assert_eq!(
        before,
        (0, 0, 1),
        "publication must roll back while the original private byte receipt remains"
    );
    assert_eq!(
        fixture
            .query("imports", json!({"kind":"copies","after":null}))
            .await
            .unwrap()["sessions"],
        json!([])
    );
    std::fs::remove_file(path).unwrap();
    let recovered = client
        .recover(
            client.activation(&id(2)).unwrap(),
            reference,
            scope(&fixture.issuer, true),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(recovered.outcome, observed.outcome);
    assert_eq!(
        writer
            .query(TargetRows {
                owner,
                session: target.clone()
            })
            .await
            .unwrap(),
        before
    );
    assert!(
        fixture
            .store
            .get_session::<StoredSessionConfiguration>(&target)
            .await
            .unwrap()
            .is_none()
    );
    fixture.app.shutdown().await.unwrap();
    fixture.config.shutdown().await.unwrap();
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
        let input = json!({"kind":"copy","selection":review["preview"]["selection"],"path":destinations["roots"][1]["path"],"title":"Real Claude Code via Codex Luna"});
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
        let snapshot = imported_snapshot(&fixture, copied).await;
        assert_eq!(original_bytes(&snapshot).await, bytes);
        let records = imported_parts(&snapshot).await;
        let answers = records.iter().filter(|(_, parts, metadata)| {
            metadata.as_ref().is_some_and(|value| value.metadata["message"]["model"] == "codex/gpt-6-luna")
                && parts.iter().any(|part| matches!(part,
                    ImportedPart::Model { part: ModelPart::Text { text_kind: TextKind::Text, text, .. } }
                        if text.chunks().collect::<String>() == "CLAUDE_NATIVE_MCP_83b62f"
                ))
        }).count();
        assert_eq!(answers, 3, "All three native replies, including the resumed turn, must retain model provenance");
        for expected in ["Verification task.", "Without calling any tools,", "This process has resumed our saved conversation."] {
            assert!(records.iter().flat_map(|(_, parts, _)| parts).any(|part| matches!(part,
                ImportedPart::Input { content } if content.text.starts_with(expected)
            )), "Missing original user turn: {expected}");
        }
        let mcp_call = records.iter().flat_map(|(_, parts, _)| parts).find_map(|part| match part {
            ImportedPart::Model { part: ModelPart::ToolCall { call } } if call.name == "mcp__maka_probe__read_marker" => Some(&call.id),
            _ => None,
        }).expect("Missing original MCP call");
        assert!(records.iter().flat_map(|(_, parts, _)| parts).any(|part| matches!(part,
            ImportedPart::ToolReturn { call_id, result, .. }
                if call_id == mcp_call && !result.body.is_error && serde_json::to_string(&result.body.output).unwrap().contains("CLAUDE_NATIVE_MCP_83b62f")
        )), "Original MCP result must retain its call correlation");
        println!("Imported {} native records; all three turns, requested model and correlated MCP result preserved", records.len());
        assert_eq!(fixture.mutation(2, "import", input, operation).await.unwrap(), imported);
        let copies = fixture.query("imports", json!({"kind":"copies","after":null})).await.unwrap();
        assert_eq!(copies["sessions"].as_array().unwrap().len(), 1);
        assert_eq!(std::fs::read(&captured).unwrap(), bytes);
        println!("LIVE_CLAUDE_IMPORT_VERIFIED: catalog, preview, copy, native text/tool/model history, no execution, original receipt");
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
    }).await.unwrap();
}
