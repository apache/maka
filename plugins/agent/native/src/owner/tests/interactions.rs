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
use maka_agent_facts::interaction::InteractionOutcome;
use maka_agent_facts::interaction::InteractionRecord;

pub(super) async fn question_response(socket: &mut TcpStream) {
    let input = json!({"questions":[
        {"question":"Choose\nformat", "options":[{"label":"Brief"},{"label":"Detailed"}]},
        {"question":"Any detail?", "options":[{"label":"Yes"},{"label":"No"}]},
        {"question":"Optional?", "options":[{"label":"Yes"},{"label":"No"}]}
    ]});
    let delta = json!({"id":"question-model","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"question-call","type":"function","function":{"name":"AskUserQuestion","arguments":input.to_string()}}]},"finish_reason":null}]});
    let body = format!(
        "data: {delta}\n\ndata: {{\"id\":\"question-model\",\"choices\":[{{\"index\":0,\"delta\":{{}},\"finish_reason\":\"tool_calls\"}}]}}\n\ndata: [DONE]\n\n"
    );
    socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
}
async fn pending(fixture: &Fixture, session: &str) -> InteractionRecord {
    let mut commits = fixture.session(session).await.subscribe_commits().unwrap();
    loop {
        if let Some(record) = fixture
            .session(session)
            .await
            .pending_interactions(session)
            .await
            .unwrap()
            .into_iter()
            .next()
        {
            return record;
        }
        commits.changed().await.unwrap();
    }
}

#[tokio::test]
async fn root_app_stream_delivers_publication_and_removal_without_source_revision_change() {
    tokio::time::timeout(Duration::from_secs(30), async {
        async fn next_pending(
            watch: &mut maka_host_runtime::application::Subscription,
        ) -> Result<Value, String> {
            loop {
                let update = watch.recv().await.ok_or("interaction stream closed")?;
                if update["kind"] == "interactions" {
                    return Ok(update["pending"].clone());
                }
            }
        }
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let fixture = Fixture::new(
            &format!("http://{}/v1", listener.local_addr().unwrap()),
            None,
        )
        .await;
        let session = fixture.create("Root app stream").await;
        let started = fixture.send(&session).await.unwrap();
        let (mut held, _) = listener.accept().await.unwrap();
        request(&mut held).await;
        let store = fixture.session(&session).await;
        let projection = store
            .session_projection::<maka_agent_api::session::StoredSessionConfiguration>(&session)
            .await
            .unwrap()
            .unwrap();
        let source_revision = projection.session.revision;
        let configuration = &projection.session.configuration;
        let binding = projection
            .session
            .workspace_binding
            .as_ref()
            .unwrap()
            .stamp();
        let basis = maka_agent_facts::workspace::PermissionBasis {
            boundary_revision: configuration
                .workspace
                .boundary_revision(configuration.boundary_revision, binding)
                .unwrap(),
            binding,
        };
        let invocation = projection.root_turn.unwrap().invocation;
        let mut target = maka_workspace_api::computer::target();
        target.scope = maka_agent_facts::interaction::GrantScope::ComputerApp {
            platform: maka_agent_facts::interaction::ComputerAppPlatform::Macos,
            application_id: "org.example.StreamFixture".into(),
        };
        let revision = store
            .computer_app_authority_revision(&target)
            .await
            .unwrap();
        let record = InteractionRecord {
            session_id: session.clone(),
            turn_id: invocation.turn_id.clone(),
            run_id: invocation.run_id.clone(),
            request_id: "stream_app_consent".into(),
            created_at: 1,
            outcome: None,
            request: maka_agent_facts::interaction::InteractionRequest::ComputerApp {
                tool_use_id: "stream_app_tool".into(),
                native_operation_id: "stream_native_effect".into(),
                target,
                basis,
                display: maka_agent_facts::interaction::ComputerAppDisplay {
                    name: "Trusted stream fixture".into(),
                    app_path: "/Stream Fixture.app".into(),
                    risk: None,
                    warning: None,
                },
                allow_always: false,
                authority_revision: revision,
            },
        };
        let mut watch = fixture
            .app
            .client()
            .subscribe(
                fixture.binding(2).await,
                "watch".into(),
                json!({"sessionId":session,"after":projection.through_sequence}),
                scope(&fixture.issuer, true),
                Attachments::new().into(),
            )
            .await
            .unwrap();
        let observed = tokio::time::timeout(Duration::from_secs(15), async {
            let empty = json!({"revision":source_revision,"entries":[]});
            if next_pending(&mut watch).await? != empty {
                return Err("initial canonical pending summary was not empty".to_owned());
            }
            if !store
                .establish_run_interaction(&invocation, &record)
                .await
                .map_err(|error| error.to_string())?
                .matches
            {
                return Err("app request publication conflicted".into());
            }
            let published = next_pending(&mut watch).await?;
            let expected = json!({"revision":source_revision,"entries":[{
                "requestId":"stream_app_consent","kind":"computer_app","toolUseId":"stream_app_tool"
            }]});
            if published != expected {
                return Err(format!(
                    "root app publication was not delivered exactly: {published}"
                ));
            }
            let response = fixture
                .mutation(
                    2,
                    "respond",
                    json!({"sessionId":session,"requestId":record.request_id,
                    "answer":{"kind":"computer_app","decision":"deny"}}),
                    Uuid::new_v4(),
                )
                .await?;
            if response["record"]["outcome"]["decision"] != "deny" {
                return Err(format!("app answer was not committed: {response}"));
            }
            let removed = next_pending(&mut watch).await?;
            if removed != empty {
                return Err(format!(
                    "root app removal was not delivered exactly: {removed}"
                ));
            }
            let actual = store
                .get::<maka_agent_api::session::StoredSessionConfiguration>()
                .await
                .map_err(|error| error.to_string())?
                .ok_or("source Session disappeared")?;
            if actual.revision != source_revision {
                return Err("source revision changed during root-only consent".into());
            }
            Ok(())
        })
        .await;
        drop(watch);
        fixture
            .mutation(
                2,
                "stop",
                json!({"sessionId":session,"invocationId":started["invocationId"]}),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
        fixture.drained().await;
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
        observed
            .expect("root-only pending delivery timed out")
            .unwrap();
    })
    .await
    .expect("native root app interaction stream fixture timed out");
}

#[tokio::test]
async fn native_browser_consent_accepts_original_producer_and_rejects_foreign_provider() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let fixture = Fixture::new(
            &format!("http://{}/v1", listener.local_addr().unwrap()),
            None,
        )
        .await;
        let session = fixture.create("Browser producer consent").await;
        let started = fixture.send(&session).await.unwrap();
        let (mut held, _) = listener.accept().await.unwrap();
        request(&mut held).await;
        let store = fixture.session(&session).await;
        let projection = store
            .session_projection::<maka_agent_api::session::StoredSessionConfiguration>(&session)
            .await
            .unwrap()
            .unwrap();
        let binding = projection
            .session
            .workspace_binding
            .as_ref()
            .unwrap()
            .stamp();
        let configuration = &projection.session.configuration;
        let basis = maka_agent_facts::workspace::PermissionBasis {
            boundary_revision: configuration
                .workspace
                .boundary_revision(configuration.boundary_revision, binding)
                .unwrap(),
            binding,
        };
        let invocation = projection.root_turn.unwrap().invocation;
        let observed: Result<(), String> = async {
            for (id, original) in [("browser_original", true), ("browser_foreign", false)] {
                let mut target = maka_workspace_api::computer::target();
                target.capability = maka_agent_facts::interaction::GrantCapability::Browser;
                target.scope = maka_agent_facts::interaction::GrantScope::BrowserOrigin {
                    origin: "https://example.com".into(),
                };
                if !original {
                    target.provider_id = "foreign_browser_provider".into();
                }
                let record = InteractionRecord {
                    session_id: session.clone(),
                    turn_id: invocation.turn_id.clone(),
                    run_id: invocation.run_id.clone(),
                    request_id: id.into(),
                    created_at: 1,
                    outcome: None,
                    request: maka_agent_facts::interaction::InteractionRequest::ClientCapability {
                        tool_use_id: "browser_tool".into(),
                        target: target.clone(),
                        basis: Some(basis),
                    },
                };
                store
                    .establish_run_interaction(&invocation, &record)
                    .await
                    .map_err(|error| error.to_string())?;
                let result = fixture
                    .mutation(
                        2,
                        "respond",
                        json!({"sessionId":session,"requestId":id,
                    "answer":{"kind":"client_capability","decision":"allow"}}),
                        Uuid::new_v4(),
                    )
                    .await?;
                let grant = store
                    .client_capability_grant(&session, &target)
                    .await
                    .map_err(|error| error.to_string())?;
                if original {
                    if result["kind"] != "recorded"
                        || result["record"]["outcome"]["decision"] != "allow"
                        || grant.as_ref().map(|grant| &grant.target) != Some(&target)
                    {
                        return Err(format!(
                            "original browser producer was not granted: {result}"
                        ));
                    }
                } else {
                    if result != json!({"kind":"rejected","reason":"unsupported"})
                        || grant.is_some()
                    {
                        return Err(format!(
                            "foreign browser producer acquired authority: {result}"
                        ));
                    }
                    if store
                        .interaction(id)
                        .await
                        .map_err(|error| error.to_string())?
                        .ok_or("foreign request disappeared")?
                        .outcome
                        .is_some()
                    {
                        return Err("unsupported producer was answered".into());
                    }
                }
            }
            Ok(())
        }
        .await;
        fixture
            .mutation(
                2,
                "stop",
                json!({"sessionId":session,"invocationId":started["invocationId"]}),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
        fixture.drained().await;
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
        observed.unwrap();
    })
    .await
    .expect("native browser producer consent fixture timed out");
}

#[tokio::test]
async fn native_question_roundtrip_is_bound_owned_and_first_wins() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let fixture = Fixture::with_services(&format!("http://{}/v1", listener.local_addr().unwrap()), None, None, Some(service_tools::Setup::questions())).await;
        let session = fixture.create("Question roundtrip").await;
        fixture.send(&session).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        let first = request(&mut socket).await;
        assert_eq!(first["tools"][0]["function"]["name"], "AskUserQuestion");
        question_response(&mut socket).await;
        let record = pending(&fixture, &session).await;
        let original = fixture.query("interaction", json!({"sessionId":session,"requestId":record.request_id})).await.unwrap();
        assert_eq!(original["request"]["questions"][0]["question"], "Choose\\u{A}format");
        let before = fixture.query("observe", json!({"sessionId":session})).await.unwrap();
        assert_eq!(before["run"]["state"], "waiting_for_user");
        let through = before["through"].as_u64().unwrap();
        let mut watch = fixture.app.client().subscribe(fixture.binding(2).await, "watch".into(), json!({"sessionId":session,"after":through}), scope(&fixture.issuer, true), Attachments::new().into()).await.unwrap();
        loop {
            let item = watch.recv().await.unwrap();
            if item["kind"] == "interactions" { assert_eq!(item["pending"]["entries"][0]["requestId"], record.request_id); break; }
        }
        // A valid Session in this owner still cannot address another Session's request.
        let other = fixture.create("Other question session").await;
        assert!(fixture.query("interaction", json!({"sessionId":other,"requestId":record.request_id})).await.is_err());
        assert!(fixture.query("pendingInteractions", json!({"sessionId":"foreign"})).await.is_err());
        let wrong = fixture.mutation(2, "respond", json!({"sessionId":other,"requestId":record.request_id,"answer":{"kind":"question","answers":["Brief","text",null]}}), Uuid::new_v4()).await.unwrap();
        assert_eq!(wrong, json!({"kind":"rejected","reason":"unavailable"}));
        let invalid = fixture.mutation(2, "respond", json!({"sessionId":session,"requestId":record.request_id,"answer":{"kind":"question","answers":["Brief"]}}), Uuid::new_v4()).await.unwrap();
        assert_eq!(invalid, json!({"kind":"rejected","reason":"invalid_answer"}));
        let operation = Uuid::new_v4();
        let input = json!({"sessionId":session,"requestId":record.request_id,"answer":{"kind":"question","answers":["Brief","my text",null]}});
        let answered = fixture.mutation(2, "respond", input.clone(), operation).await.unwrap();
        assert_eq!(answered["kind"], "recorded");
        assert_eq!(fixture.mutation(2, "respond", input, operation).await.unwrap(), answered);
        let conflict = fixture.mutation(2, "respond", json!({"sessionId":session,"requestId":record.request_id,"answer":{"kind":"question","answers":["Detailed","changed",null]}}), Uuid::new_v4()).await.unwrap();
        assert_eq!(conflict, answered);
        loop {
            let item = watch.recv().await.unwrap();
            if item["kind"] == "interactions" && item["pending"]["entries"] == json!([]) { break; }
        }
        drop(watch);
        let (mut next, _) = listener.accept().await.unwrap();
        let resumed = request(&mut next).await;
        let message = resumed["messages"].as_array().unwrap().iter().find(|message| message["role"] == "tool").unwrap();
        assert_eq!(serde_json::from_str::<Value>(message["content"].as_str().unwrap()).unwrap(), json!({"kind":"answered","answers":[
            {"question":"Choose\nformat","answer":"Brief"},{"question":"Any detail?","answer":"my text"},{"question":"Optional?","answer":null}
        ]}));
        assert!(!message.to_string().contains("journal_v1"));
        response(&mut next).await;
        fixture.drained().await;
        assert!(matches!(fixture.session(&record.session_id).await.interaction(&record.request_id).await.unwrap().unwrap().outcome, Some(InteractionOutcome::QuestionAnswer { .. })));
        fixture.app.shutdown().await.unwrap(); fixture.config.shutdown().await.unwrap();
    }).await.unwrap();
}
#[tokio::test]
async fn stopping_question_closes_original_request_and_releases_run_owner() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let fixture = Fixture::with_services(
            &format!("http://{}/v1", listener.local_addr().unwrap()),
            None,
            None,
            Some(service_tools::Setup::questions()),
        )
        .await;
        let session = fixture.create("Stop question").await;
        let started = fixture.send(&session).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        question_response(&mut socket).await;
        let record = pending(&fixture, &session).await;
        fixture
            .mutation(
                2,
                "stop",
                json!({"sessionId":session,"invocationId":started["invocationId"]}),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
        fixture.drained().await;
        assert!(matches!(
            fixture
                .session(&record.session_id)
                .await
                .interaction(&record.request_id)
                .await
                .unwrap()
                .unwrap()
                .outcome,
            Some(InteractionOutcome::Closure { .. })
        ));
        assert!(fixture.owner.runs.lock().await.controls.is_empty());
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

fn form_input() -> Value {
    json!({"message":"Choose delivery settings", "fields":[
        {"name":"note","label":"Delivery note","kind":"string","required":true,"minLength":1,"maxLength":64},
        {"name":"count","label":"Copies","kind":"integer","required":true,"minimum":1,"maximum":5},
        {"name":"confirm","label":"Confirmed","kind":"boolean","required":true},
        {"name":"format","label":"Format","kind":"single_select","required":true,"options":[{"value":"brief","label":"Brief"},{"value":"full","label":"Full"}]},
        {"name":"extras","label":"Extras","kind":"multi_select","required":false,"minItems":1,"maxItems":2,"options":[{"value":"a","label":"A"},{"value":"b","label":"B"}]}
    ]})
}
pub(super) async fn form_response(socket: &mut TcpStream) {
    let delta = json!({"id":"form-model","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"form-call","type":"function","function":{"name":"AskUserForm","arguments":form_input().to_string()}}]},"finish_reason":null}]});
    let body = format!(
        "data: {delta}\n\ndata: {{\"id\":\"form-model\",\"choices\":[{{\"index\":0,\"delta\":{{}},\"finish_reason\":\"tool_calls\"}}]}}\n\ndata: [DONE]\n\n"
    );
    socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
}
#[tokio::test]
async fn native_form_validates_original_fields_and_commits_before_resuming() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let fixture = Fixture::with_services(&format!("http://{}/v1", listener.local_addr().unwrap()), None, None, Some(service_tools::Setup::forms())).await;
        let session = fixture.create("Form roundtrip").await;
        fixture.send(&session).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        let first = request(&mut socket).await;
        assert_eq!(first["tools"][0]["function"]["name"], "AskUserForm");
        form_response(&mut socket).await;
        let record = pending(&fixture, &session).await;
        assert_eq!(fixture.query("observe", json!({"sessionId":session})).await.unwrap()["run"]["state"], "waiting_for_user");
        let other = fixture.create("Other form").await;
        let answer = json!({"kind":"form","action":"accept","values":{"note":"门口 delivery","count":2.0,"confirm":false,"format":"brief","extras":["a","b"]}});
        assert_eq!(fixture.mutation(2,"respond",json!({"sessionId":other,"requestId":record.request_id,"answer":answer}),Uuid::new_v4()).await.unwrap()["reason"],"unavailable");
        for values in [json!({}),json!({"note":"","count":2,"confirm":false,"format":"brief"}),json!({"note":"valid","count":1.5,"confirm":false,"format":"brief"}),json!({"note":"valid","count":2,"confirm":"false","format":"brief"}),json!({"note":"valid","count":2,"confirm":false,"format":"unknown"}),json!({"note":"valid","count":2,"confirm":false,"format":"brief","unknown":true})] {
            let rejected = fixture.mutation(2,"respond",json!({"sessionId":session,"requestId":record.request_id,"answer":{"kind":"form","action":"accept","values":values}}),Uuid::new_v4()).await.unwrap();
            assert_eq!(rejected["reason"],"invalid_answer");
            assert!(fixture.session(&record.session_id).await.interaction(&record.request_id).await.unwrap().unwrap().outcome.is_none());
        }
        let duplicate = fixture.mutation(2,"respond",json!({"sessionId":session,"requestId":record.request_id,"answer":{"kind":"form","action":"accept","values":{"extras":["a","a"]}}}),Uuid::new_v4()).await;
        assert_eq!(duplicate.unwrap_err(), "agent_input_invalid");
        let operation = Uuid::new_v4();
        let input = json!({"sessionId":session,"requestId":record.request_id,"answer":answer});
        let result = fixture.mutation(2,"respond",input.clone(),operation).await.unwrap();
        assert_eq!(result["kind"],"recorded");
        assert_eq!(result["record"]["outcome"]["values"],answer["values"]);
        assert_eq!(fixture.mutation(2,"respond",input,operation).await.unwrap(),result);
        assert_eq!(fixture.mutation(2,"respond",json!({"sessionId":session,"requestId":record.request_id,"answer":{"kind":"form","action":"decline"}}),Uuid::new_v4()).await.unwrap(),result);
        let (mut next, _) = listener.accept().await.unwrap();
        let resumed = request(&mut next).await;
        let message = resumed["messages"].as_array().unwrap().iter().find(|m| m["role"] == "tool").unwrap();
        let returned: Value = serde_json::from_str(message["content"].as_str().unwrap()).unwrap();
        assert_eq!(returned["kind"], "answered");
        // Model JSON canonicalizes 2.0 to 2; compare the original typed form result.
        assert_eq!(serde_json::from_value::<maka_agent_facts::capability::FormResult>(returned["result"].clone()).unwrap(), serde_json::from_value::<maka_agent_facts::capability::FormResult>(answer).unwrap());
        response(&mut next).await; fixture.drained().await;
        fixture.app.shutdown().await.unwrap(); fixture.config.shutdown().await.unwrap();
    }).await.unwrap();
}
#[tokio::test]
async fn native_form_decline_cancel_and_stop_settle_original_wait() {
    tokio::time::timeout(Duration::from_secs(30), async {
        for action in ["decline", "cancel", "stop"] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let fixture = Fixture::with_services(&format!("http://{}/v1", listener.local_addr().unwrap()), None, None, Some(service_tools::Setup::forms())).await;
            let session = fixture.create("Form closure").await;
            let started = fixture.send(&session).await.unwrap();
            let (mut socket, _) = listener.accept().await.unwrap(); request(&mut socket).await; form_response(&mut socket).await;
            let record = pending(&fixture, &session).await;
            if action == "stop" {
                fixture.mutation(2,"stop",json!({"sessionId":session,"invocationId":started["invocationId"]}),Uuid::new_v4()).await.unwrap();
            } else {
                fixture.mutation(2,"respond",json!({"sessionId":session,"requestId":record.request_id,"answer":{"kind":"form","action":action}}),Uuid::new_v4()).await.unwrap();
                let (mut next, _) = listener.accept().await.unwrap();
                let resumed = request(&mut next).await;
                let message = resumed["messages"].as_array().unwrap().iter().find(|m| m["role"] == "tool").unwrap();
                assert_eq!(serde_json::from_str::<Value>(message["content"].as_str().unwrap()).unwrap(),json!({"kind":"answered","result":{"action":action}}));
                response(&mut next).await;
            }
            fixture.drained().await;
            let stored = fixture.session(&record.session_id).await.interaction(&record.request_id).await.unwrap().unwrap();
            if action == "stop" { assert!(matches!(stored.outcome,Some(InteractionOutcome::Closure{..}))); }
            assert!(fixture.session(&session).await.pending_interactions(&session).await.unwrap().is_empty());
            fixture.app.shutdown().await.unwrap();fixture.config.shutdown().await.unwrap();
        }
    }).await.unwrap();
}
