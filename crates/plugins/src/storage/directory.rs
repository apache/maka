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
use crate::fiber::Context;
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

    /// Bind the package/scope namespace from the Host-issued Fiber identity.
    pub fn bind(&self, owner: Context) -> Result<Directory, crate::Error> {
        let identity = owner.identity()?;
        let namespace = Namespace::new(identity.package_id, identity.scope)?;
        // Hash the framed identity, not platform-sensitive path components.
        let identity = serde_json::to_vec(&(namespace.package(), namespace.scope()))
            .expect("namespace serialization");
        Ok(Directory {
            parent: self.0.clone(),
            path: self.1.clone(),
            name: format!("{:x}", Sha256::digest(identity)),
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
    owner: Context,
}

impl Directory {
    /// The same namespace as private-file operations, borrowed read-only by
    /// native algorithms; it retains the owning plugin's lifetime.
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
        let cancellation = self.owner.stopping().map_err(|_| StoreError::Retired)?;
        Ok(root.bind(self.owner.clone(), cancellation))
    }

    /// Run blocking file work under a lifecycle lease. Dropping the reply does
    /// not abandon the worker; retirement waits for it to settle. The callback
    /// must finish its work before returning, not leak handles to unowned tasks.
    /// Long reads must observe the retirement token; mutations must settle any
    /// effect already started. This is trusted code, not an adversarial sandbox.
    pub async fn run<T, F>(&self, operation: F) -> Result<T, StoreError>
    where
        T: Send + 'static,
        F: FnOnce(&Dir, &CancellationToken) -> T + Send + 'static,
    {
        let lease = self
            .owner
            .resource_call()
            .map_err(|_| StoreError::Retired)?;
        let parent = self.parent.clone();
        let name = self.name.clone();
        let result = self
            .owner
            .spawn_resource("plugin private files", move |retiring| async move {
                tokio::task::spawn_blocking(move || {
                    let _lease = lease;
                    if retiring.is_cancelled() {
                        return Err(StoreError::Retired);
                    }
                    let directory = child(&parent, &name)
                        .map_err(|error| StoreError::Unavailable(error.to_string()))?;
                    Ok(operation(&directory, &retiring))
                })
                .await
                .map_err(|error| error.to_string())
            })
            .map_err(|_| StoreError::Retired)?;
        result
            .await
            .map_err(|error| StoreError::OutcomeUnknown(error.to_string()))?
            .map_err(StoreError::OutcomeUnknown)?
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
    use crate::{composition::Scope, fiber::Fiber};
    use std::time::Duration;

    fn owner(package: &str, entry: &str, scope: Scope) -> Fiber {
        let fiber = Fiber::new(package, entry, scope).unwrap();
        fiber.begin_loading().unwrap();
        fiber.ready().unwrap();
        fiber.publish().unwrap();
        fiber
    }

    #[tokio::test]
    async fn namespaces_survive_generations_and_lost_replies_do_not_abandon_writes() {
        let root = tempfile::tempdir().unwrap();
        let directories = Directories::open(root.path()).unwrap();
        let first = owner("example.notes", "first", Scope::Profile);
        let files = directories.bind(first.context()).unwrap();
        files
            .run(|dir, _| dir.write("state", b"old"))
            .await
            .unwrap()
            .unwrap();

        for (package, scope) in [
            ("example.other", Scope::Profile),
            ("example.notes", Scope::Session("one".into())),
        ] {
            let other = owner(package, "other", scope);
            let isolated = directories.bind(other.context()).unwrap();
            assert!(
                !isolated
                    .run(|dir, _| dir.try_exists("state"))
                    .await
                    .unwrap()
                    .unwrap()
            );
            other
                .shutdown(tokio::time::Instant::now() + Duration::from_secs(2))
                .await
                .unwrap();
        }
        let same = owner("example.notes", "second", Scope::Profile);
        let shared = directories.bind(same.context()).unwrap();
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
        first.retire();
        assert!(matches!(
            reader.await.unwrap().unwrap(),
            Err(crate::filesystem::entries::Error::Cancelled)
        ));
        assert!(matches!(
            files.run(|_, _| ()).await,
            Err(StoreError::Retired)
        ));
        assert_eq!(first.context().active_calls(), 1);
        release.send(()).unwrap();
        first
            .shutdown(tokio::time::Instant::now() + Duration::from_secs(2))
            .await
            .unwrap();
        same.shutdown(tokio::time::Instant::now() + Duration::from_secs(2))
            .await
            .unwrap();

        let reopened = Directories::open(root.path()).unwrap();
        let next = owner("example.notes", "third", Scope::Profile);
        assert_eq!(
            reopened
                .bind(next.context())
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
        next.shutdown(tokio::time::Instant::now() + Duration::from_secs(2))
            .await
            .unwrap();
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
        let fiber = owner("example.notes", "notes", Scope::Profile);
        let files = directories.bind(fiber.context()).unwrap();
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
        fiber
            .shutdown(tokio::time::Instant::now() + Duration::from_secs(2))
            .await
            .unwrap();
    }
}
