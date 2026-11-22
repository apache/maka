//! The download state machine: sessions, effects, deadlines and replies.
//!
//! Everything here runs on the engine thread. File work goes through
//! [`Io`], a thread of its own (off WebAssembly), and comes back as
//! [`Signal`]s that [`Downloads::poll`] applies in order. The core never
//! waits for a disk, and a publish and a cancel cannot interleave: whichever
//! the core applies first decides the download, the other is refused with
//! `ERR_NSH_DOWNLOAD_STATE`.
//!
//! A cancellation's answer and its terminal event wait for the platform to
//! confirm its writer stopped **and** for the private staging directory to
//! be cleaned; a cleanup error is reported, not swallowed. A reply timeout
//! is not proof that a writer stopped: it never requests cleanup and keeps
//! the command tracked so a late acknowledgement still cleans up. An end
//! that arrives after a cancel was asked for is that confirmation (a
//! finish or a failure alike), and the cancellation's reason and cleanup
//! stand. A published file is never removed by a later cancel or end.

use std::{
    collections::VecDeque,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

use rustc_hash::FxHashMap;

use super::{
    CancelReason, Decision, DownloadDestination, DownloadEnd, DownloadOffer, DownloadOutcome,
    NOT_MOUNTED, OFFER_TIMEOUT, REPLY_TIMEOUT, WebDownloadSource, WebDownloadState,
    files::{self, PublishError},
    shutdown::DownloadCleanup,
};
use crate::{
    EventPayload, NodeId, PayloadValue,
    element::task::{AnswerSlot, Notify},
};

/// Why a decision still waiting for the app failed when its web view's
/// last download listener was removed: nothing can choose where its file
/// was going any more.
const NO_LISTENER: &str = "the download listener was removed";

/// What the coordinator asks the core to do.
pub(crate) enum Effect {
    /// Deliver an event to the view's listeners (or JS).
    Event {
        node: NodeId,
        kind: crate::EventKind,
        payload: EventPayload,
    },
    /// Send an operation, and track its reply as `track`.
    Command {
        node: NodeId,
        operation: crate::webview::WebViewOperation,
        track: Track,
    },
    /// Resolve a decision's answer.
    Answer {
        slot: AnswerSlot<Result<(), String>>,
        result: Result<(), String>,
    },
}

/// How a reply to a download command is handled.
#[derive(Clone, Debug)]
pub(crate) struct Track {
    key: Key,
    kind: CommandKind,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CommandKind {
    Start,
    Cancel,
}

/// One download's identity: the view it belongs to and the platform's id
/// for it.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct Key {
    pub(crate) node: NodeId,
    pub(crate) id: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Mode {
    /// `on_download` alone: the file goes to the app's data directory.
    Automatic,
    /// `on_download_pending`: the app chooses the destination.
    Manual,
    /// Neither listener: the platform keeps its own behavior (an offer
    /// that arrives anyway is cancelled).
    None,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    /// A manual offer, waiting for the app's decision.
    Offered,
    /// The destination is being staged.
    Staging,
    /// `StartDownload` sent, waiting for its reply.
    Starting,
    /// The writer is running.
    Running,
    /// The writer stopped; publishing.
    Publishing,
    /// Stopping; waiting for the platform's reply (the only proof its
    /// writer stopped).
    Cancelling,
    /// The writer stopped; the private directory is being cleaned.
    Cleaning,
}

struct Session {
    node: NodeId,
    id: String,
    url: String,
    filename: String,
    mime_type: Option<String>,
    declared: Option<u64>,
    method: Option<String>,
    source: WebDownloadSource,
    destination: Option<PathBuf>,
    overwrite: bool,
    staging: Option<files::Staging>,
    phase: Phase,
    /// The app was told the download ended; never told twice.
    reported: bool,
    /// Why it is ending, for the event reported after the stop.
    terminal_reason: Option<CancelReason>,
    /// A failure whose terminal event waits for the staging cleanup.
    failure: Option<(String, String)>,
    offer_deadline: Option<crate::time::Instant>,
    reply_deadline: Option<crate::time::Instant>,
    accept: Option<AnswerSlot<Result<(), String>>>,
    cancel_answer: Option<AnswerSlot<Result<(), String>>>,
}

#[derive(Clone)]
struct Tracked {
    track: Track,
    deadline: crate::time::Instant,
    /// Its timeout was reported once; the command stays tracked so a late
    /// acknowledgement can still stop/clean up.
    timed_out: bool,
}

enum Signal {
    Staged {
        key: Key,
        result: Result<files::Staging, String>,
    },
    Published {
        key: Key,
        result: Result<u64, PublishError>,
    },
    Cleaned {
        key: Key,
        result: Result<(), String>,
    },
}

enum Job {
    Stage {
        key: Key,
        destination: PathBuf,
        id: String,
        overwrite: bool,
        create_parent: bool,
    },
    Publish {
        key: Key,
        staging: files::Staging,
        destination: PathBuf,
        overwrite: bool,
        declared: Option<u64>,
    },
    Cleanup {
        key: Key,
        staging: files::Staging,
    },
}

/// Keeps the file work off the engine thread and reports it back.
struct Io {
    signals: Arc<Mutex<VecDeque<Signal>>>,
    notify: Arc<Mutex<Option<Notify>>>,
    /// The core is alive: a queued publish aborts (and cleans) once it is
    /// not, and a stage for a dropped core cleans itself.
    alive: Arc<AtomicBool>,
    #[cfg(not(target_arch = "wasm32"))]
    tx: Option<std::sync::mpsc::Sender<Job>>,
}

impl Default for Io {
    fn default() -> Self {
        Self {
            signals: Arc::default(),
            notify: Arc::default(),
            alive: Arc::new(AtomicBool::new(true)),
            #[cfg(not(target_arch = "wasm32"))]
            tx: None,
        }
    }
}

impl Io {
    fn submit(&mut self, job: Job) {
        #[cfg(not(target_arch = "wasm32"))]
        {
            let tx = self.tx.get_or_insert_with(|| {
                let signals = self.signals.clone();
                let notify = self.notify.clone();
                let alive = self.alive.clone();
                let (tx, rx) = std::sync::mpsc::channel::<Job>();
                std::thread::Builder::new()
                    .name("nsh-downloads".into())
                    .spawn(move || {
                        while let Ok(job) = rx.recv() {
                            if let Some(signal) = run(job, &alive) {
                                signals.lock().expect("signals lock").push_back(signal);
                                if let Some(notify) = notify.lock().expect("notify lock").clone() {
                                    notify();
                                }
                            }
                        }
                        // The core is gone and this thread is the only
                        // producer of signals: whatever it left queued is
                        // never taken, so their staged directories are the
                        // thread's to remove. (A push made just before the
                        // sender dropped is still here: the loop above is
                        // the only thing that queues one.)
                        discard(&signals);
                    })
                    .expect("a thread for the downloads' files");
                tx
            });
            if tx.send(job).is_err() {
                log::error!("the download file thread is gone");
            }
        }
        #[cfg(target_arch = "wasm32")]
        {
            if let Some(signal) = run(job, &self.alive) {
                self.signals.lock().expect("signals lock").push_back(signal);
            }
        }
    }

    /// The core is going away with signals still queued (a stage it never
    /// polled): their private directories are removed here too. The
    /// worker's own exit drains what it queues after this.
    fn discard(&self) {
        discard(&self.signals);
    }

    fn take(&mut self) -> Vec<Signal> {
        let mut signals = self.signals.lock().expect("signals lock");
        signals.drain(..).collect()
    }

    fn set_notify(&self, notify: Notify) {
        *self.notify.lock().expect("notify lock") = Some(notify);
    }
}

/// One file job, on whichever thread runs it.
fn run(job: Job, alive: &AtomicBool) -> Option<Signal> {
    match job {
        Job::Stage {
            key,
            destination,
            id,
            overwrite,
            create_parent,
        } => {
            let result = files::stage(&destination, &id, overwrite, create_parent);
            if !alive.load(Ordering::SeqCst) {
                if let Ok(staging) = &result {
                    let _ = files::cleanup(staging);
                }
                return None;
            }
            Some(Signal::Staged { key, result })
        }
        Job::Publish {
            key,
            staging,
            destination,
            overwrite,
            declared,
        } => {
            if !alive.load(Ordering::SeqCst) {
                // The core is gone: never publish for an app that cannot
                // hear of it; the writer already stopped, so cleaning is
                // safe.
                let _ = files::cleanup(&staging);
                return None;
            }
            let result = files::publish(&staging, &destination, overwrite, declared);
            if result.is_ok() {
                let _ = files::cleanup(&staging);
            }
            Some(Signal::Published { key, result })
        }
        Job::Cleanup { key, staging } => Some(Signal::Cleaned {
            key,
            result: files::cleanup(&staging),
        }),
    }
}

/// Drops the signals no core will take. A stage that completed but was
/// never polled owns a private directory no session and no cleanup sink
/// ever learned: it is removed here, after the staging work ended.
fn discard(signals: &Mutex<VecDeque<Signal>>) {
    let queued = std::mem::take(&mut *signals.lock().expect("signals lock"));
    for signal in queued {
        if let Signal::Staged {
            result: Ok(staging),
            ..
        } = signal
        {
            let _ = files::cleanup(&staging);
        }
    }
}

/// The downloads of one core: the session state machine and the file work.
#[derive(Default)]
pub(crate) struct Downloads {
    sessions: FxHashMap<Key, Session>,
    /// The commands whose replies are outstanding, by the core's request
    /// id.
    commands: FxHashMap<u64, Tracked>,
    io: Io,
    /// Where the engine's control handle hands a stop acknowledgement after
    /// the core is gone (the sink outlives this object).
    cleanup: Option<DownloadCleanup>,
}

impl Drop for Downloads {
    fn drop(&mut self) {
        // No app can hear a result any more, and a queued publish must not
        // write a file for a dead core. A session that never sent a writer
        // to the staging directory has nobody in it: its private directory
        // is removed here. One whose writer may still run is left for the
        // platform's stop acknowledgement (the contract requires it before
        // disposal); guessing would unlink under a writer.
        self.io.alive.store(false, Ordering::SeqCst);
        if let Some(cleanup) = &self.cleanup {
            cleanup.close();
        }
        for session in self.sessions.values() {
            if matches!(session.phase, Phase::Offered | Phase::Staging)
                && let Some(staging) = &session.staging
            {
                let _ = files::cleanup(staging);
            }
        }
        // A stage that finished after the last poll is still in the queue:
        // the core never learned its private directory. The worker drains
        // what it queues after this (the sender is this object's alone).
        self.io.discard();
    }
}

impl Downloads {
    pub(crate) fn set_notify(&mut self, notify: Notify) {
        self.io.set_notify(notify);
    }

    /// The engine's cleanup sink: it outlives this object and consumes the
    /// platform's last stop acknowledgement when the engine channel closes.
    pub(crate) fn set_cleanup(&mut self, cleanup: DownloadCleanup) {
        self.cleanup = Some(cleanup);
    }

    /// Removes a finished session; the sink no longer needs to clean it.
    fn remove_session(&mut self, key: &Key) -> Option<Session> {
        let removed = self.sessions.remove(key);
        if let Some(cleanup) = &self.cleanup {
            cleanup.done(key);
        }
        removed
    }

    /// Whether a download command waits under `request` (the id space is
    /// shared with the app's other web view requests).
    pub(crate) fn tracks(&self, request: u64) -> bool {
        self.commands.contains_key(&request)
    }

    /// Registers a command's reply: `request` answers `kind` for `key`.
    pub(crate) fn track(&mut self, request: u64, track: Track) {
        if matches!(track.kind, CommandKind::Cancel)
            && let Some(cleanup) = &self.cleanup
        {
            cleanup.track(request, &track.key);
        }
        self.commands.insert(
            request,
            Tracked {
                track,
                deadline: crate::time::now() + REPLY_TIMEOUT,
                timed_out: false,
            },
        );
    }

    /// The next time something is due, for the engine's wake-up.
    pub(crate) fn deadline(&self) -> Option<crate::time::Instant> {
        self.sessions
            .values()
            .flat_map(|s| [s.offer_deadline, s.reply_deadline])
            .chain(
                self.commands
                    .values()
                    .filter(|c| !c.timed_out)
                    .map(|c| Some(c.deadline)),
            )
            .flatten()
            .min()
    }

    /// The platform offered a download on `node`.
    pub(crate) fn offer(
        &mut self,
        node: NodeId,
        offer: DownloadOffer,
        mode: Mode,
        automatic: Option<DownloadDestination>,
    ) -> Vec<Effect> {
        let key = Key {
            node,
            id: offer.id.clone(),
        };
        if self.sessions.contains_key(&key) {
            log::debug!(
                target: "js",
                "web view: a duplicate offer for download `{}` was dropped",
                offer.id
            );
            return Vec::new();
        }
        let mut session = Session {
            node,
            id: offer.id,
            url: offer.url,
            filename: offer.filename,
            mime_type: offer.mime_type,
            declared: offer.bytes,
            method: offer.method,
            source: offer.source,
            destination: None,
            overwrite: false,
            staging: None,
            phase: Phase::Offered,
            reported: false,
            terminal_reason: None,
            failure: None,
            offer_deadline: None,
            reply_deadline: None,
            accept: None,
            cancel_answer: None,
        };
        let mut effects = Vec::new();
        match mode {
            Mode::Manual => {
                session.offer_deadline = Some(crate::time::now() + OFFER_TIMEOUT);
                let payload = pending_payload(&session);
                effects.push(Effect::Event {
                    node,
                    kind: crate::EventKind::DownloadPending,
                    payload,
                });
            }
            Mode::Automatic => {
                // A response the platform cannot reproduce has no bytes to
                // write: the app hears it failed rather than a guess.
                if session.source == WebDownloadSource::None {
                    effects.push(failed(
                        &mut session,
                        crate::element::codes::DOWNLOAD_DISCARDED,
                        "the platform cannot own this download".into(),
                    ));
                    effects.push(cancel_command(&session));
                    session.phase = Phase::Cancelling;
                } else if let Some(destination) = automatic {
                    let overwrite = destination.overwrite;
                    session.destination = Some(destination.path.clone());
                    session.overwrite = overwrite;
                    session.phase = Phase::Staging;
                    self.io.submit(Job::Stage {
                        key: key.clone(),
                        destination: destination.path,
                        id: session.id.clone(),
                        overwrite,
                        create_parent: true,
                    });
                } else {
                    effects.push(failed(
                        &mut session,
                        crate::element::codes::DOWNLOAD_DESTINATION,
                        "the app has no data directory for downloads".into(),
                    ));
                    effects.push(cancel_command(&session));
                    session.phase = Phase::Cancelling;
                }
            }
            Mode::None => {
                // Nothing listens: release the held transfer, and report
                // nothing (there is no listener to hear it).
                effects.push(cancel_command(&session));
                session.phase = Phase::Cancelling;
                // Nothing listens: no terminal event is due.
                session.reported = true;
                self.sessions.insert(key, session);
                return effects;
            }
        }
        self.sessions.insert(key, session);
        effects
    }

    /// An app decision on a download ([`Action::DownloadDecision`]).
    pub(crate) fn decide(
        &mut self,
        node: NodeId,
        id: &str,
        decision: Decision,
        answer: AnswerSlot<Result<(), String>>,
    ) -> Vec<Effect> {
        let key = Key {
            node,
            id: id.to_owned(),
        };
        if !self.sessions.contains_key(&key) {
            return vec![Effect::Answer {
                slot: answer,
                result: Err(crate::element::codes::DOWNLOAD_STATE.into()),
            }];
        }
        match decision {
            Decision::Accept(destination) => {
                // A response the platform cannot reproduce (Android's
                // DownloadListener) has no bytes NSH can write, even when
                // the app accepts: it can only be cancelled.
                if self
                    .sessions
                    .get(&key)
                    .is_some_and(|session| session.source == WebDownloadSource::None)
                {
                    return vec![Effect::Answer {
                        slot: answer,
                        result: Err(crate::element::codes::DOWNLOAD_DISCARDED.into()),
                    }];
                }
                let key_for_job = key.clone();
                let mut waiting = Some(answer);
                let result = {
                    let session = self.sessions.get_mut(&key).expect("checked above");
                    if session.phase != Phase::Offered {
                        None
                    } else {
                        let overwrite = destination.overwrite;
                        session.destination = Some(destination.path.clone());
                        session.overwrite = overwrite;
                        session.phase = Phase::Staging;
                        session.offer_deadline = None;
                        session.accept = waiting.take();
                        Some(Job::Stage {
                            key: key_for_job,
                            destination: destination.path,
                            id: session.id.clone(),
                            overwrite,
                            create_parent: false,
                        })
                    }
                };
                match result {
                    Some(job) => {
                        self.io.submit(job);
                        Vec::new()
                    }
                    None => vec![Effect::Answer {
                        slot: waiting.expect("the refused accept's answer"),
                        result: Err(crate::element::codes::DOWNLOAD_STATE.into()),
                    }],
                }
            }
            Decision::Cancel => self.cancel(key, answer, CancelReason::App),
        }
    }

    /// Starts stopping a download. Its answer waits for the platform's
    /// stop acknowledgement and the staging cleanup.
    fn cancel(
        &mut self,
        key: Key,
        answer: AnswerSlot<Result<(), String>>,
        reason: CancelReason,
    ) -> Vec<Effect> {
        let Some(session) = self.sessions.get_mut(&key) else {
            return vec![Effect::Answer {
                slot: answer,
                result: Err(crate::element::codes::DOWNLOAD_STATE.into()),
            }];
        };
        match session.phase {
            Phase::Offered | Phase::Staging | Phase::Starting | Phase::Running => {}
            // A finished or publishing download has its file (or is writing
            // it): a late cancel must not touch the destination.
            Phase::Publishing | Phase::Cancelling | Phase::Cleaning => {
                return vec![Effect::Answer {
                    slot: answer,
                    result: Err(crate::element::codes::DOWNLOAD_STATE.into()),
                }];
            }
        }
        let mut effects = Vec::new();
        session.cancel_answer = Some(answer);
        session.terminal_reason = Some(reason);
        // An accept still staging cannot produce a file now.
        if let Some(slot) = session.accept.take() {
            effects.push(Effect::Answer {
                slot,
                result: Err(crate::element::codes::DOWNLOAD_STATE.into()),
            });
        }
        effects.push(cancel_command(session));
        session.phase = Phase::Cancelling;
        session.offer_deadline = None;
        session.reply_deadline = None;
        effects
    }

    /// A `WebViewReply` from the platform.
    pub(crate) fn reply(
        &mut self,
        node: NodeId,
        request: u64,
        result: Result<(), String>,
    ) -> Vec<Effect> {
        // Only the node the command went to may answer it, and a foreign
        // reply must not consume the request.
        let Some(tracked) = self.commands.get(&request).cloned() else {
            return Vec::new();
        };
        if tracked.track.key.node != node {
            log::debug!(
                target: "js",
                "web view: a download reply came from node {node}, not {}",
                tracked.track.key.node
            );
            return Vec::new();
        }
        self.commands.remove(&request);
        // A failed cancel leaves the stop unconfirmed. Keep its registration
        // intact: the platform can report a late success from another thread.
        if !(matches!(tracked.track.kind, CommandKind::Cancel) && result.is_err())
            && let Some(cleanup) = &self.cleanup
        {
            cleanup.untrack(request);
        }
        let key = tracked.track.key.clone();
        let Some(session) = self.sessions.get_mut(&key) else {
            return Vec::new();
        };
        session.reply_deadline = None;
        match tracked.track.kind {
            CommandKind::Start => {
                if session.phase != Phase::Starting {
                    return Vec::new();
                }
                match result {
                    Ok(()) => {
                        session.phase = Phase::Running;
                        let mut effects = Vec::new();
                        if let Some(slot) = session.accept.take() {
                            effects.push(Effect::Answer {
                                slot,
                                result: Ok(()),
                            });
                        }
                        effects.push(Effect::Event {
                            node: session.node,
                            kind: crate::EventKind::Download,
                            payload: download_payload(
                                session,
                                WebDownloadState::Started,
                                None,
                                None,
                                None,
                                None,
                            ),
                        });
                        effects
                    }
                    Err(message) => {
                        let mut effects = Vec::new();
                        if let Some(slot) = session.accept.take() {
                            effects.push(Effect::Answer {
                                slot,
                                result: Err(message.clone()),
                            });
                        }
                        effects.push(failed(
                            session,
                            crate::element::codes::DOWNLOAD_DESTINATION,
                            message,
                        ));
                        effects.push(cancel_command(session));
                        session.phase = Phase::Cancelling;
                        effects
                    }
                }
            }
            CommandKind::Cancel => {
                if session.phase != Phase::Cancelling {
                    return Vec::new();
                }
                if let Err(message) = result {
                    // Not proof that the writer stopped: keep the session
                    // and its staging file until an end or a later reply
                    // says so; the app is told the stop was not confirmed.
                    self.commands.insert(
                        request,
                        Tracked {
                            track: tracked.track.clone(),
                            deadline: crate::time::now() + REPLY_TIMEOUT,
                            timed_out: true,
                        },
                    );
                    if let Some(slot) = session.cancel_answer.take() {
                        return vec![Effect::Answer {
                            slot,
                            result: Err(message.clone()),
                        }];
                    }
                    log::warn!(
                        target: "js",
                        "web view: download `{}` could not confirm it stopped: {message}",
                        session.id
                    );
                    return Vec::new();
                }
                if let Some(cleanup) = &self.cleanup {
                    cleanup.stop(&key);
                }
                stop_confirmed_effects(self, &key)
            }
        }
    }

    /// The transfer ended on the platform's side: how a writer stops, and
    /// the acknowledgement a cancel waits for when it comes after one was
    /// asked for.
    pub(crate) fn end(&mut self, node: NodeId, end: DownloadEnd) -> Vec<Effect> {
        let key = Key { node, id: end.id };
        if !self.sessions.contains_key(&key) {
            return Vec::new();
        }
        // An end settles anything the platform still owed an answer.
        self.commands.retain(|_, tracked| tracked.track.key != key);
        if let Some(cleanup) = &self.cleanup {
            cleanup.stop(&key);
        }
        match end.outcome {
            DownloadOutcome::Finished { .. } => {
                let Some(session) = self.sessions.get_mut(&key) else {
                    return Vec::new();
                };
                if session.phase == Phase::Cancelling {
                    // A writer that stopped after a cancel: this is the
                    // stop acknowledgement. The cancellation stands (it
                    // was asked for before the end, and its reason and
                    // cleanup were decided then), whether or not anything
                    // still listens.
                    return stop_confirmed_effects(self, &key);
                }
                let mut effects = Vec::new();
                match session.phase {
                    Phase::Starting => {
                        // Native setter reentry: the writer already
                        // finished before its Start reply. The platform
                        // did accept the destination and wrote it, so the
                        // app hears `started` first, then the end; the
                        // pending reply is forgotten above and cannot
                        // report a second start.
                        if let Some(slot) = session.accept.take() {
                            effects.push(Effect::Answer {
                                slot,
                                result: Ok(()),
                            });
                        }
                        effects.push(Effect::Event {
                            node: session.node,
                            kind: crate::EventKind::Download,
                            payload: download_payload(
                                session,
                                WebDownloadState::Started,
                                None,
                                None,
                                None,
                                None,
                            ),
                        });
                    }
                    Phase::Running => {}
                    _ => return Vec::new(),
                }
                let (Some(staging), Some(destination)) =
                    (session.staging.clone(), session.destination.clone())
                else {
                    effects.push(failed(
                        session,
                        crate::element::codes::DOWNLOAD_DESTINATION,
                        "the download finished without a staged file".into(),
                    ));
                    self.remove_session(&key);
                    return effects;
                };
                session.phase = Phase::Publishing;
                self.io.submit(Job::Publish {
                    key: key.clone(),
                    staging,
                    destination,
                    overwrite: session.overwrite,
                    declared: session.declared,
                });
                effects
            }
            DownloadOutcome::Failed { code, message } => {
                let code = code
                    .filter(|code| !code.is_empty())
                    .unwrap_or_else(|| crate::element::codes::DOWNLOAD_NETWORK.to_owned());
                let Some(session) = self.sessions.get_mut(&key) else {
                    return Vec::new();
                };
                if session.phase == Phase::Cancelling {
                    // The writer stopped (it failed): the stop a cancel
                    // waits for. The cancel already decided the reason and
                    // the cleanup, and a failure must not replace them.
                    return stop_confirmed_effects(self, &key);
                }
                match session.phase {
                    Phase::Starting | Phase::Running | Phase::Offered | Phase::Staging => {}
                    _ => return Vec::new(),
                }
                let mut effects = Vec::new();
                if let Some(slot) = session.accept.take() {
                    effects.push(Effect::Answer {
                        slot,
                        result: Err(code.clone()),
                    });
                }
                if let Some(staging) = session.staging.clone() {
                    // The terminal event waits for the cleanup.
                    session.failure = Some((code, message));
                    self.io.submit(Job::Cleanup {
                        key: key.clone(),
                        staging,
                    });
                    session.phase = Phase::Cleaning;
                } else {
                    effects.push(failed(session, &code, message));
                    self.remove_session(&key);
                }
                effects
            }
        }
    }

    /// The view `node` is going away: every download it holds or runs is
    /// cancelled ([`CancelReason::Teardown`]). The app hears the cancel
    /// now; the session (and its staging file) stays until the platform
    /// confirms its writer stopped, even though the node is gone.
    pub(crate) fn teardown(&mut self, node: NodeId) -> Vec<Effect> {
        self.cancel_node(node, CancelReason::Teardown, NOT_MOUNTED)
    }

    /// Nothing listens for downloads on `node` any more (its last
    /// `onDownload` / `onDownloadPending` listener was removed): what it
    /// holds or runs stops with [`CancelReason::NoListener`], though the
    /// view itself stays. A decision still waiting for the app is refused:
    /// nothing can hear where its file was going.
    pub(crate) fn lost_listener(&mut self, node: NodeId) -> Vec<Effect> {
        self.cancel_node(node, CancelReason::NoListener, NO_LISTENER)
    }

    /// Cancellable sessions whose node lost its last download listener.
    pub(crate) fn unobserved_nodes(&self, listens: impl Fn(NodeId) -> bool) -> Vec<NodeId> {
        if self.sessions.is_empty() {
            return Vec::new();
        }
        let mut nodes: Vec<NodeId> = self
            .sessions
            .values()
            .filter(|session| {
                !listens(session.node)
                    && matches!(
                        session.phase,
                        Phase::Offered | Phase::Staging | Phase::Starting | Phase::Running
                    )
            })
            .map(|session| session.node)
            .collect();
        nodes.sort_unstable();
        nodes.dedup();
        nodes
    }

    /// Cancels every download of `node` with `reason`, telling decisions
    /// that waited `message`. What a publish or a stop already decided is
    /// left alone.
    fn cancel_node(&mut self, node: NodeId, reason: CancelReason, message: &str) -> Vec<Effect> {
        let keys: Vec<Key> = self
            .sessions
            .iter()
            .filter(|(_, session)| session.node == node)
            .map(|(key, _)| key.clone())
            .collect();
        let mut effects = Vec::new();
        for key in keys {
            let Some(session) = self.sessions.get_mut(&key) else {
                continue;
            };
            match session.phase {
                Phase::Publishing | Phase::Cancelling | Phase::Cleaning => continue,
                Phase::Offered | Phase::Staging | Phase::Starting | Phase::Running => {}
            }
            session.terminal_reason = Some(reason);
            if let Some(slot) = session.accept.take() {
                effects.push(Effect::Answer {
                    slot,
                    result: Err(message.to_owned()),
                });
            }
            effects.push(cancel_command(session));
            session.phase = Phase::Cancelling;
            session.offer_deadline = None;
            session.reply_deadline = None;
        }
        effects
    }

    /// Time passed: unanswered offers and commands.
    pub(crate) fn poll(&mut self, now: crate::time::Instant) -> Vec<Effect> {
        let mut effects = Vec::new();
        for signal in self.io.take() {
            match signal {
                Signal::Staged { key, result } => match result {
                    Ok(staging) => {
                        let start;
                        {
                            let Some(session) = self.sessions.get_mut(&key) else {
                                self.io.submit(Job::Cleanup { key, staging });
                                continue;
                            };
                            session.staging = Some(staging);
                            if let Some(cleanup) = &self.cleanup {
                                let key = Key {
                                    node: session.node,
                                    id: session.id.clone(),
                                };
                                if let Some(staging) = &session.staging {
                                    cleanup.stage(&key, staging);
                                }
                            }
                            if session.phase != Phase::Staging {
                                // Cancelled while staging: keep the file for
                                // the cancel reply's cleanup.
                                continue;
                            }
                            session.phase = Phase::Starting;
                            session.reply_deadline = Some(now + REPLY_TIMEOUT);
                            start = start_command(session);
                        }
                        effects.push(start);
                    }
                    Err(message) => {
                        let Some(session) = self.sessions.get_mut(&key) else {
                            continue;
                        };
                        if session.phase != Phase::Staging {
                            continue;
                        }
                        if let Some(slot) = session.accept.take() {
                            effects.push(Effect::Answer {
                                slot,
                                result: Err(message.clone()),
                            });
                            // Refusing a destination is not refusing the download.
                            // The host can choose another path or cancel the held offer.
                            session.destination = None;
                            session.overwrite = false;
                            session.phase = Phase::Offered;
                            session.offer_deadline = Some(now + OFFER_TIMEOUT);
                            continue;
                        }
                        effects.push(failed(
                            session,
                            crate::element::codes::DOWNLOAD_DESTINATION,
                            message,
                        ));
                        effects.push(cancel_command(session));
                        session.phase = Phase::Cancelling;
                        session.reply_deadline = None;
                    }
                },
                Signal::Published { key, result } => {
                    let finished;
                    {
                        let Some(session) = self.sessions.get_mut(&key) else {
                            continue;
                        };
                        if session.phase != Phase::Publishing {
                            continue;
                        }
                        match result {
                            Ok(bytes) => {
                                finished = download_payload(
                                    session,
                                    WebDownloadState::Finished,
                                    Some(bytes),
                                    None,
                                    None,
                                    None,
                                );
                            }
                            Err(error) => {
                                let (code, message) = match error {
                                    PublishError::Size { actual, declared } => (
                                        crate::element::codes::DOWNLOAD_SIZE,
                                        format!(
                                            "the download wrote {actual} bytes, not {declared}"
                                        ),
                                    ),
                                    PublishError::Destination(message) => {
                                        (crate::element::codes::DOWNLOAD_DESTINATION, message)
                                    }
                                };
                                if let Some(slot) = session.accept.take() {
                                    effects.push(Effect::Answer {
                                        slot,
                                        result: Err(code.to_owned()),
                                    });
                                }
                                // The terminal event waits for the cleanup:
                                // a Failed must mean nothing is left.
                                session.failure = Some((code.to_owned(), message));
                                if let Some(staging) = session.staging.clone() {
                                    self.io.submit(Job::Cleanup {
                                        key: key.clone(),
                                        staging,
                                    });
                                    session.phase = Phase::Cleaning;
                                } else {
                                    self.remove_session(&key);
                                }
                                continue;
                            }
                        }
                    }
                    let mut answer = None;
                    if let Some(session) = self.sessions.get_mut(&key) {
                        session.reported = true;
                        answer = session.accept.take();
                    }
                    if let Some(slot) = answer {
                        effects.push(Effect::Answer {
                            slot,
                            result: Ok(()),
                        });
                    }
                    if let Some(session) = self.remove_session(&key) {
                        effects.push(Effect::Event {
                            node: session.node,
                            kind: crate::EventKind::Download,
                            payload: finished,
                        });
                    }
                }
                Signal::Cleaned { key, result } => {
                    let Some(session) = self.sessions.get_mut(&key) else {
                        continue;
                    };
                    if !matches!(session.phase, Phase::Cleaning | Phase::Cancelling) {
                        continue;
                    }
                    if let Some(slot) = session.cancel_answer.take() {
                        effects.push(Effect::Answer {
                            slot,
                            result: result.clone(),
                        });
                    }
                    let failure = session.failure.take();
                    match result {
                        Ok(()) => {
                            if !session.reported {
                                match failure {
                                    Some((code, message)) => {
                                        effects.push(failed(session, &code, message));
                                    }
                                    None => {
                                        let reason =
                                            session.terminal_reason.unwrap_or(CancelReason::App);
                                        effects.push(cancelled(session, reason));
                                    }
                                }
                            }
                        }
                        Err(cleanup) => {
                            log::warn!(
                                target: "js",
                                "web view download: cleaning download `{}` failed: {cleanup}",
                                session.id
                            );
                            if !session.reported {
                                let (code, message) = failure.unwrap_or_else(|| {
                                    (
                                        crate::element::codes::DOWNLOAD_DESTINATION.to_owned(),
                                        cleanup.clone(),
                                    )
                                });
                                effects.push(failed(
                                    session,
                                    &code,
                                    format!("{message}; the staging cleanup failed: {cleanup}"),
                                ));
                            }
                        }
                    }
                    self.remove_session(&key);
                }
            }
        }

        // An unanswered manual offer is cancelled by the clock. Its event
        // waits for the stop, like an app's cancel.
        let expired: Vec<Key> = self
            .sessions
            .iter()
            .filter(|(_, session)| {
                session.phase == Phase::Offered
                    && session.offer_deadline.is_some_and(|at| at <= now)
            })
            .map(|(key, _)| key.clone())
            .collect();
        for key in expired {
            let Some(session) = self.sessions.get_mut(&key) else {
                continue;
            };
            session.offer_deadline = None;
            session.terminal_reason = Some(CancelReason::Timeout);
            effects.push(cancel_command(session));
            session.phase = Phase::Cancelling;
        }

        // A command the platform never answered.
        let late: Vec<u64> = self
            .commands
            .iter()
            .filter(|(_, tracked)| !tracked.timed_out && tracked.deadline <= now)
            .map(|(request, _)| *request)
            .collect();
        for request in late {
            if let Some(tracked) = self.commands.get_mut(&request) {
                tracked.timed_out = true;
            }
            let Some(tracked) = self.commands.get(&request).cloned() else {
                continue;
            };
            let key = tracked.track.key.clone();
            let Some(session) = self.sessions.get_mut(&key) else {
                continue;
            };
            session.reply_deadline = None;
            match tracked.track.kind {
                CommandKind::Start => {
                    if session.phase != Phase::Starting {
                        continue;
                    }
                    self.commands.remove(&request);
                    if let Some(slot) = session.accept.take() {
                        effects.push(Effect::Answer {
                            slot,
                            result: Err(crate::element::codes::TIMED_OUT.into()),
                        });
                    }
                    effects.push(failed(
                        session,
                        crate::element::codes::TIMED_OUT,
                        "the platform did not answer the download".into(),
                    ));
                    effects.push(cancel_command(session));
                    session.phase = Phase::Cancelling;
                }
                CommandKind::Cancel => {
                    // Silence is not proof the writer stopped: keep the
                    // command tracked for a late acknowledgement, and tell
                    // the app the stop was not confirmed.
                    log::warn!(
                        target: "js",
                        "web view: the platform did not confirm download `{}` stopped",
                        session.id
                    );
                    if let Some(slot) = session.cancel_answer.take() {
                        effects.push(Effect::Answer {
                            slot,
                            result: Err(crate::element::codes::TIMED_OUT.into()),
                        });
                    }
                }
            }
        }
        effects
    }
}

/// The platform confirmed the writer stopped: clean the private directory
/// (or finish at once when there is none).
fn stop_confirmed_effects(downloads: &mut Downloads, key: &Key) -> Vec<Effect> {
    let Some(session) = downloads.sessions.get_mut(key) else {
        return Vec::new();
    };
    if let Some(staging) = session.staging.clone() {
        downloads.io.submit(Job::Cleanup {
            key: key.clone(),
            staging,
        });
        session.phase = Phase::Cleaning;
        Vec::new()
    } else {
        let mut effects = Vec::new();
        if let Some(slot) = session.cancel_answer.take() {
            effects.push(Effect::Answer {
                slot,
                result: Ok(()),
            });
        }
        if !session.reported {
            let reason = session.terminal_reason.unwrap_or(CancelReason::App);
            effects.push(cancelled(session, reason));
        }
        downloads.remove_session(key);
        effects
    }
}

fn failed(session: &mut Session, code: &str, message: String) -> Effect {
    session.reported = true;
    Effect::Event {
        node: session.node,
        kind: crate::EventKind::Download,
        payload: download_payload(
            session,
            WebDownloadState::Failed,
            None,
            Some(message),
            Some(code.to_owned()),
            None,
        ),
    }
}

fn cancelled(session: &mut Session, reason: CancelReason) -> Effect {
    session.reported = true;
    Effect::Event {
        node: session.node,
        kind: crate::EventKind::Download,
        payload: download_payload(
            session,
            WebDownloadState::Cancelled,
            None,
            None,
            None,
            Some(reason),
        ),
    }
}

fn start_command(session: &Session) -> Effect {
    Effect::Command {
        node: session.node,
        operation: crate::webview::WebViewOperation::StartDownload {
            id: session.id.clone(),
            staging: session
                .staging
                .as_ref()
                .map(|staging| staging.path().to_path_buf())
                .unwrap_or_default(),
        },
        track: Track {
            key: Key {
                node: session.node,
                id: session.id.clone(),
            },
            kind: CommandKind::Start,
        },
    }
}

fn cancel_command(session: &Session) -> Effect {
    Effect::Command {
        node: session.node,
        operation: crate::webview::WebViewOperation::CancelDownload {
            id: session.id.clone(),
        },
        track: Track {
            key: Key {
                node: session.node,
                id: session.id.clone(),
            },
            kind: CommandKind::Cancel,
        },
    }
}

fn pending_payload(session: &Session) -> EventPayload {
    EventPayload::Json(serde_json::json!({
        "id": session.id,
        "url": session.url,
        "filename": session.filename,
        "source": session.source.as_str(),
        "mime_type": session.mime_type,
        "bytes": session.declared,
        "method": session.method,
    }))
}

fn download_payload(
    session: &Session,
    state: WebDownloadState,
    bytes: Option<u64>,
    message: Option<String>,
    code: Option<String>,
    reason: Option<CancelReason>,
) -> EventPayload {
    let mut entries = vec![
        ("state", PayloadValue::Str(state.to_string())),
        ("id", PayloadValue::Str(session.id.clone())),
        ("url", PayloadValue::Str(session.url.clone())),
        ("filename", PayloadValue::Str(session.filename.clone())),
        (
            "path",
            PayloadValue::Str(
                session
                    .destination
                    .as_ref()
                    .map_or_else(String::new, |path| path.to_string_lossy().into_owned()),
            ),
        ),
        (
            "source",
            PayloadValue::Str(session.source.as_str().to_owned()),
        ),
    ];
    if let Some(bytes) = bytes {
        entries.push(("bytes", PayloadValue::Number(bytes as f64)));
    }
    if let Some(message) = message {
        entries.push(("message", PayloadValue::Str(message)));
    }
    if let Some(code) = code {
        entries.push(("code", PayloadValue::Str(code)));
    }
    if let Some(reason) = reason {
        entries.push(("reason", PayloadValue::Str(reason.as_str().to_owned())));
    }
    EventPayload::Map(entries)
}

#[cfg(test)]
mod tests {
    use std::{
        path::PathBuf,
        task::{Context, Poll, Waker},
    };

    use super::*;
    use crate::element::Answer;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "nsh-download-coordinator-{}-{name}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn settled<T>(answer: Answer<T>) -> Option<T> {
        let mut answer = std::pin::pin!(answer);
        let waker = Waker::noop();
        let mut cx = Context::from_waker(waker);
        match answer.as_mut().poll(&mut cx) {
            Poll::Ready(value) => Some(value),
            Poll::Pending => None,
        }
    }

    #[test]
    fn a_listener_lost_refuses_the_decision_it_was_waiting_for() {
        let dir = scratch("decision");
        let mut downloads = Downloads::default();
        let node = 2;
        let offer = DownloadOffer {
            id: "d".into(),
            url: "https://example.com/d".into(),
            filename: "d".into(),
            mime_type: None,
            bytes: None,
            method: None,
            source: WebDownloadSource::Transfer,
        };
        assert_eq!(downloads.offer(node, offer, Mode::Manual, None).len(), 1);
        let (answer, slot) = Answer::new();
        downloads.decide(
            node,
            "d",
            Decision::Accept(DownloadDestination::new(dir.join("out.bin"))),
            slot,
        );
        let effects = downloads.lost_listener(node);
        assert!(matches!(
            effects.first(),
            Some(Effect::Answer {
                result: Err(message),
                ..
            }) if message.as_str() == NO_LISTENER
        ));
        assert!(matches!(
            effects.get(1),
            Some(Effect::Command {
                track: Track {
                    kind: CommandKind::Cancel,
                    ..
                },
                ..
            })
        ));
        // What the core does with them: the waiting decision is told why.
        for effect in effects {
            if let Effect::Answer { slot, result } = effect {
                slot.borrow_mut().deliver(result);
            }
        }
        assert_eq!(settled(answer), Some(Err(NO_LISTENER.to_owned())));
        assert!(
            downloads
                .sessions
                .values()
                .all(|session| session.phase == Phase::Cancelling)
        );
        drop(downloads);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
