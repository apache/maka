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

//! Caller-owned lifecycle authority. Execution and resource cleanup stay in the
//! embedding adapter; this module never spawns, aborts, or blocks on user code.

use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};

use serde::Serialize;
use uuid::Uuid;

use crate::{
    Error,
    composition::InstanceId,
    contract::{Contract, Transport},
    plan::{Binding, Instance, Plan, Provider, RemoteCapability},
};

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Origin {
    Local(InstanceId),
    Remote(RemoteCapability),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Activation {
    kernel: Uuid,
    origin: Origin,
    epoch: Uuid,
}

impl Activation {
    pub fn instance(&self) -> &InstanceId {
        match &self.origin {
            Origin::Local(instance) => instance,
            Origin::Remote(target) => &target.instance,
        }
    }
    /// Attachment identity, not transport authentication or a recovery locator.
    pub fn remote_target(&self) -> Option<&RemoteCapability> {
        match &self.origin {
            Origin::Remote(target) => Some(target),
            Origin::Local(_) => None,
        }
    }
    pub fn epoch(&self) -> Uuid {
        self.epoch
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Loading,
    Active,
    Retiring,
}

/// Adapter-supplied actual export. Native values need not implement Send/Sync.
pub struct Published<T> {
    pub contract: Contract,
    pub value: T,
}

struct Registration<T> {
    epoch: Uuid,
    contract: Contract,
    value: Arc<T>,
}

/// A consumer-bound snapshot of one actual registration, never a name resolver.
pub struct Capability<T> {
    consumer: Activation,
    provider: Activation,
    export: String,
    epoch: Uuid,
    _type: std::marker::PhantomData<fn() -> T>,
}

impl<T> Clone for Capability<T> {
    fn clone(&self) -> Self {
        Self {
            consumer: self.consumer.clone(),
            provider: self.provider.clone(),
            export: self.export.clone(),
            epoch: self.epoch,
            _type: std::marker::PhantomData,
        }
    }
}

impl<T> Capability<T> {
    pub fn consumer(&self) -> &Activation {
        &self.consumer
    }
    pub fn provider(&self) -> &Activation {
        &self.provider
    }
    pub fn export(&self) -> &str {
        self.export.as_str()
    }
    pub fn registration_epoch(&self) -> Uuid {
        self.epoch
    }
}

/// Only the trusted executor receives this token. Reply observers receive its
/// ID, not settlement authority. Dropping it does not acknowledge completion.
#[must_use]
pub struct Execution<T> {
    kernel: Uuid,
    id: Uuid,
    provider: Activation,
    value: Arc<T>,
}

impl<T> Execution<T> {
    pub fn id(&self) -> Uuid {
        self.id
    }
    pub fn provider(&self) -> &Activation {
        &self.provider
    }
    pub fn value(&self) -> &T {
        &self.value
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Resource {
    owner: Activation,
    id: Uuid,
}

impl Resource {
    pub fn owner(&self) -> &Activation {
        &self.owner
    }

    pub fn id(&self) -> Uuid {
        self.id
    }
}

struct Work<T> {
    _value: Arc<T>,
    failure: Option<String>,
}
struct OwnedResource {
    label: String,
    failure: Option<String>,
}
struct Live<T> {
    activation: Activation,
    plan: Option<Instance>,
    phase: Phase,
    export_epochs: BTreeMap<String, Uuid>,
    exports: BTreeMap<String, Registration<T>>,
    calls: BTreeMap<Uuid, Work<T>>,
    resources: BTreeMap<Uuid, OwnedResource>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Status {
    pub activation: Activation,
    pub phase: Phase,
    pub calls: usize,
    pub resources: usize,
    pub failures: Vec<String>,
}

/// Host activations and their resources share one runtime per deployment domain.
/// The owner task serializes changes; this kernel does not execute UI modules.
pub struct Runtime<T> {
    identity: Uuid,
    desired: Plan,
    live: BTreeMap<Origin, Live<T>>,
}

impl<T> Runtime<T> {
    pub fn new(plan: Plan) -> Self {
        Self {
            identity: Uuid::new_v4(),
            desired: plan,
            live: BTreeMap::new(),
        }
    }

    /// Input durability belongs to the embedding deployment. Install only a
    /// checked plan after committing its input, then drive retirement/activation.
    /// Immutable derived plan, for executors to compare desired and actual owners.
    pub fn desired(&self) -> &Plan {
        &self.desired
    }

    pub fn install(&mut self, plan: Plan) -> Vec<Activation> {
        let changed: Vec<_> = self
            .live
            .iter()
            .filter(|(origin, live)| match origin {
                Origin::Local(id) => !plan.instances().get(id).is_some_and(|next| {
                    live.plan
                        .as_ref()
                        .is_some_and(|previous| same_instance(previous, next))
                }),
                Origin::Remote(target) => {
                    !remote_expected(&plan, target, &live.exports[&target.export].contract)
                }
            })
            .map(|(_, live)| live.activation.clone())
            .collect();
        self.desired = plan;
        for (origin, live) in &mut self.live {
            if let Origin::Local(id) = origin
                && let Some(next) = self.desired.instances().get(id)
                && live
                    .plan
                    .as_ref()
                    .is_some_and(|previous| same_instance(previous, next))
            {
                live.plan = Some(next.clone());
            }
        }
        let mut retired = Vec::new();
        for activation in changed {
            retired.extend(
                self.retire(&activation)
                    .expect("activation collected from this runtime"),
            );
        }
        retired
    }

    pub fn begin(&mut self, instance: &InstanceId) -> Result<Activation, Error> {
        if self
            .desired
            .instances()
            .get(instance)
            .and_then(Instance::ui_entry)
            .is_some()
        {
            return Err(Error::Lifecycle("UI instances execute in the client"));
        }
        self.begin_instance(instance)
    }

    /// Register a client consumer. Publication checks its live imports without executing UI code.
    pub fn begin_ui_consumer(&mut self, instance: &InstanceId) -> Result<Activation, Error> {
        let plan = self
            .desired
            .instances()
            .get(instance)
            .ok_or(Error::Retired)?;
        if plan.ui_entry().is_none() {
            return Err(Error::Lifecycle("instance has no UI consumer"));
        }
        self.begin_instance(instance)
    }

    fn begin_instance(&mut self, instance: &InstanceId) -> Result<Activation, Error> {
        if self.live.contains_key(&Origin::Local(instance.clone())) {
            return Err(Error::Lifecycle(
                "previous activation has not completed cleanup",
            ));
        }
        let plan = self
            .desired
            .instances()
            .get(instance)
            .filter(|plan| !plan.disabled)
            .ok_or(Error::Retired)?
            .clone();
        if let Some(parent) = &plan.parent {
            self.live
                .get(&Origin::Local(parent.clone()))
                .filter(|parent| parent.phase == Phase::Active)
                .ok_or_else(|| Error::NotReady("instance owner".into()))?;
        }
        let activation = Activation {
            kernel: self.identity,
            origin: Origin::Local(instance.clone()),
            epoch: Uuid::new_v4(),
        };
        self.live.insert(
            Origin::Local(instance.clone()),
            Live {
                activation: activation.clone(),
                export_epochs: plan
                    .host_entry()
                    .into_iter()
                    .flat_map(|entry| entry.exports.keys())
                    .map(|name| (name.clone(), Uuid::new_v4()))
                    .collect(),
                plan: Some(plan),
                phase: Phase::Loading,
                exports: BTreeMap::new(),
                calls: BTreeMap::new(),
                resources: BTreeMap::new(),
            },
        );
        Ok(activation)
    }

    /// Attach an actual transport endpoint, independently of static metadata.
    /// The trusted adapter owns authentication and the remote execution protocol.
    /// Replacing an attachment requires confirmed local work/resource cleanup.
    pub fn attach_remote(
        &mut self,
        target: RemoteCapability,
        registration_epoch: Uuid,
        actual: Published<T>,
    ) -> Result<Activation, Rejected<T>> {
        let origin = Origin::Remote(target.clone());
        let validation = (|| {
            actual.contract.validate()?;
            if registration_epoch.is_nil() || actual.contract.transport != Transport::Remote {
                return Err(Error::Contract(
                    "remote attachment requires an actual transport registration".into(),
                ));
            }
            if self.live.contains_key(&origin) {
                return Err(Error::Lifecycle(
                    "previous remote attachment has not completed cleanup",
                ));
            }
            if !remote_expected(&self.desired, &target, &actual.contract) {
                return Err(Error::Contract(
                    "remote registration does not match desired references".into(),
                ));
            }
            Ok(())
        })();
        if let Err(error) = validation {
            return Err(Rejected {
                error,
                batch: BTreeMap::from([(target.export, actual)]),
            });
        }
        let activation = Activation {
            kernel: self.identity,
            origin: origin.clone(),
            epoch: Uuid::new_v4(),
        };
        self.live.insert(
            origin,
            Live {
                activation: activation.clone(),
                plan: None,
                phase: Phase::Active,
                export_epochs: BTreeMap::new(),
                exports: BTreeMap::from([(
                    target.export,
                    Registration {
                        epoch: registration_epoch,
                        contract: actual.contract,
                        value: Arc::new(actual.value),
                    },
                )]),
                calls: BTreeMap::new(),
                resources: BTreeMap::new(),
            },
        );
        Ok(activation)
    }

    /// Validate the whole actual batch and required runtime dependencies before
    /// making any export visible. Rejected values return to their creator.
    pub fn publish(
        &mut self,
        activation: &Activation,
        batch: BTreeMap<String, Published<T>>,
    ) -> Result<(), Rejected<T>> {
        let validation = (|| {
            let live = self.owner(activation)?;
            if live.phase != Phase::Loading {
                return Err(Error::Lifecycle("activation is not loading"));
            }
            if let Some(entry) = &self.instance(activation)?.entry {
                match entry {
                    crate::plan::InstanceEntry::Host(entry) => {
                        entry.check_exports(&batch, |value| &value.contract)?;
                    }
                    crate::plan::InstanceEntry::Ui(_) if !batch.is_empty() => {
                        return Err(Error::Contract(
                            "UI consumers cannot publish Host exports".into(),
                        ));
                    }
                    crate::plan::InstanceEntry::Ui(_) => {}
                }
                for name in entry.imports().keys() {
                    self.bind(activation, name)?;
                }
            } else if !batch.is_empty() {
                return Err(Error::Contract(
                    "structural instances cannot publish actual exports".into(),
                ));
            }
            Ok(())
        })();
        if let Err(error) = validation {
            return Err(Rejected { error, batch });
        }
        let live = self.live.get_mut(&activation.origin).unwrap();
        live.exports = batch
            .into_iter()
            .map(|(name, published)| {
                let epoch = live.export_epochs[&name];
                (
                    name,
                    Registration {
                        epoch,
                        contract: published.contract,
                        value: Arc::new(published.value),
                    },
                )
            })
            .collect();
        live.phase = Phase::Active;
        Ok(())
    }

    /// Capture an owner's declared export without adding an import dependency.
    /// The capability becomes callable only after successful publication.
    pub fn own_export(&self, owner: &Activation, export: &str) -> Result<Capability<T>, Error> {
        let live = self.owner(owner)?;
        if live.phase == Phase::Retiring {
            return Err(Error::Retired);
        }
        let epoch = *live
            .export_epochs
            .get(export)
            .ok_or_else(|| Error::Contract(format!("undeclared own export: {export}")))?;
        Ok(Capability {
            consumer: owner.clone(),
            provider: owner.clone(),
            export: export.into(),
            epoch,
            _type: std::marker::PhantomData,
        })
    }

    /// Bind during loading or while active. Structural imports are only routing
    /// declarations; executable consumers establish their actual dependencies.
    pub fn bind(&self, consumer: &Activation, import: &str) -> Result<Vec<Capability<T>>, Error> {
        let live = self.owner(consumer)?;
        if live.phase == Phase::Retiring {
            return Err(Error::Retired);
        }
        let plan = self.instance(consumer)?;
        let declaration = plan
            .entry
            .as_ref()
            .and_then(|entry| entry.imports().get(import))
            .ok_or_else(|| {
                Error::Contract(format!(
                    "undeclared executable import: {import} in {}",
                    plan.path.join("/")
                ))
            })?;
        let mut handles = Vec::new();
        for binding in &plan.bindings[import] {
            if let Some(handle) = self.resolve(consumer, binding)? {
                handles.push(handle);
            }
        }
        if !declaration
            .cardinality
            .accepts(handles.len(), handles.len())
        {
            return Err(Error::NotReady(import.into()));
        }
        Ok(handles)
    }

    fn resolve(
        &self,
        consumer: &Activation,
        binding: &Binding,
    ) -> Result<Option<Capability<T>>, Error> {
        let (origin, export) = match &binding.provider {
            Provider::Local { instance, export } => (Origin::Local(instance.clone()), export),
            Provider::Remote { capability } => {
                (Origin::Remote(capability.clone()), &capability.export)
            }
        };
        let Some(live) = self
            .live
            .get(&origin)
            .filter(|live| live.phase == Phase::Active)
        else {
            return Ok(None);
        };
        let Some(registration) = live.exports.get(export) else {
            return Ok(None);
        };
        if !binding.declaration.contract.accepts(&registration.contract) {
            return Err(Error::Contract(format!(
                "actual bound export disagrees: {export}"
            )));
        }
        Ok(Some(Capability {
            consumer: consumer.clone(),
            provider: live.activation.clone(),
            export: export.clone(),
            epoch: registration.epoch,
            _type: std::marker::PhantomData,
        }))
    }

    /// Inspect the current exact registration without accepting work. The
    /// borrowed value cannot outlive this runtime borrow; final admission is
    /// still required after authorization and any asynchronous preparation.
    pub fn inspect(&self, capability: &Capability<T>) -> Result<&T, Error> {
        if self.owner(&capability.consumer)?.phase == Phase::Retiring {
            return Err(Error::Retired);
        }
        let provider = self.owner(&capability.provider)?;
        if provider.phase != Phase::Active {
            return Err(Error::Retired);
        }
        provider
            .exports
            .get(&capability.export)
            .filter(|export| export.epoch == capability.epoch)
            .map(|export| export.value.as_ref())
            .ok_or(Error::Retired)
    }

    /// The embedding performs domain authorization/durable admission in its own
    /// critical section. Invoke this final lifetime check there, after any waits,
    /// before dispatch; a queued capability is not itself accepted work.
    pub fn admit(&mut self, capability: &Capability<T>) -> Result<Execution<T>, Error> {
        self.inspect(capability)?;
        let value = self.owner(&capability.provider)?.exports[&capability.export]
            .value
            .clone();
        let id = Uuid::new_v4();
        self.live
            .get_mut(&capability.provider.origin)
            .unwrap()
            .calls
            .insert(
                id,
                Work {
                    _value: value.clone(),
                    failure: None,
                },
            );
        Ok(Execution {
            kernel: self.identity,
            id,
            provider: capability.provider.clone(),
            value,
        })
    }

    /// Unconfirmed cleanup keeps this execution's ownership. It does not retire
    /// the provider or its consumers; explicit retirement still waits for it.
    pub fn settle(
        &mut self,
        execution: &Execution<T>,
        cleanup: Result<(), String>,
    ) -> Result<(), Error> {
        if execution.kernel != self.identity {
            return Err(Error::Retired);
        }
        let live = self.owner_mut(&execution.provider)?;
        let work = live.calls.get_mut(&execution.id).ok_or(Error::Retired)?;
        match cleanup {
            Ok(()) => {
                live.calls.remove(&execution.id);
                Ok(())
            }
            Err(reason) => {
                work.failure = Some(reason);
                Ok(())
            }
        }
    }

    pub fn own_resource(
        &mut self,
        owner: &Activation,
        label: impl Into<String>,
    ) -> Result<Resource, Error> {
        let live = self.owner_mut(owner)?;
        if live.phase == Phase::Retiring {
            return Err(Error::Retired);
        }
        let id = Uuid::new_v4();
        live.resources.insert(
            id,
            OwnedResource {
                label: label.into(),
                failure: None,
            },
        );
        Ok(Resource {
            owner: owner.clone(),
            id,
        })
    }

    /// The adapter confirms close or natural completion, not merely cancellation.
    /// Newly retired owners are returned for adapter stop/cleanup delivery.
    pub fn complete_resource(
        &mut self,
        resource: &Resource,
        cleanup: Result<(), String>,
    ) -> Result<Vec<Activation>, Error> {
        let live = self.owner_mut(&resource.owner)?;
        let owned = live.resources.get_mut(&resource.id).ok_or(Error::Retired)?;
        match cleanup {
            Ok(()) => {
                live.resources.remove(&resource.id);
                Ok(Vec::new())
            }
            Err(reason) => {
                owned.failure = Some(reason);
                self.retire(&resource.owner)
            }
        }
    }

    pub fn resources(&self, owner: &Activation) -> Result<Vec<(Resource, &str)>, Error> {
        let live = self.owner(owner)?;
        Ok(live
            .resources
            .iter()
            .map(|(id, resource)| {
                (
                    Resource {
                        owner: owner.clone(),
                        id: *id,
                    },
                    resource.label.as_str(),
                )
            })
            .collect())
    }

    /// Revoke owners and consumers synchronously. The returned activations tell
    /// the adapter which initialization/tasks/resources need stop signals.
    pub fn retire(&mut self, activation: &Activation) -> Result<Vec<Activation>, Error> {
        self.owner(activation)?;
        let mut affected = BTreeSet::from([activation.origin.clone()]);
        loop {
            let before = affected.len();
            for (origin, live) in &self.live {
                let Some(plan) = &live.plan else { continue };
                if plan.dependencies().any(|dependency| {
                    let origin = match dependency {
                        crate::plan::Dependency::Local(id) => Origin::Local(id.clone()),
                        crate::plan::Dependency::Remote(capability) => {
                            Origin::Remote(capability.clone())
                        }
                    };
                    affected.contains(&origin)
                }) {
                    affected.insert(origin.clone());
                }
            }
            if affected.len() == before {
                break;
            }
        }
        let mut retired = Vec::new();
        for id in affected {
            let live = self.live.get_mut(&id).unwrap();
            if live.phase != Phase::Retiring {
                live.phase = Phase::Retiring;
                retired.push(live.activation.clone());
            }
        }
        Ok(retired)
    }

    /// Finish children and confirm all work/resources before replacing an owner.
    pub fn finish_cleanup(&mut self, activation: &Activation) -> Result<(), Error> {
        let live = self.owner(activation)?;
        if live.phase != Phase::Retiring {
            return Err(Error::Lifecycle("owner has not retired"));
        }
        let failures = failures(live);
        if !failures.is_empty() {
            return Err(Error::CleanupFailed(failures));
        }
        if !live.calls.is_empty()
            || !live.resources.is_empty()
            || self.live.values().any(|child| {
                child
                    .plan
                    .as_ref()
                    .and_then(|plan| plan.parent.as_ref())
                    .is_some_and(|parent| Origin::Local(parent.clone()) == activation.origin)
            })
        {
            return Err(Error::CleanupPending);
        }
        self.live.remove(&activation.origin);
        Ok(())
    }

    /// Read lifecycle state without building diagnostic snapshots.
    pub fn phase(&self, activation: &Activation) -> Result<Phase, Error> {
        Ok(self.owner(activation)?.phase)
    }

    pub fn status(&self, activation: &Activation) -> Result<Status, Error> {
        let live = self.owner(activation)?;
        Ok(Status {
            activation: activation.clone(),
            phase: live.phase,
            calls: live.calls.len(),
            resources: live.resources.len(),
            failures: failures(live),
        })
    }

    /// Exact local and remote owners, including those awaiting cleanup.
    pub fn activations(&self) -> impl Iterator<Item = &Activation> {
        self.live.values().map(|live| &live.activation)
    }

    /// Configuration and entry descriptor for this exact local activation.
    /// Retiring owners retain their original plan until cleanup finishes.
    pub fn instance(&self, activation: &Activation) -> Result<&Instance, Error> {
        self.owner(activation)?
            .plan
            .as_ref()
            .ok_or(Error::Lifecycle(
                "remote attachment has no local instance plan",
            ))
    }

    fn owner(&self, activation: &Activation) -> Result<&Live<T>, Error> {
        if activation.kernel != self.identity {
            return Err(Error::Retired);
        }
        self.live
            .get(&activation.origin)
            .filter(|live| live.activation == *activation)
            .ok_or(Error::Retired)
    }
    fn owner_mut(&mut self, activation: &Activation) -> Result<&mut Live<T>, Error> {
        if activation.kernel != self.identity {
            return Err(Error::Retired);
        }
        self.live
            .get_mut(&activation.origin)
            .filter(|live| live.activation == *activation)
            .ok_or(Error::Retired)
    }
}

pub struct Rejected<T> {
    pub error: Error,
    pub batch: BTreeMap<String, Published<T>>,
}

impl<T> std::fmt::Debug for Rejected<T> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Rejected")
            .field("error", &self.error)
            .field("exports", &self.batch.keys().collect::<Vec<_>>())
            .finish()
    }
}

fn failures<T>(live: &Live<T>) -> Vec<String> {
    live.calls
        .values()
        .filter_map(|work| work.failure.clone())
        .chain(
            live.resources
                .values()
                .filter_map(|resource| resource.failure.clone()),
        )
        .collect()
}

fn remote_expected(plan: &Plan, target: &RemoteCapability, actual: &Contract) -> bool {
    let mut found = false;
    for binding in plan.instances().values().flat_map(|instance| {
        instance
            .bindings
            .values()
            .flatten()
            .chain(instance.exports.values())
    }) {
        if matches!(&binding.provider, Provider::Remote {capability} if capability == target) {
            found = true;
            if !binding.declaration.contract.accepts(actual) {
                return false;
            }
        }
    }
    found
}

fn same_instance(left: &Instance, right: &Instance) -> bool {
    left.activation_basis() == right.activation_basis()
}

#[cfg(test)]
mod tests;
