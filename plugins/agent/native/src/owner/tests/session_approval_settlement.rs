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
    resume_permission, set_policy, start,
};
use super::*;
use maka_agent_facts::interaction::{
    ClosureReason, Decision, InteractionOutcome, InteractionRecord, PermissionDecision,
};
use maka_event_log::sessions::SessionMutation;
use maka_sandbox::{
    Network,
    filesystem::{Access, Rule},
    grant,
};

struct InteractionBytes {
    session: String,
    request: String,
}
impl maka_event_log::connection::Query for InteractionBytes {
    type Output = (String, String);
    fn execute(
        self,
        connection: &rusqlite::Connection,
    ) -> Result<Self::Output, maka_event_log::StoreError> {
        Ok(connection.query_row(
            "SELECT r.record_json,o.outcome_json FROM agent_interaction_requests r JOIN agent_interaction_outcomes o ON o.request=r.request AND o.session=r.session WHERE r.session=?1 AND r.request=?2",
            rusqlite::params![self.session, self.request], |row| Ok((row.get(0)?, row.get(1)?)),
        )?)
    }
}
async fn interaction_bytes(f: &Fixture, record: &InteractionRecord) -> (String, String) {
    f.store
        .data_writer()
        .unwrap()
        .query(InteractionBytes {
            session: record.execution.session_id.clone(),
            request: record.request_id.clone(),
        })
        .await
        .unwrap()
}

async fn propose(
    f: &Fixture,
    parent: &str,
    child: &str,
    socket: &mut TcpStream,
    child_socket: &mut TcpStream,
) -> (
    InteractionRecord,
    InteractionRecord,
    tokio::sync::oneshot::Sender<()>,
) {
    let permissions = grant::Permissions {
        filesystem: vec![Rule::exact(f.workspace.join("result"), Access::Write)],
        network: Network::Denied,
    };
    let (record, release) =
        establish_permissions(f, child, "child_write", permissions.clone(), child_socket).await;
    service_tools::named_tool_response(
        socket,
        "SessionRespond",
        respond_input(&record, &allow(permissions)),
    )
    .await;
    let escalation = pending_escalation(f, parent).await;
    (record, escalation, release)
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
async fn committed_human_deny_survives_busy_boundary_edit_and_post_drain_revocation() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = fixture(&listener).await;
        let parent = f.create("Parent").await;
        set_policy(&f, &parent, "read_only", true).await;
        let mut parent_socket = start(&f, &listener, &parent).await;
        let child = create_child(&listener, &mut parent_socket, &parent, "Child").await;
        let child = child["id"].as_str().unwrap().to_owned();
        let mut child_socket = start(&f, &listener, &child).await;
        let (record, escalation, release) =
            propose(&f, &parent, &child, &mut parent_socket, &mut child_socket).await;
        let interactions = f.owner.durable.interactions();

        // Fence settlement while the human decision becomes durable. A live Run
        // must reject a boundary edit rather than invalidate that original decision.
        let gate = f.owner.runs.lock().await;
        let denied = InteractionOutcome::SessionApprovalDecision {
            decision: Decision::Deny,
            committed_at: now(),
        };
        let human = interactions
            .commit_outcome(&parent, &escalation.request_id, denied.clone())
            .await
            .unwrap();
        assert_eq!(human.outcome, Some(denied));
        let before = f
            .owner
            .store
            .get_session::<StoredSessionConfiguration>(&parent)
            .await
            .unwrap()
            .unwrap();
        let active_edit = f
            .owner
            .store
            .update_session_metadata::<StoredSessionConfiguration, _>(
                &parent,
                before.revision,
                |configuration| {
                    configuration.boundary_revision += 1;
                    configuration.permissions.request_permissions = false;
                    Ok(())
                },
            )
            .await;
        assert!(matches!(
            active_edit,
            Err(maka_event_log::StoreError::SessionBusy)
        ));
        let unchanged = f
            .store
            .get_session::<StoredSessionConfiguration>(&parent)
            .await
            .unwrap()
            .unwrap();
        assert!(
            unchanged == before,
            "rejected active edit must leave the whole Session unchanged"
        );
        drop(gate);

        let (mut resumed, returned) = resumed_response(&listener).await;
        assert_eq!(returned["kind"], "recorded", "{returned}");
        assert_eq!(
            returned["record"]["outcome"]["decision"],
            json!({"decision":"deny"})
        );
        let completed = interactions
            .read(&child, &record.request_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            returned["record"],
            serde_json::to_value(&completed).unwrap()
        );
        let parent_run = f.live_access(&parent).await.execution().run_id;
        let view = f.owner.durable.frontier(parent_run).await.unwrap();
        let key = &view
            .tools
            .values()
            .find(|tool| {
                tool.call.name == "SessionRespond"
                    && tool
                        .call
                        .input
                        .as_json()
                        .is_some_and(|input| input["requestId"] == record.request_id)
            })
            .expect("original model-produced parent response tool")
            .key;
        let facts = f.recorded_facts(&parent).await;
        assert_eq!(
            facts
                .iter()
                .filter(|entry| entry.run == parent_run
                    && matches!(&entry.fact,
            maka_agent_facts::durable::Fact::ToolAdmitted { tool } if tool == key))
                .count(),
            1
        );
        assert_eq!(
            facts
                .iter()
                .filter(|entry| entry.run == parent_run
                    && matches!(&entry.fact,
            maka_agent_facts::durable::Fact::HostToolResultRecorded { tool, .. }
                | maka_agent_facts::durable::Fact::LocalToolReturned { tool, .. } if tool == key))
                .count(),
            1
        );
        assert!(matches!(
            completed.outcome,
            Some(InteractionOutcome::PermissionsDecision {
                decision: PermissionDecision::Deny,
                ..
            })
        ));
        let (basis, target) = match &record.request {
            maka_agent_facts::interaction::InteractionRequest::Permissions {
                basis,
                target,
                ..
            } => (basis, target),
            _ => unreachable!(),
        };
        let access = f.live_access(&child).await;
        assert_eq!(access.execution(), &record.execution);
        assert!(
            interactions
                .permission_grants(access.execution(), Some(target), basis)
                .await
                .unwrap()
                .is_empty()
        );
        drop(access);
        let recovered_human = interactions
            .read(&parent, &escalation.request_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(recovered_human, human);
        assert!(matches!(
            human.outcome,
            Some(InteractionOutcome::SessionApprovalDecision {
                decision: Decision::Deny,
                ..
            })
        ));
        let human_bytes = interaction_bytes(&f, &human).await;
        let child_bytes = interaction_bytes(&f, &completed).await;
        resume_permission(&listener, &mut child_socket, release).await;
        assert_eq!(
            f.query("observe", json!({"sessionId":child}))
                .await
                .unwrap()["session"]["activity"],
            "working"
        );
        response(&mut resumed).await;
        response(&mut child_socket).await;
        f.drained().await;
        assert_eq!(
            f.query("observe", json!({"sessionId":child}))
                .await
                .unwrap()["session"]["activity"],
            "idle"
        );
        for session in [&parent, &child] {
            assert!(
                f.owner
                    .durable
                    .session_quiescence(f.owner.run_owner(), session.clone())
                    .await
                    .unwrap()
                    .is_quiescent()
            );
        }
        let after = f
            .store
            .get_session::<StoredSessionConfiguration>(&parent)
            .await
            .unwrap()
            .unwrap();
        let changed = f
            .store
            .update_session_metadata::<StoredSessionConfiguration, _>(
                &parent,
                after.revision,
                |configuration| {
                    configuration.boundary_revision += 1;
                    configuration.permissions.request_permissions = false;
                    Ok(())
                },
            )
            .await
            .unwrap();
        assert!(matches!(changed, SessionMutation::Committed(_)));
        let edited = f
            .store
            .get_session::<StoredSessionConfiguration>(&parent)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            edited.configuration.boundary_revision,
            before.configuration.boundary_revision + 1
        );
        assert!(!edited.configuration.permissions.request_permissions);
        assert_eq!(
            interactions
                .read(&parent, &escalation.request_id)
                .await
                .unwrap()
                .unwrap(),
            human
        );
        assert_eq!(
            interactions
                .read(&child, &record.request_id)
                .await
                .unwrap()
                .unwrap(),
            completed
        );
        assert_eq!(interaction_bytes(&f, &human).await, human_bytes);
        assert_eq!(interaction_bytes(&f, &completed).await, child_bytes);
        assert!(
            interactions
                .permission_grants(&record.execution, Some(target), basis)
                .await
                .unwrap()
                .is_empty()
        );
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
        let (record, escalation, release) =
            propose(&f, &parent, &child, &mut parent_socket, &mut child_socket).await;
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
        let interactions = f.owner.durable.interactions();
        let closed = interactions
            .read(&parent, &escalation.request_id)
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
            !interactions
                .pending(&parent)
                .await
                .unwrap()
                .records
                .iter()
                .any(|record| record.request_id == escalation.request_id)
        );
        resume_permission(&listener, &mut child_socket, release).await;
        assert_eq!(
            f.query("observe", json!({"sessionId":child}))
                .await
                .unwrap()["session"]["activity"],
            "working"
        );
        response(&mut resumed).await;
        response(&mut child_socket).await;
        f.drained().await;
        assert_eq!(
            f.query("observe", json!({"sessionId":child}))
                .await
                .unwrap()["session"]["activity"],
            "idle"
        );
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .expect("child-settled approval withdrawal timed out");
}
