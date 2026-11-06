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
use sdk::{Agent, ConnectTo};
use serde_json::json;
use std::time::Duration;

fn remote(protocol: ProtocolVersion) -> impl ConnectTo<sdk::Client> {
    let v1 = Agent.v1()
        .on_receive_request(
            async |_: acp_v1::InitializeRequest, responder, _| {
                responder.respond(acp_v1::InitializeResponse::new(ProtocolVersion::V1))
            }, sdk::on_receive_request!(),
        )
        .on_receive_request(
            async |_: acp_v1::NewSessionRequest, responder, _| {
                responder.respond(acp_v1::NewSessionResponse::new("remote-session"))
            }, sdk::on_receive_request!(),
        )
        .on_receive_request(
            async |request: acp_v1::PromptRequest, responder, peer: v1::ConnectionTo<sdk::Client>| {
                peer.clone().spawn(async move {
                let permission = peer.send_request(acp_v1::RequestPermissionRequest::new(
                    request.session_id.clone(),
                    acp_v1::ToolCallUpdate::new("read-file", acp_v1::ToolCallUpdateFields::new().title("Read file")),
                    vec![acp_v1::PermissionOption::new("allow", "Allow once", acp_v1::PermissionOptionKind::AllowOnce)],
                )).block_task().await?;
                assert!(matches!(permission.outcome, acp_v1::RequestPermissionOutcome::Selected(selected) if selected.option_id.to_string() == "allow"));
                peer.send_notification(acp_v1::SessionNotification::new(
                    request.session_id, acp_v1::SessionUpdate::AgentMessageChunk(acp_v1::ContentChunk::new("V1 output".into())),
                ))?;
                responder.respond(acp_v1::PromptResponse::new(acp_v1::StopReason::EndTurn))
                })
            }, sdk::on_receive_request!(),
        );
    let router = Agent.protocol_router().with_v1(v1);
    if protocol == ProtocolVersion::V1 {
        return router;
    }
    let v2 = Agent.v2()
        .on_receive_request(
            async |_: acp_v2::InitializeRequest, responder, _| {
                responder.respond(acp_v2::InitializeResponse::new(ProtocolVersion::V2,
                    acp_v2::Implementation::new("remote", "1")).capabilities(
                        acp_v2::AgentCapabilities::new().session(acp_v2::SessionCapabilities::new()),
                    ))
            }, sdk::on_receive_request!(),
        )
        .on_receive_request(
            async |_: acp_v2::NewSessionRequest, responder, _| {
                responder.respond(acp_v2::NewSessionResponse::new("remote-session"))
            }, sdk::on_receive_request!(),
        )
        .on_receive_request(
            async |request: acp_v2::PromptRequest, responder, peer: v2::ConnectionTo<sdk::Client>| {
                peer.clone().spawn(async move {
                responder.respond(acp_v2::PromptResponse::new("remote-message"))?;
                let permission = peer.send_request(acp_v2::RequestPermissionRequest::new(
                    request.session_id.clone(), "Read file",
                    vec![acp_v2::PermissionOption::new("allow", "Allow once", acp_v2::PermissionOptionKind::AllowOnce)],
                )).block_task().await?;
                assert!(matches!(permission.outcome, acp_v2::RequestPermissionOutcome::Selected(selected) if selected.option_id.to_string() == "allow"));
                peer.send_notification(acp_v2::UpdateSessionNotification::new(request.session_id.clone(),
                    acp_v2::SessionUpdate::AgentMessageChunk(acp_v2::ContentChunk::new("V2 output".into(), "answer"))))?;
                peer.send_notification(acp_v2::UpdateSessionNotification::new(request.session_id,
                    acp_v2::SessionUpdate::StateUpdate(acp_v2::StateUpdate::Idle(acp_v2::IdleStateUpdate::new().stop_reason(acp_v2::StopReason::EndTurn)))))
                })
            }, sdk::on_receive_request!(),
        );
    router.with_v2(v2)
}

#[tokio::test]
async fn v1_fallback_preserves_permission_callbacks_and_streamed_output() {
    tokio::time::timeout(Duration::from_secs(10), async {
        let (send, mut events) = mpsc::channel(32);
        let driver = tokio::spawn(connect(send, false, || remote(ProtocolVersion::V1)));
        let Event::Initialized(peer) = events.recv().await.unwrap() else {
            panic!("initialize must precede session events");
        };
        let Peer::V1(peer, initialized) = *peer else {
            panic!("v1-only remote must negotiate v1");
        };
        assert_eq!(initialized.protocol_version, ProtocolVersion::V1);
        let session = peer
            .send_request(acp_v1::NewSessionRequest::new(
                std::env::current_dir().unwrap(),
            ))
            .block_task()
            .await
            .unwrap();
        let pending = peer.send_request(acp_v1::PromptRequest::new(
            session.session_id.clone(),
            vec!["Read the file".into()],
        ));
        let Event::V1Permission(request, responder) = events.recv().await.unwrap() else {
            panic!("expected v1 permission callback");
        };
        assert_eq!(request.session_id, session.session_id);
        assert_eq!(request.tool_call.tool_call_id.to_string(), "read-file");
        responder
            .respond(acp_v1::RequestPermissionResponse::new(
                acp_v1::RequestPermissionOutcome::Selected(acp_v1::SelectedPermissionOutcome::new(
                    "allow",
                )),
            ))
            .unwrap();
        assert_eq!(
            pending.block_task().await.unwrap().stop_reason,
            acp_v1::StopReason::EndTurn
        );
        let Event::V1Update(update) = events.recv().await.unwrap() else {
            panic!("expected v1 streamed output");
        };
        assert_eq!(
            serde_json::to_value(update).unwrap()["update"]["content"]["text"],
            "V1 output"
        );
        driver.abort();
        assert!(driver.await.unwrap_err().is_cancelled());
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn v2_negotiation_preserves_acceptance_permission_and_independent_completion() {
    tokio::time::timeout(Duration::from_secs(10), async {
        let (send, mut events) = mpsc::channel(32);
        let driver = tokio::spawn(connect(send, false, || remote(ProtocolVersion::V2)));
        let Event::Initialized(peer) = events.recv().await.unwrap() else {
            panic!("initialize must precede session events");
        };
        let Peer::V2(peer, initialized) = *peer else {
            panic!("v2 remote must negotiate v2");
        };
        assert_eq!(initialized.protocol_version, ProtocolVersion::V2);
        let session = peer
            .send_request(acp_v2::NewSessionRequest::new(
                std::env::current_dir().unwrap(),
            ))
            .block_task()
            .await
            .unwrap();
        let accepted = peer
            .send_request(acp_v2::PromptRequest::new(
                session.session_id.clone(),
                vec!["Read the file".into()],
            ))
            .block_task()
            .await
            .unwrap();
        assert_eq!(accepted.message_id.to_string(), "remote-message");
        let Event::V2Permission(request, responder) = events.recv().await.unwrap() else {
            panic!("expected v2 permission callback");
        };
        assert_eq!(request.session_id, session.session_id);
        assert_eq!(request.title, "Read file");
        responder
            .respond(acp_v2::RequestPermissionResponse::new(
                acp_v2::RequestPermissionOutcome::Selected(acp_v2::SelectedPermissionOutcome::new(
                    "allow",
                )),
            ))
            .unwrap();
        let Event::V2Update(update) = events.recv().await.unwrap() else {
            panic!("expected v2 streamed output");
        };
        assert_eq!(
            serde_json::to_value(update).unwrap()["update"]["content"]["text"],
            "V2 output"
        );
        let Event::V2Update(update) = events.recv().await.unwrap() else {
            panic!("expected independent completion update");
        };
        assert_eq!(
            serde_json::to_value(update).unwrap()["update"],
            json!({"sessionUpdate":"state_update","state":"idle","stopReason":"end_turn"})
        );
        driver.abort();
        assert!(driver.await.unwrap_err().is_cancelled());
    })
    .await
    .unwrap();
}
