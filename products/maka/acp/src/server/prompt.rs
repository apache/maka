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
    let peer = initialized.peer.clone();
    let capabilities = initialized.capabilities;
    let content = match request
        .prompt
        .into_iter()
        .map(crate::transport::v2::content)
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
    let cancellation = active.cancel.clone();
    let tasks = app.tasks.clone();
    tasks.spawn(async move {
        match Foreground::prepare(
            app.client.clone(),
            peer.clone(),
            session,
            active,
            capabilities,
            Prompt { content },
        )
        .await
        {
            Ok((id, foreground)) => {
                if responder
                    .respond(v2::schema::PromptResponse::new(id))
                    .is_err()
                {
                    cancellation.cancel();
                }
                let result = foreground.run().await;
                if let Err(error) = peer.complete(&session_id, result).await {
                    eprintln!("ACP completion: {error}");
                }
            }
            Err(error) => {
                let _ = responder.respond_with_error(
                    agent_client_protocol::Error::internal_error().data(error.to_string()),
                );
            }
        }
    });
    Ok(())
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
        let prepared = Foreground::prepare(
            app.client.clone(),
            peer.clone(),
            session,
            active,
            capabilities,
            Prompt { content },
        )
        .await;
        let result = match prepared {
            Ok((_, foreground)) => {
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
                    Ok(crate::presentation::Completion::Paused) => {
                        Err("Agent execution paused; continue in the Maka workbench".into())
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
