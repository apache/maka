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
use maka_host_runtime::application::ServiceTarget;

fn tools(confirmation: contract::ToolConfirmation) -> Vec<contract::ServiceTool> {
    [("observe", "SessionRead"), ("metadata", "SessionUpdate")]
        .into_iter()
        .map(|(method, name)| contract::ServiceTool {
            nestable: false,
            input: contract::ToolInput::Json,
            presentation: None,
            title: None,
            result: contract::ToolResult::Json,
            confirmation,
            name: name.into(),
            description: "Manage a conversation through its existing Session API.".into(),
            target: ServiceTarget::Export {
                name: EXPORT.into(),
            },
            method: method.into(),
        })
        .collect()
}

#[tokio::test]
async fn queued_message_with_own_session_tools_resumes_after_host_restart() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut fixture = Fixture::configured(
            &format!("http://{}/v1", listener.local_addr().unwrap()),
            None,
            None,
            None,
            |settings| settings.tools = tools(contract::ToolConfirmation::Preapproved),
        )
        .await;
        let session = fixture.create("Continue after restart").await;
        fixture.send(&session).await.unwrap();
        let (mut running_socket, _) = listener.accept().await.unwrap();
        request(&mut running_socket).await;
        let queued = fixture
            .mutation(
                2,
                "send",
                json!({
                    "sessionId":session, "message":"Continue this queued request after restart",
                    "model":fixture.selection().await,
                }),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
        assert_eq!(queued["kind"], "queued");
        let deployment = fixture.app.source().unwrap().deployment;
        fixture.app.shutdown().await.unwrap();
        drop(running_socket);
        fixture.store.recover_invocations().await.unwrap();
        let mut commits = fixture.session(&session).await.subscribe_commits().unwrap();
        let mut native = NativeRegistry::default();
        provide_all(&mut native).unwrap();
        maka_settings_native::provide(&mut native, bundled_catalog()).unwrap();
        fixture.app = Application::start_from_store(
            fixture.store.clone(),
            deployment,
            native,
            fixture.issuer.clone(),
            Arc::new(Grant(fixture.issuer.clone(), None)),
            Some(maka_host_js::factory(Default::default())),
        )
        .await
        .unwrap();
        fixture.app.ready().await.unwrap();
        let mut socket = loop {
            let work = fixture
                .query(
                    "work",
                    json!({"sessionId":session,
                "target":{"kind":"message","messageId":queued["messageId"]}}),
                )
                .await
                .unwrap();
            assert_ne!(
                work["execution"]["state"], "failed",
                "queued request failed after restart: {work}"
            );
            tokio::select! {
                socket = listener.accept() => break socket.unwrap().0,
                changed = commits.changed() => changed.unwrap(),
            }
        };
        let sent = request(&mut socket).await;
        assert!(
            sent["messages"]
                .as_array()
                .unwrap()
                .iter()
                .any(|message| message["role"] == "user"
                    && message["content"] == "Continue this queued request after restart")
        );
        response(&mut socket).await;
        loop {
            let work = fixture
                .query(
                    "work",
                    json!({"sessionId":session,
                "target":{"kind":"message","messageId":queued["messageId"]}}),
                )
                .await
                .unwrap();
            if work["execution"]["state"] == "completed" {
                break;
            }
            assert_ne!(
                work["execution"]["state"], "failed",
                "restored execution failed: {work}"
            );
            commits.changed().await.unwrap();
        }
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn own_session_service_keeps_mutation_receipts_and_deduplicates_original_calls() {
    let fixture = Fixture::configured("http://127.0.0.1:1/v1", None, None, None, |settings| {
        settings.tools = tools(contract::ToolConfirmation::Preapproved);
    })
    .await;
    let target = fixture.create("Original conversation").await;
    let service = ServiceTarget::Export {
        name: EXPORT.into(),
    };
    let request = fixture
        .services
        .request(
            Identity::Remote {
                request_id: Uuid::new_v4(),
            },
            CancellationToken::new(),
        )
        .unwrap();
    let observed = request
        .call_target(
            &service,
            "observe".into(),
            json!({"sessionId":target}),
            Attachments::new(),
        )
        .unwrap()
        .await
        .unwrap();
    assert_eq!(observed["session"]["title"], "Original conversation");
    let input = json!({"sessionId":target,"expectedRevision":observed["session"]["revision"],"title":"Renamed by its own service","labels":["managed"]});
    let operation = Uuid::new_v4();
    let first = request
        .mutate_target(
            &service,
            "metadata".into(),
            input.clone(),
            operation,
            Attachments::new(),
        )
        .unwrap()
        .await
        .unwrap();
    let replay = request
        .mutate_target(
            &service,
            "metadata".into(),
            input,
            operation,
            Attachments::new(),
        )
        .unwrap()
        .await
        .unwrap();
    assert_eq!(first, replay);
    let Receipt::Recorded {
        outcome: OperationOutcome::Returned { value },
        ..
    } = &first.receipt
    else {
        panic!("own mutation must have a recorded result: {first:?}");
    };
    assert_eq!(value["kind"], "committed");
    assert_eq!(value["session"]["title"], "Renamed by its own service");
    let recovered = request
        .recover(first.reference.clone())
        .unwrap()
        .await
        .unwrap()
        .unwrap();
    assert_eq!(recovered.reference, first.reference);
    assert_eq!(
        &recovered.outcome,
        match &first.receipt {
            Receipt::Recorded { outcome, .. } => outcome,
            _ => unreachable!(),
        }
    );
    let final_state = fixture
        .query("observe", json!({"sessionId":target}))
        .await
        .unwrap();
    assert_eq!(final_state["session"]["labels"], json!(["managed"]));
    assert_eq!(
        final_state["session"]["revision"],
        value["session"]["revision"]
    );
    request.finish().await.unwrap();
    fixture.app.shutdown().await.unwrap();
    fixture.config.shutdown().await.unwrap();
}

#[tokio::test]
async fn model_projects_own_session_api_and_resumes_after_required_confirmation() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let fixture = Fixture::configured(&format!("http://{}/v1", listener.local_addr().unwrap()), None, None, None, |settings| {
            settings.tools = tools(contract::ToolConfirmation::Required);
            settings.tools[0].confirmation = contract::ToolConfirmation::Preapproved;
        }).await;
        let target = fixture.create("Conversation to manage").await;
        let caller = fixture.create("Coordinator").await;
        let observed = fixture.query("observe", json!({"sessionId":target})).await.unwrap();
        fixture.send(&caller).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        let sent = request(&mut socket).await;
        let names: Vec<_> = sent["tools"].as_array().unwrap().iter().map(|tool| tool["function"]["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["SessionRead", "SessionUpdate"]);
        service_tools::named_tool_response(&mut socket, "SessionRead", json!({"sessionId":target})).await;
        let (mut socket, _) = listener.accept().await.unwrap();
        let sent = request(&mut socket).await;
        assert!(sent["messages"].to_string().contains("Conversation to manage"));
        service_tools::named_tool_response(&mut socket, "SessionUpdate", json!({"sessionId":target,"expectedRevision":observed["session"]["revision"],"title":"Approved conversation title","labels":[]})).await;
        let approval = service_tools::pending_approval(&fixture, &caller).await;
        assert_eq!(fixture.query("observe", json!({"sessionId":target})).await.unwrap()["session"]["title"], "Conversation to manage");
        fixture.mutation(2, "respond", json!({"sessionId":caller,"requestId":approval.request_id,"answer":{"kind":"service_approval","decision":"allow"}}), Uuid::new_v4()).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        let sent = request(&mut socket).await;
        assert!(sent["messages"].to_string().contains("Approved conversation title"));
        response(&mut socket).await;
        fixture.drained().await;
        assert_eq!(fixture.query("observe", json!({"sessionId":target})).await.unwrap()["session"]["title"], "Approved conversation title");
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn session_send_returns_to_caller_while_the_existing_target_keeps_working() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let fixture = Fixture::configured(&format!("http://{}/v1", listener.local_addr().unwrap()), None, None, None, |settings| {
            let mut send = tools(contract::ToolConfirmation::Preapproved).remove(0);
            send.name = "SessionSend".into();
            send.method = "send".into();
            let mut create = send.clone();
            create.name = "SessionCreate".into();
            create.method = "create".into();
            settings.tools = vec![create, send];
        }).await;
        let target = fixture.create("Existing task").await;
        let mut input = fixture.create_input("Coordinator").await;
        input["tools"] = json!(["SessionCreate", "SessionSend"]);
        let caller = fixture.mutation(2, "create", input, Uuid::new_v4()).await.unwrap()["session"]["id"].as_str().unwrap().to_owned();
        fixture.send(&caller).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        service_tools::named_tool_response(&mut socket, "SessionCreate", json!({
            "title":"Created task", "labels":[], "workspace":{"kind":"session","sessionId":caller},
        })).await;
        let (mut socket, _) = listener.accept().await.unwrap();
        let sent = request(&mut socket).await;
        let created: Value = serde_json::from_str(sent["messages"].as_array().unwrap().iter().rev()
            .find(|message| message["role"] == "tool").unwrap()["content"].as_str().unwrap()).unwrap();
        assert_eq!(created["session"]["parentSessionId"], caller);
        assert_eq!(created["session"]["tools"], json!(["SessionCreate", "SessionSend"]));
        let child = created["session"]["id"].as_str().unwrap();
        let observed = fixture.query("observe", json!({"sessionId":child})).await.unwrap();
        let updated = fixture.mutation(2, "metadata", json!({
            "sessionId":child, "expectedRevision":observed["session"]["revision"],
            "title":"Renamed child", "labels":[],
        }), Uuid::new_v4()).await.unwrap();
        assert_eq!(updated["session"]["parentSessionId"], caller);
        let listed = fixture.query("list", json!({"filter":"all","position":{"kind":"start"}})).await.unwrap();
        assert_eq!(listed["sessions"].as_array().unwrap().iter()
            .find(|session| session["id"] == child).unwrap()["parentSessionId"], caller);
        service_tools::named_tool_response(&mut socket, "SessionSend", json!({
            "sessionId":target, "message":"Continue the existing task", "model":fixture.selection().await,
        })).await;
        let mut target_socket = None;
        let mut caller_socket = None;
        for _ in 0..2 {
            let (mut socket, _) = listener.accept().await.unwrap();
            let sent = request(&mut socket).await;
            if sent["messages"].as_array().unwrap().iter().any(|message| message["role"] == "tool") {
                assert!(sent["messages"].to_string().contains("started"));
                caller_socket = Some(socket);
            } else {
                assert!(sent["messages"].to_string().contains("Continue the existing task"));
                target_socket = Some(socket);
            }
        }
        let mut caller_socket = caller_socket.expect("caller resumes before the target returns");
        let mut target_socket = target_socket.expect("existing target starts its admitted message");
        response(&mut caller_socket).await;
        response(&mut target_socket).await;
        fixture.drained().await;
        assert_eq!(fixture.query("observe", json!({"sessionId":target})).await.unwrap()["session"]["parentSessionId"], Value::Null);
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
    }).await.unwrap();
}
