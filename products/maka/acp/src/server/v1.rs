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

use super::{App, input, prompt};
use crate::{
    interaction::Capabilities,
    transport::{self, Peer},
};
use agent_client_protocol::{
    Agent, Client, ConnectTo,
    schema::ProtocolVersion,
    v1::{self, Responder, schema as acp},
};
use std::sync::Arc;

pub(super) fn agent(app: Arc<App>) -> impl ConnectTo<Client> {
    let init = app.clone();
    let create = app.clone();
    let load = app.clone();
    let list = app.clone();
    let config = app.clone();
    let prompt = app.clone();
    let cancel = app.clone();
    let closed = app;
    Agent
        .v1()
        .name("maka")
        .on_receive_dispatch(
            async |message: v1::Dispatch, _cx: v1::ConnectionTo<Client>| {
                input::validate(message, |value| {
                    serde_json::from_value::<acp::ContentBlock>(value.clone()).is_ok()
                })
            },
            agent_client_protocol::on_receive_dispatch!(),
        )
        .on_receive_request(
            async move |request: acp::InitializeRequest,
                        responder: Responder<acp::InitializeResponse>,
                        cx: v1::ConnectionTo<Client>| {
                let capabilities = Capabilities {
                    form: request
                        .client_capabilities
                        .elicitation
                        .as_ref()
                        .is_some_and(acp::ElicitationCapabilities::supports_form),
                };
                init.initialize(capabilities, Peer::v1(cx, init.stop.clone()))?;
                responder.respond(
                    acp::InitializeResponse::new(ProtocolVersion::V1)
                        .agent_info(acp::Implementation::new("maka", env!("CARGO_PKG_VERSION")))
                        .agent_capabilities(
                            acp::AgentCapabilities::new()
                                .load_session(true)
                                .prompt_capabilities(
                                    acp::PromptCapabilities::new()
                                        .image(true)
                                        .embedded_context(true),
                                )
                                .session_capabilities(
                                    acp::SessionCapabilities::new()
                                        .list(acp::SessionListCapabilities::new()),
                                ),
                        ),
                )
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: acp::NewSessionRequest,
                        responder: Responder<acp::NewSessionResponse>,
                        _cx: v1::ConnectionTo<Client>| {
                let app = create.clone();
                create.dispatch(responder, async move {
                    let setup = app
                        .sessions
                        .create(&app.client, &app.initialized()?.peer, &request.cwd)
                        .await?;
                    Ok(acp::NewSessionResponse::new(setup.id)
                        .config_options(transport::v1::config(setup.options)))
                })
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: acp::LoadSessionRequest,
                        responder: Responder<acp::LoadSessionResponse>,
                        _cx: v1::ConnectionTo<Client>| {
                let app = load.clone();
                load.dispatch(responder, async move {
                    let setup = app
                        .sessions
                        .resume(
                            &app.client,
                            &app.initialized()?.peer,
                            &request.session_id.to_string(),
                            &request.cwd,
                            true,
                        )
                        .await?;
                    Ok(acp::LoadSessionResponse::new()
                        .config_options(transport::v1::config(setup.options)))
                })
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: acp::ListSessionsRequest,
                        responder: Responder<acp::ListSessionsResponse>,
                        _cx: v1::ConnectionTo<Client>| {
                let app = list.clone();
                list.dispatch(responder, async move {
                    let page = app
                        .sessions
                        .list(&app.client, request.cwd, request.cursor)
                        .await?;
                    Ok(transport::v1::list(page))
                })
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: acp::SetSessionConfigOptionRequest,
                        responder: Responder<acp::SetSessionConfigOptionResponse>,
                        _cx: v1::ConnectionTo<Client>| {
                let app = config.clone();
                config.dispatch(responder, async move {
                    let value = request
                        .value
                        .as_value_id()
                        .ok_or("Configuration requires a select value")?;
                    let options = app
                        .sessions
                        .set_config(
                            &app.client,
                            &app.initialized()?.peer,
                            &request.session_id.to_string(),
                            request.config_id.0.as_ref(),
                            value.0.as_ref(),
                        )
                        .await?;
                    Ok(acp::SetSessionConfigOptionResponse::new(
                        transport::v1::config(options),
                    ))
                })
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: acp::PromptRequest,
                        responder: Responder<acp::PromptResponse>,
                        _cx: v1::ConnectionTo<Client>| {
                prompt::v1(prompt.clone(), request, responder)
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_notification(
            async move |request: acp::CancelNotification, _cx: v1::ConnectionTo<Client>| {
                if let Ok(session) = cancel.sessions.get(&request.session_id.to_string()) {
                    session.cancel();
                }
                Ok(())
            },
            agent_client_protocol::on_receive_notification!(),
        )
        .on_close(async move |_cx| {
            closed.stop.cancel();
            closed.sessions.cancel_all();
            Ok(())
        })
}
