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

async fn publish_workspace(client: &AppClient, session: &str, expected: &Value) -> Value {
    let preview = client
        .query(
            "agent",
            "previewHistoryCheckpoint",
            json!({"sessionId":session}),
        )
        .await
        .unwrap();
    let result = mutate(client, "publishCheckpoint", json!({
        "sessionId":session, "expectedRevision":expected, "confirmedSubtreeDigest":preview["subtreeDigest"],
        "workspaceConsistency":"caller_confirmed_quiescent"
    })).await;
    assert_eq!(result["state"]["kind"], "published", "{result}");
    result["state"]["head"].clone()
}

async fn finish_turn(client: &AppClient, session: &str, mut request: ModelRequest, answer: &str) {
    request.delta(answer).await;
    request.finish().await;
    while activity(client, session).await != "idle" {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn successor_host_restores_workspace_continues_session_and_publishes_next_checkpoint() {
    tokio::time::timeout(Duration::from_secs(120), checkpoint_handoff())
        .await
        .expect("checkpoint handoff timed out");
}

async fn checkpoint_handoff() {
    use maka_plugin_core::operation::{OperationOutcome, Receipt};

    let (fixture, selection, mut requests) = configured_root(true).await;
    let journal = fixture.directory().join("client.db");
    let (mut first, a, epoch) = start_host(&fixture.root, &journal).await;
    let roots = a
        .query("agent", "directories", json!({"kind":"roots"}))
        .await
        .unwrap();
    let scratch = tempfile::tempdir_in(roots["roots"][0]["path"].as_str().unwrap()).unwrap();
    let project = scratch.path().join("project");
    fs::create_dir(&project).unwrap();
    fs::write(project.join("answer.txt"), "captured").unwrap();
    let created = mutate(&a, "create", json!({"title":"Checkpoint handoff","labels":[],"workspace":{"kind":"directory","path":project}})).await;
    let session = created["session"]["id"].as_str().unwrap();
    let backend = json!({"kind":"model","connectionId":selection["connectionId"],"modelId":selection["modelId"]});
    mutate(
        &a,
        "send",
        json!({"sessionId":session,"message":"Before handoff","backend":backend}),
    )
    .await;
    requests
        .recv()
        .await
        .unwrap()
        .tool_call("exec", json!({"code":"text(31415 + 9265)"}))
        .await;
    let next = requests.recv().await.unwrap();
    assert!(
        next.body["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["role"] == "tool" && m.to_string().contains("40680")),
        "{}",
        next.body
    );
    finish_turn(&a, session, next, "Finished before handoff").await;
    let history_input = json!({"sessionId":session,"position":{"kind":"start"}});
    let original = a
        .query("agent", "history", history_input.clone())
        .await
        .unwrap();
    assert!(
        original["chunks"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["role"] == "tool_result")
    );
    let head = publish_workspace(&a, session, &Value::Null).await;
    fs::write(project.join("answer.txt"), "later local edit").unwrap();

    let restore = json!({"checkpoint":{"sessionId":session,"revision":head["revision"]},
        "parent":scratch.path(),"backend":backend,"permissions":{"access":"workspace_write","requestPermissions":true},"acceptExternalWritersRisk":true});
    let operation = a
        .mutation(
            uuid::Uuid::new_v4(),
            "agent",
            "restoreSessionCheckpoint",
            restore.clone(),
            Default::default(),
            None,
            Value::Null,
        )
        .await
        .unwrap();
    let attempt = operation.id();
    let reference = operation.prepare().await.unwrap().reference.unwrap();
    let db =
        rusqlite::Connection::open(fixture.root.join(maka_event_log::root::ROOT_DATABASE)).unwrap();
    // Keep both commits out of this crash window even if the Host runs faster
    // than the test process. The connection observes committed facts in WAL.
    db.execute_batch(&format!(
        "CREATE TRIGGER block_restore_binding BEFORE UPDATE OF result_json ON checkpoint_workspace_restores
         WHEN json_extract(OLD.request_json,'$.operation.operation')='{0}'
         BEGIN SELECT RAISE(ABORT,'hold restore commit'); END;
         CREATE TRIGGER block_restore_settlement BEFORE UPDATE OF outcome_json ON application_operations
         WHEN OLD.operation='{0}' BEGIN SELECT RAISE(ABORT,'hold Host settlement'); END;",
        reference.operation)).unwrap();
    let dispatch = tokio::spawn(async move { operation.confirm().await });
    let prepared_path: String = loop {
        use rusqlite::OptionalExtension;
        let dispatch_finished = dispatch.is_finished();
        let saved = db.query_row("SELECT json_extract(prepared_json,'$.path') FROM checkpoint_workspace_restores
            WHERE json_extract(request_json,'$.operation.operation')=? AND directory_identity_json IS NOT NULL AND result_json IS NULL",
            [reference.operation.to_string()], |row| row.get(0)).optional().unwrap();
        if let Some(path) = saved {
            break path;
        }
        assert!(!dispatch_finished, "restore ended before materialization");
        tokio::time::sleep(Duration::from_millis(10)).await;
    };
    first.start_kill().unwrap();
    assert_eq!(first.wait().await.unwrap().signal(), Some(libc::SIGKILL));
    drop(a);
    let (mut second, b, new_epoch) = start_host(&fixture.root, &journal).await;
    assert_ne!(epoch, new_epoch);
    let _ = dispatch.await.unwrap();
    db.execute_batch("DROP TRIGGER block_restore_binding; DROP TRIGGER block_restore_settlement;")
        .unwrap();
    drop(db);
    let unknown = b.recover(attempt).await.unwrap();
    assert_eq!(unknown.reference, reference);
    let uncertain_input = json!({"reference":reference,"input":restore});
    let evidence = b
        .query(
            "agent",
            "sessionCheckpointRestoreReceipt",
            uncertain_input.clone(),
        )
        .await
        .unwrap();
    assert_eq!(evidence["operation"]["outcome"]["kind"], "unresolved");
    assert!(evidence["restore"].is_null());
    assert_eq!(
        b.query("agent", "sessionCheckpointRestoreReceipt", uncertain_input)
            .await
            .unwrap(),
        evidence
    );
    let interrupted_path = Path::new(&prepared_path);
    assert_eq!(
        fs::read_to_string(interrupted_path.join("answer.txt")).unwrap(),
        "captured"
    );
    assert_eq!(
        fs::read_dir(scratch.path()).unwrap().count(),
        2,
        "receipt recovery must not copy another directory"
    );
    let session_input = json!({"sessionId":session});
    let observed = b
        .query("agent", "observe", session_input.clone())
        .await
        .unwrap();
    assert_eq!(
        observed["session"]["workspace"],
        created["session"]["workspace"]
    );
    assert_eq!(observed["session"]["activity"], "idle");
    let restored = mutate(&b, "restoreSessionCheckpoint", restore.clone()).await;
    assert_eq!(restored["sessionId"], session);
    assert_eq!(restored["head"], head);
    let target = Path::new(restored["path"].as_str().unwrap());
    assert_ne!(target, project);
    assert_ne!(target, interrupted_path);
    let observed = b.query("agent", "observe", session_input).await.unwrap();
    assert_eq!(observed["session"]["workspace"]["path"], restored["path"]);
    assert_eq!(
        fs::read_to_string(target.join("answer.txt")).unwrap(),
        "captured"
    );
    assert_eq!(
        fs::read_to_string(project.join("answer.txt")).unwrap(),
        "later local edit"
    );
    assert_eq!(
        b.query("agent", "history", history_input.clone())
            .await
            .unwrap()["chunks"],
        original["chunks"]
    );
    assert_eq!(activity(&b, session).await, "idle");
    mutate(
        &b,
        "send",
        json!({"sessionId":session,"message":"After handoff","backend":backend}),
    )
    .await;
    let next = requests.recv().await.unwrap();
    let messages = next.body["messages"].as_array().unwrap();
    assert!(
        messages
            .iter()
            .any(|m| m["role"] == "user" && m.to_string().contains("After handoff"))
    );
    assert!(
        messages
            .iter()
            .any(|m| m["role"] == "assistant" && m.to_string().contains("Finished before handoff"))
    );
    finish_turn(&b, session, next, "Finished after handoff").await;
    let stale = b
        .mutation(
            uuid::Uuid::new_v4(),
            "agent",
            "restoreSessionCheckpoint",
            restore,
            Default::default(),
            None,
            Value::Null,
        )
        .await
        .unwrap();
    stale.prepare().await.unwrap();
    let reply = stale.confirm().await.unwrap();
    assert!(
        matches!(reply.receipt,Receipt::Recorded {outcome:OperationOutcome::Unknown {ref diagnostic},..} if diagnostic == "agent_history_checkpoint_unavailable"),
        "{:?}",
        reply.receipt
    );
    let successor = publish_workspace(&b, session, &head["revision"]).await;
    assert_ne!(successor["revision"], head["revision"]);
    assert_eq!(
        b.query(
            "agent",
            "historyCheckpointHead",
            json!({"sessionId":session})
        )
        .await
        .unwrap(),
        successor
    );
    let tail = b
        .query(
            "agent",
            "history",
            json!({"sessionId":session,"position":{"kind":"tail"}}),
        )
        .await
        .unwrap();
    let chunks = tail["chunks"].as_array().unwrap();
    assert!(
        chunks
            .iter()
            .any(|chunk| chunk["text"] == "Finished after handoff"),
        "tail chunks: {chunks:?}"
    );
    b.close().await.unwrap();
    second.kill().await.unwrap();
}
