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
use crate::foreground::{Admission, Foreground};
use agent_client_protocol::{v1, v2};
use std::sync::Arc;

pub(super) fn dispatch(
    app: Arc<App>,
    request: v2::schema::PromptRequest,
    responder: v2::Responder<v2::schema::PromptResponse>,
) -> agent_client_protocol::Result<()> {
    let initialized = match app.initialized() {
        Ok(i) => i,
        Err(e) => {
            return responder.respond_with_error(
                agent_client_protocol::Error::invalid_request().data(e.to_string()),
            );
        }
    };
    let session = match app.sessions.get(&request.session_id.0) {
        Ok(session) => session,
        Err(e) => {
            return responder.respond_with_error(
                agent_client_protocol::Error::invalid_params().data(e.to_string()),
            );
        }
    };
    let registration = match session.prompt(request.idempotency_key.as_ref(), &app.stop) {
        Ok(registration) => registration,
        Err(e) => return responder.respond_with_error(e),
    };
    let peer = initialized.peer.clone();
    let capabilities = initialized.capabilities;
    let tasks = app.tasks.clone();
    tasks.spawn(async move {
        use crate::session::prompt::Registration;
        use agent_client_protocol::Error;
        let mut leader = match registration {
            Registration::Retry(retry) => {
                if let Err(error) = responder
                    .respond_with_result(retry.wait().await.map(v2::schema::PromptResponse::new))
                {
                    eprintln!("ACP retry response: {error}");
                }
                return;
            }
            Registration::First(leader) => leader,
        };
        let session_id = session.id.clone();
        let result = async {
            if let Some(key) = &request.idempotency_key {
                // A known attempt bypasses foreground admission and attachment I/O.
                let recorded: Option<String> = app
                    .client
                    .query(
                        "agent",
                        "lookupSubmission",
                        serde_json::json!({
                            "sessionId":session.id, "idempotencyKey":key
                        }),
                    )
                    .await
                    .map_err(|e| Error::internal_error().data(e.to_string()))?;
                if let Some(id) = recorded {
                    Foreground::wait_inserted(&app.client, &session.id, &id, None, &leader.cancel)
                        .await
                        .map_err(prompt_error)?;
                    return Ok((id, None));
                }
            }
            let content = request
                .prompt
                .into_iter()
                .map(crate::transport::v2::content)
                .collect::<Result<_, _>>()
                .map_err(|e| Error::invalid_params().data(e.to_string()))?;
            let active = leader.enter().await?;
            Admission {
                client: app.client.clone(),
                peer: peer.clone(),
                session,
                active,
                capabilities,
            }
            .v2(content, request.idempotency_key)
            .await
            .map_err(prompt_error)
        }
        .await;
        let (outcome, foreground) = match result {
            Ok((id, foreground)) => (Ok(id), foreground),
            Err(e) => (Err(e), None),
        };
        let cancel = leader.cancel.clone();
        let outcome = leader.publish(outcome);
        if let Err(error) =
            responder.respond_with_result(outcome.map(v2::schema::PromptResponse::new))
        {
            eprintln!("ACP prompt response: {error}");
            cancel.cancel();
        }
        if let Some(mut foreground) = foreground {
            let result = foreground.run().await;
            if let Err(error) = peer.complete(&session_id, result).await {
                eprintln!("ACP completion: {error}");
            }
        }
    });
    Ok(())
}

fn prompt_error(error: crate::Error) -> agent_client_protocol::Error {
    match error.downcast::<agent_client_protocol::Error>() {
        Ok(protocol) => *protocol,
        Err(error) => agent_client_protocol::Error::internal_error().data(error.to_string()),
    }
}

pub(super) fn v1(
    app: Arc<App>,
    request: v1::schema::PromptRequest,
    responder: v1::Responder<v1::schema::PromptResponse>,
) -> agent_client_protocol::Result<()> {
    let initialized = match app.initialized() {
        Ok(i) => i,
        Err(e) => {
            return responder.respond_with_error(
                agent_client_protocol::Error::invalid_request().data(e.to_string()),
            );
        }
    };
    let peer = initialized.peer.clone();
    let capabilities = initialized.capabilities;
    let content = match request
        .prompt
        .into_iter()
        .map(crate::transport::v1::content)
        .collect::<Result<_, _>>()
    {
        Ok(c) => c,
        Err(e) => {
            return responder.respond_with_error(
                agent_client_protocol::Error::invalid_params().data(e.to_string()),
            );
        }
    };
    let reserved = app
        .sessions
        .get(&request.session_id.to_string())
        .and_then(|session| session.enter(&app.stop).map(|active| (session, active)));
    let (session, active) = match reserved {
        Ok(pair) => pair,
        Err(e) => {
            return responder.respond_with_error(
                agent_client_protocol::Error::invalid_params().data(e.to_string()),
            );
        }
    };
    let session_id = session.id.clone();
    let tasks = app.tasks.clone();
    tasks.spawn(async move {
        let prepared = Admission {
            client: app.client.clone(),
            peer: peer.clone(),
            session,
            active,
            capabilities,
        }
        .v1(content)
        .await;
        let result = match prepared {
            Ok(mut foreground) => {
                let result = foreground.run().await;
                peer.reset(&session_id);
                let response = match result {
                    Ok(crate::presentation::Completion::Completed) => Ok(
                        v1::schema::PromptResponse::new(v1::schema::StopReason::EndTurn),
                    ),
                    Ok(crate::presentation::Completion::Cancelled) => Ok(
                        v1::schema::PromptResponse::new(v1::schema::StopReason::Cancelled),
                    ),
                    Ok(crate::presentation::Completion::Failed) => {
                        Err("Agent execution failed; see transcript".into())
                    }
                    Err(error) => Err(error),
                };
                respond_v1(responder, response)
            }
            Err(error) => respond_v1(responder, Err(error)),
        };
        if let Err(error) = result {
            eprintln!("ACP completion: {error}");
        }
    });
    Ok(())
}

fn respond_v1(
    responder: v1::Responder<v1::schema::PromptResponse>,
    result: Result<v1::schema::PromptResponse, crate::Error>,
) -> agent_client_protocol::Result<()> {
    match result {
        Ok(response) => responder.respond(response),
        Err(error) => responder.respond_with_error(
            agent_client_protocol::Error::internal_error().data(error.to_string()),
        ),
    }
}
