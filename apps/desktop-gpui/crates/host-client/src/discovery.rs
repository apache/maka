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

//! Finding a running Host for a State Root.
//!
//! A State Root directory holds `.maka-storage-root.json`, whose `rootId`
//! names a per-root control directory. A running Host writes
//! `registration.json` there with its local IPC endpoint.
//!
//! Sources in the Maka monorepo:
//! - marker: `STORAGE_ROOT_MARKER_FILE`, `readRootMarker`, `isRootMarker` in
//!   `packages/storage/src/root-authority.ts`;
//! - control directory: `resolveRootControlNamespace` and
//!   `prepareStorageRootControlDirectoryForRecord` in the same file. Note that
//!   this is the disposable cache namespace, not `state-root-owners/`, which
//!   holds only the owner lock files (`resolveRootOwnershipNamespace`);
//! - registration: `readHostRegistration` in
//!   `packages/runtime-host/src/control/registration.ts`.
//!
//! File access goes through `async-fs`, which runs each call on its blocking
//! thread pool, so these futures are safe to await from any executor.

use std::io;
use std::path::{Path, PathBuf};

use host_protocol::{HostRegistration, InvalidRegistration, is_root_id};
use serde::Deserialize;
use thiserror::Error;

/// The marker file at the top of every State Root.
pub const STORAGE_ROOT_MARKER_FILE: &str = ".maka-storage-root.json";

/// The registration file inside a control directory.
pub const REGISTRATION_FILE: &str = "registration.json";

/// `MAX_STORAGE_ROOT_MARKER_BYTES` in `root-authority.ts`.
const MAX_MARKER_BYTES: u64 = 1_024;

/// `MAX_REGISTRATION_BYTES` in `control/registration.ts`.
const MAX_REGISTRATION_BYTES: u64 = 16 * 1024;

/// A failure to locate a Host from a State Root.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum DiscoveryError {
    /// The directory has no `.maka-storage-root.json`; no Host has ever
    /// initialized it.
    #[error("{} is not a Maka State Root (no {STORAGE_ROOT_MARKER_FILE})", .0.display())]
    RootUnmarked(PathBuf),
    /// The marker exists but is not a valid interactive root marker.
    #[error("invalid State Root marker at {}: {reason}", path.display())]
    InvalidMarker { path: PathBuf, reason: String },
    /// No `registration.json`: no Host is running for this root.
    #[error("no Runtime Host is registered in {}", .0.display())]
    NotRegistered(PathBuf),
    /// `registration.json` is not a bounded regular file.
    #[error("{} must be a regular file of at most {MAX_REGISTRATION_BYTES} bytes", .0.display())]
    RegistrationNotAFile(PathBuf),
    /// `registration.json` violates the registration schema.
    #[error("invalid Runtime Host registration at {}", path.display())]
    InvalidRegistration {
        path: PathBuf,
        #[source]
        source: InvalidRegistration,
    },
    /// The registration belongs to a different State Root.
    #[error("registration rootId {found} does not match the State Root {expected}")]
    RootMismatch { expected: String, found: String },
    /// The OS account home directory could not be determined.
    #[error("cannot determine the home directory")]
    NoHomeDirectory,
    /// Any other file system failure.
    #[error("failed to read {}", path.display())]
    Io {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
}

/// `RootMarker` in `root-authority.ts`. Unknown fields are ignored.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RootMarker {
    schema_version: u32,
    kind: String,
    root_id: String,
    root_identity: RootMarkerIdentity,
}

#[derive(Deserialize)]
struct RootMarkerIdentity {
    dev: String,
    ino: String,
}

/// Reads the `rootId` from the marker file of the State Root at `root`.
///
/// Validates the marker the way `isRootMarker` does. It does not check the
/// recorded `dev`/`ino` against the directory; that repair decision belongs
/// to the Host.
pub async fn read_root_id(root: &Path) -> Result<String, DiscoveryError> {
    Ok(read_marker(root).await?.root_id)
}

/// A validated root marker.
#[cfg_attr(not(unix), allow(dead_code))]
pub(crate) struct MarkerRecord {
    pub(crate) root_id: String,
    /// `rootIdentity.dev` and `rootIdentity.ino`, decimal.
    pub(crate) dev: String,
    pub(crate) ino: String,
}

/// Reads and validates the marker of the State Root at `root`
/// (`readRootMarker` and `isRootMarker` in `root-authority.ts`).
pub(crate) async fn read_marker(root: &Path) -> Result<MarkerRecord, DiscoveryError> {
    let path = root.join(STORAGE_ROOT_MARKER_FILE);
    let bytes = match read_bounded_file(&path, MAX_MARKER_BYTES).await {
        Ok(Some(bytes)) => bytes,
        Ok(None) => {
            return Err(DiscoveryError::InvalidMarker {
                path,
                reason: format!("must be a regular file of at most {MAX_MARKER_BYTES} bytes"),
            });
        }
        Err(source) if source.kind() == io::ErrorKind::NotFound => {
            return Err(DiscoveryError::RootUnmarked(root.to_owned()));
        }
        Err(source) => return Err(DiscoveryError::Io { path, source }),
    };
    let invalid = |reason: &str| DiscoveryError::InvalidMarker {
        path: path.clone(),
        reason: reason.to_owned(),
    };
    let marker: RootMarker = serde_json::from_slice(&bytes).map_err(|_| invalid("not a marker"))?;
    if marker.schema_version != 1 {
        return Err(invalid("unsupported schemaVersion"));
    }
    if marker.kind != "interactive" {
        return Err(invalid("kind is not interactive"));
    }
    if !is_root_id(&marker.root_id) {
        return Err(invalid("rootId is not 64 lowercase hex characters"));
    }
    let is_decimal = |value: &str| !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit());
    if !is_decimal(&marker.root_identity.dev) || !is_decimal(&marker.root_identity.ino) {
        return Err(invalid("rootIdentity is not a decimal dev/ino pair"));
    }
    Ok(MarkerRecord {
        root_id: marker.root_id,
        dev: marker.root_identity.dev,
        ino: marker.root_identity.ino,
    })
}

/// The directory that holds one control directory per State Root
/// (`resolveRootControlNamespace`).
///
/// - macOS: `~/Library/Caches/Maka/runtime-hosts`
/// - Windows: `~\AppData\Local\Maka\runtime-hosts`
/// - other: `~/.cache/maka/runtime-hosts`
///
/// The TS code reads the account home from the password database
/// (`os.userInfo().homedir`); this uses [`std::env::home_dir`], which prefers
/// `$HOME`. They differ only when `$HOME` is overridden.
pub fn control_namespace() -> Result<PathBuf, DiscoveryError> {
    let home = std::env::home_dir()
        .filter(|home| home.is_absolute())
        .ok_or(DiscoveryError::NoHomeDirectory)?;
    let namespace = if cfg!(target_os = "macos") {
        home.join("Library/Caches/Maka/runtime-hosts")
    } else if cfg!(windows) {
        home.join("AppData").join("Local").join("Maka").join("runtime-hosts")
    } else {
        home.join(".cache/maka/runtime-hosts")
    };
    Ok(namespace)
}

/// The control directory of the State Root identified by `root_id`.
pub fn control_directory(root_id: &str) -> Result<PathBuf, DiscoveryError> {
    Ok(control_namespace()?.join(root_id))
}

/// Reads and validates `registration.json` in `control_dir`.
pub async fn discover_registration(control_dir: &Path) -> Result<HostRegistration, DiscoveryError> {
    let path = control_dir.join(REGISTRATION_FILE);
    let bytes = match read_bounded_file(&path, MAX_REGISTRATION_BYTES).await {
        Ok(Some(bytes)) => bytes,
        Ok(None) => return Err(DiscoveryError::RegistrationNotAFile(path)),
        Err(source) if source.kind() == io::ErrorKind::NotFound => {
            return Err(DiscoveryError::NotRegistered(control_dir.to_owned()));
        }
        Err(source) => return Err(DiscoveryError::Io { path, source }),
    };
    HostRegistration::decode(&bytes)
        .map_err(|source| DiscoveryError::InvalidRegistration { path, source })
}

/// A Host found from a State Root path.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct DiscoveredHost {
    pub root_id: String,
    pub control_directory: PathBuf,
    pub registration: HostRegistration,
}

/// Resolves `root` → `rootId` → control directory → registration, and checks
/// that the registration belongs to this root.
pub async fn discover_host(root: &Path) -> Result<DiscoveredHost, DiscoveryError> {
    let root_id = read_root_id(root).await?;
    let control_directory = control_directory(&root_id)?;
    let registration = discover_registration(&control_directory).await?;
    if registration.root_id != root_id {
        return Err(DiscoveryError::RootMismatch {
            expected: root_id,
            found: registration.root_id,
        });
    }
    Ok(DiscoveredHost { root_id, control_directory, registration })
}

/// Reads `path` if it is a regular file (not a symlink) of at most
/// `max_bytes`. Returns `Ok(None)` when it exists but fails that check.
async fn read_bounded_file(path: &Path, max_bytes: u64) -> io::Result<Option<Vec<u8>>> {
    let metadata = async_fs::symlink_metadata(path).await?;
    if !metadata.is_file() || metadata.len() > max_bytes {
        return Ok(None);
    }
    let bytes = async_fs::read(path).await?;
    if bytes.len() as u64 > max_bytes {
        return Ok(None);
    }
    Ok(Some(bytes))
}

#[cfg(test)]
// Test setup writes fixture files synchronously; no UI thread is involved.
#[allow(clippy::disallowed_methods)]
mod tests {
    use std::fs;

    use futures_lite::future::block_on;

    use super::*;

    const ROOT_ID: &str = "67d440f2c07d4cf4e9f56a52aa2bf8e435c71602ddda6244987e201de0c4fb8d";

    fn scratch_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("host-client-discovery-{name}-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(&dir).expect("create scratch dir");
        dir
    }

    fn write_marker(root: &Path, contents: &str) {
        fs::write(root.join(STORAGE_ROOT_MARKER_FILE), contents).expect("write marker");
    }

    #[test]
    fn reads_root_id_from_a_valid_marker() {
        let root = scratch_dir("valid");
        write_marker(
            &root,
            &format!(
                r#"{{"schemaVersion":1,"kind":"interactive","rootId":"{ROOT_ID}","rootIdentity":{{"dev":"1","ino":"2"}}}}"#
            ),
        );
        assert_eq!(block_on(read_root_id(&root)).expect("root id"), ROOT_ID);
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn missing_marker_means_unmarked_root() {
        let root = scratch_dir("unmarked");
        assert!(matches!(block_on(read_root_id(&root)), Err(DiscoveryError::RootUnmarked(_))));
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn rejects_invalid_markers() {
        let root = scratch_dir("invalid");
        for contents in [
            "not json".to_owned(),
            format!(
                r#"{{"schemaVersion":2,"kind":"interactive","rootId":"{ROOT_ID}","rootIdentity":{{"dev":"1","ino":"2"}}}}"#
            ),
            r#"{"schemaVersion":1,"kind":"interactive","rootId":"ABC","rootIdentity":{"dev":"1","ino":"2"}}"#
                .to_owned(),
            format!(
                r#"{{"schemaVersion":1,"kind":"interactive","rootId":"{ROOT_ID}","rootIdentity":{{"dev":"x","ino":"2"}}}}"#
            ),
            "x".repeat(2_000),
        ] {
            write_marker(&root, &contents);
            assert!(
                matches!(block_on(read_root_id(&root)), Err(DiscoveryError::InvalidMarker { .. })),
                "{contents:.40} should be rejected"
            );
        }
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn missing_registration_means_not_registered() {
        let control = scratch_dir("no-registration");
        assert!(matches!(
            block_on(discover_registration(&control)),
            Err(DiscoveryError::NotRegistered(_))
        ));
        fs::remove_dir_all(control).ok();
    }

    #[test]
    fn reads_a_valid_registration() {
        let control = scratch_dir("registration");
        fs::write(
            control.join(REGISTRATION_FILE),
            format!(
                r#"{{"kind":"maka-runtime-host","schemaVersion":1,"rootId":"{ROOT_ID}","hostEpoch":"e","endpoint":"/tmp/h.sock","protocolMin":0,"protocolMax":0,"compatibilityEpoch":197,"state":"ready","pid":42,"createdAt":"2026-09-24T16:39:46.703Z"}}"#
            ),
        )
        .expect("write registration");
        let registration = block_on(discover_registration(&control)).expect("registration");
        assert_eq!(registration.endpoint, "/tmp/h.sock");
        assert_eq!(registration.pid, 42);
        fs::remove_dir_all(control).ok();
    }

    #[test]
    fn rejects_an_invalid_registration() {
        let control = scratch_dir("bad-registration");
        fs::write(control.join(REGISTRATION_FILE), r#"{"kind":"other"}"#).expect("write");
        assert!(matches!(
            block_on(discover_registration(&control)),
            Err(DiscoveryError::InvalidRegistration { .. })
        ));
        fs::remove_dir_all(control).ok();
    }

    #[test]
    fn control_directory_is_under_the_cache_namespace() {
        let directory = control_directory(ROOT_ID).expect("home");
        assert!(directory.ends_with(Path::new("runtime-hosts").join(ROOT_ID)));
    }
}
