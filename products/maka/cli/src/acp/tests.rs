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

mod provider;
mod public_client;
mod support;

use agent_client_protocol::{
    Agent, ByteStreams, Client, V2ConnectionTo,
    schema::{ProtocolVersion, v2 as acp},
};
use serde_json::json;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sdk_nine_idle_sessions_can_close_and_resume_on_one_connection() {
    tokio::time::timeout(Duration::from_secs(40), async {
        let fixture = support::Fixture::open().await;
        let workspace = fixture.workspace.clone();
        let mut native = fixture.native;
        let mut model_requests = fixture.model_requests;
        let (sdk, facade) = tokio::io::duplex(1024);
        let (facade_read, facade_write) = tokio::io::split(facade);
        let serving = tokio::spawn(maka_acp::serve(
            fixture.client,
            facade_read,
            facade_write,
            tokio_util::sync::CancellationToken::new(),
        ));
        let (sdk_read, sdk_write) = tokio::io::split(sdk);
        let result = Client
            .v2()
            .connect_with(
                ByteStreams::new(sdk_write.compat_write(), sdk_read.compat()),
                async |connection| {
                    connection
                        .send_request(acp::InitializeRequest::new(
                            ProtocolVersion::V2,
                            acp::Implementation::new("maka-sdk-idle-sessions", "1"),
                        ))
                        .block_task()
                        .await?;
                    let mut sessions = Vec::new();
                    for _ in 0..9 {
                        let created = connection
                            .send_request(acp::NewSessionRequest::new(&workspace))
                            .block_task()
                            .await?;
                        sessions.push(created.session_id);
                    }
                    for id in &sessions {
                        connection
                            .send_request(acp::CloseSessionRequest::new(id.clone()))
                            .block_task()
                            .await?;
                    }
                    for id in &sessions {
                        connection
                            .send_request(acp::ResumeSessionRequest::new(id.clone(), &workspace))
                            .block_task()
                            .await?;
                    }
                    for id in &sessions {
                        connection
                            .send_request(acp::CloseSessionRequest::new(id.clone()))
                            .block_task()
                            .await?;
                    }
                    Ok(sessions)
                },
            )
            .await;
        // Settle the real owners even when the ninth request is rejected.
        tokio::time::timeout(Duration::from_secs(10), serving)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        native.close().await.unwrap();
        fixture.stop.cancel();
        fixture.server.await.unwrap().unwrap();
        assert!(
            matches!(
                model_requests.try_recv(),
                Err(mpsc::error::TryRecvError::Empty)
            ),
            "idle session lifecycle must not invoke the model"
        );
        drop(fixture.provider);
        let sessions = result.expect("nine idle sessions must create, close, resume and close");
        let unique: std::collections::HashSet<_> = sessions.into_iter().collect();
        assert_eq!(unique.len(), 9);
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sdk_published_directory_depth_uses_path_progress() {
    tokio::time::timeout(Duration::from_secs(40), async {
        let fixture = support::Fixture::open().await;
        let root = fixture.workspace.clone();
        let marker = maka_fs_tools::workspace::MARKER_FILE;
        let original_root_marker = std::fs::read(root.join(marker)).unwrap();
        let mut leaf = root.clone();
        let mut intermediate = Vec::new();
        for _ in 0..65 {
            leaf.push("d");
            std::fs::create_dir(&leaf).unwrap();
            intermediate.push(leaf.clone());
        }
        let (leaf, directory_identity) = maka_fs_tools::directory::capture(&leaf).unwrap();
        // This contained alias sorts before the real child. Traversal must make
        // canonical path progress rather than repeatedly selecting the root.
        #[cfg(unix)]
        std::os::unix::fs::symlink(&root, root.join("a-loop")).unwrap();
        let mut native = fixture.native;
        let (sdk, facade) = tokio::io::duplex(1024);
        let (facade_read, facade_write) = tokio::io::split(facade);
        let serving = tokio::spawn(maka_acp::serve(
            fixture.client,
            facade_read,
            facade_write,
            tokio_util::sync::CancellationToken::new(),
        ));
        let (sdk_read, sdk_write) = tokio::io::split(sdk);
        let sdk_result = Client
            .v2()
            .connect_with(
                ByteStreams::new(sdk_write.compat_write(), sdk_read.compat()),
                async |connection| {
                    let initialized = connection
                        .send_request(acp::InitializeRequest::new(
                            ProtocolVersion::V2,
                            acp::Implementation::new("maka-sdk-deep-cwd", "1"),
                        ))
                        .block_task()
                        .await?;
                    // Keep the original failure as data: baseline cannot select the
                    // physical leaf, but must still close the real ACP/Host owners.
                    let created = connection
                        .send_request(acp::NewSessionRequest::new(&leaf))
                        .block_task()
                        .await;
                    if let Ok(created) = &created {
                        connection
                            .send_request(acp::CloseSessionRequest::new(created.session_id.clone()))
                            .block_task()
                            .await?;
                    }
                    Ok((initialized, created))
                },
            )
            .await;
        let created_id = sdk_result
            .as_ref()
            .ok()
            .and_then(|(_, created)| created.as_ref().ok())
            .map(|created| created.session_id.to_string());
        let observed = if let Some(session) = &created_id {
            Some(support::query(&native, "agent", "observe", json!({"sessionId":session})).await)
        } else {
            None
        };
        let workspace_identity = maka_fs_tools::workspace::read_identity(&leaf);
        tokio::time::timeout(Duration::from_secs(10), serving)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        native.close().await.unwrap();
        fixture.stop.cancel();
        fixture.server.await.unwrap().unwrap();
        drop(fixture.provider);

        assert_eq!(leaf.strip_prefix(&root).unwrap().components().count(), 65);
        assert!(leaf.to_str().unwrap().len() <= 4096);
        assert_eq!(
            std::fs::read(root.join(marker)).unwrap(),
            original_root_marker
        );
        for path in intermediate.iter().take(64) {
            assert!(
                !path.join(marker).exists(),
                "ACP initialized an intermediate directory: {path:?}"
            );
        }
        let (initialized, created) = sdk_result.expect("real ACP SDK connection must settle");
        assert_eq!(initialized.protocol_version, ProtocolVersion::V2);
        let created = created.expect("NewSession must select the physical depth65 cwd");
        let observed = observed.unwrap();
        assert_eq!(observed["session"]["id"], created.session_id.to_string());
        let workspace: maka_agent_api::contract::Workspace =
            serde_json::from_value(observed["session"]["workspace"].clone()).unwrap();
        assert_eq!(workspace.path, leaf.to_str().unwrap());
        assert_eq!(workspace.directory_identity, directory_identity);
        assert_eq!(workspace.identity, workspace_identity.unwrap());
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sdk_acceptance_precedes_model_completion_and_resume_replays_canonical_ids() {
    tokio::time::timeout(Duration::from_secs(40), scenario(false))
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sdk_cancel_settles_the_admitted_turn_without_accepting_a_busy_prompt() {
    tokio::time::timeout(Duration::from_secs(40), scenario(true))
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sdk_form_answer_is_durable_before_the_model_receives_its_tool_result() {
    tokio::time::timeout(Duration::from_secs(40), form_scenario())
        .await
        .unwrap();
}

async fn form_scenario() {
    use sqlx::{Connection, SqliteConnection, sqlite::SqliteConnectOptions};
    use std::collections::BTreeMap;
    use tokio::sync::oneshot;

    let fixture = support::Fixture::open().await;
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
    Client.v2().on_receive_notification(
        async move |notification: acp::UpdateSessionNotification, _: V2ConnectionTo<Agent>| {
            updates.send(notification.update).await.map_err(agent_client_protocol::Error::into_internal_error)
        }, agent_client_protocol::on_receive_notification!(),
    ).on_receive_request(
        async move |request: acp::CreateElicitationRequest, responder, _connection| {
            let (reply, answer) = oneshot::channel();
            callbacks.send((request, reply)).await.map_err(agent_client_protocol::Error::into_internal_error)?;
            responder.respond(answer.await.map_err(agent_client_protocol::Error::into_internal_error)?)
        }, agent_client_protocol::on_receive_request!(),
    ).connect_with(ByteStreams::new(sdk_write.compat_write(), sdk_read.compat()), async |connection| {
        connection.send_request(acp::InitializeRequest::new(ProtocolVersion::V2,
            acp::Implementation::new("maka-sdk-form", "1")).capabilities(acp::ClientCapabilities::new()
                .elicitation(acp::ElicitationCapabilities::new().form(acp::ElicitationFormCapabilities::new()))))
            .block_task().await?;
        connection.send_request(acp::ResumeSessionRequest::new(session.as_str(), workspace)).block_task().await?;
        connection.send_request(acp::PromptRequest::new(session.as_str(), vec![acp::ContentBlock::Text(
            acp::TextContent::new("Ask me which answer to use."))])).block_task().await?;
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
        assert_eq!(support::until_idle(&mut receive, &mut live).await, Some(acp::StopReason::EndTurn));
        let rows = support::canonical(&native, &session).await;
        let result = rows.iter().find(|row| row.role == maka_agent_ports::session::history::Role::ToolResult && row.tool.as_ref().is_some_and(|tool| tool.tool_use_id == tool_id))
            .expect("canonical tool result for the SDK callback identity");
        assert!(!result.tool.as_ref().unwrap().result.as_ref().unwrap().is_error);
        assert!(result.text.contains("Beta"));
        assert!(live.iter().any(|update| {
            let acp::SessionUpdate::ToolCallUpdate(tool) = update else { return false; };
            tool.tool_call_id.to_string() == tool_id && serde_json::to_value(tool).unwrap()["status"] == "completed"
        }), "the same tool must be visibly complete before idle");
        connection.send_request(acp::CloseSessionRequest::new(session.as_str())).block_task().await?;
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

async fn scenario(cancel: bool) {
    let fixture = support::Fixture::open().await;
    let (provider, mut model_requests) = (fixture.provider, fixture.model_requests);
    let mut native = fixture.native;
    let session = fixture.session.clone();
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
    let (send, mut receive) = mpsc::channel::<acp::SessionUpdate>(128);
    Client.v2().on_receive_notification(
        async move |notification: acp::UpdateSessionNotification, _: V2ConnectionTo<Agent>| {
            send.send(notification.update).await.map_err(agent_client_protocol::Error::into_internal_error)
        },
        agent_client_protocol::on_receive_notification!(),
    ).connect_with(ByteStreams::new(sdk_write.compat_write(), sdk_read.compat()), async |connection| {
        let initialized = connection.send_request(acp::InitializeRequest::new(
            ProtocolVersion::V2, acp::Implementation::new("maka-sdk-acceptance", "1"),
        )).block_task().await?;
        assert_eq!(initialized.protocol_version, ProtocolVersion::V2);
        connection.send_request(acp::ResumeSessionRequest::new(session.as_str(), workspace.clone()))
            .block_task().await?;
        let accepted = tokio::time::timeout(Duration::from_secs(5), connection.send_request(
            acp::PromptRequest::new(session.as_str(), vec![acp::ContentBlock::Text(acp::TextContent::new("Explain the fixture."))]),
        ).block_task()).await.expect("prompt acceptance waited for model completion")?;
        let request = model_requests.recv().await.expect("model request after acceptance");
        let admitted = support::query(&native, "agent", "observe", json!({"sessionId":session})).await;
        let invocation = admitted["run"]["invocationId"].as_str().unwrap().to_owned();
        let mut reply = Some(request.reply);
        // The provider is now gated on this explicit reply. Neither prompt
        // acceptance nor busy rejection can rely on finishing the model call.
        assert!(!accepted.message_id.to_string().is_empty());
        let busy = connection.send_request(acp::PromptRequest::new(
            session.as_str(), vec![acp::ContentBlock::Text(acp::TextContent::new("Must not be inserted."))],
        )).block_task().await;
        assert!(busy.is_err(), "a foreground prompt must exclude another admission");
        let mut live = Vec::new();
        while let Ok(update) = receive.try_recv() {
            assert!(!matches!(update, acp::SessionUpdate::StateUpdate(acp::StateUpdate::Idle(_))), "idle arrived while model response remained gated");
            live.push(update);
        }
        if cancel {
            connection.send_notification(acp::CancelSessionNotification::new(session.as_str()))?;
        } else {
            reply.take().unwrap().send(json!({"index":0,"delta":{"reasoning_content":"Check the evidence.","content":"The fixture is correct."},"finish_reason":"stop"})).unwrap();
        }
        let stop = support::until_idle(&mut receive, &mut live).await;
        if let Some(reply) = reply {
            let _ = reply.send(json!({"index":0,"delta":{},"finish_reason":"stop"}));
        }
        assert_eq!(stop, Some(if cancel { acp::StopReason::Cancelled } else { acp::StopReason::EndTurn }));
        let rows = support::canonical(&native, &session).await;
        let users: Vec<_> = rows.iter().filter(|row| row.role == maka_agent_ports::session::history::Role::User).collect();
        assert_eq!(users.len(), 1, "busy rejection must not insert a second user message");
        assert_eq!(users[0].message_id, accepted.message_id.to_string());
        let observed = support::query(&native, "agent", "observe", json!({"sessionId":session})).await;
        assert_eq!(observed["session"]["activity"], "idle");
        let execution = support::query(&native, "agent", "execution", json!({"sessionId":session,"invocationId":invocation})).await;
        assert_eq!(execution["execution"]["state"], if cancel { "cancelled" } else { "completed" }, "ACP idle requires the original physical execution receipt");
        let live_messages = support::messages(&live);
        assert_eq!(live_messages.get(&("user_message".into(), accepted.message_id.to_string())).map(String::as_str), Some("Explain the fixture."));
        if !cancel {
            use maka_agent_ports::session::history::Role;
use maka_agent_ports::session::history::HistoryField;
            let assistant: Vec<_> = rows.iter().filter(|row| row.role == Role::Assistant).collect();
            assert_eq!(assistant.iter().filter(|row| row.field == HistoryField::Body).map(|row| row.text.as_str()).collect::<String>(), "The fixture is correct.");
            assert_eq!(assistant.iter().filter(|row| row.field == HistoryField::Thinking).map(|row| row.text.as_str()).collect::<String>(), "Check the evidence.");
            for row in assistant {
                let (kind, id) = match row.field { HistoryField::Body => ("agent_message", row.message_id.clone()), HistoryField::Thinking => ("agent_thought", format!("thinking:{}", row.message_id)) };
                if !row.text.is_empty() { assert_eq!(live_messages.get(&(kind.into(), id)).map(String::as_str), Some(row.text.as_str())); }
            }
        }
        // Close waits for the foreground's subscription cleanup, then resume
        // must reproduce the same canonical messages on this SDK connection.
        connection.send_request(acp::CloseSessionRequest::new(session.as_str())).block_task().await?;
        let mut replay = Vec::new();
        while let Ok(update) = receive.try_recv() { replay.push(update); }
        assert!(replay.is_empty(), "foreground emitted output after idle");
        connection.send_request(acp::ResumeSessionRequest::new(session.as_str(), workspace)
            .replay_from(acp::ReplayFrom::Start(acp::ReplayFromStart::new())))
            .block_task().await?;
        // A typed close request is an SDK dispatch fence after replay delivery.
        connection.send_request(acp::CloseSessionRequest::new(session.as_str())).block_task().await?;
        while let Ok(update) = receive.try_recv() { replay.push(update); }
        assert_eq!(support::messages(&replay), live_messages);
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
