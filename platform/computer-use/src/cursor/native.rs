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

use maka_agent_facts::tools::ToolError;
use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    process::{ExitCode, Stdio},
    sync::OnceLock,
    time::Duration,
};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout};

mod helper;
use super::{Color, Options, theme};

const ENTRY: &str = "__maka-cua-cursor";
const MAX_MESSAGE: u64 = 16 * 1024;
static HOST_EXECUTABLE: OnceLock<PathBuf> = OnceLock::new();
static NEXT_COLOR: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// Call at the executable entry point, before starting runtime threads.
/// The private child hosts display surfaces and read-only AppKit metadata.
/// It has no computer input operations.
pub fn bootstrap() -> Option<ExitCode> {
    if std::env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new(ENTRY)) {
        return Some(match helper::run() {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                use std::io::Write as _;
                let _ = writeln!(
                    std::io::stdout(),
                    "{}",
                    serde_json::to_string(&Response::Render {
                        state: RenderState::unavailable(&error),
                    })
                    .unwrap()
                );
                let _ = writeln!(std::io::stderr(), "Maka cursor: {error}");
                ExitCode::FAILURE
            }
        });
    }
    if let Ok(path) = std::env::current_exe() {
        let _ = HOST_EXECUTABLE.set(path);
    }
    None
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RenderStatus {
    #[default]
    Idle,
    Ready,
    Unavailable,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RenderState {
    pub status: RenderStatus,
    pub visible: bool,
    #[serde(
        default,
        deserialize_with = "crate::protocol::deserialize_numbers",
        skip_serializing_if = "Option::is_none"
    )]
    pub requested_position: Option<[f64; 2]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub theme: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub renderer_pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
impl RenderState {
    pub(crate) fn unavailable(error: impl std::fmt::Display) -> Self {
        Self {
            status: RenderStatus::Unavailable,
            error: Some(error.to_string()),
            ..Default::default()
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Spec {
    pub id: String,
    pub label: String,
    pub color: Color,
    pub enabled: bool,
    pub reduced_motion: bool,
}
impl Default for Spec {
    fn default() -> Self {
        let id = uuid::Uuid::new_v4();
        Self {
            color: Color::ALL
                [NEXT_COLOR.fetch_add(1, std::sync::atomic::Ordering::Relaxed) % Color::ALL.len()],
            id: id.to_string(),
            label: "Maka".into(),
            enabled: true,
            reduced_motion: false,
        }
    }
}
impl Spec {
    pub(crate) fn configure(&mut self, options: Options) -> Result<(), ToolError> {
        if let Some(label) = &options.label
            && (label.chars().count() > 48 || label.chars().any(char::is_control))
        {
            return Err(failed(
                "cursor label must be at most 48 characters without control characters",
            ));
        }
        if let Some(label) = options.label {
            self.label = label;
        }
        if let Some(color) = options.color {
            self.color = color;
        }
        if let Some(enabled) = options.enabled {
            self.enabled = enabled;
        }
        if let Some(reduced) = options.reduced_motion {
            self.reduced_motion = reduced;
        }
        Ok(())
    }
    pub(crate) fn theme_id(&self) -> String {
        format!("org.apache.maka.cursor.{}", self.color.name())
    }
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Request {
    Update {
        cursor: Spec,
        #[serde(default, deserialize_with = "crate::protocol::deserialize_numbers")]
        point: Option<[f64; 2]>,
        action: cursor_overlay::CursorAction,
        window: Option<u64>,
    },
    State {
        id: String,
    },
    Remove {
        id: String,
    },
    #[cfg(target_os = "macos")]
    Geometry {
        expected_pid: i32,
        window_id: u32,
    },
    #[cfg(target_os = "macos")]
    MacMetadata {
        query: crate::macos::page_scroll::metadata::Query,
    },
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Response {
    Render {
        state: RenderState,
    },
    #[cfg(target_os = "macos")]
    Geometry {
        #[serde(deserialize_with = "crate::protocol::deserialize_numbers")]
        result: Result<platform_macos::geometry::NativeWindowGeometry, String>,
    },
    #[cfg(target_os = "macos")]
    MacMetadata {
        result: Result<crate::macos::page_scroll::metadata::Observation, String>,
    },
}

pub(crate) struct Host {
    executable: Option<PathBuf>,
    sender: Option<tokio::sync::mpsc::Sender<Job>>,
}
struct Job {
    command: Control,
    reply: tokio::sync::oneshot::Sender<Result<Response, ToolError>>,
}
enum Control {
    Call(Request),
    Configure(Spec),
    Stop,
}
impl Default for Host {
    fn default() -> Self {
        Self {
            executable: HOST_EXECUTABLE.get().cloned(),
            sender: None,
        }
    }
}
impl Host {
    pub(crate) fn with_executable(path: PathBuf) -> Self {
        Self {
            executable: Some(path),
            sender: None,
        }
    }
    pub(crate) fn registered(&self) -> bool {
        self.executable.is_some()
    }
    fn sender(&mut self) -> tokio::sync::mpsc::Sender<Job> {
        self.sender
            .get_or_insert_with(|| {
                let (sender, mut receiver) = tokio::sync::mpsc::channel::<Job>(32);
                let mut transport = Transport {
                    executable: self.executable.clone(),
                    process: None,
                    last_error: None,
                };
                tokio::spawn(async move {
                    while let Some(job) = receiver.recv().await {
                        let stopping = matches!(job.command, Control::Stop);
                        let result = match job.command {
                            Control::Call(Request::State { id }) => Ok(Response::Render {
                                state: transport.state(&id).await,
                            }),
                            Control::Call(Request::Remove { id }) => {
                                transport.remove(&id).await.map(|()| Response::Render {
                                    state: RenderState::default(),
                                })
                            }
                            Control::Call(request) => transport.request(request).await,
                            Control::Configure(cursor) => Ok(Response::Render {
                                state: transport.configure(&cursor).await,
                            }),
                            Control::Stop => transport.stop().await.map(|()| Response::Render {
                                state: RenderState::default(),
                            }),
                        };
                        let stopped = stopping && result.is_ok();
                        let _ = job.reply.send(result);
                        if stopped {
                            return;
                        }
                    }
                    // No caller remains to receive a fallible close result.
                    // Explicit Stop keeps this actor alive on failure instead.
                    if let Err(error) = transport.stop().await {
                        tracing::error!(%error, "cursor helper final cleanup was not confirmed");
                    }
                });
                sender
            })
            .clone()
    }
    async fn call(&mut self, command: Control) -> Result<Response, ToolError> {
        self.schedule(command).await
    }

    fn schedule(
        &mut self,
        command: Control,
    ) -> impl std::future::Future<Output = Result<Response, ToolError>> + Send + 'static {
        let sender = if self
            .sender
            .as_ref()
            .is_some_and(tokio::sync::mpsc::Sender::is_closed)
        {
            Err(cleanup_unconfirmed(
                "cursor renderer owner closed without a confirmed stop",
            ))
        } else {
            Ok(self.sender())
        };
        let (reply, receive) = tokio::sync::oneshot::channel();
        async move {
            sender?.send(Job { command, reply }).await.map_err(|_| {
                cleanup_unconfirmed("cursor renderer owner closed before accepting the request")
            })?;
            receive.await.map_err(|_| {
                cleanup_unconfirmed("cursor renderer request acknowledgement was lost")
            })?
        }
    }
    async fn render(&mut self, command: Control) -> Result<RenderState, ToolError> {
        match self.call(command).await? {
            Response::Render { state } => Ok(state),
            #[cfg(target_os = "macos")]
            Response::Geometry { .. } | Response::MacMetadata { .. } => {
                Err(failed("display host returned an unexpected reply"))
            }
        }
    }
    #[cfg(target_os = "macos")]
    pub(crate) fn window_geometry(
        &mut self,
        expected_pid: i32,
        window_id: u32,
    ) -> impl std::future::Future<
        Output = Result<platform_macos::geometry::NativeWindowGeometry, ToolError>,
    > + Send
    + 'static {
        let response = self.schedule(Control::Call(Request::Geometry {
            expected_pid,
            window_id,
        }));
        async move {
            match response.await? {
                Response::Geometry { result } => result.map_err(failed),
                Response::Render { .. } | Response::MacMetadata { .. } => {
                    Err(failed("display host returned an unexpected reply"))
                }
            }
        }
    }
    #[cfg(target_os = "macos")]
    pub(crate) fn mac_metadata(
        &mut self,
        query: crate::macos::page_scroll::metadata::Query,
    ) -> impl std::future::Future<
        Output = Result<crate::macos::page_scroll::metadata::Observation, ToolError>,
    > + Send
    + 'static {
        let response = self.schedule(Control::Call(Request::MacMetadata { query }));
        async move {
            match response.await? {
                Response::MacMetadata { result } => result.map_err(failed),
                Response::Render { .. } | Response::Geometry { .. } => {
                    Err(failed("display host returned an unexpected reply"))
                }
            }
        }
    }
    pub(crate) fn update(
        &mut self,
        cursor: &Spec,
        point: Option<[f64; 2]>,
        action: cursor_overlay::CursorAction,
        window: Option<u64>,
    ) -> impl std::future::Future<Output = Result<RenderState, ToolError>> + Send + 'static {
        let response = self.schedule(Control::Call(Request::Update {
            cursor: cursor.clone(),
            point,
            action,
            window,
        }));
        async move {
            match response.await? {
                Response::Render { state } => Ok(state),
                #[cfg(target_os = "macos")]
                Response::Geometry { .. } | Response::MacMetadata { .. } => {
                    Err(failed("display host returned an unexpected reply"))
                }
            }
        }
    }
    pub(crate) async fn state(&mut self, cursor: &Spec) -> RenderState {
        self.render(Control::Call(Request::State {
            id: cursor.id.clone(),
        }))
        .await
        .unwrap_or_else(RenderState::unavailable)
    }
    pub(crate) async fn configure(&mut self, cursor: &Spec) -> RenderState {
        self.render(Control::Configure(cursor.clone()))
            .await
            .unwrap_or_else(RenderState::unavailable)
    }
    /// Remove a logical cursor while preserving any helper cleanup uncertainty.
    pub(crate) async fn remove(&mut self, id: &str) -> Result<(), ToolError> {
        if self.sender.is_some() {
            self.call(Control::Call(Request::Remove { id: id.into() }))
                .await?;
        }
        Ok(())
    }
    /// Retire the actor only after its original stop job confirms child exit.
    ///
    /// # Errors
    /// Returns cleanup uncertainty with the original sender still retained.
    pub(crate) async fn stop(&mut self) -> Result<(), ToolError> {
        let Some(sender) = self.sender.as_ref() else {
            return Ok(());
        };
        let (reply, receive) = tokio::sync::oneshot::channel();
        sender
            .send(Job {
                command: Control::Stop,
                reply,
            })
            .await
            .map_err(|_| {
                cleanup_unconfirmed("cursor renderer owner closed before stop was acknowledged")
            })?;
        let response = receive
            .await
            .map_err(|_| cleanup_unconfirmed("cursor renderer stop acknowledgement was lost"))??;
        match response {
            Response::Render { .. } => {
                self.sender = None;
                Ok(())
            }
            #[cfg(target_os = "macos")]
            Response::Geometry { .. } | Response::MacMetadata { .. } => Err(cleanup_unconfirmed(
                "cursor renderer returned an unexpected stop acknowledgement",
            )),
        }
    }
}

struct Transport {
    executable: Option<PathBuf>,
    process: Option<Process>,
    last_error: Option<ToolError>,
}
struct Process {
    child: Child,
    custody: ChildCustody,
    input: Option<ChildStdin>,
    output: BufReader<ChildStdout>,
    _themes: tempfile::TempDir,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ChildCustody {
    Owned,
    WaitUnconfirmed,
}

impl Drop for Process {
    fn drop(&mut self) {
        if self.custody == ChildCustody::Owned
            && matches!(self.child.try_wait(), Ok(None))
            && let Err(error) = self.child.start_kill()
        {
            tracing::error!(%error, "cursor helper best-effort termination failed");
        }
    }
}

impl Transport {
    async fn start(&mut self) -> Result<(), ToolError> {
        if let Some(process) = self.process.as_ref() {
            if process.input.is_none() {
                return Err(cleanup_unconfirmed(
                    "cursor renderer cleanup has not been confirmed",
                ));
            }
            return Ok(());
        }
        let executable=self.executable.as_ref().ok_or_else(|| failed("cursor_unavailable: this executable did not register the native cursor entry point"))?;
        let themes = tempfile::Builder::new()
            .prefix("maka-cursors-")
            .tempdir()
            .map_err(failed)?;
        theme::write_artifacts(themes.path()).map_err(failed)?;
        let mut command = tokio::process::Command::new(executable);
        command
            .arg(ENTRY)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(false)
            .env_clear();
        for name in [
            "HOME",
            "PATH",
            "LANG",
            "LC_ALL",
            "DISPLAY",
            "WAYLAND_DISPLAY",
            "XDG_RUNTIME_DIR",
            "XAUTHORITY",
            "DBUS_SESSION_BUS_ADDRESS",
            "LOCALAPPDATA",
            "SYSTEMROOT",
            "WINDIR",
            "TEMP",
            "TMP",
        ] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        command.env("CUA_DRIVER_CURSOR_THEME_DIR", themes.path());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.as_std_mut().process_group(0);
        }
        #[cfg(windows)]
        command.creation_flags(
            windows_sys::Win32::System::Threading::CREATE_NEW_PROCESS_GROUP
                | windows_sys::Win32::System::Threading::CREATE_NO_WINDOW,
        );
        let mut child = command.spawn().map_err(failed)?;
        let input = child
            .stdin
            .take()
            .ok_or_else(|| failed("cursor stdin unavailable"))?;
        let output = BufReader::new(
            child
                .stdout
                .take()
                .ok_or_else(|| failed("cursor stdout unavailable"))?,
        );
        self.process = Some(Process {
            child,
            custody: ChildCustody::Owned,
            input: Some(input),
            output,
            _themes: themes,
        });
        Ok(())
    }
    async fn request(&mut self, request: Request) -> Result<Response, ToolError> {
        if let Some(error) = &self.last_error {
            return Err(error.clone());
        }
        let starting = self.process.is_none();
        if let Err(error) = self.start().await {
            self.last_error = Some(error.clone());
            return Err(error);
        }
        let process = self
            .process
            .as_mut()
            .expect("successful renderer start retains its child");
        #[cfg(target_os = "macos")]
        let maximum_response = if matches!(request, Request::MacMetadata { .. }) {
            // Native metadata is bounded by the actual WindowServer snapshot,
            // not the much smaller cursor-state JSON envelope.
            u64::MAX
        } else {
            MAX_MESSAGE
        };
        #[cfg(not(target_os = "macos"))]
        let maximum_response = MAX_MESSAGE;
        let result =
            tokio::time::timeout(Duration::from_secs(if starting { 10 } else { 3 }), async {
                let mut bytes = serde_json::to_vec(&request).map_err(failed)?;
                bytes.push(b'\n');
                process
                    .input
                    .as_mut()
                    .ok_or_else(|| {
                        cleanup_unconfirmed(
                            "cursor renderer input is closed before cleanup was confirmed",
                        )
                    })?
                    .write_all(&bytes)
                    .await
                    .map_err(failed)?;
                let mut line = String::new();
                (&mut process.output)
                    .take(maximum_response.saturating_add(1))
                    .read_line(&mut line)
                    .await
                    .map_err(failed)?;
                if line.is_empty() || line.len() as u64 > maximum_response {
                    return Err(failed("cursor renderer returned an invalid response"));
                }
                let value: Response = serde_json::from_str(&line).map_err(failed)?;
                match &value {
                    Response::Render { state } => {
                        if let Some(error) = &state.error {
                            return Err(failed(error));
                        }
                    }
                    #[cfg(target_os = "macos")]
                    Response::Geometry { .. } | Response::MacMetadata { .. } => {}
                }
                #[cfg(target_os = "macos")]
                if !matches!(
                    (&request, &value),
                    (Request::Geometry { .. }, Response::Geometry { .. })
                        | (Request::MacMetadata { .. }, Response::MacMetadata { .. })
                        | (
                            Request::Update { .. } | Request::State { .. } | Request::Remove { .. },
                            Response::Render { .. }
                        )
                ) {
                    return Err(failed("display host returned an unexpected reply"));
                }
                Ok(value)
            })
            .await
            .unwrap_or_else(|_| Err(failed("cursor renderer did not respond")));
        match result {
            Ok(value) => Ok(value),
            Err(error) => {
                self.last_error = Some(error.clone());
                match self.stop().await {
                    Ok(()) => Err(error),
                    Err(cleanup) => {
                        let error = cleanup_unconfirmed(format!("{error}; {cleanup}"));
                        self.last_error = Some(error.clone());
                        Err(error)
                    }
                }
            }
        }
    }
    async fn render(&mut self, request: Request) -> Result<RenderState, ToolError> {
        match self.request(request).await? {
            Response::Render { state } => Ok(state),
            #[cfg(target_os = "macos")]
            Response::Geometry { .. } | Response::MacMetadata { .. } => {
                Err(failed("display host returned an unexpected reply"))
            }
        }
    }
    pub(crate) async fn update(
        &mut self,
        cursor: &Spec,
        point: Option<[f64; 2]>,
        action: cursor_overlay::CursorAction,
        window: Option<u64>,
    ) -> Result<RenderState, ToolError> {
        self.render(Request::Update {
            cursor: cursor.clone(),
            point,
            action,
            window,
        })
        .await
    }
    async fn state(&mut self, id: &str) -> RenderState {
        if self.process.is_none() {
            return match &self.last_error {
                Some(error) => RenderState::unavailable(error),
                None if self.executable.is_none() => {
                    RenderState::unavailable("no cursor display host registered")
                }
                None => RenderState::default(),
            };
        }
        match self.render(Request::State { id: id.into() }).await {
            Ok(value) => value,
            Err(error) => RenderState::unavailable(error),
        }
    }
    pub(crate) async fn configure(&mut self, cursor: &Spec) -> RenderState {
        if let Some(error @ ToolError::CleanupUnconfirmed(_)) = self.last_error.as_ref() {
            return RenderState::unavailable(error);
        }
        self.last_error = None;
        if self.process.is_some() {
            match self
                .update(cursor, None, cursor_overlay::CursorAction::Idle, None)
                .await
            {
                Ok(value) => value,
                Err(error) => RenderState::unavailable(error),
            }
        } else {
            self.state(&cursor.id).await
        }
    }
    pub(crate) async fn remove(&mut self, id: &str) -> Result<(), ToolError> {
        if self.process.is_some() {
            self.request(Request::Remove { id: id.into() }).await?;
        }
        Ok(())
    }
    pub(crate) async fn stop(&mut self) -> Result<(), ToolError> {
        let Some(process) = self.process.as_mut() else {
            return Ok(());
        };
        let mut failures = Vec::new();
        if let Some(mut input) = process.input.take() {
            if let Err(error) = input.shutdown().await {
                failures.push(format!("closing cursor renderer input: {error}"));
            }
            drop(input);
        }
        let exited = match tokio::time::timeout(Duration::from_secs(2), process.child.wait()).await
        {
            Ok(Ok(_)) => true,
            Ok(Err(error)) => {
                // A wait error can mean ownership of this PID was lost. Do
                // not send a signal to a potentially reused PID after it.
                failures.push(format!("waiting for cursor renderer exit: {error}"));
                process.custody = ChildCustody::WaitUnconfirmed;
                false
            }
            Err(_) if process.custody == ChildCustody::WaitUnconfirmed => {
                failures.push("cursor renderer child ownership was already unconfirmed".into());
                false
            }
            Err(_) => match process.child.start_kill() {
                Ok(()) => match process.child.wait().await {
                    Ok(_) => true,
                    Err(error) => {
                        failures.push(format!(
                            "reaping cursor renderer after termination: {error}"
                        ));
                        process.custody = ChildCustody::WaitUnconfirmed;
                        false
                    }
                },
                Err(error) => {
                    failures.push(format!("terminating cursor renderer: {error}"));
                    false
                }
            },
        };
        if exited && failures.is_empty() {
            self.process = None;
            Ok(())
        } else {
            let error = cleanup_unconfirmed(failures.join("; "));
            self.last_error = Some(error.clone());
            Err(error)
        }
    }
}
fn failed(error: impl std::fmt::Display) -> ToolError {
    ToolError::Failed(error.to_string())
}

fn cleanup_unconfirmed(error: impl std::fmt::Display) -> ToolError {
    ToolError::CleanupUnconfirmed(error.to_string())
}

impl crate::protocol::Action {
    pub(crate) fn cursor_target(&self) -> Option<crate::protocol::Position> {
        use crate::protocol::{Action, Position};
        match self {
            Action::MoveCursor { target }
            | Action::Click { target, .. }
            | Action::Scroll { target, .. } => Some(target.clone()),
            Action::Drag { from, .. } => Some(Position::Point(*from)),
            Action::SetValue { index, .. }
            | Action::SelectText { index, .. }
            | Action::Secondary { index, .. } => Some(Position::Element(*index)),
            Action::TypeText { index, .. }
            | Action::Paste { index, .. }
            | Action::PressKey { index, .. } => index.map(Position::Element),
            _ => None,
        }
    }
    pub(crate) fn cursor_action(&self) -> cursor_overlay::CursorAction {
        use crate::protocol::Action;
        use cursor_overlay::CursorAction as Cue;
        match self {
            Action::MoveCursor { .. } => Cue::Idle,
            Action::Click { .. } | Action::LinuxClick { .. } | Action::Secondary { .. } => {
                Cue::Click
            }
            Action::Drag { .. } | Action::LinuxDrag { .. } => Cue::Drag,
            Action::Scroll { .. } | Action::LinuxScroll { .. } => Cue::Scroll,
            Action::TypeText { .. }
            | Action::Paste { .. }
            | Action::SetValue { .. }
            | Action::SelectText { .. } => Cue::Text,
            Action::PressKey { .. } => Cue::Key,
            Action::Navigate { .. } | Action::Back | Action::Forward | Action::Reload => {
                Cue::Navigate
            }
            Action::Close => Cue::App,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_wire_preserves_fractional_coordinates_and_geometry() {
        fn roundtrip<T: Serialize + serde::de::DeserializeOwned>(
            value: T,
            failures: &mut Vec<String>,
        ) {
            let wire = serde_json::to_string(&value).unwrap();
            match serde_json::from_str::<T>(&wire) {
                Ok(decoded) => assert_eq!(serde_json::to_string(&decoded).unwrap(), wire),
                Err(error) => failures.push(format!("{wire}: {error}")),
            }
        }
        let mut failures = Vec::new();
        roundtrip(
            Request::Update {
                cursor: Spec::default(),
                point: Some([10.5, -20.25]),
                action: cursor_overlay::CursorAction::Observe,
                window: None,
            },
            &mut failures,
        );
        roundtrip(
            Response::Render {
                state: RenderState {
                    requested_position: Some([10.5, -20.25]),
                    ..Default::default()
                },
            },
            &mut failures,
        );
        #[cfg(target_os = "macos")]
        {
            roundtrip(
                Request::MacMetadata {
                    query: crate::macos::page_scroll::metadata::Query::GlobalWindow {
                        point: [10.5, -20.25],
                    },
                },
                &mut failures,
            );
            roundtrip(
                Response::Geometry {
                    result: Ok(platform_macos::geometry::NativeWindowGeometry {
                        window_id: 42,
                        pid: 7,
                        layer: 0,
                        bounds: platform_macos::windows::WindowBounds {
                            x: 10.5,
                            y: -20.25,
                            width: 300.75,
                            height: 200.5,
                        },
                        native_scale: 1.5,
                    }),
                },
                &mut failures,
            );
        }
        assert!(failures.is_empty(), "{}", failures.join("\n"));
    }

    #[tokio::test]
    async fn stop_failure_keeps_the_original_owner_until_a_confirmed_retry() {
        let (sender, mut receiver) = tokio::sync::mpsc::channel(1);
        let mut host = Host {
            executable: None,
            sender: Some(sender),
        };
        let (result, ()) = tokio::join!(host.stop(), async {
            let job = receiver
                .recv()
                .await
                .expect("the original actor receives stop");
            assert!(matches!(job.command, Control::Stop));
            assert!(
                job.reply
                    .send(Err(cleanup_unconfirmed("wait failed")))
                    .is_ok()
            );
        });
        assert!(matches!(result, Err(ToolError::CleanupUnconfirmed(_))));
        assert!(
            host.sender.is_some(),
            "unconfirmed cleanup keeps the original actor"
        );

        let (result, ()) = tokio::join!(host.stop(), async {
            let job = receiver
                .recv()
                .await
                .expect("retry uses the original actor");
            assert!(matches!(job.command, Control::Stop));
            assert!(
                job.reply
                    .send(Ok(Response::Render {
                        state: RenderState::default()
                    }))
                    .is_ok()
            );
        });
        result.unwrap();
        assert!(
            host.sender.is_none(),
            "only confirmed cleanup retires the actor"
        );
    }

    #[tokio::test]
    async fn stop_never_replaces_a_closed_owner_with_an_empty_actor() {
        let (sender, receiver) = tokio::sync::mpsc::channel(1);
        drop(receiver);
        let mut host = Host {
            executable: None,
            sender: Some(sender),
        };
        assert!(matches!(
            host.stop().await,
            Err(ToolError::CleanupUnconfirmed(_))
        ));
        assert!(
            host.sender
                .as_ref()
                .is_some_and(tokio::sync::mpsc::Sender::is_closed)
        );
        let cursor = Spec::default();
        assert!(matches!(
            host.update(&cursor, None, cursor_overlay::CursorAction::Idle, None)
                .await,
            Err(ToolError::CleanupUnconfirmed(_))
        ));
        assert!(
            host.sender
                .as_ref()
                .is_some_and(tokio::sync::mpsc::Sender::is_closed)
        );
    }

    #[tokio::test]
    async fn lost_stop_acknowledgement_and_remove_cleanup_errors_are_not_success() {
        let (sender, mut receiver) = tokio::sync::mpsc::channel(1);
        let mut host = Host {
            executable: None,
            sender: Some(sender),
        };
        let (result, ()) = tokio::join!(host.stop(), async {
            let job = receiver.recv().await.expect("stop was accepted");
            assert!(matches!(job.command, Control::Stop));
            drop(job.reply);
        });
        assert!(matches!(result, Err(ToolError::CleanupUnconfirmed(_))));
        assert!(host.sender.is_some());

        let (result, ()) = tokio::join!(host.remove("task-owned"), async {
            let job = receiver.recv().await.expect("remove was accepted");
            assert!(
                matches!(job.command, Control::Call(Request::Remove { id }) if id == "task-owned")
            );
            assert!(
                job.reply
                    .send(Err(cleanup_unconfirmed(
                        "helper termination was not confirmed"
                    )))
                    .is_ok()
            );
        });
        assert!(matches!(result, Err(ToolError::CleanupUnconfirmed(_))));
        assert!(host.sender.is_some());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn transport_stop_waits_for_the_real_pipe_child_to_exit() {
        let mut child = tokio::process::Command::new("/bin/sh")
            .args(["-c", "while IFS= read -r line; do :; done"])
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(false)
            .spawn()
            .unwrap();
        let pid = child.id().expect("the task-owned child is running");
        let input = child.stdin.take().unwrap();
        let output = BufReader::new(child.stdout.take().unwrap());
        let mut transport = Transport {
            executable: None,
            process: Some(Process {
                child,
                custody: ChildCustody::Owned,
                input: Some(input),
                output,
                _themes: tempfile::tempdir().unwrap(),
            }),
            last_error: None,
        };
        transport.stop().await.unwrap();
        assert!(transport.process.is_none());
        // SAFETY: signal zero only observes the task-owned child's PID.
        assert_eq!(
            unsafe { libc::kill(pid as i32, 0) },
            -1,
            "stop must reap the pipe child"
        );
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::ESRCH)
        );
        transport.stop().await.unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_real_wait_error_preserves_the_child_and_blocks_unconfirmed_reuse() {
        let mut child = tokio::process::Command::new("/bin/sh")
            .args(["-c", "exit 0"])
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(false)
            .spawn()
            .unwrap();
        let pid = child.id().expect("the task-owned child has a PID");
        let input = child.stdin.take().unwrap();
        let output = BufReader::new(child.stdout.take().unwrap());
        let reaped = tokio::task::spawn_blocking(move || {
            let mut status = 0;
            loop {
                // SAFETY: this fixture alone owns the spawned child. External
                // reaping deliberately makes Tokio's later wait return ECHILD.
                let result = unsafe { libc::waitpid(pid as i32, &mut status, 0) };
                if result != -1
                    || std::io::Error::last_os_error().raw_os_error() != Some(libc::EINTR)
                {
                    return result;
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(reaped, pid as i32, "the fixture must reap its own child");
        let mut transport = Transport {
            executable: None,
            process: Some(Process {
                child,
                custody: ChildCustody::Owned,
                input: Some(input),
                output,
                _themes: tempfile::tempdir().unwrap(),
            }),
            last_error: None,
        };
        assert!(matches!(
            transport.stop().await,
            Err(ToolError::CleanupUnconfirmed(_))
        ));
        let retained = transport
            .process
            .as_ref()
            .expect("wait failure retains the original child owner");
        assert_eq!(retained.custody, ChildCustody::WaitUnconfirmed);
        assert!(
            retained.input.is_none(),
            "EOF closure does not discard the child handle"
        );
        let configured = transport.configure(&Spec::default()).await;
        assert!(matches!(configured.status, RenderStatus::Unavailable));
        assert!(
            transport.process.is_some(),
            "configuration cannot replace an unconfirmed child"
        );
        assert!(matches!(
            transport
                .request(Request::State {
                    id: "task-owned".into()
                })
                .await,
            Err(ToolError::CleanupUnconfirmed(_))
        ));
        drop(transport);
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    #[ignore = "requires a task-owned macOS desktop, MAKA_CUA_TEST_HOST, MAKA_CUA_GEOMETRY_PID and MAKA_CUA_GEOMETRY_WINDOW"]
    async fn geometry_refusal_preserves_the_host_and_other_cursors() {
        let executable =
            std::env::var_os("MAKA_CUA_TEST_HOST").expect("set the built Maka executable");
        let pid: i32 = std::env::var("MAKA_CUA_GEOMETRY_PID")
            .expect("set the task-owned fixture PID")
            .parse()
            .unwrap();
        let window_id: u32 = std::env::var("MAKA_CUA_GEOMETRY_WINDOW")
            .expect("set the task-owned fixture window ID")
            .parse()
            .unwrap();
        let mut host = Host::with_executable(executable.into());
        let disabled = Spec {
            enabled: false,
            ..Default::default()
        };
        let geometry = host.window_geometry(pid, window_id).await.unwrap();
        assert_eq!((geometry.pid, geometry.window_id), (pid, window_id));
        let idle = host.state(&disabled).await;
        assert!(!idle.visible);
        assert!(idle.theme.is_none(), "metadata must not register a cursor");
        let renderer_pid = idle.renderer_pid.unwrap();

        let other = Spec::default();
        host.update(
            &other,
            Some([geometry.bounds.x + 20.0, geometry.bounds.y + 20.0]),
            cursor_overlay::CursorAction::Idle,
            Some(u64::from(window_id)),
        )
        .await
        .unwrap();
        assert!(host.state(&other).await.visible);
        let error = host.window_geometry(0, window_id).await.unwrap_err();
        assert!(error.to_string().contains("window_owner_pid_mismatch"));
        let state = host.state(&other).await;
        assert_eq!(state.renderer_pid, Some(renderer_pid));
        assert!(
            state.visible,
            "a metadata refusal must preserve other cursors"
        );
        host.window_geometry(pid, window_id).await.unwrap();
        host.stop().await.unwrap();
    }

    #[tokio::test]
    #[ignore = "requires MAKA_CUA_TEST_HOST; displays a native cursor without sending input"]
    async fn renderer_keeps_cursor_until_disabled_and_exits_with_its_channel() {
        let executable =
            std::env::var_os("MAKA_CUA_TEST_HOST").expect("set the built maka executable");
        let mut host = Host::with_executable(executable.clone().into());
        let mut cursor = Spec {
            enabled: false,
            color: Color::Blue,
            ..Default::default()
        };
        let state = host
            .update(&cursor, None, cursor_overlay::CursorAction::Idle, None)
            .await
            .unwrap();
        assert_eq!(state.theme.as_deref(), Some(cursor.theme_id().as_str()));
        assert!(!state.visible);
        let pid = state.renderer_pid.unwrap();
        cursor.enabled = true;
        host.update(
            &cursor,
            Some([60.0, 60.0]),
            cursor_overlay::CursorAction::Click,
            None,
        )
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_secs(4)).await;
        assert!(
            host.state(&cursor).await.visible,
            "an idle Session keeps its cursor"
        );
        cursor.enabled = false;
        assert!(!host.configure(&cursor).await.visible);
        host.stop().await.unwrap();
        #[cfg(unix)]
        assert_ne!(
            unsafe { libc::kill(pid as i32, 0) },
            0,
            "renderer must exit after EOF"
        );
        #[cfg(not(unix))]
        let _ = pid;

        // A broken response pipe must not strand the AppKit main loop after
        // its control thread encounters an I/O error.
        let mut child = tokio::process::Command::new(executable)
            .arg(ENTRY)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        drop(child.stdout.take());
        let mut request = serde_json::to_vec(&Request::State { id: cursor.id }).unwrap();
        request.push(b'\n');
        child
            .stdin
            .as_mut()
            .unwrap()
            .write_all(&request)
            .await
            .unwrap();
        let exit = tokio::time::timeout(Duration::from_secs(10), child.wait())
            .await
            .expect("broken pipe must stop the renderer")
            .unwrap();
        assert!(!exit.success());
    }
}
