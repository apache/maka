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

//! Installation-owned MCP connections. Protocol code stays behind this boundary;
//! the Agent owns per-call permission, journal admission and user confirmation.
mod http;
mod owned;
mod result;
mod validation;
pub use maka_agent_facts::configuration::mcp::{
    ServerConfiguration, Transport as TransportConfiguration,
};
use maka_agent_facts::{
    tool_output::ToolSuccess,
    tools::{ToolDefinition, ToolError},
};
use rmcp::{
    ClientHandler, Peer, RoleClient, ServiceExt,
    model::*,
    service::{NotificationContext, PeerRequestOptions, ServiceError},
    transport::{
        Transport,
        async_rw::AsyncRwTransport,
        streamable_http_client::{
            StreamableHttpClientTransport, StreamableHttpClientTransportConfig,
        },
    },
};
use serde_json::Value;
use std::{
    collections::HashSet,
    fmt,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::sync::{oneshot, watch};
use tokio_util::sync::CancellationToken;
pub use validation::validate;
const CLEANUP: Duration = Duration::from_secs(5);

#[derive(Clone)]
pub struct RemoteTool {
    pub remote_name: String,
    pub definition: ToolDefinition,
    pub read_only: bool,
}
#[derive(Clone)]
pub struct Connection(Arc<Inner>);
struct Inner {
    name: String,
    peer: Peer<RoleClient>,
    tools: Vec<RemoteTool>,
    invalid: Arc<AtomicBool>,
    stop: CancellationToken,
    owner: CleanupMaterial,
    timeout: Duration,
    remote: bool,
}
impl Drop for Inner {
    fn drop(&mut self) {
        self.stop.cancel();
    }
}
struct Handler(Arc<AtomicBool>);
impl ClientHandler for Handler {
    async fn on_tool_list_changed(&self, _: NotificationContext<RoleClient>) {
        self.0.store(true, Ordering::Release);
    }
    fn get_info(&self) -> ClientConfig {
        let mut info = ClientConfig::default();
        info.client_info.name = "maka".into();
        info.client_info.version = env!("CARGO_PKG_VERSION").into();
        info
    }
}
type Ready = oneshot::Sender<Result<(Peer<RoleClient>, Vec<RemoteTool>), String>>;

/// Actual original cleanup custody, not a connection descriptor or a grant.
#[derive(Clone)]
pub struct CleanupMaterial(Arc<RuntimeOwner>);
struct RuntimeOwner {
    task: Option<tokio::task::JoinHandle<Result<(), Box<CleanupFailure>>>>,
    done: watch::Receiver<Option<Result<(), String>>>,
    stop: CancellationToken,
}
struct CleanupFailure {
    message: String,
    _transport: Option<owned::Custody>,
    _child: Option<maka_process::pipe::Child>,
}
impl fmt::Debug for CleanupMaterial {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("CleanupMaterial { original_owner: .. }")
    }
}
impl CleanupMaterial {
    /// Observe only the original owner. This supplies neither caller ACK nor a
    /// Root settlement token; a terminal failure cannot become confirmed later.
    pub async fn closed(&self) -> Result<(), String> {
        let mut done = self.0.done.clone();
        loop {
            if let Some(result) = done.borrow_and_update().clone() {
                return result;
            }
            done.changed()
                .await
                .map_err(|_| "MCP connection owner disappeared".to_owned())?;
        }
    }
}
impl Drop for RuntimeOwner {
    fn drop(&mut self) {
        self.stop.cancel();
        if let Some(task) = self.task.take() {
            tokio::spawn(async move {
                if let Ok(Err(material)) = task.await {
                    // Even a lost observer cannot dispose of an unconfirmed Child
                    // or transport. No new registry or synthetic ACK is involved.
                    std::future::pending::<()>().await;
                    drop(material);
                }
            });
        }
    }
}

#[derive(Debug)]
pub struct StartupError {
    pub message: String,
    pub material: Option<CleanupMaterial>,
}
impl StartupError {
    pub fn clean(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            material: None,
        }
    }
    pub fn unconfirmed(message: impl Into<String>, material: CleanupMaterial) -> Self {
        Self {
            message: message.into(),
            material: Some(material),
        }
    }
}
#[derive(Debug)]
pub struct CloseError {
    pub message: String,
    pub material: CleanupMaterial,
}
impl fmt::Display for CloseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for CloseError {}
impl fmt::Display for StartupError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for StartupError {}
impl Connection {
    pub async fn connect(
        configuration: ServerConfiguration,
        network: maka_network::Policy,
    ) -> Result<Self, StartupError> {
        Self::connect_cancellable(configuration, network, CancellationToken::new()).await
    }
    pub async fn connect_cancellable(
        configuration: ServerConfiguration,
        network: maka_network::Policy,
        cancellation: CancellationToken,
    ) -> Result<Self, StartupError> {
        validate(&configuration).map_err(StartupError::clean)?;
        if cancellation.is_cancelled() {
            return Err(StartupError::clean("MCP startup cancelled"));
        }
        let stop = CancellationToken::new();
        let cancel_on_drop = stop.clone().drop_guard();
        let invalid = Arc::new(AtomicBool::new(false));
        let (ready, received) = oneshot::channel();
        let (finished, done) = watch::channel(None);
        let config = configuration.clone();
        let owner_stop = stop.clone();
        let owner_invalid = invalid.clone();
        // Startup and teardown survive a dropped observer. No child or HTTP worker
        // can lose its owner when the activation request is cancelled.
        let task = tokio::spawn(async move {
            let result = own(config, network, owner_invalid, owner_stop, ready).await;
            finished.send_replace(Some(
                result
                    .as_ref()
                    .map(|_| ())
                    .map_err(|failure| failure.message.clone()),
            ));
            result
        });
        let material = CleanupMaterial(Arc::new(RuntimeOwner {
            task: Some(task),
            done,
            stop: stop.clone(),
        }));
        let result = tokio::select! {
            biased;
            _ = cancellation.cancelled() => Err("MCP startup cancelled".to_owned()),
            result = received => result.unwrap_or_else(|_| Err("MCP connection owner disappeared".into())),
        };
        let (peer, tools) = match result {
            Ok(ready) => ready,
            Err(error) => {
                stop.cancel();
                return Err(
                    match tokio::time::timeout(CLEANUP, material.closed()).await {
                        Ok(Ok(())) => StartupError::clean(error),
                        Ok(Err(cleanup)) => {
                            StartupError::unconfirmed(format!("{error}; {cleanup}"), material)
                        }
                        Err(_) => StartupError::unconfirmed(
                            format!("{error}; MCP startup cleanup timed out"),
                            material,
                        ),
                    },
                );
            }
        };
        cancel_on_drop.disarm();
        Ok(Self(Arc::new(Inner {
            name: configuration.name,
            peer,
            tools,
            invalid,
            stop,
            owner: material,
            timeout: Duration::from_millis(configuration.call_timeout_ms),
            remote: matches!(
                configuration.transport,
                TransportConfiguration::StreamableHttp { .. }
            ),
        })))
    }
    pub fn tools(&self) -> &[RemoteTool] {
        &self.0.tools
    }
    pub fn available(&self) -> bool {
        !self.0.invalid.load(Ordering::Acquire)
            && !self.0.stop.is_cancelled()
            && !self.0.peer.is_transport_closed()
    }
    pub async fn close(&self) -> Result<(), CloseError> {
        self.0.stop.cancel();
        match tokio::time::timeout(CLEANUP, self.0.owner.closed()).await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(message)) => Err(CloseError {
                message,
                material: self.0.owner.clone(),
            }),
            Err(_) => Err(CloseError {
                message: "MCP cleanup timed out; original owner is still retained".into(),
                material: self.0.owner.clone(),
            }),
        }
    }
    pub async fn call(
        &self,
        name: String,
        input: Value,
        cancellation: CancellationToken,
    ) -> Result<ToolSuccess, ToolError> {
        if !self.available() || !self.0.tools.iter().any(|tool| tool.remote_name == name) {
            return Err(failed(
                "MCP connection or captured tool catalog is unavailable; reactivate the Agent",
            ));
        }
        let arguments = input
            .as_object()
            .cloned()
            .ok_or_else(|| failed("MCP tool arguments must be an object"))?;
        if cancellation.is_cancelled() {
            return Err(failed("MCP call cancelled before dispatch"));
        }
        let cancellation = cancellation.child_token();
        let cancel_on_drop = cancellation.clone().drop_guard();
        let connection = self.clone();
        let result =
            tokio::spawn(async move { connection.call_owned(name, arguments, cancellation).await })
                .await
                .map_err(|_| ToolError::CleanupUnconfirmed("MCP call owner disappeared".into()))?;
        cancel_on_drop.disarm();
        result
    }
    async fn call_owned(
        &self,
        name: String,
        arguments: serde_json::Map<String, Value>,
        cancellation: CancellationToken,
    ) -> Result<ToolSuccess, ToolError> {
        if !self.available() || cancellation.is_cancelled() {
            return Err(failed(
                "MCP call cancelled or catalog retired before dispatch",
            ));
        }
        let request = ClientRequest::CallToolRequest(CallToolRequest::new(
            CallToolRequestParams::new(name).with_arguments(arguments),
        ));
        // The deadline includes admission to the SDK's bounded outbound queue.
        // A blocked writer must not make queueing uncancellable or unbounded.
        let deadline = tokio::time::Instant::now() + self.0.timeout;
        let sent = tokio::select! {
            result = self.0.peer.send_cancellable_request(request, PeerRequestOptions::no_options()) => result,
            _ = cancellation.cancelled() => return self.uncertain("MCP dispatch cancelled").await,
            _ = tokio::time::sleep_until(deadline) => return self.uncertain("MCP dispatch timed out").await,
        };
        // One request only: no transparent session recovery, retries or MRTR.
        let handle = match sent {
            Ok(handle) => handle,
            Err(ServiceError::McpError(error)) => return Err(failed(error.to_string())),
            Err(_) => return self.uncertain("MCP request transport failed").await,
        };
        let id = handle.id.clone();
        let response = handle.await_response();
        tokio::pin!(response);
        let outcome = tokio::select! {
            result = &mut response => Some(result),
            _ = cancellation.cancelled() => None,
            _ = tokio::time::sleep_until(deadline) => None,
        };
        let outcome = match outcome {
            Some(result) => result,
            None => {
                let notification = CancelledNotification::new(CancelledNotificationParam::new(
                    Some(id),
                    Some("Maka call cancelled or timed out".into()),
                ));
                // rmcp retires its response slot after sending cancellation. A
                // local Cancelled result is not a terminal server response and
                // therefore follows the uncertainty path below.
                let _ = tokio::time::timeout(
                    CLEANUP,
                    self.0.peer.send_notification(notification.into()),
                )
                .await;
                match tokio::time::timeout(CLEANUP, &mut response).await {
                    Ok(result) => result,
                    Err(_) => {
                        return self
                            .uncertain("MCP cancellation has no terminal response")
                            .await;
                    }
                }
            }
        };
        match outcome {
            Ok(ServerResult::CallToolResult(result)) => Ok(result::project(result)),
            Err(ServiceError::McpError(error)) => Err(failed(error.to_string())),
            _ => {
                self.uncertain("MCP call ended without a final tool result")
                    .await
            }
        }
    }
    async fn uncertain(&self, reason: &str) -> Result<ToolSuccess, ToolError> {
        self.0.invalid.store(true, Ordering::Release);
        self.close()
            .await
            .map_err(|error| ToolError::CleanupUnconfirmed(error.message))?;
        let message = format!(
            "{}: {reason}; external effects are unconfirmed and the connection was retired",
            self.0.name
        );
        Err(if self.0.remote {
            ToolError::CleanupUnconfirmed(message)
        } else {
            ToolError::OutcomeUnknown(message)
        })
    }
}
fn failed(message: impl Into<String>) -> ToolError {
    ToolError::Failed(message.into())
}

async fn own(
    config: ServerConfiguration,
    network: maka_network::Policy,
    invalid: Arc<AtomicBool>,
    stop: CancellationToken,
    ready: Ready,
) -> Result<(), Box<CleanupFailure>> {
    let mut ready = Some(ready);
    let outcome =
        match &config.transport {
            TransportConfiguration::Stdio {
                command,
                args,
                cwd,
                env,
                pass_env,
            } => {
                let setup = (|| {
                    let executable = which::which(command)
                        .map_err(|_| "MCP executable is unavailable".to_owned())?;
                    let mut plan = maka_process::Command::new(executable, cwd);
                    plan.env_clear();
                    // Basic executable lookup, home/cache and temporary paths only.
                    // Secrets and proxy URLs require explicit env/passEnv entries.
                    for key in [
                        "PATH",
                        "HOME",
                        "USERPROFILE",
                        "SystemRoot",
                        "WINDIR",
                        "TEMP",
                        "TMP",
                        "TMPDIR",
                        "LANG",
                        "LC_ALL",
                    ] {
                        if let Some(value) = std::env::var_os(key) {
                            plan.env(key, value);
                        }
                    }
                    for arg in args {
                        plan.arg(arg);
                    }
                    for (key, value) in env {
                        plan.env(key, value);
                    }
                    for key in pass_env {
                        plan.env(
                            key,
                            std::env::var_os(key).ok_or_else(|| {
                                format!("MCP environment variable {key} is not configured")
                            })?,
                        );
                    }
                    Ok::<_, String>(plan)
                })();
                match setup {
                    Err(error) => {
                        startup_failed(&mut ready, error);
                        Ok(())
                    }
                    Ok(plan) => match maka_process::pipe::spawn(plan).await {
                        Err(_) => {
                            startup_failed(&mut ready, "MCP process startup failed");
                            Ok(())
                        }
                        Ok(spawned) => {
                            let maka_process::pipe::Spawned {
                                mut child,
                                stdin,
                                stdout,
                                mut stderr,
                            } = spawned;
                            // Drain without publishing potentially secret server diagnostics.
                            let stderr = tokio::spawn(async move {
                                tokio::io::copy(&mut stderr, &mut tokio::io::sink()).await
                            });
                            let transport =
                                AsyncRwTransport::<RoleClient, _, _>::new(stdout, stdin)
                                    .with_max_line_length(usize::MAX);
                            let result = run(transport, &config, invalid, stop, &mut ready).await;
                            let cleanup =
                                match tokio::time::timeout(Duration::from_secs(1), child.wait())
                                    .await
                                {
                                    Ok(result) => result
                                        .map(|_| ())
                                        .map_err(|_| "MCP process group cleanup unconfirmed"),
                                    Err(_) => {
                                        match child.terminate().await {
                                            Ok(()) => child.wait().await.map(|_| ()).map_err(
                                                |_| "MCP process group cleanup unconfirmed",
                                            ),
                                            Err(_) => Err("MCP process termination failed"),
                                        }
                                    }
                                };
                            // Only the owned drain task is aborted, never the original
                            // service waiting future or its process cleanup owner.
                            stderr.abort();
                            let _ = stderr.await;
                            match cleanup {
                                Ok(()) => result,
                                Err(message) => match result {
                                    Ok(()) => Err(Box::new(CleanupFailure {
                                        message: message.to_owned(),
                                        _transport: None,
                                        _child: Some(child),
                                    })),
                                    Err(mut failure) => {
                                        failure.message = format!("{}; {message}", failure.message);
                                        failure._child = Some(child);
                                        Err(failure)
                                    }
                                },
                            }
                        }
                    },
                }
            }
            TransportConfiguration::StreamableHttp {
                url,
                headers,
                header_env,
            } => {
                let setup = (|| {
                    let mut values = std::collections::HashMap::new();
                    for (name, value) in headers {
                        values.insert(
                            reqwest::header::HeaderName::from_bytes(name.as_bytes())
                                .map_err(|_| "Invalid MCP header")?,
                            reqwest::header::HeaderValue::from_str(value)
                                .map_err(|_| "Invalid MCP header")?,
                        );
                    }
                    for (name, key) in header_env {
                        values.insert(
                            reqwest::header::HeaderName::from_bytes(name.as_bytes())
                                .map_err(|_| "Invalid MCP header")?,
                            reqwest::header::HeaderValue::from_str(&std::env::var(key).map_err(
                                |_| "MCP header environment variable is not configured",
                            )?)
                            .map_err(|_| "Invalid MCP header")?,
                        );
                    }
                    let client = network
                        .client_builder()
                        .redirect(reqwest::redirect::Policy::none())
                        .build()
                        .map_err(|_| "MCP HTTP client construction failed")?;
                    let config = StreamableHttpClientTransportConfig::with_uri(url.clone())
                        .custom_headers(values)
                        .max_sse_event_size(usize::MAX)
                        .reinit_on_expired_session(false);
                    Ok::<_, String>(StreamableHttpClientTransport::with_client(
                        http::Client(client),
                        config,
                    ))
                })();
                match setup {
                    Ok(transport) => run(transport, &config, invalid, stop, &mut ready).await,
                    Err(error) => {
                        startup_failed(&mut ready, error);
                        Ok(())
                    }
                }
            }
        };
    if ready.is_some() {
        startup_failed(&mut ready, "MCP connection closed during startup");
    }
    outcome
}

fn startup_failed(ready: &mut Option<Ready>, message: impl Into<String>) {
    if let Some(ready) = ready.take() {
        let _ = ready.send(Err(message.into()));
    }
}

async fn run<T: Transport<RoleClient> + 'static>(
    transport: T,
    config: &ServerConfiguration,
    invalid: Arc<AtomicBool>,
    stop: CancellationToken,
    ready: &mut Option<Ready>,
) -> Result<(), Box<CleanupFailure>> {
    let (transport, custody) = owned::track(transport);
    let deadline = tokio::time::Instant::now() + Duration::from_millis(config.startup_timeout_ms);
    let started = {
        let startup = Handler(invalid).serve(transport);
        tokio::pin!(startup);
        tokio::select! {
            result = tokio::time::timeout_at(deadline, &mut startup) => result
                .map_err(|_| "MCP startup timed out".to_owned())
                .and_then(|result| result.map_err(|_| "MCP initialization failed".to_owned())),
            _ = stop.cancelled() => Err("MCP startup cancelled".into()),
        }
    };
    let joined = match started {
        Err(error) => {
            startup_failed(ready, error);
            Ok(())
        }
        Ok(service) => {
            let peer = service.peer().clone();
            let sdk_stop = service.cancellation_token();
            let waiting = service.waiting();
            tokio::pin!(waiting);
            let discovered = {
                let discovery = discover(&peer, config);
                tokio::pin!(discovery);
                tokio::select! {
                    result = tokio::time::timeout_at(deadline, &mut discovery) => result
                        .map_err(|_| "MCP startup timed out".to_owned()).and_then(|result| result),
                    _ = stop.cancelled() => Err("MCP startup cancelled".into()),
                }
            };
            let result = match discovered {
                Err(error) => {
                    startup_failed(ready, error);
                    sdk_stop.cancel();
                    waiting.await
                }
                Ok(tools) => {
                    if ready
                        .take()
                        .expect("one startup reply")
                        .send(Ok((peer, tools)))
                        .is_err()
                    {
                        stop.cancel();
                    }
                    tokio::select! {
                        result = &mut waiting => result,
                        _ = stop.cancelled() => {
                            sdk_stop.cancel();
                            // The observer's deadline is outside this owner. Keep
                            // driving this exact original waiting future to its join.
                            waiting.await
                        },
                    }
                }
            };
            result
                .map(|_| ())
                .map_err(|_| "MCP service cleanup failed".to_owned())
        }
    };
    let transport = custody.closed().await.map_err(|error| error.to_string());
    let message = match (joined, transport) {
        (Ok(()), Ok(())) => return Ok(()),
        (Err(service), Err(transport)) => format!("{service}; {transport}"),
        (Err(error), Ok(())) | (Ok(()), Err(error)) => error,
    };
    Err(Box::new(CleanupFailure {
        message,
        _transport: Some(custody),
        _child: None,
    }))
}

async fn discover(
    peer: &Peer<RoleClient>,
    config: &ServerConfiguration,
) -> Result<Vec<RemoteTool>, String> {
    let mut tools = Vec::new();
    let mut cursor = None;
    let mut cursors = HashSet::new();
    loop {
        let page = peer
            .list_tools(
                cursor.map(|cursor| PaginatedRequestParams::default().with_cursor(Some(cursor))),
            )
            .await
            .map_err(|_| "MCP tool discovery failed")?;
        tools.extend(page.tools);
        cursor = page.next_cursor;
        if cursor.is_none() {
            return validation::tools(config, tools);
        }
        if !cursors.insert(cursor.clone()) {
            return Err("MCP pagination cursor repeats".into());
        }
    }
}
