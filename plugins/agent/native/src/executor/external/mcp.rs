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
    catalog: Option<Arc<Vec<Value>>>,
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
    pub async fn open(
        session_id: String,
        definitions: Option<Vec<Value>>,
    ) -> Result<Arc<Self>, Error> {
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
                catalog: definitions.map(Arc::new),
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
        if state.catalog.as_ref().is_none_or(|catalog| {
            definitions
                .iter()
                .any(|definition| !catalog.contains(definition))
        }) {
            state.catalog = Some(Arc::new(definitions));
        }
        let bridge = Arc::new(Bridge {
            tools,
            endpoint: Arc::downgrade(self),
            catalog: state
                .catalog
                .as_ref()
                .expect("actual Call initialized the catalog")
                .clone(),
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
    catalog: Arc<Vec<Value>>,
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
#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn tools() -> (
        tempfile::TempDir,
        Arc<maka_event_log::root_store::SessionStore>,
        maka_event_log::root_store::SessionWorkLease,
        maka_event_log::root_store::WorkEffects,
    ) {
        let directory = tempfile::tempdir().unwrap();
        let owner = maka_event_log::root::RootOwner::create(
            &directory.path().join("root"),
            &maka_event_log::root::RootNamespaces {
                ownership: directory.path().join("owners"),
                control: directory.path().join("control"),
            },
        )
        .unwrap();
        let root = RootStore::open(Arc::new(owner), maka_event_log::ROOT_MIGRATIONS)
            .await
            .unwrap();
        let session = root
            .create_session("session", "test", &serde_json::json!({}), 1)
            .await
            .unwrap();
        let (lease, effects) = session
            .work_scope(None)
            .await
            .unwrap()
            .accept(CancellationToken::new());
        std::fs::create_dir(directory.path().join("native-inputs")).unwrap();
        (directory, Arc::new(lease.store()), lease, effects)
    }
    struct ListingEffects;
    impl tools::HostEffects for ListingEffects {
        fn invoke(
            &self,
            _: maka_tools::ToolCatalog,
            _: maka_agent_facts::tools::ToolCallContext,
            _: String,
            _: Value,
            _: CancellationToken,
        ) -> BoxFuture<
            'static,
            Result<
                maka_agent_facts::tool_output::ReturnedToolResult,
                maka_agent_facts::tools::ToolError,
            >,
        > {
            panic!("listing/catalog tests must never execute a Host effect")
        }
    }
    fn list_tools(
        store: &maka_event_log::root_store::SessionStore,
        catalog: maka_tools::ToolCatalog,
    ) -> tools::Tools {
        tools::Tools::for_test(
            catalog,
            maka_agent_facts::durable::ExecutionIdentity {
                session_id: "session".into(),
                turn_id: "list-only".into(),
                run_id: maka_agent_facts::durable::RunId::new(),
            },
            store.work_custody().unwrap(),
            maka_agent_facts::durable::ExternalTaskId::new(),
            maka_agent_facts::executor::Binding {
                executor_id: "external".to_owned().try_into().unwrap(),
                package_id: "list-only".into(),
                entry_id: "external".into(),
                activation: "list-only".into(),
            },
            Arc::new(ListingEffects),
        )
    }
    fn definition() -> Value {
        serde_json::json!({"name":"FrozenTool","description":"original","inputSchema":{"type":"object"}})
    }
    fn catalog(definitions: Vec<Value>) -> maka_tools::ToolCatalog {
        use maka_agent_facts::tools::{
            ToolExecutor, ToolFuture, ToolHandler, ToolNesting, ToolRegistration, ToolSemantics,
        };
        struct Listing(Vec<String>);
        impl ToolExecutor for Listing {
            fn names(&self) -> Vec<String> {
                self.0.clone()
            }
            fn invoke(&self, _: String, _: Value, _: CancellationToken) -> ToolFuture {
                panic!("listing tools does not execute them")
            }
        }
        let names = definitions
            .iter()
            .map(|value| value["name"].as_str().unwrap().to_owned())
            .collect();
        let handler = ToolHandler::Immediate(Arc::new(Listing(names)));
        maka_tools::ToolCatalog::new(definitions.into_iter().map(|definition| ToolRegistration {
            definition: serde_json::from_value(definition).unwrap(),
            nesting: ToolNesting::DirectOnly,
            semantics: ToolSemantics::Parallel,
            handler: handler.clone(),
        }))
        .unwrap()
    }
    fn initialize() -> Value {
        serde_json::json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{
            "protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"fixture","version":"1"}}})
    }
    async fn post(
        bridge: &Bridge,
        token: &str,
        session: Option<&str>,
        message: Value,
    ) -> (u16, String) {
        let address = bridge
            .url
            .strip_prefix("http://")
            .unwrap()
            .strip_suffix("/mcp")
            .unwrap();
        let mut socket = tokio::net::TcpStream::connect(address).await.unwrap();
        let body = message.to_string();
        let session = session
            .map(|id| format!("Mcp-Session-Id: {id}\r\n"))
            .unwrap_or_default();
        socket.write_all(format!("POST /mcp HTTP/1.1\r\nHost: {address}\r\nAuthorization: Bearer {token}\r\n{session}Content-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
        let mut response = String::new();
        tokio::time::timeout(Duration::from_secs(5), socket.read_to_string(&mut response))
            .await
            .unwrap()
            .unwrap();
        let status = response.split_whitespace().nth(1).unwrap().parse().unwrap();
        (status, response)
    }
    async fn initialized(bridge: &Bridge) -> String {
        let (status, response) = post(bridge, bridge.bearer(), None, initialize()).await;
        assert_eq!(status, 200, "{response}");
        let id = response
            .lines()
            .find_map(|line| {
                let (key, value) = line.split_once(':')?;
                key.eq_ignore_ascii_case("mcp-session-id")
                    .then(|| value.trim().to_owned())
            })
            .unwrap();
        let (status, response) = post(
            bridge,
            bridge.bearer(),
            Some(&id),
            serde_json::json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
        )
        .await;
        assert_eq!(status, 202, "{response}");
        id
    }
    #[tokio::test]
    async fn endpoint_is_stable_but_credentials_and_transport_authority_are_not_reusable() {
        let (_directory, store, lease, _effects) = tools().await;
        let endpoint = Endpoint::open("session".into(), Some(vec![definition()]))
            .await
            .unwrap();
        let first = endpoint
            .bind(
                list_tools(&store, Default::default()),
                _directory.path().join("native-inputs"),
            )
            .unwrap();
        let config_directory = first.directory().to_owned();
        let first_id = initialized(&first).await;
        let list = serde_json::json!({"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}});
        let (status, response) = post(&first, first.bearer(), Some(&first_id), list.clone()).await;
        assert_eq!(status, 200, "{response}");
        assert!(response.contains("FrozenTool"), "{response}");
        use maka_agent_ports::executor::RootSettlementOwner as _;
        assert_eq!(first.original_root_cleanup(), OperationCleanup::Unconfirmed);
        let signal = first.clone().original_root_cleanup_signal();
        tokio::pin!(signal);
        assert!(futures_util::poll!(signal.as_mut()).is_pending());
        first.close().await.unwrap();
        signal.await;
        assert_eq!(first.original_root_cleanup(), OperationCleanup::Confirmed);
        assert!(first.manager.sessions.read().await.is_empty());
        assert!(first.admit().is_err(), "a closed scope must never reopen");
        assert!(
            config_directory.exists(),
            "scope close cannot remove native input files"
        );
        let second = endpoint
            .bind(
                list_tools(&store, Default::default()),
                _directory.path().join("native-inputs"),
            )
            .unwrap();
        assert_eq!(first.url, second.url);
        assert_eq!(first.directory(), second.directory());
        assert_ne!(first.bearer(), second.bearer());
        assert_eq!(
            post(&second, first.bearer(), None, initialize()).await.0,
            401
        );
        assert_eq!(
            post(&second, second.bearer(), Some(&first_id), list.clone())
                .await
                .0,
            404
        );
        assert_eq!(
            post(&second, second.bearer(), None, list.clone()).await.0,
            400
        );
        let second_id = initialized(&second).await;
        assert_ne!(first_id, second_id);
        let (status, response) = post(&second, second.bearer(), Some(&second_id), list).await;
        assert_eq!(status, 200, "{response}");
        assert!(
            response.contains("FrozenTool"),
            "reduced ceiling must not change the catalog: {response}"
        );
        second.close().await.unwrap();
        assert_eq!(
            post(&second, second.bearer(), None, initialize()).await.0,
            401
        );
        endpoint.finish().await.unwrap();
        assert!(_effects.seal().unwrap());
        _effects.settle().await.unwrap();
        lease.finish();
        assert!(
            config_directory.exists(),
            "bridge retirement cannot dispose caller-owned native inputs"
        );
        std::fs::remove_dir_all(&config_directory).unwrap();
        assert!(!config_directory.exists());
    }
    #[tokio::test]
    async fn request_captured_before_close_cannot_rebind_to_the_next_scope() {
        let (_directory, store, lease, _effects) = tools().await;
        let endpoint = Endpoint::open("session".into(), Some(vec![]))
            .await
            .unwrap();
        let first = endpoint
            .bind(
                list_tools(&store, Default::default()),
                _directory.path().join("native-inputs"),
            )
            .unwrap();
        let old_route = endpoint.state.lock().unwrap().route.clone().unwrap();
        let guard = first.begin_request().unwrap();
        let closing = {
            let first = first.clone();
            tokio::spawn(async move { first.close().await })
        };
        first.cancelled.cancelled().await;
        assert!(
            !closing.is_finished(),
            "request capture must settle before transport cleanup"
        );
        assert!(
            endpoint
                .bind(
                    list_tools(&store, Default::default()),
                    _directory.path().join("native-inputs")
                )
                .is_err()
        );
        drop(guard);
        closing.await.unwrap().unwrap();
        let second = endpoint
            .bind(
                list_tools(&store, Default::default()),
                _directory.path().join("native-inputs"),
            )
            .unwrap();
        let request = HttpRequest::builder()
            .method("POST")
            .uri("/mcp")
            .header("Content-Type", "application/json")
            .body(Body::from(initialize().to_string()))
            .unwrap();
        assert_eq!(
            old_route.handle(request).await.status(),
            StatusCode::UNAUTHORIZED
        );
        assert!(second.manager.sessions.read().await.is_empty());
        second.close().await.unwrap();
        endpoint.finish().await.unwrap();
        assert!(_effects.seal().unwrap());
        _effects.settle().await.unwrap();
        lease.finish();
    }

    #[tokio::test]
    async fn settled_catalog_updates_keep_the_endpoint_and_do_not_rewrite_old_scopes() {
        let (_directory, store, lease, _effects) = tools().await;
        let endpoint = Endpoint::open("session".into(), Some(vec![definition()]))
            .await
            .unwrap();
        let first = endpoint
            .bind(
                list_tools(&store, catalog(vec![definition()])),
                _directory.path().join("native-inputs"),
            )
            .unwrap();
        let first_id = initialized(&first).await;
        let mut changed = definition();
        changed["description"] = "updated description".into();
        changed["inputSchema"] = serde_json::json!({"type":"object","required":["new"]});
        let mut added = definition();
        added["name"] = "ExtraTool".into();
        let updated = vec![added, changed];
        assert!(
            endpoint
                .bind(
                    list_tools(&store, catalog(updated.clone())),
                    _directory.path().join("native-inputs")
                )
                .is_err(),
            "definitions cannot change while the original invocation is unsettled"
        );
        first.close().await.unwrap();
        let second = endpoint
            .bind(
                list_tools(&store, catalog(updated.clone())),
                _directory.path().join("native-inputs"),
            )
            .unwrap();
        assert_eq!(second.url, first.url);
        assert_eq!(second.directory(), first.directory());
        assert_eq!(first.definitions(), &[definition()]);
        assert_eq!(second.definitions(), updated);
        assert_eq!(
            post(&second, first.bearer(), None, initialize()).await.0,
            401
        );
        let list = serde_json::json!({"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}});
        assert_eq!(
            post(&second, second.bearer(), Some(&first_id), list.clone())
                .await
                .0,
            404
        );
        let second_id = initialized(&second).await;
        let (status, response) = post(&second, second.bearer(), Some(&second_id), list).await;
        assert_eq!(status, 200, "{response}");
        assert!(
            response.contains("updated description") && response.contains("ExtraTool"),
            "{response}"
        );
        second.close().await.unwrap();
        let reduced = endpoint
            .bind(
                list_tools(&store, Default::default()),
                _directory.path().join("native-inputs"),
            )
            .unwrap();
        assert_eq!(
            reduced.definitions(),
            updated,
            "a reduced ceiling must not churn the catalog"
        );
        reduced.close().await.unwrap();
        endpoint.finish().await.unwrap();
        assert!(_effects.seal().unwrap());
        _effects.settle().await.unwrap();
        lease.finish();
    }
}
