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
use maka_agent_facts::event::Fact;
use maka_agent_facts::interaction::InteractionRecord;
use maka_agent_facts::interaction::InteractionRequest;
async fn binding(f: &Fixture) -> Binding {
    let client = f.app.client();
    client
        .bind(client.activation(&id(1)).unwrap(), "service".into())
        .await
        .unwrap()
        .remove(0)
}
async fn snapshot(f: &Fixture) -> Value {
    f.app
        .client()
        .start(
            binding(f).await,
            "snapshot".into(),
            json!({}),
            scope(&f.issuer, true),
            Attachments::new().into(),
        )
        .await
        .unwrap()
        .result()
        .await
        .unwrap()
}
async fn mutation(f: &Fixture, method: &str, input: Value, secret: Option<&str>) -> Value {
    let client = f.app.client();
    let attachments = secret
        .map(|value| {
            BTreeMap::from([(
                "secret".into(),
                Arc::new(Secret(value.into())) as Arc<dyn maka_capabilities::call::ReadResource>,
            )])
        })
        .unwrap_or_default();
    let prepared = client
        .prepare_mutation(
            binding(f).await,
            method.into(),
            input,
            scope(&f.issuer, true),
            Uuid::new_v4(),
            attachments.into(),
        )
        .await
        .unwrap();
    let reference = prepared.reference().clone();
    let recorded = f
        .store
        .record_application_intent(
            reference.source.clone(),
            prepared.consumer().instance().clone(),
            reference.clone(),
            Value::Null,
        )
        .await
        .unwrap();
    let result = client
        .mutate(prepared, recorded)
        .await
        .unwrap()
        .result()
        .await;
    let Receipt::Recorded {
        outcome: OperationOutcome::Returned { value },
        ..
    } = result.receipt
    else {
        panic!("Web settings receipt")
    };
    value
}
struct Secret(String);
impl maka_capabilities::call::ReadResource for Secret {
    fn resource_type(&self) -> maka_plugin_core::contract::ResourceType {
        maka_plugin_core::contract::ResourceType {
            name: "maka.text.utf8".into(),
            version: 1,
        }
    }
    fn bytes(&self) -> usize {
        self.0.len()
    }
    fn metadata(&self) -> Value {
        Value::Null
    }
    fn read(&self, range: std::ops::Range<usize>) -> Result<Vec<u8>, String> {
        Ok(self.0.as_bytes()[range].to_vec())
    }
}
async fn save(f: &Fixture, revision: Value, enabled: bool) -> Value {
    mutation(
        f,
        "save",
        json!({"revision":revision,"settings":{"enabled":enabled,"source":"model"}}),
        None,
    )
    .await
}

async fn start(listener: &TcpListener, f: &Fixture, session: &str, url: String) -> Value {
    let started = f.send(session).await.unwrap();
    let (mut socket, _) = listener.accept().await.unwrap();
    let _ = request(&mut socket).await;
    let delta = json!({"id":"web-model","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"web-call","type":"function","function":{"name":"WebFetch","arguments":json!({"url":url}).to_string()}}]},"finish_reason":null}]});
    let body = format!(
        "data: {delta}\n\ndata: {{\"id\":\"web-model\",\"choices\":[{{\"index\":0,\"delta\":{{}},\"finish_reason\":\"tool_calls\"}}]}}\n\ndata: [DONE]\n\n"
    );
    socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
    started
}
async fn finish(listener: &TcpListener, f: &Fixture) -> Value {
    let (mut socket, _) = listener.accept().await.unwrap();
    let sent = request(&mut socket).await;
    let tool = sent["messages"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .find(|m| m["role"] == "tool")
        .unwrap();
    let result = serde_json::from_str(tool["content"].as_str().unwrap()).unwrap();
    response(&mut socket).await;
    f.drained().await;
    result
}
async fn pending(f: &Fixture, session: &str) -> InteractionRecord {
    let mut commits = f.session(session).await.subscribe_commits().unwrap();
    loop {
        if let Some(record) = f
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
async fn approve(f: &Fixture, record: &InteractionRecord) {
    let InteractionRequest::Permissions { request, .. } = &record.request else {
        panic!("network permission")
    };
    f.mutation(2, "respond", json!({"sessionId":record.session_id,"requestId":record.request_id,"answer":{"kind":"permissions","decision":{"decision":"allow","scope":"once","permissions":request.permissions}}}), Uuid::new_v4()).await.unwrap();
}
#[tokio::test]
async fn native_web_redirects_require_each_destination_and_cancel_withdraws_pending_permission() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let model = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let first = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let second = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/first", first.local_addr().unwrap());
        let f = Fixture::with_services(&format!("http://{}/v1", model.local_addr().unwrap()), None, None, Some(service_tools::Setup::web())).await;
        let session = f.create("Native Web").await;
        assert_eq!(snapshot(&f).await["settings"]["enabled"], false);
        let saved = save(&f, Value::Null, true).await;
        assert_eq!(saved["kind"], "updated");
        assert_eq!(save(&f, Value::Null, false).await["kind"], "changed");
        start(&model, &f, &session, url.clone()).await;
        let permission = pending(&f, &session).await;
        assert!(tokio::time::timeout(Duration::from_millis(50), first.accept()).await.is_err());
        approve(&f, &permission).await;
        let (mut socket, _) = first.accept().await.unwrap();
        let mut bytes = [0; 4096]; assert!(socket.read(&mut bytes).await.unwrap() > 0);
        let next = format!("http://{}/result", second.local_addr().unwrap());
        socket.write_all(format!("HTTP/1.1 302 Found\r\nLocation: {next}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
        drop(socket);
        let redirected = pending(&f, &session).await;
        assert_ne!(permission.request_id, redirected.request_id);
        assert!(tokio::time::timeout(Duration::from_millis(50), second.accept()).await.is_err());
        approve(&f, &redirected).await;
        let (mut socket, _) = second.accept().await.unwrap(); assert!(socket.read(&mut bytes).await.unwrap() > 0);
        let body = "<html><title>Native</title><body><article><p>Web result retained through the original operation.</p></article></body></html>";
        socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
        drop(socket);
        let result = finish(&model, &f).await;
        assert_eq!(result["kind"], "completed", "{result}");
        assert!(result["value"]["content"].as_str().unwrap().contains("Web result retained"));
        let facts = service_tools::facts(&f, &session).await;
        assert!(facts.iter().any(|fact| matches!(fact, Fact::ToolDispatched { name, title: Some(title), .. } if name == "WebFetch" && title.fallback == format!("Read web page · {url}"))));
        assert_eq!(facts.iter().filter(|fact| matches!(fact, Fact::ToolDispatched { name, .. } if name == "Http")).count(), 2);
        // A body remains owned until cancellation actually closes its socket.
        let streaming = start(&model, &f, &session, url.clone()).await;
        approve(&f, &pending(&f, &session).await).await;
        let (mut streaming_socket, _) = first.accept().await.unwrap();
        assert!(streaming_socket.read(&mut bytes).await.unwrap() > 0);
        streaming_socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 100000\r\n\r\npending body").await.unwrap();
        f.mutation(2, "stop", json!({"sessionId":session,"invocationId":streaming["invocationId"]}), Uuid::new_v4()).await.unwrap();
        f.drained().await;
        assert_eq!(tokio::time::timeout(Duration::from_secs(2), streaming_socket.read(&mut bytes)).await.unwrap().unwrap(), 0);
        let facts = service_tools::facts(&f, &session).await;
        let http_operations: std::collections::BTreeSet<_> = facts.iter().filter_map(|fact| match fact {
            Fact::ToolDispatched { name, operation_id, .. } if name == "Http" => Some(operation_id.clone()), _ => None,
        }).collect();
        assert_eq!(http_operations.len(), 3);
        assert_eq!(facts.iter().filter(|fact| matches!(fact, Fact::ToolSettled { operation_id, .. } if http_operations.contains(operation_id))).count(), 3);
        let started = start(&model, &f, &session, url).await;
        let _ = pending(&f, &session).await;
        f.mutation(2, "stop", json!({"sessionId":session,"invocationId":started["invocationId"]}), Uuid::new_v4()).await.unwrap();
        f.drained().await;
        assert!(f.session(&session).await.pending_interactions(&session).await.unwrap().is_empty());
        assert!(tokio::time::timeout(Duration::from_millis(50), first.accept()).await.is_err());
        assert_eq!(snapshot(&f).await["settings"]["enabled"], true);
        f.app.shutdown().await.unwrap(); f.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn native_web_request_binding_tracks_settings_provider_capabilities_and_private_key_revisions()
 {
    tokio::time::timeout(Duration::from_secs(30), async {
        let model = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = Fixture::with_services(&format!("http://{}/v1", model.local_addr().unwrap()), None, None, Some(service_tools::Setup::web())).await;

        let session = f.create("Web binding").await;
        f.send(&session).await.unwrap();

        let (mut socket, _) = model.accept().await.unwrap();
        let initial = request(&mut socket).await;

        assert!(!initial["tools"].to_string().contains("WebFetch"));
        let invocation = f.session(&session).await.session_projection::<StoredSessionConfiguration>(&session).await.unwrap().unwrap().root_turn.unwrap().invocation;
        let available = maka_tools::availability::Availability::new(f.owner.tools.clone(), maka_tools::availability::LoadedTools::temporary().unwrap());
        let execution_scope = f.session(&session).await.execution_scope(Some(f.owner.session(&session).await.unwrap().configuration.permission_basis())).await.unwrap();

        let execution = execution_scope.store().execution_custody().unwrap();
        let capture = |protocol, capable| {
            let available = &available; let invocation = invocation.clone(); let execution = execution.clone(); let cwd = f.workspace.to_str().unwrap().to_owned();
            async move { available.capture(Some(maka_agent_facts::tools::ModelToolContext { model: "fixture-model".into(), provider_tools: protocol,
                capabilities: maka_agent_facts::configuration::ModelCapabilities { web_search: Some(capable), ..Default::default() } }), invocation, Some(execution), cwd, CancellationToken::new()).await.unwrap().all() }
        };
        save(&f, Value::Null, true).await;
        for (protocol, expected) in [(maka_agent_facts::tools::ProviderToolProtocol::OpenaiResponses, "openai.web_search"), (maka_agent_facts::tools::ProviderToolProtocol::AnthropicMessages, "anthropic.web_search_20250305")] {
            let bound = capture(Some(protocol), true).await;
            let definition = bound.definitions().find(|tool| tool.name == "WebSearch").unwrap();
            assert_eq!(definition.provider.as_ref().unwrap().id, expected);
            assert!(bound.validate("WebSearch", &json!({"query":"test"})).is_err());
        }
        assert!(!capture(None, true).await.contains("WebSearch"));
        assert!(!capture(Some(maka_agent_facts::tools::ProviderToolProtocol::OpenaiResponses), false).await.contains("WebSearch"));
        let current = snapshot(&f).await;
        mutation(&f, "save", json!({"revision":current["revision"],"settings":{"enabled":true,"source":"tavily"}}), None).await;
        assert!(!capture(None, false).await.contains("WebSearch"));
        assert_eq!(mutation(&f, "saveKey", json!({"revision":null}), Some("   ")).await["kind"], "invalid_key");
        let saved = mutation(&f, "saveKey", json!({"revision":null}), Some("private-web-first-key")).await;
        assert_eq!(saved["snapshot"]["credential"]["configured"], true);
        let policy = f.config.runtime_policy().await.unwrap();
        f.config.set_privacy(policy.revision, maka_agent_facts::configuration::policy::PrivacyPolicy { incognito_active: true }).await.unwrap();
        assert_eq!(mutation(&f, "checkKey", json!({"revision":saved["snapshot"]["credential"]["revision"]}), None).await["kind"], "check_unavailable");
        assert!(!capture(None, false).await.contains("WebFetch"));
        assert!(!capture(None, false).await.contains("WebSearch"));
        let policy = f.config.runtime_policy().await.unwrap();
        f.config.set_privacy(policy.revision, maka_agent_facts::configuration::policy::PrivacyPolicy { incognito_active: false }).await.unwrap();

        assert_eq!(mutation(&f, "saveKey", json!({"revision":null}), Some("private-web-stale-key")).await["kind"], "changed");
        let bound = capture(None, false).await;
        assert!(bound.contains("WebSearch"));
        assert!(bound.definitions().find(|tool| tool.name == "WebSearch").unwrap().provider.is_none());
        let refreshed = mutation(&f, "saveKey", json!({"revision":saved["snapshot"]["credential"]["revision"]}), Some("private-web-second-key")).await;
        // A captured request cannot silently forward a newly replaced credential.
        let result = f.app.client().start(binding(&f).await, "capture".into(), json!({}), scope(&f.issuer, true), Attachments::new().into()).await.unwrap().result().await.unwrap();
        let mut old_basis = result["basis"].clone(); old_basis["credentialRevision"] = saved["snapshot"]["credential"]["revision"].clone();
        let rejected = mutation(&f, "search", json!({"basis":old_basis,"input":{"query":"must not contact external service","limit":1}}), None).await;
        assert_eq!(rejected["kind"], "failed");
        assert!(f.session(&session).await.pending_interactions(&session).await.unwrap().is_empty());
        mutation(&f, "deleteKey", json!({"revision":refreshed["snapshot"]["credential"]["revision"]}), None).await;
        assert!(!capture(None, false).await.contains("WebSearch"));

        response(&mut socket).await; f.drained().await;

        for path in f.runtime_databases() {
        let database = rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let mut statement = database.prepare("SELECT request_json || outcome_json || cleanup_json FROM application_operations").unwrap();
        for row in statement.query_map([], |row| row.get::<_, String>(0)).unwrap() {
            let row = row.unwrap(); assert!(!row.contains("private-web-"), "credential leaked into operation history");
        }
        }

        drop(execution_scope);
        f.app.shutdown().await.unwrap(); f.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn native_web_selected_model_search_crosses_the_actual_responses_request() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let server = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", server.local_addr().unwrap());
        let f = Fixture::with_services(&base, None, None, Some(service_tools::Setup::web())).await;
        let provider = json!({"packageId":maka_providers::api::ID,"entryId":maka_providers::api::ID,"scope":"profile","name":"openai-responses-compatible"});
        let catalog = f.config.catalog().await.unwrap();
        let CatalogMutationResult::Committed { connection: Some(basis), .. } = f.config.create_connection(serde_json::from_value(json!({
            "expectedCatalogRevision":catalog.revision,
            "connection":{"slug":"responses","name":"Responses", "provider":provider,
                "configuration":{"baseUrl":base},"enabled":true,"enabledModelIds":["fixture-model"],
                "modelOverrides":{"fixture-model":{"capabilities":{"chat":true,"webSearch":true}}}}
        })).unwrap()).await.unwrap() else { panic!("create Responses connection") };
        let maka_config::oauth::enrollment::LoginPreparation::Ready(ticket) = f.config.prepare_oauth_login(maka_agent_facts::oauth::LoginStart {
            expected_credential: None, attempt_id: Uuid::new_v4().to_string(),
            target: maka_agent_facts::oauth::Target::Existing {
                expected: ConnectionCredentialTarget { connection_id:basis.connection_id.clone(), revision:basis.revision,
                    provider:serde_json::from_value(provider).unwrap(), slug:"responses".into(), configuration:json!({"baseUrl":base}) },
                configuration:json!({"baseUrl":base}),
            },
            authentication:maka_agent_facts::provider::AuthenticationInput { method:"api-key".into(), input:json!({"apiKey":"fixture-responses-key"}) },
        }).await.unwrap() else { panic!("prepare credential") };
        assert!(ticket.claim().await.unwrap());
        assert!(matches!(ticket.complete(maka_agent_facts::provider::Credential { secret:"fixture-responses-key".into(), refresh_at:None }, 1).await.unwrap(), maka_config::oauth::enrollment::LoginCompletion::Committed(_)));
        let row = f.config.catalog().await.unwrap().connections.into_iter().find(|row|row.slug == "responses").unwrap();
        save(&f, Value::Null, true).await;
        let session = f.create("Selected model Web").await;
        f.mutation(2, "send", json!({"sessionId":session,"message":"Research Maka", "model": {"connectionId":row.connection_id,"revision":row.revision,"modelId":"fixture-model"}}), Uuid::new_v4()).await.unwrap();
        // The ordinary adapter tries its WebSocket lane before HTTP fallback.
        // This local provider explicitly supports HTTP only; no model request
        // has been dispatched during these upgrade attempts.
        for _ in 0..6 {
            let (mut socket, _) = server.accept().await.unwrap();
            let mut head = Vec::new();
            while !head.ends_with(b"\r\n\r\n") {
                head.push(socket.read_u8().await.unwrap());
                assert!(head.len() < 64 * 1024);
            }
            assert!(head.starts_with(b"GET /v1/responses "));
            socket.write_all(b"HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
        }
        let (mut socket, _) = server.accept().await.unwrap();
        let outgoing = request_with_key(&mut socket, "fixture-responses-key").await;
        assert!(outgoing["tools"].as_array().unwrap().iter().any(|tool| tool["type"] == "web_search"), "{outgoing}");
        assert!(!outgoing["tools"].as_array().unwrap().iter().any(|tool| tool["type"] == "function" && tool["name"] == "WebSearch"));
        let events = [
            json!({"type":"response.created","response":{"id":"resp_search","created_at":1,"model":"fixture-model"}}),
            json!({"type":"response.output_item.added","output_index":0,"item":{"type":"web_search_call","id":"search_1","status":"in_progress"}}),
            json!({"type":"response.output_item.done","output_index":0,"item":{"type":"web_search_call","id":"search_1","status":"completed","action":{"type":"search","query":"Maka"}}}),
            json!({"type":"response.output_item.added","output_index":1,"item":{"type":"message","id":"msg_1","role":"assistant","content":[]}}),
            json!({"type":"response.output_text.delta","item_id":"msg_1","output_index":1,"content_index":0,"delta":"Selected model search answer"}),
            json!({"type":"response.output_item.done","output_index":1,"item":{"type":"message","id":"msg_1","role":"assistant","content":[{"type":"output_text","text":"Selected model search answer","annotations":[]}]}}),
            json!({"type":"response.completed","response":{"id":"resp_search","output":[],"usage":{"input_tokens":2,"output_tokens":5}}}),
        ];
        let body: String = events.iter().map(|event| format!("event: {}\ndata: {event}\n\n", event["type"].as_str().unwrap())).collect();
        socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
        drop(socket);
        f.drained().await;
        let page = f.query("history", json!({"sessionId":session,"position":{"kind":"tail"}})).await.unwrap();
        assert!(page.to_string().contains("Selected model search answer"), "{page}");
        assert!(!service_tools::facts(&f, &session).await.iter().any(|fact|matches!(fact, Fact::ToolDispatched { name, .. } if name == "Http" || name == "WebSearch")));
        assert!(f.session(&session).await.pending_interactions(&session).await.unwrap().is_empty());
        f.app.shutdown().await.unwrap(); f.config.shutdown().await.unwrap();
    }).await.unwrap();
}
