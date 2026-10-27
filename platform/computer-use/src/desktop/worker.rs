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
mod callbacks;
mod connection;
#[cfg(feature = "native-desktop")]
mod epochs;
pub(in crate::desktop) use connection::{AudioObservation, Connection};
#[cfg(feature = "native-desktop")]
use epochs::serve;

use super::failed;
#[cfg(feature = "native-desktop")]
use super::local_platform;
#[cfg(all(test, unix))]
use crate::BrowserAuthorization;
#[cfg(feature = "native-desktop")]
use crate::Driver;
use crate::{BrowserAccess, protocol::Command};
use maka_agent_facts::tools::ToolError;
use maka_capabilities::computer::BrowserConnection;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;
#[cfg(any(feature = "native-desktop", all(test, unix)))]
use std::sync::Arc;
use std::{
    io,
    path::PathBuf,
    process::{ExitCode, Stdio},
    time::Duration,
};
#[cfg(feature = "native-desktop")]
use tokio::sync::Mutex;
#[cfg(feature = "native-desktop")]
use tokio::sync::mpsc;
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout},
};
use tokio_util::sync::CancellationToken;

const ENTRY: &str = "__maka-cua-desktop";
const PROTOCOL: u32 = 3;
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
        owner: String,
        epoch: String,
        session: String,
        turn: String,
        #[serde(default)]
        operation_id: Option<String>,
        browsers: Vec<BrowserConnection>,
        #[serde(default, skip_serializing_if = "no_preparation_policy")]
        preparation_policy: crate::BrowserPreparationPolicy,
        command: Command,
        language: maka_agent_facts::language::Language,
    },
    LeaseChild {
        owner: String,
        epoch: String,
        session: String,
        turn: String,
        operation_id: String,
        browsers: Vec<BrowserConnection>,
        #[serde(default, skip_serializing_if = "no_preparation_policy")]
        preparation_policy: crate::BrowserPreparationPolicy,
        request: crate::BrowserLeaseChildRequest,
        language: maka_agent_facts::language::Language,
    },
    CloseEpoch {
        owner: String,
        epoch: String,
    },
    CloseOwner {
        owner: String,
    },
    DiscardAudio {
        owner: String,
        epoch: String,
    },
    FinishTurn {
        owner: String,
        epoch: String,
        session: String,
        turn: String,
        language: maka_agent_facts::language::Language,
    },
    FinishOwnerTurn {
        owner: String,
        turn: String,
        language: maka_agent_facts::language::Language,
    },
    Shutdown,
}

fn no_preparation_policy(policy: &crate::BrowserPreparationPolicy) -> bool {
    !policy.popup_enabled && policy.headers.is_empty()
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
    BrowserCallback {
        message: Box<callbacks::ParentMessage>,
    },
    Request {
        id: u64,
        request: Box<Request>,
    },
    Cancel {
        id: u64,
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
    BrowserCallback {
        message: callbacks::WorkerMessage,
    },
    Response {
        id: u64,
        result: Response,
    },
    AudioFinished {
        id: u64,
        result: Result<(), Failure>,
    },
    BrowserAuthorization {
        id: u64,
        authorization_id: u64,
        mode: AuthorizationMode,
        access: BrowserAccess,
    },
    BrowserSessionPreparationAuthorization {
        id: u64,
        authorization_id: u64,
        mode: AuthorizationMode,
        identity: callbacks::ScopeIdentity,
        preparation: crate::BrowserSessionPreparation,
    },
}

fn callback_identity(request: &Request) -> Option<callbacks::ScopeIdentity> {
    match request {
        Request::Invoke {
            owner,
            epoch,
            session,
            turn,
            operation_id: Some(operation_id),
            ..
        } if !operation_id.is_empty() => Some(callbacks::ScopeIdentity {
            owner: owner.clone(),
            epoch: epoch.clone(),
            session: session.clone(),
            turn: turn.clone(),
            operation_id: operation_id.clone(),
        }),
        Request::LeaseChild {
            owner,
            epoch,
            session,
            turn,
            operation_id,
            ..
        } if !operation_id.is_empty() => Some(callbacks::ScopeIdentity {
            owner: owner.clone(),
            epoch: epoch.clone(),
            session: session.clone(),
            turn: turn.clone(),
            operation_id: operation_id.clone(),
        }),
        _ => None,
    }
}
fn seal_parent_callbacks(callbacks: &callbacks::ParentCallbacks, request: &Request) {
    match request {
        Request::CloseEpoch { owner, epoch } => callbacks.seal_matching(owner, Some(epoch), None),
        Request::CloseOwner { owner } => callbacks.seal_matching(owner, None, None),
        Request::FinishTurn {
            owner, epoch, turn, ..
        } => callbacks.seal_matching(owner, Some(epoch), Some(turn)),
        Request::FinishOwnerTurn { owner, turn, .. } => {
            callbacks.seal_matching(owner, None, Some(turn))
        }
        _ => {}
    }
}

// Both purposes share one invocation's existing authorization queue. This
// routing metadata never creates a document, a grant, or a native lease proof.
enum BrowserAuthorizationRequest {
    Access(BrowserAccess),
    SessionPreparation {
        identity: callbacks::ScopeIdentity,
        preparation: crate::BrowserSessionPreparation,
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
    connection: Option<Connection>,
    closed: bool,
    audio_enabled: bool,
}
struct Process {
    child: Child,
    pipes: Option<(ChildStdin, BufReader<ChildStdout>)>,
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
        if let Some(error) = self.connection.as_ref().and_then(Connection::fault) {
            return Err(error);
        }
        if self.connection.is_none() {
            let executable = tokio::select! {
                biased;
                _ = cancellation.cancelled() => return Err(failed("Computer Use preparation cancelled")),
                executable = windows_executable() => executable?,
            };
            let process = Process::start(executable, self.audio_enabled).await?;
            self.connection = Some(Connection::start(process));
        }
        if cancellation.is_cancelled() {
            return Err(failed("Computer Use preparation cancelled"));
        }
        Ok(())
    }

    pub(in crate::desktop) fn connection(&self) -> Option<Connection> {
        self.connection.clone()
    }

    pub(crate) async fn close(&mut self) -> Result<(), ToolError> {
        self.closed = true;
        match &self.connection {
            Some(connection) => connection.close().await,
            None => Ok(()),
        }
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

    async fn disconnect(&mut self) -> io::Result<()> {
        // Close both directions so a peer writing a failed response cannot
        // stay blocked on its output while we wait for its cleanup.
        self.pipes.take();
        // WSL's interop process represents a Windows process, so killing the
        // Linux PID alone does not prove that native work has stopped.
        let status = tokio::time::timeout(EXIT_TIMEOUT, self.child.wait())
            .await
            .map_err(|_| io::Error::other("Windows desktop worker exit was not confirmed"))??;
        if !status.success() {
            return Err(io::Error::other(format!(
                "Windows desktop worker exited with {status}; native cleanup was not confirmed"
            )));
        }
        Ok(())
    }
}

fn authorization_cleanup(result: Result<(), ToolError>) -> Option<ToolError> {
    match result {
        Ok(()) | Err(ToolError::Failed(_) | ToolError::Io { .. }) => None,
        Err(error) => Some(ToolError::CleanupUnconfirmed(format!(
            "Browser authorization cleanup was not confirmed: {error}"
        ))),
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
            self.send
                .send(ParentFrame::Request {
                    id,
                    request: Box::new(request),
                })
                .await
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

    #[cfg(any(feature = "native-desktop", unix))]
    fn request(session: &str, command: Value) -> Request {
        Request::Invoke {
            owner: session.into(),
            epoch: "fixture-epoch".into(),
            session: session.into(),
            turn: "fixture-turn".into(),
            operation_id: None,
            browsers: Vec::new(),
            preparation_policy: Default::default(),
            command: serde_json::from_value(command).unwrap(),
            language: maka_agent_facts::language::Language::En,
        }
    }

    #[tokio::test]
    async fn desktop_frames_preserve_invoke_language() {
        use crate::protocol::{
            Action, BrowserCheckOptions, BrowserClickOptions, BrowserMutationOperation,
            BrowserSelectOption, BrowserTextOptions, Direction, Distance, Handle, LocatorPlan,
            Position,
        };
        use maka_agent_facts::language::Language;

        for (language, tag) in [
            (Language::ZhCn, "zh-CN"),
            (Language::ZhTw, "zh-TW"),
            (Language::En, "en"),
        ] {
            let request = Request::Invoke {
                owner: "fixture-owner".into(),
                epoch: "fixture-epoch".into(),
                session: "same-session".into(),
                turn: "fixture-turn".into(),
                operation_id: None,
                browsers: Vec::new(),
                preparation_policy: Default::default(),
                command: Command::Documentation,
                language,
            };
            let framed = encode(&ParentFrame::Request {
                id: 42,
                request: Box::new(request),
            })
            .unwrap();
            let decoded: ParentFrame = read_sync(&mut framed.as_slice()).unwrap();
            assert_eq!(
                serde_json::to_value(decoded).unwrap(),
                json!({
                    "kind": "request",
                    "id": 42,
                    "request": {
                        "method": "invoke",
                        "owner": "fixture-owner",
                        "epoch": "fixture-epoch",
                        "session": "same-session",
                        "turn": "fixture-turn",
                        "browsers": [],
                        "command": { "method": "documentation" },
                        "language": tag,
                    },
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
        let roundtrip_command = |command| {
            let request = ParentFrame::Request {
                id: 42,
                request: Box::new(Request::Invoke {
                    owner: "fixture-owner".into(),
                    epoch: "fixture-epoch".into(),
                    session: "same-session".into(),
                    turn: "fixture-turn".into(),
                    operation_id: None,
                    browsers: Vec::new(),
                    preparation_policy: Default::default(),
                    command,
                    language: Language::En,
                }),
            };
            let framed = encode(&request).unwrap();
            assert_eq!(
                u32::from_be_bytes(framed[..4].try_into().unwrap()) as usize,
                framed.len() - 4
            );
            let ParentFrame::Request { id, request } = read_sync(&mut framed.as_slice()).unwrap()
            else {
                panic!("numeric action changed its typed worker frame");
            };
            let Request::Invoke {
                session,
                turn,
                command,
                ..
            } = *request
            else {
                panic!("numeric action changed its typed worker request");
            };
            assert_eq!(
                (id, session.as_str(), turn.as_str()),
                (42, "same-session", "fixture-turn")
            );
            command
        };
        let [amount, x, y] = expected.map(f64::from_bits);
        for pixels in [false, true] {
            let Command::Action {
                handle: Handle::App(target),
                action:
                    Action::Scroll {
                        target: Position::Point(point),
                        direction: Direction::Down,
                        distance,
                    },
            } = roundtrip_command(Command::Action {
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
            })
            else {
                panic!("numeric action changed its typed worker request");
            };
            assert_eq!(target, "numeric-target");
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
                    id: 42,
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
            assert_eq!(response_id, 42);
            assert_eq!(
                ["amount", "x", "y"].map(|field| response[field].as_f64().unwrap().to_bits()),
                expected
            );
        }

        let Command::Action {
            action: Action::Drag { from, to },
            ..
        } = roundtrip_command(Command::Action {
            handle: Handle::App("numeric-target".into()),
            action: Action::Drag {
                from: [x, y],
                to: [y, amount],
            },
        })
        else {
            panic!("drag coordinates changed their typed worker request");
        };
        assert_eq!(from.map(f64::to_bits), [expected[1], expected[2]]);
        assert_eq!(to.map(f64::to_bits), [expected[2], expected[0]]);

        for operation in [
            BrowserMutationOperation::Click {
                options: BrowserClickOptions {
                    timeout_ms: Some(amount),
                    ..Default::default()
                },
            },
            BrowserMutationOperation::Fill {
                value: "text".into(),
                options: BrowserTextOptions {
                    timeout_ms: Some(amount),
                },
            },
            BrowserMutationOperation::SetChecked {
                checked: true,
                options: BrowserCheckOptions {
                    timeout_ms: Some(amount),
                    ..Default::default()
                },
            },
            BrowserMutationOperation::SelectOption {
                values: vec![BrowserSelectOption {
                    index: Some(y),
                    ..Default::default()
                }],
                options: BrowserTextOptions {
                    timeout_ms: Some(amount),
                },
            },
        ] {
            let Command::BrowserMutation { operation, .. } =
                roundtrip_command(Command::BrowserMutation {
                    handle: Handle::Tab("numeric-target".into()),
                    locator: LocatorPlan {
                        selector: "select".into(),
                    },
                    operation,
                })
            else {
                panic!("browser mutation changed its typed worker request");
            };
            let timeout = match operation {
                BrowserMutationOperation::Click { options } => options.timeout_ms,
                BrowserMutationOperation::Fill { options, .. } => options.timeout_ms,
                BrowserMutationOperation::SetChecked { options, .. } => options.timeout_ms,
                BrowserMutationOperation::SelectOption { values, options } => {
                    assert_eq!(values[0].index.map(f64::to_bits), Some(expected[2]));
                    options.timeout_ms
                }
                _ => panic!("browser mutation changed its operation"),
            };
            assert_eq!(timeout.map(f64::to_bits), Some(expected[0]));
        }
        for input in [
            r#"{"kind":"click","options":{}}"#,
            r#"{"kind":"setChecked","checked":true,"options":{}}"#,
            r#"{"kind":"selectOption","values":[{}],"options":{}}"#,
        ] {
            let operation: BrowserMutationOperation = serde_json::from_str(input).unwrap();
            let timeout = match operation {
                BrowserMutationOperation::Click { options } => options.timeout_ms,
                BrowserMutationOperation::SetChecked { options, .. } => options.timeout_ms,
                BrowserMutationOperation::SelectOption { values, options } => {
                    assert!(values[0].index.is_none());
                    options.timeout_ms
                }
                _ => panic!("browser mutation changed its operation"),
            };
            assert!(timeout.is_none(), "{input}");
        }
    }

    #[cfg(feature = "native-desktop")]
    #[tokio::test]
    async fn discard_audio_only_visits_an_existing_helper_session() {
        let (send, receive) = requests();
        let (mut output, writer) = tokio::io::duplex(64 * 1024);
        let driver = Arc::new(Mutex::new(Driver::with_audio(true)));
        let task = tokio::spawn(serve(receive, writer, CancellationToken::new(), driver));
        let _: Hello = read(&mut output).await.unwrap();
        send.send(Request::DiscardAudio {
            owner: "absent".into(),
            epoch: "absent".into(),
        })
        .await
        .unwrap();
        assert_eq!(response(&mut output).await.unwrap().unwrap(), Value::Null);
        send.send(request(
            "owner",
            json!({"method":"configureCursor","options":{"label":"retained","enabled":false}}),
        ))
        .await
        .unwrap();
        assert_eq!(
            response(&mut output).await.unwrap().unwrap()["settings"]["label"],
            "retained"
        );
        send.send(Request::DiscardAudio {
            owner: "owner".into(),
            epoch: "fixture-epoch".into(),
        })
        .await
        .unwrap();
        assert_eq!(response(&mut output).await.unwrap().unwrap(), Value::Null);
        send.send(request(
            "owner",
            json!({"method":"cursorState","options":{}}),
        ))
        .await
        .unwrap();
        assert_eq!(
            response(&mut output).await.unwrap().unwrap()["settings"]["label"],
            "retained"
        );
        send.send(Request::Shutdown).await.unwrap();
        assert!(response(&mut output).await.unwrap().is_ok());
        task.await.unwrap().unwrap();
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
            owner: "a".into(),
            epoch: "fixture-epoch".into(),
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
        send.send(Request::CloseOwner { owner: "a".into() })
            .await
            .unwrap();
        assert!(response(&mut output).await.unwrap().is_ok());
        for (session, label) in [("a-new", "Maka"), ("b", "Bob")] {
            send.send(request(
                session,
                json!({"method":"cursorState","options":{}}),
            ))
            .await
            .unwrap();
            let result: Response = response(&mut output).await.unwrap();
            assert_eq!(result.unwrap()["settings"]["label"], label);
        }
        send.send(request("a-new", json!({"method":"observe","handle":{"kind":"app","id":"unbound"},"kind":"ax","options":{}}))).await.unwrap();
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
                owner: "fixture-owner".into(),
                epoch: "fixture-epoch".into(),
                session: "same-session".into(),
                turn: "fixture-turn".into(),
                operation_id: None,
                browsers: Vec::new(),
                preparation_policy: Default::default(),
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

    #[cfg(unix)]
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

    #[cfg(unix)]
    struct UnconfirmedAuthorization {
        started: Arc<tokio::sync::Notify>,
    }
    #[cfg(unix)]
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
        let connection = Connection::start(process);
        let mut worker = Worker {
            connection: Some(connection.clone()),
            ..Default::default()
        };
        let error = connection
            .invoke(
                request("owner", json!({"method":"documentation"})),
                Some(Arc::new(UnconfirmedAuthorization {
                    started: Arc::new(tokio::sync::Notify::new()),
                })),
                CancellationToken::new(),
            )
            .await
            .unwrap_err();
        assert!(
            matches!(&error, ToolError::CleanupUnconfirmed(message) if message.contains("canonical withdrawal unavailable"))
        );
        assert!(connection.fault().is_some());
        let repeated = connection
            .invoke(
                request("next-owner", json!({"method":"documentation"})),
                None,
                CancellationToken::new(),
            )
            .await
            .unwrap_err();
        assert_eq!(
            repeated.to_string(),
            error.to_string(),
            "a retired transport cannot borrow a later invocation's authority"
        );
        assert_eq!(
            worker.close().await.unwrap_err().to_string(),
            error.to_string(),
            "confirmed process exit cannot erase the original cleanup failure"
        );
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
        let connection = Connection::start(process);
        let mut worker = Worker {
            connection: Some(connection.clone()),
            ..Default::default()
        };
        let cancelled = CancellationToken::new();
        cancelled.cancel();
        assert!(
            matches!(connection.invoke(request("a", json!({"method":"documentation"})), None, cancelled).await,
            Err(ToolError::Failed(message)) if message == "Computer Use cancelled before dispatch")
        );
        assert!(matches!(
            connection
                .invoke(
                    request("a", json!({"method":"documentation"})),
                    None,
                    CancellationToken::new()
                )
                .await,
            Err(ToolError::OutcomeUnknown(_))
        ));
        assert!(
            matches!(connection.invoke(request("a", json!({"method":"documentation"})), None, CancellationToken::new()).await,
            Err(ToolError::Failed(message)) if message.contains("restart the Host"))
        );
        assert!(
            matches!(worker.close().await, Err(ToolError::CleanupUnconfirmed(message)) if message.contains("Windows desktop cleanup was not confirmed"))
        );
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
    #[cfg(unix)]
    #[tokio::test]
    async fn failed_worker_exit_does_not_confirm_native_cleanup() {
        let mut child = tokio::process::Command::new("/bin/sh")
            .arg("-c")
            .arg("exit 7")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let mut process = Process {
            pipes: Some((
                child.stdin.take().unwrap(),
                BufReader::new(child.stdout.take().unwrap()),
            )),
            child,
        };
        let error = process.disconnect().await.unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::Other);
        assert_eq!(
            error.to_string(),
            "Windows desktop worker exited with exit status: 7; native cleanup was not confirmed"
        );
    }
}
