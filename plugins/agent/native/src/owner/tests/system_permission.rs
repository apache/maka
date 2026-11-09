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
use crate::contract::SystemPermissionOutcome;
use maka_agent_facts::interaction::{
    ClosureReason, InteractionAnswer, InteractionRecord, InteractionRequest, SystemPermissionGrant,
};
use maka_agent_ports::execution::Interactions as _;

fn read(record: &InteractionRecord) -> InteractionRead {
    InteractionRead {
        session_id: record.execution.session_id.clone(),
        request_id: record.request_id.clone(),
    }
}
fn ask(record: &InteractionRecord, grant: SystemPermissionGrant) -> RequestSystemPermission {
    RequestSystemPermission {
        session_id: record.execution.session_id.clone(),
        request_id: record.request_id.clone(),
        grant,
    }
}
fn missing_accessibility(
    grants: &[SystemPermissionGrant],
) -> Result<Vec<SystemPermissionGrant>, String> {
    Ok(grants
        .iter()
        .copied()
        .filter(|grant| *grant == SystemPermissionGrant::Accessibility)
        .collect())
}
fn effective(_: &[SystemPermissionGrant]) -> Result<Vec<SystemPermissionGrant>, String> {
    Ok(vec![])
}
fn unreadable(_: &[SystemPermissionGrant]) -> Result<Vec<SystemPermissionGrant>, String> {
    Err("fresh status transport failed".into())
}
fn request_error(_: &[SystemPermissionGrant], _: &(dyn Fn() -> bool + Sync)) -> Result<(), String> {
    Err("LaunchServices cannot resolve application test.identity".into())
}
fn unexpected_request(
    _: &[SystemPermissionGrant],
    _: &(dyn Fn() -> bool + Sync),
) -> Result<(), String> {
    panic!("this boundary must not invoke an OS request")
}
async fn pending(
    f: &Fixture,
    session: &str,
    grants: Vec<SystemPermissionGrant>,
) -> InteractionRecord {
    let access = f.live_access(session).await;
    let record = InteractionRecord {
        execution: access.execution().clone(),
        request_id: "system-test".into(),
        created_at: 1,
        outcome: None,
        request: InteractionRequest::SystemPermission {
            tool_use_id: "system-tool".into(),
            grants,
            application: "Fixture Host".into(),
            application_location: None,
        },
    };
    assert_eq!(access.establish(&record).await.unwrap(), record);
    record
}

#[tokio::test]
async fn system_permission_preserves_producer_outcomes_and_native_errors() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = Fixture::new(&format!("http://{}/v1", listener.local_addr().unwrap()), None).await;
        let session = f.create("System permissions").await;
        let queued = f.send(&session).await.unwrap();
        let run = f.delivered_run(&queued).await;
        let (mut held, _) = listener.accept().await.unwrap();
        request(&mut held).await;
        let record = pending(&f, &session, vec![SystemPermissionGrant::Accessibility, SystemPermissionGrant::ScreenRecording]).await;
        let store = f.owner.durable.interactions();
        let human = scope(&f.issuer, true);
        let status = f.owner.system_permission_status_with(read(&record), true, missing_accessibility).await.unwrap();
        assert!(status.requestable);
        assert_eq!(serde_json::to_value(&status.grants).unwrap(), json!([
            {"grant":"accessibility","effective":false}, {"grant":"screen_recording","effective":true}
        ]));
        let status = f.owner.request_system_permission_with(ask(&record, SystemPermissionGrant::Accessibility), &human, true, effective, unexpected_request).await.unwrap();
        assert!(status.grants.iter().all(|grant| grant.effective));
        assert!(status.outcome.is_none(), "effective checks do not settle the original producer");
        assert_eq!(f.owner.system_permission_status_with(read(&record), true, unreadable).await.err().unwrap(), "fresh status transport failed");
        assert_eq!(f.owner.request_system_permission_with(ask(&record, SystemPermissionGrant::Accessibility), &human, true, unreadable, unexpected_request).await.err().unwrap(), "fresh status transport failed");
        assert_eq!(f.owner.request_system_permission_with(ask(&record, SystemPermissionGrant::Accessibility), &human, true, missing_accessibility, request_error).await.err().unwrap(), "LaunchServices cannot resolve application test.identity");
        assert!(store.read(&session, &record.request_id).await.unwrap().unwrap().outcome.is_none());
        store.commit_outcome(&session, &record.request_id, InteractionAnswer::SystemPermissionCancel {}.into_outcome(2)).await.unwrap();
        let status = f.owner.system_permission_status_with(read(&record), true, effective).await.unwrap();
        assert_eq!(status.outcome, Some(SystemPermissionOutcome::Closure { reason: ClosureReason::ProducerCancelled, committed_at: 2 }));
        assert!(!status.requestable);
        assert_eq!(f.owner.request_system_permission_with(ask(&record, SystemPermissionGrant::Accessibility), &human, true, effective, unexpected_request).await.err().unwrap(), "agent_system_permission_not_requestable");
        let operation = Uuid::new_v4();
        let input = json!({"sessionId":session,"requestId":record.request_id,"grant":"accessibility"});
        let first = f.mutation(2, "requestSystemPermission", input.clone(), operation).await;
        assert_eq!(f.mutation(2, "requestSystemPermission", input, operation).await, first);
        f.mutation(2, "stop", json!({"sessionId":session,"runId":run}), Uuid::new_v4()).await.unwrap();
        f.drained().await;
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn system_permission_requires_human_access_and_a_live_requestable_grant() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = Fixture::new(
            &format!("http://{}/v1", listener.local_addr().unwrap()),
            None,
        )
        .await;
        let session = f.create("Permission boundaries").await;
        let other = f.create("Foreign request owner").await;
        session_parent_authority::set_policy(&f, &session, "workspace_write", false).await;
        let queued = f.send(&session).await.unwrap();
        let run = f.delivered_run(&queued).await;
        let (mut held, _) = listener.accept().await.unwrap();
        request(&mut held).await;
        let record = pending(&f, &session, vec![SystemPermissionGrant::ScreenRecording]).await;
        let access = f.live_access(&session).await;
        let mut agent = f
            .issuer
            .issue_with_work(
                Identity::Agent {
                    execution: access.execution().clone(),
                    operation_id: None,
                },
                true,
                f.owner.stop.child_token(),
                access.custody().clone(),
            )
            .unwrap();
        agent
            .restrict_sandbox(&access.spec().permission_ceiling.sandbox)
            .unwrap();
        drop(access);
        assert_eq!(
            f.owner
                .request_system_permission_with(
                    ask(&record, SystemPermissionGrant::ScreenRecording),
                    &agent,
                    true,
                    effective,
                    unexpected_request
                )
                .await
                .err()
                .unwrap(),
            "agent_system_permission_human_action_required"
        );
        drop(agent);
        let human = scope(&f.issuer, true);
        let status = f
            .owner
            .system_permission_status_with(read(&record), false, unreadable)
            .await
            .unwrap();
        assert!(!status.requestable);
        assert!(
            !status.grants[0].effective,
            "unsupported does not mean granted"
        );
        assert_eq!(
            f.owner
                .request_system_permission_with(
                    ask(&record, SystemPermissionGrant::ScreenRecording),
                    &human,
                    false,
                    effective,
                    unexpected_request
                )
                .await
                .err()
                .unwrap(),
            "agent_system_permission_not_requestable"
        );
        assert_eq!(
            f.owner
                .request_system_permission_with(
                    ask(&record, SystemPermissionGrant::Accessibility),
                    &human,
                    true,
                    effective,
                    unexpected_request
                )
                .await
                .err()
                .unwrap(),
            "agent_system_permission_grant_not_requested"
        );
        assert!(
            f.query(
                "systemPermissionStatus",
                json!({"sessionId":other,"requestId":record.request_id})
            )
            .await
            .is_err()
        );
        assert!(
            !f.owner
                .system_permission_status_with(read(&record), true, effective)
                .await
                .unwrap()
                .requestable
        );
        assert_eq!(
            f.owner
                .request_system_permission_with(
                    ask(&record, SystemPermissionGrant::ScreenRecording),
                    &human,
                    true,
                    effective,
                    unexpected_request
                )
                .await
                .err()
                .unwrap(),
            "agent_system_permission_not_requestable"
        );
        f.mutation(
            2,
            "stop",
            json!({"sessionId":session,"runId":run}),
            Uuid::new_v4(),
        )
        .await
        .unwrap();
        f.drained().await;
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}
