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

//! Private, parent-owned desktop worker. There is no listener or reconnect path.
use super::failed;
#[cfg(feature = "native-desktop")]
use super::local_platform;
use crate::{BrowserAccess, BrowserAuthorization, InvocationContext, protocol::Command};
#[cfg(feature = "native-desktop")]
use crate::{Driver, session::Session};
use maka_agent_facts::tools::ToolError;
use maka_capabilities::computer::BrowserConnection;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;
#[cfg(feature = "native-desktop")]
use std::collections::HashMap;
#[cfg(any(feature = "native-desktop", test))]
use std::future::Future;
use std::sync::Arc;
use std::{
    io,
    path::PathBuf,
    process::{ExitCode, Stdio},
    time::Duration,
};
#[cfg(feature = "native-desktop")]
use tokio::sync::Mutex;
#[cfg(any(feature = "native-desktop", test))]
use tokio::sync::{mpsc, oneshot};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout},
};
use tokio_util::sync::CancellationToken;

const ENTRY: &str = "__maka-cua-desktop";
const PROTOCOL: u32 = 1;
const STARTUP_TIMEOUT: Duration = Duration::from_secs(15);
const EXIT_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Hello {
    protocol: u32,
    platform: String,
    audio_enabled: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "method", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum Request {
    Invoke {
        session: String,
        turn: String,
        browsers: Vec<BrowserConnection>,
        command: Command,
        language: maka_agent_facts::language::Language,
    },
    CloseSession {
        session: String,
    },
    DiscardAudio {
        session: String,
    },
    FinishTurn {
        session: String,
        turn: String,
        language: maka_agent_facts::language::Language,
    },
    Shutdown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", content = "message", rename_all = "snake_case")]
enum Failure {
    Failed(String),
    OutcomeUnknown(String),
    CleanupUnconfirmed(String),
}
impl From<ToolError> for Failure {
    fn from(error: ToolError) -> Self {
        match error {
            ToolError::Failed(message) => Self::Failed(message),
            ToolError::OutcomeUnknown(message) | ToolError::OperationUnknown { message, .. } => {
                Self::OutcomeUnknown(message)
            }
            ToolError::OperationCleanupUnconfirmed { message, .. }
            | ToolError::CleanupUnconfirmed(message)
            | ToolError::Persistence(message) => Self::CleanupUnconfirmed(message),
            ToolError::Io { message, .. } => Self::Failed(message),
        }
    }
}
impl From<Failure> for ToolError {
    fn from(error: Failure) -> Self {
        match error {
            Failure::Failed(message) => Self::Failed(message),
            Failure::OutcomeUnknown(message) => Self::OutcomeUnknown(message),
            Failure::CleanupUnconfirmed(message) => Self::CleanupUnconfirmed(message),
        }
    }
}
type Response = Result<Value, Failure>;

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum ParentFrame {
    Request {
        id: u64,
        request: Request,
    },
    BrowserAuthorizationResult {
        id: u64,
        authorization_id: u64,
        result: Result<(), Failure>,
    },
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum WorkerFrame {
    Response {
        id: u64,
        result: Response,
    },
    BrowserAuthorization {
        id: u64,
        authorization_id: u64,
        mode: AuthorizationMode,
        access: BrowserAccess,
    },
}

#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum AuthorizationMode {
    Authorize,
    Check,
}

#[derive(Default)]
pub(crate) struct Worker {
    process: Option<Process>,
    fault: Option<ToolError>,
    closed: bool,
    audio_enabled: bool,
    request_id: u64,
}
struct Process {
    child: Child,
    pipes: Option<(ChildStdin, BufReader<ChildStdout>)>,
    authorization_id: u64,
}
impl Worker {
    pub(crate) fn with_audio(audio_enabled: bool) -> Self {
        Self {
            audio_enabled,
            ..Default::default()
        }
    }
    pub(crate) async fn prepare(
        &mut self,
        cancellation: &CancellationToken,
    ) -> Result<(), ToolError> {
        if self.closed {
            return Err(failed("Windows desktop worker is closed"));
        }
        if let Some(error) = &self.fault {
            return Err(error.clone());
        }
        if self.process.is_none() {
            let executable = tokio::select! {
                biased;
                _ = cancellation.cancelled() => return Err(failed("Computer Use preparation cancelled")),
                executable = windows_executable() => executable?,
            };
            // The worker only advertises its protocol here. Native Cua state
            // remains idle until a separately admitted operation is sent.
            self.process = Some(Process::start(executable, self.audio_enabled).await?);
        }
        if cancellation.is_cancelled() {
            return Err(failed("Computer Use preparation cancelled"));
        }
        Ok(())
    }
    pub(crate) async fn release_session(&mut self, session: &str) -> Result<(), ToolError> {
        if self.process.is_some() {
            self.call(
                Request::CloseSession {
                    session: session.into(),
                },
                &CancellationToken::new(),
            )
            .await?;
        }
        Ok(())
    }
    pub(crate) async fn discard_audio(&mut self, session: &str) -> Result<(), ToolError> {
        if self.process.is_some() {
            self.call(
                Request::DiscardAudio {
                    session: session.into(),
                },
                &CancellationToken::new(),
            )
            .await?;
        }
        Ok(())
    }

    pub(crate) async fn invoke(
        &mut self,
        request: Request,
        invocation: &InvocationContext<'_>,
        cancellation: &CancellationToken,
    ) -> Result<Value, ToolError> {
        self.exchange(request, invocation.browser_authorization(), cancellation)
            .await
    }

    pub(crate) async fn call(
        &mut self,
        request: Request,
        cancellation: &CancellationToken,
    ) -> Result<Value, ToolError> {
        self.exchange(request, None, cancellation).await
    }

    async fn exchange(
        &mut self,
        request: Request,
        authorization: Option<Arc<dyn BrowserAuthorization>>,
        cancellation: &CancellationToken,
    ) -> Result<Value, ToolError> {
        if cancellation.is_cancelled() {
            return Err(failed("Computer Use cancelled before dispatch"));
        }
        let id = self
            .request_id
            .checked_add(1)
            .ok_or_else(|| failed("desktop request identity exhausted"))?;
        let frame = encode(&ParentFrame::Request { id, request }).map_err(failed)?;
        self.prepare(cancellation).await?;
        self.request_id = id;
        let process = self.process.as_mut().unwrap();
        // Once sent, settle the request even when the caller cancels. Callback
        // cancellation denies permission; it does not infer input never ran.
        let failure = match process
            .exchange(&frame, id, authorization, cancellation)
            .await
        {
            Ok(Err(Failure::CleanupUnconfirmed(message))) => ToolError::CleanupUnconfirmed(message),
            Ok(response) => return response.map_err(Into::into),
            Err(error) => error,
        };
        let (unconfirmed, problem) = match failure {
            ToolError::CleanupUnconfirmed(message) => (true, message),
            other => (false, other.to_string()),
        };
        let message = format!(
            "Windows desktop connection lost: {problem}; restart the Host before using Computer Use again"
        );
        let result = match process.disconnect().await {
            Ok(()) if unconfirmed => ToolError::CleanupUnconfirmed(message.clone()),
            Ok(()) => ToolError::OutcomeUnknown(message.clone()),
            Err(cleanup) => ToolError::CleanupUnconfirmed(format!("{message}; {cleanup}")),
        };
        self.fault = Some(match &result {
            ToolError::OutcomeUnknown(_) => failed(&message),
            _ => result.clone(),
        });
        Err(result)
    }

    pub(crate) async fn close(&mut self) -> Result<(), ToolError> {
        let mut failure = None;
        if !self.closed
            && self.process.is_some()
            && self.fault.is_none()
            && let Err(error) = self
                .call(Request::Shutdown, &CancellationToken::new())
                .await
        {
            failure = Some(error);
        }
        self.closed = true;
        if let Some(process) = &mut self.process {
            process
                .disconnect()
                .await
                .map_err(|error| ToolError::CleanupUnconfirmed(error.to_string()))?;
        }
        self.process = None;
        failure.map_or(Ok(()), Err)
    }
}
impl Process {
    async fn start(executable: PathBuf, audio_enabled: bool) -> Result<Self, ToolError> {
        let mut command = tokio::process::Command::new(executable);
        command
            .arg(ENTRY)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true);
        if audio_enabled {
            command.arg("--audio");
        }
        #[cfg(unix)]
        command.process_group(0);
        let mut child = command.spawn().map_err(|error| failed(format!(
            "Windows desktop unavailable: {error}; install Windows Maka and enable WSL interoperability"
        )))?;
        Self {
            pipes: Some((
                child.stdin.take().unwrap(),
                BufReader::new(child.stdout.take().unwrap()),
            )),
            child,
            authorization_id: 0,
        }
        .handshake(audio_enabled)
        .await
    }

    async fn handshake(mut self, expected_audio: bool) -> Result<Self, ToolError> {
        let hello = tokio::time::timeout(
            STARTUP_TIMEOUT,
            read::<_, Hello>(&mut self.pipes.as_mut().unwrap().1),
        )
        .await;
        let problem = match hello {
            Ok(Ok(Hello {
                protocol: PROTOCOL,
                platform,
                audio_enabled,
            })) if platform == "windows" && audio_enabled == expected_audio => return Ok(self),
            Ok(Ok(_)) => {
                "incompatible desktop worker; install a matching Windows Maka build".to_owned()
            }
            Ok(Err(error)) => format!("Windows desktop worker handshake failed: {error}"),
            Err(_) => "Windows desktop worker startup timed out".to_owned(),
        };
        self.disconnect()
            .await
            .map_err(|error| ToolError::CleanupUnconfirmed(format!("{problem}; {error}")))?;
        Err(failed(problem))
    }

    async fn exchange(
        &mut self,
        frame: &[u8],
        id: u64,
        authorization: Option<Arc<dyn BrowserAuthorization>>,
        cancellation: &CancellationToken,
    ) -> Result<Response, ToolError> {
        let (input, output) = self
            .pipes
            .as_mut()
            .ok_or_else(|| ToolError::OutcomeUnknown("desktop channel closed".into()))?;
        exchange_frames(
            input,
            output,
            frame,
            id,
            &mut self.authorization_id,
            authorization,
            cancellation,
        )
        .await
    }

    async fn disconnect(&mut self) -> io::Result<()> {
        // Close both directions so a peer writing a failed response cannot
        // stay blocked on its output while we wait for its cleanup.
        self.pipes.take();
        // WSL's interop process represents a Windows process, so killing the
        // Linux PID alone does not prove that native work has stopped.
        tokio::time::timeout(EXIT_TIMEOUT, self.child.wait())
            .await
            .map_err(|_| io::Error::other("Windows desktop worker exit was not confirmed"))??;
        Ok(())
    }
}

fn connection_lost(error: io::Error) -> ToolError {
    ToolError::OutcomeUnknown(error.to_string())
}

fn authorization_cleanup(result: Result<(), ToolError>) -> Option<ToolError> {
    match result {
        Ok(()) | Err(ToolError::Failed(_) | ToolError::Io { .. }) => None,
        Err(error) => Some(ToolError::CleanupUnconfirmed(format!(
            "Browser authorization cleanup was not confirmed: {error}"
        ))),
    }
}

async fn cancel_authorization(
    decision: &mut crate::AuthorizationFuture,
    cancellation: &CancellationToken,
) -> Option<ToolError> {
    cancellation.cancel();
    authorization_cleanup(decision.await)
}

async fn exchange_frames(
    input: &mut (impl AsyncWrite + Unpin),
    output: &mut (impl AsyncRead + Unpin),
    frame: &[u8],
    id: u64,
    last_authorization: &mut u64,
    authorization: Option<Arc<dyn BrowserAuthorization>>,
    cancellation: &CancellationToken,
) -> Result<Response, ToolError> {
    input.write_all(frame).await.map_err(connection_lost)?;
    input.flush().await.map_err(connection_lost)?;
    let mut message = read::<_, WorkerFrame>(output)
        .await
        .map_err(connection_lost)?;
    loop {
        match message {
            WorkerFrame::Response {
                id: response_id,
                result,
            } if response_id == id => return Ok(result),
            WorkerFrame::BrowserAuthorization {
                id: request_id,
                authorization_id,
                mode,
                access,
            } if request_id == id && authorization_id > *last_authorization => {
                *last_authorization = authorization_id;
                let callback_cancellation = cancellation.child_token();
                let _callback_lifetime = callback_cancellation.clone().drop_guard();
                let mut decision = match authorization.as_ref() {
                    Some(authorization) if !cancellation.is_cancelled() => match mode {
                        AuthorizationMode::Authorize => {
                            authorization.authorize(access, callback_cancellation.clone())
                        }
                        AuthorizationMode::Check => {
                            authorization.check(access, callback_cancellation.clone())
                        }
                    },
                    _ => Box::pin(async {
                        Err(failed("Browser site access requires Host authorization"))
                    }),
                };
                // Both futures retain custody. Cancellation must settle the
                // canonical prompt and the original framed native response.
                let next = read::<_, WorkerFrame>(output);
                tokio::pin!(next);
                message = tokio::select! {
                    biased;
                    received = &mut next => {
                        let cleanup = cancel_authorization(&mut decision, &callback_cancellation).await;
                        if let Some(error) = cleanup { return Err(error); }
                        received.map_err(connection_lost)?
                    },
                    _ = cancellation.cancelled() => {
                        let cleanup = cancel_authorization(&mut decision, &callback_cancellation).await;
                        let result = match &cleanup {
                            Some(error) => Err(Failure::from(error.clone())),
                            None => Err(Failure::Failed("Browser authorization cancelled".into())),
                        };
                        let sent = write(input, &ParentFrame::BrowserAuthorizationResult { id, authorization_id, result }).await;
                        let received = next.await;
                        if let Some(error) = cleanup { return Err(error); }
                        sent.map_err(connection_lost)?;
                        received.map_err(connection_lost)?
                    },
                    result = &mut decision => {
                        let cleanup = authorization_cleanup(result.clone());
                        let sent = write(input, &ParentFrame::BrowserAuthorizationResult { id, authorization_id, result: result.map_err(Failure::from) }).await;
                        let received = next.await;
                        if let Some(error) = cleanup { return Err(error); }
                        sent.map_err(connection_lost)?;
                        received.map_err(connection_lost)?
                    },
                };
            }
            _ => {
                return Err(ToolError::OutcomeUnknown(
                    "desktop response identity mismatch".into(),
                ));
            }
        }
    }
}

#[cfg(any(feature = "native-desktop", test))]
struct AuthorizationRequest {
    mode: AuthorizationMode,
    access: BrowserAccess,
    reply: oneshot::Sender<Result<(), Failure>>,
}

#[cfg(any(feature = "native-desktop", test))]
struct RemoteAuthorization {
    requests: mpsc::Sender<AuthorizationRequest>,
}

#[cfg(any(feature = "native-desktop", test))]
impl RemoteAuthorization {
    fn request(
        &self,
        mode: AuthorizationMode,
        access: BrowserAccess,
        cancellation: CancellationToken,
    ) -> crate::AuthorizationFuture {
        let requests = self.requests.clone();
        Box::pin(async move {
            let (reply, result) = oneshot::channel();
            tokio::select! {
                biased;
                _ = cancellation.cancelled() => return Err(failed("Browser authorization cancelled")),
                sent = requests.send(AuthorizationRequest { mode, access, reply }) => {
                    sent.map_err(|_| failed("Browser authorization invocation expired"))?;
                }
            }
            tokio::select! {
                biased;
                _ = cancellation.cancelled() => Err(failed("Browser authorization cancelled")),
                result = result => result.map_err(|_| failed("Browser authorization invocation expired"))?.map_err(Into::into),
            }
        })
    }
}

#[cfg(any(feature = "native-desktop", test))]
impl BrowserAuthorization for RemoteAuthorization {
    fn authorize(
        &self,
        access: BrowserAccess,
        cancellation: CancellationToken,
    ) -> crate::AuthorizationFuture {
        self.request(AuthorizationMode::Authorize, access, cancellation)
    }
    fn check(
        &self,
        access: BrowserAccess,
        cancellation: CancellationToken,
    ) -> crate::AuthorizationFuture {
        self.request(AuthorizationMode::Check, access, cancellation)
    }
}

#[cfg(any(feature = "native-desktop", test))]
async fn dispatch_with_authorization(
    id: u64,
    dispatch: impl Future<Output = Result<Value, ToolError>>,
    mut callbacks: mpsc::Receiver<AuthorizationRequest>,
    receive: &mut mpsc::Receiver<ParentFrame>,
    output: &mut (impl AsyncWrite + Unpin),
    disconnected: &CancellationToken,
    last_authorization: &mut u64,
) -> io::Result<Response> {
    tokio::pin!(dispatch);
    let mut pending: Option<(u64, oneshot::Sender<Result<(), Failure>>)> = None;
    let mut callbacks_open = true;
    loop {
        tokio::select! {
            biased;
            result = &mut dispatch => return Ok(result.map_err(Failure::from)),
            _ = disconnected.cancelled() => return Ok(dispatch.await.map_err(Failure::from)),
            frame = receive.recv() => {
                match (frame, pending.take()) {
                    (Some(ParentFrame::BrowserAuthorizationResult { id: response_id, authorization_id, result }), Some((expected, reply)))
                        if response_id == id && authorization_id == expected => { let _ = reply.send(result); }
                    _ => {
                        disconnected.cancel();
                        let _ = dispatch.await;
                        return Err(io::Error::new(io::ErrorKind::InvalidData, "desktop authorization identity mismatch"));
                    }
                }
            },
            callback = callbacks.recv(), if callbacks_open && pending.is_none() => {
                match callback {
                    Some(callback) if !callback.reply.is_closed() => {
                        let Some(authorization_id) = last_authorization.checked_add(1) else {
                            disconnected.cancel();
                            let _ = dispatch.await;
                            return Err(io::Error::other("desktop authorization identity exhausted"));
                        };
                        *last_authorization = authorization_id;
                        if let Err(error) = write(output, &WorkerFrame::BrowserAuthorization {
                            id, authorization_id, mode: callback.mode, access: callback.access,
                        }).await {
                            disconnected.cancel();
                            let _ = dispatch.await;
                            return Err(error);
                        }
                        pending = Some((authorization_id, callback.reply));
                    }
                    Some(_) => {},
                    None => callbacks_open = false,
                }
            }
        }
    }
}

async fn windows_executable() -> Result<PathBuf, ToolError> {
    if let Some(path) = std::env::var_os("MAKA_CUA_WINDOWS_EXECUTABLE") {
        let path = PathBuf::from(path);
        if path.is_absolute() && path.is_file() {
            return Ok(path);
        }
        return Err(failed(
            "MAKA_CUA_WINDOWS_EXECUTABLE must be an absolute path to Windows maka.exe, as visible from WSL",
        ));
    }
    let resolve = super::WINDOWS_HELPER.get().ok_or_else(|| {
        failed("the embedding application has not configured Windows desktop provisioning")
    })?;
    resolve().await
}

/// Invoke after cursor bootstrap and before starting the embedding application.
pub fn bootstrap() -> Option<ExitCode> {
    if std::env::args_os().nth(1).as_deref() != Some(std::ffi::OsStr::new(ENTRY)) {
        return None;
    }
    let audio_enabled =
        std::env::args_os().nth(2).as_deref() == Some(std::ffi::OsStr::new("--audio"));
    let result = if std::env::args_os().len() != if audio_enabled { 3 } else { 2 } {
        Err(io::Error::other("desktop worker accepts only --audio"))
    } else {
        #[cfg(feature = "native-desktop")]
        {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .and_then(|runtime| runtime.block_on(serve_stdio(audio_enabled)))
        }
        #[cfg(not(feature = "native-desktop"))]
        {
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "native desktop support is not included in this build; rebuild with the native-desktop feature",
            ))
        }
    };
    Some(match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("Maka desktop: {error}");
            ExitCode::FAILURE
        }
    })
}

#[cfg(feature = "native-desktop")]
async fn serve_stdio(audio_enabled: bool) -> io::Result<()> {
    let (send, receive) = mpsc::channel(1);
    let disconnected = CancellationToken::new();
    let eof = disconnected.clone();
    // A detached blocking reader avoids Tokio stdin keeping runtime shutdown
    // alive when stdout closes while the parent still holds stdin open.
    std::thread::spawn(move || {
        let mut input = std::io::stdin().lock();
        while let Ok(request) = read_sync(&mut input) {
            if send.blocking_send(request).is_err() {
                break;
            }
        }
        eof.cancel();
    });
    let driver = Arc::new(Mutex::new(Driver::with_audio(audio_enabled)));
    serve(receive, tokio::io::stdout(), disconnected, driver).await
}

#[cfg(feature = "native-desktop")]
async fn serve(
    mut receive: mpsc::Receiver<ParentFrame>,
    mut output: impl AsyncWrite + Unpin,
    disconnected: CancellationToken,
    driver: Arc<Mutex<Driver>>,
) -> io::Result<()> {
    let mut sessions = HashMap::<String, Session>::new();
    let audio_enabled = driver.lock().await.audio_enabled;
    write(
        &mut output,
        &Hello {
            protocol: PROTOCOL,
            platform: local_platform().into(),
            audio_enabled,
        },
    )
    .await?;
    let mut shutdown = None;
    let mut transport_error = None;
    let mut last_request = 0;
    let mut last_authorization = 0;
    while let Some(frame) = tokio::select! {
        biased;
        _ = disconnected.cancelled() => None,
        request = receive.recv() => request,
    } {
        let ParentFrame::Request { id, request } = frame else {
            transport_error = Some(io::Error::new(
                io::ErrorKind::InvalidData,
                "desktop authorization invocation expired",
            ));
            break;
        };
        if id <= last_request {
            transport_error = Some(io::Error::new(
                io::ErrorKind::InvalidData,
                "desktop request identity mismatch",
            ));
            break;
        }
        last_request = id;
        if matches!(request, Request::Shutdown) {
            shutdown = Some(id);
            break;
        }
        let (requests, callbacks) = mpsc::channel(1);
        let authorization: Arc<dyn BrowserAuthorization> =
            Arc::new(RemoteAuthorization { requests });
        let dispatch = dispatch(
            request,
            &mut sessions,
            &driver,
            authorization,
            &disconnected,
        );
        let result = match dispatch_with_authorization(
            id,
            dispatch,
            callbacks,
            &mut receive,
            &mut output,
            &disconnected,
            &mut last_authorization,
        )
        .await
        {
            Ok(result) => result,
            Err(error) => {
                transport_error = Some(error);
                break;
            }
        };
        if let Err(error) = write(&mut output, &WorkerFrame::Response { id, result }).await {
            transport_error = Some(error);
            break;
        }
    }
    let mut cleanup = Ok(Value::Null);
    for local in sessions.values_mut() {
        if let Err(error) = local.close().await {
            cleanup = Err(Failure::from(error));
        }
    }
    if let Err(error) = driver.lock().await.close().await {
        cleanup = Err(Failure::from(error));
    }
    if let Some(id) = shutdown {
        let status = cleanup
            .as_ref()
            .map(|_| ())
            .map_err(|error| io::Error::other(format!("{error:?}")));
        write(
            &mut output,
            &WorkerFrame::Response {
                id,
                result: cleanup,
            },
        )
        .await?;
        return transport_error.map_or(status, Err);
    }
    if let Some(error) = transport_error {
        return Err(error);
    }
    cleanup
        .map(|_| ())
        .map_err(|error| io::Error::other(format!("{error:?}")))
}

#[cfg(feature = "native-desktop")]
async fn dispatch(
    request: Request,
    sessions: &mut HashMap<String, Session>,
    driver: &Arc<Mutex<Driver>>,
    authorization: Arc<dyn BrowserAuthorization>,
    disconnected: &CancellationToken,
) -> Result<Value, ToolError> {
    match request {
        Request::Invoke {
            session,
            turn,
            browsers,
            command,
            language,
        } => {
            if session.is_empty() || turn.is_empty() {
                Err(failed("invalid desktop Session or turn identity"))
            } else if sessions.len() >= 16 && !sessions.contains_key(&session) {
                Err(failed("desktop Session capacity reached"))
            } else {
                let local = sessions
                    .entry(session.clone())
                    .or_insert_with(|| Session::new(driver.clone()));
                local.configure_browsers(browsers, language)?;
                local
                    .invoke(
                        command,
                        &InvocationContext::new(&session, &turn)
                            .with_browser_authorization(authorization),
                        disconnected,
                        language,
                    )
                    .await
            }
        }
        Request::CloseSession { session } => {
            let result = match sessions.get_mut(&session) {
                Some(local) => local.close().await,
                None => Ok(()),
            };
            if result.is_ok() {
                sessions.remove(&session);
            }
            result.map(|()| Value::Null)
        }
        Request::DiscardAudio { session } => match sessions.get_mut(&session) {
            Some(local) => local.discard_audio().await,
            None => Ok(()),
        }
        .map(|()| Value::Null),
        Request::FinishTurn {
            session,
            turn,
            language,
        } => match sessions.get_mut(&session) {
            Some(local) => local.finish_turn(&session, &turn, language).await,
            None => Ok(()),
        }
        .map(|()| Value::Null),
        Request::Shutdown => unreachable!("shutdown is handled after resource settlement"),
    }
}

fn length(length: u32) -> io::Result<usize> {
    let length = length as usize;
    if length == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid desktop frame length",
        ));
    }
    Ok(length)
}
fn encode(value: &impl Serialize) -> io::Result<Vec<u8>> {
    let mut bytes = vec![0; 4];
    serde_json::to_writer(&mut bytes, value)?;
    let size = bytes.len() - 4;
    let size = u32::try_from(size).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "desktop message is not representable",
        )
    })?;
    if size == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "desktop message too large",
        ));
    }
    bytes[..4].copy_from_slice(&size.to_be_bytes());
    Ok(bytes)
}
async fn write(output: &mut (impl AsyncWrite + Unpin), value: &impl Serialize) -> io::Result<()> {
    output.write_all(&encode(value)?).await?;
    output.flush().await
}
async fn read<R: AsyncRead + Unpin, T: DeserializeOwned>(input: &mut R) -> io::Result<T> {
    let mut bytes = vec![0; length(input.read_u32().await?)?];
    input.read_exact(&mut bytes).await?;
    serde_json::from_slice(&bytes).map_err(Into::into)
}
#[cfg(any(feature = "native-desktop", test))]
fn read_sync<T: DeserializeOwned>(input: &mut impl io::Read) -> io::Result<T> {
    let mut header = [0; 4];
    input.read_exact(&mut header)?;
    let mut bytes = vec![0; length(u32::from_be_bytes(header))?];
    input.read_exact(&mut bytes)?;
    serde_json::from_slice(&bytes).map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[cfg(feature = "native-desktop")]
    struct TestRequests {
        send: mpsc::Sender<ParentFrame>,
        id: std::sync::atomic::AtomicU64,
    }

    #[cfg(feature = "native-desktop")]
    impl TestRequests {
        async fn send(&self, request: Request) -> Result<(), mpsc::error::SendError<ParentFrame>> {
            let id = self.id.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
            self.send.send(ParentFrame::Request { id, request }).await
        }
    }

    #[cfg(feature = "native-desktop")]
    fn requests() -> (TestRequests, mpsc::Receiver<ParentFrame>) {
        let (send, receive) = mpsc::channel(1);
        (
            TestRequests {
                send,
                id: std::sync::atomic::AtomicU64::new(0),
            },
            receive,
        )
    }

    #[cfg(feature = "native-desktop")]
    async fn response(output: &mut (impl AsyncRead + Unpin)) -> io::Result<Response> {
        match read::<_, WorkerFrame>(output).await? {
            WorkerFrame::Response { result, .. } => Ok(result),
            _ => Err(io::Error::other(
                "unexpected callback in non-browser fixture",
            )),
        }
    }

    fn request(session: &str, command: Value) -> Request {
        Request::Invoke {
            session: session.into(),
            turn: "fixture-turn".into(),
            browsers: Vec::new(),
            command: serde_json::from_value(command).unwrap(),
            language: maka_agent_facts::language::Language::En,
        }
    }

    #[tokio::test]
    async fn discarding_unbound_audio_does_not_prepare_a_worker() {
        let mut worker = Worker::with_audio(true);
        worker.discard_audio("unbound-session").await.unwrap();
        assert!(worker.process.is_none());
        worker.close().await.unwrap();
    }

    #[tokio::test]
    async fn desktop_frames_preserve_invoke_language() {
        use crate::protocol::{Action, Direction, Distance, Handle, Position};
        use maka_agent_facts::language::Language;

        for (language, tag) in [
            (Language::ZhCn, "zh-CN"),
            (Language::ZhTw, "zh-TW"),
            (Language::En, "en"),
        ] {
            let request = Request::Invoke {
                session: "same-session".into(),
                turn: "fixture-turn".into(),
                browsers: Vec::new(),
                command: Command::Documentation,
                language,
            };
            let framed = encode(&request).unwrap();
            let decoded: Request = read_sync(&mut framed.as_slice()).unwrap();
            assert_eq!(
                serde_json::to_value(decoded).unwrap(),
                json!({
                    "method": "invoke",
                    "session": "same-session",
                    "turn": "fixture-turn",
                    "browsers": [],
                    "command": { "method": "documentation" },
                    "language": tag,
                }),
            );
        }

        // Preserve the caller's binary64 values through the actual parent /
        // helper framing in both directions, before any OS-specific policy.
        // Decimal values: 0.12345678901234569, 17.123456789012344,
        // 5.123456789012345. The first loses one ULP with the approximate
        // JSON float parser, even though its printed value looks equivalent.
        let expected = [
            0x3fbf_9add_3746_f660,
            0x4031_1f9a_dd37_46f6,
            0x4014_7e6b_74dd_1bd9,
        ];
        for pixels in [false, true] {
            let [amount, x, y] = expected.map(f64::from_bits);
            let request = ParentFrame::Request {
                id: 42,
                request: Request::Invoke {
                    session: "same-session".into(),
                    turn: "fixture-turn".into(),
                    browsers: Vec::new(),
                    command: Command::Action {
                        handle: Handle::App("numeric-target".into()),
                        action: Action::Scroll {
                            target: Position::Point([x, y]),
                            direction: Direction::Down,
                            distance: Some(if pixels {
                                Distance::Pixels { pixels: amount }
                            } else {
                                Distance::Pages(amount)
                            }),
                        },
                    },
                    language: Language::En,
                },
            };
            let framed = encode(&request).unwrap();
            assert_eq!(
                u32::from_be_bytes(framed[..4].try_into().unwrap()) as usize,
                framed.len() - 4
            );
            let ParentFrame::Request {
                id,
                request:
                    Request::Invoke {
                        session,
                        turn,
                        command:
                            Command::Action {
                                handle: Handle::App(target),
                                action:
                                    Action::Scroll {
                                        target: Position::Point(point),
                                        direction: Direction::Down,
                                        distance,
                                    },
                            },
                        ..
                    },
            } = read_sync(&mut framed.as_slice()).unwrap()
            else {
                panic!("numeric action changed its typed worker request");
            };
            assert_eq!(
                (id, session.as_str(), turn.as_str(), target.as_str()),
                (42, "same-session", "fixture-turn", "numeric-target")
            );
            let amount = match (pixels, distance) {
                (false, Some(Distance::Pages(amount)))
                | (true, Some(Distance::Pixels { pixels: amount })) => amount,
                _ => panic!("scroll distance changed its typed unit across the worker boundary"),
            };
            assert_eq!(
                [amount.to_bits(), point[0].to_bits(), point[1].to_bits()],
                expected
            );

            let (mut parent, mut helper) = tokio::io::duplex(1024);
            write(
                &mut helper,
                &WorkerFrame::Response {
                    id,
                    result: Ok(json!({"amount":amount,"x":point[0],"y":point[1]})),
                },
            )
            .await
            .unwrap();
            let WorkerFrame::Response {
                id: response_id,
                result: Ok(response),
            } = read(&mut parent).await.unwrap()
            else {
                panic!("numeric response changed its worker frame");
            };
            assert_eq!(response_id, id);
            assert_eq!(
                ["amount", "x", "y"].map(|field| response[field].as_f64().unwrap().to_bits()),
                expected
            );
        }
    }

    #[cfg(feature = "native-desktop")]
    #[tokio::test]
    async fn discard_audio_only_visits_an_existing_helper_session() {
        let mut sessions = HashMap::new();
        let driver = Arc::new(Mutex::new(Driver::with_audio(true)));
        let (requests, _callbacks) = mpsc::channel(1);
        let authorization: Arc<dyn BrowserAuthorization> =
            Arc::new(RemoteAuthorization { requests });
        let cancellation = CancellationToken::new();
        assert_eq!(
            dispatch(
                Request::DiscardAudio {
                    session: "absent".into()
                },
                &mut sessions,
                &driver,
                authorization.clone(),
                &cancellation
            )
            .await
            .unwrap(),
            Value::Null
        );
        assert!(
            sessions.is_empty(),
            "discarding missing audio cannot create a native Session"
        );
        let configured = dispatch(
            request(
                "owner",
                json!({"method":"configureCursor","options":{"label":"retained","enabled":false}}),
            ),
            &mut sessions,
            &driver,
            authorization.clone(),
            &cancellation,
        )
        .await
        .unwrap();
        assert_eq!(configured["settings"]["label"], "retained");
        dispatch(
            Request::DiscardAudio {
                session: "owner".into(),
            },
            &mut sessions,
            &driver,
            authorization.clone(),
            &cancellation,
        )
        .await
        .unwrap();
        let state = dispatch(
            request("owner", json!({"method":"cursorState","options":{}})),
            &mut sessions,
            &driver,
            authorization,
            &cancellation,
        )
        .await
        .unwrap();
        assert_eq!(
            state["settings"]["label"], "retained",
            "audio cleanup retains unrelated Session configuration"
        );
        for session in sessions.values_mut() {
            session.close().await.unwrap();
        }
        driver.lock().await.close().await.unwrap();
    }

    #[cfg(feature = "native-desktop")]
    #[tokio::test]
    async fn desktop_sessions_own_targets_and_reset_independently() {
        let (send, receive) = requests();
        let (mut output, writer) = tokio::io::duplex(64 * 1024);
        let driver = Arc::new(Mutex::new(Driver::default()));
        let task = tokio::spawn(serve(receive, writer, CancellationToken::new(), driver));
        let hello: Hello = read(&mut output).await.unwrap();
        assert_eq!(hello.platform, local_platform());
        for (session, label) in [("a", "Alice"), ("b", "Bob")] {
            send.send(request(
                session,
                json!({"method":"configureCursor","options":{"label":label,"enabled":false}}),
            ))
            .await
            .unwrap();
            let result: Response = response(&mut output).await.unwrap();
            assert_eq!(result.unwrap()["settings"]["label"], label);
        }
        send.send(Request::FinishTurn {
            session: "a".into(),
            turn: "fixture-turn".into(),
            language: maka_agent_facts::language::Language::En,
        })
        .await
        .unwrap();
        assert_eq!(response(&mut output).await.unwrap().unwrap(), Value::Null);
        send.send(request("a", json!({"method":"cursorState","options":{}})))
            .await
            .unwrap();
        assert_eq!(
            response(&mut output).await.unwrap().unwrap()["settings"]["label"],
            "Alice",
            "turn cleanup must retain the Session's configuration"
        );
        send.send(Request::CloseSession {
            session: "a".into(),
        })
        .await
        .unwrap();
        assert!(response(&mut output).await.unwrap().is_ok());
        for (session, label) in [("a", "Maka"), ("b", "Bob")] {
            send.send(request(
                session,
                json!({"method":"cursorState","options":{}}),
            ))
            .await
            .unwrap();
            let result: Response = response(&mut output).await.unwrap();
            assert_eq!(result.unwrap()["settings"]["label"], label);
        }
        send.send(request("a", json!({"method":"observe","handle":{"kind":"app","id":"unbound"},"kind":"ax","options":{}}))).await.unwrap();
        let error = response(&mut output).await.unwrap().unwrap_err();
        assert!(
            matches!(error, Failure::Failed(message) if message == "stale_target: bind the app again")
        );
        send.send(Request::Shutdown).await.unwrap();
        assert!(response(&mut output).await.unwrap().is_ok());
        task.await.unwrap().unwrap();
    }

    #[cfg(feature = "native-desktop")]
    #[tokio::test]
    async fn desktop_transport_keeps_language_per_invoke_not_per_session() {
        use maka_agent_facts::language::Language;
        let (send, receive) = requests();
        let (mut output, writer) = tokio::io::duplex(64 * 1024);
        let task = tokio::spawn(serve(
            receive,
            writer,
            CancellationToken::new(),
            Arc::new(Mutex::new(Driver::default())),
        ));
        let _: Hello = read(&mut output).await.unwrap();
        for (language, tag, recovery) in [
            (Language::ZhCn, "zh-CN", "重新绑定目标"),
            (Language::ZhTw, "zh-TW", "重新綁定目標"),
            (Language::En, "en", "target rebinding"),
        ] {
            let request = Request::Invoke {
                session: "same-session".into(),
                turn: "fixture-turn".into(),
                browsers: Vec::new(),
                command: Command::Documentation,
                language,
            };
            // Exercise the helper's real framed serializer/deserializer before
            // dispatch; locale is transport metadata, never model command data.
            let framed = encode(&request).unwrap();
            let decoded: Request = read_sync(&mut framed.as_slice()).unwrap();
            assert_eq!(serde_json::to_value(&decoded).unwrap()["language"], tag);
            send.send(decoded).await.unwrap();
            let response: Response = response(&mut output).await.unwrap();
            let text = response.unwrap();
            let text = text.as_str().unwrap();
            assert!(
                text.contains(recovery)
                    && text.contains("cua_reset")
                    && text.contains("getAXState")
            );
        }
        send.send(Request::Shutdown).await.unwrap();
        assert!(response(&mut output).await.unwrap().is_ok());
        task.await.unwrap().unwrap();
    }

    #[cfg(feature = "native-desktop")]
    #[tokio::test]
    async fn disconnected_desktop_discards_queued_work_and_closes_output() {
        let (send, receive) = requests();
        send.send(request("queued", json!({"method":"documentation"})))
            .await
            .unwrap();
        let stop = CancellationToken::new();
        stop.cancel();
        let (mut output, writer) = tokio::io::duplex(1024);
        let task = tokio::spawn(serve(
            receive,
            writer,
            stop,
            Arc::new(Mutex::new(Driver::default())),
        ));
        let _: Hello = read(&mut output).await.unwrap();
        assert_eq!(
            response(&mut output).await.unwrap_err().kind(),
            io::ErrorKind::UnexpectedEof
        );
        task.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn desktop_frames_reject_empty_and_partial_responses() {
        let mut oversize = 0_u32.to_be_bytes().as_slice().to_vec();
        assert_eq!(
            read::<_, Response>(&mut oversize.as_slice())
                .await
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidData
        );
        assert_eq!(
            read_sync::<Response>(&mut oversize.as_slice())
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidData
        );
        oversize = encode(&Ok::<_, Failure>(json!({"image":"payload"}))).unwrap();
        oversize.pop();
        assert_eq!(
            read::<_, Response>(&mut oversize.as_slice())
                .await
                .unwrap_err()
                .kind(),
            io::ErrorKind::UnexpectedEof
        );
    }

    fn browser_access(url: &str) -> BrowserAccess {
        BrowserAccess::Read {
            document: crate::BrowserDocument {
                browser_id: "fixture-browser".into(),
                generation: "ws://127.0.0.1/devtools/browser/fixture".into(),
                tab_id: "fixture-tab".into(),
                url: url.into(),
            },
        }
    }

    struct FixtureAuthorization {
        calls: Arc<std::sync::Mutex<Vec<(&'static str, BrowserAccess)>>>,
        waiting: Option<Arc<tokio::sync::Notify>>,
        cancellation: Arc<std::sync::Mutex<Option<CancellationToken>>>,
    }

    impl BrowserAuthorization for FixtureAuthorization {
        fn authorize(
            &self,
            access: BrowserAccess,
            cancellation: CancellationToken,
        ) -> crate::AuthorizationFuture {
            self.calls.lock().unwrap().push(("authorize", access));
            *self.cancellation.lock().unwrap() = Some(cancellation.clone());
            let waiting = self.waiting.clone();
            Box::pin(async move {
                if let Some(waiting) = waiting {
                    waiting.notify_one();
                    cancellation.cancelled().await;
                    return Err(failed("fixture permission cancelled"));
                }
                Ok(())
            })
        }
        fn check(&self, access: BrowserAccess, _: CancellationToken) -> crate::AuthorizationFuture {
            self.calls.lock().unwrap().push(("check", access));
            Box::pin(async { Err(failed("fixture has no existing grant")) })
        }
    }

    fn authorization(waiting: Option<Arc<tokio::sync::Notify>>) -> Arc<FixtureAuthorization> {
        Arc::new(FixtureAuthorization {
            calls: Arc::new(std::sync::Mutex::new(Vec::new())),
            waiting,
            cancellation: Arc::new(std::sync::Mutex::new(None)),
        })
    }

    #[tokio::test]
    async fn browser_callbacks_forward_exact_invocation_and_distinguish_check() {
        let (parent, peer) = tokio::io::duplex(4096);
        let (mut output, mut input) = tokio::io::split(parent);
        let (mut peer_input, mut peer_output) = tokio::io::split(peer);
        let expected = browser_access("https://example.test/private");
        let access = expected.clone();
        let peer = tokio::spawn(async move {
            let ParentFrame::Request {
                id,
                request: Request::Invoke { session, turn, .. },
            } = read(&mut peer_input).await.unwrap()
            else {
                panic!("expected invoke");
            };
            assert_eq!(
                (id, session.as_str(), turn.as_str()),
                (1, "owner", "fixture-turn")
            );
            for (authorization_id, mode) in [
                (1, AuthorizationMode::Authorize),
                (2, AuthorizationMode::Check),
            ] {
                write(
                    &mut peer_output,
                    &WorkerFrame::BrowserAuthorization {
                        id,
                        authorization_id,
                        mode,
                        access: access.clone(),
                    },
                )
                .await
                .unwrap();
                let ParentFrame::BrowserAuthorizationResult {
                    id: response_id,
                    authorization_id: response_authorization,
                    result,
                } = read(&mut peer_input).await.unwrap()
                else {
                    panic!("expected authorization result");
                };
                assert_eq!((response_id, response_authorization), (1, authorization_id));
                if authorization_id == 1 {
                    assert!(result.is_ok());
                } else {
                    assert!(
                        matches!(result, Err(Failure::Failed(message)) if message == "fixture has no existing grant")
                    );
                }
            }
            write(
                &mut peer_output,
                &WorkerFrame::Response {
                    id,
                    result: Ok(json!({"settled": true})),
                },
            )
            .await
            .unwrap();
        });
        let authorization = authorization(None);
        let frame = encode(&ParentFrame::Request {
            id: 1,
            request: request("owner", json!({"method":"documentation"})),
        })
        .unwrap();
        let mut last = 0;
        let result = exchange_frames(
            &mut input,
            &mut output,
            &frame,
            1,
            &mut last,
            Some(authorization.clone()),
            &CancellationToken::new(),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(result, json!({"settled":true}));
        assert_eq!(
            *authorization.calls.lock().unwrap(),
            vec![("authorize", expected.clone()), ("check", expected)]
        );
        assert_eq!(last, 2);
        peer.await.unwrap();
    }

    #[tokio::test]
    async fn cancelled_host_prompt_denies_and_preserves_partially_read_settlement() {
        let (parent, peer) = tokio::io::duplex(4096);
        let (mut output, mut input) = tokio::io::split(parent);
        let (mut peer_input, mut peer_output) = tokio::io::split(peer);
        let waiting = Arc::new(tokio::sync::Notify::new());
        let authorization = authorization(Some(waiting.clone()));
        let cancellation = CancellationToken::new();
        let cancel = cancellation.clone();
        let peer = tokio::spawn(async move {
            let _: ParentFrame = read(&mut peer_input).await.unwrap();
            write(
                &mut peer_output,
                &WorkerFrame::BrowserAuthorization {
                    id: 1,
                    authorization_id: 1,
                    mode: AuthorizationMode::Authorize,
                    access: browser_access("https://cancel.test/"),
                },
            )
            .await
            .unwrap();
            waiting.notified().await;
            let settlement = encode(&WorkerFrame::Response {
                id: 1,
                result: Err(Failure::Failed("native invocation refused".into())),
            })
            .unwrap();
            peer_output.write_all(&settlement[..2]).await.unwrap();
            tokio::task::yield_now().await;
            cancel.cancel();
            let ParentFrame::BrowserAuthorizationResult {
                id,
                authorization_id,
                result,
            } = read(&mut peer_input).await.unwrap()
            else {
                panic!("expected denial");
            };
            assert_eq!((id, authorization_id), (1, 1));
            assert!(
                matches!(result, Err(Failure::Failed(message)) if message == "Browser authorization cancelled")
            );
            peer_output.write_all(&settlement[2..]).await.unwrap();
        });
        let frame = encode(&ParentFrame::Request {
            id: 1,
            request: request("owner", json!({"method":"documentation"})),
        })
        .unwrap();
        let result = exchange_frames(
            &mut input,
            &mut output,
            &frame,
            1,
            &mut 0,
            Some(authorization.clone()),
            &cancellation,
        )
        .await
        .unwrap();
        assert!(
            matches!(result, Err(Failure::Failed(message)) if message == "native invocation refused")
        );
        assert!(
            authorization
                .cancellation
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .is_cancelled()
        );
        peer.await.unwrap();
    }

    #[tokio::test]
    async fn settled_callback_expires_before_the_next_invocation_authority() {
        let (parent, peer) = tokio::io::duplex(4096);
        let (mut output, mut input) = tokio::io::split(parent);
        let (mut peer_input, mut peer_output) = tokio::io::split(peer);
        let waiting = Arc::new(tokio::sync::Notify::new());
        let first = authorization(Some(waiting.clone()));
        let second = authorization(None);
        let peer = tokio::spawn(async move {
            let _: ParentFrame = read(&mut peer_input).await.unwrap();
            write(
                &mut peer_output,
                &WorkerFrame::BrowserAuthorization {
                    id: 1,
                    authorization_id: 1,
                    mode: AuthorizationMode::Authorize,
                    access: browser_access("https://first.test/"),
                },
            )
            .await
            .unwrap();
            waiting.notified().await;
            write(
                &mut peer_output,
                &WorkerFrame::Response {
                    id: 1,
                    result: Ok(json!("expired")),
                },
            )
            .await
            .unwrap();
            // No reply for invocation1 may leak ahead of invocation2.
            let ParentFrame::Request { id: 2, .. } = read(&mut peer_input).await.unwrap() else {
                panic!("old callback escaped its invocation");
            };
            write(
                &mut peer_output,
                &WorkerFrame::BrowserAuthorization {
                    id: 2,
                    authorization_id: 2,
                    mode: AuthorizationMode::Authorize,
                    access: browser_access("https://second.test/"),
                },
            )
            .await
            .unwrap();
            let ParentFrame::BrowserAuthorizationResult {
                id: 2,
                authorization_id: 2,
                result: Ok(()),
            } = read(&mut peer_input).await.unwrap()
            else {
                panic!("second authority was not used");
            };
            write(
                &mut peer_output,
                &WorkerFrame::Response {
                    id: 2,
                    result: Ok(json!("second")),
                },
            )
            .await
            .unwrap();
        });
        let mut last = 0;
        for (id, authorization, expected) in
            [(1, first.clone(), "expired"), (2, second.clone(), "second")]
        {
            let frame = encode(&ParentFrame::Request {
                id,
                request: request("owner", json!({"method":"documentation"})),
            })
            .unwrap();
            assert_eq!(
                exchange_frames(
                    &mut input,
                    &mut output,
                    &frame,
                    id,
                    &mut last,
                    Some(authorization),
                    &CancellationToken::new()
                )
                .await
                .unwrap()
                .unwrap(),
                json!(expected)
            );
        }
        assert!(
            first
                .cancellation
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .is_cancelled()
        );
        assert_eq!(
            *first.calls.lock().unwrap(),
            vec![("authorize", browser_access("https://first.test/"))]
        );
        assert_eq!(
            *second.calls.lock().unwrap(),
            vec![("authorize", browser_access("https://second.test/"))]
        );
        peer.await.unwrap();
    }

    struct CanonicalAuthorization {
        store: maka_event_log::SessionStore,
        invocation: maka_agent_facts::event::Invocation,
        record: maka_agent_facts::interaction::InteractionRecord,
        published: Arc<tokio::sync::Notify>,
    }

    impl BrowserAuthorization for CanonicalAuthorization {
        fn authorize(
            &self,
            _: BrowserAccess,
            cancellation: CancellationToken,
        ) -> crate::AuthorizationFuture {
            let store = self.store.clone();
            let invocation = self.invocation.clone();
            let record = self.record.clone();
            let published = self.published.clone();
            Box::pin(async move {
                store
                    .establish_run_interaction(&invocation, &record)
                    .await
                    .map_err(|error| ToolError::Persistence(error.to_string()))?;
                published.notify_one();
                maka_agent_authority::interaction_wait::wait(&store, &record, &cancellation)
                    .await
                    .map_err(|error| ToolError::CleanupUnconfirmed(error.into()))?;
                Err(failed("canonical consent closed"))
            })
        }
        fn check(&self, _: BrowserAccess, _: CancellationToken) -> crate::AuthorizationFuture {
            Box::pin(async { Err(failed("canonical origin grant missing")) })
        }
    }

    #[tokio::test]
    async fn cancelled_or_expired_callback_settles_canonical_prompt_before_returning() {
        use maka_agent_facts::{
            event::{EventWrite, Fact, Invocation, InvocationInput, RuntimeEvent},
            interaction::{
                ClosureReason, Decision, GrantCapability, GrantScope, GrantTarget,
                InteractionOutcome, InteractionRecord, InteractionRequest,
            },
        };
        for response_first in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let owner = maka_event_log::root::RootOwner::create(
                &directory.path().join("root"),
                &maka_event_log::root::RootNamespaces {
                    ownership: directory.path().join("ownership"),
                    control: directory.path().join("control"),
                },
            )
            .unwrap();
            let root = maka_event_log::RootStore::open(Arc::new(owner))
                .await
                .unwrap();
            let store = root
                .create_session("session", "fixture", &json!({}), 1)
                .await
                .unwrap();
            let invocation = Invocation {
                session_id: "session".into(),
                turn_id: "turn".into(),
                run_id: "run".into(),
                invocation_id: "invocation".into(),
            };
            store
                .append(
                    &EventWrite::plain(RuntimeEvent::new(
                        invocation.clone(),
                        Fact::InvocationOpened {
                            configuration: None,
                            input: InvocationInput::Message {
                                content: "browser consent".into(),
                                request_fingerprint: None,
                                source_messages: vec![],
                            },
                        },
                    ))
                    .unwrap(),
                )
                .await
                .unwrap();
            let target = GrantTarget {
                provider_id: "maka_workspace_computer".into(),
                contract_id: "maka_workspace_computer_v1".into(),
                server_id: "maka_workspace_computer".into(),
                tool_name: "cua_repl".into(),
                capability: GrantCapability::Browser,
                scope: GrantScope::BrowserOrigin {
                    origin: "https://cancel.test".into(),
                },
            };
            let record = InteractionRecord {
                session_id: "session".into(),
                turn_id: "turn".into(),
                run_id: "run".into(),
                request_id: "cancelled_browser_origin".into(),
                created_at: 2,
                outcome: None,
                request: InteractionRequest::ClientCapability {
                    tool_use_id: "browser-operation".into(),
                    basis: None,
                    target: target.clone(),
                },
            };
            let published = Arc::new(tokio::sync::Notify::new());
            let authorization = Arc::new(CanonicalAuthorization {
                store: store.clone(),
                invocation,
                record: record.clone(),
                published: published.clone(),
            });
            let cancellation = CancellationToken::new();
            let cancel = cancellation.clone();
            let (parent, peer) = tokio::io::duplex(4096);
            let (mut output, mut input) = tokio::io::split(parent);
            let (mut peer_input, mut peer_output) = tokio::io::split(peer);
            let peer = tokio::spawn(async move {
                let _: ParentFrame = read(&mut peer_input).await.unwrap();
                write(
                    &mut peer_output,
                    &WorkerFrame::BrowserAuthorization {
                        id: 1,
                        authorization_id: 1,
                        mode: AuthorizationMode::Authorize,
                        access: browser_access("https://cancel.test/"),
                    },
                )
                .await
                .unwrap();
                published.notified().await;
                let response = WorkerFrame::Response {
                    id: 1,
                    result: Err(Failure::Failed("native invocation refused".into())),
                };
                if response_first {
                    write(&mut peer_output, &response).await.unwrap();
                } else {
                    cancel.cancel();
                    let ParentFrame::BrowserAuthorizationResult {
                        id: 1,
                        authorization_id: 1,
                        result: Err(Failure::Failed(message)),
                    } = read(&mut peer_input).await.unwrap()
                    else {
                        panic!("expected cancelled origin decision");
                    };
                    assert_eq!(message, "Browser authorization cancelled");
                    write(&mut peer_output, &response).await.unwrap();
                }
            });
            let frame = encode(&ParentFrame::Request {
                id: 1,
                request: request("session", json!({"method":"documentation"})),
            })
            .unwrap();
            let result = exchange_frames(
                &mut input,
                &mut output,
                &frame,
                1,
                &mut 0,
                Some(authorization),
                &cancellation,
            )
            .await
            .unwrap();
            assert!(
                matches!(result, Err(Failure::Failed(message)) if message == "native invocation refused")
            );
            let canonical = store
                .interaction(&record.request_id)
                .await
                .unwrap()
                .unwrap();
            assert!(
                matches!(
                    canonical.outcome,
                    Some(InteractionOutcome::Closure {
                        reason: ClosureReason::ProducerCancelled,
                        ..
                    })
                ),
                "the canonical pending prompt must close before the native operation returns"
            );
            let late = store
                .commit_interaction_outcome(
                    &record.request_id,
                    InteractionOutcome::ClientCapabilityDecision {
                        decision: Decision::Allow,
                        committed_at: 3,
                    },
                )
                .await
                .unwrap();
            assert!(
                !late.matches,
                "an abandoned prompt cannot accept a late approval"
            );
            assert!(
                store
                    .client_capability_grant("session", &target)
                    .await
                    .unwrap()
                    .is_none()
            );
            peer.await.unwrap();
            root.close().await.unwrap();
        }
    }

    struct UnconfirmedAuthorization {
        started: Arc<tokio::sync::Notify>,
    }
    impl BrowserAuthorization for UnconfirmedAuthorization {
        fn authorize(
            &self,
            _: BrowserAccess,
            cancellation: CancellationToken,
        ) -> crate::AuthorizationFuture {
            let started = self.started.clone();
            Box::pin(async move {
                started.notify_one();
                cancellation.cancelled().await;
                Err(ToolError::CleanupUnconfirmed(
                    "canonical withdrawal unavailable".into(),
                ))
            })
        }
        fn check(
            &self,
            _: BrowserAccess,
            cancellation: CancellationToken,
        ) -> crate::AuthorizationFuture {
            self.authorize(browser_access("https://cancel.test/"), cancellation)
        }
    }

    #[tokio::test]
    async fn unconfirmed_callback_cleanup_still_waits_for_native_settlement() {
        let (parent, peer) = tokio::io::duplex(4096);
        let (mut output, mut input) = tokio::io::split(parent);
        let (mut peer_input, mut peer_output) = tokio::io::split(peer);
        let cancellation = CancellationToken::new();
        let cancel = cancellation.clone();
        let started = Arc::new(tokio::sync::Notify::new());
        let started_peer = started.clone();
        let (settled, settlement) = oneshot::channel();
        let (release, released) = oneshot::channel();
        let peer = tokio::spawn(async move {
            let _: ParentFrame = read(&mut peer_input).await.unwrap();
            write(
                &mut peer_output,
                &WorkerFrame::BrowserAuthorization {
                    id: 1,
                    authorization_id: 1,
                    mode: AuthorizationMode::Authorize,
                    access: browser_access("https://cancel.test/"),
                },
            )
            .await
            .unwrap();
            started_peer.notified().await;
            cancel.cancel();
            let ParentFrame::BrowserAuthorizationResult {
                result: Err(Failure::CleanupUnconfirmed(message)),
                ..
            } = read(&mut peer_input).await.unwrap()
            else {
                panic!("expected cleanup uncertainty");
            };
            assert!(message.contains("canonical withdrawal unavailable"));
            settled.send(()).unwrap();
            released.await.unwrap();
            write(
                &mut peer_output,
                &WorkerFrame::Response {
                    id: 1,
                    result: Ok(json!("native settled")),
                },
            )
            .await
            .unwrap();
        });
        let frame = encode(&ParentFrame::Request {
            id: 1,
            request: request("owner", json!({"method":"documentation"})),
        })
        .unwrap();
        let task = tokio::spawn(async move {
            exchange_frames(
                &mut input,
                &mut output,
                &frame,
                1,
                &mut 0,
                Some(Arc::new(UnconfirmedAuthorization { started })),
                &cancellation,
            )
            .await
        });
        settlement.await.unwrap();
        assert!(
            !task.is_finished(),
            "unknown authority cleanup cannot abandon the native response"
        );
        release.send(()).unwrap();
        assert!(
            matches!(task.await.unwrap(), Err(ToolError::CleanupUnconfirmed(message)) if message.contains("canonical withdrawal unavailable"))
        );
        peer.await.unwrap();
    }

    #[tokio::test]
    async fn old_worker_callback_never_reaches_the_next_host_invocation() {
        let (parent, peer) = tokio::io::duplex(4096);
        let (mut output, mut input) = tokio::io::split(parent);
        let (mut peer_input, mut peer_output) = tokio::io::split(peer);
        let peer = tokio::spawn(async move {
            let ParentFrame::Request { id: 2, .. } = read(&mut peer_input).await.unwrap() else {
                panic!("expected second invocation");
            };
            write(
                &mut peer_output,
                &WorkerFrame::BrowserAuthorization {
                    id: 1,
                    authorization_id: 2,
                    mode: AuthorizationMode::Authorize,
                    access: browser_access("https://old.test/"),
                },
            )
            .await
            .unwrap();
        });
        let authorization = authorization(None);
        let frame = encode(&ParentFrame::Request {
            id: 2,
            request: request("next-owner", json!({"method":"documentation"})),
        })
        .unwrap();
        let error = exchange_frames(
            &mut input,
            &mut output,
            &frame,
            2,
            &mut 1,
            Some(authorization.clone()),
            &CancellationToken::new(),
        )
        .await
        .unwrap_err();
        assert!(
            matches!(error, ToolError::OutcomeUnknown(message) if message == "desktop response identity mismatch")
        );
        assert!(
            authorization.calls.lock().unwrap().is_empty(),
            "an old worker callback must not request a grant from the new Host invocation"
        );
        peer.await.unwrap();
    }

    #[tokio::test]
    async fn framed_remote_authorization_denial_and_success_reach_the_dispatcher() {
        let (parent, peer) = tokio::io::duplex(4096);
        let (mut output, mut input) = tokio::io::split(parent);
        let (mut peer_input, mut peer_output) = tokio::io::split(peer);
        let (send, mut receive) = mpsc::channel(1);
        let reader = tokio::spawn(async move {
            while let Ok(frame) = read(&mut peer_input).await {
                if send.send(frame).await.is_err() {
                    break;
                }
            }
        });
        let peer = tokio::spawn(async move {
            let mut authorization_id = 0;
            for id in [1, 2] {
                let Some(ParentFrame::Request { id: request_id, .. }) = receive.recv().await else {
                    panic!("expected framed invoke");
                };
                assert_eq!(request_id, id);
                let (requests, callbacks) = mpsc::channel(1);
                let remote = RemoteAuthorization { requests };
                let stop = CancellationToken::new();
                let dispatch = async {
                    remote
                        .authorize(browser_access("https://protected.test/"), stop.clone())
                        .await?;
                    Ok(json!({"effect":"authorized"}))
                };
                let result = dispatch_with_authorization(
                    id,
                    dispatch,
                    callbacks,
                    &mut receive,
                    &mut peer_output,
                    &stop,
                    &mut authorization_id,
                )
                .await
                .unwrap();
                write(&mut peer_output, &WorkerFrame::Response { id, result })
                    .await
                    .unwrap();
            }
            assert_eq!(authorization_id, 2);
        });
        let authorization = authorization(None);
        let mut last = 0;
        for id in [1, 2] {
            let frame = encode(&ParentFrame::Request {
                id,
                request: request("owner", json!({"method":"documentation"})),
            })
            .unwrap();
            let callback: Option<Arc<dyn BrowserAuthorization>> =
                (id == 2).then(|| authorization.clone() as Arc<dyn BrowserAuthorization>);
            let result = exchange_frames(
                &mut input,
                &mut output,
                &frame,
                id,
                &mut last,
                callback,
                &CancellationToken::new(),
            )
            .await
            .unwrap();
            if id == 1 {
                assert!(
                    matches!(result, Err(Failure::Failed(message)) if message == "Browser site access requires Host authorization")
                );
            } else {
                assert_eq!(result.unwrap(), json!({"effect":"authorized"}));
            }
        }
        assert_eq!(
            *authorization.calls.lock().unwrap(),
            vec![("authorize", browser_access("https://protected.test/"))]
        );
        drop(input);
        drop(output);
        peer.await.unwrap();
        reader.await.unwrap();
    }

    #[tokio::test]
    async fn stale_remote_authorization_response_cannot_authorize_a_new_invocation() {
        let (send, mut receive) = mpsc::channel(1);
        let (mut peer, mut writer) = tokio::io::duplex(4096);
        let (requests, callbacks) = mpsc::channel(1);
        let remote = Arc::new(RemoteAuthorization { requests });
        let retained = remote.clone();
        let stop = CancellationToken::new();
        let cancellation = stop.clone();
        let task = tokio::spawn(async move {
            let dispatch = async move {
                remote
                    .authorize(browser_access("https://new.test/"), cancellation)
                    .await?;
                Ok(json!("must never dispatch"))
            };
            dispatch_with_authorization(
                2,
                dispatch,
                callbacks,
                &mut receive,
                &mut writer,
                &stop,
                &mut 0,
            )
            .await
        });
        let WorkerFrame::BrowserAuthorization {
            id,
            authorization_id,
            access,
            ..
        } = read(&mut peer).await.unwrap()
        else {
            panic!("expected callback");
        };
        assert_eq!(
            (id, authorization_id, access.url()),
            (2, 1, "https://new.test/")
        );
        send.send(ParentFrame::BrowserAuthorizationResult {
            id: 1,
            authorization_id,
            result: Ok(()),
        })
        .await
        .unwrap();
        let error = task.await.unwrap().unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert_eq!(error.to_string(), "desktop authorization identity mismatch");
        let expired = retained
            .authorize(
                browser_access("https://later.test/"),
                CancellationToken::new(),
            )
            .await;
        assert!(
            matches!(expired, Err(ToolError::Failed(message)) if message == "Browser authorization invocation expired")
        );
    }

    #[cfg(unix)]
    fn child(hello: Hello) -> Process {
        child_reply(hello, &[])
    }

    #[cfg(unix)]
    fn child_reply(hello: Hello, reply: &[WorkerFrame]) -> Process {
        let frame = encode(&hello)
            .unwrap()
            .iter()
            .map(|byte| format!("\\{:03o}", byte))
            .collect::<String>();
        let reply = reply
            .iter()
            .flat_map(|message| encode(message).unwrap())
            .map(|byte| format!("\\{:03o}", byte))
            .collect::<String>();
        let completion = if reply.is_empty() {
            String::new()
        } else {
            format!("; printf '%b' '{reply}'; cat >/dev/null")
        };
        // A disposable peer exercises the real pipes and process wait. Replying
        // peers wait for parent EOF so cleanup must actually close both pipes.
        let mut child = tokio::process::Command::new("/bin/sh")
            .arg("-c")
            .arg(format!(
                "printf '%b' '{frame}'; dd bs=1 count=1 of=/dev/null 2>/dev/null{completion}"
            ))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        Process {
            pipes: Some((
                child.stdin.take().unwrap(),
                BufReader::new(child.stdout.take().unwrap()),
            )),
            child,
            authorization_id: 0,
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn unconfirmed_callback_cleanup_retires_the_worker_before_another_request() {
        let process = child_reply(
            Hello {
                protocol: PROTOCOL,
                platform: "windows".into(),
                audio_enabled: false,
            },
            &[
                WorkerFrame::BrowserAuthorization {
                    id: 1,
                    authorization_id: 1,
                    mode: AuthorizationMode::Authorize,
                    access: browser_access("https://cancel.test/"),
                },
                WorkerFrame::Response {
                    id: 1,
                    result: Ok(json!("native settled")),
                },
            ],
        )
        .handshake(false)
        .await
        .unwrap();
        let mut worker = Worker {
            process: Some(process),
            ..Default::default()
        };
        let context = InvocationContext::new("owner", "fixture-turn").with_browser_authorization(
            Arc::new(UnconfirmedAuthorization {
                started: Arc::new(tokio::sync::Notify::new()),
            }),
        );
        let error = worker
            .invoke(
                request("owner", json!({"method":"documentation"})),
                &context,
                &CancellationToken::new(),
            )
            .await
            .unwrap_err();
        assert!(
            matches!(&error, ToolError::CleanupUnconfirmed(message) if message.contains("canonical withdrawal unavailable"))
        );
        assert!(worker.process.as_ref().unwrap().pipes.is_none());
        let repeated = worker
            .call(
                request("next-owner", json!({"method":"documentation"})),
                &CancellationToken::new(),
            )
            .await
            .unwrap_err();
        assert_eq!(
            repeated.to_string(),
            error.to_string(),
            "the retired transport cannot borrow a later invocation's authority"
        );
        worker.close().await.unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn lost_acknowledgment_is_unknown_and_never_replayed() {
        let process = child(Hello {
            protocol: PROTOCOL,
            platform: "windows".into(),
            audio_enabled: false,
        })
        .handshake(false)
        .await
        .unwrap();
        let mut worker = Worker {
            process: Some(process),
            ..Default::default()
        };
        let cancelled = CancellationToken::new();
        cancelled.cancel();
        assert!(
            matches!(worker.call(request("a", json!({"method":"documentation"})), &cancelled).await,
            Err(ToolError::Failed(message)) if message == "Computer Use cancelled before dispatch")
        );
        assert!(matches!(
            worker
                .call(
                    request("a", json!({"method":"documentation"})),
                    &CancellationToken::new()
                )
                .await,
            Err(ToolError::OutcomeUnknown(_))
        ));
        assert!(
            matches!(worker.call(request("a", json!({"method":"documentation"})), &CancellationToken::new()).await, Err(ToolError::Failed(message)) if message.contains("restart the Host"))
        );
        worker.close().await.unwrap();
        child(Hello {
            protocol: PROTOCOL,
            platform: "windows".into(),
            audio_enabled: true,
        })
        .handshake(true)
        .await
        .unwrap()
        .disconnect()
        .await
        .unwrap();
        for hello in [
            Hello {
                protocol: PROTOCOL + 1,
                platform: "windows".into(),
                audio_enabled: false,
            },
            Hello {
                protocol: PROTOCOL,
                platform: "linux".into(),
                audio_enabled: false,
            },
            Hello {
                protocol: PROTOCOL,
                platform: "windows".into(),
                audio_enabled: true,
            },
        ] {
            assert!(
                matches!(child(hello).handshake(false).await, Err(ToolError::Failed(message)) if message.contains("incompatible desktop worker"))
            );
        }
    }
}
