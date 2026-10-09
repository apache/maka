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

//! Runs the bot sidecar and keeps it running.
//!
//! [`supervise`] returns a future that owns the whole lifecycle: start the
//! sidecar, wait for its `ready`, hand it the settings and the workspace,
//! forward its commands and events, and start it again with backoff when it
//! exits. It spawns nothing itself; the caller drives the future, as
//! `host-client`'s supervisor is driven.
//!
//! - The settings and the workspace last given ([`BotHandle::apply_settings`],
//!   [`BotHandle::set_workspace`]) are replayed to every new sidecar, so a
//!   restart brings the channels back without the caller's help. While no
//!   sidecar runs they are only recorded.
//! - Other commands need a running sidecar and fail with
//!   [`BotCommandError::NotRunning`] otherwise; a command in flight when the
//!   sidecar exits fails with [`BotCommandError::Interrupted`], and is never
//!   replayed.
//! - A sidecar that reports `fatal` (no built Maka checkout, bad arguments)
//!   or cannot be started is not restarted: [`BotEvent::Suspended`] until
//!   [`BotHandle::restart`].
//! - [`BotHandle::shutdown`] asks the sidecar to stop its bridges and exit,
//!   and kills it after [`RestartPolicy::shutdown_grace`]. Dropping the
//!   future kills it at once. A sidecar whose client died sees its stdin close
//!   and exits by itself.

use std::collections::HashMap;
use std::fmt;
use std::future::Future;
use std::io;
use std::pin::Pin;
use std::process::ExitStatus;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use async_io::Timer;
use async_process::{Child, ChildStdin, Stdio};
use futures_lite::io::BufReader;
use futures_lite::{AsyncBufReadExt as _, AsyncRead, AsyncWriteExt as _, future};
use host_protocol::WorkspaceTarget;
use serde::de::DeserializeOwned;
use serde_json::Value;
use thiserror::Error;

use crate::instance_lock::InstanceLock;
use crate::protocol::{
    BotTestResult, ChannelStatus, Command, HostLinkState, LogLevel, OnboardingBrand,
    OnboardingChannel, OnboardingSnapshot, SIDECAR_PROTOCOL_VERSION, SidecarEvent, SidecarLine,
    SidecarRefusal, WechatBridgeQr, decode_line, encode_command,
};
use crate::settings::{BotChannelSettings, BotChatSettings, BotProvider};
use crate::sidecar::SidecarCommand;

/// Capacity of the event channel. Events are rare (a status change, a log
/// line); a slow consumer holds the sidecar's output back rather than losing
/// any.
pub const EVENT_CHANNEL_CAPACITY: usize = 64;

/// A stdout line longer than this is not the protocol; it is dropped.
const MAX_LINE_BYTES: usize = 1024 * 1024;

/// Timing of the supervisor.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct RestartPolicy {
    /// The delay before the first restart after a crash; it doubles with each
    /// crash in a row up to `backoff_max`.
    pub backoff_min: Duration,
    pub backoff_max: Duration,
    /// A sidecar that ran this long before exiting starts a new crash count.
    pub stable_run: Duration,
    /// How long a new sidecar may take to report `ready`.
    pub ready_timeout: Duration,
    /// How long a command may wait for its answer. A channel test waits for
    /// the platform (10 s in `bot-test.ts`), and applying settings starts the
    /// bridges, each of which signs in first.
    pub command_timeout: Duration,
    /// How long [`BotHandle::shutdown`] waits for the sidecar to exit before
    /// killing it.
    pub shutdown_grace: Duration,
}

impl Default for RestartPolicy {
    fn default() -> Self {
        Self {
            backoff_min: Duration::from_secs(1),
            backoff_max: Duration::from_secs(60),
            stable_run: Duration::from_secs(60),
            ready_timeout: Duration::from_secs(30),
            command_timeout: Duration::from_secs(45),
            shutdown_grace: Duration::from_secs(3),
        }
    }
}

impl RestartPolicy {
    pub fn with_backoff(mut self, min: Duration, max: Duration) -> Self {
        self.backoff_min = min;
        self.backoff_max = max.max(min);
        self
    }

    pub fn with_timeouts(mut self, ready: Duration, command: Duration, shutdown: Duration) -> Self {
        self.ready_timeout = ready;
        self.command_timeout = command;
        self.shutdown_grace = shutdown;
        self
    }

    /// The delay before restart `crashes` (1-based) of a crash streak.
    pub fn restart_delay(&self, crashes: u32) -> Duration {
        let doublings = crashes.saturating_sub(1).min(16);
        self.backoff_min.saturating_mul(1 << doublings).min(self.backoff_max)
    }
}

/// What happens to the sidecar, in order.
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub enum BotEvent {
    /// Sidecar process `pid` reported `ready` and received the settings.
    /// `compatibility_epoch` is the Maka checkout's
    /// `RUNTIME_HOST_COMPATIBILITY_EPOCH`.
    Started { pid: u32, compatibility_epoch: Option<u32> },
    /// A channel's status changed.
    Status(ChannelStatus),
    /// The sidecar's connection to the Runtime Host changed.
    Host(HostLinkState),
    /// A line the sidecar logged (its stderr as [`LogLevel::Warn`]).
    Log { level: LogLevel, message: String },
    /// The sidecar exited; it is started again after `restart_in`, or at
    /// once on [`BotHandle::restart`].
    Exited { reason: Arc<str>, restart_in: Duration },
    /// The sidecar cannot run as things are; nothing is retried until
    /// [`BotHandle::restart`].
    Suspended { reason: Arc<str> },
    /// The supervisor stopped; the future has completed.
    Stopped,
}

/// Why a command did not complete.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[non_exhaustive]
pub enum BotCommandError {
    #[error("the bot sidecar is not running")]
    NotRunning,
    #[error("the bot sidecar exited before it answered")]
    Interrupted,
    #[error("the bot sidecar did not answer in time")]
    TimedOut,
    #[error("the bot sidecar refused the command: {}", .0.message)]
    Refused(SidecarRefusal),
    #[error("the bot sidecar sent an answer this client cannot read: {0}")]
    InvalidAnswer(String),
    #[error("the bot supervisor has stopped")]
    Stopped,
}

pub(crate) type Reply = async_channel::Sender<Result<Value, BotCommandError>>;

pub(crate) enum Request {
    Command { command: Command, reply: Reply },
    Restart,
    Shutdown { done: async_channel::Sender<()> },
}

/// Sends commands to the supervised sidecar. Cheap to clone.
#[derive(Clone)]
pub struct BotHandle {
    pub(crate) requests: async_channel::Sender<Request>,
}

impl fmt::Debug for BotHandle {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("BotHandle").finish_non_exhaustive()
    }
}

impl BotHandle {
    /// Runs the channels in `settings` (`botRegistry.applySettings`), now
    /// and in every sidecar started later.
    pub async fn apply_settings(&self, settings: BotChatSettings) -> Result<(), BotCommandError> {
        self.send(Command::ApplySettings { settings: Box::new(settings) }).await.map(drop)
    }

    /// Where bot Sessions are created, now and in every sidecar started
    /// later. With none, a bot message is answered with Desktop's "Select a
    /// project from the Runtime Host first".
    pub async fn set_workspace(
        &self,
        workspace: Option<WorkspaceTarget>,
    ) -> Result<(), BotCommandError> {
        self.send(Command::SetWorkspace { workspace }).await.map(drop)
    }

    /// Checks `channel`'s credentials against its platform
    /// (`testBotChannel`). Record the result with
    /// [`BotChannelSettings::record_test`].
    pub async fn test_channel(
        &self,
        provider: BotProvider,
        channel: BotChannelSettings,
    ) -> Result<BotTestResult, BotCommandError> {
        let answer =
            self.send(Command::TestChannel { provider, channel: Box::new(channel) }).await?;
        field(answer, "result")
    }

    /// Re-applies the settings, as Desktop's `settings:bots:restart` does,
    /// and resumes a channel suspended by a conflict: `provider`'s, or every
    /// one. Returns every channel's status.
    pub async fn restart_listeners(
        &self,
        provider: Option<BotProvider>,
    ) -> Result<Vec<ChannelStatus>, BotCommandError> {
        field(self.send(Command::RestartListeners { provider }).await?, "statuses")
    }

    /// Every channel's status (`botRegistry.allStatuses`).
    pub async fn list_statuses(&self) -> Result<Vec<ChannelStatus>, BotCommandError> {
        field(self.send(Command::ListStatuses).await?, "statuses")
    }

    /// Starts a QR onboarding of `provider`, cancelling its last one
    /// (`settings:bots:onboarding:start`).
    pub async fn onboarding_start(
        &self,
        provider: BotProvider,
        brand: Option<OnboardingBrand>,
    ) -> Result<OnboardingSnapshot, BotCommandError> {
        field(self.send(Command::OnboardingStart { provider, brand }).await?, "snapshot")
    }

    /// Asks the provider about session `session_id`; with the channel a
    /// confirmed scan set, once.
    pub(crate) async fn onboarding_poll(
        &self,
        session_id: &str,
    ) -> Result<(OnboardingSnapshot, Option<OnboardingChannel>), BotCommandError> {
        let mut answer =
            self.send(Command::OnboardingPoll { session_id: session_id.to_owned() }).await?;
        let channel = match answer.get_mut("channel").map(Value::take) {
            None | Some(Value::Null) => None,
            Some(channel) => Some(
                serde_json::from_value(channel)
                    .map_err(|error| BotCommandError::InvalidAnswer(format!("channel: {error}")))?,
            ),
        };
        Ok((field(answer, "snapshot")?, channel))
    }

    /// After the confirmed channel was saved and applied: connected, or
    /// connected with a warning when its listener did not start.
    pub async fn onboarding_finish(
        &self,
        session_id: &str,
    ) -> Result<OnboardingSnapshot, BotCommandError> {
        let command = Command::OnboardingFinish { session_id: session_id.to_owned() };
        field(self.send(command).await?, "snapshot")
    }

    pub async fn onboarding_cancel(
        &self,
        session_id: &str,
    ) -> Result<OnboardingSnapshot, BotCommandError> {
        let command = Command::OnboardingCancel { session_id: session_id.to_owned() };
        field(self.send(command).await?, "snapshot")
    }

    /// The HTTPS page to open when the code cannot be scanned.
    pub async fn onboarding_url(&self, session_id: &str) -> Result<String, BotCommandError> {
        let command = Command::OnboardingUrl { session_id: session_id.to_owned() };
        field(self.send(command).await?, "url")
    }

    /// The local wechat-bridge's sign-in QR code for `channel`
    /// (`settings:bots:wechatQrCode`).
    pub async fn wechat_bridge_qr(
        &self,
        channel: BotChannelSettings,
    ) -> Result<WechatBridgeQr, BotCommandError> {
        field(self.send(Command::WechatBridgeQr { channel: Box::new(channel) }).await?, "result")
    }

    /// Starts the sidecar now: after a crash without waiting for the backoff,
    /// after [`BotEvent::Suspended`], or in place of a running one.
    pub fn restart(&self) {
        let _ = self.requests.try_send(Request::Restart);
    }

    /// Stops the sidecar and the supervisor; resolves once the sidecar has
    /// exited.
    pub async fn shutdown(&self) {
        let (done, stopped) = async_channel::bounded(1);
        if self.requests.send(Request::Shutdown { done }).await.is_ok() {
            let _ = stopped.recv().await;
        }
    }

    async fn send(&self, command: Command) -> Result<Value, BotCommandError> {
        let (reply, answer) = async_channel::bounded(1);
        self.requests
            .send(Request::Command { command, reply })
            .await
            .map_err(|_| BotCommandError::Stopped)?;
        answer.recv().await.map_err(|_| BotCommandError::Stopped)?
    }
}

fn field<T: DeserializeOwned>(mut answer: Value, name: &str) -> Result<T, BotCommandError> {
    let value = answer.get_mut(name).map(Value::take).unwrap_or(Value::Null);
    serde_json::from_value(value)
        .map_err(|error| BotCommandError::InvalidAnswer(format!("{name}: {error}")))
}

/// The parts [`supervise`] returns.
#[derive(Debug)]
#[non_exhaustive]
pub struct SupervisedBots {
    pub handle: BotHandle,
    /// Must be polled (spawned on a background executor) or nothing happens.
    pub run: BotRun,
    /// What happens, in order. Bounded at [`EVENT_CHANNEL_CAPACITY`].
    pub events: async_channel::Receiver<BotEvent>,
}

/// The supervisor's future.
pub struct BotRun {
    pub(crate) future: Pin<Box<dyn Future<Output = ()> + Send>>,
}

impl Future for BotRun {
    type Output = ();

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<()> {
        self.future.as_mut().poll(cx)
    }
}

impl fmt::Debug for BotRun {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("BotRun").finish_non_exhaustive()
    }
}

/// Supervises the process `command` starts. `lock`, when given, is held until
/// the supervisor stops.
pub fn supervise(
    command: SidecarCommand,
    policy: RestartPolicy,
    lock: Option<InstanceLock>,
) -> SupervisedBots {
    let (requests_tx, requests) = async_channel::bounded(8);
    let (events_tx, events) = async_channel::bounded(EVENT_CHANNEL_CAPACITY);
    let supervisor = Supervisor {
        command,
        policy,
        requests,
        events: events_tx,
        settings: None,
        workspace: None,
        stopped: Vec::new(),
        lock,
    };
    SupervisedBots {
        handle: BotHandle { requests: requests_tx },
        run: BotRun { future: Box::pin(supervisor.run()) },
        events,
    }
}

/// A supervisor with no process behind it: the test answers the requests and
/// sends the events.
#[cfg(test)]
pub(crate) struct Script {
    pub(crate) requests: async_channel::Receiver<Request>,
    pub(crate) events: async_channel::Sender<BotEvent>,
}

#[cfg(test)]
pub(crate) fn scripted() -> (SupervisedBots, Script) {
    let (requests_tx, requests) = async_channel::bounded(8);
    let (events_tx, events) = async_channel::bounded(EVENT_CHANNEL_CAPACITY);
    let supervised = SupervisedBots {
        handle: BotHandle { requests: requests_tx },
        run: BotRun { future: Box::pin(future::pending()) },
        events,
    };
    (supervised, Script { requests, events: events_tx })
}

struct Supervisor {
    command: SidecarCommand,
    policy: RestartPolicy,
    requests: async_channel::Receiver<Request>,
    events: async_channel::Sender<BotEvent>,
    /// Replayed to every new sidecar.
    settings: Option<BotChatSettings>,
    workspace: Option<Option<WorkspaceTarget>>,
    /// Told once the supervisor has stopped.
    stopped: Vec<async_channel::Sender<()>>,
    /// Released before `stopped` is told, so a new sidecar can take it.
    lock: Option<InstanceLock>,
}

/// How one sidecar run ended.
enum Ended {
    /// It exited or was killed; start another after the backoff.
    Exited(String),
    /// Starting another cannot help.
    Fatal(String),
    /// The caller asked for a new one.
    Restart,
    /// The caller asked to stop.
    Shutdown,
}

/// What ended a wait between runs.
enum Resume {
    Start,
    Shutdown,
}

impl Supervisor {
    async fn run(mut self) {
        let mut crashes = 0;
        loop {
            let started = Instant::now();
            match self.run_sidecar().await {
                Ended::Shutdown => break,
                Ended::Restart => crashes = 0,
                Ended::Fatal(reason) => {
                    self.emit(BotEvent::Suspended { reason: reason.into() }).await;
                    match self.wait(None).await {
                        Resume::Start => crashes = 0,
                        Resume::Shutdown => break,
                    }
                }
                Ended::Exited(reason) => {
                    if started.elapsed() >= self.policy.stable_run {
                        crashes = 0;
                    }
                    crashes += 1;
                    let restart_in = self.policy.restart_delay(crashes);
                    self.emit(BotEvent::Exited { reason: reason.into(), restart_in }).await;
                    if let Resume::Shutdown = self.wait(Some(Instant::now() + restart_in)).await {
                        break;
                    }
                }
            }
        }
        drop(self.lock.take());
        for done in self.stopped.drain(..) {
            let _ = done.try_send(());
        }
        self.emit(BotEvent::Stopped).await;
    }

    async fn emit(&self, event: BotEvent) {
        // Nobody listening is not a reason to stop the bots.
        let _ = self.events.send(event).await;
    }

    /// Records what a command changes for later sidecars.
    fn remember(&mut self, command: &Command) {
        match command {
            Command::ApplySettings { settings } => self.settings = Some((**settings).clone()),
            Command::SetWorkspace { workspace } => self.workspace = Some(workspace.clone()),
            _ => {}
        }
    }

    /// Answers a command while no sidecar runs.
    fn answer_idle(&mut self, command: Command, reply: Reply) {
        let answer = match command {
            Command::ApplySettings { .. } | Command::SetWorkspace { .. } => {
                self.remember(&command);
                Ok(Value::Object(Default::default()))
            }
            _ => Err(BotCommandError::NotRunning),
        };
        let _ = reply.try_send(answer);
    }

    /// Waits until `until` (forever when `None`), answering requests.
    async fn wait(&mut self, until: Option<Instant>) -> Resume {
        loop {
            let timer = async {
                match until {
                    Some(deadline) => {
                        Timer::at(deadline).await;
                    }
                    None => future::pending::<()>().await,
                }
                None
            };
            let request = async { Some(self.requests.recv().await.ok()) };
            let woke = future::or(request, timer).await;
            match woke {
                None => return Resume::Start,
                Some(None) => return Resume::Shutdown,
                Some(Some(Request::Restart)) => return Resume::Start,
                Some(Some(Request::Shutdown { done })) => {
                    self.stopped.push(done);
                    return Resume::Shutdown;
                }
                Some(Some(Request::Command { command, reply })) => self.answer_idle(command, reply),
            }
        }
    }

    /// Runs one sidecar process until it exits or the caller intervenes.
    async fn run_sidecar(&mut self) -> Ended {
        let mut command = self.command.to_command();
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                return Ended::Fatal(format!(
                    "cannot start the bot sidecar with {}: {error}",
                    self.command.program().display()
                ));
            }
        };
        let (Some(stdin), Some(stdout), Some(stderr)) =
            (child.stdin.take(), child.stdout.take(), child.stderr.take())
        else {
            let _ = child.kill();
            return Ended::Fatal("the bot sidecar has no stdio pipes".to_owned());
        };
        let mut run = SidecarRun {
            child,
            stdin,
            stdout: LineReader::new(stdout),
            stderr: Some(LineReader::new(stderr)),
            next_id: 1,
            pending: HashMap::new(),
            fatal: None,
            ready: false,
        };
        let ended = self.serve(&mut run).await;
        run.fail_pending(BotCommandError::Interrupted);
        match ended {
            Served::Exited => {
                let status = run.child.status().await;
                match run.fatal.take() {
                    Some(fatal) => Ended::Fatal(fatal),
                    None => Ended::Exited(describe_exit(status)),
                }
            }
            Served::Kill(ended) => {
                let _ = run.child.kill();
                let _ = run.child.status().await;
                ended
            }
            Served::Shutdown => {
                let _ = run.child.status().await;
                Ended::Shutdown
            }
        }
    }

    async fn serve(&mut self, run: &mut SidecarRun) -> Served {
        let ready_by = Instant::now() + self.policy.ready_timeout;
        loop {
            let deadline = if run.ready { run.next_deadline() } else { Some(ready_by) };
            let woke = run.wake(&self.requests, deadline).await;
            match woke {
                Wake::Stdout(ReadLine::Eof) => return Served::Exited,
                Wake::Stdout(ReadLine::TooLong) => {
                    self.log(LogLevel::Warn, "dropped a sidecar line over 1 MiB".to_owned()).await;
                }
                Wake::Stdout(ReadLine::Line(line)) => {
                    if let Some(served) = self.handle_line(run, &line).await {
                        return served;
                    }
                }
                Wake::Stderr(ReadLine::Line(line)) => {
                    self.log(LogLevel::Warn, format!("stderr: {line}")).await;
                }
                Wake::Stderr(ReadLine::TooLong) => {}
                Wake::Stderr(ReadLine::Eof) => run.stderr = None,
                Wake::Request(None) => return self.shut_down(run).await,
                Wake::Request(Some(Request::Shutdown { done })) => {
                    self.stopped.push(done);
                    return self.shut_down(run).await;
                }
                Wake::Request(Some(Request::Restart)) => return Served::Kill(Ended::Restart),
                Wake::Request(Some(Request::Command { command, reply })) => {
                    if !run.ready {
                        self.answer_idle(command, reply);
                        continue;
                    }
                    self.remember(&command);
                    let deadline = Instant::now() + self.policy.command_timeout;
                    run.send(&command, Some(reply), deadline).await;
                }
                Wake::Deadline if !run.ready => {
                    return Served::Kill(Ended::Exited(format!(
                        "the bot sidecar did not report ready within {} s",
                        self.policy.ready_timeout.as_secs()
                    )));
                }
                Wake::Deadline => run.expire(Instant::now()),
            }
        }
    }

    /// Handles one stdout line; `Some` when it ends the run.
    async fn handle_line(&mut self, run: &mut SidecarRun, line: &str) -> Option<Served> {
        let decoded = match decode_line(line) {
            Ok(decoded) => decoded,
            Err(error) => {
                self.log(
                    LogLevel::Warn,
                    format!("dropped a sidecar line that is not the protocol: {error}"),
                )
                .await;
                return None;
            }
        };
        match decoded {
            SidecarLine::Answer(answer) => run.answer(answer),
            SidecarLine::Event(SidecarEvent::Ready { protocol, compatibility_epoch, pid }) => {
                if protocol != SIDECAR_PROTOCOL_VERSION {
                    return Some(Served::Kill(Ended::Fatal(format!(
                        "the bot sidecar speaks protocol {protocol}, this client {SIDECAR_PROTOCOL_VERSION}"
                    ))));
                }
                run.ready = true;
                // Replayed before any caller command, so those see the state
                // the caller last set.
                let deadline = Instant::now() + self.policy.command_timeout;
                if let Some(settings) = self.settings.clone() {
                    run.send(
                        &Command::ApplySettings { settings: Box::new(settings) },
                        None,
                        deadline,
                    )
                    .await;
                }
                if let Some(workspace) = self.workspace.clone() {
                    run.send(&Command::SetWorkspace { workspace }, None, deadline).await;
                }
                let pid = pid.unwrap_or_else(|| run.child.id());
                self.emit(BotEvent::Started { pid, compatibility_epoch }).await;
            }
            SidecarLine::Event(SidecarEvent::Fatal { code, message }) => {
                run.fatal = Some(format!("{message} ({code})"));
            }
            SidecarLine::Event(SidecarEvent::Status(status)) => {
                self.emit(BotEvent::Status(status)).await;
            }
            SidecarLine::Event(SidecarEvent::Host(state)) => self.emit(BotEvent::Host(state)).await,
            SidecarLine::Event(SidecarEvent::Log { level, message }) => {
                self.log(level, message).await
            }
            SidecarLine::Event(SidecarEvent::Unknown) => {}
        }
        None
    }

    async fn log(&self, level: LogLevel, message: String) {
        match level {
            LogLevel::Error => log::error!("bot sidecar: {message}"),
            LogLevel::Warn => log::warn!("bot sidecar: {message}"),
            LogLevel::Info | LogLevel::Unknown => log::info!("bot sidecar: {message}"),
        }
        self.emit(BotEvent::Log { level, message }).await;
    }

    /// Asks the sidecar to exit, and kills it after the grace period.
    async fn shut_down(&mut self, run: &mut SidecarRun) -> Served {
        if run.ready {
            run.send(&Command::Shutdown, None, Instant::now() + self.policy.shutdown_grace).await;
        }
        // Closing stdin tells a sidecar that is still starting, too.
        let _ = run.stdin.close().await;
        let grace = Instant::now() + self.policy.shutdown_grace;
        loop {
            let line = run.stdout.next_line();
            let timer = async {
                Timer::at(grace).await;
                None
            };
            let read = future::or(async { Some(line.await) }, timer).await;
            match read {
                Some(ReadLine::Eof) => return Served::Shutdown,
                Some(ReadLine::Line(line)) => {
                    // Status events while the bridges stop are still news.
                    let _ = self.handle_line(run, &line).await;
                }
                Some(ReadLine::TooLong) => {}
                None => return Served::Kill(Ended::Shutdown),
            }
        }
    }
}

/// How [`Supervisor::serve`] ended.
enum Served {
    /// stdout closed: the sidecar exited by itself.
    Exited,
    /// Kill the sidecar, then end the run this way.
    Kill(Ended),
    /// The sidecar exited after `shutdown`.
    Shutdown,
}

enum Wake {
    Stdout(ReadLine),
    Stderr(ReadLine),
    /// `None` when every handle is gone.
    Request(Option<Request>),
    Deadline,
}

struct Pending {
    reply: Option<Reply>,
    command: &'static str,
    deadline: Instant,
}

/// One running sidecar process.
struct SidecarRun {
    child: Child,
    stdin: ChildStdin,
    stdout: LineReader<async_process::ChildStdout>,
    /// `None` once it closed.
    stderr: Option<LineReader<async_process::ChildStderr>>,
    next_id: u64,
    pending: HashMap<u64, Pending>,
    /// The sidecar's `fatal` report, if it made one.
    fatal: Option<String>,
    ready: bool,
}

impl SidecarRun {
    async fn wake(
        &mut self,
        requests: &async_channel::Receiver<Request>,
        deadline: Option<Instant>,
    ) -> Wake {
        let Self { stdout, stderr, .. } = self;
        let stdout = async { Wake::Stdout(stdout.next_line().await) };
        let stderr = async {
            match stderr.as_mut() {
                Some(stderr) => Wake::Stderr(stderr.next_line().await),
                None => future::pending().await,
            }
        };
        let request = async { Wake::Request(requests.recv().await.ok()) };
        let timer = async {
            match deadline {
                Some(deadline) => {
                    Timer::at(deadline).await;
                    Wake::Deadline
                }
                None => future::pending().await,
            }
        };
        future::or(stdout, future::or(stderr, future::or(request, timer))).await
    }

    /// Writes `command`; its answer goes to `reply`, or is only checked when
    /// the supervisor sent it itself.
    async fn send(&mut self, command: &Command, reply: Option<Reply>, deadline: Instant) {
        let id = self.next_id;
        self.next_id += 1;
        let line = match encode_command(id, command) {
            Ok(line) => line,
            Err(error) => {
                if let Some(reply) = reply {
                    let _ = reply.try_send(Err(BotCommandError::InvalidAnswer(error.to_string())));
                }
                return;
            }
        };
        if self.stdin.write_all(&line).await.is_err() || self.stdin.flush().await.is_err() {
            // The sidecar is exiting; its stdout closes next.
            if let Some(reply) = reply {
                let _ = reply.try_send(Err(BotCommandError::Interrupted));
            }
            return;
        }
        self.pending.insert(id, Pending { reply, command: command.name(), deadline });
    }

    fn answer(&mut self, answer: crate::protocol::Answer) {
        let Some(pending) = self.pending.remove(&answer.id) else { return };
        let result = answer.result.map_err(BotCommandError::Refused);
        match pending.reply {
            Some(reply) => {
                let _ = reply.try_send(result);
            }
            None => {
                if let Err(error) = result {
                    log::warn!("bot sidecar refused {}: {error}", pending.command);
                }
            }
        }
    }

    fn next_deadline(&self) -> Option<Instant> {
        self.pending.values().map(|pending| pending.deadline).min()
    }

    fn expire(&mut self, now: Instant) {
        let expired: Vec<u64> = self
            .pending
            .iter()
            .filter(|(_, pending)| pending.deadline <= now)
            .map(|(id, _)| *id)
            .collect();
        for id in expired {
            if let Some(Pending { reply: Some(reply), .. }) = self.pending.remove(&id) {
                let _ = reply.try_send(Err(BotCommandError::TimedOut));
            }
        }
    }

    fn fail_pending(&mut self, error: BotCommandError) {
        for (_, pending) in self.pending.drain() {
            if let Some(reply) = pending.reply {
                let _ = reply.try_send(Err(error.clone()));
            }
        }
    }
}

fn describe_exit(status: io::Result<ExitStatus>) -> String {
    match status {
        Ok(status) => format!("the bot sidecar exited ({status})"),
        Err(error) => format!("the bot sidecar exited: {error}"),
    }
}

enum ReadLine {
    Line(String),
    /// A line over [`MAX_LINE_BYTES`], skipped.
    TooLong,
    Eof,
}

/// Reads lines, keeping a partial line across cancelled reads: the only await
/// is `fill_buf`, and everything it returned is copied out before the next.
struct LineReader<R> {
    reader: BufReader<R>,
    line: Vec<u8>,
    overflowed: bool,
}

impl<R: AsyncRead + Unpin> LineReader<R> {
    fn new(reader: R) -> Self {
        Self { reader: BufReader::new(reader), line: Vec::new(), overflowed: false }
    }

    async fn next_line(&mut self) -> ReadLine {
        loop {
            let available = match self.reader.fill_buf().await {
                Ok(available) => available,
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(_) => return ReadLine::Eof,
            };
            if available.is_empty() {
                return match std::mem::take(&mut self.line) {
                    line if !line.is_empty() && !self.overflowed => {
                        ReadLine::Line(String::from_utf8_lossy(&line).into_owned())
                    }
                    _ => ReadLine::Eof,
                };
            }
            let (chunk, complete) = match available.iter().position(|byte| *byte == b'\n') {
                Some(end) => (&available[..end], Some(end + 1)),
                None => (available, None),
            };
            if self.line.len() + chunk.len() > MAX_LINE_BYTES {
                self.overflowed = true;
                self.line.clear();
            } else if !self.overflowed {
                self.line.extend_from_slice(chunk);
            }
            let consumed = complete.unwrap_or(chunk.len());
            self.reader.consume(consumed);
            if complete.is_some() {
                let line = std::mem::take(&mut self.line);
                if std::mem::take(&mut self.overflowed) {
                    return ReadLine::TooLong;
                }
                let line = String::from_utf8_lossy(&line);
                let line = line.trim_end_matches('\r');
                if line.trim().is_empty() {
                    continue;
                }
                return ReadLine::Line(line.to_owned());
            }
        }
    }
}
