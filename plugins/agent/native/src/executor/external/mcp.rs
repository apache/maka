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

//! Invocation-bound MCP transport. Detached admitted calls retain original Host custody.
use super::*;
use axum::{
    Router,
    extract::Request as HttpRequest,
    http::StatusCode,
    middleware::{self, Next},
    response::IntoResponse,
};
use rmcp::{
    RoleServer, ServerHandler,
    model::*,
    service::RequestContext,
    transport::streamable_http_server::{
        StreamableHttpServerConfig, StreamableHttpService, session::local::LocalSessionManager,
    },
};
use std::sync::Mutex;
use tokio::sync::Notify;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Opening,
    Open,
    Closed,
}
struct Admission {
    phase: Phase,
    pending: usize,
    failure: Option<Error>,
}
pub(super) struct Bridge {
    tools: tools::Tools,
    state: Mutex<Admission>,
    changed: Notify,
    pub cancelled: CancellationToken,
    pub failed: CancellationToken,
    pub listed: CancellationToken,
    pub url: String,
    token: String,
    server_stop: CancellationToken,
    sessions_stop: CancellationToken,
    server: tokio::sync::Mutex<Option<tokio::task::JoinHandle<std::io::Result<()>>>>,
}
impl Bridge {
    pub async fn open(tools: tools::Tools) -> Result<Arc<Self>, Error> {
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .map_err(|e| Error::Provider(e.to_string()))?;
        let address = listener
            .local_addr()
            .map_err(|e| Error::Provider(e.to_string()))?;
        let bridge = Arc::new(Self {
            tools,
            state: Mutex::new(Admission {
                phase: Phase::Opening,
                pending: 0,
                failure: None,
            }),
            changed: Notify::new(),
            cancelled: CancellationToken::new(),
            failed: CancellationToken::new(),
            listed: CancellationToken::new(),
            url: format!("http://{address}/mcp"),
            token: format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple()),
            server_stop: CancellationToken::new(),
            sessions_stop: CancellationToken::new(),
            server: tokio::sync::Mutex::new(None),
        });
        let factory = bridge.clone();
        let mut config = StreamableHttpServerConfig::default();
        config.legacy_session_mode = false;
        config.json_response = true;
        config.max_request_body_bytes = runtime::MAX_MESSAGE_BYTES;
        config.cancellation_token = bridge.sessions_stop.clone();
        let service = StreamableHttpService::new(
            move || Ok(Handler(factory.clone())),
            Arc::new(LocalSessionManager::default()),
            config,
        );
        let auth = bridge.clone();
        let router = Router::new()
            .nest_service("/mcp", service)
            .layer(middleware::from_fn(
                move |request: HttpRequest, next: Next| {
                    let auth = auth.clone();
                    async move {
                        let valid = request
                            .headers()
                            .get("authorization")
                            .and_then(|h| h.to_str().ok())
                            .is_some_and(|header| {
                                header.strip_prefix("Bearer ") == Some(auth.token.as_str())
                            });
                        let open = auth
                            .state
                            .lock()
                            .expect("MCP admission lock poisoned")
                            .phase
                            != Phase::Closed;
                        if !valid || !open {
                            return StatusCode::UNAUTHORIZED.into_response();
                        }
                        next.run(request).await
                    }
                },
            ));
        let stopped = bridge.server_stop.clone();
        *bridge.server.lock().await = Some(tokio::spawn(async move {
            axum::serve(listener, router)
                .with_graceful_shutdown(stopped.cancelled_owned())
                .await
        }));
        Ok(bridge)
    }
    pub fn bearer(&self) -> &str {
        &self.token
    }
    pub fn acp(&self) -> Value {
        serde_json::json!({"type":"http","name":"maka","url":self.url,"headers":[{"name":"Authorization","value":format!("Bearer {}",self.token)}]})
    }
    pub fn claude(&self) -> Value {
        serde_json::json!({"mcpServers":{"maka":{"type":"http","url":self.url,"headers":{"Authorization":format!("Bearer {}", self.token)}}}})
    }
    pub fn admit(&self) -> Result<(), Error> {
        let mut state = self.state.lock().expect("MCP admission lock poisoned");
        if state.phase == Phase::Closed {
            return Err(Error::Cancelled);
        }
        state.phase = Phase::Open;
        Ok(())
    }
    pub fn close_admission(&self) {
        self.state
            .lock()
            .expect("MCP admission lock poisoned")
            .phase = Phase::Closed;
        self.cancelled.cancel();
    }
    pub async fn close(&self) -> Result<(), Error> {
        self.close_admission();
        loop {
            let changed = self.changed.notified();
            if self
                .state
                .lock()
                .expect("MCP admission lock poisoned")
                .pending
                == 0
            {
                break;
            }
            changed.await;
        }
        self.server_stop.cancel();
        let server = { self.server.lock().await.take() };
        if let Some(mut server) = server {
            let result = match tokio::time::timeout(std::time::Duration::from_secs(4), &mut server)
                .await
            {
                Ok(result) => result,
                Err(_) => {
                    self.sessions_stop.cancel();
                    match tokio::time::timeout(std::time::Duration::from_secs(1), &mut server).await
                    {
                        Ok(result) => result,
                        Err(_) => {
                            *self.server.lock().await = Some(server);
                            return Err(Error::CleanupUnconfirmed);
                        }
                    }
                }
            };
            result
                .map_err(|_| Error::CleanupUnconfirmed)?
                .map_err(|_| Error::CleanupUnconfirmed)?;
        }
        self.sessions_stop.cancel();
        match self
            .state
            .lock()
            .expect("MCP admission lock poisoned")
            .failure
            .take()
        {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
    async fn call(
        self: &Arc<Self>,
        request: CallToolRequestParams,
        client_cancel: CancellationToken,
    ) -> Result<CallToolResponse, rmcp::ErrorData> {
        let (send, receive) = tokio::sync::oneshot::channel();
        {
            let mut state = self.state.lock().expect("MCP admission lock poisoned");
            if state.phase != Phase::Open {
                return Err(rmcp::ErrorData::invalid_request(
                    "Host tool admission closed",
                    None,
                ));
            }
            state.pending += 1;
            let bridge = self.clone();
            let call_cancel = self.cancelled.child_token();
            let work = self.tools.invoke(
                request.name.into_owned(),
                Value::Object(request.arguments.unwrap_or_default()),
                call_cancel.clone(),
            );
            // This worker survives client cancellation/disconnect. Only its original outcome settles T1.
            tokio::spawn(async move {
                let mut work = AssertUnwindSafe(work).catch_unwind();
                let result = tokio::select! {
                    result = &mut work => result,
                    () = client_cancel.cancelled() => { call_cancel.cancel(); work.await },
                };
                let (reply, fatal) = result.unwrap_or_else(|_| (
                    serde_json::json!({"isError":true,"content":[{"type":"text","text":"Host tool outcome is unknown"}]}),
                    Some(Error::Unknown),
                ));
                {
                    let mut state = bridge.state.lock().expect("MCP admission lock poisoned");
                    if let Some(fatal) = fatal {
                        if state.failure.is_none() || matches!(fatal, Error::CleanupUnconfirmed) {
                            state.failure = Some(fatal);
                        }
                        state.phase = Phase::Closed;
                        bridge.failed.cancel();
                        bridge.cancelled.cancel();
                    }
                    state.pending -= 1;
                }
                let _ = send.send(reply);
                bridge.changed.notify_one();
            });
        }
        let reply = receive
            .await
            .map_err(|_| rmcp::ErrorData::internal_error("Host tool owner lost", None))?;
        serde_json::from_value::<CallToolResult>(reply)
            .map(Into::into)
            .map_err(|_| rmcp::ErrorData::internal_error("Invalid Host tool projection", None))
    }
}
#[derive(Clone)]
struct Handler(Arc<Bridge>);
impl ServerHandler for Handler {
    fn get_info(&self) -> ServerConfig {
        let mut info = ServerConfig::default();
        info.capabilities = ServerCapabilities::builder().enable_tools().build();
        info
    }
    async fn list_tools(
        &self,
        _: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, rmcp::ErrorData> {
        let result =
            serde_json::from_value(serde_json::json!({"tools":self.0.tools.definitions()}))
                .map_err(|_| rmcp::ErrorData::internal_error("Invalid Host catalog", None));
        if result.is_ok() {
            self.0.listed.cancel();
        }
        result
    }
    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, rmcp::ErrorData> {
        self.0.call(request, context.ct).await
    }
}
