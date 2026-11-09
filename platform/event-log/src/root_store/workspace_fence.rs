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

//! Physical directory coordination, never filesystem permission or a path locator.
use super::*;
use cap_fs_ext::{DirExt, MetadataExt};
use cap_std::fs::Dir;
use std::{
    ffi::OsString,
    path::{Component, Path},
    sync::{Mutex, OnceLock},
};

#[derive(Clone)]
pub struct RootWorkspace {
    owner: Weak<root::RootOwner>,
    directory: Arc<Dir>,
}
#[derive(Clone)]
pub struct WorkspaceFence {
    registration: Arc<Entry>,
}
pub(super) struct ChildSlot {
    fence: WorkspaceFence,
}
#[derive(Default)]
pub(super) struct Registry {
    entries: Mutex<Vec<Weak<Entry>>>,
}
struct Entry {
    access: Access,
}
enum Access {
    UnknownWork,
    Work(RootWorkspace),
    Exclusive(Vec<RootWorkspace>),
    Child {
        parent: RootWorkspace,
        name: OsString,
        bound: OnceLock<RootWorkspace>,
    },
}
#[derive(Clone, Copy, PartialEq, Eq)]
struct Node {
    device: u64,
    inode: u64,
}
struct Tree {
    leaf: Node,
    ancestors: Vec<Node>,
}
impl Tree {
    fn overlaps(&self, other: &Self) -> bool {
        self.ancestors.contains(&other.leaf) || other.ancestors.contains(&self.leaf)
    }
}
fn node(directory: &Dir) -> Result<Node, StoreError> {
    let metadata = directory.dir_metadata()?;
    if !metadata.is_dir() {
        return Err(invalid("workspace handle is not a directory"));
    }
    Ok(Node {
        device: metadata.dev(),
        inode: metadata.ino(),
    })
}
fn tree(directory: &Dir) -> Result<Tree, StoreError> {
    let leaf = node(directory)?;
    let mut ancestors = vec![leaf];
    let mut current = directory.try_clone()?;
    loop {
        let parent = current.open_parent_dir(cap_std::ambient_authority())?;
        let identity = node(&parent)?;
        if identity == *ancestors.last().expect("leaf") {
            break;
        }
        if ancestors.contains(&identity) {
            return Err(invalid("workspace ancestor cycle"));
        }
        ancestors.push(identity);
        current = parent;
    }
    Ok(Tree { leaf, ancestors })
}
fn invalid(message: &str) -> StoreError {
    StoreError::InvalidTransition(message.into())
}

// All of this observation runs on the original Root's blocking read actor.
struct Observed {
    entry: Arc<Entry>,
    bound: Option<RootWorkspace>,
    kind: ObservedKind,
}
enum ObservedKind {
    UnknownWork,
    Work(Tree),
    Exclusive(Vec<Tree>),
    Child {
        parent: Tree,
        child: Option<Tree>,
        name: OsString,
    },
}
fn observe(entry: Arc<Entry>) -> Result<Observed, StoreError> {
    let mut bound = None;
    let kind = match &entry.access {
        Access::UnknownWork => ObservedKind::UnknownWork,
        Access::Work(workspace) => ObservedKind::Work(tree(&workspace.directory)?),
        Access::Exclusive(workspaces) => ObservedKind::Exclusive(
            workspaces
                .iter()
                .map(|workspace| tree(&workspace.directory))
                .collect::<Result<Vec<_>, _>>()?,
        ),
        Access::Child {
            parent,
            name,
            bound: original,
        } => {
            bound = original.get().cloned();
            let child = match &bound {
                Some(workspace) => Some(tree(&workspace.directory)?),
                None => match parent.directory.open_dir_nofollow(name) {
                    Ok(directory) => Some(tree(&directory)?),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                    Err(error) => return Err(error.into()),
                },
            };
            ObservedKind::Child {
                parent: tree(&parent.directory)?,
                child,
                name: name.clone(),
            }
        }
    };
    Ok(Observed { entry, bound, kind })
}
fn child_directory_conflict(parent: &Tree, child: Option<&Tree>, directory: &Tree) -> bool {
    parent.ancestors.contains(&directory.leaf)
        || child.is_some_and(|child| child.overlaps(directory))
}
fn conflicts(a: &ObservedKind, b: &ObservedKind) -> bool {
    match (a, b) {
        (
            ObservedKind::UnknownWork | ObservedKind::Work(_),
            ObservedKind::UnknownWork | ObservedKind::Work(_),
        ) => false,
        (ObservedKind::UnknownWork, _) | (_, ObservedKind::UnknownWork) => true,
        (ObservedKind::Work(a), ObservedKind::Exclusive(b))
        | (ObservedKind::Exclusive(b), ObservedKind::Work(a)) => b.iter().any(|b| a.overlaps(b)),
        (ObservedKind::Exclusive(a), ObservedKind::Exclusive(b)) => {
            a.iter().any(|a| b.iter().any(|b| a.overlaps(b)))
        }
        (ObservedKind::Child { parent, child, .. }, ObservedKind::Work(directory))
        | (ObservedKind::Work(directory), ObservedKind::Child { parent, child, .. }) => {
            child_directory_conflict(parent, child.as_ref(), directory)
        }
        (ObservedKind::Child { parent, child, .. }, ObservedKind::Exclusive(directories))
        | (ObservedKind::Exclusive(directories), ObservedKind::Child { parent, child, .. }) => {
            directories
                .iter()
                .any(|directory| child_directory_conflict(parent, child.as_ref(), directory))
        }
        (
            ObservedKind::Child {
                parent: a,
                child: ca,
                ..
            },
            ObservedKind::Child {
                parent: b,
                child: cb,
                ..
            },
        ) => {
            ca.as_ref().is_some_and(|child| {
                b.ancestors.contains(&child.leaf)
                    || cb.as_ref().is_some_and(|other| child.overlaps(other))
            }) || cb
                .as_ref()
                .is_some_and(|child| a.ancestors.contains(&child.leaf))
        }
    }
}
impl Registry {
    fn snapshot(&self) -> Vec<Arc<Entry>> {
        let mut entries = self.entries.lock().unwrap();
        let mut live = Vec::new();
        entries.retain(|entry| match entry.upgrade() {
            Some(entry) => {
                live.push(entry);
                true
            }
            None => false,
        });
        live
    }
    fn register(&self, access: Access) -> Result<WorkspaceFence, StoreError> {
        let entry = Arc::new(Entry { access });
        if matches!(entry.access, Access::Work(_) | Access::UnknownWork) {
            let mut entries = self.entries.lock().unwrap();
            let mut live = Vec::new();
            entries.retain(|entry| match entry.upgrade() {
                Some(entry) => {
                    live.push(entry);
                    true
                }
                None => false,
            });
            if live
                .iter()
                .all(|entry| matches!(entry.access, Access::Work(_) | Access::UnknownWork))
            {
                entries.push(Arc::downgrade(&entry));
                drop(entries);
                drop(live);
                return Ok(WorkspaceFence {
                    registration: entry,
                });
            }
            drop(entries);
            drop(live);
        }
        loop {
            let snapshot = self.snapshot();
            let observed = snapshot
                .into_iter()
                .map(observe)
                .collect::<Result<Vec<_>, _>>()?;
            let wanted = observe(entry.clone())?;
            let busy = observed.iter().any(|existing| {
                conflicts(&wanted.kind, &existing.kind) || same_slot(&wanted.kind, &existing.kind)
            });
            let mut entries = self.entries.lock().unwrap();
            let current = entries.iter().filter_map(Weak::upgrade).collect::<Vec<_>>();
            if current.len() != observed.len()
                || current.iter().zip(&observed).any(|(entry, observed)| {
                    !Arc::ptr_eq(entry, &observed.entry) || !observed.unchanged()
                })
            {
                drop(entries);
                continue;
            }
            if busy {
                return Err(StoreError::SessionBusy);
            }
            entries.push(Arc::downgrade(&entry));
            return Ok(WorkspaceFence {
                registration: entry,
            });
        }
    }
}
impl Observed {
    fn unchanged(&self) -> bool {
        match &self.entry.access {
            Access::Child { bound, .. } => match (&self.bound, bound.get()) {
                (None, None) => true,
                (Some(a), Some(b)) => Arc::ptr_eq(&a.directory, &b.directory),
                _ => false,
            },
            _ => true,
        }
    }
}
fn same_slot(a: &ObservedKind, b: &ObservedKind) -> bool {
    match (a, b) {
        (
            ObservedKind::Child {
                parent: a,
                name: na,
                ..
            },
            ObservedKind::Child {
                parent: b,
                name: nb,
                ..
            },
        ) => a.leaf == b.leaf && na == nb,
        _ => false,
    }
}
impl RootWorkspace {
    pub(super) fn directory(&self) -> &Dir {
        &self.directory
    }
    pub(super) fn validate(&self, owner: &Arc<root::RootOwner>) -> Result<(), StoreError> {
        let original = self.owner.upgrade().ok_or(StoreError::ConnectionClosed)?;
        if !Arc::ptr_eq(&original, owner) {
            return Err(invalid("foreign Root workspace"));
        }
        Ok(())
    }
}
impl RootStore {
    /// Trusted assembly supplies an already authorized, opened directory. No
    /// parent descriptor or filesystem access is exposed by this observation.
    pub async fn workspace(&self, directory: Dir) -> Result<RootWorkspace, StoreError> {
        self.require_open()?;
        let owner = self.log.owned_root()?;
        let weak = Arc::downgrade(&owner);
        let log = self.log.scoped(self.log.clone());
        let workspace = log
            .connection
            .read(move |_| {
                owner.validate_current()?;
                node(&directory)?;
                Ok(RootWorkspace {
                    owner: weak,
                    directory: Arc::new(directory),
                })
            })
            .await?;
        self.require_open()?;
        Ok(workspace)
    }
    /// Compare already held directory observations; this neither grants I/O nor
    /// asks the coordination registry whether a different directory is busy.
    pub async fn validate_workspace_fence(
        &self,
        fence: &WorkspaceFence,
        workspace: &RootWorkspace,
    ) -> Result<(), StoreError> {
        self.require_open()?;
        let owner = self.log.owned_root()?;
        fence.validate_owner(&owner)?;
        workspace.validate(&owner)?;
        let fence = fence.clone();
        let workspace = workspace.clone();
        self.log
            .scoped(self.log.clone())
            .connection
            .read(move |_| {
                if node(fence.directory()?)? != node(&workspace.directory)? {
                    return Err(invalid("workspace handle differs from its original fence"));
                }
                Ok(())
            })
            .await
    }

    pub async fn fence_workspace(
        &self,
        workspace: &RootWorkspace,
    ) -> Result<WorkspaceFence, StoreError> {
        self.fence_workspaces(std::slice::from_ref(workspace)).await
    }

    /// One physical scope: aliases and overlapping members never conflict with
    /// each other, only with original scopes already admitted by this Root.
    pub async fn fence_workspaces(
        &self,
        workspaces: &[RootWorkspace],
    ) -> Result<WorkspaceFence, StoreError> {
        self.require_open()?;
        if workspaces.is_empty() {
            return Err(invalid("empty workspace fence"));
        }
        let owner = self.log.owned_root()?;
        for workspace in workspaces {
            workspace.validate(&owner)?;
        }
        let workspaces = workspaces.to_vec();
        let gates = self.gates.clone();
        let log = self.log.scoped(self.log.clone());
        let fence = log
            .connection
            .read(move |_| gates.workspaces.register(Access::Exclusive(workspaces)))
            .await?;
        self.require_open()?;
        Ok(fence)
    }
}
impl SessionStore {
    pub(super) async fn workspace_work_pin(
        &self,
        workspace: Option<&RootWorkspace>,
    ) -> Result<WorkspaceFence, StoreError> {
        let owner = self.owner()?;
        let access = match workspace {
            Some(workspace) => {
                workspace.validate(&owner.owned_root()?)?;
                Access::Work(workspace.clone())
            }
            None => Access::UnknownWork,
        };
        let gates = self.gates.clone();
        owner
            .scoped(owner.clone())
            .connection
            .read(move |_| gates.workspaces.register(access))
            .await
    }
}
impl WorkspaceFence {
    pub(super) fn child_parent(&self) -> Result<(&Dir, &OsString), StoreError> {
        match &self.registration.access {
            Access::Child { parent, name, .. } => Ok((&parent.directory, name)),
            _ => Err(invalid("restore requires its original child slot fence")),
        }
    }
    pub(crate) fn directory(&self) -> Result<&Dir, StoreError> {
        match &self.registration.access {
            Access::Exclusive(workspaces) => match workspaces.as_slice() {
                [workspace] => Ok(&workspace.directory),
                _ => Err(invalid("workspace fence does not name one directory")),
            },
            Access::Child { bound, .. } => bound
                .get()
                .map(|workspace| &*workspace.directory)
                .ok_or_else(|| invalid("workspace child slot is not bound")),
            _ => Err(invalid("workspace fence is not exclusive")),
        }
    }
    pub(crate) fn validate_owner(&self, owner: &Arc<root::RootOwner>) -> Result<(), StoreError> {
        match &self.registration.access {
            Access::Exclusive(workspaces) => {
                for workspace in workspaces {
                    workspace.validate(owner)?;
                }
                Ok(())
            }
            Access::Child { parent, .. } => parent.validate(owner),
            _ => Err(invalid("workspace fence is not exclusive")),
        }
    }
}
impl ChildSlot {
    /// Called on the original physical worker, before namespace or body writes.
    pub(super) fn reserve(
        gates: &Arc<gates::Gates>,
        owner: &Arc<root::RootOwner>,
        parent: Dir,
        name: OsString,
    ) -> Result<Self, StoreError> {
        let mut components = Path::new(&name).components();
        if !matches!(components.next(), Some(Component::Normal(_)))
            || components.next().is_some()
            || name.as_encoded_bytes().contains(&0)
        {
            return Err(invalid("invalid workspace child slot"));
        }
        let parent = RootWorkspace {
            owner: Arc::downgrade(owner),
            directory: Arc::new(parent),
        };
        tree(&parent.directory)?;
        let fence = gates.workspaces.register(Access::Child {
            parent,
            name,
            bound: OnceLock::new(),
        })?;
        Ok(Self { fence })
    }
    pub(super) fn create(&self, gates: &Arc<gates::Gates>) -> Result<(), StoreError> {
        let Access::Child {
            parent,
            name,
            bound,
        } = &self.fence.registration.access
        else {
            unreachable!()
        };
        parent.directory.create_dir(name)?;
        let directory = parent.directory.open_dir_nofollow(name)?;
        let workspace = RootWorkspace {
            owner: parent.owner.clone(),
            directory: Arc::new(directory),
        };
        tree(&workspace.directory)?;
        let registry = gates.workspaces.entries.lock().unwrap();
        let inserted = bound.set(workspace);
        drop(registry);
        inserted.map_err(|_| invalid("workspace child slot already bound"))
    }
    pub(super) fn bind_existing(
        &self,
        gates: &Arc<gates::Gates>,
        directory: Dir,
    ) -> Result<(), StoreError> {
        let Access::Child { parent, bound, .. } = &self.fence.registration.access else {
            unreachable!()
        };
        let workspace = RootWorkspace {
            owner: parent.owner.clone(),
            directory: Arc::new(directory),
        };
        tree(&workspace.directory)?;
        let registry = gates.workspaces.entries.lock().unwrap();
        let inserted = bound.set(workspace);
        drop(registry);
        inserted.map_err(|_| invalid("workspace child slot already bound"))
    }
    pub(super) fn fence(&self) -> WorkspaceFence {
        self.fence.clone()
    }
}
