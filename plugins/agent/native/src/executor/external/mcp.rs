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

//! Conversation endpoint and invocation-bound catalog, credentials and transport sessions.
use super::*;
use axum::{
    Router, extract::Request as HttpRequest, http::StatusCode, response::IntoResponse, routing::any,
};
use rmcp::{
    RoleServer, ServerHandler,
    model::*,
    service::RequestContext,
    transport::streamable_http_server::{
        StreamableHttpServerConfig, StreamableHttpService,
        session::{SessionManager, local::LocalSessionManager},
    },
};
use std::sync::{Mutex, Weak};
use tokio::sync::Notify;

type Service = StreamableHttpService<Handler, LocalSessionManager>;
struct Route {
    bridge: Arc<Bridge>,
    service: Service,
}
struct EndpointState {
    route: Option<Arc<Route>>,
    active: Weak<Bridge>,
    retired: bool,
}
pub(super) struct Endpoint {
    pub session_id: String,
    address: std::net::SocketAddr,
    url: String,
    state: Mutex<EndpointState>,
    server_stop: CancellationToken,
    server: tokio::sync::Mutex<Option<tokio::task::JoinHandle<std::io::Result<()>>>>,
}
impl Endpoint {
    pub async fn open(session_id: String) -> Result<Arc<Self>, Error> {
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .map_err(|e| Error::Provider(e.to_string()))?;
        let address = listener
            .local_addr()
            .map_err(|e| Error::Provider(e.to_string()))?;
        let endpoint = Arc::new(Self {
            session_id,
            address,
            url: format!("http://{address}/mcp"),
            state: Mutex::new(EndpointState {
                route: None,
                active: Weak::new(),
                retired: false,
            }),
            server_stop: CancellationToken::new(),
            server: tokio::sync::Mutex::new(None),
        });
        let weak = Arc::downgrade(&endpoint);
        let router = Router::new().route(
            "/mcp",
            any(move |request: HttpRequest| {
                let weak = weak.clone();
                async move {
                    let Some(endpoint) = weak.upgrade() else {
                        return StatusCode::GONE.into_response();
                    };
                    // Capture authority before reading the body or waiting on transport I/O.
                    let route = {
                        let state = endpoint.state.lock().expect("MCP endpoint lock poisoned");
                        state
                            .route
                            .as_ref()
                            .filter(|route| {
                                !state.retired
                                    && request
                                        .headers()
                                        .get("authorization")
                                        .and_then(|h| h.to_str().ok())
                                        .is_some_and(|h| {
                                            h.strip_prefix("Bearer ") == Some(route.bridge.bearer())
                                        })
                            })
                            .cloned()
                    };
                    let Some(route) = route else {
                        return StatusCode::UNAUTHORIZED.into_response();
                    };
                    route.handle(request).await
                }
            }),
        );
        let stopped = endpoint.server_stop.clone();
        *endpoint.server.lock().await = Some(tokio::spawn(async move {
            axum::serve(listener, router)
                .with_graceful_shutdown(stopped.cancelled_owned())
                .await
        }));
        Ok(endpoint)
    }
    pub async fn local_addr(&self) -> Result<std::net::SocketAddr, Error> {
        let server = self.server.lock().await;
        if self.server_stop.is_cancelled()
            || self
                .state
                .lock()
                .expect("MCP endpoint lock poisoned")
                .retired
            || !server.as_ref().is_some_and(|task| !task.is_finished())
        {
            return Err(Error::Retired);
        }
        Ok(self.address)
    }
    pub fn bind(
        self: &Arc<Self>,
        tools: tools::Tools,
        directory: PathBuf,
    ) -> Result<Arc<Bridge>, Error> {
        let definitions = tools.definitions();
        let mut state = self.state.lock().expect("MCP endpoint lock poisoned");
        if state.retired || self.server_stop.is_cancelled() {
            return Err(Error::Retired);
        }
        if state
            .active
            .upgrade()
            .is_some_and(|bridge| !bridge.drained())
        {
            return Err(Error::Invalid(
                "Previous Host MCP scope has not drained".into(),
            ));
        }
        let bridge = Arc::new(Bridge {
            tools,
            endpoint: Arc::downgrade(self),
            catalog: definitions,
            state: Mutex::new(Admission {
                phase: Phase::Opening,
                pending: 0,
                requests: 0,
                handlers: 0,
                failure: None,
            }),
            changed: Notify::new(),
            cancelled: CancellationToken::new(),
            failed: CancellationToken::new(),
            listed: CancellationToken::new(),
            url: self.url.clone(),
            directory,
            token: format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple()),
            sessions_stop: CancellationToken::new(),
            manager: Arc::new(LocalSessionManager::default()),
            closing: tokio::sync::Mutex::new(()),
        });
        let weak = Arc::downgrade(&bridge);
        let mut config = StreamableHttpServerConfig::default();
        config.legacy_session_mode = true;
        config.json_response = true;
        config.max_request_body_bytes = runtime::MAX_MESSAGE_BYTES;
        config.cancellation_token = bridge.sessions_stop.clone();
        let service = StreamableHttpService::new(
            move || {
                weak.upgrade()
                    .map(Handler::new)
                    .ok_or_else(|| std::io::Error::other("MCP scope retired"))
            },
            bridge.manager.clone(),
            config,
        );
        state.active = Arc::downgrade(&bridge);
        state.route = Some(Arc::new(Route {
            bridge: bridge.clone(),
            service,
        }));
        Ok(bridge)
    }
    pub async fn finish(&self) -> Result<(), Error> {
        let bridge = {
            let mut state = self.state.lock().expect("MCP endpoint lock poisoned");
            state.retired = true;
            state.active.upgrade()
        };
        let drained = match bridge {
            Some(bridge) => {
                // Business failures belong to the canonical effect receipt. Only
                // still-live Host resources prevent this transport's retirement.
                let _business = bridge.close().await;
                bridge.drained()
            }
            None => true,
        };
        self.server_stop.cancel();
        let mut server = self.server.lock().await;
        if let Some(task) = server.as_mut() {
            tokio::time::timeout(Duration::from_secs(5), task)
                .await
                .map_err(|_| Error::CleanupUnconfirmed)?
                .map_err(|_| Error::CleanupUnconfirmed)?
                .map_err(|_| Error::CleanupUnconfirmed)?;
            *server = None;
        }
        if !drained {
            return Err(Error::CleanupUnconfirmed);
        }
        Ok(())
    }
}
impl Drop for Endpoint {
    fn drop(&mut self) {
        self.server_stop.cancel();
    }
}
impl Route {
    async fn handle(&self, request: HttpRequest) -> axum::response::Response {
        let Some(_request) = self.bridge.begin_request() else {
            return StatusCode::UNAUTHORIZED.into_response();
        };
        let work = async {
            // Newer stateless MCP revisions must not silently ignore a stale session header.
            if let Some(id) = request.headers().get("mcp-session-id") {
                let Ok(id) = id.to_str() else {
                    return StatusCode::BAD_REQUEST.into_response();
                };
                match self.bridge.manager.has_session(&id.to_owned().into()).await {
                    Ok(true) => {}
                    Ok(false) => return StatusCode::NOT_FOUND.into_response(),
                    Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
                }
            }
            self.service.handle(request).await.into_response()
        };
        tokio::select! { biased;
            () = self.bridge.cancelled.cancelled() => StatusCode::UNAUTHORIZED.into_response(),
            response = work => response,
        }
    }
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Opening,
    Open,
    Closed,
}
struct Admission {
    phase: Phase,
    pending: usize,
    requests: usize,
    handlers: usize,
    failure: Option<Error>,
}
impl Admission {
    fn idle(&self) -> bool {
        self.pending == 0 && self.requests == 0
    }
}
struct RequestGuard(Arc<Bridge>);
impl Drop for RequestGuard {
    fn drop(&mut self) {
        self.0
            .state
            .lock()
            .expect("MCP admission lock poisoned")
            .requests -= 1;
        self.0.changed.notify_waiters();
    }
}
pub(super) struct Bridge {
    tools: tools::Tools,
    endpoint: Weak<Endpoint>,
    catalog: Vec<Value>,
    state: Mutex<Admission>,
    changed: Notify,
    pub cancelled: CancellationToken,
    pub failed: CancellationToken,
    pub listed: CancellationToken,
    pub url: String,
    directory: PathBuf,
    token: String,
    sessions_stop: CancellationToken,
    manager: Arc<LocalSessionManager>,
    closing: tokio::sync::Mutex<()>,
}
impl maka_agent_ports::executor::RootSettlementOwner for Bridge {
    fn original_root_cleanup(&self) -> OperationCleanup {
        if self.drained() {
            OperationCleanup::Confirmed
        } else {
            OperationCleanup::Unconfirmed
        }
    }
    fn original_root_cleanup_signal(self: Arc<Self>) -> BoxFuture<'static, ()> {
        Box::pin(async move {
            loop {
                let notified = self.changed.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                if self.drained() {
                    return;
                }
                notified.await;
            }
        })
    }
}

impl Bridge {
    fn begin_request(self: &Arc<Self>) -> Option<RequestGuard> {
        let mut state = self.state.lock().expect("MCP admission lock poisoned");
        if state.phase == Phase::Closed {
            return None;
        }
        state.requests += 1;
        Some(RequestGuard(self.clone()))
    }
    pub fn bearer(&self) -> &str {
        &self.token
    }
    pub fn directory(&self) -> &std::path::Path {
        &self.directory
    }
    pub fn definitions(&self) -> &[Value] {
        &self.catalog
    }
    pub fn claude(&self) -> Value {
        serde_json::json!({"mcpServers":{"maka":{"type":"http","url":self.url,"headers":{"Authorization":format!("Bearer {}", self.token)}}}})
    }
    pub async fn finish_turn(&self) {
        self.tools.finish_signal().cancelled().await;
        // Let successful calls return before the native interrupt closes their transport.
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if self
                .state
                .lock()
                .expect("MCP admission lock poisoned")
                .idle()
            {
                return;
            }
            changed.await;
        }
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
        self.changed.notify_waiters();
    }
    pub async fn close(&self) -> Result<(), Error> {
        let _closing = self.closing.lock().await;
        self.close_admission();
        if let Some(endpoint) = self.endpoint.upgrade() {
            let mut state = endpoint.state.lock().expect("MCP endpoint lock poisoned");
            if state
                .route
                .as_ref()
                .is_some_and(|route| std::ptr::eq(route.bridge.as_ref(), self))
            {
                state.route = None;
            }
        }
        loop {
            let changed = self.changed.notified();
            if self
                .state
                .lock()
                .expect("MCP admission lock poisoned")
                .idle()
            {
                break;
            }
            changed.await;
        }
        self.sessions_stop.cancel();
        let close_sessions = async {
            let ids: Vec<_> = self.manager.sessions.read().await.keys().cloned().collect();
            for id in ids {
                self.manager
                    .close_session(&id)
                    .await
                    .map_err(|_| Error::CleanupUnconfirmed)?;
            }
            // LocalSessionManager::close_session enqueues Close; handler drop proves worker exit.
            loop {
                let changed = self.changed.notified();
                if self
                    .state
                    .lock()
                    .expect("MCP admission lock poisoned")
                    .handlers
                    == 0
                {
                    break;
                }
                changed.await;
            }
            Ok::<_, Error>(())
        };
        tokio::time::timeout(Duration::from_secs(5), close_sessions)
            .await
            .map_err(|_| Error::CleanupUnconfirmed)??;
        self.state
            .lock()
            .expect("MCP admission lock poisoned")
            .failure
            .clone()
            .map_or(Ok(()), Err)
    }
    pub(super) fn drained(&self) -> bool {
        let state = self.state.lock().expect("MCP admission lock poisoned");
        state.phase == Phase::Closed && state.idle() && state.handlers == 0
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
                bridge.changed.notify_waiters();
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
struct Handler(Arc<Bridge>);
impl Handler {
    fn new(bridge: Arc<Bridge>) -> Self {
        bridge
            .state
            .lock()
            .expect("MCP admission lock poisoned")
            .handlers += 1;
        Self(bridge)
    }
}
impl Clone for Handler {
    fn clone(&self) -> Self {
        Self::new(self.0.clone())
    }
}
impl Drop for Handler {
    fn drop(&mut self) {
        self.0
            .state
            .lock()
            .expect("MCP admission lock poisoned")
            .handlers -= 1;
        self.0.changed.notify_waiters();
    }
}
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
        let result = serde_json::from_value(serde_json::json!({"tools":self.0.definitions()}))
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
