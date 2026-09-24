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

use super::App;
use crate::foreground::{Foreground, Prompt};
use agent_client_protocol::{Client, Responder, V2ConnectionTo, schema::v2 as acp};
use std::{sync::Arc, time::Duration};

pub(super) fn dispatch(
    app: Arc<App>,
    request: acp::PromptRequest,
    responder: Responder<acp::PromptResponse>,
    cx: V2ConnectionTo<Client>,
) -> agent_client_protocol::Result<()> {
    let capabilities = match app.initialized() {
        Ok(capabilities) => capabilities,
        Err(error) => {
            return responder.respond_with_error(
                agent_client_protocol::Error::invalid_request().data(error.to_string()),
            );
        }
    };
    // Reserve before returning to SDK dispatch so a following
    // cancel (including in the same batch) cannot miss this work.
    let reserved = app
        .sessions
        .get(&request.session_id.to_string())
        .and_then(|session| session.enter(&app.stop).map(|active| (session, active)));
    let (session, active) = match reserved {
        Ok(reserved) => reserved,
        Err(error) => {
            return responder.respond_with_error(
                agent_client_protocol::Error::invalid_params().data(error.to_string()),
            );
        }
    };
    let cancellation = active.cancel.clone();
    let session_id = session.id.clone();
    let peer = app.peer(cx);
    let tasks = app.tasks.clone();
    tasks.spawn(async move {
        let turn_id = uuid::Uuid::new_v4().to_string();
        let preparing = Foreground::prepare(
            app.client.clone(), peer, &app.routes, session, active, capabilities,
            Prompt { turn_id: turn_id.clone(), content: request.prompt },
        );
        tokio::pin!(preparing);
        let result = match tokio::time::timeout(Duration::from_secs(15), &mut preparing).await {
            Ok(result) => {
                let response = match &result {
                    Ok((id, _)) => responder.respond(acp::PromptResponse::new(id.clone())),
                    Err(error) => responder.respond_with_error(
                        agent_client_protocol::Error::internal_error().data(error.to_string()),
                    ),
                };
                if response.is_err() { cancellation.cancel(); }
                result
            }
            Err(_) => {
                // Timeout ends this RPC wait, not the original Host receipt.
                // Connection shutdown supplies the bounded settlement deadline.
                let data = serde_json::json!({
                    "message": "Admission timed out; retaining the original receipt for cancellation",
                    "sessionId": session_id,
                    "turnId": turn_id,
                });
                let _ = responder.respond_with_error(
                    agent_client_protocol::Error::internal_error().data(data),
                );
                cancellation.cancel();
                preparing.await
            }
        };
        match result {
            Ok((_, foreground)) => foreground.run().await,
            Err(error) => eprintln!("ACP prompt: {error}"),
        }
    });
    Ok(())
}
