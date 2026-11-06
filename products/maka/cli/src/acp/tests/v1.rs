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

use super::support;
use agent_client_protocol::{
    Agent, ByteStreams, Client,
    schema::ProtocolVersion,
    v1::{self, schema as acp},
};
use serde_json::json;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn prompt_waits_for_completion_and_load_replays_without_duplicate_text() {
    let fixture = support::Fixture::open().await;
    tokio::time::timeout(Duration::from_secs(40), scenario(fixture, false))
        .await
        .unwrap();
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancel_waits_for_physical_settlement_and_busy_prompts_are_not_inserted() {
    let fixture = support::Fixture::open().await;
    tokio::time::timeout(Duration::from_secs(40), scenario(fixture, true))
        .await
        .unwrap();
}

async fn scenario(fixture: support::Fixture, cancel: bool) {
    let (provider, mut model_requests) = (fixture.provider, fixture.model_requests);
    let mut native = fixture.native;
    let workspace = fixture.workspace.clone();
    let (sdk, facade) = tokio::io::duplex(1024);
    let (read, write) = tokio::io::split(facade);
    let serving = tokio::spawn(maka_acp::serve(
        fixture.client,
        read,
        write,
        tokio_util::sync::CancellationToken::new(),
    ));
    let (read, write) = tokio::io::split(sdk);
    let (send, mut updates) = mpsc::channel::<acp::SessionUpdate>(128);
    Client.v1().on_receive_notification(async move |notification:acp::SessionNotification,_:v1::ConnectionTo<Agent>| {
        send.send(notification.update).await.map_err(agent_client_protocol::Error::into_internal_error)
    },agent_client_protocol::on_receive_notification!()).connect_with(ByteStreams::new(write.compat_write(),read.compat()),async |connection| {
        let initialized=connection.send_request(acp::InitializeRequest::new(ProtocolVersion::V1)
            .client_info(acp::Implementation::new("lody-compatible-test","1"))).block_task().await?;
        assert_eq!(initialized.protocol_version,ProtocolVersion::V1);
        assert!(initialized.agent_capabilities.load_session);
        assert!(initialized.agent_capabilities.session_capabilities.list.is_some());
        let created=connection.send_request(acp::NewSessionRequest::new(workspace.clone())).block_task().await?;
        let session=created.session_id.to_string();
        assert!(created.config_options.as_ref().unwrap().iter().any(|o|o.id.to_string()=="model"));
        let configured=connection.send_request(acp::SetSessionConfigOptionRequest::new(
            created.session_id.clone(),"model",acp::SessionConfigOptionValue::value_id("default"))).block_task().await?;
        let model=configured.config_options.iter().find(|o|o.id.to_string()=="model").unwrap();
        assert_eq!(serde_json::to_value(model).unwrap()["currentValue"],"default");
        let listed=connection.send_request(acp::ListSessionsRequest::new()).block_task().await?;
        assert!(listed.sessions.iter().any(|s|s.session_id.to_string()==session));
        let pending=connection.send_request(acp::PromptRequest::new(created.session_id.clone(),vec!["Explain the fixture.".into()]));
        let response=pending.block_task();tokio::pin!(response);
        let request=tokio::select! {
            biased;
            result=&mut response=>panic!("v1 prompt completed while provider was still gated: {result:?}"),
            request=model_requests.recv()=>request.expect("model request"),
        };
        let busy=connection.send_request(acp::PromptRequest::new(created.session_id.clone(),vec!["Must not be inserted.".into()])).block_task().await;
        assert!(busy.is_err());
        let admitted=support::query(&native,"agent","observe",json!({"sessionId":session})).await;
        let invocation=admitted["run"]["invocationId"].as_str().unwrap().to_owned();
        let mut reply = Some(request.reply);
        if cancel {
            connection.send_notification(acp::CancelNotification::new(created.session_id.clone()))?;
        } else {
            reply.take().unwrap().send(json!({"index":0,"delta":{"reasoning_content":"Check the evidence.","content":"The fixture is correct."},"finish_reason":"stop"})).unwrap();
        }
        let completed=response.await?;
        if let Some(reply)=reply { let _=reply.send(json!({"index":0,"delta":{},"finish_reason":"stop"})); }
        assert_eq!(completed.stop_reason,if cancel {acp::StopReason::Cancelled}else{acp::StopReason::EndTurn});
        let execution=support::query(&native,"agent","execution",json!({"sessionId":session,"invocationId":invocation})).await;
        assert_eq!(execution["execution"]["state"],if cancel {"cancelled"}else{"completed"});
        let rows=support::canonical(&native,&session).await;
        let users:Vec<_>=rows.iter().filter(|row|row.role==maka_agent_ports::session::history::Role::User).collect();
        assert_eq!(users.iter().map(|row|row.text.as_str()).collect::<Vec<_>>(),vec!["Explain the fixture."]);
        // The following request fences all notifications sent before completion.
        connection.send_request(acp::ListSessionsRequest::new()).block_task().await?;
        let mut live=Vec::new();while let Ok(update)=updates.try_recv() { live.push(update); }
        if !cancel {
            assert_eq!(text(&live,false),"The fixture is correct.");
            assert_eq!(text(&live,true),"Check the evidence.");
        }
        connection.send_request(acp::LoadSessionRequest::new(created.session_id,workspace)).block_task().await?;
        connection.send_request(acp::ListSessionsRequest::new()).block_task().await?;
        let mut replay=Vec::new();while let Ok(update)=updates.try_recv() { replay.push(update); }
        assert_eq!(text(&replay,false),text(&live,false));
        assert_eq!(text(&replay,true),text(&live,true));
        Ok(())
    }).await.unwrap();
    tokio::time::timeout(Duration::from_secs(10), serving)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    native.close().await.unwrap();
    fixture.stop.cancel();
    fixture.server.await.unwrap().unwrap();
    drop(provider);
}

fn text(updates: &[acp::SessionUpdate], thinking: bool) -> String {
    updates
        .iter()
        .filter_map(|update| match update {
            acp::SessionUpdate::AgentMessageChunk(chunk) if !thinking => Some(&chunk.content),
            acp::SessionUpdate::AgentThoughtChunk(chunk) if thinking => Some(&chunk.content),
            _ => None,
        })
        .filter_map(|block| match block {
            acp::ContentBlock::Text(text) => Some(text.text.as_str()),
            _ => None,
        })
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn form_answer_is_durable_and_tool_output_precedes_prompt_completion() {
    let fixture = support::Fixture::open().await;
    tokio::time::timeout(Duration::from_secs(40), form_scenario(fixture))
        .await
        .unwrap();
}

async fn form_scenario(fixture: support::Fixture) {
    use sqlx::{Connection, SqliteConnection, sqlite::SqliteConnectOptions};
    use std::collections::BTreeMap;
    use tokio::sync::oneshot;

    let session_database = fixture
        .database_containing(
            "SELECT EXISTS(SELECT 1 FROM session_control WHERE id=?)",
            &[&fixture.session],
        )
        .await;
    let mut database = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(&session_database)
            .read_only(true),
    )
    .await
    .unwrap();
    let (provider, mut model_requests) = (fixture.provider, fixture.model_requests);
    let mut native = fixture.native;
    let session = fixture.session.clone();
    let session_id = acp::SessionId::new(session.as_str());
    let workspace = fixture.workspace.clone();
    let (sdk, facade) = tokio::io::duplex(1024);
    let (facade_read, facade_write) = tokio::io::split(facade);
    let serving = tokio::spawn(maka_acp::serve(
        fixture.client,
        facade_read,
        facade_write,
        tokio_util::sync::CancellationToken::new(),
    ));
    let (sdk_read, sdk_write) = tokio::io::split(sdk);
    let (updates, mut receive) = mpsc::channel::<acp::SessionUpdate>(128);
    let (callbacks, mut forms) = mpsc::channel::<(
        acp::CreateElicitationRequest,
        oneshot::Sender<acp::CreateElicitationResponse>,
    )>(1);
    Client.v1().on_receive_notification(
        async move |notification: acp::SessionNotification, _: v1::ConnectionTo<Agent>| {
            updates.send(notification.update).await.map_err(agent_client_protocol::Error::into_internal_error)
        }, agent_client_protocol::on_receive_notification!(),
    ).on_receive_request(
        async move |request: acp::CreateElicitationRequest, responder, _connection| {
            let (reply, answer) = oneshot::channel();
            callbacks.send((request, reply)).await.map_err(agent_client_protocol::Error::into_internal_error)?;
            responder.respond(answer.await.map_err(agent_client_protocol::Error::into_internal_error)?)
        }, agent_client_protocol::on_receive_request!(),
    ).connect_with(ByteStreams::new(sdk_write.compat_write(), sdk_read.compat()), async |connection| {
        connection.send_request(acp::InitializeRequest::new(ProtocolVersion::V1).client_info(
            acp::Implementation::new("maka-sdk-form-v1", "1")).client_capabilities(acp::ClientCapabilities::new()
                .elicitation(acp::ElicitationCapabilities::new().form(acp::ElicitationFormCapabilities::new()))))
            .block_task().await?;
        connection.send_request(acp::LoadSessionRequest::new(session_id.clone(), workspace)).block_task().await?;
        let pending=connection.send_request(acp::PromptRequest::new(session_id.clone(), vec![acp::ContentBlock::Text(
            acp::TextContent::new("Ask me which answer to use."))])).block_task();
        tokio::pin!(pending);
        let first = model_requests.recv().await.unwrap();
        assert!(first.body["tools"].as_array().unwrap().iter().any(|tool| tool["function"]["name"] == "AskUserQuestion"));
        first.reply.send(json!({"index":0,"delta":{"role":"assistant","tool_calls":[{
            "index":0,"id":"sdk-question","type":"function","function":{"name":"AskUserQuestion",
            "arguments":json!({"questions":[{"question":"Choose the answer", "options":[{"label":"Alpha"},{"label":"Beta"}]}]}).to_string()}
        }]},"finish_reason":"tool_calls"})).unwrap();
        let (form, answer) = forms.recv().await.expect("typed SDK form callback");
        let acp::ElicitationMode::Form(form) = form.mode else { panic!("expected form mode"); };
        let acp::ElicitationScope::Session(scope) = form.scope else { panic!("expected session scope"); };
        assert_eq!(scope.session_id.to_string(), session.as_str());
        let tool_id = scope.tool_call_id.expect("form must identify the dispatched tool").to_string();
        let requests: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM interaction_requests").fetch_one(&mut database).await.unwrap();
        assert_eq!(requests, 1, "the form callback must come from a durable Host interaction");
        let before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM interaction_outcomes").fetch_one(&mut database).await.unwrap();
        assert_eq!(before, 0, "a published callback is still awaiting the SDK answer");
        assert!(model_requests.try_recv().is_err(), "the model cannot consume an unanswered tool result");
        answer.send(acp::CreateElicitationResponse::new(acp::ElicitationAcceptAction::new()
            .content(BTreeMap::from([("question_0".into(), acp::ElicitationContentValue::from("Beta"))])))).unwrap();
        let next = model_requests.recv().await.expect("model resumes after SDK response");
        let model_tool = next.body["messages"].as_array().unwrap().iter()
            .find(|message| message["role"] == "tool").expect("tool answer supplied to model");
        assert!(model_tool["content"].as_str().unwrap().contains("Beta"));
        let outcomes: Vec<String> = sqlx::query_scalar("SELECT outcome_json FROM interaction_outcomes")
            .fetch_all(&mut database).await.unwrap();
        assert_eq!(outcomes.len(), 1, "the SDK callback settles exactly one authoritative answer");
        let outcome: serde_json::Value = serde_json::from_str(&outcomes[0]).unwrap();
        assert_eq!(outcome["kind"], "question_answer");
        assert_eq!(outcome["answers"], json!(["Beta"]));
        next.reply.send(json!({"index":0,"delta":{"content":"Selected Beta."},"finish_reason":"stop"})).unwrap();
        let mut live = Vec::new();
        assert_eq!(pending.await?.stop_reason,acp::StopReason::EndTurn);
        connection.send_request(acp::ListSessionsRequest::new()).block_task().await?;
        while let Ok(update)=receive.try_recv() { live.push(update); }
        let rows = support::canonical(&native, &session).await;
        let result = rows.iter().find(|row| row.role == maka_agent_ports::session::history::Role::ToolResult && row.tool.as_ref().is_some_and(|tool| tool.tool_use_id == tool_id))
            .expect("canonical tool result for the SDK callback identity");
        assert!(!result.tool.as_ref().unwrap().result.as_ref().unwrap().is_error);
        assert!(result.text.contains("Beta"));
        assert!(live.iter().any(|update| {
            let acp::SessionUpdate::ToolCallUpdate(tool) = update else { return false; };
            tool.tool_call_id.to_string() == tool_id && serde_json::to_value(tool).unwrap()["status"] == "completed"
        }), "the same tool must be visibly complete before idle");
        connection.send_request(acp::ListSessionsRequest::new()).block_task().await?;
        Ok(())
    }).await.unwrap();
    tokio::time::timeout(Duration::from_secs(10), serving)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    native.close().await.unwrap();
    fixture.stop.cancel();
    fixture.server.await.unwrap().unwrap();
    database.close().await.unwrap();
    drop(provider);
}
