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
    foreground, interactive_desktop, ownership, require_consent, same_control, write_json,
};
use crate::{
    control::{Control, Result, State},
    model::{Policy, Snapshot},
    recorder_lifecycle::{
        CaptureFence, CaptureHealth, CaptureOutcome, EventEpochs, LiveState, drain_events,
    },
    store::Store,
};
use chrono::Utc;
use serde_json::json;
use std::{
    io::Read,
    os::windows::process::CommandExt,
    path::Path,
    process::{Child, Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU32, Ordering},
        mpsc::{self, Receiver},
    },
    time::{Duration, Instant},
};
use windows::Win32::{
    Foundation::HWND,
    UI::{
        Accessibility::{HWINEVENTHOOK, SetWinEventHook, UnhookWinEvent},
        WindowsAndMessaging::{
            DispatchMessageW, EVENT_OBJECT_DESTROY, EVENT_OBJECT_FOCUS, EVENT_OBJECT_NAMECHANGE,
            EVENT_OBJECT_SELECTION, EVENT_OBJECT_SELECTIONWITHIN, EVENT_OBJECT_VALUECHANGE,
            EVENT_SYSTEM_FOREGROUND, GA_ROOT, GetAncestor, MSG, PM_REMOVE, PeekMessageW,
            TranslateMessage, WINEVENT_OUTOFCONTEXT, WINEVENT_SKIPOWNPROCESS,
        },
    },
};

static EPOCHS: EventEpochs = EventEpochs::new();
static DIRTY_KIND: AtomicU32 = AtomicU32::new(EVENT_SYSTEM_FOREGROUND);
const MAX_SNAPSHOT_BYTES: u64 = 128 * 1024;

unsafe extern "system" fn on_event(
    _hook: HWINEVENTHOOK,
    event: u32,
    hwnd: HWND,
    object: i32,
    _child: i32,
    _thread: u32,
    _time: u32,
) {
    if event == EVENT_SYSTEM_FOREGROUND {
        EPOCHS.window_changed();
        DIRTY_KIND.store(event, Ordering::Relaxed);
    } else if event == EVENT_OBJECT_DESTROY && object == 0 {
        // HWND reuse, including an away/back transition during a blocking read.
        EPOCHS.window_changed();
    } else if let Some((current, _)) = foreground()
        && unsafe { GetAncestor(hwnd, GA_ROOT) }.0 as usize == current
    {
        // Same-window document/value/focus ABA invalidates a capture without
        // assigning a new identity to every edit in the window.
        EPOCHS.content_changed();
        DIRTY_KIND.store(event, Ordering::Relaxed);
    }
}

struct Hooks(Vec<HWINEVENTHOOK>);

impl Hooks {
    fn install() -> Result<Self> {
        let mut hooks = Self(Vec::new());
        for (first, last) in [
            (EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND),
            (EVENT_OBJECT_DESTROY, EVENT_OBJECT_DESTROY),
            (EVENT_OBJECT_FOCUS, EVENT_OBJECT_SELECTIONWITHIN),
            (EVENT_OBJECT_NAMECHANGE, EVENT_OBJECT_VALUECHANGE),
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

struct Pending {
    child: Child,
    output: Receiver<std::io::Result<Vec<u8>>>,
    started: Instant,
    fence: CaptureFence,
    source: String,
    control: Control,
    kind: &'static str,
}

impl Pending {
    fn start(
        home: &Path,
        fence: CaptureFence,
        source: &str,
        control: &Control,
        kind: &'static str,
        parent: &ownership::Parent,
        stopping: &AtomicBool,
    ) -> Result<Option<Self>> {
        let target = fence.target;
        let mut command = Command::new(std::env::current_exe()?);
        command
            .args([
                "snapshot",
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
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        Policy::load(home)?;
        let prepared_control = Control::load(home)?;
        if !same_control(control, &prepared_control) {
            return Ok(None);
        }
        // Command construction and policy reads can block; admission belongs
        // immediately beside spawn, retaining the pre-preparation epochs.
        if !admit(home, &prepared_control, fence, parent, stopping)? {
            return Ok(None);
        }
        let mut child = command.spawn()?;
        let stdout = child.stdout.take().ok_or("snapshot_pipe_unavailable")?;
        let (send, output) = mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let result = stdout
                .take(MAX_SNAPSHOT_BYTES + 1)
                .read_to_end(&mut bytes)
                .and_then(|_| {
                    if bytes.len() as u64 > MAX_SNAPSHOT_BYTES {
                        Err(std::io::Error::other("snapshot_output_limit"))
                    } else {
                        Ok(bytes)
                    }
                });
            let _ = send.send(result);
        });
        Ok(Some(Self {
            child,
            output,
            started: Instant::now(),
            fence,
            source: source.to_owned(),
            control: prepared_control,
            kind,
        }))
    }
}

impl Drop for Pending {
    fn drop(&mut self) {
        // Includes timeout, pause, source transition, parse failure and parent exit.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub(super) fn record(home: &Path, parent: ownership::Parent) -> Result<()> {
    let _ownership = ownership::acquire(home)?;
    require_consent(home)?;
    Policy::load(home)?;
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
    let mut segment_started = Instant::now();
    let mut hooks = None;
    let mut pending: Option<Pending> = None;
    let mut source: Option<((usize, u32), u64, String)> = None;
    let mut last_retained = None;
    let mut last_attempt = Instant::now() - Duration::from_secs(3);
    let mut last_heartbeat = Instant::now();
    let mut last_flush = Instant::now();
    let mut health = CaptureHealth::default();
    let outcome = (|| -> Result<()> {
        loop {
            let queue_drained = dispatch_events();
            if !parent.alive() || stopping.load(Ordering::SeqCst) {
                break;
            }
            require_consent(home)?;
            let next = Control::load(home)?;
            if next.state == State::Stopped {
                break;
            }
            let paused = next.paused(Utc::now());
            let available = interactive_desktop();
            if !same_control(&control, &next) || paused || !available {
                pending = None;
                source = None;
                last_retained = None;
                health.observe(CaptureOutcome::Suppressed);
            }
            control = next;
            let state = if paused || !available {
                "paused"
            } else {
                "running"
            };
            publish_health(home, &mut health, state)?;
            if paused || !available {
                hooks = None;
                std::thread::sleep(Duration::from_millis(50));
                continue;
            }
            if hooks.is_none() {
                hooks = Some(Hooks::install()?);
                DIRTY_KIND.store(EVENT_SYSTEM_FOREGROUND, Ordering::Relaxed);
            }
            let target = foreground();
            let epochs = EPOCHS.current();
            if source
                .as_ref()
                .is_some_and(|(old, version, _)| Some(*old) != target || *version != epochs.window)
            {
                source = None;
                last_retained = None;
                health.observe(CaptureOutcome::Suppressed);
            }
            let stale = pending
                .as_ref()
                .is_some_and(|job| Some(job.fence.target) != target || job.fence.epochs != epochs);
            let timed_out = pending
                .as_ref()
                .is_some_and(|job| job.started.elapsed() >= Duration::from_secs(2));
            if stale || timed_out {
                // Health publication and control reads may have blocked since
                // the first pump. Cancellation takes precedence over timeout.
                let failed = if let Some(job) = pending.as_ref().filter(|_| !stale && queue_drained)
                {
                    admit(home, &job.control, job.fence, &parent, &stopping)?
                } else {
                    false
                };
                pending = None;
                last_retained = None;
                health.observe(if failed {
                    CaptureOutcome::Failed
                } else {
                    CaptureOutcome::Suppressed
                });
            }
            // A full queue budget does not establish the source's current epoch.
            if queue_drained
                && let Some(job) = pending.as_mut()
                && let Some(status) = job.child.try_wait()?
            {
                let bytes = job.output.recv_timeout(Duration::from_millis(100));
                // Even failed workers may have been cancelled by a source/pause
                // transition while output was being collected.
                if !admit(home, &job.control, job.fence, &parent, &stopping)? {
                    store.suppress()?;
                    last_retained = None;
                    health.observe(CaptureOutcome::Suppressed);
                } else if !status.success() {
                    health.observe(CaptureOutcome::Failed);
                    last_retained = None;
                } else {
                    let snapshot = bytes
                        .ok()
                        .and_then(|bytes| bytes.ok())
                        .and_then(|bytes| serde_json::from_slice::<Option<Snapshot>>(&bytes).ok());
                    if let Some(Some(snapshot)) = snapshot {
                        if snapshot.window_id != job.fence.target.0 as u64
                            || snapshot.pid != job.fence.target.1
                            || snapshot.source_id != job.source
                        {
                            health.observe(CaptureOutcome::Failed);
                            last_retained = None;
                            pending = None;
                            publish_health(home, &mut health, state)?;
                            continue;
                        }
                        let fingerprint = serde_json::to_string(&snapshot)?;
                        if last_retained.as_ref() != Some(&fingerprint)
                            || job.kind == "window.changed"
                        {
                            let policy = Policy::load(home)?;
                            if store.append_if(&snapshot, job.kind, &policy, Utc::now(), || {
                                admit(home, &job.control, job.fence, &parent, &stopping)
                            })? {
                                last_retained = Some(fingerprint);
                            } else {
                                last_retained = None;
                            }
                        }
                        health.observe(CaptureOutcome::Observed);
                    } else if snapshot.is_some() {
                        store.suppress()?;
                        last_retained = None;
                        health.observe(CaptureOutcome::Suppressed);
                    } else {
                        health.observe(CaptureOutcome::Failed);
                        last_retained = None;
                    }
                }
                pending = None;
            }
            publish_health(home, &mut health, state)?;
            if segment_started.elapsed() >= Duration::from_secs(600) {
                pending = None;
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
            let backoff = if health.failures > 2 { 15 } else { 3 };
            if pending.is_none()
                && last_attempt.elapsed() >= Duration::from_secs(backoff)
                && queue_drained
                && (dirty != 0 || last_heartbeat.elapsed() >= Duration::from_secs(15))
                && let Some(target) = target
            {
                let new_source = source
                    .as_ref()
                    .is_none_or(|(old, version, _)| *old != target || *version != epochs.window);
                if new_source {
                    source = Some((target, epochs.window, uuid::Uuid::new_v4().to_string()));
                }
                let kind = if new_source {
                    "window.changed"
                } else if (EVENT_OBJECT_SELECTION..=EVENT_OBJECT_SELECTIONWITHIN).contains(&dirty) {
                    "selection.changed"
                } else {
                    "ui.changed"
                };
                pending = Pending::start(
                    home,
                    CaptureFence { target, epochs },
                    &source.as_ref().unwrap().2,
                    &control,
                    kind,
                    &parent,
                    &stopping,
                )?;
                if pending.is_some() {
                    DIRTY_KIND.store(0, Ordering::Relaxed);
                    last_attempt = Instant::now();
                    last_heartbeat = Instant::now();
                } else {
                    health.observe(CaptureOutcome::Suppressed);
                    publish_health(home, &mut health, state)?;
                }
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        Ok(())
    })();
    drop(pending);
    drop(hooks);
    store.finish(Utc::now())?;
    write_json(
        &home.join("runtime.json"),
        &json!({
            "state": "stopped", "endedAt": Utc::now(), "captureFailures": health.failures,
        }),
    )?;
    outcome
}
