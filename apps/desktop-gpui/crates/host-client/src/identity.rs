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

//! A client instance id that stays the same across launches.
//!
//! The Electron desktop keeps one id per installation
//! (`loadOrCreateRuntimeHostClientInstanceId` in
//! `packages/runtime-host/src/client/client-instance-identity.ts`), so a Host
//! can tell a returning client from a new one during takeover and handoff.
//! This client does the same: the id lives in `client-instance-id` under the
//! platform config directory (on macOS
//! `~/Library/Application Support/maka-gpui/client-instance-id`).
//!
//! The file holds the id and a newline. A file that is missing gets created;
//! one that is unreadable as an id (too large, not a regular file, not UTF-8,
//! outside `^[A-Za-z0-9_-]{1,128}$`) is replaced with a new id instead of
//! failing startup. The TS client rejects a damaged identity file; a desktop
//! client that cannot start over a corrupt cache file helps nobody, and the
//! only cost of a new id is that the Host sees a new client.
//!
//! File access goes through `async-fs`, which runs each call on its blocking
//! pool, so these futures are safe to await from any executor.

use std::io;
use std::path::{Path, PathBuf};

use futures_lite::AsyncWriteExt;
use host_protocol::ClientInstanceId;
use thiserror::Error;

use crate::random_client_instance_id;

/// The directory under the platform config directory that holds this
/// client's files.
pub const CLIENT_CONFIG_DIRECTORY: &str = "maka-gpui";

/// The identity file name inside [`CLIENT_CONFIG_DIRECTORY`].
pub const CLIENT_IDENTITY_FILE: &str = "client-instance-id";

/// `CLIENT_IDENTITY_MAX_BYTES` in `client-instance-identity.ts`.
const MAX_IDENTITY_BYTES: u64 = 512;

/// Where the id came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum IdentityOrigin {
    /// Read back from an earlier launch.
    Loaded,
    /// No file existed; a new id was written.
    Created,
    /// The file was not a valid id; a new id replaced it.
    Replaced,
}

/// A persisted client instance id and where it came from.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct ClientIdentity {
    pub id: ClientInstanceId,
    pub origin: IdentityOrigin,
}

/// A failure to read or write the identity file.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum IdentityError {
    /// The platform has no config directory (no home directory).
    #[error("cannot determine the platform config directory")]
    NoConfigDirectory,
    #[error("failed to access the client identity at {}", path.display())]
    Io {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
}

/// The identity file path under the platform config directory.
pub fn client_identity_path() -> Result<PathBuf, IdentityError> {
    let config = dirs::config_dir().ok_or(IdentityError::NoConfigDirectory)?;
    Ok(config.join(CLIENT_CONFIG_DIRECTORY).join(CLIENT_IDENTITY_FILE))
}

/// Reads the id at `path`, creating or replacing it as the module docs say.
pub async fn load_or_create_client_instance_id(
    path: &Path,
) -> Result<ClientIdentity, IdentityError> {
    let io_error = |source| IdentityError::Io { path: path.to_owned(), source };
    let origin = match read_identity(path).await {
        Ok(Some(id)) => return Ok(ClientIdentity { id, origin: IdentityOrigin::Loaded }),
        Ok(None) => IdentityOrigin::Replaced,
        Err(error) if error.kind() == io::ErrorKind::NotFound => IdentityOrigin::Created,
        Err(error) => return Err(io_error(error)),
    };
    let id = random_client_instance_id();
    write_identity(path, &id).await.map_err(io_error)?;
    Ok(ClientIdentity { id, origin })
}

/// `Ok(None)` when the file exists but does not hold a valid id.
async fn read_identity(path: &Path) -> io::Result<Option<ClientInstanceId>> {
    let metadata = async_fs::symlink_metadata(path).await?;
    if !metadata.is_file() || metadata.len() > MAX_IDENTITY_BYTES {
        return Ok(None);
    }
    let bytes = async_fs::read(path).await?;
    let Ok(text) = std::str::from_utf8(&bytes) else {
        return Ok(None);
    };
    Ok(ClientInstanceId::new(text.trim_end_matches(['\n', '\r'])).ok())
}

/// Writes `id` to a temporary file beside `path`, then renames it over
/// `path`, so a reader never sees a partial id.
async fn write_identity(path: &Path, id: &ClientInstanceId) -> io::Result<()> {
    let directory = path.parent().unwrap_or(Path::new("."));
    let mut builder = async_fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use async_fs::unix::DirBuilderExt as _;
        builder.mode(0o700);
    }
    builder.create(directory).await?;

    let temporary = directory.join(format!(".{CLIENT_IDENTITY_FILE}-{}.tmp", random_suffix()));
    let mut options = async_fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use async_fs::unix::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let written = async {
        let mut file = options.open(&temporary).await?;
        file.write_all(format!("{id}\n").as_bytes()).await?;
        file.flush().await?;
        file.sync_all().await?;
        drop(file);
        async_fs::rename(&temporary, path).await
    }
    .await;
    if written.is_err() {
        let _ = async_fs::remove_file(&temporary).await;
    }
    written
}

fn random_suffix() -> String {
    random_client_instance_id().as_str().replace('-', "")
}

#[cfg(test)]
// Test setup writes fixture files synchronously; no UI thread is involved.
#[allow(clippy::disallowed_methods)]
mod tests {
    use std::fs;

    use futures_lite::future::block_on;

    use super::*;

    fn scratch_path(name: &str) -> PathBuf {
        std::env::temp_dir()
            .join(format!("host-client-identity-{name}-{}", uuid::Uuid::new_v4().simple()))
            .join(CLIENT_CONFIG_DIRECTORY)
            .join(CLIENT_IDENTITY_FILE)
    }

    fn cleanup(path: &Path) {
        if let Some(root) = path.parent().and_then(Path::parent) {
            fs::remove_dir_all(root).ok();
        }
    }

    #[test]
    fn first_run_creates_an_id_that_later_runs_read_back() {
        let path = scratch_path("create");
        let created = block_on(load_or_create_client_instance_id(&path)).expect("created");
        assert_eq!(created.origin, IdentityOrigin::Created);
        assert_eq!(fs::read_to_string(&path).expect("file"), format!("{}\n", created.id));

        let loaded = block_on(load_or_create_client_instance_id(&path)).expect("loaded");
        assert_eq!(loaded.origin, IdentityOrigin::Loaded);
        assert_eq!(loaded.id, created.id);
        cleanup(&path);
    }

    #[cfg(unix)]
    #[test]
    fn the_identity_file_is_private_to_the_user() {
        use std::os::unix::fs::PermissionsExt as _;
        let path = scratch_path("mode");
        block_on(load_or_create_client_instance_id(&path)).expect("created");
        let mode = fs::metadata(&path).expect("metadata").permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        cleanup(&path);
    }

    #[test]
    fn invalid_contents_are_replaced_with_a_new_id() {
        let path = scratch_path("invalid");
        fs::create_dir_all(path.parent().expect("parent")).expect("dir");
        for contents in ["".as_bytes(), b"has space\n", b"dotted.id", &[0xff, 0xfe], &[b'a'; 600]] {
            fs::write(&path, contents).expect("write");
            let identity = block_on(load_or_create_client_instance_id(&path)).expect("replaced");
            assert_eq!(identity.origin, IdentityOrigin::Replaced, "{contents:?}");
            let reread = block_on(load_or_create_client_instance_id(&path)).expect("loaded");
            assert_eq!(reread.origin, IdentityOrigin::Loaded);
            assert_eq!(reread.id, identity.id);
        }
        cleanup(&path);
    }

    #[test]
    fn a_directory_in_place_of_the_file_is_an_error_not_a_panic() {
        let path = scratch_path("directory");
        fs::create_dir_all(&path).expect("dir");
        // Not a regular file, so it reads as invalid; the rename over a
        // directory then fails and is reported.
        assert!(matches!(
            block_on(load_or_create_client_instance_id(&path)),
            Err(IdentityError::Io { .. })
        ));
        cleanup(&path);
    }

    #[test]
    fn a_hand_written_uuid_is_accepted() {
        let path = scratch_path("uuid");
        fs::create_dir_all(path.parent().expect("parent")).expect("dir");
        fs::write(&path, "0a4adfd1-a36c-47f0-8ba0-2012902025f8\r\n").expect("write");
        let identity = block_on(load_or_create_client_instance_id(&path)).expect("loaded");
        assert_eq!(identity.origin, IdentityOrigin::Loaded);
        assert_eq!(identity.id.as_str(), "0a4adfd1-a36c-47f0-8ba0-2012902025f8");
        cleanup(&path);
    }

    #[test]
    fn the_default_path_is_under_the_config_directory() {
        let path = client_identity_path().expect("config dir");
        assert!(path.ends_with(Path::new(CLIENT_CONFIG_DIRECTORY).join(CLIENT_IDENTITY_FILE)));
        #[cfg(target_os = "macos")]
        assert!(path.to_string_lossy().contains("Library/Application Support/maka-gpui"));
    }
}
