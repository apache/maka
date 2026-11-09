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

fn workspace(mut input: Value, consistency: &str) -> Value {
    input["workspaceConsistency"] = json!(consistency);
    input
}

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
        .mutate_owned(prepared, json!({ "reference": &reference }))
        .await
        .unwrap()
        .result()
        .await
        .receipt;
    let Receipt::Recorded {
        outcome:
            OperationOutcome::Returned {
                result: OperationResult::Success { value },
            },
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
        let original = workspace(input(&f,&session,Value::Null).await, "unverified");
        let (publication_ref,value) = mutate(&f,"publishCheckpoint",original.clone(),Uuid::new_v4()).await;
        assert_eq!(value["workspace"]["warning"],"external_writers_not_fenced");
        assert_eq!(value["workspace"]["consistency"],"unverified");
        let head = value["state"]["head"].clone();
        std::fs::write(f.workspace.join("answer.txt"), "source modified later").unwrap();

        let restore_input = json!({"checkpoint":{"sessionId":session,"revision":head["revision"]},
            "parent":f.workspace,"permissions":{"access":"workspace_write","requestPermissions":true},
            "backend":model_backend(&f.selection().await),"acceptExternalWritersRisk":true});
        let observed = f.query("observe", json!({"sessionId":session})).await.unwrap();
        let marked = f.mutation(2,"markRead",json!({"sessionId":session,"messageId":observed["session"]["tailMessageId"]}),Uuid::new_v4()).await.unwrap();
        assert_eq!(marked["kind"],"observed");
        let current = f.query("observe", json!({"sessionId":session})).await.unwrap();
        let changed = f.mutation(2,"metadata",json!({"sessionId":session,"expectedRevision":current["session"]["revision"],"title":"Renamed after checkpoint","labels":[],"pinned":true}),Uuid::new_v4()).await.unwrap();
        assert_eq!(changed["kind"],"committed");
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
        let repeated = f.mutation(2,"restoreSessionCheckpoint",restore_input.clone(),Uuid::new_v4()).await.unwrap();
        assert_ne!(repeated["path"], result["path"]);
        assert_eq!(repeated["head"], head);
        turn(&f,&listener,&session,"continued after workspace restore").await;
        let history=f.query("history",json!({"sessionId":session,"position":{"kind":"tail"}})).await.unwrap().to_string();
        assert!(history.contains("checkpoint history") && history.contains("continued after workspace restore"));
        let next = f.mutation(2,"publishCheckpoint",workspace(input(&f,&session,head["revision"].clone()).await, "caller_confirmed_quiescent"),Uuid::new_v4()).await.unwrap();
        assert_eq!(next["state"]["kind"],"published", "{next}");
        assert_ne!(next["state"]["head"]["revision"], head["revision"]);
        assert_eq!(f.query("historyCheckpointHead",json!({"sessionId":session})).await.unwrap(),next["state"]["head"]);
        assert!(f.mutation(2,"restoreSessionCheckpoint",restore_input.clone(),Uuid::new_v4()).await.is_err());
        assert_eq!(f.query("checkpointReceipt",json!({"reference":publication_ref,"input":original})).await.unwrap()["publication"],value);
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
            "publishCheckpoint",
            json!({"history":history}),
            Uuid::new_v4()
        )
        .await
        .is_err()
    );
    let value = f
        .mutation(
            2,
            "publishCheckpoint",
            workspace(history, "caller_confirmed_quiescent"),
            Uuid::new_v4(),
        )
        .await
        .unwrap();
    turn(&f, &listener, &session, "newer history").await;
    let request = json!({"checkpoint":{"sessionId":session,"revision":value["state"]["head"]["revision"]},"parent":f.workspace,"permissions":{"access":"read_only","requestPermissions":true},"backend":model_backend(&f.selection().await),"acceptExternalWritersRisk":true});
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
            "publishCheckpoint",
            workspace(input(&f, &session, Value::Null).await, "unverified"),
            Uuid::new_v4(),
        )
        .await
        .unwrap();
    let request = json!({"checkpoint":{"sessionId":session,"revision":value["state"]["head"]["revision"]},"parent":f.workspace,"permissions":{"access":"read_only","requestPermissions":true},"backend":model_backend(&f.selection().await),"acceptExternalWritersRisk":true});
    // A Goal producer can be admitted before restore takes the native runs gate,
    // yet not have written its first durable record. Its own gate must exclude restore.
    let producer = f.owner.goals.admissions.ordered(&session).await;
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

#[tokio::test]
async fn checkpoint_admission_excludes_shared_workspaces_without_stalling_other_sessions() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let f = Fixture::new(
        &format!("http://{}/v1", listener.local_addr().unwrap()),
        None,
    )
    .await;
    let a = f.create("Checkpoint A").await;
    let shared = f.create("Shared workspace").await;
    let roots = f
        .query("directories", json!({"kind":"roots"}))
        .await
        .unwrap();
    let b = f.mutation(2,"create",json!({"title":"Unrelated B","labels":[],"workspace":{"kind":"directory","path":roots["roots"][1]["path"]}}),Uuid::new_v4()).await.unwrap()["session"]["id"].as_str().unwrap().to_owned();
    let shared_configuration = f.owner.session(&shared).await.unwrap().configuration;
    let shared_producer = f
        .owner
        .current_work_scope(&shared, &shared_configuration)
        .await
        .unwrap();
    assert!(f.owner.checkpoint_admission(&a, true).await.is_err());
    drop(shared_producer);
    let producer_b = f.owner.goals.admissions.ordered(&b).await;
    let (admission, _) = f.owner.checkpoint_admission(&a, true).await.unwrap();
    // Read-only session/history observation remains available while mutations are excluded.
    assert!(f.query("observe", json!({"sessionId":a})).await.is_ok());
    assert!(
        f.query("observe", json!({"sessionId":shared}))
            .await
            .is_ok()
    );
    assert!(
        f.query(
            "history",
            json!({"sessionId":shared,"position":{"kind":"tail"}}),
        )
        .await
        .is_ok()
    );
    assert!(f.send(&shared).await.is_err());
    assert_eq!(
        f.mutation(
            2,
            "metadata",
            json!({"sessionId":a,"expectedRevision":1,"title":"Busy","labels":[]}),
            Uuid::new_v4(),
        )
        .await
        .unwrap()["reason"],
        "busy"
    );
    assert!(f.owner.checkpoint_admission(&shared, true).await.is_err());
    drop(producer_b);
    let (other_checkpoint, _) = f.owner.checkpoint_admission(&b, true).await.unwrap();
    drop(other_checkpoint);
    tokio::time::timeout(
        Duration::from_secs(30),
        turn(&f, &listener, &b, "B progresses during A checkpoint"),
    )
    .await
    .unwrap();
    let current = f.query("observe", json!({"sessionId":b})).await.unwrap();
    let changed = f.mutation(2,"metadata",json!({"sessionId":b,"expectedRevision":current["session"]["revision"],"title":"B still writable","labels":[]}),Uuid::new_v4()).await.unwrap();
    assert_eq!(changed["kind"], "committed");
    drop(admission);
    assert!(f.owner.mutable_session(&shared).await.is_ok());
    // An admitted run in a distinct directory must not block A's capture.
    f.send(&b).await.unwrap();
    let (stream, _) = tokio::time::timeout(Duration::from_secs(15), listener.accept())
        .await
        .unwrap()
        .unwrap();
    let result = f
        .mutation(
            2,
            "publishCheckpoint",
            workspace(input(&f, &a, Value::Null).await, "unverified"),
            Uuid::new_v4(),
        )
        .await
        .unwrap();
    assert_eq!(result["state"]["kind"], "published");
    drop(stream);
    close(&f).await;
}

#[tokio::test]
async fn active_goal_defers_during_shared_checkpoint_and_restore_enforces_tilde_and_target_parent_fencing()
 {
    tokio::time::timeout(Duration::from_secs(90), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = Fixture::configured_with_temp_home(
            &format!("http://{}/v1", listener.local_addr().unwrap()),
            |settings| {
                settings.goals = true;
                settings.tool_discovery = true;
            },
        )
        .await;
        let a = f.create("Checkpoint A").await;
        let shared = f.create("Shared goal session").await;
        let roots = f
            .query("directories", json!({"kind":"roots"}))
            .await
            .unwrap();
        let b = f
            .mutation(
                2,
                "create",
                json!({"title":"Target parent B","labels":[],"workspace":{"kind":"directory","path":roots["roots"][1]["path"]}}),
                Uuid::new_v4(),
            )
            .await
            .unwrap()["session"]["id"]
            .as_str()
            .unwrap()
            .to_owned();

        // Arm a Goal on `shared` (start=false), hold checkpoint admission on `a`, then start `shared`'s Goal
        // — wait: starting while `a` holds admission must reject `changeGoal` on `shared` as busy,
        // and if `shared`'s Goal is already active while `shared`'s turn finishes into `a`'s checkpoint,
        // the Goal tick must defer cleanly (never marking `authorityBlocked`) and resume once `a` releases!
        f.send(&shared).await.unwrap();
        let (mut shared_turn, _) = listener.accept().await.unwrap();
        request(&mut shared_turn).await;
        let shared_cfg = f.owner.session(&shared).await.unwrap().configuration;
        let goal_approval = json!({
            "target":{
                "sessionId":shared,
                "workspace":shared_cfg.workspace,
                "permissions":shared_cfg.permissions,
                "boundaryRevision":shared_cfg.boundary_revision,
                "binding":shared_cfg.binding
            },
            "model":f.selection().await,
            "thinkingLevel":null
        });
        let created_goal = f
            .mutation(
                2,
                "changeGoal",
                json!({"kind":"create","sessionId":shared,"objective":"Finish after checkpoint","start":true,"tokenBudget":null,"approval":goal_approval}),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
        assert_eq!(created_goal["kind"], "committed");
        response_with_text(&mut shared_turn, "initial turn done").await;
        // Accept the Goal's first continuation turn, pause before completing, finish it, then hold `a`'s checkpoint:
        let (mut goal_turn_1, _) = tokio::time::timeout(Duration::from_secs(15), listener.accept())
            .await
            .unwrap()
            .unwrap();
        request(&mut goal_turn_1).await;
        response_with_text(&mut goal_turn_1, "working on goal step 1").await;
        // Wait for `shared` to settle idle or next goal tick; grab admission on `a` as soon as `shared` is between turns,
        // OR test holding `admission` on `a` when `Goals::execution_changed()` fires!
        let (mut goal_turn_2, _) = tokio::time::timeout(Duration::from_secs(15), listener.accept())
            .await
            .unwrap()
            .unwrap();
        request(&mut goal_turn_2).await;
        // Hold the real producer gate until the current physical work ends,
        // then acquire the actual directory fence before allowing its next tick.
        let producer=f.owner.goals.admissions.ordered(&shared).await;
        response_with_text(&mut goal_turn_2,"working on goal step 2").await;
        f.drained().await;
        let held=f.owner.checkpoint_admission(&a,true).await.unwrap().0;
        drop(producer);
        f.owner.goals.execution_changed();
        tokio::time::sleep(Duration::from_millis(120)).await;
        let during = f.query("goal", json!({"sessionId":shared})).await.unwrap()["current"].clone();
        assert_eq!(
            during["status"], "active",
            "Goal must defer instead of failing: {during}"
        );
        assert_eq!(during["note"], "");
        assert!(
            !f.owner
                .goals
                .repository
                .read(&shared)
                .await
                .unwrap()
                .unwrap()
                .goal
                .authority_blocked
        );
        drop(held);
        f.owner.goals.execution_changed();
        let (mut goal_turn_3, _) = tokio::time::timeout(Duration::from_secs(15), listener.accept())
            .await
            .unwrap()
            .unwrap();
        let sent = request(&mut goal_turn_3).await;
        let has_exec = sent["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|tool| tool["function"]["name"] == "exec");
        let (tool_name, tool_input) = if has_exec {
            (
                "exec",
                json!({"code":"text(await tools.GoalStatus({\"status\":\"achieved\",\"note\":\"done after checkpoint\"}));"}),
            )
        } else {
            (
                "GoalStatus",
                json!({"status":"achieved","note":"done after checkpoint"}),
            )
        };
        service_tools::named_tool_response(&mut goal_turn_3, tool_name, tool_input).await;
        let (mut goal_finish, _) = tokio::time::timeout(Duration::from_secs(15), listener.accept())
            .await
            .unwrap()
            .unwrap();
        request(&mut goal_finish).await;
        response_with_text(&mut goal_finish, "goal completed").await;
        f.drained().await;

        // Publish checkpoint on `a`, then verify non-Remote scope rejection, busy target `parent` rejection, and `~/` parent expansion.
        std::fs::write(f.workspace.join("tilde.txt"), "restored via tilde").unwrap();
        let published = f
            .mutation(
                2,
                "publishCheckpoint",
                workspace(input(&f, &a, Value::Null).await, "unverified"),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
        let revision = published["state"]["head"]["revision"].clone();
        let bg_scope = f
            .issuer
            .issue_with(
                Identity::Background {
                    grant: maka_capabilities::authorization::Id(Uuid::new_v4()),
                },
                true,
                CancellationToken::new(),
            )
            .unwrap();
        assert!(
            f.owner
                .preview_history_checkpoint(
                    contract::SessionRead {
                        session_id: a.clone()
                    },
                    &bg_scope,
                )
                .await
                .is_err()
        );

        let restore_tilde = json!({
            "checkpoint":{"sessionId":a,"revision":revision},
            "parent":"~/other-workspace",
            "permissions":{"access":"workspace_write","requestPermissions":true},
            "backend":model_backend(&f.selection().await),
            "acceptExternalWritersRisk":true
        });
        // Active run in `~/other-workspace` (`b`) must block restoring `a` into `~/other-workspace`.
        f.send(&b).await.unwrap();
        let (mut b_socket, _) = tokio::time::timeout(Duration::from_secs(15), listener.accept())
            .await
            .unwrap()
            .unwrap();
        assert!(
            f.mutation(2, "restoreSessionCheckpoint", restore_tilde.clone(), Uuid::new_v4())
                .await
                .is_err()
        );
        request(&mut b_socket).await;
        response_with_text(&mut b_socket, "b finished").await;
        f.drained().await;

        let restored = f
            .mutation(2, "restoreSessionCheckpoint", restore_tilde, Uuid::new_v4())
            .await
            .unwrap();
        let restored_path = std::path::PathBuf::from(restored["path"].as_str().unwrap());
        assert!(restored_path.starts_with(roots["roots"][1]["path"].as_str().unwrap()));
        assert_eq!(
            std::fs::read_to_string(restored_path.join("tilde.txt")).unwrap(),
            "restored via tilde"
        );
        close(&f).await;
    })
    .await
    .unwrap();
}
