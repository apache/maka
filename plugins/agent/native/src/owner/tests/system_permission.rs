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
use crate::owner::system_permission::Platform;
use maka_agent_facts::interaction::{
    InteractionAnswer, InteractionRecord, InteractionRequest, SystemPermissionGrant,
};
use std::sync::atomic::{AtomicBool, Ordering};

struct Probe {
    supported: bool,
    request_error: Option<&'static str>,
    observation_error: Option<&'static str>,
    accessibility: AtomicBool,
    requests: StdMutex<Vec<SystemPermissionGrant>>,
}
impl Platform for Probe {
    fn supported(&self) -> bool {
        self.supported
    }
    fn missing(
        &self,
        grants: &[SystemPermissionGrant],
    ) -> Result<Vec<SystemPermissionGrant>, String> {
        if let Some(error) = self.observation_error {
            return Err(error.into());
        }
        Ok(grants
            .iter()
            .copied()
            .filter(|grant| {
                *grant == SystemPermissionGrant::Accessibility
                    && !self.accessibility.load(Ordering::SeqCst)
            })
            .collect())
    }
    fn request(
        &self,
        grant: SystemPermissionGrant,
        _cancelled: &(dyn Fn() -> bool + Sync),
    ) -> Result<(), String> {
        if let Some(error) = self.request_error {
            return Err(error.into());
        }
        self.requests.lock().unwrap().push(grant);
        self.accessibility.store(true, Ordering::SeqCst);
        Ok(())
    }
}
fn read(record: &InteractionRecord) -> InteractionRead {
    InteractionRead {
        session_id: record.session_id.clone(),
        request_id: record.request_id.clone(),
    }
}
fn ask(record: &InteractionRecord, grant: SystemPermissionGrant) -> RequestSystemPermission {
    RequestSystemPermission {
        session_id: record.session_id.clone(),
        request_id: record.request_id.clone(),
        grant,
    }
}

#[tokio::test]
async fn system_permission_observes_host_and_only_human_requests_without_settling_producer() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = Fixture::new(&format!("http://{}/v1", listener.local_addr().unwrap()), None).await;
        let session = f.create("System permissions").await;
        let started = f.send(&session).await.unwrap();
        let (mut held, _) = listener.accept().await.unwrap();
        request(&mut held).await;
        let store = f.session(&session).await;
        let invocation = store.session_projection::<StoredSessionConfiguration>(&session).await.unwrap().unwrap().root_turn.unwrap().invocation;
        let record = InteractionRecord {
            session_id: session.clone(), turn_id: invocation.turn_id.clone(), run_id: invocation.run_id.clone(),
            request_id: "system-test".into(), created_at: 1, outcome: None,
            request: InteractionRequest::SystemPermission {
                tool_use_id: "system-tool".into(), grants: vec![SystemPermissionGrant::Accessibility, SystemPermissionGrant::ScreenRecording],
                application: "Fixture Host".into(), application_location: None,
            },
        };
        store.establish_run_interaction(&invocation, &record).await.unwrap();
        let platform = Arc::new(Probe { supported: true, request_error: None, observation_error: None, accessibility: AtomicBool::new(false), requests: StdMutex::new(vec![]) });
        let status = f.owner.system_permission_status_with(read(&record), platform.clone()).await.unwrap();
        assert!(status.requestable);
        assert_eq!(serde_json::to_value(&status.grants).unwrap(), json!([
            {"grant":"accessibility","effective":false}, {"grant":"screen_recording","effective":true}
        ]));
        assert!(platform.requests.lock().unwrap().is_empty(), "observation must never prompt");
        let agent = f.issuer.issue_with(Identity::Agent { invocation: invocation.clone(), operation_id: Some("request".into()) }, true, CancellationToken::new()).unwrap();
        assert_eq!(f.owner.request_system_permission_with(ask(&record, SystemPermissionGrant::Accessibility), &agent, platform.clone()).await.err().unwrap(), "agent_system_permission_human_action_required");
        assert!(platform.requests.lock().unwrap().is_empty());
        let human = scope(&f.issuer, true);
        let unreadable = Arc::new(Probe {
            supported: true,
            request_error: None,
            observation_error: Some("fresh status transport failed"),
            accessibility: AtomicBool::new(false),
            requests: StdMutex::new(vec![]),
        });
        assert_eq!(f.owner.system_permission_status_with(read(&record), unreadable.clone()).await.err().unwrap(), "fresh status transport failed");
        assert_eq!(f.owner.request_system_permission_with(ask(&record, SystemPermissionGrant::Accessibility), &human, unreadable.clone()).await.err().unwrap(), "fresh status transport failed");
        assert!(unreadable.requests.lock().unwrap().is_empty(), "failed observation must not issue a request");
        assert!(store.interaction(&record.request_id).await.unwrap().unwrap().outcome.is_none(), "failed observation must not settle the producer");

        let invalid_identity = Arc::new(Probe {
            supported: true,
            request_error: Some("LaunchServices cannot resolve application test.identity"), observation_error: None,
            accessibility: AtomicBool::new(false),
            requests: StdMutex::new(vec![]),
        });
        let error = f.owner.request_system_permission_with(ask(&record, SystemPermissionGrant::Accessibility), &human, invalid_identity.clone()).await.err().unwrap();
        assert_eq!(error, "LaunchServices cannot resolve application test.identity");
        assert!(invalid_identity.requests.lock().unwrap().is_empty());
        let unchanged = f.owner.system_permission_status_with(read(&record), invalid_identity).await.unwrap();
        assert!(unchanged.record.outcome.is_none());
        assert!(!unchanged.grants[0].effective);
        assert!(unchanged.requestable, "an identity error is not unsupported or a changed session permission policy");
        let status = f.owner.request_system_permission_with(ask(&record, SystemPermissionGrant::Accessibility), &human, platform.clone()).await.unwrap();
        assert!(status.grants.iter().all(|grant| grant.effective));
        assert!(status.record.outcome.is_none(), "only the original producer may complete its request");
        assert_eq!(*platform.requests.lock().unwrap(), vec![SystemPermissionGrant::Accessibility]);
        f.owner.request_system_permission_with(ask(&record, SystemPermissionGrant::Accessibility), &human, platform.clone()).await.unwrap();
        assert_eq!(platform.requests.lock().unwrap().len(), 1, "already effective grants do not prompt");
        let canceled = store.commit_interaction_outcome(&record.request_id, InteractionAnswer::SystemPermissionCancel {}.into_outcome(2)).await.unwrap().record;
        let status = f.owner.system_permission_status_with(read(&record), platform.clone()).await.unwrap();
        assert!(!status.requestable);
        assert_eq!(status.record, canceled);
        assert_eq!(f.owner.request_system_permission_with(ask(&record, SystemPermissionGrant::Accessibility), &human, platform.clone()).await.err().unwrap(), "agent_system_permission_not_requestable");
        // The public mutation also returns its original receipt on a repeated observation.
        let operation = Uuid::new_v4();
        let input = json!({"sessionId":session,"requestId":record.request_id,"grant":"accessibility"});
        let first = f.mutation(2, "requestSystemPermission", input.clone(), operation).await;
        assert_eq!(f.mutation(2, "requestSystemPermission", input, operation).await, first);
        f.mutation(2, "stop", json!({"sessionId":session,"invocationId":started["invocationId"]}), Uuid::new_v4()).await.unwrap();
        f.drained().await;
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn system_permission_rejects_unsupported_host_foreign_request_and_unrequested_grant() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = Fixture::new(
            &format!("http://{}/v1", listener.local_addr().unwrap()),
            None,
        )
        .await;
        let session = f.create("Unsupported permission host").await;
        let other = f.create("Foreign request owner").await;
        session_parent_authority::set_policy(&f, &session, "workspace_write", false).await;
        let started = f.send(&session).await.unwrap();
        let (mut held, _) = listener.accept().await.unwrap();
        request(&mut held).await;
        let store = f.session(&session).await;
        let invocation = store
            .session_projection::<StoredSessionConfiguration>(&session)
            .await
            .unwrap()
            .unwrap()
            .root_turn
            .unwrap()
            .invocation;
        let record = InteractionRecord {
            session_id: session.clone(),
            turn_id: invocation.turn_id.clone(),
            run_id: invocation.run_id.clone(),
            request_id: "unsupported-system-test".into(),
            created_at: 1,
            outcome: None,
            request: InteractionRequest::SystemPermission {
                tool_use_id: "system-tool".into(),
                grants: vec![SystemPermissionGrant::ScreenRecording],
                application: "Fixture Host".into(),
                application_location: None,
            },
        };
        store
            .establish_run_interaction(&invocation, &record)
            .await
            .unwrap();
        let platform = Arc::new(Probe {
            supported: false,
            request_error: None,
            observation_error: None,
            accessibility: AtomicBool::new(true),
            requests: StdMutex::new(vec![]),
        });
        let status = f
            .owner
            .system_permission_status_with(read(&record), platform.clone())
            .await
            .unwrap();
        assert!(!status.requestable);
        assert!(
            !status.grants[0].effective,
            "unsupported Host cannot report effective grants from an empty missing list"
        );
        let human = scope(&f.issuer, true);
        assert_eq!(
            f.owner
                .request_system_permission_with(
                    ask(&record, SystemPermissionGrant::ScreenRecording),
                    &human,
                    platform.clone()
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
                    platform.clone()
                )
                .await
                .err()
                .unwrap(),
            "agent_system_permission_grant_not_requested"
        );
        assert!(
            f.owner
                .system_permission_status_with(
                    InteractionRead {
                        session_id: other.clone(),
                        request_id: record.request_id.clone()
                    },
                    platform.clone()
                )
                .await
                .is_err()
        );
        assert!(
            f.query(
                "systemPermissionStatus",
                json!({"sessionId":other,"requestId":record.request_id})
            )
            .await
            .is_err()
        );
        assert!(platform.requests.lock().unwrap().is_empty());
        let supported = Arc::new(Probe {
            supported: true,
            request_error: None,
            observation_error: None,
            accessibility: AtomicBool::new(false),
            requests: StdMutex::new(vec![]),
        });
        let status = f
            .owner
            .system_permission_status_with(read(&record), supported.clone())
            .await
            .unwrap();
        assert!(
            !status.requestable,
            "a live Run with permission requests disabled cannot prompt"
        );
        assert_eq!(
            f.owner
                .request_system_permission_with(
                    ask(&record, SystemPermissionGrant::ScreenRecording),
                    &human,
                    supported.clone()
                )
                .await
                .err()
                .unwrap(),
            "agent_system_permission_not_requestable"
        );
        assert!(supported.requests.lock().unwrap().is_empty());
        f.mutation(
            2,
            "stop",
            json!({"sessionId":session,"invocationId":started["invocationId"]}),
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
