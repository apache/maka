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

//! Live shell ownership. Durable records remain in the existing RootStore.
mod control;
mod handle;
mod output;
mod pipes;
pub mod request;
pub mod stdin;
mod terminal;
mod worker;
pub use control::Input as ControlInput;
pub use control::{ControlError, ControlErrorKind, WriteReceipt};
pub use handle::{ShellHandle, StopReceipt};
pub use output::{PtyStream, PtyStreamEvent};

use maka_event_log::StoreError;
use maka_event_log::root_store::RootStore;
use maka_plugin_core::shell_run::{ShellObservation, ShellRun};
use maka_plugin_core::terminal::TerminalSize;
use maka_process::pty::PtyCommand;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tokio::sync::{mpsc, watch};
use tokio_util::{sync::CancellationToken, task::TaskTracker};

#[derive(Debug, thiserror::Error)]
pub enum ShellError {
    #[error("shell launch cancelled before admission")]
    CancelledBeforeAdmission,
    #[error("{0}")]
    Rejected(&'static str),
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("PTY replay failed: {0}")]
    Replay(#[source] Arc<std::io::Error>),
    #[error(transparent)]
    Screen(#[from] maka_process::terminal::ScreenError),
    #[error(transparent)]
    Process(#[from] maka_agent_facts::tools::ToolError),
}

type Result<T> = std::result::Result<T, ShellError>;
type Key = (String, String);
type Active = Arc<Mutex<HashMap<Key, ShellHandle>>>;
pub(super) type Update = Option<std::result::Result<Arc<ShellObservation>, Arc<ShellError>>>;

/// At most eight native PTYs; each worker owns its Rust terminal parser.
/// This is an internal execution API, not a client authorization boundary.
pub struct ShellResources {
    log: Arc<RootStore>,
    active: Active,
    workers: TaskTracker,
    shutdown: CancellationToken,
    host_drain: CancellationToken,
}

impl ShellResources {
    pub fn new(log: Arc<RootStore>, host_drain: CancellationToken) -> Self {
        Self {
            log,
            active: Arc::default(),
            workers: TaskTracker::new(),
            shutdown: host_drain.child_token(),
            host_drain,
        }
    }

    /// Acceptance transfers lifetime ownership, not just the caller's future.
    /// Session admission and controller authorization belong to the Host caller.
    pub fn start_pty(
        &self,
        record: ShellRun,
        command: PtyCommand,
        size: TerminalSize,
        custody: Option<Arc<dyn maka_plugin_core::work::WorkCustody>>,
        workspace: Option<std::fs::File>,
    ) -> Result<ShellHandle> {
        record.validate().map_err(ShellError::Rejected)?;
        let work = prepare_work(&self.log, &record, custody, workspace)?;
        if !record.output.is_pty()
            || record
                .timeout_ms
                .is_some_and(|ms| maka_process::validate_timeout(ms).is_err())
        {
            return Err(ShellError::Rejected("invalid PTY launch"));
        }
        // File creation never holds the shared active-map lock.
        let output = output::Output::new(size)?;
        let mut active = self.active.lock().unwrap();
        if self.shutdown.is_cancelled() {
            return Err(ShellError::Rejected("shell resources are draining"));
        }
        let key = (record.session_id.clone(), record.id.clone());
        if active.contains_key(&key) {
            return Err(ShellError::Rejected("shell resource already active"));
        }
        if active
            .values()
            .filter(|handle| handle.pty.is_some())
            .count()
            >= 8
        {
            return Err(ShellError::Rejected("PTY capacity exhausted"));
        }
        let (commands, receiver) = mpsc::channel(8);
        let (updates, snapshot) = watch::channel(None);
        let cancellation = self.shutdown.child_token();
        let stop = Arc::default();
        let handle = ShellHandle {
            control_gate: Arc::default(),
            snapshot,
            cancellation: cancellation.clone(),
            stop: Arc::clone(&stop),
            pty: Some(handle::PtyControl {
                commands,
                output: output.clone(),
            }),
        };
        let owner = Residency {
            key: key.clone(),
            active: self.active.clone(),
            _tracked: self.workers.token(),
        };
        let log = self.log.clone();
        let host_drain = self.host_drain.clone();
        active.insert(key, handle.clone());
        // Release the map before spawn: failure drops Residency on this thread.
        drop(active);
        std::thread::Builder::new()
            .name("maka-pty".into())
            .spawn(move || {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    let runtime = tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()?;
                    runtime.block_on(async {
                        let lease = work_lease(&log, &record, work, cancellation.clone()).await?;
                        let result = worker::Worker {
                            log: lease.store(),
                            record: Arc::new(record),
                            commands: receiver,
                            updates: updates.clone(),
                            cancellation,
                            stop,
                            host_drain: host_drain.clone(),
                            persistence_failed: false,
                            output: output.clone(),
                        }
                        .run(command, size)
                        .await;
                        finish_work(lease, &result);
                        result
                    })
                }));
                match result {
                    Ok(Ok(())) => {}
                    Ok(Err(error)) => {
                        updates.send_replace(Some(Err(Arc::new(error))));
                    }
                    Err(_) => {
                        host_drain.cancel();
                        updates.send_replace(Some(Err(Arc::new(ShellError::Rejected(
                            "PTY worker panicked; outcome unknown",
                        )))));
                    }
                }
                output.close();
                // OS handles and the private scheduler drain before releasing capacity.
                drop(owner);
            })?;
        Ok(handle)
    }

    pub fn get(&self, session: &str, id: &str) -> Option<ShellHandle> {
        self.active
            .lock()
            .unwrap()
            .get(&(session.into(), id.into()))
            .cloned()
    }

    /// Non-interactive background commands use bounded pipes, never a V8.
    pub fn start_pipes(
        &self,
        record: ShellRun,
        command: maka_process::Command,
        custody: Option<Arc<dyn maka_plugin_core::work::WorkCustody>>,
        workspace: Option<std::fs::File>,
    ) -> Result<ShellHandle> {
        use futures_util::FutureExt;
        record.validate().map_err(ShellError::Rejected)?;
        let work = prepare_work(&self.log, &record, custody, workspace)?;
        if record.output.is_pty() {
            return Err(ShellError::Rejected("invalid pipe launch"));
        }
        let scheduler = tokio::runtime::Handle::try_current()
            .map_err(|_| ShellError::Rejected("shell launch requires a runtime"))?;
        let mut active = self.active.lock().unwrap();
        if self.shutdown.is_cancelled() {
            return Err(ShellError::Rejected("shell resources are draining"));
        }
        let key = (record.session_id.clone(), record.id.clone());
        if active.contains_key(&key) {
            return Err(ShellError::Rejected("shell resource already active"));
        }
        if active
            .values()
            .filter(|handle| handle.pty.is_none())
            .count()
            >= 64
        {
            return Err(ShellError::Rejected("background pipe capacity exhausted"));
        }
        let cancellation = self.shutdown.child_token();
        let process = command.observe(record.timeout_ms, cancellation.clone())?;
        let (updates, snapshot) = watch::channel(None);
        let stop = Arc::default();
        let handle = ShellHandle {
            control_gate: Arc::default(),
            snapshot,
            cancellation: cancellation.clone(),
            stop: Arc::clone(&stop),
            pty: None,
        };
        let owner = Residency {
            key: key.clone(),
            active: self.active.clone(),
            _tracked: self.workers.token(),
        };
        let log = self.log.clone();
        let drain = self.host_drain.clone();
        active.insert(key, handle.clone());
        drop(active);
        scheduler.spawn(async move {
            let _owner = owner;
            let result = std::panic::AssertUnwindSafe(async {
                let lease = work_lease(&log, &record, work, cancellation.clone()).await?;
                let result = pipes::run(
                    lease.store(),
                    record,
                    process,
                    &updates,
                    &cancellation,
                    &drain,
                    &stop,
                )
                .await;
                finish_work(lease, &result);
                result
            })
            .catch_unwind()
            .await;
            let error = match result {
                Ok(Ok(())) => return,
                Ok(Err(error)) => error,
                Err(_) => {
                    drain.cancel();
                    ShellError::Rejected("pipe worker panicked; outcome unknown")
                }
            };
            updates.send_replace(Some(Err(Arc::new(error))));
        });
        Ok(handle)
    }

    pub fn active_count(&self) -> usize {
        self.active.lock().unwrap().len()
    }

    pub async fn shutdown(&self) {
        {
            let _admission = self.active.lock().unwrap();
            self.shutdown.cancel();
            self.workers.close();
        }
        self.workers.wait().await;
    }
}

impl Drop for ShellResources {
    fn drop(&mut self) {
        self.shutdown.cancel();
    }
}

struct Residency {
    key: Key,
    active: Active,
    _tracked: tokio_util::task::task_tracker::TaskTrackerToken,
}
impl Drop for Residency {
    fn drop(&mut self) {
        self.active.lock().unwrap().remove(&self.key);
    }
}

fn finish_work(lease: maka_event_log::root_store::SessionWorkLease, result: &Result<()>) {
    if matches!(
        result,
        Err(ShellError::Process(
            maka_agent_facts::tools::ToolError::CleanupUnconfirmed(_)
                | maka_agent_facts::tools::ToolError::OperationCleanupUnconfirmed { .. }
        ))
    ) {
        lease.retain_unconfirmed(());
    } else {
        lease.finish();
    }
}

// Before a worker starts, admission failures and failed spawning own no physical
// effect. Once taken, the worker's lease retains uncertainty on an unchecked Drop.
struct PreparedWork {
    lease: Option<maka_event_log::root_store::SessionWorkLease>,
    workspace: Option<std::fs::File>,
}
impl Drop for PreparedWork {
    fn drop(&mut self) {
        if let Some(lease) = self.lease.take() {
            lease.finish();
        }
    }
}
fn prepare_work(
    root: &RootStore,
    record: &ShellRun,
    custody: Option<Arc<dyn maka_plugin_core::work::WorkCustody>>,
    workspace: Option<std::fs::File>,
) -> Result<PreparedWork> {
    // Capture the real child before returning; a background worker may first
    // poll after its original observer has finished.
    let lease = custody
        .map(|custody| root.fork_work(custody.as_ref(), &record.session_id))
        .transpose()?;
    Ok(PreparedWork {
        workspace: if lease.is_none() { workspace } else { None },
        lease,
    })
}
async fn work_lease(
    root: &RootStore,
    record: &ShellRun,
    mut work: PreparedWork,
    cancellation: CancellationToken,
) -> Result<maka_event_log::root_store::SessionWorkLease> {
    if let Some(lease) = work.lease.take() {
        return Ok(lease);
    }
    // This pins only the declared primary workspace, not every writable path
    // permitted by the command's sandbox or DangerFullAccess.
    let workspace = match work.workspace.take() {
        Some(directory) => Some(
            root.workspace(cap_std::fs::Dir::from_std_file(directory))
                .await?,
        ),
        None => None,
    };
    let session = root.session(&record.session_id).await?;
    let scope = match &workspace {
        Some(workspace) => {
            session
                .work_scope_in(Some(record.permissions.basis), workspace)
                .await?
        }
        None => session.work_scope(Some(record.permissions.basis)).await?,
    };
    let (lease, _) = scope.accept(cancellation);
    Ok(lease)
}
