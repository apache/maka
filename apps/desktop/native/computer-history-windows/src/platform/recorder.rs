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

use super::{
    foreground,
    input_lease::{
        CompletionReason, LeaseFrame, observation_only, observation_source,
        same_observation_source, valid_completion,
    },
    interactive_desktop, ownership, require_consent, same_control, write_json,
};
use crate::{
    control::{Control, Result, State},
    input::{InputError, InputMode, InputObserver, InputScope},
    input_actions::{Actions, same_input_source},
    model::{Policy, Snapshot, read_regular},
    recorder_lifecycle::{
        CAPTURE_LIMIT, CaptureFence, CaptureHealth, CaptureOutcome, CaptureSchedule, EventEpochs,
        InputLeaseState as LeaseState, LeaseDisposition, LeaseEnd, LeaseRevision, LiveState,
        RECORDER_POLL, SOURCE_FRESHNESS, drain_events, finish_recording,
    },
    store::Store,
};
use chrono::Utc;
use serde_json::json;
use std::{
    io::{BufRead, BufReader, Read, Write},
    os::windows::process::CommandExt,
    path::Path,
    process::{Child, Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering},
        mpsc::{self, Receiver},
    },
    time::{Duration, Instant},
};
use windows::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, WPARAM},
    System::{
        LibraryLoader::GetModuleHandleW,
        RemoteDesktop::{
            NOTIFY_FOR_THIS_SESSION, WTSRegisterSessionNotification,
            WTSUnRegisterSessionNotification,
        },
    },
    UI::{
        Accessibility::{HWINEVENTHOOK, SetWinEventHook, UnhookWinEvent},
        WindowsAndMessaging::{
            CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, EVENT_OBJECT_DESTROY,
            EVENT_OBJECT_FOCUS, EVENT_OBJECT_NAMECHANGE, EVENT_OBJECT_REORDER,
            EVENT_OBJECT_SELECTION, EVENT_OBJECT_SELECTIONWITHIN,
            EVENT_OBJECT_TEXTSELECTIONCHANGED, EVENT_OBJECT_VALUECHANGE, EVENT_SYSTEM_FOREGROUND,
            GA_ROOT, GUITHREADINFO, GetAncestor, GetGUIThreadInfo, GetWindowThreadProcessId,
            HWND_MESSAGE, MSG, PM_REMOVE, PeekMessageW, RegisterClassW, TranslateMessage,
            WINDOW_EX_STYLE, WINDOW_STYLE, WINEVENT_OUTOFCONTEXT, WINEVENT_SKIPOWNPROCESS,
            WM_WTSSESSION_CHANGE, WNDCLASSW, WTS_CONSOLE_DISCONNECT, WTS_REMOTE_DISCONNECT,
            WTS_SESSION_LOCK, WTS_SESSION_LOGOFF,
        },
    },
};
use windows::core::w;

static EPOCHS: EventEpochs = EventEpochs::new();
static DIRTY_KIND: AtomicU32 = AtomicU32::new(EVENT_SYSTEM_FOREGROUND);
static SESSION_SUSPENDED: AtomicBool = AtomicBool::new(false);
static INPUT_EPOCH: AtomicU64 = AtomicU64::new(0);
static INPUT_WINDOW: AtomicUsize = AtomicUsize::new(0);
static INPUT_TARGET: AtomicUsize = AtomicUsize::new(0);
const MAX_SNAPSHOT_BYTES: u64 = 128 * 1024;
// IAccessible2 AccessibleEventID: document content/load and text insert/remove/update.
const IA2_DOCUMENT_CONTENT_CHANGED: u32 = 0x104;
const IA2_DOCUMENT_LOAD_COMPLETE: u32 = 0x105;
const IA2_TEXT_INSERTED: u32 = 0x11e;
const IA2_TEXT_UPDATED: u32 = 0x120;

unsafe extern "system" fn on_event(
    _hook: HWINEVENTHOOK,
    event: u32,
    hwnd: HWND,
    object: i32,
    child: i32,
    _thread: u32,
    _time: u32,
) {
    if event == EVENT_SYSTEM_FOREGROUND {
        INPUT_EPOCH.fetch_add(1, Ordering::SeqCst);
        EPOCHS.window_changed();
        DIRTY_KIND.store(event, Ordering::Relaxed);
    } else if event == EVENT_OBJECT_DESTROY && object == 0 && child == 0 {
        if hwnd.0 as usize == INPUT_WINDOW.load(Ordering::SeqCst)
            || hwnd.0 as usize == INPUT_TARGET.load(Ordering::SeqCst)
        {
            INPUT_EPOCH.fetch_add(1, Ordering::SeqCst);
        }
        // OBJID_WINDOW / CHILDID_SELF. Use the retained source HWND, not a
        // live ancestry lookup on a destroyed (possibly reused) handle.
        EPOCHS.window_destroyed(hwnd.0 as usize);
    } else if let Some((current, _)) = foreground()
        && unsafe { GetAncestor(hwnd, GA_ROOT) }.0 as usize == current
    {
        if crate::recorder_lifecycle::input_identity_changed(
            event,
            object,
            child,
            hwnd.0 as usize == INPUT_TARGET.load(Ordering::SeqCst),
        ) {
            INPUT_EPOCH.fetch_add(1, Ordering::SeqCst);
        }
        // Same-window document/value/focus ABA invalidates a capture without
        // assigning a new identity to every edit in the window.
        EPOCHS.content_changed();
        DIRTY_KIND.store(event, Ordering::Relaxed);
    }
}

struct Hooks(Vec<HWINEVENTHOOK>);

struct SessionNotifications(HWND);

unsafe extern "system" fn session_message(
    window: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if message == WM_WTSSESSION_CHANGE {
        INPUT_EPOCH.fetch_add(1, Ordering::SeqCst);
        // Sent messages can run inside PeekMessage without appearing in its MSG.
        // Invalidate even a disconnect/reconnect that completes between polls.
        EPOCHS.window_changed();
        DIRTY_KIND.store(EVENT_SYSTEM_FOREGROUND, Ordering::Relaxed);
        if matches!(
            wparam.0 as u32,
            WTS_CONSOLE_DISCONNECT | WTS_REMOTE_DISCONNECT | WTS_SESSION_LOCK | WTS_SESSION_LOGOFF
        ) {
            SESSION_SUSPENDED.store(true, Ordering::SeqCst);
        }
    }
    unsafe { DefWindowProcW(window, message, wparam, lparam) }
}

impl SessionNotifications {
    fn new() -> Result<Self> {
        let window = unsafe {
            let instance = GetModuleHandleW(None)?.into();
            let class = WNDCLASSW {
                lpfnWndProc: Some(session_message),
                hInstance: instance,
                lpszClassName: w!("MakaHistorySessionNotifications"),
                ..Default::default()
            };
            if RegisterClassW(&class) == 0 {
                return Err(windows::core::Error::from_thread().into());
            }
            CreateWindowExW(
                WINDOW_EX_STYLE(0),
                class.lpszClassName,
                w!(""),
                WINDOW_STYLE(0),
                0,
                0,
                0,
                0,
                Some(HWND_MESSAGE),
                None,
                Some(instance),
                None,
            )?
        };
        let value = Self(window);
        unsafe { WTSRegisterSessionNotification(window, NOTIFY_FOR_THIS_SESSION)? };
        Ok(value)
    }
}

impl Drop for SessionNotifications {
    fn drop(&mut self) {
        unsafe {
            let _ = WTSUnRegisterSessionNotification(self.0);
            let _ = DestroyWindow(self.0);
        }
    }
}

impl Hooks {
    fn install() -> Result<Self> {
        let mut hooks = Self(Vec::new());
        for (first, last) in [
            (EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND),
            (EVENT_OBJECT_DESTROY, EVENT_OBJECT_DESTROY),
            (EVENT_OBJECT_FOCUS, EVENT_OBJECT_SELECTIONWITHIN),
            (EVENT_OBJECT_NAMECHANGE, EVENT_OBJECT_VALUECHANGE),
            (EVENT_OBJECT_REORDER, EVENT_OBJECT_REORDER),
            (
                EVENT_OBJECT_TEXTSELECTIONCHANGED,
                EVENT_OBJECT_TEXTSELECTIONCHANGED,
            ),
            (IA2_DOCUMENT_CONTENT_CHANGED, IA2_DOCUMENT_LOAD_COMPLETE),
            (IA2_TEXT_INSERTED, IA2_TEXT_UPDATED),
        ] {
            let hook = unsafe {
                SetWinEventHook(
                    first,
                    last,
                    None,
                    Some(on_event),
                    0,
                    0,
                    WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
                )
            };
            if hook.is_invalid() {
                return Err("window_event_subscription_failed".into());
            }
            hooks.0.push(hook);
        }
        Ok(hooks)
    }
}

impl Drop for Hooks {
    fn drop(&mut self) {
        for hook in &self.0 {
            unsafe {
                let _ = UnhookWinEvent(*hook);
            }
        }
    }
}

fn dispatch_events() -> bool {
    let mut message = MSG::default();
    drain_events(
        || unsafe {
            if !PeekMessageW(&mut message, None, 0, 0, PM_REMOVE).as_bool() {
                return false;
            }
            let _ = TranslateMessage(&message);
            DispatchMessageW(&message);
            true
        },
        256,
    )
}

fn admit(
    home: &Path,
    control: &Control,
    fence: CaptureFence,
    parent: &ownership::Parent,
    stopping: &AtomicBool,
) -> Result<bool> {
    fence.after_preparation(
        || {
            require_consent(home)?;
            Ok(same_control(control, &Control::load(home)?))
        },
        || {
            let desktop_available = interactive_desktop();
            let queue_drained = dispatch_events();
            LiveState {
                queue_drained,
                desktop_available,
                foreground: foreground(),
                epochs: EPOCHS.current(),
                parent_alive: parent.alive(),
                stopping: stopping.load(Ordering::SeqCst),
            }
        },
    )
}

fn publish_health(home: &Path, health: &mut CaptureHealth, state: &'static str) -> Result<()> {
    let now = Instant::now();
    if health.due(state, now) {
        write_json(
            &home.join("runtime.json"),
            &json!({
                "state": state, "processIdentifier": std::process::id(),
                "updatedAt": Utc::now(), "captureFailures": health.failures,
            }),
        )?;
        health.published(state, now);
    }
    Ok(())
}

struct InputSource {
    snapshot: Snapshot,
    capture_text: bool,
    epoch: u64,
    window_epoch: u64,
    captured_at: Instant,
    lease: Option<(Arc<LeaseState>, u64)>,
}

impl InputSource {
    fn retry_after_content_change(
        &self,
        home: &Path,
        control: &Control,
        cancelled: CaptureFence,
        parent: &ownership::Parent,
        stopping: &AtomicBool,
        schedule: &mut CaptureSchedule,
    ) -> Result<bool> {
        let epochs = EPOCHS.current();
        if cancelled.target != (self.snapshot.window_id as usize, self.snapshot.pid)
            || cancelled.epochs.window != epochs.window
            || cancelled.epochs.content == epochs.content
        {
            return Ok(false);
        }
        let policy = Policy::load(home)?;
        if policy.capture_text != self.capture_text
            || policy
                .project(&self.snapshot, "ui.changed", 1, Utc::now())
                .is_none()
        {
            return Ok(false);
        }
        // This admits retaining the original bounded-age action, never the
        // cancelled worker's body. A later worker must still verify and write.
        let retained = admit(
            home,
            control,
            CaptureFence {
                epochs,
                ..cancelled
            },
            parent,
            stopping,
        )? && self.scope().is_some();
        if retained {
            schedule.retry_input_before(self.captured_at, self.captured_at + SOURCE_FRESHNESS);
        }
        Ok(retained)
    }

    fn scope(&self) -> Option<InputScope> {
        let input_target = self.snapshot.input_target.as_ref()?;
        let focus = input_target.hwnd as usize;
        let uia_lease_epoch = if input_target.uia.is_some() {
            let (state, identity) = self.lease.as_ref()?;
            if !state.admits(*identity) {
                return None;
            }
            Some(*identity)
        } else {
            None
        };
        let target = (self.snapshot.window_id as usize, self.snapshot.pid);
        if INPUT_EPOCH.load(Ordering::SeqCst) != self.epoch
            || EPOCHS.current().window != self.window_epoch
            || foreground() != Some(target)
            || self.captured_at.elapsed() >= SOURCE_FRESHNESS
        {
            return None;
        }
        let thread = unsafe { GetWindowThreadProcessId(HWND(target.0 as *mut _), None) };
        let mut info = GUITHREADINFO {
            cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
            ..Default::default()
        };
        unsafe { GetGUIThreadInfo(thread, &mut info) }.ok()?;
        if info.hwndFocus.0 as usize != focus {
            return None;
        }
        Some(InputScope {
            hwnd: target.0,
            pid: target.1,
            epoch: self.epoch,
            focus_hwnd: focus,
            mode: if input_target.uia.is_some() {
                InputMode::ObservedUia
            } else {
                InputMode::NativeChild
            },
            uia_lease_epoch,
        })
    }
}

fn revoke_input(
    observer: &Option<InputObserver>,
    source: &mut Option<InputSource>,
    actions: &mut Actions,
) -> Result<()> {
    *source = None;
    actions.clear();
    INPUT_WINDOW.store(0, Ordering::SeqCst);
    INPUT_TARGET.store(0, Ordering::SeqCst);
    if let Some(observer) = observer {
        observer.set_scope(None)?;
    }
    Ok(())
}

fn stop_input(observer: &mut Option<InputObserver>) -> std::result::Result<(), InputError> {
    if let Some(observer) = observer.take() {
        observer.stop()?;
    }
    Ok(())
}

fn start_capture<T>(
    input: &Option<InputObserver>,
    source: &mut Option<InputSource>,
    actions: &mut Actions,
    start: impl FnOnce() -> Result<Option<T>>,
    preserve: impl FnOnce(&InputSource) -> Result<bool>,
) -> Result<Option<T>> {
    let job = start()?;
    if job.is_none() && !source.as_ref().map(preserve).transpose()?.unwrap_or(false) {
        revoke_input(input, source, actions)?;
    }
    Ok(job)
}

fn retain_completed_input(
    observer: &Option<InputObserver>,
    source: &mut Option<InputSource>,
    actions: &mut Actions,
    success: bool,
    snapshot: Option<&Snapshot>,
    preserve: impl FnOnce(&InputSource) -> Result<bool>,
) -> Result<bool> {
    let retain = match (source.as_ref(), snapshot) {
        (Some(original), Some(snapshot))
            if success && same_input_source(&original.snapshot, snapshot) =>
        {
            preserve(original)?
        }
        _ => false,
    };
    if !retain {
        revoke_input(observer, source, actions)?;
    }
    Ok(retain)
}

struct Pending {
    child: Child,
    output: Receiver<WorkerFrame>,
    started: Instant,
    fence: CaptureFence,
    source: String,
    control: Control,
    config: Vec<u8>,
    kind: &'static str,
    capture_text: bool,
    lease: Option<Arc<LeaseState>>,
    request: u64,
    frame_epochs: Option<(u64, u64)>,
    lease_seen: LeaseRevision,
    frame_changes: Option<LeaseRevision>,
    terminal: Option<(CompletionReason, Option<Snapshot>)>,
    observation: Option<Snapshot>,
}

struct WorkerFrame {
    bytes: Vec<u8>,
    changes: Option<LeaseRevision>,
}

// One current capture owns this value; boxing adds a per-capture allocation
// solely to reduce an already bounded stack value.
#[allow(clippy::large_enum_variant)]
enum Collected {
    Completed(bool, Option<Option<Snapshot>>),
    Invalidated,
}

fn read_lease_output(
    mut reader: impl BufRead,
    state: &LeaseState,
    mut publish: impl FnMut(WorkerFrame) -> bool,
) {
    let mut framed = false;
    let ended = loop {
        let mut bytes = Vec::new();
        let read = Read::by_ref(&mut reader)
            .take(MAX_SNAPSHOT_BYTES + 1)
            .read_until(b'\n', &mut bytes);
        match read {
            Ok(0) => break LeaseEnd::Eof,
            Err(_) => break LeaseEnd::Failed,
            _ => {}
        }
        if bytes.len() as u64 > MAX_SNAPSHOT_BYTES || bytes.last() != Some(&b'\n') {
            break LeaseEnd::InvalidOutput;
        }
        let Ok(frame) = serde_json::from_slice::<LeaseFrame>(&bytes) else {
            break LeaseEnd::InvalidOutput;
        };
        if let LeaseFrame::Completed {
            request,
            reason,
            snapshot,
        } = &frame
        {
            if framed || *request != 0 || !valid_completion(*reason, snapshot.as_ref()) {
                break LeaseEnd::InvalidOutput;
            }
            // A terminal frame is not a live lease. Require clean EOF before
            // exposing it; the owner still verifies exit and external authority.
            match reader.read(&mut [0u8; 1]) {
                Ok(0) => {}
                Ok(_) => break LeaseEnd::InvalidOutput,
                Err(_) => break LeaseEnd::Failed,
            }
            if !publish(WorkerFrame {
                bytes,
                changes: None,
            }) {
                break LeaseEnd::Failed;
            }
            state.end(LeaseEnd::Completed);
            return;
        }
        framed = true;
        let (identity, content, revoked) = match &frame {
            LeaseFrame::Snapshot {
                identity, content, ..
            } => (*identity, *content, false),
            LeaseFrame::Invalidated {
                identity,
                content,
                revoked,
            } => (*identity, *content, *revoked),
            LeaseFrame::Completed { .. } => unreachable!(),
        };
        if !state.observe(
            LeaseRevision { identity, content },
            matches!(frame, LeaseFrame::Invalidated { .. }),
            revoked,
        ) {
            break LeaseEnd::InvalidOutput;
        }
        let Some(changes) = state.observed_changes() else {
            break LeaseEnd::Failed;
        };
        if !publish(WorkerFrame {
            bytes,
            changes: Some(changes),
        }) {
            break LeaseEnd::Failed;
        }
    };
    state.end(ended);
}

impl Pending {
    fn start(
        home: &Path,
        fence: CaptureFence,
        source: &str,
        control: &Control,
        parent: &ownership::Parent,
        stopping: &AtomicBool,
    ) -> Result<Option<Self>> {
        let target = fence.target;
        let mut command = Command::new(std::env::current_exe()?);
        command
            .args([
                "snapshot-lease",
                "--parent-pid",
                &std::process::id().to_string(),
                "--window",
                &target.0.to_string(),
                "--pid",
                &target.1.to_string(),
                "--source",
                source,
            ])
            .env("OPEN_COMPUTER_HISTORY_HOME", home)
            .creation_flags(0x08000000) // CREATE_NO_WINDOW, never a console flash.
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let capture_text = Policy::load(home)?.capture_text;
        let config = read_regular(&home.join("config.json"), 256 * 1024)?;
        let prepared_control = Control::load(home)?;
        if !same_control(control, &prepared_control) {
            return Ok(None);
        }
        // Command construction and policy reads can block; admission belongs
        // immediately beside spawn, retaining the pre-preparation epochs.
        if !admit(home, &prepared_control, fence, parent, stopping)? {
            return Ok(None);
        }
        let started = Instant::now();
        let mut child = command.spawn()?;
        let stdout = child.stdout.take().ok_or("snapshot_pipe_unavailable")?;
        let (send, output) = mpsc::sync_channel(8);
        let state = Arc::new(LeaseState::new(started));
        let reader_state = state.clone();
        std::thread::spawn(move || {
            read_lease_output(BufReader::new(stdout), &reader_state, |bytes| {
                send.try_send(bytes).is_ok()
            });
        });
        Ok(Some(Self {
            child,
            output,
            started,
            fence,
            source: source.to_owned(),
            control: prepared_control,
            config,
            kind: "ui.changed",
            capture_text,
            lease: Some(state),
            request: 0,
            frame_epochs: None,
            lease_seen: LeaseRevision::default(),
            frame_changes: None,
            terminal: None,
            observation: None,
        }))
    }

    fn synchronize_lease(&mut self) {
        if self
            .lease
            .as_ref()
            .is_some_and(|state| state.synchronize(&mut self.lease_seen, &INPUT_EPOCH, &EPOCHS))
        {
            DIRTY_KIND.store(EVENT_OBJECT_VALUECHANGE, Ordering::SeqCst);
        }
    }

    fn request(&mut self, fence: CaptureFence, kind: &'static str) -> Result<()> {
        let state = self.lease.as_ref().ok_or("missing_input_lease")?;
        if state.current().is_none() {
            return Err("input_lease_expired".into());
        }
        self.request = self
            .request
            .checked_add(1)
            .ok_or("input_lease_request_overflow")?;
        self.started = Instant::now();
        self.fence = fence;
        self.kind = kind;
        self.frame_epochs = None;
        self.frame_changes = None;
        let written = self
            .child
            .stdin
            .as_mut()
            .ok_or_else(|| std::io::Error::other("input_lease_stdin_closed"))
            .and_then(|stdin| {
                stdin.write_all(format!("{{\"request\":{}}}\n", self.request).as_bytes())
            });
        if let Err(error) = written {
            state.end(LeaseEnd::Failed);
            return Err(error.into());
        }
        Ok(())
    }

    fn collect(&mut self) -> Result<Option<Collected>> {
        self.synchronize_lease();
        if self.terminal.is_some() {
            return self.collect_terminal();
        }
        if self.lease.is_some() {
            for _ in 0..8 {
                match self.output.try_recv() {
                    Ok(output) => {
                        let frame = serde_json::from_slice::<LeaseFrame>(&output.bytes)?;
                        match frame {
                            LeaseFrame::Completed {
                                request: 0,
                                reason,
                                snapshot,
                            } if self.request == 0 => {
                                self.terminal = Some((reason, snapshot));
                                return self.collect_terminal();
                            }
                            LeaseFrame::Snapshot {
                                request,
                                identity,
                                content,
                                snapshot,
                            } if request == self.request => {
                                self.frame_epochs = Some((identity, content));
                                self.frame_changes = output.changes;
                                return Ok(Some(Collected::Completed(true, Some(snapshot))));
                            }
                            LeaseFrame::Invalidated { .. } => {
                                // A queued notice already synchronized before this
                                // request must not cancel the fresh request again.
                                if self.fence.epochs != EPOCHS.current() {
                                    return Ok(Some(Collected::Invalidated));
                                }
                            }
                            _ => {}
                        }
                    }
                    Err(mpsc::TryRecvError::Disconnected) => {
                        self.lease.as_ref().unwrap().end(LeaseEnd::Eof);
                        return Ok(Some(Collected::Completed(false, None)));
                    }
                    Err(mpsc::TryRecvError::Empty) => break,
                }
            }
            // Exit can precede the reader publishing its final frame. The
            // bounded reader/disconnect path owns output completion.
            Ok(None)
        } else {
            Ok(None)
        }
    }

    fn collect_terminal(&mut self) -> Result<Option<Collected>> {
        let Some(status) = self.child.try_wait()? else {
            return Ok(None);
        };
        if !status.success() || self.started.elapsed() >= CAPTURE_LIMIT {
            return Ok(Some(Collected::Completed(false, None)));
        }
        let Some((_, snapshot)) = &mut self.terminal else {
            return Ok(None);
        };
        // The reader admitted only one terminal frame followed by clean EOF.
        // Dropping lease authority here cannot authorize external UIA input.
        self.lease = None;
        Ok(Some(Collected::Completed(true, Some(snapshot.take()))))
    }

    fn subscription_failed(&self) -> bool {
        matches!(
            self.terminal,
            Some((CompletionReason::SubscriptionFailure, _))
        )
    }

    fn lease_current(&self) -> bool {
        match (&self.lease, self.frame_epochs) {
            (None, _) => true,
            (Some(state), Some((identity, content))) => self.frame_changes.is_some_and(|changes| {
                state.frame_current(LeaseRevision { identity, content }, changes)
            }),
            _ => false,
        }
    }

    fn admitted(
        &self,
        home: &Path,
        parent: &ownership::Parent,
        stopping: &AtomicBool,
    ) -> Result<bool> {
        Ok(self.lease_current()
            && self.started.elapsed() < CAPTURE_LIMIT
            && Policy::load(home)?.capture_text == self.capture_text
            && read_regular(&home.join("config.json"), 256 * 1024)? == self.config
            && admit(home, &self.control, self.fence, parent, stopping)?
            && self.lease_current()
            && self.started.elapsed() < CAPTURE_LIMIT)
    }

    fn accept_input(
        &self,
        original: Option<&InputSource>,
        snapshot: &Snapshot,
        final_admission: impl FnOnce() -> Result<bool>,
    ) -> Result<bool> {
        if self.subscription_failed()
            || snapshot.window_id != self.fence.target.0 as u64
            || snapshot.pid != self.fence.target.1
            || snapshot.source_id != self.source
            || !same_input_source(snapshot, snapshot)
        {
            return Ok(false);
        }
        if let Some(state) = &self.lease
            && state.verified_at().is_some()
            && original.is_none_or(|original| {
                original.capture_text != self.capture_text
                    || !same_input_source(&original.snapshot, snapshot)
                    || original.lease.as_ref().is_none_or(|(owner, identity)| {
                        !Arc::ptr_eq(owner, state) || !state.admits(*identity)
                    })
                    || original.captured_at.elapsed() >= SOURCE_FRESHNESS
            })
        {
            return Ok(false);
        }
        if !final_admission()? {
            return Ok(false);
        }
        Ok(match &self.lease {
            None => self.started.elapsed() < CAPTURE_LIMIT,
            Some(state) => self.frame_epochs.zip(self.frame_changes).is_some_and(
                |((identity, content), seen)| {
                    state.accept_verified(
                        self.request,
                        self.started,
                        LeaseRevision { identity, content },
                        seen,
                        Instant::now,
                    )
                },
            ),
        })
    }

    fn accept_observation(
        &mut self,
        snapshot: &Snapshot,
        final_admission: impl FnOnce(&Self) -> Result<bool>,
    ) -> Result<bool> {
        if !observation_only(snapshot)
            || self
                .observation
                .as_ref()
                .is_some_and(|old| !same_observation_source(old, snapshot))
            || snapshot.window_id != self.fence.target.0 as u64
            || snapshot.pid != self.fence.target.1
            || snapshot.source_id != self.source
        {
            return Ok(false);
        }
        if !final_admission(self)? {
            return Ok(false);
        }
        let accepted = self
            .lease
            .as_ref()
            .zip(self.frame_epochs.zip(self.frame_changes))
            .is_some_and(|(state, ((identity, content), seen))| {
                state.accept_observed(
                    self.request,
                    self.started,
                    LeaseRevision { identity, content },
                    seen,
                    Instant::now,
                )
            });
        if accepted {
            self.observation = Some(observation_source(snapshot));
        }
        Ok(accepted)
    }

    fn into_idle(
        mut self,
        retained: Option<&InputSource>,
        outcome: CaptureOutcome,
        classify_terminal: impl FnOnce(&mut Self) -> Result<CaptureOutcome>,
    ) -> Result<(Option<Self>, CaptureOutcome)> {
        let disposition = self
            .lease
            .as_ref()
            .map_or(LeaseDisposition::Retire, |state| {
                state.retain_completed(
                    self.frame_epochs
                        .zip(self.frame_changes)
                        .map(|((identity, content), seen)| {
                            (LeaseRevision { identity, content }, seen)
                        }),
                    retained
                        .and_then(|source| source.lease.as_ref())
                        .filter(|(owner, _)| Arc::ptr_eq(owner, state))
                        .map(|(_, identity)| *identity),
                )
            });
        match disposition {
            LeaseDisposition::Keep => Ok((Some(self), outcome)),
            LeaseDisposition::Retire => Ok((None, outcome)),
            LeaseDisposition::Terminal => {
                let outcome = classify_terminal(&mut self)?;
                Ok((None, outcome))
            }
        }
    }

    fn failure_outcome(
        &mut self,
        home: &Path,
        parent: &ownership::Parent,
        stopping: &AtomicBool,
    ) -> Result<CaptureOutcome> {
        // EOF revokes input locally; only real source notifications are
        // synchronized into the authority fence used for health classification.
        self.synchronize_lease();
        let current = Policy::load(home)?.capture_text == self.capture_text
            && read_regular(&home.join("config.json"), 256 * 1024)? == self.config
            && admit(home, &self.control, self.fence, parent, stopping)?;
        Ok(self.lease.as_ref().map_or(
            if current {
                CaptureOutcome::Failed
            } else {
                CaptureOutcome::Suppressed
            },
            |state| state.failure_outcome(current, self.lease_seen, Instant::now()),
        ))
    }

    fn retry_invalidated_lease(
        &mut self,
        home: &Path,
        parent: &ownership::Parent,
        stopping: &AtomicBool,
    ) -> Result<bool> {
        let Some(state) = self.lease.clone() else {
            return Ok(false);
        };
        let epochs = EPOCHS.current();
        let fence = CaptureFence {
            epochs,
            ..self.fence
        };
        // One prompt retry inside the accepted source's existing lifetime.
        // Retrying changes no source/fact timestamps and cannot revive admission.
        let admitted = Policy::load(home)?.capture_text == self.capture_text
            && admit(home, &self.control, fence, parent, stopping)?;
        let retried = state.retry_cancelled(
            self.fence,
            fence,
            || Ok(admitted),
            || self.request(fence, "ui.changed"),
        );
        match retried {
            Err(_) if state.ended() => Ok(false),
            outcome => outcome,
        }
    }
}

impl Drop for Pending {
    fn drop(&mut self) {
        // Includes timeout, pause, source transition, parse failure and parent exit.
        if let Some(state) = &self.lease {
            state.close();
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub(super) fn record(home: &Path, parent: ownership::Parent) -> Result<()> {
    let _ownership = ownership::acquire(home)?;
    require_consent(home)?;
    let mut capture_text = Policy::load(home)?.capture_text;
    let mut control = Control::load(home)?;
    if !parent.alive() {
        return Err("parent_exited".into());
    }
    let stopping = Arc::new(AtomicBool::new(false));
    let stop = stopping.clone();
    // Desktop ends the pipe for graceful shutdown. EOF also fences an owner crash.
    std::thread::spawn(move || {
        let mut byte = [0u8; 1];
        let _ = std::io::stdin().read(&mut byte);
        stop.store(true, Ordering::SeqCst);
    });
    let mut store = Store::new(home, Utc::now())?;
    let _session_notifications = SessionNotifications::new()?;
    let mut suspended = false;
    let mut segment_started = Instant::now();
    let mut hooks = None;
    let mut input: Option<InputObserver> = None;
    let mut input_source: Option<InputSource> = None;
    let mut actions = Actions::default();
    let mut pending: Option<Pending> = None;
    let mut idle_lease: Option<Pending> = None;
    let mut source: Option<((usize, u32), u64, String)> = None;
    let mut last_retained = None;
    let mut schedule = CaptureSchedule::default();
    let mut last_flush = Instant::now();
    let mut health = CaptureHealth::default();
    let outcome = (|| -> Result<()> {
        loop {
            let queue_drained = dispatch_events();
            if !parent.alive() || stopping.load(Ordering::SeqCst) {
                break;
            }
            require_consent(home)?;
            let input_policy = Policy::load(home)?;
            if input_policy.capture_text != capture_text {
                capture_text = input_policy.capture_text;
                INPUT_EPOCH.fetch_add(1, Ordering::SeqCst);
                revoke_input(&input, &mut input_source, &mut actions)?;
                pending = None;
                idle_lease = None;
                last_retained = None;
                EPOCHS.content_changed();
            }
            let next = Control::load(home)?;
            if next.state == State::Stopped {
                break;
            }
            let paused = next.paused(Utc::now());
            let available = interactive_desktop();
            let suspend = paused || !available || SESSION_SUSPENDED.swap(false, Ordering::SeqCst);
            if !same_control(&control, &next) || suspend {
                INPUT_EPOCH.fetch_add(1, Ordering::SeqCst);
                revoke_input(&input, &mut input_source, &mut actions)?;
                pending = None;
                idle_lease = None;
                source = None;
                last_retained = None;
                health.observe(CaptureOutcome::Suppressed);
            }
            control = next;
            let state = if suspend { "paused" } else { "running" };
            if suspend {
                hooks = None;
                stop_input(&mut input)?;
                if !suspended {
                    store.finish(Utc::now())?;
                    suspended = true;
                }
                publish_health(home, &mut health, state)?;
                std::thread::sleep(RECORDER_POLL);
                continue;
            }
            if suspended {
                store = Store::new(home, Utc::now())?;
                segment_started = Instant::now();
                last_flush = Instant::now();
                suspended = false;
            }
            publish_health(home, &mut health, state)?;
            if hooks.is_none() {
                hooks = Some(Hooks::install()?);
                DIRTY_KIND.store(EVENT_SYSTEM_FOREGROUND, Ordering::Relaxed);
            }
            if let Some(lease) = pending.as_mut().or(idle_lease.as_mut()) {
                lease.synchronize_lease();
            }
            {
                if idle_lease.as_ref().is_some_and(|lease| {
                    lease
                        .lease
                        .as_ref()
                        .is_none_or(|state| state.current().is_none())
                }) {
                    if let Some(job) = idle_lease.as_mut() {
                        health.observe(job.failure_outcome(home, &parent, &stopping)?);
                    }
                    idle_lease = None;
                    INPUT_EPOCH.fetch_add(1, Ordering::SeqCst);
                    revoke_input(&input, &mut input_source, &mut actions)?;
                }
                if input.is_none() {
                    input = InputObserver::start(true)?;
                }
                let scope = input_source.as_ref().and_then(|source| {
                    input_policy.project(&source.snapshot, "ui.changed", 1, Utc::now())?;
                    source.scope()
                });
                if let Some(input) = &input {
                    if let Some(scope) = scope {
                        // Drain before renewal: a missed admission lease
                        // must not revive input received while blocked.
                        actions.ingest(input.drain(scope)?, scope, Instant::now());
                        input.set_scope(Some(scope))?;
                    } else {
                        input.set_scope(None)?;
                        input_source = None;
                        actions.clear();
                    }
                }
            }
            let target = foreground();
            let epochs = EPOCHS.current();
            if source
                .as_ref()
                .is_some_and(|(old, version, _)| Some(*old) != target || *version != epochs.window)
            {
                source = None;
                idle_lease = None;
                last_retained = None;
                revoke_input(&input, &mut input_source, &mut actions)?;
                health.observe(CaptureOutcome::Suppressed);
            }
            let mut stale = pending
                .as_ref()
                .is_some_and(|job| Some(job.fence.target) != target || job.fence.epochs != epochs);
            let timed_out = pending
                .as_ref()
                .is_some_and(|job| job.started.elapsed() >= CAPTURE_LIMIT);
            if stale
                && !timed_out
                && queue_drained
                && let Some(job) = pending.as_mut()
                && job.retry_invalidated_lease(home, &parent, &stopping)?
            {
                stale = false;
            }
            if stale || timed_out {
                let content_only = stale
                    && !timed_out
                    && match (&input_source, &pending) {
                        (Some(source), Some(job)) => source.retry_after_content_change(
                            home,
                            &job.control,
                            job.fence,
                            &parent,
                            &stopping,
                            &mut schedule,
                        )?,
                        _ => false,
                    };
                if !content_only {
                    revoke_input(&input, &mut input_source, &mut actions)?;
                }
                // Health publication and control reads may have blocked since
                // the first pump. Cancellation takes precedence over timeout.
                let outcome = if let Some(job) =
                    pending.as_mut().filter(|_| !content_only && queue_drained)
                {
                    job.failure_outcome(home, &parent, &stopping)?
                } else {
                    CaptureOutcome::Suppressed
                };
                if outcome == CaptureOutcome::Failed {
                    schedule.completed(EPOCHS.current());
                }
                if content_only && pending.as_ref().is_some_and(|job| job.lease.is_some()) {
                    idle_lease = pending.take();
                } else {
                    pending = None;
                }
                last_retained = None;
                health.observe(outcome);
            }
            // A full queue budget does not establish the source's current epoch.
            let completed = if queue_drained {
                if let Some(job) = pending.as_mut() {
                    match job.collect()? {
                        Some(Collected::Completed(success, snapshot)) => Some((success, snapshot)),
                        Some(Collected::Invalidated) => {
                            if !job.retry_invalidated_lease(home, &parent, &stopping)? {
                                let outcome = job.failure_outcome(home, &parent, &stopping)?;
                                revoke_input(&input, &mut input_source, &mut actions)?;
                                pending = None;
                                last_retained = None;
                                health.observe(outcome);
                            }
                            None
                        }
                        None => None,
                    }
                } else {
                    None
                }
            } else {
                None
            };
            if let Some((success, snapshot)) = completed
                && let Some(job) = pending.as_mut()
            {
                let outcome;
                // Even failed workers may have been cancelled by a source/pause
                // transition while output was being collected.
                if !job.admitted(home, &parent, &stopping)? {
                    let retained = retain_completed_input(
                        &input,
                        &mut input_source,
                        &mut actions,
                        success,
                        snapshot
                            .as_ref()
                            .and_then(Option::as_ref)
                            .filter(|snapshot| {
                                snapshot.window_id == job.fence.target.0 as u64
                                    && snapshot.pid == job.fence.target.1
                                    && snapshot.source_id == job.source
                            }),
                        |source| {
                            source.retry_after_content_change(
                                home,
                                &job.control,
                                job.fence,
                                &parent,
                                &stopping,
                                &mut schedule,
                            )
                        },
                    )?;
                    store.suppress()?;
                    last_retained = None;
                    outcome = if retained {
                        CaptureOutcome::Suppressed
                    } else {
                        job.failure_outcome(home, &parent, &stopping)?
                    };
                } else if !success {
                    revoke_input(&input, &mut input_source, &mut actions)?;
                    outcome = CaptureOutcome::Failed;
                    last_retained = None;
                } else if let Some(Some(snapshot)) = snapshot {
                    if snapshot.window_id != job.fence.target.0 as u64
                        || snapshot.pid != job.fence.target.1
                        || snapshot.source_id != job.source
                    {
                        revoke_input(&input, &mut input_source, &mut actions)?;
                        health.observe(CaptureOutcome::Failed);
                        last_retained = None;
                        schedule.completed(EPOCHS.current());
                        pending = None;
                        publish_health(home, &mut health, state)?;
                        continue;
                    }
                    let fingerprint = serde_json::to_string(&snapshot)?;
                    let policy = Policy::load(home)?;
                    let mut input_admitted = !job.subscription_failed();
                    if let Some(original) = &input_source {
                        if original.scope().is_some()
                            && original.capture_text == job.capture_text
                            && same_input_source(&original.snapshot, &snapshot)
                        {
                            while actions.persist_next(Instant::now(), job.started, |action| {
                                let mut action_snapshot = snapshot.without_content();
                                action_snapshot.action = Some(action.action.clone());
                                let written = store.append_if(
                                    &action_snapshot,
                                    action.kind,
                                    &policy,
                                    action.received_at.into(),
                                    || {
                                        Ok(policy.capture_text == job.capture_text
                                            && job.admitted(home, &parent, &stopping)?
                                            && original.scope().is_some()
                                            && job.lease_current())
                                    },
                                )?;
                                input_admitted = written;
                                Ok(written)
                            })? {}
                        } else {
                            // The observer may still hold undrained facts for
                            // identical HWNDs with different source metadata.
                            input_admitted = job.lease.is_none() && !job.subscription_failed();
                            revoke_input(&input, &mut input_source, &mut actions)?;
                        }
                    }
                    if !input_admitted {
                        let retain = match &input_source {
                            Some(original) => original.retry_after_content_change(
                                home,
                                &job.control,
                                job.fence,
                                &parent,
                                &stopping,
                                &mut schedule,
                            )?,
                            None => false,
                        };
                        if !retain {
                            revoke_input(&input, &mut input_source, &mut actions)?;
                        }
                    }
                    if last_retained
                        .as_ref()
                        .map(|(fingerprint, _, _)| fingerprint)
                        != Some(&fingerprint)
                        || job.kind == "window.changed"
                    {
                        let kind = if job.kind != "window.changed"
                            && last_retained.as_ref().is_some_and(|(_, selection, items)| {
                                selection != &snapshot.selection
                                    || items != &snapshot.item_selection
                            }) {
                            "selection.changed"
                        } else {
                            job.kind
                        };
                        if store.append_if(&snapshot, kind, &policy, Utc::now(), || {
                            Ok(policy.capture_text == job.capture_text
                                && job.admitted(home, &parent, &stopping)?)
                        })? {
                            last_retained = Some((
                                fingerprint,
                                snapshot.selection.clone(),
                                snapshot.item_selection.clone(),
                            ));
                        } else {
                            last_retained = None;
                            input_admitted = false;
                        }
                    }
                    let observed = policy
                        .project(&snapshot, "ui.changed", 1, Utc::now())
                        .is_some()
                        && job.accept_observation(&snapshot, |job| {
                            job.admitted(home, &parent, &stopping)
                        })?;
                    if !observed && job.observation.is_some() && observation_only(&snapshot) {
                        // A replaced owner gets a fresh worker, never renewal of
                        // the old owner. Preserve a bounded follow-up attempt.
                        EPOCHS.content_changed();
                        DIRTY_KIND.store(EVENT_OBJECT_VALUECHANGE, Ordering::SeqCst);
                    }
                    if input_admitted
                        && policy.capture_text == job.capture_text
                        && Policy::load(home)?.capture_text == job.capture_text
                        && snapshot.input_target.is_some()
                        && job.lease_current()
                        && policy
                            .project(&snapshot, "ui.changed", 1, Utc::now())
                            .is_some()
                        && job.accept_input(input_source.as_ref(), &snapshot, || {
                            job.admitted(home, &parent, &stopping)
                        })?
                    {
                        let candidate = InputSource {
                            snapshot: snapshot.without_content(),
                            capture_text: job.capture_text,
                            epoch: INPUT_EPOCH.load(Ordering::SeqCst),
                            window_epoch: job.fence.epochs.window,
                            captured_at: job.started,
                            lease: job
                                .lease
                                .as_ref()
                                .zip(job.frame_epochs)
                                .map(|(state, (identity, _))| (state.clone(), identity)),
                        };
                        if let Some(scope) = candidate.scope() {
                            if let Some(input) = &input {
                                INPUT_WINDOW.store(scope.hwnd, Ordering::SeqCst);
                                INPUT_TARGET.store(scope.focus_hwnd, Ordering::SeqCst);
                                input.set_scope(Some(scope))?;
                            }
                            input_source = Some(candidate);
                        } else {
                            revoke_input(&input, &mut input_source, &mut actions)?;
                            if let Some(lease) = &job.lease {
                                lease.close();
                            }
                        }
                    } else {
                        let retain = match &input_source {
                            Some(original) => original.retry_after_content_change(
                                home,
                                &job.control,
                                job.fence,
                                &parent,
                                &stopping,
                                &mut schedule,
                            )?,
                            None => false,
                        };
                        if !retain {
                            revoke_input(&input, &mut input_source, &mut actions)?;
                            if !observed && let Some(lease) = &job.lease {
                                lease.close();
                            }
                        }
                    }
                    outcome = if job.subscription_failed() {
                        job.failure_outcome(home, &parent, &stopping)?
                    } else {
                        CaptureOutcome::Observed
                    };
                } else if snapshot.is_some() {
                    revoke_input(&input, &mut input_source, &mut actions)?;
                    store.suppress()?;
                    last_retained = None;
                    outcome = if job.subscription_failed() {
                        job.failure_outcome(home, &parent, &stopping)?
                    } else {
                        CaptureOutcome::Suppressed
                    };
                } else {
                    revoke_input(&input, &mut input_source, &mut actions)?;
                    outcome = CaptureOutcome::Failed;
                    last_retained = None;
                }
                // Disposition owns the final terminal decision. A later EOF
                // on a kept child remains owned by the next idle-lease check.
                let job = pending.take().unwrap();
                let (idle, outcome) = job.into_idle(input_source.as_ref(), outcome, |job| {
                    job.failure_outcome(home, &parent, &stopping)
                })?;
                health.observe(outcome);
                schedule.completed(EPOCHS.current());
                idle_lease = idle;
            }
            publish_health(home, &mut health, state)?;
            if segment_started.elapsed() >= Duration::from_secs(600) {
                revoke_input(&input, &mut input_source, &mut actions)?;
                pending = None;
                idle_lease = None;
                store.finish(Utc::now())?;
                store = Store::new(home, Utc::now())?;
                segment_started = Instant::now();
                last_retained = None;
            }
            if last_flush.elapsed() >= Duration::from_secs(5) {
                store.flush()?;
                last_flush = Instant::now();
            }
            // Flush/rotation and job collection may block. Take a fresh target
            // only after draining, then fence preparation inside Pending::start.
            let queue_drained = dispatch_events();
            let target = foreground();
            let epochs = EPOCHS.current();
            let dirty = DIRTY_KIND.load(Ordering::Relaxed);
            if input_source.is_none() {
                schedule.cancel_input_retry();
            }
            let action_due = actions.pending()
                && input_source.as_ref().is_some_and(|source| {
                    source.lease.is_some()
                        && source.scope().is_some()
                        && schedule.input_due(
                            Instant::now(),
                            source.captured_at + SOURCE_FRESHNESS,
                            health.failures,
                        )
                });
            if pending.is_none()
                && queue_drained
                && let Some(target) = target
                && (idle_lease.as_ref().is_some_and(|job| {
                    job.observation.is_some()
                        && job
                            .lease
                            .as_ref()
                            .filter(|state| state.current().is_some())
                            .and_then(|state| state.verified_at())
                            .is_some_and(|verified| {
                                schedule.renewal_due(
                                    Instant::now(),
                                    verified,
                                    epochs,
                                    health.failures,
                                )
                            })
                }) || input_source.as_ref().is_some_and(|source| {
                    source.lease.is_some()
                        && source.scope().is_some()
                        && schedule.renewal_due(
                            Instant::now(),
                            source.captured_at,
                            epochs,
                            health.failures,
                        )
                }) || action_due
                    || schedule.due(
                        Instant::now(),
                        dirty != 0 || actions.pending() || input_source.is_some(),
                        epochs,
                        health.failures,
                    ))
            {
                EPOCHS.track_window(target.0);
                let new_source = source
                    .as_ref()
                    .is_none_or(|(old, version, _)| *old != target || *version != epochs.window);
                if new_source {
                    source = Some((target, epochs.window, uuid::Uuid::new_v4().to_string()));
                }
                let kind = if new_source {
                    "window.changed"
                } else if dirty == EVENT_OBJECT_TEXTSELECTIONCHANGED
                    || (EVENT_OBJECT_SELECTION..=EVENT_OBJECT_SELECTIONWITHIN).contains(&dirty)
                {
                    "selection.changed"
                } else {
                    "ui.changed"
                };
                let mut start_outcome = CaptureOutcome::Suppressed;
                pending = if let Some(mut lease) = idle_lease.take() {
                    if lease.fence.target == target
                        && lease.fence.epochs.window == epochs.window
                        && lease
                            .lease
                            .as_ref()
                            .is_some_and(|state| state.current().is_some())
                        && same_control(&lease.control, &control)
                        && admit(
                            home,
                            &control,
                            CaptureFence { target, epochs },
                            &parent,
                            &stopping,
                        )?
                    {
                        // A failed write/expired child is still a completed
                        // attempt. Let the normal terminal path classify it.
                        if lease
                            .request(CaptureFence { target, epochs }, kind)
                            .is_err()
                            && let Some(state) = &lease.lease
                        {
                            state.end(LeaseEnd::Failed);
                        }
                        Some(lease)
                    } else {
                        start_outcome = lease.failure_outcome(home, &parent, &stopping)?;
                        revoke_input(&input, &mut input_source, &mut actions)?;
                        None
                    }
                } else {
                    start_capture(
                        &input,
                        &mut input_source,
                        &mut actions,
                        || {
                            Pending::start(
                                home,
                                CaptureFence { target, epochs },
                                &source.as_ref().unwrap().2,
                                &control,
                                &parent,
                                &stopping,
                            )
                        },
                        |original| {
                            original.retry_after_content_change(
                                home,
                                &control,
                                CaptureFence { target, epochs },
                                &parent,
                                &stopping,
                                &mut schedule,
                            )
                        },
                    )?
                };
                if let Some(job) = &mut pending {
                    job.kind = kind;
                    DIRTY_KIND.store(0, Ordering::Relaxed);
                    schedule.started(Instant::now(), epochs);
                } else {
                    health.observe(start_outcome);
                    publish_health(home, &mut health, state)?;
                }
            }
            std::thread::sleep(RECORDER_POLL);
        }
        Ok(())
    })();
    drop(pending);
    drop(idle_lease);
    drop(hooks);
    finish_recording(
        outcome,
        || stop_input(&mut input).map_err(Into::into),
        || store.finish(Utc::now()),
        |clean| {
            write_json(
                &home.join("runtime.json"),
                &json!({
                    "state": if clean { "stopped" } else { "error" },
                    "endedAt": Utc::now(), "captureFailures": health.failures,
                }),
            )
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::recorder_lifecycle::Epochs;
    use windows::Win32::UI::WindowsAndMessaging::{SendMessageW, WTS_SESSION_UNLOCK};

    fn completed_child() -> Child {
        // Process startup is fixture preparation, not a simulated capture.
        // Reap before starting the lease clock; Pending still owns the handle.
        let mut child = Command::new("cmd.exe")
            .args(["/d", "/c", "exit", "0"])
            .creation_flags(0x08000000)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        assert!(child.wait().unwrap().success());
        child
    }

    #[test]
    fn pending_item_observation_retains_child_but_never_input_and_rejects_replacement() {
        for rejected in ["pause", "source", "owner", "epoch", "input"] {
            let child = completed_child();
            let now = Instant::now();
            let state = Arc::new(LeaseState::new(now));
            let revision = LeaseRevision {
                identity: 1,
                content: 1,
            };
            assert!(state.observe(revision, false, false));
            let mut snapshot = crate::model::tests::snapshot();
            snapshot.input_target = None;
            snapshot.item_selection = Some(crate::model::ItemSelection {
                owner_runtime_id: vec![7, 1],
                document_runtime_id: vec![],
                items: vec![],
            });
            let (_, output) = mpsc::sync_channel(8);
            let mut pending = Pending {
                child,
                output,
                started: now,
                fence: CaptureFence {
                    target: (snapshot.window_id as usize, snapshot.pid),
                    epochs: Epochs::default(),
                },
                source: snapshot.source_id.clone(),
                control: Control {
                    state: State::Running,
                    resume_at: None,
                    revision: None,
                },
                config: vec![],
                kind: "selection.changed",
                capture_text: true,
                lease: Some(state.clone()),
                request: 0,
                frame_epochs: Some((1, 1)),
                lease_seen: LeaseRevision::default(),
                frame_changes: state.observed_changes(),
                terminal: None,
                observation: None,
            };
            assert!(pending.accept_observation(&snapshot, |_| Ok(true)).unwrap());
            assert!(!state.admits(1));
            let (idle, _) = pending
                .into_idle(None, CaptureOutcome::Observed, |_| {
                    panic!("observation child must remain owned")
                })
                .unwrap();
            let mut pending = idle.unwrap();
            pending.request = 1;
            pending.started = Instant::now();
            match rejected {
                "pause" => state.close(),
                "source" => snapshot.source_id.push('x'),
                "owner" => snapshot
                    .item_selection
                    .as_mut()
                    .unwrap()
                    .owner_runtime_id
                    .push(2),
                "epoch" => {
                    state.observe(
                        LeaseRevision {
                            identity: 2,
                            content: 2,
                        },
                        true,
                        false,
                    );
                }
                _ => {
                    snapshot.input_target = Some(crate::model::InputTarget {
                        hwnd: 101,
                        role: "AXTextField".into(),
                        uia: None,
                    })
                }
            }
            assert!(
                !pending
                    .accept_observation(&snapshot, |_| Ok(rejected != "pause"))
                    .unwrap(),
                "{rejected}"
            );
            assert!(!state.admits(1));
        }
    }

    #[test]
    fn pending_accepts_only_fully_verified_baselines_and_same_owner_renewals() {
        use crate::model::{InputTarget, UiaTarget, tests::snapshot};
        for case in [
            "baseline",
            "renewal",
            "missing-original",
            "different-owner",
            "policy",
            "target",
            "metadata",
            "private",
            "unknown",
            "final-denial",
            "final-error",
            "late-eof",
            "late-notice",
            "missing-stamp",
            "one-shot",
        ] {
            let child = completed_child();
            let now = Instant::now();
            let baseline = case == "baseline" || case == "one-shot";
            let birth = if baseline {
                now - RECORDER_POLL
            } else {
                now - SOURCE_FRESHNESS - Duration::from_secs(1)
            };
            let lease = Arc::new(LeaseState::new(birth));
            let frame = LeaseRevision {
                identity: 1,
                content: 1,
            };
            assert!(lease.observe(frame, false, false));
            let seen = lease.observed_changes().unwrap();
            assert!(!lease.admits(1), "a reader frame is not parent admission");
            let previous = now - Duration::from_secs(3);
            if !baseline {
                assert!(lease.accept_verified(0, birth, frame, seen, || birth));
                assert!(lease.accept_verified(1, previous, frame, seen, || previous));
                assert!(
                    lease.current().is_some(),
                    "the old worker birth is not expiry"
                );
            }
            let mut fresh = snapshot();
            fresh.input_target = Some(InputTarget {
                hwnd: 101,
                role: "AXTextField".into(),
                uia: (case != "one-shot").then_some(UiaTarget {
                    runtime_id: vec![42, 7],
                    document_runtime_id: vec![42],
                }),
            });
            let mut original = (!baseline).then(|| InputSource {
                snapshot: fresh.without_content(),
                capture_text: true,
                epoch: 0,
                window_epoch: 0,
                captured_at: previous,
                lease: Some((lease.clone(), 1)),
            });
            let (_, output) = mpsc::sync_channel(8);
            let mut pending = Pending {
                child,
                output,
                started: now - RECORDER_POLL,
                fence: CaptureFence {
                    target: (fresh.window_id as usize, fresh.pid),
                    epochs: Epochs::default(),
                },
                source: fresh.source_id.clone(),
                control: Control {
                    state: State::Running,
                    resume_at: None,
                    revision: None,
                },
                config: Vec::new(),
                kind: "ui.changed",
                capture_text: true,
                lease: (case != "one-shot").then(|| lease.clone()),
                request: if baseline { 0 } else { 2 },
                frame_epochs: Some((1, 1)),
                lease_seen: seen,
                frame_changes: Some(seen),
                terminal: None,
                observation: None,
            };
            match case {
                "missing-original" => original = None,
                "different-owner" => {
                    original.as_mut().unwrap().lease = Some((Arc::new(LeaseState::new(now)), 1));
                }
                "policy" => original.as_mut().unwrap().capture_text = false,
                "target" => fresh.pid += 1,
                "metadata" => fresh.title = "another document".into(),
                "private" => fresh.private = true,
                "unknown" => fresh.source_known = false,
                "missing-stamp" => pending.frame_changes = None,
                _ => {}
            }
            let accepted_before = lease.verified_at();
            let accepted = pending.accept_input(original.as_ref(), &fresh, || {
                match case {
                    "final-denial" => return Ok(false),
                    "final-error" => return Err("final_authority_unavailable".into()),
                    "late-eof" => lease.end(LeaseEnd::Eof),
                    "late-notice" => {
                        assert!(lease.observe(frame, true, false));
                    }
                    _ => {}
                }
                Ok(true)
            });
            if case == "final-error" {
                assert!(accepted.is_err());
            } else {
                let expected = matches!(case, "baseline" | "renewal" | "one-shot");
                assert_eq!(accepted.unwrap(), expected, "{case}");
            }
            if matches!(case, "baseline" | "renewal") {
                assert_eq!(lease.verified_at(), Some(pending.started), "{case}");
                assert!(lease.admits(1));
                assert_eq!(lease.started, birth, "worker identity remains immutable");
                if let Some(original) = original {
                    assert_eq!(
                        original.captured_at, previous,
                        "queued source is not rewritten"
                    );
                }
            } else {
                assert_eq!(lease.verified_at(), accepted_before, "{case}");
            }
        }
    }

    #[test]
    fn pending_terminal_requires_successful_exit_without_external_input_authority() {
        use crate::model::{InputTarget, tests::snapshot};
        use std::io::Cursor;
        for reason in [
            CompletionReason::Native,
            CompletionReason::BodyOnly,
            CompletionReason::SubscriptionFailure,
        ] {
            for failure in ["none", "exit", "expired"] {
                let mut snapshot = snapshot();
                if reason == CompletionReason::Native {
                    snapshot.input_target = Some(InputTarget {
                        hwnd: 101,
                        role: "AXTextField".into(),
                        uia: None,
                    });
                }
                let mut child = Command::new("cmd")
                    .args([
                        "/C",
                        if failure == "exit" {
                            "exit 1"
                        } else {
                            "exit 0"
                        },
                    ])
                    .creation_flags(0x08000000)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .unwrap();
                child.wait().unwrap();
                let started = Instant::now();
                let state = Arc::new(LeaseState::new(started));
                let (send, output) = mpsc::channel();
                let mut wire = serde_json::to_vec(&LeaseFrame::Completed {
                    request: 0,
                    reason,
                    snapshot: Some(snapshot.clone()),
                })
                .unwrap();
                wire.push(b'\n');
                read_lease_output(Cursor::new(wire), &state, |frame| {
                    send.send(frame).unwrap();
                    true
                });
                let mut pending = Pending {
                    child,
                    output,
                    started: if failure == "expired" {
                        started - CAPTURE_LIMIT
                    } else {
                        started
                    },
                    fence: CaptureFence {
                        target: (snapshot.window_id as usize, snapshot.pid),
                        epochs: EPOCHS.current(),
                    },
                    source: snapshot.source_id.clone(),
                    control: Control {
                        state: State::Running,
                        revision: None,
                        resume_at: None,
                    },
                    config: Vec::new(),
                    kind: "window.changed",
                    capture_text: true,
                    lease: Some(state.clone()),
                    request: 0,
                    frame_epochs: None,
                    lease_seen: LeaseRevision::default(),
                    frame_changes: None,
                    terminal: None,
                    observation: None,
                };
                let collected = pending.collect().unwrap();
                assert!(!state.admits(1));
                if failure != "none" {
                    assert!(matches!(collected, Some(Collected::Completed(false, None))));
                    assert!(!pending.lease_current());
                    continue;
                }
                let Some(Collected::Completed(true, Some(Some(retained)))) = collected else {
                    panic!("expected checked terminal body");
                };
                assert_eq!(retained.text, snapshot.text);
                assert!(pending.lease.is_none());
                assert_eq!(
                    pending.subscription_failed(),
                    reason == CompletionReason::SubscriptionFailure
                );
                assert!(!pending.accept_input(None, &retained, || Ok(false)).unwrap());
                if reason == CompletionReason::Native {
                    assert!(pending.accept_input(None, &retained, || Ok(true)).unwrap());
                } else {
                    assert!(retained.input_target.is_none());
                }
                let expected = if pending.subscription_failed() {
                    CaptureOutcome::Failed
                } else {
                    CaptureOutcome::Observed
                };
                let (idle, outcome) = pending
                    .into_idle(None, expected, |_| panic!("terminal already classified"))
                    .unwrap();
                assert!(idle.is_none());
                assert_eq!(outcome, expected);
            }
        }
    }

    #[test]
    fn terminal_reader_retains_only_a_single_complete_non_uia_observation() {
        use crate::model::{InputTarget, UiaTarget, tests::snapshot};
        use std::io::Cursor;
        for reason in [
            CompletionReason::Native,
            CompletionReason::BodyOnly,
            CompletionReason::SubscriptionFailure,
        ] {
            for case in [
                "valid",
                "external",
                "wrong-reason",
                "wrong-request",
                "trailing",
                "duplicate",
                "prior",
                "truncated",
            ] {
                let state = LeaseState::new(Instant::now());
                let mut snapshot = snapshot();
                if reason == CompletionReason::Native || matches!(case, "external" | "wrong-reason")
                {
                    snapshot.input_target = Some(InputTarget {
                        hwnd: 101,
                        role: "AXTextField".into(),
                        uia: (case == "external").then_some(UiaTarget {
                            runtime_id: vec![42, 7],
                            document_runtime_id: vec![42],
                        }),
                    });
                }
                if reason == CompletionReason::Native && case == "wrong-reason" {
                    snapshot.input_target = None;
                }
                let frame = LeaseFrame::Completed {
                    request: u64::from(case == "wrong-request"),
                    reason,
                    snapshot: Some(snapshot),
                };
                let mut wire = serde_json::to_vec(&frame).unwrap();
                wire.push(b'\n');
                match case {
                    "trailing" => wire.push(b'x'),
                    "duplicate" => wire.extend(wire.clone()),
                    "prior" => {
                        let mut prior = b"{\"type\":\"invalidated\",\"identity\":1,\"content\":1,\"revoked\":false}\n".to_vec();
                        prior.extend(wire);
                        wire = prior;
                    }
                    "truncated" => {
                        wire.pop();
                    }
                    _ => {}
                }
                let mut completed = 0;
                read_lease_output(Cursor::new(wire), &state, |output| {
                    if matches!(
                        serde_json::from_slice::<LeaseFrame>(&output.bytes).unwrap(),
                        LeaseFrame::Completed { .. }
                    ) {
                        completed += 1;
                        assert!(output.changes.is_none());
                    }
                    true
                });
                assert_eq!(completed, usize::from(case == "valid"), "{reason:?}/{case}");
                assert!(!state.admits(1), "terminal output is never UIA admission");
            }
        }
    }

    #[test]
    fn terminal_reader_health_preserves_real_cancellation_and_reports_provider_failures() {
        use std::io::Cursor;
        let home = crate::model::tests::Home::new();
        let mut health = CaptureHealth::default();
        for wire in [
            "",
            "{\"type\":\"snapshot\",\"request\":0,\"identity\":1,\"content\":1,\"snapshot\":null}\n",
            "{\"type\":\"invalidated\",\"identity\":1,\"content\":1,\"revoked\":true}\n",
            "{\"type\":\"snapshot\"}\n",
        ] {
            let state = LeaseState::new(Instant::now());
            let events = EventEpochs::new();
            let fence = CaptureFence {
                target: (10, 20),
                epochs: events.current(),
            };
            let input_epoch = AtomicU64::new(0);
            let mut seen = LeaseRevision::default();
            read_lease_output(Cursor::new(wire), &state, |_| true);
            assert!(!state.synchronize(&mut seen, &input_epoch, &events));
            assert!(state.current().is_none());
            health.observe(state.failure_outcome(
                fence.allows(LiveState {
                    queue_drained: true,
                    parent_alive: true,
                    stopping: false,
                    desktop_available: true,
                    foreground: Some(fence.target),
                    epochs: events.current(),
                }),
                seen,
                Instant::now(),
            ));
        }
        assert_eq!(health.failures, 4);
        publish_health(&home.0, &mut health, "running").unwrap();
        let saved: serde_json::Value =
            serde_json::from_slice(&std::fs::read(home.0.join("runtime.json")).unwrap()).unwrap();
        assert_eq!(saved["captureFailures"], 4);
        let state = LeaseState::new(Instant::now());
        let events = EventEpochs::new();
        let input_epoch = AtomicU64::new(0);
        let mut seen = LeaseRevision::default();
        read_lease_output(
            Cursor::new(concat!(
                "{\"type\":\"snapshot\",\"request\":0,\"identity\":1,\"content\":1,\"snapshot\":null}\n",
                "{\"type\":\"invalidated\",\"identity\":2,\"content\":2,\"revoked\":true}\n",
            )),
            &state,
            |_| true,
        );
        assert!(state.synchronize(&mut seen, &input_epoch, &events));
        assert_eq!(
            state.failure_outcome(false, seen, Instant::now()),
            CaptureOutcome::Suppressed
        );
    }

    #[test]
    fn production_lease_reader_baselines_then_invalidates_and_accepts_fresh_verifier() {
        use crate::model::tests::snapshot;
        use std::io::Cursor;
        let state = LeaseState::new(Instant::now());
        let events = EventEpochs::new();
        let input_epoch = AtomicU64::new(0);
        let mut seen = LeaseRevision::default();
        let first_fence = events.current();
        let frames = [
            LeaseFrame::Snapshot {
                request: 0,
                identity: 1,
                content: 1,
                snapshot: Some(snapshot()),
            },
            LeaseFrame::Invalidated {
                identity: 2,
                content: 2,
                revoked: false,
            },
            LeaseFrame::Snapshot {
                request: 1,
                identity: 2,
                content: 2,
                snapshot: Some(snapshot()),
            },
        ];
        let mut wire = Vec::new();
        for frame in frames {
            serde_json::to_writer(&mut wire, &frame).unwrap();
            wire.push(b'\n');
        }
        let mut count = 0;
        read_lease_output(Cursor::new(wire), &state, |output| {
            let parsed = serde_json::from_slice(&output.bytes).unwrap();
            if matches!(parsed, LeaseFrame::Invalidated { .. }) {
                assert!(state.synchronize(&mut seen, &input_epoch, &events));
                assert!(!state.admits(1));
                return true;
            }
            let LeaseFrame::Snapshot {
                request,
                identity,
                content,
                snapshot,
            } = parsed
            else {
                panic!("snapshot")
            };
            assert!(snapshot.is_some());
            let frame = LeaseRevision { identity, content };
            let changed = state.synchronize(&mut seen, &input_epoch, &events);
            if request == 0 {
                assert!(
                    !changed,
                    "the initial reader frame cannot stale its own capture"
                );
                assert_eq!(events.current(), first_fence);
                assert_eq!(input_epoch.load(Ordering::SeqCst), 0);
            } else {
                assert!(!changed, "notice was already consumed by the owner");
                assert_ne!(events.current(), first_fence);
                assert_eq!(input_epoch.load(Ordering::SeqCst), 1);
                assert!(!state.admits(1));
            }
            assert!(state.frame_current(frame, output.changes.unwrap()));
            count += 1;
            true
        });
        assert_eq!(count, 2);
        assert!(state.current().is_none(), "pipe EOF closes admission");
    }

    #[test]
    fn production_lease_reader_preserves_prebaseline_invalidation_and_rejects_bad_wire() {
        use std::io::Cursor;
        let state = LeaseState::new(Instant::now());
        let events = EventEpochs::new();
        let input_epoch = AtomicU64::new(0);
        let mut seen = LeaseRevision::default();
        read_lease_output(
            Cursor::new(concat!(
                "{\"type\":\"invalidated\",\"identity\":1,\"content\":1,\"revoked\":false}\n",
                "{\"type\":\"snapshot\",\"request\":0,\"identity\":1,\"content\":1,\"snapshot\":null}\n"
            )),
            &state,
            |output| {
                let invalidated = matches!(
                    serde_json::from_slice::<LeaseFrame>(&output.bytes).unwrap(),
                    LeaseFrame::Invalidated { .. }
                );
                assert_eq!(
                    state.synchronize(&mut seen, &input_epoch, &events),
                    invalidated
                );
                assert_eq!(input_epoch.load(Ordering::SeqCst), 1);
                true
            },
        );
        for wire in [
            b"{\"type\":\"snapshot\"}\n".to_vec(),
            b"{\"type\":\"snapshot\",\"request\":0,\"identity\":1,\"content\":1,\"snapshot\":null}"
                .to_vec(),
            vec![b' '; (MAX_SNAPSHOT_BYTES + 1) as usize],
        ] {
            let state = LeaseState::new(Instant::now());
            read_lease_output(Cursor::new(wire), &state, |_| {
                panic!("invalid frame published")
            });
            assert!(state.current().is_none());
        }
    }

    #[test]
    fn late_equal_epoch_notice_cannot_revalidate_an_older_queued_snapshot() {
        use std::io::Cursor;
        let state = LeaseState::new(Instant::now());
        let mut original = None;
        read_lease_output(
            Cursor::new(concat!(
                "{\"type\":\"snapshot\",\"request\":0,\"identity\":1,\"content\":1,\"snapshot\":null}\n",
                "{\"type\":\"invalidated\",\"identity\":1,\"content\":1,\"revoked\":false}\n",
                "{\"type\":\"snapshot\",\"request\":1,\"identity\":1,\"content\":1,\"snapshot\":null}\n"
            )),
            &state,
            |output| {
                let frame = serde_json::from_slice::<LeaseFrame>(&output.bytes).unwrap();
                let revision = LeaseRevision {
                    identity: 1,
                    content: 1,
                };
                match frame {
                    LeaseFrame::Snapshot { request: 0, .. } => {
                        original = output.changes;
                        assert!(state.frame_current(revision, original.unwrap()));
                    }
                    LeaseFrame::Invalidated { .. } => {
                        assert!(!state.frame_current(revision, original.unwrap()));
                    }
                    _ => {
                        assert!(!state.frame_current(revision, original.unwrap()));
                        assert!(state.frame_current(revision, output.changes.unwrap()));
                    }
                }
                true
            },
        );
    }

    #[test]
    fn completed_same_source_retains_original_return_through_real_fence_then_writes_once() {
        use crate::{
            input::{InputBatch, InputFact, InputKind, Modifiers},
            model::{
                InputTarget,
                tests::{Home, snapshot},
            },
        };
        let child = completed_child();
        let home = Home::new();
        let policy = home.policy(true);
        let mut store = Store::new(&home.0, Utc::now()).unwrap();
        let events = EventEpochs::new();
        let lease = Arc::new(LeaseState::new(Instant::now()));
        let frame = LeaseRevision {
            identity: 1,
            content: 1,
        };
        assert!(lease.observe(frame, false, false));
        let frame_changes = lease.observed_changes();
        assert!(lease.accept_verified(
            0,
            lease.started,
            frame,
            frame_changes.unwrap(),
            Instant::now,
        ));
        let (mut original, mut queue, observed_at) = {
            let mut snapshot = snapshot().without_content();
            snapshot.input_target = Some(InputTarget {
                hwnd: 101,
                role: "AXTextField".into(),
                uia: Some(crate::model::UiaTarget {
                    runtime_id: vec![42, 7],
                    document_runtime_id: vec![42],
                }),
            });
            let observed_at = lease.started;
            let scope = InputScope {
                hwnd: snapshot.window_id as usize,
                pid: snapshot.pid,
                focus_hwnd: 101,
                epoch: 1,
                mode: InputMode::ObservedUia,
                uia_lease_epoch: Some(1),
            };
            let mut actions = Actions::default();
            actions.ingest(
                InputBatch {
                    facts: vec![InputFact {
                        scope,
                        kind: InputKind::Return,
                        modifiers: Modifiers::default(),
                        os_time_ms: 1,
                        observed_at,
                        received_at: std::time::SystemTime::UNIX_EPOCH,
                    }],
                    interrupted: false,
                },
                scope,
                observed_at,
            );
            (
                Some(InputSource {
                    snapshot,
                    capture_text: true,
                    epoch: 1,
                    window_epoch: 0,
                    captured_at: observed_at,
                    lease: Some((lease.clone(), 1)),
                }),
                actions,
                observed_at,
            )
        };
        let fresh = original.as_ref().unwrap().snapshot.clone();
        let cancelled = CaptureFence {
            target: (fresh.window_id as usize, fresh.pid),
            epochs: events.current(),
        };
        let (_, output) = mpsc::sync_channel(8);
        let pending = Pending {
            child,
            output,
            started: observed_at,
            fence: cancelled,
            source: fresh.source_id.clone(),
            control: Control {
                state: State::Running,
                resume_at: None,
                revision: None,
            },
            config: Vec::new(),
            kind: "ui.changed",
            capture_text: true,
            lease: Some(lease.clone()),
            request: 1,
            frame_epochs: Some((1, 1)),
            lease_seen: LeaseRevision::default(),
            frame_changes,
            terminal: None,
            observation: None,
        };
        assert!(lease.observe(
            LeaseRevision {
                content: 2,
                ..frame
            },
            true,
            false
        ));
        events.content_changed();
        let current = CaptureFence {
            epochs: events.current(),
            ..cancelled
        };
        let mut schedule = CaptureSchedule::default();
        assert!(
            retain_completed_input(
                &None,
                &mut original,
                &mut queue,
                true,
                Some(&fresh),
                |source| {
                    let allowed = current.after_preparation(
                        || {
                            Ok(policy
                                .project(&source.snapshot, "ui.changed", 1, Utc::now())
                                .is_some())
                        },
                        || LiveState {
                            queue_drained: true,
                            parent_alive: true,
                            stopping: false,
                            desktop_available: true,
                            foreground: Some(current.target),
                            epochs: events.current(),
                        },
                    )?;
                    if allowed {
                        schedule.retry_input_before(
                            source.captured_at,
                            source.captured_at + Duration::from_secs(5),
                        );
                    }
                    Ok(allowed && lease.admits(1))
                }
            )
            .unwrap()
        );
        assert_eq!(original.as_ref().unwrap().captured_at, observed_at);
        assert!(queue.pending());
        assert!(!pending.lease_current(), "completed frame is stale");
        let (idle, outcome) = pending
            .into_idle(original.as_ref(), CaptureOutcome::Suppressed, |_| {
                panic!("live retained child cannot be terminal")
            })
            .unwrap();
        assert_eq!(outcome, CaptureOutcome::Suppressed);
        let mut idle = idle.expect("same child must survive");
        assert!(Arc::ptr_eq(idle.lease.as_ref().unwrap(), &lease));
        assert_eq!(idle.lease.as_ref().unwrap().started, observed_at);
        assert!(lease.observe(
            LeaseRevision {
                content: 2,
                ..frame
            },
            false,
            false
        ));
        idle.frame_epochs = Some((1, 2));
        idle.frame_changes = lease.observed_changes();
        assert!(idle.lease_current());
        let verifier_started = Instant::now();
        let write = |action: &crate::input_actions::QueuedAction| {
            let mut snapshot = fresh.without_content();
            snapshot.action = Some(action.action.clone());
            store.append_if(
                &snapshot,
                action.kind,
                &policy,
                action.received_at.into(),
                || {
                    Ok(idle.lease_current()
                        && current.after_preparation(
                            || Ok(true),
                            || LiveState {
                                queue_drained: true,
                                parent_alive: true,
                                stopping: false,
                                desktop_available: true,
                                foreground: Some(current.target),
                                epochs: events.current(),
                            },
                        )?
                        && lease.admits(1))
                },
            )
        };
        assert!(
            queue
                .persist_next(Instant::now(), verifier_started, write)
                .unwrap()
        );
        assert!(
            !queue
                .persist_next(Instant::now(), verifier_started, |_| {
                    panic!("acknowledged Return cannot be replayed")
                })
                .unwrap()
        );
        store.finish(Utc::now()).unwrap();
        let segments = std::fs::read_dir(home.0.join("segments"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect::<Vec<_>>();
        assert_eq!(segments.len(), 1);
        let saved = std::fs::read_to_string(segments[0].join("events.jsonl")).unwrap();
        let lines = saved
            .lines()
            .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0]["kind"], "keyboard.submit");
        assert!(lines[0].get("ax").is_none());
        assert!(lines[0].get("selection").is_none());

        idle.lease_seen = lease.observed_changes().unwrap();
        assert!(!lease.ended());
        // Exact late EOF race: the last pre-disposition check just succeeded.
        lease.end(LeaseEnd::Eof);
        let terminal_calls = std::cell::Cell::new(0);
        let (idle, outcome) = idle
            .into_idle(original.as_ref(), CaptureOutcome::Observed, |job| {
                terminal_calls.set(terminal_calls.get() + 1);
                Ok(job.lease.as_ref().unwrap().failure_outcome(
                    true,
                    job.lease_seen,
                    Instant::now(),
                ))
            })
            .unwrap();
        let mut health = CaptureHealth::default();
        health.observe(outcome);
        assert!(idle.is_none());
        assert_eq!(terminal_calls.get(), 1);
        assert_eq!(health.failures, 1);
        assert!(original.as_ref().unwrap().scope().is_none());
        assert!(!queue.pending());

        for reason in [
            "failed", "missing", "pid", "title", "aumid", "secure", "role", "runtime", "revoked",
        ] {
            let mut source = Some(InputSource {
                snapshot: fresh.clone(),
                capture_text: true,
                epoch: 1,
                window_epoch: 0,
                captured_at: observed_at,
                lease: None,
            });
            let mut changed = fresh.clone();
            match reason {
                "pid" => changed.pid += 1,
                "title" => changed.title = "changed".into(),
                "aumid" => changed.application_user_model_id = Some("TestPackage!App".into()),
                "secure" => changed.secure = true,
                "role" => changed.input_target.as_mut().unwrap().role = "AXDocument".into(),
                "runtime" => {
                    changed.input_target.as_mut().unwrap().uia = Some(crate::model::UiaTarget {
                        runtime_id: vec![1, 2],
                        document_runtime_id: vec![1],
                    })
                }
                _ => {}
            }
            let mut queue = Actions::default();
            let scope = InputScope {
                hwnd: fresh.window_id as usize,
                pid: fresh.pid,
                focus_hwnd: 101,
                epoch: 1,
                mode: InputMode::NativeChild,
                uia_lease_epoch: None,
            };
            queue.ingest(
                InputBatch {
                    facts: vec![InputFact {
                        scope,
                        kind: InputKind::Return,
                        modifiers: Modifiers::default(),
                        os_time_ms: 1,
                        observed_at,
                        received_at: std::time::SystemTime::UNIX_EPOCH,
                    }],
                    interrupted: false,
                },
                scope,
                observed_at,
            );
            assert!(queue.pending());
            assert!(
                !retain_completed_input(
                    &None,
                    &mut source,
                    &mut queue,
                    reason != "failed",
                    (reason != "missing").then_some(&changed),
                    |_| {
                        assert_eq!(
                            reason, "revoked",
                            "mismatched completion cannot ask for retention"
                        );
                        current.after_preparation(
                            || Ok(true),
                            || LiveState {
                                queue_drained: true,
                                parent_alive: false,
                                stopping: true,
                                desktop_available: true,
                                foreground: Some(current.target),
                                epochs: events.current(),
                            },
                        )
                    }
                )
                .unwrap(),
                "{reason}"
            );
            assert!(source.is_none(), "{reason}");
            assert!(!queue.pending(), "{reason}");
        }
    }

    mod private_start_retry {
        use super::*;
        use crate::{
            input::{InputBatch, InputFact, InputKind, Modifiers},
            model::{InputTarget, tests::snapshot},
        };
        use std::cell::Cell;

        fn queued() -> (Option<InputSource>, Actions) {
            let now = Instant::now();
            let mut snapshot = snapshot().without_content();
            snapshot.input_target = Some(InputTarget {
                hwnd: 101,
                role: "AXTextField".into(),
                uia: None,
            });
            let scope = InputScope {
                hwnd: snapshot.window_id as usize,
                pid: snapshot.pid,
                focus_hwnd: 101,
                mode: InputMode::NativeChild,
                uia_lease_epoch: None,
                epoch: 17,
            };
            let source = InputSource {
                snapshot,
                capture_text: true,
                epoch: scope.epoch,
                window_epoch: 9,
                captured_at: now,
                lease: None,
            };
            let mut actions = Actions::default();
            actions.ingest(
                InputBatch {
                    facts: vec![InputFact {
                        scope,
                        kind: InputKind::Return,
                        modifiers: Modifiers::default(),
                        os_time_ms: 100,
                        observed_at: now,
                        received_at: std::time::SystemTime::UNIX_EPOCH,
                    }],
                    interrupted: false,
                },
                scope,
                now,
            );
            (Some(source), actions)
        }

        #[test]
        fn revoked_before_spawn_calls_real_admission_and_cannot_retain_return() {
            use crate::model::tests::Home;
            use windows::Win32::System::Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
                TH32CS_SNAPPROCESS,
            };
            let processes = ownership::OwnedHandle(
                unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }.unwrap(),
            );
            let mut entry = PROCESSENTRY32W {
                dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
                ..Default::default()
            };
            unsafe { Process32FirstW(processes.0, &mut entry) }.unwrap();
            while entry.th32ProcessID != std::process::id() {
                unsafe { Process32NextW(processes.0, &mut entry) }.unwrap();
            }
            let parent = ownership::Parent::open(entry.th32ParentProcessID).unwrap();
            let home = Home::new();
            home.policy(true);
            write_json(
                &home.0.join("maka-settings.json"),
                &json!({"enabled": true}),
            )
            .unwrap();
            let control = Control::load(&home.0).unwrap();
            let stopping = AtomicBool::new(true);
            let (mut source, mut actions) = queued();
            let original = source.as_ref().unwrap();
            let fence = CaptureFence {
                target: (original.snapshot.window_id as usize, original.snapshot.pid),
                epochs: EPOCHS.current(),
            };
            let source_id = original.snapshot.source_id.clone();
            let cancelled = CaptureFence {
                epochs: crate::recorder_lifecycle::Epochs {
                    content: fence.epochs.content.wrapping_sub(1),
                    ..fence.epochs
                },
                ..fence
            };
            let mut schedule = CaptureSchedule::default();
            let retention_calls = Cell::new(0);
            let job = start_capture(
                &None,
                &mut source,
                &mut actions,
                || Pending::start(&home.0, fence, &source_id, &control, &parent, &stopping),
                |original| {
                    retention_calls.set(retention_calls.get() + 1);
                    original.retry_after_content_change(
                        &home.0,
                        &control,
                        cancelled,
                        &parent,
                        &stopping,
                        &mut schedule,
                    )
                },
            )
            .unwrap();
            assert!(job.is_none(), "revoked owner must not spawn a worker");
            assert_eq!(retention_calls.get(), 1);
            assert!(source.is_none());
            assert!(!actions.pending());
            assert!(!home.0.join("segments").exists());
        }

        #[test]
        fn denied_spawn_preserves_original_fact_only_when_owner_admits_retry() {
            for retain in [false, true] {
                let (mut source, mut actions) = queued();
                let original_time = source.as_ref().unwrap().captured_at;
                let original_source = source.as_ref().unwrap().snapshot.source_id.clone();
                let starts = Cell::new(0);
                let decisions = Cell::new(0);
                let job = start_capture::<()>(
                    &None,
                    &mut source,
                    &mut actions,
                    || {
                        starts.set(starts.get() + 1);
                        Ok(None)
                    },
                    |original| {
                        decisions.set(decisions.get() + 1);
                        assert_eq!(original.captured_at, original_time);
                        assert_eq!(original.snapshot.source_id, original_source);
                        Ok(retain)
                    },
                )
                .unwrap();
                assert!(job.is_none());
                assert_eq!(starts.get(), 1);
                assert_eq!(decisions.get(), 1);
                assert_eq!(source.is_some(), retain);
                assert_eq!(actions.pending(), retain);
                if retain {
                    assert_eq!(source.as_ref().unwrap().captured_at, original_time);
                    assert_eq!(
                        start_capture(
                            &None,
                            &mut source,
                            &mut actions,
                            || Ok(Some(23)),
                            |_| panic!("successful spawn must not request retention"),
                        )
                        .unwrap(),
                        Some(23)
                    );
                    assert!(
                        actions.pending(),
                        "spawn is not a persistence acknowledgement"
                    );
                    assert_eq!(source.as_ref().unwrap().captured_at, original_time);
                }
            }
        }

        #[test]
        fn spawn_or_retention_error_propagates_once_without_acknowledgement() {
            for fail_start in [false, true] {
                let (mut source, mut actions) = queued();
                let original_time = source.as_ref().unwrap().captured_at;
                let starts = Cell::new(0);
                let decisions = Cell::new(0);
                let error = start_capture::<()>(
                    &None,
                    &mut source,
                    &mut actions,
                    || {
                        starts.set(starts.get() + 1);
                        if fail_start {
                            Err("synthetic_spawn_error".into())
                        } else {
                            Ok(None)
                        }
                    },
                    |_| {
                        decisions.set(decisions.get() + 1);
                        Err("synthetic_admission_error".into())
                    },
                )
                .unwrap_err();
                assert_eq!(
                    error.to_string(),
                    if fail_start {
                        "synthetic_spawn_error"
                    } else {
                        "synthetic_admission_error"
                    }
                );
                assert_eq!(starts.get(), 1);
                assert_eq!(decisions.get(), usize::from(!fail_start));
                assert!(actions.pending(), "errors must not acknowledge a Return");
                assert_eq!(source.as_ref().unwrap().captured_at, original_time);
            }
        }
    }

    #[test]
    fn admitted_verifier_spawn_preserves_actions_and_failed_admission_revokes_them() {
        use crate::input::{InputBatch, InputFact, InputKind, Modifiers};
        let now = Instant::now();
        let scope = InputScope {
            hwnd: 10,
            pid: 20,
            epoch: 1,
            focus_hwnd: 11,
            mode: InputMode::NativeChild,
            uia_lease_epoch: None,
        };
        let mut actions = Actions::default();
        actions.ingest(
            InputBatch {
                facts: vec![InputFact {
                    scope,
                    kind: InputKind::Return,
                    modifiers: Modifiers::default(),
                    os_time_ms: 100,
                    observed_at: now,
                    received_at: std::time::SystemTime::UNIX_EPOCH,
                }],
                interrupted: false,
            },
            scope,
            now,
        );
        let mut source = None;
        assert_eq!(
            start_capture(
                &None,
                &mut source,
                &mut actions,
                || Ok(Some(1)),
                |_| Ok(false)
            )
            .unwrap(),
            Some(1)
        );
        assert!(
            actions.pending(),
            "the verifier must not revoke its own pending actions"
        );
        assert!(
            start_capture::<()>(&None, &mut source, &mut actions, || Ok(None), |_| Ok(false))
                .unwrap()
                .is_none()
        );
        assert!(!actions.pending());
    }

    #[test]
    fn sent_session_aba_invalidates_source_and_retains_suspension_until_consumed() {
        let notifications = SessionNotifications::new().unwrap();
        let before = EPOCHS.current();
        unsafe {
            SendMessageW(
                notifications.0,
                WM_WTSSESSION_CHANGE,
                Some(WPARAM(WTS_SESSION_LOCK as usize)),
                Some(LPARAM(0)),
            );
            SendMessageW(
                notifications.0,
                WM_WTSSESSION_CHANGE,
                Some(WPARAM(WTS_SESSION_UNLOCK as usize)),
                Some(LPARAM(0)),
            );
        }
        let after = EPOCHS.current();
        assert_eq!(after.window, before.window + 2);
        assert_eq!(after.content, before.content);
        assert!(SESSION_SUSPENDED.swap(false, Ordering::SeqCst));
        assert!(!SESSION_SUSPENDED.load(Ordering::SeqCst));
        assert_eq!(DIRTY_KIND.load(Ordering::Relaxed), EVENT_SYSTEM_FOREGROUND);
    }
}
