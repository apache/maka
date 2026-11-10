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

//! Native-only Windows SDK owner, using the existing inherited worker channel.
//! Browser, JavaScript and the embedding Host never execute in this child.

use super::{
    Connection, EXIT_TIMEOUT, Failure, Hello, PROTOCOL, ParentFrame, Process, Request, WorkerFrame,
    read_sync, write,
};
use crate::{InvocationContext, desktop::NativeEpochId};
use cua_driver_sdk::{
    CuaDriver, CuaDriverSession, WindowsInterruptionBinding, WindowsInterruptionSink,
    WindowsPhysicalInput,
};
use maka_agent_facts::{language::Language, tools::ToolError};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{io, process::ExitCode, sync::Arc};
use tokio::{
    sync::{Mutex, mpsc, watch},
    task::{JoinError, JoinSet},
};
use tokio_util::sync::CancellationToken;

pub(super) const ENTRY: &str = "__maka-cua-native-windows";

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(
    tag = "frame",
    content = "window",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub(crate) enum NativeCoordinateFrame {
    Screenshot,
    WindowPixels,
    WindowFrame(cua_driver_sdk::NativeWindowFrame),
    RawWindowObservation,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct NativeGeneration(uuid::Uuid);
impl NativeGeneration {
    pub(super) fn observed(&self) -> String {
        self.0.to_string()
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct NativeKey {
    pub epoch: String,
    pub session: String,
    pub turn: String,
    pub execution: crate::ExecutionCorrelation,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum NativeOperation {
    ListApps,
    ListWindows,
    GetWindowState,
    Click,
    TypeText,
    PressKey,
    Scroll,
    Drag,
    SetValue,
    LaunchApp,
    ElementBounds,
    BringToFront,
    NativeSecondaryAction,
    StartAudioRecording,
    StopAudioRecording,
}
impl NativeOperation {
    pub(super) fn name(self) -> &'static str {
        match self {
            Self::ListApps => "list_apps",
            Self::ListWindows => "list_windows",
            Self::GetWindowState => "get_window_state",
            Self::Click => "click",
            Self::TypeText => "type_text",
            Self::PressKey => "press_key",
            Self::Scroll => "scroll",
            Self::Drag => "drag",
            Self::SetValue => "set_value",
            Self::LaunchApp => "launch_app",
            Self::ElementBounds => "element_bounds",
            Self::BringToFront => "bring_to_front",
            Self::NativeSecondaryAction => "native_secondary_action",
            Self::StartAudioRecording => "start_audio_recording",
            Self::StopAudioRecording => "stop_audio_recording",
        }
    }
    fn parse(name: &str) -> Result<Self, ToolError> {
        Ok(match name {
            "list_apps" => Self::ListApps,
            "list_windows" => Self::ListWindows,
            "get_window_state" => Self::GetWindowState,
            "click" => Self::Click,
            "type_text" => Self::TypeText,
            "press_key" => Self::PressKey,
            "scroll" => Self::Scroll,
            "drag" => Self::Drag,
            "set_value" => Self::SetValue,
            "launch_app" => Self::LaunchApp,
            "element_bounds" => Self::ElementBounds,
            "bring_to_front" => Self::BringToFront,
            "native_secondary_action" => Self::NativeSecondaryAction,
            "start_audio_recording" => Self::StartAudioRecording,
            "stop_audio_recording" => Self::StopAudioRecording,
            _ => {
                return Err(ToolError::Failed(
                    "unsupported native owner operation".into(),
                ));
            }
        })
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct NativeResult {
    pub text: String,
    pub is_error: bool,
    pub error_code: Option<String>,
    pub raw_json: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    audio_output: Option<std::path::PathBuf>,
}
impl From<cua_driver_sdk::ToolResult> for NativeResult {
    fn from(result: cua_driver_sdk::ToolResult) -> Self {
        Self {
            text: result.text,
            is_error: result.is_error,
            error_code: result.error_code,
            raw_json: result.raw_json,
            audio_output: None,
        }
    }
}

pub(crate) struct NativeReply {
    pub result: NativeResult,
    pub audio: Option<NativeAudioCompletion>,
}

/// Exact transport custody of a real native capture, not a model-selected ID.
#[derive(Clone)]
pub(crate) struct NativeAudioCompletion {
    slot: Arc<Slot>,
    key: NativeKey,
    output: std::path::PathBuf,
    completion: super::connection::AudioObservation,
}
impl NativeAudioCompletion {
    pub(crate) async fn wait(&self) -> Result<(), ToolError> {
        let mut completion = self.completion.clone();
        loop {
            if let Some(result) = completion.borrow().clone() {
                return result;
            }
            completion.changed().await.map_err(|error| {
                ToolError::CleanupUnconfirmed(format!(
                    "native audio completion disappeared: {error}"
                ))
            })?;
        }
    }
    pub(crate) async fn discard(&self) -> Result<(), ToolError> {
        self.slot
            .connection
            .invoke(
                Request::NativeDiscardAudio {
                    key: self.key.clone(),
                    output: Some(self.output.clone()),
                },
                None,
                CancellationToken::new(),
            )
            .await?;
        Ok(())
    }
}

#[derive(Clone, Debug)]
pub(super) enum NativeExit {
    Exited { code: Option<i32> },
    WaitFailed(String),
}
impl NativeExit {
    fn escape(&self) -> bool {
        matches!(self, Self::Exited { code: Some(130) })
    }
}
pub(super) type ExitObservation = watch::Receiver<Option<NativeExit>>;

#[derive(Clone, Default)]
pub(super) struct NativeObservation {
    pub key: Option<NativeKey>,
    pub interrupted: bool,
    pub retired: Option<Result<(), ToolError>>,
    pub source: Option<Arc<super::connection::NativeCallSource>>,
    pub persisted: Option<Result<(), ToolError>>,
}

struct Slot {
    initial_key: NativeKey,
    generation: NativeGeneration,
    connection: Connection,
    hard_stop: CancellationToken,
    exit: ExitObservation,
    observation: watch::Receiver<NativeObservation>,
    audio: std::sync::Mutex<
        Option<(
            NativeKey,
            std::path::PathBuf,
            super::connection::AudioObservation,
        )>,
    >,
    requests: Arc<Mutex<()>>,
}
impl Slot {
    fn key(&self) -> NativeKey {
        self.observation
            .borrow()
            .key
            .clone()
            .unwrap_or_else(|| self.initial_key.clone())
    }
    fn escaped(&self) -> bool {
        self.observation.borrow().interrupted
            || self.exit.borrow().as_ref().is_some_and(NativeExit::escape)
    }
    async fn retire_binding(&self) -> Result<(), ToolError> {
        let retired = self.observation.borrow().retired.clone();
        if !matches!(retired, Some(Ok(()))) {
            if self.exit.borrow().is_some() {
                return Err(ToolError::CleanupUnconfirmed(
                    "native owner exited without an owned-input retirement acknowledgement".into(),
                ));
            }
            // A normal exact-key RPC may settle while the older native input
            // remains blocked. Its ACK covers guards only, never that action.
            if let Err(error) = self.connection.retire_native(self.key()).await {
                // Esc can retire and exit before replying to this concurrently
                // queued control. Its exact-key native retirement notification
                // is equally real input proof; Child wait is still required.
                if !matches!(self.observation.borrow().retired, Some(Ok(()))) {
                    return Err(error);
                }
            }
        }
        Ok(())
    }
    async fn close(&self) -> Result<(), ToolError> {
        self.retire_binding().await?;
        let close = self.connection.close();
        tokio::pin!(close);
        let result = match tokio::time::timeout(EXIT_TIMEOUT, close.as_mut()).await {
            Ok(result) => result,
            Err(_) => {
                // Only the exact directly spawned native child can be killed.
                // This does not target a job tree, app, browser, JS or Host PID.
                // The actual guard-retirement ACK above is required first.
                self.hard_stop.cancel();
                close.await
            }
        };
        // Original request custodians retain their Unknown outcome after a
        // forced exit. This host-only close reports only the actual owned-input
        // ACK and Child wait; transport loss alone is not a cleanup failure.
        let _transport_result = result;
        self.connection.native_process_cleanup().await
    }
}

/// One native physical resource in the existing Driver, not a permission map.
#[derive(Clone, Default)]
pub(crate) struct NativeOwner {
    current: Arc<Mutex<Option<Arc<Slot>>>>,
}
impl NativeOwner {
    async fn prepare(
        &self,
        key: NativeKey,
        audio: bool,
        expected: Option<NativeGeneration>,
    ) -> Result<(Arc<Slot>, tokio::sync::OwnedMutexGuard<()>), ToolError> {
        let mut current = self.current.lock().await;
        if let Some(slot) = current.as_ref() {
            let mut observation = slot.observation.clone();
            loop {
                let interrupted = observation.borrow().interrupted;
                let persisted = observation.borrow().persisted.clone();
                if !interrupted {
                    break;
                }
                match persisted {
                    Some(Ok(())) => break,
                    Some(Err(error)) => {
                        return Err(ToolError::Failed(format!(
                            "native interruption writer is unavailable: {error}"
                        )));
                    }
                    None => observation.changed().await.map_err(|error| {
                        ToolError::Failed(format!("native interruption observation lost: {error}"))
                    })?,
                }
            }
        }
        if let Some(expected) = expected {
            let slot = current.as_ref().filter(|slot| slot.key() == key && slot.generation == expected && slot.exit.borrow().is_none() && !slot.observation.borrow().interrupted && slot.observation.borrow().retired.is_none())
                .ok_or_else(|| ToolError::Failed("native_generation_retired: retained native observation cannot use a replacement owner".into()))?;
            let admission = slot.requests.clone().try_lock_owned().map_err(|_| {
                ToolError::Failed("native helper already has an active request".into())
            })?;
            return Ok((slot.clone(), admission));
        }
        if let Some(slot) = current.as_ref() {
            if slot.key().session == key.session
                && slot.key().turn == key.turn
                && slot.key().execution == key.execution
                && slot.escaped()
            {
                return Err(ToolError::Failed(
                    "computer_use_interrupted: native Computer Use is stopped for this turn".into(),
                ));
            }
            if slot.key() == key {
                if slot.observation.borrow().retired.is_some() || slot.exit.borrow().is_some() {
                    return Err(ToolError::Failed("native_generation_retired".into()));
                }
                let admission = slot.requests.clone().try_lock_owned().map_err(|_| {
                    ToolError::Failed("native helper already has an active request".into())
                })?;
                return Ok((slot.clone(), admission));
            }
            let prior_idle = slot.requests.clone().try_lock_owned().map_err(|_| {
                ToolError::Failed("native helper already has an active request".into())
            })?;
            if slot.key().session == key.session && !slot.escaped() && slot.exit.borrow().is_none()
            {
                slot.retire_binding().await?;
                if !slot.escaped() && slot.exit.borrow().is_none() {
                    // Normal turn changes only the actual input binding. The
                    // same SDK/audio manager and returned WAVs stay owned.
                    return Ok((slot.clone(), prior_idle));
                }
            }
            slot.close().await?;
        }
        let (exit, observation) = watch::channel(None);
        let (native, native_observation) = watch::channel(NativeObservation {
            key: Some(key.clone()),
            ..Default::default()
        });
        let hard_stop = CancellationToken::new();
        let executable =
            std::env::current_exe().map_err(|error| ToolError::Failed(error.to_string()))?;
        let process = Process::start_native(executable, audio, exit).await?;
        let generation = NativeGeneration(uuid::Uuid::new_v4());
        let slot = Arc::new(Slot {
            initial_key: key.clone(),
            generation,
            connection: Connection::start_native(
                process,
                hard_stop.clone(),
                key.clone(),
                generation,
                native,
            ),
            hard_stop,
            exit: observation,
            observation: native_observation,
            audio: std::sync::Mutex::new(None),
            requests: Arc::new(Mutex::new(())),
        });
        let admission = slot
            .requests
            .clone()
            .try_lock_owned()
            .expect("new native owner has no accepted request");
        *current = Some(slot.clone());
        Ok((slot, admission))
    }
    pub(crate) async fn invoke(
        &self,
        name: &str,
        input: Value,
        epoch: NativeEpochId,
        expected: Option<NativeGeneration>,
        coordinate_frame: NativeCoordinateFrame,
        audio: bool,
        cancellation: &CancellationToken,
        language: Language,
        invocation: &InvocationContext<'_>,
    ) -> Result<NativeReply, ToolError> {
        if cancellation.is_cancelled() {
            return Err(ToolError::Failed(
                "Computer Use cancelled before native dispatch".into(),
            ));
        }
        let operation = NativeOperation::parse(name)?;
        let key = NativeKey {
            epoch: epoch.to_string(),
            session: invocation.session().into(),
            turn: invocation.turn().into(),
            execution: invocation.execution_correlation().clone(),
        };
        let operation_id = invocation.operation_id().map(str::to_owned);
        let observer = invocation.native_interruption_observer();
        let (slot, admission) = self.prepare(key.clone(), audio, expected).await?;
        let existing_source = slot.observation.borrow().source.clone();
        let existing_binding = existing_source
            .as_ref()
            .and_then(|source| source.binding.as_ref());
        let fresh_binding = existing_binding.is_none_or(|binding| {
            binding.session() != key.session
                || binding.turn() != key.turn
                || binding.execution_correlation() != &key.execution
                || binding.native_epoch() != key.epoch
        });
        let binding = if fresh_binding {
            match (&observer, &operation_id) {
                (Some(observer), Some(operation)) if !operation.is_empty() => {
                    if existing_source.is_some() {
                        // An unobserved first request already owns the physical
                        // sink. Join that producer before registering a new one;
                        // metadata cannot relabel an existing Hook callback.
                        slot.retire_binding().await?;
                        if slot.escaped() || slot.exit.borrow().is_some() {
                            return Err(ToolError::Failed("native_generation_retired".into()));
                        }
                    }
                    let binding = crate::NativeBindingSource::from_bound_native(
                        key.session.clone(),
                        key.turn.clone(),
                        key.execution.clone(),
                        key.epoch.clone(),
                        slot.generation.observed(),
                        operation.clone(),
                    )?;
                    // This metadata registration happens before wire admission;
                    // independent discard/retirement controls keep progressing.
                    crate::native_interruption::own_observation(|| observer.bound(binding.clone()))
                        .await?;
                    Some(binding)
                }
                (Some(_), _) => {
                    return Err(ToolError::Failed(
                        "native observer requires the actual Host operation".into(),
                    ));
                }
                (None, _) => None,
            }
        } else {
            None
        };
        let source = super::connection::NativeCallSource {
            key: key.clone(),
            operation_id: operation_id.clone(),
            observer,
            binding,
        };
        if cancellation.is_cancelled() {
            return Err(ToolError::Failed(
                "Computer Use cancelled before native dispatch".into(),
            ));
        }
        let reply = slot
            .connection
            .invoke_native(
                Request::NativeInvoke {
                    key: key.clone(),
                    operation,
                    operation_id,
                    arguments: input,
                    coordinate_frame,
                    language,
                },
                cancellation.clone(),
                admission,
                source,
            )
            .await?;
        let mut result: NativeResult = serde_json::from_value(reply.value).map_err(|error| {
            ToolError::OutcomeUnknown(format!("invalid native owner result: {error}"))
        })?;
        let audio = if !result.is_error {
            match reply.audio {
                Some(completion) => {
                    let output = result.audio_output.take().ok_or_else(|| {
                        ToolError::CleanupUnconfirmed(
                            "native audio ACK omitted its actual owned output metadata".into(),
                        )
                    })?;
                    *slot.audio.lock().map_err(|_| {
                        ToolError::CleanupUnconfirmed("native audio receipt mutex poisoned".into())
                    })? = Some((key.clone(), output.clone(), completion.clone()));
                    Some(NativeAudioCompletion {
                        slot: slot.clone(),
                        key: key.clone(),
                        output,
                        completion,
                    })
                }
                None => None,
            }
        } else {
            None
        };
        Ok(NativeReply { result, audio })
    }
    pub(crate) async fn generation(
        &self,
        epoch: NativeEpochId,
    ) -> Result<NativeGeneration, ToolError> {
        let current = self.current.lock().await;
        let slot = current
            .as_ref()
            .filter(|slot| slot.key().epoch == epoch.to_string())
            .ok_or_else(|| ToolError::Failed("native generation is unavailable".into()))?;
        if let Some(NativeExit::WaitFailed(reason)) = slot.exit.borrow().as_ref() {
            return Err(ToolError::CleanupUnconfirmed(reason.clone()));
        }
        if slot.exit.borrow().is_some()
            || slot.observation.borrow().interrupted
            || slot.observation.borrow().retired.is_some()
        {
            return Err(ToolError::Failed("native_generation_retired".into()));
        }
        Ok(slot.generation)
    }
    pub(crate) async fn audio_completion(
        &self,
        epoch: NativeEpochId,
    ) -> Result<NativeAudioCompletion, ToolError> {
        let current = self.current.lock().await;
        let slot = current
            .as_ref()
            .filter(|slot| slot.key().epoch == epoch.to_string())
            .ok_or_else(|| ToolError::Failed("native audio epoch is unavailable".into()))?;
        let receipt = slot
            .audio
            .lock()
            .map_err(|_| {
                ToolError::CleanupUnconfirmed("native audio receipt mutex poisoned".into())
            })?
            .clone();
        let (key, output, completion) = receipt
            .ok_or_else(|| ToolError::Failed("computer audio recording is not active".into()))?;
        Ok(NativeAudioCompletion {
            slot: slot.clone(),
            key,
            output,
            completion,
        })
    }
    pub(crate) async fn discard_audio(&self, epoch: NativeEpochId) -> Result<(), ToolError> {
        let slot = self
            .current
            .lock()
            .await
            .as_ref()
            .filter(|slot| slot.key().epoch == epoch.to_string())
            .cloned();
        let Some(slot) = slot else {
            return Ok(());
        };
        slot.connection
            .invoke(
                Request::NativeDiscardAudio {
                    key: slot.key(),
                    output: None,
                },
                None,
                CancellationToken::new(),
            )
            .await?;
        *slot.audio.lock().map_err(|_| {
            ToolError::CleanupUnconfirmed("native audio receipt mutex poisoned".into())
        })? = None;
        Ok(())
    }
    pub(crate) async fn finish_turn(
        &self,
        epoch: NativeEpochId,
        session: &str,
        turn: &str,
        execution: &crate::ExecutionCorrelation,
    ) -> Result<(), ToolError> {
        let current = self.current.lock().await;
        if let Some(slot) = current.as_ref().filter(|slot| {
            slot.key().epoch == epoch.to_string()
                && slot.key().session == session
                && slot.key().turn == turn
                && &slot.key().execution == execution
        }) {
            slot.retire_binding().await?;
        }
        Ok(())
    }
    pub(crate) async fn close_epoch(&self, epoch: NativeEpochId) -> Result<(), ToolError> {
        let current = self.current.lock().await;
        if let Some(slot) = current
            .as_ref()
            .filter(|slot| slot.key().epoch == epoch.to_string())
        {
            slot.retire_binding().await?;
        }
        // JS epoch replacement cannot erase the original interrupted source.
        // A different admitted source may replace it through normal binding custody.
        Ok(())
    }
    pub(crate) async fn close(&self) -> Result<(), ToolError> {
        if let Some(slot) = self.current.lock().await.as_ref() {
            slot.close().await?;
        }
        Ok(())
    }
}

enum NativeEvent {
    Escape {
        key: NativeKey,
        operation_id: Option<String>,
        binding: Arc<WindowsInterruptionBinding>,
    },
    Completed {
        id: u64,
        audio_start: bool,
        result: Result<(NativeResult, Option<cua_driver_sdk::AudioCompletion>), Failure>,
    },
    Audio {
        id: u64,
        result: Result<(), Failure>,
    },
    Control {
        id: u64,
        retired_monitor: Option<Arc<WindowsInterruptionBinding>>,
        result: Result<Value, Failure>,
    },
}
struct PhysicalSink {
    events: mpsc::UnboundedSender<NativeEvent>,
    key: NativeKey,
    operation_id: Option<String>,
    binding: std::sync::OnceLock<std::sync::Weak<WindowsInterruptionBinding>>,
}
impl WindowsInterruptionSink for PhysicalSink {
    fn notify(&self, input: WindowsPhysicalInput) -> Result<(), String> {
        if input == WindowsPhysicalInput::Escape {
            let binding = self
                .binding
                .get()
                .and_then(std::sync::Weak::upgrade)
                .ok_or_else(|| "physical native producer lost its actual binding".to_owned())?;
            self.events
                .send(NativeEvent::Escape {
                    key: self.key.clone(),
                    operation_id: self.operation_id.clone(),
                    binding,
                })
                .map_err(|_| "native owner supervisor disappeared".to_owned())?;
        }
        Ok(())
    }
}
fn create_interruption_binding(
    session: &Arc<CuaDriverSession>,
    key: &NativeKey,
    operation_id: Option<String>,
    events: mpsc::UnboundedSender<NativeEvent>,
) -> io::Result<Arc<WindowsInterruptionBinding>> {
    let sink = Arc::new(PhysicalSink {
        events,
        key: key.clone(),
        operation_id,
        binding: std::sync::OnceLock::new(),
    });
    let binding = session
        .create_windows_interruption(key.turn.clone(), sink.clone())
        .map_err(|error| io::Error::other(error.to_string()))?;
    sink.binding
        .set(Arc::downgrade(&binding))
        .map_err(|_| io::Error::other("native physical producer binding initialized twice"))?;
    Ok(binding)
}

// Task failure terminates this native-only actor. The parent keeps its exact
// pending requests and requires real input-retirement/process proof; a panic is
// neither a successful completion nor a physical-Esc receipt.
fn native_task_finished(result: Result<(), JoinError>) -> io::Result<()> {
    match result {
        Ok(()) => Ok(()),
        Err(error) if error.is_panic() => std::panic::resume_unwind(error.into_panic()),
        Err(error) => Err(io::Error::other(error)),
    }
}

struct Bound {
    key: NativeKey,
    session: Arc<CuaDriverSession>,
    monitor: Option<Arc<WindowsInterruptionBinding>>,
    operation_id: Option<String>,
}

async fn serve(
    mut receive: mpsc::Receiver<ParentFrame>,
    mut output: impl tokio::io::AsyncWrite + Unpin,
    disconnected: CancellationToken,
    audio: bool,
) -> io::Result<()> {
    write(
        &mut output,
        &Hello {
            protocol: PROTOCOL,
            platform: "windows-native".into(),
            audio_enabled: audio,
        },
    )
    .await?;
    let driver = CuaDriver::create_configured(crate::driver::native_configuration(audio))
        .map_err(|error| io::Error::other(error.to_string()))?;
    let (events, mut received) = mpsc::unbounded_channel();
    let mut bound: Option<Bound> = None;
    let mut active = None;
    let mut controls = std::collections::HashSet::new();
    let mut tasks = JoinSet::new();
    let mut shutdown = None;
    let mut closing = false;
    let mut interrupted = false;
    let mut quarantined: Option<String> = None;
    let mut last_request = 0;
    loop {
        if closing && active.is_none() && controls.is_empty() {
            let cleanup = driver
                .shutdown()
                .await
                .map_err(|error| io::Error::other(error.to_string()));
            if let Some(id) = shutdown {
                write(
                    &mut output,
                    &WorkerFrame::Response {
                        id,
                        result: cleanup
                            .as_ref()
                            .map(|_| Value::Null)
                            .map_err(|error| Failure::CleanupUnconfirmed(error.to_string())),
                    },
                )
                .await?;
            }
            return cleanup;
        }
        tokio::select! {
            biased;
            joined = tasks.join_next(), if !tasks.is_empty() => {
                native_task_finished(joined.expect("native task set was nonempty"))?;
            },
            event = received.recv() => match event.ok_or_else(|| io::Error::other("native event producer disappeared"))? {
                NativeEvent::Escape { key, operation_id, binding } => {
                    let Some(bound) = bound.as_ref() else { return Err(io::Error::other("physical Esc has no actual native binding")); };
                    if key != bound.key || operation_id != bound.operation_id || !bound.monitor.as_ref().is_some_and(|monitor| Arc::ptr_eq(&binding, monitor)) {
                        // A valid old callback is sent before its real Hook
                        // thread joins and before NativeRetire ACK. Parent
                        // rebind admission requires that ACK. A mismatch is a
                        // broken producer contract: never label or kill B as A.
                        let reason = "native physical producer arrived after its terminal binding barrier".to_owned();
                        eprintln!("{reason}");
                        quarantined = Some(reason);
                        continue;
                    }
                    interrupted = true;
                    write(&mut output, &WorkerFrame::NativeInterruption { key: key.clone(), operation_id }).await?;
                    let joined = binding.release_native_inputs().await;
                    let result = joined.map_err(|error| Failure::CleanupUnconfirmed(error.to_string()));
                    write(&mut output, &WorkerFrame::NativeRetired { key, result: result.clone() }).await?;
                    // This process owns only native SDK work. Exit stops even a
                    // blocked UIA provider; no arbitrary PID/job tree is killed.
                    // A failed owned-input release must not permit a hard exit.
                    // Process exit itself settles the native hook/provider threads.
                    if let Err(error) = result { eprintln!("native input retirement: {error:?}"); continue; }
                    std::process::exit(130);
                },
                NativeEvent::Completed { id, audio_start, result } => {
                    if active.take() != Some(id) { return Err(io::Error::other("native completion identity mismatch")); }
                    let (reply, completion) = match result {
                        Ok((result, completion)) => (serde_json::to_value(result).map_err(|error| Failure::OutcomeUnknown(error.to_string())), completion),
                        Err(error) => (Err(error), None),
                    };
                    write(&mut output, &WorkerFrame::Response { id, result: reply }).await?;
                    if let Some(completion) = completion {
                        let events = events.clone();
                        tasks.spawn(async move {
                            let result = completion.wait().await.map_err(|error| Failure::CleanupUnconfirmed(error.to_string()));
                            let _ = events.send(NativeEvent::Audio { id, result });
                        });
                    } else if audio_start {
                        write(&mut output, &WorkerFrame::AudioFinished { id, result: Err(Failure::Failed("native audio did not start".into())) }).await?;
                    }
                },
                NativeEvent::Audio { id, result } => write(&mut output, &WorkerFrame::AudioFinished { id, result }).await?,
                NativeEvent::Control { id, retired_monitor, result } => {
                    if !controls.remove(&id) { return Err(io::Error::other("native control completion identity mismatch")); }
                    if result.is_ok() {
                        if let (Some(current), Some(retired)) = (bound.as_mut(), retired_monitor.as_ref()) {
                            if current.monitor.as_ref().is_some_and(|monitor| Arc::ptr_eq(monitor, retired)) {
                                current.monitor = None;
                            }
                        }
                    }
                    write(&mut output, &WorkerFrame::Response { id, result }).await?;
                },
            },
            _ = disconnected.cancelled(), if !closing => closing = true,
            frame = receive.recv(), if !closing => {
                match frame {
                    Some(ParentFrame::Request { id, request }) => {
                        if id <= last_request { return Err(io::Error::other("native request identity mismatch")); }
                        last_request = id;
                        match *request {
                            Request::Shutdown => { closing = true; shutdown = Some(id); },
                            Request::NativeInvoke { key, operation, operation_id, arguments, coordinate_frame, .. } => {
                                if let Some(reason) = &quarantined {
                                    write(&mut output, &WorkerFrame::Response { id, result: Err(Failure::Failed(format!("native input producer is quarantined: {reason}"))) }).await?;
                                    continue;
                                }
                                if interrupted {
                                    write(&mut output, &WorkerFrame::Response { id, result: Err(Failure::Failed("computer_use_interrupted: native Computer Use is stopped for this turn".into())) }).await?;
                                    continue;
                                }
                                if active.is_some() {
                                    write(&mut output, &WorkerFrame::Response { id, result: Err(Failure::Failed("native helper already has an active request".into())) }).await?;
                                    continue;
                                }
                                if key.epoch.is_empty() || key.session.is_empty() || key.turn.is_empty() { return Err(io::Error::other("native key is empty")); }
                                if let Some(current) = bound.as_mut().filter(|bound| bound.key != key || bound.monitor.is_none()) {
                                    if current.key.session != key.session { return Err(io::Error::other("native process owner changed")); }
                                    if let Some(monitor) = current.monitor.as_ref() {
                                        monitor.close_monitor().await.map_err(|error| io::Error::other(error.to_string()))?;
                                    }
                                    current.monitor = Some(create_interruption_binding(&current.session, &key, operation_id.clone(), events.clone())?);
                                    current.key = key.clone();
                                    current.operation_id = operation_id.clone();
                                }
                                if bound.is_none() {
                                    let session = driver.create_trusted_session(cua_driver_sdk::TrustedSessionOptions {
                                        public_session: format!("maka-native-{}", uuid::Uuid::new_v4()),
                                        mode: cua_driver_sdk::SessionPermissionMode::Standard, ttl_seconds: 86400, idle_ttl_seconds: 86400,
                                        capability_manifest_path: None, bounded_manifest_path: None,
                                    }).map_err(|error| io::Error::other(error.to_string()))?;
                                    session.start_session(cua_driver_contract::StartSessionInput { session: None, capture_scope: None, cursor_theme: None, cursor_motion: None }).await.map_err(|error| io::Error::other(error.to_string()))?;
                                    let monitor = create_interruption_binding(&session, &key, operation_id.clone(), events.clone())?;
                                    bound = Some(Bound { key, session, monitor: Some(monitor), operation_id });
                                }
                                let bound = bound.as_ref().expect("created native binding");
                                let session = bound.session.clone(); let monitor = bound.monitor.as_ref().expect("created actual input producer").clone(); let events = events.clone();
                                active = Some(id);
                                tasks.spawn(async move {
                                    let call = match coordinate_frame {
                                        NativeCoordinateFrame::RawWindowObservation => {
                                            if !matches!(operation,NativeOperation::GetWindowState) {
                                                Err(cua_driver_sdk::DriverError::Protocol { reason:"raw observation refinement requires get_window_state".into() })
                                            } else {
                                                session.observe_raw_window_with_windows_interruption(arguments.to_string(),monitor).await
                                            }
                                        },
                                        NativeCoordinateFrame::WindowFrame(frame) => session.call_tool_with_native_window_frame_and_windows_interruption(operation.name().into(), arguments.to_string(), frame, monitor).await,
                                        NativeCoordinateFrame::WindowPixels => session.call_tool_with_native_window_pixels_and_windows_interruption(operation.name().into(), arguments.to_string(), monitor).await,
                                        NativeCoordinateFrame::Screenshot => session.call_tool_with_windows_interruption(operation.name().into(), arguments.to_string(), monitor).await,
                                    };
                                    let result = match call {
                                        Ok(result) => {
                                            let completion = if matches!(operation, NativeOperation::StartAudioRecording) && !result.is_error {
                                                session.audio_completion().await.map(Some)
                                            } else { Ok(None) };
                                            match completion {
                                                Ok(completion) => {
                                                    let mut result = NativeResult::from(result);
                                                    match completion.as_ref().map(|capture| capture.output_path()).transpose() {
                                                        Ok(output) => { result.audio_output = output; Ok((result, completion)) },
                                                        Err(error) => {
                                                            let cleanup = session.discard_audio().await;
                                                            Err(Failure::CleanupUnconfirmed(format!("native audio output metadata: {error}; startup cleanup: {cleanup:?}")))
                                                        },
                                                    }
                                                },
                                                Err(error) => {
                                                    let cleanup = session.discard_audio().await;
                                                    let message = match cleanup { Ok(()) => error.to_string(), Err(cleanup) => format!("{error}; failed to discard accepted audio: {cleanup}") };
                                                    Err(Failure::CleanupUnconfirmed(message))
                                                },
                                            }
                                        },
                                        Err(error) => Err(Failure::OutcomeUnknown(error.to_string())),
                                    };
                                    let _ = events.send(NativeEvent::Completed { id, audio_start: matches!(operation, NativeOperation::StartAudioRecording), result });
                                });
                            },
                            Request::NativeDiscardAudio { key, output: expected_output } if bound.as_ref().is_some_and(|bound| bound.key == key || (expected_output.is_some() && bound.key.session == key.session && bound.key.epoch == key.epoch)) => {
                                let session = bound.as_ref().expect("checked bound").session.clone();
                                let events = events.clone();
                                controls.insert(id);
                                tasks.spawn(async move {
                                    let result = match expected_output {
                                        Some(output) => session.discard_audio_output(output).await.map(Value::Bool),
                                        None => session.discard_audio().await.map(|_| Value::Null),
                                    }.map_err(|error| Failure::CleanupUnconfirmed(error.to_string()));
                                    let _ = events.send(NativeEvent::Control { id, retired_monitor: None, result });
                                });
                            },
                            Request::NativeRetire { key } if bound.as_ref().is_none_or(|bound| bound.key == key) => {
                                let monitor = bound.as_ref().and_then(|bound| bound.monitor.clone());
                                let events = events.clone(); controls.insert(id);
                                tasks.spawn(report_native_control(events, id, monitor.clone(), async move {
                                    match monitor { Some(monitor) => monitor.close_monitor().await.map(|_| Value::Null).map_err(|error| Failure::CleanupUnconfirmed(error.to_string())), None => Ok(Value::Null) }
                                }));
                            },
                            _ => write(&mut output, &WorkerFrame::Response { id, result: Err(Failure::Failed("native-only helper refuses non-native requests".into())) }).await?,
                        }
                    },
                    Some(ParentFrame::Cancel { id }) if active == Some(id) || id <= last_request => {},
                    None => closing = true,
                    _ => return Err(io::Error::other("native-only helper received a foreign capability frame")),
                }
            },
        }
    }
}

async fn report_native_control(
    events: mpsc::UnboundedSender<NativeEvent>,
    id: u64,
    retired_monitor: Option<Arc<WindowsInterruptionBinding>>,
    settlement: impl std::future::Future<Output = Result<Value, Failure>>,
) {
    // The ACK is queued only after this same real cleanup future settles.
    // NativeRetire's future includes the actual Hook thread join.
    let result = settlement.await;
    let _ = events.send(NativeEvent::Control {
        id,
        retired_monitor,
        result,
    });
}

pub(super) fn bootstrap() -> Option<ExitCode> {
    if std::env::args_os().nth(1).as_deref() != Some(std::ffi::OsStr::new(ENTRY)) {
        return None;
    }
    let audio = std::env::args_os().nth(2).as_deref() == Some(std::ffi::OsStr::new("--audio"));
    let result = if std::env::args_os().len() != if audio { 3 } else { 2 } {
        Err(io::Error::other("native owner accepts only --audio"))
    } else {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .and_then(|runtime| {
                runtime.block_on(async {
                    let (send, receive) = mpsc::channel(1);
                    let disconnected = CancellationToken::new();
                    let eof = disconnected.clone();
                    std::thread::spawn(move || {
                        let mut input = std::io::stdin().lock();
                        while let Ok(frame) = read_sync(&mut input) {
                            if send.blocking_send(frame).is_err() {
                                break;
                            }
                        }
                        eof.cancel();
                    });
                    serve(receive, tokio::io::stdout(), disconnected, audio).await
                })
            })
    };
    Some(match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("Maka native owner: {error}");
            ExitCode::FAILURE
        }
    })
}
