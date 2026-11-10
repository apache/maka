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

//! Private files share the KV namespace, not the Host's entire state directory.
use crate::call::Scope;
use cap_fs_ext::DirExt;
use cap_std::{ambient_authority, fs::Dir};
use maka_plugin_core::storage::{Namespace, StoreError};
use sha2::{Digest, Sha256};
use std::{io, path::Path, sync::Arc};
use tokio_util::sync::CancellationToken;

/// Host-created, pinned parent. Opening it performs blocking filesystem I/O.
#[derive(Clone)]
pub struct Directories(Arc<Dir>, std::path::PathBuf);

impl Directories {
    pub fn open(state_root: &Path) -> io::Result<Self> {
        if !state_root.is_absolute() {
            return Err(io::Error::other("plugin data root must be absolute"));
        }
        let root = Dir::open_ambient_dir(state_root, ambient_authority())?;
        Ok(Self(
            Arc::new(child(&root, "plugin-data")?),
            state_root.join("plugin-data"),
        ))
    }

    /// The trusted embedding selects the namespace and admitted call together.
    pub fn bind(&self, namespace: &Namespace, owner: Scope) -> Result<Directory, crate::Error> {
        if owner.cancellation.is_cancelled() {
            return Err(crate::Error::Retired);
        }
        // Hash the framed identity, not platform-sensitive path components.
        let identity = serde_json::to_vec(&(namespace.package(), namespace.scope()))
            .expect("namespace serialization");
        Ok(Directory {
            parent: self.0.clone(),
            path: self.1.clone(),
            name: hex::encode(Sha256::digest(identity)),
            owner,
        })
    }
}

/// A package/scope-bound capability. Entries in that namespace share files.
/// Data survives retirement; new operations do not. Plugins own file formats,
/// transactions and coordination between Entries or external writers.
#[derive(Clone)]
pub struct Directory {
    parent: Arc<Dir>,
    path: std::path::PathBuf,
    name: String,
    owner: Scope,
}

impl Directory {
    /// The same namespace as private-file operations, borrowed read-only by
    /// native algorithms; it retains the original call's lifetime.
    pub async fn read_only(&self) -> Result<crate::filesystem::ReadDirectory, StoreError> {
        let path = self.path.join(&self.name);
        let root = self
            .run(move |directory, _| {
                directory
                    .try_clone()
                    .map(|directory| crate::filesystem::ReadRoot::from_handle(directory, path))
            })
            .await?
            .map_err(|error| StoreError::Unavailable(error.to_string()))?;
        Ok(root.bind_scope(&self.owner))
    }

    /// Run blocking file work under the original call scope. Dropping the reply does
    /// not abandon the worker; retirement waits for it to settle. The callback
    /// must finish its work before returning, not leak handles to unowned tasks.
    /// Long reads must observe the retirement token; mutations must settle any
    /// effect already started. This is trusted code, not an adversarial sandbox.
    pub async fn run<T, F>(&self, operation: F) -> Result<T, StoreError>
    where
        T: Send + 'static,
        F: FnOnce(&Dir, &CancellationToken) -> T + Send + 'static,
    {
        if self.owner.cancellation.is_cancelled() {
            return Err(StoreError::Retired);
        }
        let mut ticket = self
            .owner
            .resources
            .reserve()
            .map_err(|_| StoreError::Retired)?;
        let parent = self.parent.clone();
        let name = self.name.clone();
        let retiring = self.owner.cancellation.clone();
        tokio::task::spawn_blocking(move || {
            ticket.start();
            let result = if retiring.is_cancelled() {
                Err(StoreError::Retired)
            } else {
                child(&parent, &name)
                    .map_err(|error| StoreError::Unavailable(error.to_string()))
                    .map(|directory| operation(&directory, &retiring))
            };
            ticket.complete(Ok(()));
            result
        })
        .await
        .map_err(|error| StoreError::OutcomeUnknown(error.to_string()))?
    }
}

fn child(parent: &Dir, name: &str) -> io::Result<Dir> {
    match parent.create_dir(name) {
        Ok(()) => {
            #[cfg(unix)]
            parent.open(".")?.sync_all()?;
        }
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error),
    }
    parent.open_dir_nofollow(name)
}
