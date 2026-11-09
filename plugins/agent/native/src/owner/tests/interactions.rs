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
use maka_agent_ports::execution::Interactions as _;

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
    let interactions = fixture.owner.durable.interactions();
    let mut commits = interactions.subscribe().unwrap();
    loop {
        commits.borrow_and_update();
        if let Some(record) = interactions
            .pending(session)
            .await
            .unwrap()
            .records
            .into_iter()
            .next()
        {
            return record;
        }
        commits.changed().await.unwrap();
    }
}

#[tokio::test]
async fn native_browser_consent_accepts_original_producer_and_rejects_foreign_provider() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let fixture = Fixture::with_services(
            &format!("http://{}/v1", listener.local_addr().unwrap()),
            None,
            None,
            Some(service_tools::Setup::browser_consent()),
        ).await;
        let session = fixture.create("Browser producer consent").await;
        let queued = fixture.send(&session).await.unwrap();
        let run = fixture.delivered_run(&queued).await;
        let (mut socket, _) = listener.accept().await.unwrap();
        let sent = request(&mut socket).await;
        assert!(sent["tools"].as_array().unwrap().iter().any(|tool| tool["function"]["name"] == "Navigate"));
        service_tools::named_tool_response(&mut socket, "Navigate", json!({"url":"https://example.com"})).await;
        drop(socket);

        let store = fixture.owner.durable.interactions();
        let mut commits = store.subscribe().unwrap();
        let records = loop {
            commits.borrow_and_update();
            let records = store.pending(&session).await.unwrap().records;
            assert!(records.len() <= 6);
            if records.len() == 6 { break records; }
            commits.changed().await.unwrap();
        };
        let view = fixture.owner.durable.frontier(run).await.unwrap();
        let tool = view.tools.values().find(|tool| tool.call.name == "Navigate").expect("actual Finished Navigate call");
        assert!(tool.admitted && tool.accepted.is_none());
        let key = maka_agent_state::fold::tool_key(&tool.key);
        let tool_use_id = maka_agent_facts::tool_call::tool_use_id(run, &key);
        let binding = store.binding(&session, &records[0].request_id).await.unwrap().unwrap();
        let maka_agent_state::interactions::ApprovalPhase::Host { original } = binding.phase else {
            panic!("browser consent must be bound to the original admitted Host operation")
        };
        assert_eq!(original.method, "navigate");
        let observed: Result<(), String> = async {
            for (name, capability) in [
                ("page", maka_agent_facts::interaction::GrantCapability::Browser),
                ("download", maka_agent_facts::interaction::GrantCapability::BrowserDownload),
                ("upload", maka_agent_facts::interaction::GrantCapability::BrowserUpload),
            ] {
                for (suffix, supported) in [("original", true), ("foreign", false)] {
                    let id = format!("{tool_use_id}:{name}_browser_{suffix}");
                    let record = records.iter().find(|record| record.request_id == id).ok_or("original browser request missing")?;
                    assert_eq!(record.execution.session_id, session);
                    assert_eq!(record.execution.run_id, run);
                    let maka_agent_facts::interaction::InteractionRequest::ClientCapability { tool_use_id: actual_tool, target, basis } = &record.request else {
                        return Err("original browser request changed kind".into());
                    };
                    assert_eq!(actual_tool, &tool_use_id);
                    assert!(basis.is_some());
                    assert_eq!(target.capability, capability);
                    assert_eq!(target.scope, maka_agent_facts::interaction::GrantScope::BrowserOrigin { origin: "https://example.com".into() });
                    assert_eq!(target.provider_id, if supported { maka_workspace_api::computer::target().provider_id } else { "foreign_browser_provider".into() });
                    let binding = store.binding(&session, &id).await.map_err(|error| error.to_string())?.ok_or("original approval binding missing")?;
                    assert_eq!(binding.target, maka_agent_facts::durable::AuthorizationObligation::Tool { tool: tool.key.clone() });
                    assert_eq!(binding.phase, maka_agent_state::interactions::ApprovalPhase::Host { original: original.clone() });
                    let result = fixture.mutation(
                        2, "respond",
                        json!({"sessionId":session,"requestId":id,"answer":{"kind":"client_capability","decision":"allow"}}),
                        Uuid::new_v4(),
                    ).await?;
                    let grant = store.client_capability_grant(&session, target).await.map_err(|error| error.to_string())?;
                    if supported {
                        if result["kind"] != "recorded"
                            || result["record"]["outcome"]["decision"] != "allow"
                            || grant.as_ref().map(|grant| &grant.target) != Some(target)
                        {
                            return Err(format!("original browser producer was not granted: {result}"));
                        }
                    } else {
                        if result != json!({"kind":"rejected","reason":"unsupported"}) || grant.is_some() {
                            return Err(format!("foreign browser producer acquired authority: {result}"));
                        }
                        if store.read(&session, &id).await.map_err(|error| error.to_string())?.ok_or("foreign request disappeared")?.outcome.is_some() {
                            return Err("unsupported producer was answered".into());
                        }
                    }
                }
            }
            let held = fixture.owner.durable.frontier(run).await.map_err(|error| error.to_string())?;
            assert!(held.tools[&key].accepted.is_none(), "all negative assertions finish while the original Host call is still held");
            Ok(())
        }.await;
        fixture.mutation(2, "stop", json!({"sessionId":session,"runId":run}), Uuid::new_v4()).await.unwrap();
        fixture.drained().await;
        assert!(store.pending(&session).await.unwrap().records.is_empty());
        let recorded = fixture.history_items(&session).await;
        assert_eq!(recorded.iter().filter(|item| item.recorded.run == run && matches!(
            &item.recorded.fact, maka_agent_facts::durable::Fact::ToolAdmitted { tool: key } if key == &tool.key
        )).count(), 1);
        assert_eq!(recorded.iter().filter(|item| item.recorded.run == run && matches!(
            &item.recorded.fact, maka_agent_facts::durable::Fact::HostToolResultRecorded { tool: key, reference, .. } if key == &tool.key && reference == &original
        )).count(), 1);
        let settled = fixture.store.operation(&original).unwrap().operation_observation().await.unwrap().expect("original browser SDK receipt");
        assert!(matches!(settled.outcome, OperationOutcome::Returned { result: maka_plugin_core::operation::OperationResult::Failure { .. } }), "the consent-only fixture must not claim navigation succeeded");
        assert_eq!(settled.cleanup, maka_plugin_core::operation::OperationCleanup::Confirmed);
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
        observed.unwrap();
    }).await.expect("native browser producer consent fixture timed out");
}

#[tokio::test]
async fn native_system_permission_is_listed_cancellable_and_producer_granted() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let fixture = Fixture::new(
            &format!("http://{}/v1", listener.local_addr().unwrap()),
            None,
        )
        .await;
        let session = fixture.create("System permission").await;
        let queued = fixture.send(&session).await.unwrap();
        fixture.delivered_run(&queued).await;
        let (mut held, _) = listener.accept().await.unwrap();
        request(&mut held).await;
        let store = fixture.owner.durable.interactions();
        let access = fixture.live_access(&session).await;
        let observed: Result<(), String> = async {
            for id in ["system_cancelled", "system_granted"] {
                let record = InteractionRecord {
                    execution: access.execution().clone(),
                    request_id: id.into(),
                    created_at: 1,
                    outcome: None,
                    request: maka_agent_facts::interaction::InteractionRequest::SystemPermission {
                        tool_use_id: "computer_tool".into(),
                        grants: vec![
                            maka_agent_facts::interaction::SystemPermissionGrant::Accessibility,
                            maka_agent_facts::interaction::SystemPermissionGrant::ScreenRecording,
                        ],
                        application: "Maka Host".into(),
                        application_location: None,
                    },
                };
                access.establish(&record).await?;
            }
            let listed = fixture
                .query("pendingInteractions", json!({"sessionId":session}))
                .await?;
            for id in ["system_cancelled", "system_granted"] {
                let entries = listed["entries"].as_array().ok_or("pending entries")?;
                if !entries.contains(
                    &json!({"requestId":id,"kind":"system_permission","toolUseId":"computer_tool"}),
                ) {
                    return Err(format!("system permission was not listed: {listed}"));
                }
            }
            let respond = |answer: Value| {
                fixture.mutation(
                    2,
                    "respond",
                    json!({"sessionId":session,"requestId":"system_cancelled","answer":answer}),
                    Uuid::new_v4(),
                )
            };
            let foreign = respond(json!({"kind":"computer_app_cancel"})).await?;
            if foreign != json!({"kind":"rejected","reason":"invalid_answer"}) {
                return Err(format!("foreign cancel was accepted: {foreign}"));
            }
            if respond(json!({"kind":"system_permission_granted"}))
                .await
                .is_ok()
            {
                return Err("a user answer claimed the system grant".into());
            }
            let cancelled = respond(json!({"kind":"system_permission_cancel"})).await?;
            if cancelled["kind"] != "recorded"
                || cancelled["record"]["outcome"]["kind"] != "closure"
                || cancelled["record"]["outcome"]["reason"] != "producer_cancelled"
            {
                return Err(format!(
                    "system permission cancel was not recorded: {cancelled}"
                ));
            }
            let granted = store
                .commit_outcome(
                    &session,
                    "system_granted",
                    InteractionOutcome::SystemPermissionGranted { committed_at: 2 },
                )
                .await
                .map_err(|error| error.to_string())?;
            if granted.outcome
                != Some(InteractionOutcome::SystemPermissionGranted { committed_at: 2 })
            {
                return Err("producer grant was not committed".into());
            }
            Ok(())
        }
        .await;
        let run = access.execution().run_id;
        drop(access);
        fixture
            .mutation(
                2,
                "stop",
                json!({"sessionId":session,"runId":run}),
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
    .expect("native system permission fixture timed out");
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
        assert!(matches!(fixture.owner.durable.interactions().read(&record.execution.session_id, &record.request_id).await.unwrap().unwrap().outcome, Some(InteractionOutcome::QuestionAnswer { .. })));
        fixture.app.shutdown().await.unwrap(); fixture.config.shutdown().await.unwrap();
    }).await.unwrap();
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
            assert!(fixture.owner.durable.interactions().read(&record.execution.session_id, &record.request_id).await.unwrap().unwrap().outcome.is_none());
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
async fn native_form_decline_resumes_original_wait() {
    form_closure("decline").await;
}

#[tokio::test]
async fn native_form_cancel_resumes_original_wait() {
    form_closure("cancel").await;
}

#[tokio::test]
async fn native_form_stop_closes_original_wait() {
    form_closure("stop").await;
}

async fn form_closure(action: &str) {
    tokio::time::timeout(Duration::from_secs(30), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let fixture = Fixture::with_services(&format!("http://{}/v1", listener.local_addr().unwrap()), None, None, Some(service_tools::Setup::forms())).await;
        let session = fixture.create("Form closure").await;
        let queued = fixture.send(&session).await.unwrap();
        fixture.delivered_run(&queued).await;
        let (mut socket, _) = listener.accept().await.unwrap(); request(&mut socket).await; form_response(&mut socket).await;
        let record = pending(&fixture, &session).await;
        if action == "stop" {
            fixture.mutation(2,"stop",json!({"sessionId":session,"runId":record.execution.run_id}),Uuid::new_v4()).await.unwrap();
        } else {
            fixture.mutation(2,"respond",json!({"sessionId":session,"requestId":record.request_id,"answer":{"kind":"form","action":action}}),Uuid::new_v4()).await.unwrap();
            let (mut next, _) = listener.accept().await.unwrap();
            let resumed = request(&mut next).await;
            let message = resumed["messages"].as_array().unwrap().iter().find(|m| m["role"] == "tool").unwrap();
            assert_eq!(serde_json::from_str::<Value>(message["content"].as_str().unwrap()).unwrap(),json!({"kind":"answered","result":{"action":action}}));
            response(&mut next).await;
        }
        fixture.drained().await;
        let stored = fixture.owner.durable.interactions().read(&record.execution.session_id, &record.request_id).await.unwrap().unwrap();
        if action == "stop" { assert!(matches!(stored.outcome,Some(InteractionOutcome::Closure{..}))); }
        assert!(fixture.owner.durable.interactions().pending(&session).await.unwrap().records.is_empty());
        fixture.app.shutdown().await.unwrap();fixture.config.shutdown().await.unwrap();
    }).await.unwrap();
}
