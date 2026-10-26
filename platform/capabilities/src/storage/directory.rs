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
use super::{Namespace, StoreError};
use crate::call::Scope;
use cap_fs_ext::DirExt;
use cap_std::{ambient_authority, fs::Dir};
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

#[cfg(test)]
mod tests {
    use super::*;
    use maka_plugin_core::scope::Scope as NamespaceScope;
    use std::time::Duration;

    fn scope() -> crate::call::Scope {
        crate::call::Issuer::default()
            .issue(
                crate::call::Identity::Remote {
                    request_id: uuid::Uuid::new_v4(),
                },
                CancellationToken::new(),
            )
            .unwrap()
    }

    #[tokio::test]
    async fn namespaces_survive_generations_and_lost_replies_do_not_abandon_writes() {
        let root = tempfile::tempdir().unwrap();
        let directories = Directories::open(root.path()).unwrap();
        let first = scope();
        let namespace = Namespace::new("example.notes", NamespaceScope::Profile).unwrap();
        let files = directories.bind(&namespace, first.clone()).unwrap();
        files
            .run(|dir, _| dir.write("state", b"old"))
            .await
            .unwrap()
            .unwrap();

        for (package, namespace_scope) in [
            ("example.other", NamespaceScope::Profile),
            ("example.notes", NamespaceScope::Session("one".into())),
        ] {
            let other = scope();
            let isolated_namespace = Namespace::new(package, namespace_scope).unwrap();
            let isolated = directories
                .bind(&isolated_namespace, other.clone())
                .unwrap();
            assert!(
                !isolated
                    .run(|dir, _| dir.try_exists("state"))
                    .await
                    .unwrap()
                    .unwrap()
            );
            other.finish().await.unwrap();
        }
        let same = scope();
        let shared = directories.bind(&namespace, same.clone()).unwrap();
        assert_eq!(
            shared
                .run(|dir, _| dir.read("state"))
                .await
                .unwrap()
                .unwrap(),
            b"old"
        );

        let (started, ready) = tokio::sync::oneshot::channel();
        let (release, waiting) = std::sync::mpsc::channel();
        let pending = files.clone();
        let waiter = tokio::spawn(async move {
            pending
                .run(move |dir, _| {
                    started.send(()).unwrap();
                    waiting.recv_timeout(Duration::from_secs(5)).unwrap();
                    dir.write("state", b"committed")
                })
                .await
        });
        ready.await.unwrap();
        let (reading, entered) = tokio::sync::oneshot::channel();
        let reader_files = files.clone();
        let reader = tokio::spawn(async move {
            reader_files
                .run(move |directory, cancellation| {
                    reading.send(()).unwrap();
                    // Simulate a blocked read between bounded chunks, without timing races.
                    tokio::runtime::Handle::current().block_on(cancellation.cancelled());
                    crate::filesystem::entries::execute(
                        directory,
                        crate::filesystem::entries::Operation::List(
                            crate::filesystem::entries::ListFiles {
                                path: String::new(),
                                after: None,
                                limit: 16,
                            },
                        ),
                        cancellation,
                        None,
                    )
                })
                .await
        });
        entered.await.unwrap();
        waiter.abort();
        first.cancellation.cancel();
        assert!(matches!(
            reader.await.unwrap().unwrap(),
            Err(crate::filesystem::entries::Error::Cancelled)
        ));
        assert!(matches!(
            files.run(|_, _| ()).await,
            Err(StoreError::Retired)
        ));
        assert!(!first.resources.is_idle());
        assert!(
            tokio::time::timeout(Duration::from_millis(20), first.finish())
                .await
                .is_err()
        );
        release.send(()).unwrap();
        first.finish().await.unwrap();
        same.finish().await.unwrap();

        let reopened = Directories::open(root.path()).unwrap();
        let next = scope();
        assert_eq!(
            reopened
                .bind(&namespace, next.clone())
                .unwrap()
                .run(|dir, _| dir.read("state"))
                .await
                .unwrap()
                .unwrap(),
            b"committed"
        );
        assert!(matches!(
            files.run(|_, _| ()).await,
            Err(StoreError::Retired)
        ));
        next.finish().await.unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn private_directory_aliases_cannot_redirect_plugin_writes() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), root.path().join("plugin-data")).unwrap();
        assert!(Directories::open(root.path()).is_err());
        std::fs::remove_file(root.path().join("plugin-data")).unwrap();
        let directories = Directories::open(root.path()).unwrap();
        let owner = scope();
        let namespace = Namespace::new("example.notes", NamespaceScope::Profile).unwrap();
        let files = directories.bind(&namespace, owner.clone()).unwrap();
        std::os::unix::fs::symlink(
            outside.path(),
            root.path().join("plugin-data").join(&files.name),
        )
        .unwrap();
        assert!(
            files
                .run(|dir, _| dir.write("state", b"wrong"))
                .await
                .is_err()
        );
        assert!(!outside.path().join("state").exists());
        owner.finish().await.unwrap();
    }
}
