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

async fn mutate(f: &Fixture, method: &str, input: Value, id: Uuid) -> (RecoveryRef, Value) {
    let client = f.app.client();
    let prepared = client
        .prepare_mutation(
            f.binding(2).await,
            method.into(),
            input,
            scope(&f.issuer, true),
            id,
            Attachments::new().into(),
        )
        .await
        .unwrap();
    let reference = prepared.reference().clone();
    let receipt = client
        .mutate_owned(prepared)
        .await
        .unwrap()
        .result()
        .await
        .receipt;
    let Receipt::Recorded {
        outcome: OperationOutcome::Returned { value },
        ..
    } = receipt
    else {
        panic!("{receipt:?}")
    };
    (reference, value)
}

#[tokio::test]
async fn workspace_checkpoint_restores_same_session_and_runs_next_turn_then_cas() {
    tokio::time::timeout(Duration::from_secs(120), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = Fixture::new(&format!("http://{}/v1", listener.local_addr().unwrap()), None).await;
        let session = f.create("Restore workspace").await;
        std::fs::write(f.workspace.join("answer.txt"), "checkpoint file").unwrap();
        turn(&f, &listener, &session, "checkpoint history").await;
        let original = json!({"history":input(&f,&session,Value::Null).await,"workspaceConsistency":"unverified"});
        let (publication_ref,value) = mutate(&f,"publishSessionCheckpoint",original.clone(),Uuid::new_v4()).await;
        assert_eq!(value["warning"],"external_writers_not_fenced");
        assert_eq!(value["workspaceConsistency"],"unverified");
        let head = value["publication"]["state"]["head"].clone();
        std::fs::write(f.workspace.join("answer.txt"), "source modified later").unwrap();
        let roots = f.query("directories", json!({"kind":"roots"})).await.unwrap();
        let restore_input = json!({"checkpoint":{"sessionId":session,"revision":head["revision"]},
            "parent":roots["roots"][1]["selection"],"permissions":{"access":"workspace_write","requestPermissions":true},
            "backend":model_backend(&f.selection().await),"acceptExternalWritersRisk":true});
        let operation = Uuid::new_v4();
        let (restore_ref,result) = mutate(&f,"restoreSessionCheckpoint",restore_input.clone(),operation).await;
        assert_eq!(result["sessionId"],session);
        assert_eq!(result["head"],head);
        assert_eq!(result["workspace"]["consistency"],"unverified");
        let target = std::path::PathBuf::from(result["path"].as_str().unwrap());
        assert_eq!(std::fs::read_to_string(target.join("answer.txt")).unwrap(),"checkpoint file");
        assert_eq!(std::fs::read_to_string(f.workspace.join("answer.txt")).unwrap(),"source modified later");
        let active = f.owner.session(&session).await.unwrap();
        assert_eq!(active.configuration.workspace.path,result["path"].as_str().unwrap());
        assert_eq!(f.mutation(2,"restoreSessionCheckpoint",restore_input.clone(),operation).await.unwrap(),result);
        turn(&f,&listener,&session,"continued after workspace restore").await;
        let history=f.query("history",json!({"sessionId":session,"position":{"kind":"tail"}})).await.unwrap().to_string();
        assert!(history.contains("checkpoint history") && history.contains("continued after workspace restore"));
        let next = f.mutation(2,"publishSessionCheckpoint",json!({"history":input(&f,&session,head["revision"].clone()).await,"workspaceConsistency":"caller_confirmed_quiescent"}),Uuid::new_v4()).await.unwrap();
        assert_eq!(next["publication"]["state"]["kind"],"published", "{next}");
        assert_ne!(next["publication"]["state"]["head"]["revision"], head["revision"]);
        assert_eq!(f.query("historyCheckpointHead",json!({"sessionId":session})).await.unwrap(),next["publication"]["state"]["head"]);
        assert!(f.mutation(2,"restoreSessionCheckpoint",restore_input.clone(),Uuid::new_v4()).await.is_err());
        assert_eq!(f.query("sessionCheckpointReceipt",json!({"reference":publication_ref,"input":original})).await.unwrap()["checkpoint"],value);
        let parent=target.parent().unwrap();
        std::fs::rename(parent,parent.with_file_name("moved-restored-parent")).unwrap();
        assert_eq!(f.query("sessionCheckpointRestoreReceipt",json!({"reference":restore_ref,"input":restore_input})).await.unwrap()["restore"],result);
        close(&f).await;
    }).await.unwrap();
}

#[tokio::test]
async fn workspace_checkpoint_requires_explicit_consistency_and_rejects_advanced_history_restore() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let f = Fixture::new(
        &format!("http://{}/v1", listener.local_addr().unwrap()),
        None,
    )
    .await;
    let session = f.create("No history rollback").await;
    let history = input(&f, &session, Value::Null).await;
    assert!(
        f.mutation(
            2,
            "publishSessionCheckpoint",
            json!({"history":history}),
            Uuid::new_v4()
        )
        .await
        .is_err()
    );
    let value = f
        .mutation(
            2,
            "publishSessionCheckpoint",
            json!({"history":history,"workspaceConsistency":"caller_confirmed_quiescent"}),
            Uuid::new_v4(),
        )
        .await
        .unwrap();
    turn(&f, &listener, &session, "newer history").await;
    let roots = f
        .query("directories", json!({"kind":"roots"}))
        .await
        .unwrap();
    let request = json!({"checkpoint":{"sessionId":session,"revision":value["publication"]["state"]["head"]["revision"]},"parent":roots["roots"][1]["selection"],"permissions":{"access":"read_only","requestPermissions":true},"backend":model_backend(&f.selection().await),"acceptExternalWritersRisk":true});
    assert!(
        f.mutation(2, "restoreSessionCheckpoint", request, Uuid::new_v4())
            .await
            .is_err()
    );
    assert_eq!(
        f.owner
            .session(&session)
            .await
            .unwrap()
            .configuration
            .workspace
            .path,
        f.workspace.to_str().unwrap()
    );
    close(&f).await;
}

#[tokio::test]
async fn workspace_restore_rejects_an_inflight_goal_producer() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let f = Fixture::new(
        &format!("http://{}/v1", listener.local_addr().unwrap()),
        None,
    )
    .await;
    let session = f.create("Goal producer during restore").await;
    let value = f
        .mutation(
            2,
            "publishSessionCheckpoint",
            json!({
                "history":input(&f,&session,Value::Null).await,
                "workspaceConsistency":"unverified"
            }),
            Uuid::new_v4(),
        )
        .await
        .unwrap();
    let roots = f
        .query("directories", json!({"kind":"roots"}))
        .await
        .unwrap();
    let request = json!({"checkpoint":{"sessionId":session,"revision":value["publication"]["state"]["head"]["revision"]},"parent":roots["roots"][1]["selection"],"permissions":{"access":"read_only","requestPermissions":true},"backend":model_backend(&f.selection().await),"acceptExternalWritersRisk":true});
    // A Goal producer can be admitted before restore takes the native runs gate,
    // yet not have written its first durable record. Its own gate must exclude restore.
    let producer = f.owner.goals.gate.lock().await;
    let result = tokio::time::timeout(
        Duration::from_secs(10),
        f.mutation(
            2,
            "restoreSessionCheckpoint",
            request.clone(),
            Uuid::new_v4(),
        ),
    )
    .await
    .unwrap();
    assert!(
        result.is_err(),
        "restore passed an unfinished Goal producer: {result:?}"
    );
    assert_eq!(
        f.owner
            .session(&session)
            .await
            .unwrap()
            .configuration
            .workspace
            .path,
        f.workspace.to_str().unwrap()
    );
    drop(producer);
    f.mutation(2, "restoreSessionCheckpoint", request, Uuid::new_v4())
        .await
        .unwrap();
    close(&f).await;
}
