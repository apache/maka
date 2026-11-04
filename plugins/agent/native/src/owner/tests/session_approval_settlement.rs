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

use super::session_parent_authority::{
    allow, create_child, establish_permissions, fixture, pending_escalation, respond_input,
    set_policy, start,
};
use super::*;
use maka_agent_facts::interaction::{
    ClosureReason, Decision, InteractionOutcome, InteractionRecord,
};
use maka_event_log::sessions::SessionMutation;
use maka_sandbox::{
    Network,
    filesystem::{Access, Rule},
    grant,
};

async fn propose(
    f: &Fixture,
    parent: &str,
    child: &str,
    socket: &mut TcpStream,
) -> (InteractionRecord, InteractionRecord) {
    let permissions = grant::Permissions {
        filesystem: vec![Rule::exact(f.workspace.join("result"), Access::Write)],
        network: Network::Denied,
    };
    let record = establish_permissions(f, child, "child_write", permissions.clone()).await;
    service_tools::named_tool_response(
        socket,
        "SessionRespond",
        respond_input(&record, &allow(permissions)),
    )
    .await;
    let escalation = pending_escalation(f, parent).await;
    (record, escalation)
}

async fn resumed_response(listener: &TcpListener) -> (TcpStream, Value) {
    let (mut socket, _) = listener.accept().await.unwrap();
    let sent = request(&mut socket).await;
    let returned = sent["messages"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .find(|message| message["role"] == "tool")
        .unwrap()["content"]
        .as_str()
        .unwrap();
    let returned = serde_json::from_str(returned).unwrap();
    (socket, returned)
}

#[tokio::test]
async fn committed_human_deny_survives_parent_permission_edit_before_child_settlement() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = fixture(&listener).await;
        let parent = f.create("Parent").await;
        set_policy(&f, &parent, "read_only", true).await;
        let mut parent_socket = start(&f, &listener, &parent).await;
        let child = create_child(&listener, &mut parent_socket, &parent, "Child").await;
        let child = child["id"].as_str().unwrap().to_owned();
        let mut child_socket = start(&f, &listener, &child).await;
        let (record, escalation) = propose(&f, &parent, &child, &mut parent_socket).await;
        let parent_store = f.session(&parent).await;

        // Control the exact race: commit the human receipt and edit permissions
        // while the delegated response cannot pass its final settlement gate.
        let gate = f.owner.runs.lock().await;
        let human = parent_store
            .commit_interaction_outcome(
                &escalation.request_id,
                InteractionOutcome::SessionApprovalDecision {
                    decision: Decision::Deny,
                    committed_at: now(),
                },
            )
            .await
            .unwrap();
        assert!(human.matches);
        let before = f
            .owner
            .store
            .get_session::<StoredSessionConfiguration>(&parent)
            .await
            .unwrap()
            .unwrap();
        let changed = f
            .owner
            .store
            .update_session_permissions::<StoredSessionConfiguration, _>(
                &parent,
                before.revision,
                now(),
                |configuration| {
                    configuration.boundary_revision += 1;
                    configuration.permissions.request_permissions = false;
                    Ok(())
                },
            )
            .await
            .unwrap();
        assert!(matches!(changed, SessionMutation::Committed(_)));
        drop(gate);

        let (mut resumed, returned) = resumed_response(&listener).await;
        assert_eq!(returned["kind"], "recorded", "{returned}");
        assert_eq!(
            returned["record"]["outcome"]["decision"],
            json!({"decision":"deny"})
        );
        let completed = f
            .session(&child)
            .await
            .interaction(&record.request_id)
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(
            completed.outcome,
            Some(InteractionOutcome::PermissionsDecision {
                decision: grant::Decision::Deny,
                ..
            })
        ));
        let projection = f
            .session(&child)
            .await
            .session_projection::<StoredSessionConfiguration>(&child)
            .await
            .unwrap()
            .unwrap();
        let basis = match record.request {
            maka_agent_facts::interaction::InteractionRequest::Permissions { basis, .. } => basis,
            _ => unreachable!(),
        };
        assert!(
            f.session(&child)
                .await
                .permission_grants(
                    &projection.root_turn.unwrap().invocation,
                    Some("permission_tool"),
                    &basis,
                )
                .await
                .unwrap()
                .is_empty()
        );
        let human = parent_store
            .interaction(&escalation.request_id)
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(
            human.outcome,
            Some(InteractionOutcome::SessionApprovalDecision {
                decision: Decision::Deny,
                ..
            })
        ));
        response(&mut resumed).await;
        response(&mut child_socket).await;
        f.drained().await;
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .expect("human denial settlement timed out");
}

#[tokio::test]
async fn child_settlement_withdraws_parent_approval_and_returns_original_winner() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = fixture(&listener).await;
        let parent = f.create("Parent").await;
        set_policy(&f, &parent, "read_only", true).await;
        let mut parent_socket = start(&f, &listener, &parent).await;
        let child = create_child(&listener, &mut parent_socket, &parent, "Child").await;
        let child = child["id"].as_str().unwrap().to_owned();
        let mut child_socket = start(&f, &listener, &child).await;
        let (record, escalation) = propose(&f, &parent, &child, &mut parent_socket).await;
        let winner = f
            .mutation(
                2,
                "respond",
                json!({
                    "sessionId":child, "requestId":record.request_id,
                    "answer":{"kind":"permissions","decision":{"decision":"deny"}},
                }),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
        assert_eq!(winner["kind"], "recorded", "{winner}");
        let (mut resumed, returned) = resumed_response(&listener).await;
        assert_eq!(returned, winner);
        let closed = f
            .session(&parent)
            .await
            .interaction(&escalation.request_id)
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(
            closed.outcome,
            Some(InteractionOutcome::Closure {
                reason: ClosureReason::ProducerCancelled,
                ..
            })
        ));
        assert!(
            !f.session(&parent)
                .await
                .pending_interactions(&parent)
                .await
                .unwrap()
                .iter()
                .any(|record| record.request_id == escalation.request_id)
        );
        response(&mut resumed).await;
        response(&mut child_socket).await;
        f.drained().await;
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .expect("child-settled approval withdrawal timed out");
}
