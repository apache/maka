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

//! A prepared interpreter is live custody, not a durable grant to run code.
use crate::{CellAbort, CellResult};
use maka_process::lifetime::{ProcessGoneProof, ProcessIdentity, ProcessObservation};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::sync::{oneshot, watch};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

pub const JAVASCRIPT_VM: &str = "maka.javascript.v8-host";
pub const PYTHON_VM: &str = "maka.python.monty-child";
pub const VM_BINDING_VERSION: u32 = 1;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VmBinding {
    pub runtime: String,
    pub version: u32,
    pub descriptor: Value,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProcessBinding {
    process: ProcessIdentity,
    job_nonce: Uuid,
}

impl VmBinding {
    pub fn javascript_host() -> std::io::Result<Self> {
        Self::process(JAVASCRIPT_VM, ProcessIdentity::current()?, Uuid::new_v4())
    }

    pub fn python_child(pid: u32, job_nonce: Uuid) -> std::io::Result<Self> {
        Self::process(PYTHON_VM, ProcessIdentity::capture(pid)?, job_nonce)
    }

    fn process(runtime: &str, process: ProcessIdentity, job_nonce: Uuid) -> std::io::Result<Self> {
        Ok(Self {
            runtime: runtime.into(),
            version: VM_BINDING_VERSION,
            descriptor: serde_json::to_value(ProcessBinding { process, job_nonce })
                .map_err(std::io::Error::other)?,
        })
    }
}

#[derive(Debug)]
pub enum RuntimeVmObservation {
    Alive,
    Gone(RuntimeVmGoneProof),
    Unobservable { diagnostic: String },
}

/// Only the actual read-only OS observation can construct this evidence.
/// It cannot be deserialized, cloned, or used as execution authority.
#[derive(Debug)]
pub struct RuntimeVmGoneProof {
    binding: VmBinding,
    evidence: VmGoneEvidence,
}

#[derive(Debug)]
enum VmGoneEvidence {
    Process(ProcessGoneProof),
    Closed(VmClosureProof),
}

#[derive(Debug)]
struct VmClosureProof {
    _joined: Arc<AtomicBool>,
}

impl RuntimeVmGoneProof {
    pub fn binding(&self) -> &VmBinding {
        &self.binding
    }
    pub fn process(&self) -> Option<&ProcessGoneProof> {
        match &self.evidence {
            VmGoneEvidence::Process(process) => Some(process),
            VmGoneEvidence::Closed(_proof) => None,
        }
    }
}

pub async fn observe_binding(binding: &VmBinding) -> RuntimeVmObservation {
    if binding.version != VM_BINDING_VERSION
        || !matches!(binding.runtime.as_str(), JAVASCRIPT_VM | PYTHON_VM)
    {
        return RuntimeVmObservation::Unobservable {
            diagnostic: "unsupported VM binding contract".into(),
        };
    }
    let descriptor: ProcessBinding = match serde_json::from_value(binding.descriptor.clone()) {
        Ok(descriptor) => descriptor,
        Err(error) => {
            return RuntimeVmObservation::Unobservable {
                diagnostic: format!("invalid VM process binding: {error}"),
            };
        }
    };
    if descriptor.job_nonce.is_nil() {
        return RuntimeVmObservation::Unobservable {
            diagnostic: "invalid VM job nonce".into(),
        };
    }
    let binding = binding.clone();
    match tokio::task::spawn_blocking(move || {
        maka_process::lifetime::observe(&descriptor.process).map(|observation| match observation {
            ProcessObservation::Alive => RuntimeVmObservation::Alive,
            ProcessObservation::Gone(process) => RuntimeVmObservation::Gone(RuntimeVmGoneProof {
                binding,
                evidence: VmGoneEvidence::Process(process),
            }),
            ProcessObservation::Unobservable { diagnostic } => {
                RuntimeVmObservation::Unobservable { diagnostic }
            }
        })
    })
    .await
    {
        Ok(Ok(observation)) => observation,
        Ok(Err(error)) => RuntimeVmObservation::Unobservable {
            diagnostic: error.to_string(),
        },
        Err(error) => RuntimeVmObservation::Unobservable {
            diagnostic: format!("VM process observer failed: {error}"),
        },
    }
}

/// Shared by clones of the actual source runtime, not by Roots or process-global
/// registries. Entries exist only for bindings exposed for canonical recording.
#[derive(Clone)]
pub struct SourceRuntimeOwner(Arc<SourceRuntimeState>);

struct SourceRuntimeState {
    bindings: Mutex<BTreeMap<Uuid, OwnedVm>>,
    physical_changed: watch::Sender<()>,
}

impl Default for SourceRuntimeOwner {
    fn default() -> Self {
        Self(Arc::new(SourceRuntimeState {
            bindings: Mutex::new(BTreeMap::new()),
            physical_changed: watch::channel(()).0,
        }))
    }
}

struct OwnedVm {
    binding: VmBinding,
    joined: Arc<AtomicBool>,
}

struct OwnerLease {
    owner: SourceRuntimeOwner,
    joined: Arc<AtomicBool>,
}

/// The source owner fixes the actual Host identity and nonce. Runtime code can
/// publish readiness after creating its isolate, but cannot substitute a binding.
pub struct VmThreadReady {
    binding: VmBinding,
    sender: oneshot::Sender<VmBinding>,
}

impl VmThreadReady {
    pub fn publish(self) -> Result<(), CellAbort> {
        self.sender
            .send(self.binding)
            .map_err(|_| CellAbort::Cancelled)
    }
}

impl SourceRuntimeOwner {
    /// Subscribe before the first observation. A change only requests a fresh
    /// physical observation; it is not terminal or business-outcome evidence.
    pub fn physical_changes(&self) -> watch::Receiver<()> {
        self.0.physical_changed.subscribe()
    }

    /// Own the actual thread handle through join. The runtime closure creates
    /// its isolate before sending ready, and drops it before returning.
    pub async fn prepare_thread<F>(
        &self,
        name: &str,
        cancellation: CancellationToken,
        run: F,
    ) -> Result<PreparedCell, CellAbort>
    where
        F: FnOnce(VmThreadReady, oneshot::Receiver<()>) -> Result<CellResult, CellAbort>
            + Send
            + 'static,
    {
        let (ready, binding) = oneshot::channel();
        let (start, gate) = oneshot::channel();
        let (reply, result) = oneshot::channel();
        let joined = Arc::new(AtomicBool::new(false));
        let (finished, termination) = oneshot::channel();
        let thread = std::thread::Builder::new()
            .name(name.into())
            .spawn(move || {
                let result = VmBinding::javascript_host()
                    .map_err(|error| {
                        CellAbort::Internal(format!("capture JavaScript VM host: {error}"))
                    })
                    .and_then(|binding| {
                        run(
                            VmThreadReady {
                                binding,
                                sender: ready,
                            },
                            gate,
                        )
                    });
                let _ = finished.send(result);
            })
            .map_err(|error| CellAbort::Internal(format!("cannot start cell worker: {error}")))?;
        let closed = joined.clone();
        let physical_changed = self.0.physical_changed.clone();
        // Wait asynchronously for teardown before joining. Holding a blocking
        // pool thread for a live Cell could starve that Cell's nested effects.
        tokio::spawn(async move {
            let outcome = termination.await;
            let outcome = match tokio::task::spawn_blocking(move || thread.join()).await {
                Ok(Ok(())) => {
                    closed.store(true, Ordering::Release);
                    physical_changed.send_replace(());
                    outcome.unwrap_or_else(|_| Err(owner_lost()))
                }
                Ok(Err(_)) => Err(CellAbort::VmCleanupUnconfirmed(
                    "VM thread join observed a panic".into(),
                )),
                Err(error) => Err(CellAbort::VmCleanupUnconfirmed(format!(
                    "VM join owner lost: {error}"
                ))),
            };
            let _ = reply.send(outcome);
        });
        let mut prepared = PreparedCell::from_owner(binding, start, result, cancellation).await?;
        prepared.owner = Some(OwnerLease {
            owner: self.clone(),
            joined,
        });
        Ok(prepared)
    }

    fn retain(&self, binding: &VmBinding, joined: &Arc<AtomicBool>) {
        let descriptor: ProcessBinding = serde_json::from_value(binding.descriptor.clone())
            .expect("prepared source runtime binding contract");
        let mut entries = self
            .0
            .bindings
            .lock()
            .expect("source VM owner lock poisoned");
        entries
            .entry(descriptor.job_nonce)
            .or_insert_with(|| OwnedVm {
                binding: binding.clone(),
                joined: joined.clone(),
            });
    }

    pub async fn observe_binding(&self, binding: &VmBinding) -> RuntimeVmObservation {
        if binding.runtime == JAVASCRIPT_VM && binding.version == VM_BINDING_VERSION {
            let descriptor: ProcessBinding =
                match serde_json::from_value(binding.descriptor.clone()) {
                    Ok(descriptor) => descriptor,
                    Err(error) => {
                        return RuntimeVmObservation::Unobservable {
                            diagnostic: format!("invalid VM process binding: {error}"),
                        };
                    }
                };
            {
                let entries = match self.0.bindings.lock() {
                    Ok(entries) => entries,
                    Err(_) => {
                        return RuntimeVmObservation::Unobservable {
                            diagnostic: "source VM owner lock poisoned".into(),
                        };
                    }
                };
                if let Some(vm) = entries.get(&descriptor.job_nonce) {
                    if vm.binding != *binding {
                        return RuntimeVmObservation::Unobservable {
                            diagnostic: "VM nonce binding mismatch".into(),
                        };
                    }
                    return if vm.joined.load(Ordering::Acquire) {
                        RuntimeVmObservation::Gone(RuntimeVmGoneProof {
                            binding: binding.clone(),
                            evidence: VmGoneEvidence::Closed(VmClosureProof {
                                _joined: vm.joined.clone(),
                            }),
                        })
                    } else {
                        RuntimeVmObservation::Alive
                    };
                }
            }
        }
        observe_binding(binding).await
    }

    /// Canonical completion/interruption/acceptance ACK releases only this
    /// exact binding. The join watcher never inserts or resurrects entries.
    pub fn release_binding(&self, binding: &VmBinding) -> bool {
        let Ok(descriptor) = serde_json::from_value::<ProcessBinding>(binding.descriptor.clone())
        else {
            return false;
        };
        let mut entries = self
            .0
            .bindings
            .lock()
            .expect("source VM owner lock poisoned");
        if entries
            .get(&descriptor.job_nonce)
            .is_some_and(|vm| vm.binding == *binding)
        {
            entries.remove(&descriptor.job_nonce);
            true
        } else {
            false
        }
    }
}

/// Non-cloneable lease of an already prepared VM and frozen script. Its owner
/// remains alive until execution or cancellation has physically settled.
pub struct PreparedCell {
    binding: VmBinding,
    start: Option<oneshot::Sender<()>>,
    result: Option<oneshot::Receiver<Result<CellResult, CellAbort>>>,
    cancellation: CancellationToken,
    owner: Option<OwnerLease>,
}

impl PreparedCell {
    /// Runtime adapters retain the ready sender until a real VM/child exists.
    /// They send the final result only after VM teardown and effect drain, or
    /// report VmCleanupUnconfirmed. A failed prepare awaits that same owner.
    pub async fn from_owner(
        ready: oneshot::Receiver<VmBinding>,
        start: oneshot::Sender<()>,
        result: oneshot::Receiver<Result<CellResult, CellAbort>>,
        cancellation: CancellationToken,
    ) -> Result<Self, CellAbort> {
        let cancel_on_drop = cancellation.clone().drop_guard();
        match ready.await {
            Ok(binding) => {
                cancel_on_drop.disarm();
                Ok(Self {
                    binding,
                    start: Some(start),
                    result: Some(result),
                    cancellation,
                    owner: None,
                })
            }
            Err(_) => {
                cancellation.cancel();
                drop(start);
                match result.await {
                    Ok(Err(error)) => Err(error),
                    Ok(Ok(_)) => Err(CellAbort::Internal(
                        "VM owner completed without a binding".into(),
                    )),
                    Err(_) => Err(owner_lost()),
                }
            }
        }
    }

    pub fn binding(&self) -> &VmBinding {
        if let Some(lease) = &self.owner {
            lease.owner.retain(&self.binding, &lease.joined);
        }
        &self.binding
    }

    /// Call only after canonical VmBound ACK. This releases the original VM's
    /// gate; neither a replacement script nor another job can be supplied.
    pub async fn execute_bound(mut self) -> Result<CellResult, CellAbort> {
        if !self.cancellation.is_cancelled() {
            if let Some(start) = self.start.take() {
                let _ = start.send(());
            }
        } else {
            self.start.take();
        }
        self.result
            .take()
            .expect("prepared VM result owned")
            .await
            .map_err(|_| owner_lost())?
    }

    /// Prove termination without releasing the script gate. Ordinary execution
    /// diagnostics do not negate teardown; only physical uncertainty does.
    pub async fn abort(mut self) -> Result<(), CellAbort> {
        self.cancellation.cancel();
        self.start.take();
        match self
            .result
            .take()
            .expect("prepared VM result owned")
            .await
            .map_err(|_| owner_lost())?
        {
            Err(error @ CellAbort::VmCleanupUnconfirmed(_)) => Err(error),
            Ok(_) | Err(_) => Ok(()),
        }
    }
}

impl Drop for PreparedCell {
    fn drop(&mut self) {
        self.cancellation.cancel();
    }
}

fn owner_lost() -> CellAbort {
    CellAbort::VmCleanupUnconfirmed("prepared VM owner ended without cleanup confirmation".into())
}
