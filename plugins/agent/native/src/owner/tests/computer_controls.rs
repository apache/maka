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
use maka_agent_facts::event::{EventWrite, Fact, Invocation, InvocationInput, RuntimeEvent};
use maka_agent_facts::interaction::{
    ComputerAppDecision, ComputerAppDisplay, ComputerAppPlatform, Decision, GrantScope,
    InteractionOutcome, InteractionRecord, InteractionRequest,
};

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
        let fixture = Fixture::new("http://127.0.0.1:1/v1", None).await;
        let session = fixture.create("User app Stop controls").await;
        let store = fixture.session(&session).await;
        let record = store
            .get::<maka_agent_api::session::StoredSessionConfiguration>()
            .await
            .unwrap()
            .unwrap();
        let stamp = record.workspace_binding.as_ref().unwrap().stamp();
        let basis = maka_agent_facts::workspace::PermissionBasis {
            boundary_revision: record
                .configuration
                .workspace
                .boundary_revision(record.configuration.boundary_revision, stamp)
                .unwrap(),
            binding: stamp,
        };
        let invocation = Invocation {
            session_id: session.clone(),
            turn_id: "control-turn".into(),
            run_id: "control-run".into(),
            invocation_id: "control-invocation".into(),
        };
        store
            .append(
                &EventWrite::plain(RuntimeEvent::new(
                    invocation.clone(),
                    Fact::InvocationOpened {
                        configuration: None,
                        input: InvocationInput::Message {
                            source_messages: Vec::new(),
                            content: "Host consent fixture".into(),
                            request_fingerprint: None,
                        },
                    },
                ))
                .unwrap(),
            )
            .await
            .unwrap();
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
        for (id, request, outcome) in [
            (
                "control-broad",
                InteractionRequest::ClientCapability {
                    tool_use_id: "control-public-tool".into(),
                    target: broad.clone(),
                    basis: Some(basis),
                },
                InteractionOutcome::ClientCapabilityDecision {
                    decision: Decision::Allow,
                    committed_at: 2,
                },
            ),
            (
                "control-app",
                InteractionRequest::ComputerApp {
                    tool_use_id: "control-public-tool".into(),
                    native_operation_id: "controlled-native-effect".into(),
                    target: app.clone(),
                    basis,
                    display: display.clone(),
                    allow_always: false,
                    authority_revision: 0,
                },
                InteractionOutcome::ComputerAppDecision {
                    decision: ComputerAppDecision::Session,
                    committed_at: 2,
                },
            ),
        ] {
            let request = InteractionRecord {
                session_id: session.clone(),
                turn_id: invocation.turn_id.clone(),
                run_id: invocation.run_id.clone(),
                request_id: id.into(),
                created_at: 1,
                request,
                outcome: None,
            };
            store
                .establish_run_interaction(&invocation, &request)
                .await
                .unwrap();
            store.commit_interaction_outcome(id, outcome).await.unwrap();
        }
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
        let event = EventWrite::plain(RuntimeEvent::new(
            invocation.clone(),
            Fact::ToolDispatched {
                presentation: None,
                title: None,
                operation_id: "controlled-native-effect".into(),
                call: maka_agent_facts::tool_call::ToolCallIdentity::standalone(
                    "control-call".into(),
                ),
                name: "native-fixture".into(),
                input: json!({}),
            },
        ))
        .unwrap();
        store
            .append_computer_app_dispatch(
                &event,
                std::slice::from_ref(&broad),
                &app,
                &display,
                &basis,
            )
            .await
            .unwrap();
        let (settled, _) = EventWrite::tool_success(
            "control-settled".into(),
            std::time::SystemTime::now(),
            invocation.clone(),
            "controlled-native-effect".into(),
            maka_agent_facts::tool_output::ToolOutput::Text(
                "Fixture completed without native input".into(),
            )
            .into(),
        )
        .unwrap();
        store.append(&settled).await.unwrap();
        let activity = maka_agent_facts::interaction::ComputerAppActivity {
            invocation: invocation.clone(),
            operation_id: "controlled-native-effect".into(),
            target: app,
            display,
        };
        let active = json!({"entries":[{"activity":activity,"stopped":false}]});
        assert_eq!(next_apps(&mut watch).await, active);
        let selector = json!({"sessionId":session,"operationId":"controlled-native-effect"});
        for identity in [
            Identity::Agent {
                invocation: invocation.clone(),
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
            if let Ok(prepared) = prepared {
                if let Ok(result) = client.mutate_owned(prepared).await {
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
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
    })
    .await
    .expect("real Host app Stop controls timed out");
}
