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

use super::*;
use maka_capabilities::{
    call::Scope,
    process::{self, Chunk, Command, Error, Exit, Handle, Id, Process, Stream},
};
use maka_host_runtime::application::NativeRequest;
use maka_plugin_core::operation::OperationCleanup;
use maka_plugin_core::work::resources::Resources;
use maka_workspace_api::protocol;
use std::sync::{Mutex, OnceLock};
use tokio::sync::{mpsc, oneshot, watch};

pub(super) struct Processes {
    calls: Arc<calls::Calls>,
    configuration: Configuration,
    entries: Mutex<BTreeMap<String, Arc<Entry>>>,
    workers: Arc<Resources>,
    drain: CancellationToken,
}
struct Entry {
    id: Uuid,
    scope: Scope,
    running: Arc<Running>,
}
pub(super) struct Running {
    request: Arc<NativeRequest>,
    original: OnceLock<(Uuid, String)>,
    reference: OnceLock<maka_plugin_core::operation::RecoveryRef>,
    drain_output: CancellationToken,
    chunks: tokio::sync::Mutex<mpsc::Receiver<Chunk>>,
    done: watch::Receiver<Option<Arc<Done>>>,
    root: watch::Receiver<Option<Result<(), String>>>,
}
struct Done {
    exit: Result<Exit, String>,
    job: JobProof,
}
#[derive(Clone, Copy)]
enum JobProof {
    Unconfirmed,
    PreventedBeforeStart,
}
impl JobProof {
    fn cleanup(self) -> OperationCleanup {
        match self {
            Self::Unconfirmed => OperationCleanup::Unconfirmed,
            Self::PreventedBeforeStart => OperationCleanup::Confirmed,
        }
    }
}
impl Processes {
    pub fn new(calls: Arc<calls::Calls>, configuration: Configuration) -> Self {
        Self {
            calls,
            configuration,
            entries: Mutex::default(),
            workers: Arc::default(),
            drain: CancellationToken::new(),
        }
    }
    pub fn is_idle(&self) -> bool {
        self.workers.is_idle()
    }
    pub fn task_cleanup(&self, scope: &Scope) -> Result<OperationCleanup, String> {
        let issued = self.calls.original_issued(scope)?;
        let running = issued.process.lock().unwrap().seal();
        Ok(match running {
            None => OperationCleanup::Confirmed,
            Some(running) => {
                let done = running.done.borrow();
                done.as_ref()
                    .map_or(OperationCleanup::Unconfirmed, |done| done.job.cleanup())
            }
        })
    }
    pub async fn settle_task(&self, scope: &Scope) -> Result<(), String> {
        let running = self
            .calls
            .original_issued(scope)?
            .process
            .lock()
            .unwrap()
            .seal();
        let Some(running) = running else {
            return Ok(());
        };
        running.drain_output.cancel();
        let cleanup = running.detach().await;
        self.entries
            .lock()
            .unwrap()
            .retain(|_, entry| !Arc::ptr_eq(&entry.running, &running));
        cleanup
    }
    pub async fn close_task(&self, scope: &Scope) -> Result<(), String> {
        let running = self
            .calls
            .original_issued(scope)?
            .process
            .lock()
            .unwrap()
            .seal();
        match running {
            Some(running) => close_running(&self.calls, scope, &running)
                .await
                .map_err(|error| error.to_string()),
            None => Ok(()),
        }
    }

    pub async fn close_all(&self) -> Result<(), String> {
        self.drain.cancel();
        let entries = self
            .entries
            .lock()
            .unwrap()
            .values()
            .cloned()
            .collect::<Vec<_>>();
        let mut cleanup = Ok(());
        for entry in entries {
            if let Err(error) = entry.running.detach().await {
                cleanup = Err(error);
            }
        }
        self.entries.lock().unwrap().clear();
        self.workers.settle().await.map_err(|e| e.to_string())?;
        cleanup
    }
    fn bind(&self, scope: Scope, entry: Arc<Entry>) -> Result<Handle, Error> {
        if !Arc::ptr_eq(
            self.calls.issued(&scope).map_err(Error::Invalid)?,
            self.calls.issued(&entry.scope).map_err(Error::Invalid)?,
        ) {
            return Err(Error::Denied);
        }
        Ok(Handle {
            id: Id(entry.id.to_string()),
            io: Arc::new(Bound {
                calls: self.calls.clone(),
                scope,
                entry,
            }),
        })
    }
}
fn identity(scope: &Scope) -> String {
    format!("acp-process-{}", calls::digest(&scope.identity))
}
impl process::Processes for Processes {
    fn spawn(&self, scope: Scope, command: Command) -> BoxFuture<'_, Result<Handle, Error>> {
        Box::pin(async move {
            command.validate()?;
            if self.drain.is_cancelled() {
                return Err(Error::Denied);
            }
            let issued = self.calls.issued(&scope).map_err(Error::Invalid)?.clone();
            let request = Arc::new(
                self.calls
                    .request(
                        &scope,
                        identity(&scope),
                        scope.cancellation.child_token(),
                        Some("run"),
                    )
                    .map_err(Error::Invalid)?,
            );
            let (chunks, receive) = mpsc::channel(8);
            let (done, completed) = watch::channel(None);
            let (root_done, root) = watch::channel(None);
            let (started, waiting) = oneshot::channel();
            let running = Arc::new(Running {
                request: request.clone(),
                original: OnceLock::new(),
                reference: OnceLock::new(),
                drain_output: CancellationToken::new(),
                chunks: tokio::sync::Mutex::new(receive),
                done: completed,
                root,
            });
            let input = serde_json::to_value(protocol::Run {
                executable: command.executable,
                args: command.args,
                env: command.env,
                additional_permissions: self.configuration.permissions.clone(),
                justification: self
                    .configuration
                    .permissions
                    .as_ref()
                    .map(|_| format!("Run {}", self.configuration.agent.display_name)),
            })
            .map_err(|e| Error::Invalid(e.to_string()))?;
            let mut ticket = self
                .workers
                .reserve()
                .map_err(|e| Error::Failed(e.to_string()))?;
            {
                let mut original = issued.process.lock().unwrap();
                if !matches!(*original, calls::ProcessSlot::Available) {
                    return Err(Error::Failed(
                        "A fresh ACP task cannot restart or replace its original private process"
                            .into(),
                    ));
                }
                *original = calls::ProcessSlot::Claimed(running.clone());
            }
            let observing = running.clone();
            let drain = self.drain.clone();
            let calls = self.calls.clone();
            tokio::spawn(async move {
                ticket.start();
                let pumped = CancellationToken::new();
                let work = async {
                    let result = pump(
                        &calls, &request, &issued, &observing, input, chunks, started,
                    )
                    .await;
                    pumped.cancel();
                    result
                };
                let retire = async {
                    tokio::select! {
                        () = drain.cancelled() => request.scope().cancellation.cancel(),
                        () = pumped.cancelled() => {},
                    }
                };
                let (result, ()) = tokio::join!(work, retire);
                done.send_replace(Some(Arc::new(result)));
                let cleanup = request.finish().await;
                match &cleanup {
                    Ok(()) => ticket.complete(Ok(())),
                    Err(error) => ticket.unconfirmed(error.clone(), observing),
                }
                root_done.send_replace(Some(cleanup));
            });
            let id = tokio::select! {
                biased;
                () = scope.cancellation.cancelled() => None,
                result = waiting => result.ok(),
            };
            let Some(id) = id else {
                running.detach().await.map_err(Error::CleanupUnconfirmed)?;
                if let Some(done) = running.done.borrow().as_ref()
                    && let Err(error) = &done.exit
                {
                    return Err(Error::Failed(error.clone()));
                }
                return Err(Error::Failed(
                    "ACP private process was not observed starting".into(),
                ));
            };
            let entry = Arc::new(Entry {
                id,
                scope: scope.clone(),
                running,
            });
            let handle = self.bind(scope, entry.clone())?;
            self.entries.lock().unwrap().insert(id.to_string(), entry);
            Ok(handle)
        })
    }
    fn open(&self, scope: Scope, id: Id) -> Result<Handle, Error> {
        let entry = self
            .entries
            .lock()
            .unwrap()
            .get(&id.0)
            .cloned()
            .ok_or(Error::Denied)?;
        self.bind(scope, entry)
    }
    fn close(&self, id: Id) -> BoxFuture<'_, Result<(), Error>> {
        Box::pin(async move {
            let entry = self.entries.lock().unwrap().get(&id.0).cloned();
            if let Some(entry) = entry {
                explicit_close(&self.calls, &entry).await?;
                self.entries.lock().unwrap().remove(&id.0);
            }
            Ok(())
        })
    }
}
async fn pump(
    calls: &calls::Calls,
    request: &NativeRequest,
    issued: &calls::Issued,
    running: &Running,
    input: Value,
    chunks: mpsc::Sender<Chunk>,
    started: oneshot::Sender<Uuid>,
) -> Done {
    let mut job = JobProof::Unconfirmed;
    let exit = async {
    let resources = maka_host_runtime::application::CallResources::default();
    let task_id = match &issued.role { calls::Role::Runtime { authority, .. } => Some(authority.0.task_id()), calls::Role::Setup(_) => None };
    let recovery = serde_json::json!({
        "kind":"acp_process_start", "version":2,
        "correlation":{"source":issued.origin.scope().identity,"caller":request.scope().identity,
            "taskId":task_id,"requester":issued.origin.requester().instance()},
        "target":{"kind":"import","name":"processes","member":0}, "method":"run", "input":input,
        "resources":{"descriptors":resources.descriptors()?,"reacquisition":{"kind":"none"}},
    });
    eprintln!("acp process: stage=process_begin_enter");
    let mut mutation = request
        .begin_mutation(
            "processes",
            0,
            "run".into(),
            input,
            issued.process_operation()?,
            recovery.clone(),
            resources,
        )?
        .await?;
    eprintln!("acp process: stage=process_begin_return");
    let reference = mutation.reference.clone();
    let lookup = request.lookup_intent(issued.process_operation()?)?;
    eprintln!("acp process: stage=process_intent_lookup_admitted");
    let intent = lookup.await?
        .ok_or("ACP admitted process has no original caller intent")?;
    eprintln!("acp process: stage=process_intent_observed");
    calls.check_process_intent(&intent, issued.process_operation()?, &recovery)?;
    eprintln!("acp process: stage=process_intent_checked");
    if intent.reference != reference { return Err("ACP admitted process reference changed".into()); }
    running.reference.set(reference.clone()).map_err(|_| "ACP process admitted twice")?;
    issued.process_reference(reference.clone(), false).await?;
    eprintln!("acp process: stage=process_reference_recorded");
    let mut started = Some(started);
    let mut saw_progress = false;
    let mut failure = None;
    while let Some(value) = mutation.recv().await {
        saw_progress = true;
        let frame = match serde_json::from_value::<protocol::Progress>(value) {
            Ok(frame) => frame,
            Err(error) => { failure.get_or_insert_with(|| error.to_string()); continue; }
        };
        match frame {
            protocol::Progress::Started { id, resource_ref } => {
                eprintln!("acp process: stage=process_started_observed");
                if id != reference.operation { failure.get_or_insert_with(|| "ACP process id differs from its original operation".into()); continue; }
                if let Err(error) = running
                    .original
                    .set((id, resource_ref.clone()))
                    .map_err(|_| "ACP original process resource changed".to_owned()) {
                    failure.get_or_insert(error); continue;
                }
                if let Err(error) = issued.process_reference(reference.clone(), true).await {
                    failure.get_or_insert(error); continue;
                }
                if let Some(started) = started.take() { let _ = started.send(id); }
            }
            protocol::Progress::Output { stream, bytes } => {
                if started.is_some() {
                    failure.get_or_insert_with(|| "ACP output preceded original process start".into());
                    continue;
                }
                let chunk = Chunk {
                    stream: match stream {
                        protocol::Stream::Stdout => Stream::Stdout,
                        protocol::Stream::Stderr => Stream::Stderr,
                    },
                    bytes,
                };
                tokio::select! {
                    biased;
                    () = request.scope().cancellation.cancelled() => {},
                    () = running.drain_output.cancelled() => {},
                    result = chunks.send(chunk) => if result.is_err() { request.scope().cancellation.cancel(); },
                }
            }
        }
    }
    let reply = mutation.result().await;
    if reply.reference != reference { return Err("ACP original run reply reference changed".into()); }
    if !saw_progress && matches!(&reply.receipt,
        maka_plugin_core::operation::Receipt::Recorded {
            outcome: maka_plugin_core::operation::OperationOutcome::NotExecuted {
                proof: maka_plugin_core::operation::NotExecutedProof::ProviderPreventedBeforeStart },
            cleanup: OperationCleanup::Confirmed,
        }) { job = JobProof::PreventedBeforeStart; }
    {
        use maka_plugin_core::operation::{OperationOutcome, OperationResult, Receipt};
        let (receipt_kind, outcome_kind, receipt_cleanup) = match &reply.receipt {
            Receipt::NotRecorded => ("NotRecorded", "Absent", "Absent"),
            Receipt::Unavailable { .. } => ("Unavailable", "Absent", "Absent"),
            Receipt::Recorded { outcome, cleanup } => (
                "Recorded",
                match outcome {
                    OperationOutcome::Unresolved => "Unresolved",
                    OperationOutcome::Returned {
                        result: OperationResult::Success { .. },
                    } => "ReturnedSuccess",
                    OperationOutcome::Returned {
                        result: OperationResult::Failure { .. },
                    } => "ReturnedFailure",
                    OperationOutcome::NotExecuted { .. } => "NotExecuted",
                    OperationOutcome::Unknown { .. } => "Unknown",
                },
                match cleanup {
                    OperationCleanup::Confirmed => "Confirmed",
                    OperationCleanup::Unconfirmed => "Unconfirmed",
                    OperationCleanup::Failed { .. } => "Failed",
                },
            ),
        };
        eprintln!(
            "acp process: stage=process_completion receipt_kind={receipt_kind} outcome_kind={outcome_kind} receipt_cleanup={receipt_cleanup}"
        );
    }
    if let Some(error) = failure { return Err(error); }
    match serde_json::from_value(calls::returned_outcome(reply.receipt)?)
        .map_err(|e| e.to_string())?
    {
        protocol::Completion::Exited {
            code,
            success,
            stopped,
            error,
        } => {
            match code {
                Some(code) => eprintln!(
                    "acp process: stage=process_exit completion_kind=Exited code={code} success={success} stopped={stopped} error_some={}",
                    error.is_some()
                ),
                None => eprintln!(
                    "acp process: stage=process_exit completion_kind=Exited code=None success={success} stopped={stopped} error_some={}",
                    error.is_some()
                ),
            }
            Ok(Exit {
                code,
                success,
                stopped,
                error,
            })
        }
        protocol::Completion::Failed { message } => {
            eprintln!("acp process: stage=process_exit completion_kind=Failed");
            Err(message)
        }
    }
    }.await;
    Done { exit, job }
}
impl Running {
    pub fn reference(&self) -> Result<&maka_plugin_core::operation::RecoveryRef, String> {
        self.reference
            .get()
            .ok_or_else(|| "ACP original process reference was not observed".into())
    }
    pub fn private_paths(&self) -> Result<maka_external_agent::ports::PrivatePaths, String> {
        let (_, resource) = self
            .original
            .get()
            .ok_or("IsolationUnavailable: original private process resource was not observed")?;
        let root = std::path::Path::new(resource);
        let path = |path: std::path::PathBuf| {
            path.to_str()
                .map(str::to_owned)
                .ok_or_else(|| "Private process input path is not UTF-8".to_owned())
        };
        Ok(maka_external_agent::ports::PrivatePaths {
            working_directory: path(root.join("workspace"))?,
            history_file: path(
                root.join("inputs")
                    .join(maka_agent_authority::executor::HISTORY_FILE),
            )?,
        })
    }
    pub fn original(&self) -> Result<&(Uuid, String), String> {
        self.original
            .get()
            .ok_or_else(|| "Original private process was not observed starting".into())
    }
    async fn completion(&self) -> Result<Arc<Done>, String> {
        let mut done = self.done.clone();
        loop {
            if let Some(done) = done.borrow_and_update().clone() {
                return Ok(done);
            }
            done.changed()
                .await
                .map_err(|_| "ACP original process observer disappeared")?;
        }
    }
    async fn detach(&self) -> Result<(), String> {
        self.request.scope().cancellation.cancel();
        let mut root = self.root.clone();
        loop {
            if let Some(result) = root.borrow_and_update().clone() {
                return result;
            }
            root.changed()
                .await
                .map_err(|_| "ACP original Root observer disappeared")?;
        }
    }
}
async fn close_running(
    calls: &calls::Calls,
    scope: &Scope,
    running: &Arc<Running>,
) -> Result<(), Error> {
    running.drain_output.cancel();
    let setup = calls
        .original_issued(scope)
        .map_err(Error::CleanupUnconfirmed)?
        .is_setup();
    if let Some(done) = running.done.borrow().clone()
        && matches!(done.job, JobProof::PreventedBeforeStart)
    {
        return Ok(());
    }
    let close_error = if !setup || !scope.cancellation.is_cancelled() {
        match calls.close_original(scope, running).await {
            Ok(written) if written.closed => None,
            Ok(_) => Some("Original process received a close signal but has not closed".to_owned()),
            Err(error) => Some(error),
        }
    } else {
        None
    };
    match calls.cleanup_original(scope, running, setup).await {
        Ok(OperationCleanup::Confirmed) => Ok(()),
        Ok(OperationCleanup::Unconfirmed) => Err(Error::CleanupUnconfirmed(
            close_error
                .unwrap_or_else(|| "Original process physical closure is not yet confirmed".into()),
        )),
        Ok(OperationCleanup::Failed { diagnostic }) | Err(diagnostic) => {
            Err(Error::CleanupUnconfirmed(match close_error {
                Some(close) => format!("Original close: {close}; cleanup source: {diagnostic}"),
                None => diagnostic,
            }))
        }
    }
}

async fn explicit_close(calls: &calls::Calls, entry: &Entry) -> Result<(), Error> {
    close_running(calls, &entry.scope, &entry.running).await
}

struct Bound {
    calls: Arc<calls::Calls>,
    scope: Scope,
    entry: Arc<Entry>,
}
impl Bound {
    async fn input(&self, bytes: Option<Vec<u8>>) -> Result<(), Error> {
        self.calls
            .invoke(
                self.scope.clone(),
                format!("acp-input-{}", Uuid::new_v4()),
                self.scope.cancellation.child_token(),
                ("processes", "input"),
                serde_json::to_value(protocol::Input {
                    id: self.entry.id,
                    bytes,
                    additional_permissions: None,
                    justification: None,
                })
                .map_err(|e| Error::Invalid(e.to_string()))?,
                true,
            )
            .await
            .map_err(Error::CleanupUnconfirmed)?;
        Ok(())
    }
}
impl Process for Bound {
    fn write(&self, bytes: Vec<u8>) -> BoxFuture<'_, Result<(), Error>> {
        Box::pin(async move {
            if bytes.is_empty() {
                return self.input(Some(bytes)).await;
            }
            for chunk in bytes.chunks(8192) {
                self.input(Some(chunk.to_vec())).await?;
            }
            Ok(())
        })
    }
    fn end_input(&self) -> BoxFuture<'_, Result<(), Error>> {
        Box::pin(self.input(None))
    }
    fn next(&self) -> BoxFuture<'_, Result<Option<Chunk>, Error>> {
        Box::pin(async move {
            let chunk = self.entry.running.chunks.lock().await.recv().await;
            if chunk.is_none() {
                let done = self
                    .entry
                    .running
                    .completion()
                    .await
                    .map_err(Error::Failed)?;
                if let Err(error) = &done.exit {
                    return Err(Error::CleanupUnconfirmed(error.clone()));
                }
            }
            Ok(chunk)
        })
    }
    fn wait(&self) -> BoxFuture<'_, Result<Exit, Error>> {
        Box::pin(async move {
            let done = self
                .entry
                .running
                .completion()
                .await
                .map_err(Error::Failed)?;
            let exit = done
                .exit
                .as_ref()
                .map_err(|e| Error::CleanupUnconfirmed(e.clone()))?;
            Ok(Exit {
                code: exit.code,
                success: exit.success,
                stopped: exit.stopped,
                error: exit.error.clone(),
            })
        })
    }
    fn close(&self) -> BoxFuture<'_, Result<(), Error>> {
        Box::pin(explicit_close(&self.calls, &self.entry))
    }
}
