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
use crate::contract::Interface;

/// Independent UI owner. References never redirect across a mount lifetime.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Mount {
    kernel: Uuid,
    id: Uuid,
}
impl Mount {
    pub fn id(&self) -> Uuid {
        self.id
    }
}

pub(super) struct Mounted<T> {
    capability: Capability<T>,
    parent: Option<Mount>,
    root: Option<crate::composition::RootKind>,
    phase: Phase,
    failure: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MountStatus {
    pub mount: Mount,
    pub provider: Activation,
    pub parent: Option<Mount>,
    pub phase: Phase,
    pub failure: Option<String>,
}

impl<T> Runtime<T> {
    /// Bootstrap selects the ordinary component named by the checked launch
    /// binding. This supplies no additional business or surface capability.
    pub fn mount_launch(&mut self) -> Result<Mount, Error> {
        self.mount_root(crate::composition::RootKind::Launch)
    }

    pub fn mount_root(&mut self, kind: crate::composition::RootKind) -> Result<Mount, Error> {
        let binding = self
            .desired
            .root(kind)
            .ok_or_else(|| Error::NotReady("selected root component".into()))?;
        let Provider::Local { instance, .. } = &binding.provider else {
            return Err(Error::NotReady("remote launch component".into()));
        };
        let provider = self
            .live
            .get(&Origin::Local(instance.clone()))
            .ok_or_else(|| Error::NotReady("launch component".into()))?
            .activation
            .clone();
        let capability = self
            .resolve(&provider, binding)?
            .ok_or_else(|| Error::NotReady("launch component".into()))?;
        let mount = self.mount_component(&capability, None)?;
        self.mounts.get_mut(&mount.id).unwrap().root = Some(kind);
        Ok(mount)
    }

    pub fn root_kind(&self, mount: &Mount) -> Result<Option<crate::composition::RootKind>, Error> {
        Ok(self.mounted(mount)?.root)
    }

    pub fn mount_component(
        &mut self,
        capability: &Capability<T>,
        parent: Option<&Mount>,
    ) -> Result<Mount, Error> {
        if capability.provider.remote_target().is_some() {
            return Err(Error::Contract(
                "remote services cannot be mounted as local components".into(),
            ));
        }
        // Admission checks both epochs. Mount creation is its own owner, not
        // accepted business work, so the validation lease settles immediately.
        let execution = self.admit(capability)?;
        self.settle(&execution, Ok(()))?;
        let registration = &self.owner(&capability.provider)?.exports[&capability.export];
        if !matches!(registration.contract.interface, Interface::Component { .. }) {
            return Err(Error::Contract("mount target is not a component".into()));
        }
        if let Some(parent) = parent {
            let owner = self.mounted(parent)?;
            if owner.phase == Phase::Retiring || owner.capability.provider != capability.consumer {
                return Err(Error::Retired);
            }
        }
        let mount = Mount {
            kernel: self.identity,
            id: Uuid::new_v4(),
        };
        self.mounts.insert(
            mount.id,
            Mounted {
                capability: capability.clone(),
                parent: parent.cloned(),
                root: None,
                phase: Phase::Loading,
                failure: None,
            },
        );
        Ok(mount)
    }

    /// Used for initialization and mounted callbacks. The embedding additionally
    /// checks callback/mount revisions and invocation authority before dispatch.
    pub fn admit_mount(&mut self, mount: &Mount) -> Result<Execution<T>, Error> {
        let mounted = self.mounted(mount)?;
        if mounted.phase == Phase::Retiring {
            return Err(Error::Retired);
        }
        let capability = mounted.capability.clone();
        self.admit(&capability)
    }

    pub fn publish_mount(&mut self, mount: &Mount) -> Result<(), Error> {
        let mounted = self.mounted_mut(mount)?;
        if mounted.phase != Phase::Loading {
            return Err(Error::Lifecycle("mount is not loading"));
        }
        mounted.phase = Phase::Active;
        Ok(())
    }

    pub fn retire_mount(&mut self, mount: &Mount) -> Result<Vec<Mount>, Error> {
        self.mounted(mount)?;
        let mut affected = BTreeSet::from([mount.id]);
        loop {
            let before = affected.len();
            for (id, child) in &self.mounts {
                if child
                    .parent
                    .as_ref()
                    .is_some_and(|parent| affected.contains(&parent.id))
                {
                    affected.insert(*id);
                }
            }
            if affected.len() == before {
                break;
            }
        }
        let mut retired = Vec::new();
        for id in affected {
            let mounted = self.mounts.get_mut(&id).unwrap();
            if mounted.phase != Phase::Retiring {
                mounted.phase = Phase::Retiring;
                retired.push(Mount {
                    kernel: self.identity,
                    id,
                });
            }
        }
        Ok(retired)
    }

    /// Only the adapter can confirm that all native resources/subscriptions of
    /// this mount closed. Unknown cleanup preserves this owner and fences reuse.
    pub fn complete_mount(
        &mut self,
        mount: &Mount,
        cleanup: Result<(), String>,
    ) -> Result<(), Error> {
        let mounted = self.mounted_mut(mount)?;
        if mounted.phase != Phase::Retiring {
            return Err(Error::Lifecycle("mount has not retired"));
        }
        if let Err(reason) = cleanup {
            mounted.failure = Some(reason.clone());
            return Err(Error::CleanupFailed(vec![reason]));
        }
        if self
            .mounts
            .values()
            .any(|child| child.parent.as_ref() == Some(mount))
        {
            return Err(Error::CleanupPending);
        }
        self.mounts.remove(&mount.id);
        Ok(())
    }

    pub fn mount_statuses(&self) -> Vec<MountStatus> {
        self.mounts
            .iter()
            .map(|(id, mounted)| MountStatus {
                mount: Mount {
                    kernel: self.identity,
                    id: *id,
                },
                provider: mounted.capability.provider.clone(),
                parent: mounted.parent.clone(),
                phase: mounted.phase,
                failure: mounted.failure.clone(),
            })
            .collect()
    }

    /// Read the original owner directly; rendering must not snapshot every
    /// mount to inspect one node or walk its parent chain.
    pub fn mount_phase(&self, mount: &Mount) -> Result<Phase, Error> {
        Ok(self.mounted(mount)?.phase)
    }

    pub fn retiring_mounts(&self) -> impl Iterator<Item = Mount> + '_ {
        self.mounts.iter().filter_map(|(id, mounted)| {
            (mounted.phase == Phase::Retiring).then_some(Mount {
                kernel: self.identity,
                id: *id,
            })
        })
    }

    pub fn mount_parent(&self, mount: &Mount) -> Result<Option<&Mount>, Error> {
        Ok(self.mounted(mount)?.parent.as_ref())
    }

    pub fn mount_provider(&self, mount: &Mount) -> Result<&Activation, Error> {
        Ok(&self.mounted(mount)?.capability.provider)
    }

    fn mounted(&self, mount: &Mount) -> Result<&Mounted<T>, Error> {
        if mount.kernel != self.identity {
            return Err(Error::Retired);
        }
        self.mounts.get(&mount.id).ok_or(Error::Retired)
    }
    fn mounted_mut(&mut self, mount: &Mount) -> Result<&mut Mounted<T>, Error> {
        if mount.kernel != self.identity {
            return Err(Error::Retired);
        }
        self.mounts.get_mut(&mount.id).ok_or(Error::Retired)
    }
    pub(super) fn mounts_depend_on(&self, activation: &Activation) -> bool {
        self.mounts.values().any(|mounted| {
            &mounted.capability.provider == activation || &mounted.capability.consumer == activation
        })
    }
    pub(super) fn retire_root_mounts(&mut self, kind: crate::composition::RootKind) {
        let mounts: Vec<_> = self
            .mounts
            .iter()
            .filter(|(_, mounted)| mounted.root == Some(kind))
            .map(|(id, _)| Mount {
                kernel: self.identity,
                id: *id,
            })
            .collect();
        for mount in mounts {
            self.retire_mount(&mount)
                .expect("mount collected from runtime");
        }
    }
    pub(super) fn retire_invalid_mounts(&mut self) {
        let mounts: Vec<_> = self
            .mounts
            .iter()
            .filter(|(_, mounted)| {
                self.owner(&mounted.capability.provider)
                    .ok()
                    .is_none_or(|owner| owner.phase == Phase::Retiring)
                    || self
                        .owner(&mounted.capability.consumer)
                        .ok()
                        .is_none_or(|owner| owner.phase == Phase::Retiring)
            })
            .map(|(id, _)| Mount {
                kernel: self.identity,
                id: *id,
            })
            .collect();
        for mount in mounts {
            self.retire_mount(&mount)
                .expect("mount collected from runtime");
        }
    }
}
