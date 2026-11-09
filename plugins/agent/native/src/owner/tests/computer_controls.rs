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

use super::service_tools::{Behavior, Counter, Setup};
use super::*;
use maka_agent_facts::durable::{AuthorizationObligation, FactId, UnixMillis};
use maka_agent_facts::interaction::{
    ComputerAppDecision, ComputerAppDisplay, ComputerAppPlatform, Decision, GrantScope,
    InteractionOutcome, InteractionRecord, InteractionRequest,
};
use maka_agent_state::{ContentBlob, Head, computer};

async fn next_apps(watch: &mut maka_host_runtime::application::Subscription) -> Value {
    loop {
        let update = watch.recv().await.expect("computer app stream closed");
        if update["kind"] == "computer_apps" {
            return update["apps"].clone();
        }
    }
}

#[tokio::test]
async fn app_stop_is_user_only_and_streams_settled_activity_without_native_input() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let counter = Counter::new(Behavior::Held);
        let fixture = Fixture::with_services(
            &format!("http://{}/v1", listener.local_addr().unwrap()),
            None,
            None,
            Some(Setup::native(counter.clone(), true)),
        )
        .await;
        let session = fixture.create("User app Stop controls").await;
        let mut watch = fixture
            .app
            .client()
            .subscribe(
                fixture.binding(2).await,
                "watch".into(),
                json!({"sessionId":session,"after":0}),
                scope(&fixture.issuer, true),
                Attachments::new().into(),
            )
            .await
            .unwrap();
        assert_eq!(next_apps(&mut watch).await, json!({"entries":[]}));
        fixture.send(&session).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        service_tools::named_tool_response(&mut socket, "Counter", json!({"amount":1})).await;
        counter.entered.acquire().await.unwrap().forget();
        let access = fixture.live_access(&session).await;
        let execution = access.execution().clone();
        let view = access.fresh().await.unwrap();
        let tool = view
            .tools
            .values()
            .find(|tool| tool.call.name == "Counter")
            .unwrap()
            .clone();
        assert!(tool.admitted && tool.accepted.is_none());
        let original = tool
            .original
            .clone()
            .expect("actual Host bind precedes handler entry");
        let native_operation = original.operation.to_string();
        let tool_use_id = maka_agent_facts::tool_call::tool_use_id(
            execution.run_id,
            &maka_agent_state::fold::tool_key(&tool.key),
        );
        let basis = view.spec.permission_basis;
        let data = access.data_writer().unwrap();
        let apps = computer::ComputerStore::new(data.clone());
        let interactions = maka_agent_state::interactions::InteractionsStore::new(data.clone());
        let at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        let broad = maka_workspace_api::computer::target();
        let mut app = broad.clone();
        app.scope = GrantScope::ComputerApp {
            platform: ComputerAppPlatform::Macos,
            application_id: "org.example.StopFixture".into(),
        };
        let display = ComputerAppDisplay {
            name: "Trusted Stop fixture".into(),
            app_path: "/Stop Fixture.app".into(),
            risk: None,
            warning: None,
        };
        let activity = maka_agent_facts::interaction::ComputerAppActivity {
            execution: execution.clone(),
            operation_id: native_operation.clone(),
            target: app.clone(),
            display: display.clone(),
        };
        // A metadata-only adapter fixture uses the real Host source; it dispatches no native input.
        let capture = ContentBlob::json(
            &json!({"adapter":"trusted-stop-fixture","nativeInput":false,"original":original}),
        )
        .unwrap();
        apps.append(
            access.claim(),
            Head::from(&view),
            computer::Change {
                id: FactId::new(),
                at: UnixMillis(at.try_into().unwrap()),
                fact: computer::Fact::SubjectObserved {
                    subject: computer::Subject {
                        activity: activity.clone(),
                        basis,
                        allow_always: false,
                        target: AuthorizationObligation::Tool {
                            tool: tool.key.clone(),
                        },
                        operation: original,
                        capture: capture.reference().clone(),
                    },
                },
            },
            vec![capture],
        )
        .await
        .unwrap();
        for (id, request, outcome) in [
            (
                "control-broad",
                InteractionRequest::ClientCapability {
                    tool_use_id: tool_use_id.clone(),
                    target: broad.clone(),
                    basis: Some(basis),
                },
                InteractionOutcome::ClientCapabilityDecision {
                    decision: Decision::Allow,
                    committed_at: at,
                },
            ),
            (
                "control-app",
                InteractionRequest::ComputerApp {
                    tool_use_id: tool_use_id.clone(),
                    native_operation_id: native_operation.clone(),
                    target: app.clone(),
                    basis,
                    display: display.clone(),
                    allow_always: false,
                    authority_revision: 0,
                },
                InteractionOutcome::ComputerAppDecision {
                    decision: ComputerAppDecision::Session,
                    committed_at: at,
                },
            ),
        ] {
            let request = InteractionRecord {
                execution: execution.clone(),
                request_id: id.into(),
                created_at: at,
                request,
                outcome: None,
            };
            interactions
                .establish(
                    access.claim(),
                    Head::from(&access.fresh().await.unwrap()),
                    request,
                    None,
                    vec![],
                )
                .await
                .unwrap();
            interactions
                .commit_outcome(&session, id, outcome)
                .await
                .unwrap();
        }
        apps.append(
            access.claim(),
            Head::from(&access.fresh().await.unwrap()),
            computer::Change {
                id: FactId::new(),
                at: UnixMillis(at.try_into().unwrap()),
                fact: computer::Fact::AppAuthorized {
                    source_operation: native_operation.clone(),
                    request: Some("control-app".into()),
                    basis,
                },
            },
            vec![],
        )
        .await
        .unwrap();
        counter.release.add_permits(1);
        let (mut next_socket, _) = listener.accept().await.unwrap();
        request(&mut next_socket).await;
        let settled=fixture.recorded_facts(&session).await;
        assert!(settled.iter().any(|recorded|matches!(&recorded.fact,maka_agent_facts::durable::Fact::HostToolResultRecorded{tool:key,..} if *key==tool.key)),"the actual Host return is canonical before checking settled activity");
        assert_eq!(settled.iter().filter(|recorded|matches!(&recorded.fact,maka_agent_facts::durable::Fact::ToolResultAccepted{tool:key,outcome:maka_agent_facts::durable::AcceptedResult::Succeeded,..} if *key==tool.key)).count(),1,"the actual Host tool has one successful accepted result");
        assert_eq!(counter.effects.load(std::sync::atomic::Ordering::SeqCst), 1);
        let active = json!({"entries":[{"activity":activity,"stopped":false}]});
        assert_eq!(next_apps(&mut watch).await, active);
        assert_eq!(
            fixture
                .query("computerApps", json!({"sessionId":session}))
                .await
                .unwrap(),
            active
        );
        let selector = json!({"sessionId":session,"operationId":native_operation});
        for identity in [
            Identity::Agent {
                execution: execution.clone(),
                operation_id: Some("untrusted-stop".into()),
            },
            Identity::Background {
                grant: maka_capabilities::authorization::Id(Uuid::new_v4()),
            },
        ] {
            let scope = fixture
                .issuer
                .issue_with(identity, true, CancellationToken::new())
                .unwrap();
            let client = fixture.app.client();
            let prepared = client
                .prepare_mutation(
                    fixture.binding(2).await,
                    "stopComputerApp".into(),
                    selector.clone(),
                    scope,
                    Uuid::new_v4(),
                    Attachments::new().into(),
                )
                .await;
            if let Ok(prepared) = prepared
                && let Ok(result) = client.mutate_owned(prepared, selector.clone()).await
            {
                let result = result.result().await;
                assert!(
                    !matches!(
                        result.receipt,
                        Receipt::Recorded {
                            outcome: OperationOutcome::Returned { .. },
                            ..
                        }
                    ),
                    "non-user scope returned a Stop result"
                );
            }
            assert_eq!(
                fixture
                    .query("computerApps", json!({"sessionId":session}))
                    .await
                    .unwrap(),
                active
            );
        }
        for field in ["applicationId", "appPath", "risk"] {
            let mut forged = selector.clone();
            forged[field] = json!("caller-controlled");
            assert!(
                fixture
                    .mutation(2, "stopComputerApp", forged, Uuid::new_v4())
                    .await
                    .is_err()
            );
        }
        assert_eq!(
            fixture
                .mutation(2, "stopComputerApp", selector, Uuid::new_v4())
                .await
                .unwrap(),
            json!({"requested":true})
        );
        assert_eq!(
            next_apps(&mut watch).await,
            json!({"entries":[{"activity":activity,"stopped":true}]})
        );
        drop(watch);
        response(&mut next_socket).await;
        fixture.drained().await;
        drop(apps);
        drop(interactions);
        drop(data);
        drop(access);
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
    })
    .await
    .expect("real Host app Stop controls timed out");
}
