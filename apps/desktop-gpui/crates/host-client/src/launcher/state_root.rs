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

//! Creating a State Root, as a launcher must before it spawns a Host.
//!
//! A Host candidate never creates a State Root. It opens `--root` with
//! `resolveExistingStorageRoot` and `--expected-root-id`
//! (`startInteractiveRuntimeHostCandidate` in
//! `packages/runtime-host/src/server/candidate.ts`), which fails on a
//! directory without a marker. The TS launcher prepares the root first:
//! `connectOrSpawnRuntimeHostWithDependencies` in
//! `packages/runtime-host/src/client/connect-or-spawn.ts` calls
//! `resolveStorageRoot({ path, kind: 'interactive' })` in
//! `packages/storage/src/root-authority.ts`, which
//!
//! - creates the directory with mode 0700 (`ensureRootDirectory`);
//! - resolves it to its canonical path (`realpath`), which is what the
//!   candidate receives as `--root`;
//! - creates `.maka-storage-root.json` when it is missing (`ensureRootMarker`):
//!   `{"schemaVersion":1,"kind":"interactive","rootId":"<32 random bytes as
//!   hex>","rootIdentity":{"dev":"<st_dev>","ino":"<st_ino>"}}` and a newline.
//!   `publishMarkerFile` (`packages/storage/src/marker-file.ts`) writes it to
//!   `<marker>.<pid>.<uuid>.tmp` with mode 0600 and fsyncs it, hard-links it
//!   to the marker name so that a marker another process published first is
//!   kept, fsyncs the directory, and removes the temporary file;
//! - rejects a marker whose `rootIdentity` names a different directory
//!   (`root_identity_collision`), as a copied or restored State Root has.
//!
//! [`prepare_state_root`] does the same. It never rewrites an existing marker;
//! adopting a copied root is a decision for Maka's own tools
//! (`adoptStorageRootOnImport`).

use std::io;
use std::path::{Path, PathBuf};

use thiserror::Error;

use crate::DiscoveryError;
#[cfg(unix)]
use crate::discovery::{STORAGE_ROOT_MARKER_FILE, read_marker};

/// A State Root that exists and carries a valid marker for its directory.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct PreparedRoot {
    /// The resolved directory, as a Host candidate receives it in `--root`.
    pub canonical_path: PathBuf,
    /// The marker's `rootId`: 64 lowercase hex characters.
    pub root_id: String,
    /// Whether this call wrote the marker.
    pub created: bool,
}

/// Why a State Root could not be prepared.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum StateRootError {
    /// The path exists and is not a directory.
    #[error("{} is not a directory", .0.display())]
    NotADirectory(PathBuf),
    /// The marker was written for another directory (`root_identity_collision`).
    #[error(
        "the State Root marker in {} belongs to a different directory; it was probably copied or \
         restored from elsewhere, and Maka must adopt it before it can be used",
        .0.display()
    )]
    IdentityMismatch(PathBuf),
    /// The marker exists but is invalid.
    #[error(transparent)]
    Marker(DiscoveryError),
    /// Creating or reading the directory or the marker failed.
    #[error("failed to prepare the State Root at {}", path.display())]
    Io {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    /// Creating State Roots is not implemented on this platform yet.
    #[error("creating a State Root is not supported on this platform yet")]
    Unsupported,
}

/// Creates the State Root at `path` if needed and returns its canonical path
/// and `rootId`, the way `resolveStorageRoot` does (see the module docs).
///
/// File access goes through `async-fs`, so the future is safe to await from
/// any executor.
#[cfg(unix)]
pub async fn prepare_state_root(path: &Path) -> Result<PreparedRoot, StateRootError> {
    use async_fs::unix::DirBuilderExt as _;

    let io_error = |path: &Path| {
        let path = path.to_owned();
        move |source| StateRootError::Io { path, source }
    };
    let requested = std::path::absolute(path).map_err(io_error(path))?;
    let mut builder = async_fs::DirBuilder::new();
    builder.recursive(true).mode(0o700);
    if let Err(error) = builder.create(&requested).await {
        return Err(match async_fs::metadata(&requested).await {
            Ok(metadata) if !metadata.is_dir() => StateRootError::NotADirectory(requested),
            _ => io_error(&requested)(error),
        });
    }
    let canonical_path = async_fs::canonicalize(&requested).await.map_err(io_error(&requested))?;
    let identity = directory_identity(&canonical_path).await?;

    let marker_path = canonical_path.join(STORAGE_ROOT_MARKER_FILE);
    let created = match async_fs::symlink_metadata(&marker_path).await {
        Ok(_) => false,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            publish_marker(&canonical_path, &identity).await.map_err(io_error(&marker_path))?
        }
        Err(error) => return Err(io_error(&marker_path)(error)),
    };

    let marker = read_marker(&canonical_path).await.map_err(StateRootError::Marker)?;
    // The directory must still be the one the marker was checked against.
    if directory_identity(&canonical_path).await? != identity
        || marker.dev != identity.dev
        || marker.ino != identity.ino
    {
        return Err(StateRootError::IdentityMismatch(canonical_path));
    }
    Ok(PreparedRoot { canonical_path, root_id: marker.root_id, created })
}

/// See the unix implementation.
#[cfg(not(unix))]
pub async fn prepare_state_root(_path: &Path) -> Result<PreparedRoot, StateRootError> {
    Err(StateRootError::Unsupported)
}

/// A directory's device and inode numbers, in the decimal form the marker
/// records (`rootStat.dev.toString()` of a bigint `stat`).
#[cfg(unix)]
#[derive(Debug, PartialEq, Eq)]
struct DirectoryIdentity {
    dev: String,
    ino: String,
}

#[cfg(unix)]
async fn directory_identity(path: &Path) -> Result<DirectoryIdentity, StateRootError> {
    use std::os::unix::fs::MetadataExt as _;

    let metadata = async_fs::metadata(path)
        .await
        .map_err(|source| StateRootError::Io { path: path.to_owned(), source })?;
    if !metadata.is_dir() {
        return Err(StateRootError::NotADirectory(path.to_owned()));
    }
    Ok(DirectoryIdentity { dev: metadata.dev().to_string(), ino: metadata.ino().to_string() })
}

/// The marker's contents, byte for byte what `ensureRootMarker` writes.
#[cfg(unix)]
fn marker_contents(root_id: &str, identity: &DirectoryIdentity) -> String {
    let marker = serde_json::json!({
        "schemaVersion": 1,
        "kind": "interactive",
        "rootId": root_id,
        "rootIdentity": { "dev": identity.dev, "ino": identity.ino },
    });
    format!("{marker}\n")
}

/// 32 bytes from the OS random source as lowercase hex
/// (`randomBytes(32).toString('hex')`).
#[cfg(unix)]
fn new_root_id() -> io::Result<String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(io::Error::other)?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// Publishes a new marker in `root` without replacing one that appears
/// meanwhile (`publishMarkerFile` with `publication: 'create'`). Returns
/// whether this call's marker won.
#[cfg(unix)]
async fn publish_marker(root: &Path, identity: &DirectoryIdentity) -> io::Result<bool> {
    use async_fs::unix::OpenOptionsExt as _;
    use futures_lite::AsyncWriteExt as _;

    let contents = marker_contents(&new_root_id()?, identity);
    let temporary = root.join(format!(
        "{STORAGE_ROOT_MARKER_FILE}.{}.{}.tmp",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let result = async {
        let mut file = async_fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary)
            .await?;
        file.write_all(contents.as_bytes()).await?;
        file.flush().await?;
        file.sync_all().await?;
        drop(file);
        match async_fs::hard_link(&temporary, root.join(STORAGE_ROOT_MARKER_FILE)).await {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => return Ok(false),
            Err(error) => return Err(error),
        }
        async_fs::File::open(root).await?.sync_all().await?;
        Ok(true)
    }
    .await;
    let _ = async_fs::remove_file(&temporary).await;
    result
}

#[cfg(all(test, unix))]
// Test setup and assertions touch the file system synchronously; no UI
// thread is involved.
#[allow(clippy::disallowed_methods)]
mod tests {
    use std::fs;
    use std::os::unix::fs::{MetadataExt as _, PermissionsExt as _};

    use futures_lite::future::block_on;
    use serde_json::Value;

    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("host-client-state-root-{name}-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(&dir).expect("scratch dir");
        fs::canonicalize(dir).expect("canonical scratch dir")
    }

    #[test]
    fn creates_the_directory_and_a_marker_like_resolve_storage_root() {
        let parent = scratch("create");
        let root = parent.join("nested/state-root");
        let prepared = block_on(prepare_state_root(&root)).expect("prepared");
        assert!(prepared.created);
        assert_eq!(prepared.canonical_path, root);
        assert!(host_protocol::is_root_id(&prepared.root_id));

        let directory = fs::metadata(&root).expect("root");
        assert_eq!(directory.permissions().mode() & 0o777, 0o700);
        let marker_path = root.join(STORAGE_ROOT_MARKER_FILE);
        let marker = fs::metadata(&marker_path).expect("marker");
        assert_eq!(marker.permissions().mode() & 0o777, 0o600);
        let text = fs::read_to_string(&marker_path).expect("marker text");
        assert!(text.ends_with("}\n"));
        let json: Value = serde_json::from_str(&text).expect("marker json");
        assert_eq!(
            json,
            serde_json::json!({
                "schemaVersion": 1,
                "kind": "interactive",
                "rootId": prepared.root_id,
                "rootIdentity": {
                    "dev": directory.dev().to_string(),
                    "ino": directory.ino().to_string()
                }
            })
        );
        // Key order matches `JSON.stringify` of the TS object literal.
        assert!(text.starts_with(r#"{"schemaVersion":1,"kind":"interactive","rootId":""#));
        // No temporary file is left behind.
        let entries: Vec<_> = fs::read_dir(&root).expect("entries").collect();
        assert_eq!(entries.len(), 1);
        fs::remove_dir_all(parent).ok();
    }

    #[test]
    fn an_existing_marker_is_kept() {
        let root = scratch("existing");
        let first = block_on(prepare_state_root(&root)).expect("first");
        let second = block_on(prepare_state_root(&root)).expect("second");
        assert!(!second.created);
        assert_eq!(first.root_id, second.root_id);
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn a_marker_from_another_directory_is_rejected() {
        let parent = scratch("copied");
        let original = parent.join("original");
        block_on(prepare_state_root(&original)).expect("original");
        let copy = parent.join("copy");
        fs::create_dir(&copy).expect("copy dir");
        fs::copy(original.join(STORAGE_ROOT_MARKER_FILE), copy.join(STORAGE_ROOT_MARKER_FILE))
            .expect("copy marker");
        assert!(matches!(
            block_on(prepare_state_root(&copy)),
            Err(StateRootError::IdentityMismatch(_))
        ));
        fs::remove_dir_all(parent).ok();
    }

    #[test]
    fn a_file_is_not_a_state_root() {
        let parent = scratch("file");
        let file = parent.join("file");
        fs::write(&file, "x").expect("file");
        assert!(matches!(
            block_on(prepare_state_root(&file)),
            Err(StateRootError::NotADirectory(_))
        ));
        fs::remove_dir_all(parent).ok();
    }

    #[test]
    fn an_invalid_marker_is_reported() {
        let root = scratch("invalid");
        fs::write(root.join(STORAGE_ROOT_MARKER_FILE), "{}").expect("marker");
        assert!(matches!(block_on(prepare_state_root(&root)), Err(StateRootError::Marker(_))));
        fs::remove_dir_all(root).ok();
    }
}
