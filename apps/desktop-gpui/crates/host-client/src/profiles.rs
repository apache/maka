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

//! Remote Host profiles and their access credentials, kept in this client's
//! config directory (on macOS `~/Library/Application Support/maka-gpui/`),
//! never in a State Root.
//!
//! Modeled on Desktop's catalog (`FileRuntimeHostProfileCatalog` and
//! `createRuntimeHostProfileCredentialStore` in
//! `packages/runtime-host/src/client/host-profile.ts`), which keeps
//! `runtime-host-profiles.json` (schema 5) beside a separate credential store.
//! This client owns its own two files:
//!
//! - [`REMOTE_PROFILES_FILE`]: `{ "schemaVersion": 5, "profiles": [...] }`, each
//!   profile `{ id, name, kind: "remote", transport, rootId }` as Desktop
//!   writes a remote profile;
//! - [`REMOTE_CREDENTIALS_FILE`], mode 0600:
//!   `{ "schemaVersion": 1, "credentials": [{ profileId, target, credential }] }`,
//!   with `"pending": true` on a credential that pairing has not finalized
//!   yet (Desktop keeps such a credential in its pairing journal,
//!   `runtime-host-pairing-journal.ts`);
//! - [`HOST_SELECTION_FILE`] (see [`HostSelection`](crate::HostSelection)):
//!   the default Host and the enabled remote ones, Desktop's
//!   `runtime-host-profile-selection.json`.
//!
//! A credential is bound to its profile's target, as Desktop's credential
//! slot is (`profileCredentialBinding`): a SHA-256 over the transport kind,
//! its endpoint, and the State Root id. A profile's target never changes (a
//! different target is a new profile), and a credential whose binding does
//! not match is not handed out, so it only ever goes to the Host it was
//! issued for.
//!
//! Not modeled: WSL environment profiles, Session Guest profiles, profile
//! incarnation ids (they serve capability-provider credentials), and
//! Desktop's lock file against other processes. Writes are serialized within
//! this process; each file is replaced atomically.

use std::io;
use std::path::{Path, PathBuf};

use async_lock::Mutex;
use futures_lite::AsyncWriteExt as _;
use host_protocol::{
    AccessCredential, OperatorCommand, OwnerConnectionCode, RemoteTransport, SshEndpoint,
    is_root_id,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::CLIENT_CONFIG_DIRECTORY;
use crate::selection::HOST_SELECTION_FILE;

/// The profile document inside [`CLIENT_CONFIG_DIRECTORY`] (Desktop's
/// `CLIENT_PROFILE_DOCUMENT_NAME`).
pub const REMOTE_PROFILES_FILE: &str = "runtime-host-profiles.json";

/// The credential document inside [`CLIENT_CONFIG_DIRECTORY`].
pub const REMOTE_CREDENTIALS_FILE: &str = "runtime-host-credentials.json";

/// `PROFILE_SCHEMA_VERSION`.
const PROFILE_SCHEMA_VERSION: u32 = 5;

const CREDENTIAL_SCHEMA_VERSION: u32 = 1;

/// `PROFILE_DOCUMENT_MAX_BYTES`.
const PROFILE_DOCUMENT_MAX_BYTES: u64 = 64 * 1024;

/// Room for [`PROFILE_COUNT_MAX`] credentials of the maximum size.
const CREDENTIAL_DOCUMENT_MAX_BYTES: u64 = 512 * 1024;

/// `PROFILE_COUNT_MAX`.
const PROFILE_COUNT_MAX: usize = 32;

/// `PROFILE_NAME_MAX_BYTES`.
const PROFILE_NAME_MAX_BYTES: usize = 128;

/// `LOCAL_RUNTIME_HOST_PROFILE.id`, reserved for the local Host.
pub const LOCAL_PROFILE_ID: &str = "local";

/// A saved remote Host: where it is and which State Root it must serve.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "WireProfile", into = "WireProfile")]
pub struct RemoteHostProfile {
    id: String,
    name: String,
    root_id: String,
    transport: RemoteTransport,
}

/// Why a profile's fields are not valid.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[non_exhaustive]
pub enum ProfileError {
    /// Not `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`, or `local`.
    #[error("Runtime Host profile id is invalid or reserved")]
    InvalidId,
    /// Empty after trimming, over 128 bytes, or with control characters.
    #[error("Runtime Host profile name is invalid")]
    InvalidName,
    #[error("Runtime Host profile rootId is not a State Root id")]
    InvalidRootId,
    #[error("Runtime Host profile kind must be remote")]
    NotRemote,
}

impl RemoteHostProfile {
    /// A profile, validated as `decodeRemoteRuntimeHostProfile` does. The name
    /// is trimmed.
    pub fn new(
        id: &str,
        name: &str,
        root_id: &str,
        transport: RemoteTransport,
    ) -> Result<Self, ProfileError> {
        Ok(Self {
            id: require_profile_id(id)?,
            name: require_profile_name(name)?,
            root_id: is_root_id(root_id)
                .then(|| root_id.to_owned())
                .ok_or(ProfileError::InvalidRootId)?,
            transport,
        })
    }

    /// A profile with a fresh id, `remote-<uuid>`, as Desktop names the
    /// profile it creates from a connection code.
    pub fn with_new_id(
        name: &str,
        root_id: &str,
        transport: RemoteTransport,
    ) -> Result<Self, ProfileError> {
        Self::new(&format!("remote-{}", uuid::Uuid::new_v4()), name, root_id, transport)
    }

    /// The profile a connection code describes, with a fresh id
    /// (`importConnectionCode` in Desktop's `runtime-host-profile-service.ts`).
    /// Its credential is the code's pending credential.
    pub fn from_connection_code(code: &OwnerConnectionCode) -> Result<Self, ProfileError> {
        Self::with_new_id(&code.name, &code.root_id, code.transport.clone())
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    /// The State Root the Host must serve; a connection to any other fails.
    pub fn root_id(&self) -> &str {
        &self.root_id
    }

    pub fn transport(&self) -> &RemoteTransport {
        &self.transport
    }

    /// The same profile under another name.
    pub fn renamed(&self, name: &str) -> Result<Self, ProfileError> {
        Ok(Self { name: require_profile_name(name)?, ..self.clone() })
    }

    /// `profileCredentialBinding`: SHA-256, hex, over the transport kind, the
    /// transport's endpoint, and the State Root id, separated by NUL.
    pub fn target_fingerprint(&self) -> String {
        let (kind, binding) = match &self.transport {
            RemoteTransport::Tls(url) => ("tls", url.as_str().to_owned()),
            RemoteTransport::Plaintext(url) => (
                "plaintext",
                format!("{}\0{}", url.as_str(), host_protocol::PLAINTEXT_ACKNOWLEDGEMENT),
            ),
            RemoteTransport::Ssh(ssh) => {
                let port = ssh.ssh_port().map(|port| port.to_string()).unwrap_or_default();
                let endpoint = match ssh.endpoint() {
                    SshEndpoint::Forward { remote_port, websocket_path, .. } => {
                        format!("{remote_port}\0{websocket_path}")
                    }
                    SshEndpoint::Operator(operator) => {
                        format!("activate\0{}", operator_binding(operator))
                    }
                };
                ("ssh", format!("{}\0{port}\0{endpoint}", ssh.destination()))
            }
            RemoteTransport::DirectPeer(peer) => ("libp2p-direct", peer.peer_id().to_owned()),
            // A transport kind added later binds by its whole encoding.
            other => ("other", serde_json::to_string(other).unwrap_or_default()),
        };
        let mut hash = Sha256::new();
        hash.update(kind);
        hash.update([0]);
        hash.update(binding);
        hash.update([0]);
        hash.update(&self.root_id);
        hash.finalize().iter().map(|byte| format!("{byte:02x}")).collect()
    }
}

/// `operatorTargetBinding`.
fn operator_binding(operator: &OperatorCommand) -> String {
    match operator {
        OperatorCommand::LegacyPosixExecutable { executable_path, .. } => executable_path.clone(),
        other => serde_json::to_string(other).unwrap_or_default(),
    }
}

/// `requireProfileId`.
fn require_profile_id(id: &str) -> Result<String, ProfileError> {
    let bytes = id.as_bytes();
    let valid = (1..=64).contains(&bytes.len())
        && bytes[0].is_ascii_alphanumeric()
        && bytes.iter().all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(byte))
        && id != LOCAL_PROFILE_ID;
    if valid { Ok(id.to_owned()) } else { Err(ProfileError::InvalidId) }
}

/// `requireProfileName`.
fn require_profile_name(name: &str) -> Result<String, ProfileError> {
    let name = name.trim();
    let valid = !name.is_empty()
        && name.len() <= PROFILE_NAME_MAX_BYTES
        && !name.chars().any(|c| matches!(c, '\u{0}'..='\u{1f}' | '\u{7f}'));
    if valid { Ok(name.to_owned()) } else { Err(ProfileError::InvalidName) }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireProfile {
    id: String,
    name: String,
    kind: String,
    transport: RemoteTransport,
    root_id: String,
}

impl TryFrom<WireProfile> for RemoteHostProfile {
    type Error = ProfileError;

    fn try_from(wire: WireProfile) -> Result<Self, ProfileError> {
        if wire.kind != "remote" {
            return Err(ProfileError::NotRemote);
        }
        Self::new(&wire.id, &wire.name, &wire.root_id, wire.transport)
    }
}

impl From<RemoteHostProfile> for WireProfile {
    fn from(profile: RemoteHostProfile) -> Self {
        Self {
            id: profile.id,
            name: profile.name,
            kind: "remote".to_owned(),
            transport: profile.transport,
            root_id: profile.root_id,
        }
    }
}

/// A profile and, when one is stored for its current target, its credential.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct ResolvedRemoteHost {
    pub profile: RemoteHostProfile,
    /// `None` when none was stored, or the stored one belongs to another
    /// target (Desktop: `credential_required`).
    pub credential: Option<AccessCredential>,
    /// The credential was saved for pairing and pairing has not finished:
    /// it may still be the pending one, which allows only `host.status`
    /// and `access.credential.finalize`.
    pub pairing_pending: bool,
}

/// A saved profile as a list of Hosts shows it: whether it has a usable
/// credential, and whether its pairing is unfinished.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct RemoteHostEntry {
    pub profile: RemoteHostProfile,
    pub has_credential: bool,
    pub pairing_pending: bool,
}

/// Why the profile store could not do what was asked.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum ProfileStoreError {
    /// The platform has no config directory (no home directory).
    #[error("cannot determine the platform config directory")]
    NoConfigDirectory,
    #[error("failed to access {}", path.display())]
    Io {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    /// A document exists but is not one this client wrote. It is left alone.
    #[error("{} is invalid: {reason}", path.display())]
    Invalid { path: PathBuf, reason: String },
    #[error("no remote Runtime Host profile {0}")]
    UnknownProfile(String),
    /// [`RemoteProfileStore::create`] with an id that is already saved.
    #[error("a remote Runtime Host profile {0} already exists; a new profile needs a new id")]
    DuplicateId(String),
    #[error("at most {PROFILE_COUNT_MAX} remote Runtime Host profiles can be saved")]
    TooManyProfiles,
    /// A save that changes where a saved profile points.
    #[error("the target of remote Runtime Host profile {0} cannot change; create a new profile")]
    TargetChanged(String),
    /// A new profile saved without a credential.
    #[error("remote Runtime Host profile {0} needs an access credential")]
    CredentialRequired(String),
    /// The local Host cannot be disabled or removed.
    #[error("the local Runtime Host cannot be disabled or removed")]
    LocalProfile,
    /// Disabling or removing the default Host.
    #[error("choose another default Runtime Host before disabling or removing {0}")]
    DefaultProfile(String),
    /// Removing a Host that is enabled.
    #[error("disable remote Runtime Host {0} before removing it")]
    ProfileEnabled(String),
    /// Making a disabled Host the default.
    #[error("enable remote Runtime Host {0} before making it the default")]
    NotEnabled(String),
    /// Enabling a Host whose pairing is unfinished.
    #[error("finish or discard the pairing of remote Runtime Host {0} first")]
    PairingPending(String),
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProfileDocument {
    schema_version: u32,
    profiles: Vec<RemoteHostProfile>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CredentialDocument {
    schema_version: u32,
    credentials: Vec<StoredCredential>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredCredential {
    profile_id: String,
    /// [`RemoteHostProfile::target_fingerprint`] when it was stored.
    target: String,
    credential: AccessCredential,
    /// Saved for pairing, which has not finished.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pending: bool,
}

/// The remote Host profiles of this client. Cheap to share by reference;
/// every call reads the files afresh.
#[derive(Debug)]
pub struct RemoteProfileStore {
    directory: PathBuf,
    /// Serializes read-modify-write cycles within this process.
    pub(crate) writes: Mutex<()>,
}

impl RemoteProfileStore {
    /// A store whose files live in `directory`.
    pub fn new(directory: impl Into<PathBuf>) -> Self {
        Self { directory: directory.into(), writes: Mutex::new(()) }
    }

    /// The store in [`CLIENT_CONFIG_DIRECTORY`] under the platform config
    /// directory, next to the client identity.
    pub fn in_config_directory() -> Result<Self, ProfileStoreError> {
        let config = dirs::config_dir().ok_or(ProfileStoreError::NoConfigDirectory)?;
        Ok(Self::new(config.join(CLIENT_CONFIG_DIRECTORY)))
    }

    pub fn directory(&self) -> &Path {
        &self.directory
    }

    /// Every saved profile, in the order they were added.
    pub async fn list(&self) -> Result<Vec<RemoteHostProfile>, ProfileStoreError> {
        Ok(self.read_profiles().await?.profiles)
    }

    /// The profile `id` and its credential.
    pub async fn resolve(&self, id: &str) -> Result<ResolvedRemoteHost, ProfileStoreError> {
        let profile = self
            .read_profiles()
            .await?
            .profiles
            .into_iter()
            .find(|profile| profile.id == id)
            .ok_or_else(|| ProfileStoreError::UnknownProfile(id.to_owned()))?;
        let credentials = self.read_credentials().await?;
        let stored = stored_for(&credentials, &profile);
        Ok(ResolvedRemoteHost {
            credential: stored.map(|stored| stored.credential.clone()),
            pairing_pending: stored.is_some_and(|stored| stored.pending),
            profile,
        })
    }

    /// Every saved profile, in the order they were added, with whether it
    /// has a credential for its target and whether its pairing is
    /// unfinished.
    pub async fn entries(&self) -> Result<Vec<RemoteHostEntry>, ProfileStoreError> {
        let profiles = self.read_profiles().await?.profiles;
        let credentials = self.read_credentials().await?;
        Ok(profiles
            .into_iter()
            .map(|profile| {
                let stored = stored_for(&credentials, &profile);
                RemoteHostEntry {
                    has_credential: stored.is_some(),
                    pairing_pending: stored.is_some_and(|stored| stored.pending),
                    profile,
                }
            })
            .collect())
    }

    /// Saves a new profile with its credential. Fails if the id is taken.
    pub async fn create(
        &self,
        profile: &RemoteHostProfile,
        credential: &AccessCredential,
    ) -> Result<(), ProfileStoreError> {
        self.write(profile, Some(credential), true, false).await
    }

    /// Saves a new profile with the credential it is about to pair with,
    /// marked pending until [`Self::mark_paired`]. Save it before pairing:
    /// once the Host finalizes, that credential is the active one.
    pub async fn create_pending(
        &self,
        profile: &RemoteHostProfile,
        credential: &AccessCredential,
    ) -> Result<(), ProfileStoreError> {
        self.write(profile, Some(credential), true, true).await
    }

    /// Records that the pairing of profile `id` finished: its credential is
    /// active. `false` when no credential is stored for it.
    pub async fn mark_paired(&self, id: &str) -> Result<bool, ProfileStoreError> {
        let _guard = self.writes.lock().await;
        let mut credentials = self.read_credentials().await?;
        let Some(stored) = credentials.credentials.iter_mut().find(|s| s.profile_id == id) else {
            return Ok(false);
        };
        if stored.pending {
            stored.pending = false;
            self.write_credentials(&credentials).await?;
        }
        Ok(true)
    }

    /// Saves `profile`, replacing the saved profile with its id, or adds it.
    /// A saved profile may change only its name; `credential`, when given,
    /// replaces the stored one. A new profile needs a credential.
    pub async fn save(
        &self,
        profile: &RemoteHostProfile,
        credential: Option<&AccessCredential>,
    ) -> Result<(), ProfileStoreError> {
        self.write(profile, credential, false, false).await
    }

    /// Removes the profile `id` and its credential. `false` when there was
    /// none. A Host that is enabled or the default is not removed
    /// (Desktop's `remove` in `runtime-host-profile-service.ts`).
    pub async fn remove(&self, id: &str) -> Result<bool, ProfileStoreError> {
        let _guard = self.writes.lock().await;
        let current = self.read_profiles().await?;
        if !current.profiles.iter().any(|profile| profile.id == id) {
            return Ok(false);
        }
        let selection = self.read_selection().await?;
        if selection.default_profile_id() == id {
            return Err(ProfileStoreError::DefaultProfile(id.to_owned()));
        }
        if selection.is_enabled(id) {
            return Err(ProfileStoreError::ProfileEnabled(id.to_owned()));
        }
        let credentials = self.read_credentials().await?;
        let next = ProfileDocument {
            schema_version: PROFILE_SCHEMA_VERSION,
            profiles: current.profiles.iter().filter(|profile| profile.id != id).cloned().collect(),
        };
        let remaining = CredentialDocument {
            schema_version: CREDENTIAL_SCHEMA_VERSION,
            credentials: credentials
                .credentials
                .iter()
                .filter(|stored| stored.profile_id != id)
                .cloned()
                .collect(),
        };
        // Desktop's order: the profile goes first, then its credential; a
        // failure restores the profile.
        self.write_profiles(&next).await?;
        if let Err(error) = self.write_credentials(&remaining).await {
            let _ = self.write_profiles(&current).await;
            return Err(error);
        }
        Ok(true)
    }

    async fn write(
        &self,
        profile: &RemoteHostProfile,
        credential: Option<&AccessCredential>,
        require_new: bool,
        pending: bool,
    ) -> Result<(), ProfileStoreError> {
        let _guard = self.writes.lock().await;
        let current = self.read_profiles().await?;
        let previous = current.profiles.iter().find(|saved| saved.id == profile.id);
        match previous {
            Some(_) if require_new => {
                return Err(ProfileStoreError::DuplicateId(profile.id.clone()));
            }
            Some(previous) if previous.target_fingerprint() != profile.target_fingerprint() => {
                return Err(ProfileStoreError::TargetChanged(profile.id.clone()));
            }
            None if current.profiles.len() >= PROFILE_COUNT_MAX => {
                return Err(ProfileStoreError::TooManyProfiles);
            }
            _ => {}
        }
        let credentials = self.read_credentials().await?;
        if credential.is_none()
            && (previous.is_none() || credential_for(&credentials, profile).is_none())
        {
            return Err(ProfileStoreError::CredentialRequired(profile.id.clone()));
        }
        let next = ProfileDocument {
            schema_version: PROFILE_SCHEMA_VERSION,
            profiles: if previous.is_some() {
                current
                    .profiles
                    .iter()
                    .map(
                        |saved| {
                            if saved.id == profile.id { profile.clone() } else { saved.clone() }
                        },
                    )
                    .collect()
            } else {
                current.profiles.iter().cloned().chain([profile.clone()]).collect()
            },
        };
        let Some(credential) = credential else {
            return self.write_profiles(&next).await;
        };
        let stored = StoredCredential {
            profile_id: profile.id.clone(),
            target: profile.target_fingerprint(),
            credential: credential.clone(),
            pending,
        };
        let next_credentials = CredentialDocument {
            schema_version: CREDENTIAL_SCHEMA_VERSION,
            credentials: credentials
                .credentials
                .iter()
                .filter(|saved| saved.profile_id != profile.id)
                .cloned()
                .chain([stored])
                .collect(),
        };
        // Desktop's order: the credential first, then the profile; a failure
        // restores the credentials.
        self.write_credentials(&next_credentials).await?;
        if let Err(error) = self.write_profiles(&next).await {
            let _ = self.write_credentials(&credentials).await;
            return Err(error);
        }
        Ok(())
    }

    fn profiles_path(&self) -> PathBuf {
        self.directory.join(REMOTE_PROFILES_FILE)
    }

    pub(crate) fn selection_path(&self) -> PathBuf {
        self.directory.join(HOST_SELECTION_FILE)
    }

    fn credentials_path(&self) -> PathBuf {
        self.directory.join(REMOTE_CREDENTIALS_FILE)
    }

    pub(crate) async fn profile_ids(&self) -> Result<Vec<String>, ProfileStoreError> {
        Ok(self.read_profiles().await?.profiles.into_iter().map(|profile| profile.id).collect())
    }

    async fn read_profiles(&self) -> Result<ProfileDocument, ProfileStoreError> {
        let path = self.profiles_path();
        let Some(bytes) = read_document(&path, PROFILE_DOCUMENT_MAX_BYTES).await? else {
            return Ok(ProfileDocument {
                schema_version: PROFILE_SCHEMA_VERSION,
                profiles: Vec::new(),
            });
        };
        let document: ProfileDocument = serde_json::from_slice(&bytes).map_err(|error| {
            ProfileStoreError::Invalid { path: path.clone(), reason: error.to_string() }
        })?;
        let invalid = |reason: &str| ProfileStoreError::Invalid {
            path: path.clone(),
            reason: reason.to_owned(),
        };
        if document.schema_version != PROFILE_SCHEMA_VERSION {
            return Err(invalid("unsupported schema version"));
        }
        if document.profiles.len() > PROFILE_COUNT_MAX {
            return Err(invalid("too many profiles"));
        }
        let mut ids = std::collections::HashSet::new();
        if !document.profiles.iter().all(|profile| ids.insert(profile.id.as_str())) {
            return Err(invalid("duplicate profile id"));
        }
        Ok(document)
    }

    async fn read_credentials(&self) -> Result<CredentialDocument, ProfileStoreError> {
        let path = self.credentials_path();
        let Some(bytes) = read_document(&path, CREDENTIAL_DOCUMENT_MAX_BYTES).await? else {
            return Ok(CredentialDocument {
                schema_version: CREDENTIAL_SCHEMA_VERSION,
                credentials: Vec::new(),
            });
        };
        let document: CredentialDocument = serde_json::from_slice(&bytes).map_err(|error| {
            ProfileStoreError::Invalid { path: path.clone(), reason: error.to_string() }
        })?;
        if document.schema_version != CREDENTIAL_SCHEMA_VERSION {
            return Err(ProfileStoreError::Invalid {
                path,
                reason: "unsupported schema version".to_owned(),
            });
        }
        Ok(document)
    }

    async fn write_profiles(&self, document: &ProfileDocument) -> Result<(), ProfileStoreError> {
        let path = self.profiles_path();
        let mut bytes = serde_json::to_vec_pretty(document)
            .map_err(|error| ProfileStoreError::Io { path: path.clone(), source: error.into() })?;
        bytes.push(b'\n');
        if bytes.len() as u64 > PROFILE_DOCUMENT_MAX_BYTES {
            return Err(ProfileStoreError::Invalid {
                path,
                reason: "exceeds its size limit".to_owned(),
            });
        }
        write_private(&path, &bytes).await.map_err(|source| ProfileStoreError::Io { path, source })
    }

    async fn write_credentials(
        &self,
        document: &CredentialDocument,
    ) -> Result<(), ProfileStoreError> {
        let path = self.credentials_path();
        let mut bytes = serde_json::to_vec_pretty(document)
            .map_err(|error| ProfileStoreError::Io { path: path.clone(), source: error.into() })?;
        bytes.push(b'\n');
        write_private(&path, &bytes).await.map_err(|source| ProfileStoreError::Io { path, source })
    }
}

/// The stored credential for `profile`, if its binding matches the
/// profile's current target.
fn credential_for(
    credentials: &CredentialDocument,
    profile: &RemoteHostProfile,
) -> Option<AccessCredential> {
    stored_for(credentials, profile).map(|stored| stored.credential.clone())
}

fn stored_for<'a>(
    credentials: &'a CredentialDocument,
    profile: &RemoteHostProfile,
) -> Option<&'a StoredCredential> {
    let target = profile.target_fingerprint();
    credentials
        .credentials
        .iter()
        .find(|stored| stored.profile_id == profile.id && stored.target == target)
}

/// The file's bytes, or `None` when it does not exist. A file that is not a
/// regular file or exceeds `max_bytes` is invalid.
pub(crate) async fn read_document(
    path: &Path,
    max_bytes: u64,
) -> Result<Option<Vec<u8>>, ProfileStoreError> {
    let metadata = match async_fs::symlink_metadata(path).await {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(source) => return Err(ProfileStoreError::Io { path: path.to_owned(), source }),
    };
    if !metadata.is_file() || metadata.len() > max_bytes {
        return Err(ProfileStoreError::Invalid {
            path: path.to_owned(),
            reason: "not a regular file within its size limit".to_owned(),
        });
    }
    async_fs::read(path)
        .await
        .map(Some)
        .map_err(|source| ProfileStoreError::Io { path: path.to_owned(), source })
}

/// Writes `bytes` to a new 0600 file beside `path` and renames it over
/// `path`, creating the directory (0700) first (`writeProfileDocument`).
pub(crate) async fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let directory = path.parent().unwrap_or(Path::new("."));
    let mut builder = async_fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use async_fs::unix::DirBuilderExt as _;
        builder.mode(0o700);
    }
    builder.create(directory).await?;
    let name = path.file_name().map(|name| name.to_string_lossy()).unwrap_or_default();
    let temporary = directory.join(format!(".{name}-{}.tmp", uuid::Uuid::new_v4().simple()));
    let mut options = async_fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use async_fs::unix::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let written = async {
        let mut file = options.open(&temporary).await?;
        file.write_all(bytes).await?;
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

#[cfg(test)]
// Test setup reads fixture files synchronously; no UI thread is involved.
#[allow(clippy::disallowed_methods)]
mod tests {
    use std::fs;

    use futures_lite::future::block_on;
    use host_protocol::{OperatorPlatform, SshTransport};
    use serde_json::json;

    use super::*;

    const ROOT_ID: &str = "67d440f2c07d4cf4e9f56a52aa2bf8e435c71602ddda6244987e201de0c4fb8d";

    struct Scratch(PathBuf);

    impl Scratch {
        fn new(name: &str) -> Self {
            Self(
                std::env::temp_dir()
                    .join(format!("host-client-profiles-{name}-{}", uuid::Uuid::new_v4().simple())),
            )
        }

        fn store(&self) -> RemoteProfileStore {
            RemoteProfileStore::new(self.0.join(CLIENT_CONFIG_DIRECTORY))
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).ok();
        }
    }

    fn tls_profile(id: &str) -> RemoteHostProfile {
        let transport = RemoteTransport::tls("wss://build.example.com/runtime-host").expect("tls");
        RemoteHostProfile::new(id, " Build box ", ROOT_ID, transport).expect("profile")
    }

    fn credential(value: &str) -> AccessCredential {
        AccessCredential::new(value).expect("credential")
    }

    #[test]
    fn a_created_profile_resolves_with_its_credential() {
        let scratch = Scratch::new("create");
        let store = scratch.store();
        assert!(block_on(store.list()).expect("empty").is_empty());
        let profile = tls_profile("build");
        assert_eq!(profile.name(), "Build box");
        block_on(store.create(&profile, &credential("mrha_one"))).expect("create");

        let resolved = block_on(store.resolve("build")).expect("resolve");
        assert_eq!(resolved.profile, profile);
        assert_eq!(resolved.credential, Some(credential("mrha_one")));
        assert!(matches!(
            block_on(store.create(&profile, &credential("mrha_two"))),
            Err(ProfileStoreError::DuplicateId(_))
        ));
        assert!(matches!(
            block_on(store.resolve("other")),
            Err(ProfileStoreError::UnknownProfile(_))
        ));

        let document: serde_json::Value = serde_json::from_slice(
            &fs::read(store.directory().join(REMOTE_PROFILES_FILE)).expect("profiles"),
        )
        .expect("json");
        assert_eq!(
            document,
            json!({
                "schemaVersion": 5,
                "profiles": [{
                    "id": "build",
                    "name": "Build box",
                    "kind": "remote",
                    "transport": {"kind": "tls", "url": "wss://build.example.com/runtime-host"},
                    "rootId": ROOT_ID
                }]
            })
        );
        let credentials = fs::read_to_string(store.directory().join(REMOTE_CREDENTIALS_FILE))
            .expect("credentials");
        assert!(credentials.contains("mrha_one"));
        assert!(
            !fs::read_to_string(store.directory().join(REMOTE_PROFILES_FILE))
                .expect("profiles")
                .contains("mrha_one")
        );
    }

    #[cfg(unix)]
    #[test]
    fn both_files_are_private_to_the_user() {
        use std::os::unix::fs::PermissionsExt as _;
        let scratch = Scratch::new("mode");
        let store = scratch.store();
        block_on(store.create(&tls_profile("build"), &credential("mrha_one"))).expect("create");
        for file in [REMOTE_PROFILES_FILE, REMOTE_CREDENTIALS_FILE] {
            let mode =
                fs::metadata(store.directory().join(file)).expect("file").permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "{file}");
        }
        let mode = fs::metadata(store.directory()).expect("dir").permissions().mode();
        assert_eq!(mode & 0o777, 0o700);
    }

    #[test]
    fn a_rename_keeps_the_credential_and_a_new_target_is_refused() {
        let scratch = Scratch::new("save");
        let store = scratch.store();
        let profile = tls_profile("build");
        block_on(store.create(&profile, &credential("mrha_one"))).expect("create");

        let renamed = profile.renamed("Build server").expect("rename");
        block_on(store.save(&renamed, None)).expect("rename keeps the credential");
        let resolved = block_on(store.resolve("build")).expect("resolve");
        assert_eq!(resolved.profile.name(), "Build server");
        assert_eq!(resolved.credential, Some(credential("mrha_one")));

        block_on(store.save(&renamed, Some(&credential("mrha_two")))).expect("replace credential");
        assert_eq!(
            block_on(store.resolve("build")).expect("resolve").credential,
            Some(credential("mrha_two"))
        );

        let moved = RemoteHostProfile::new(
            "build",
            "Build box",
            ROOT_ID,
            RemoteTransport::tls("wss://elsewhere.example.com/runtime-host").expect("tls"),
        )
        .expect("profile");
        assert!(matches!(
            block_on(store.save(&moved, Some(&credential("mrha_three")))),
            Err(ProfileStoreError::TargetChanged(_))
        ));
        assert!(matches!(
            block_on(store.save(&tls_profile("new"), None)),
            Err(ProfileStoreError::CredentialRequired(_))
        ));
    }

    #[test]
    fn a_credential_bound_to_another_target_is_not_handed_out() {
        let scratch = Scratch::new("binding");
        let store = scratch.store();
        block_on(store.create(&tls_profile("build"), &credential("mrha_one"))).expect("create");
        // Someone edits the profile document to point elsewhere.
        let path = store.directory().join(REMOTE_PROFILES_FILE);
        let edited = fs::read_to_string(&path)
            .expect("profiles")
            .replace("build.example.com", "evil.example.com");
        fs::write(&path, edited).expect("edit");
        let resolved = block_on(store.resolve("build")).expect("resolve");
        assert_eq!(
            resolved.profile.transport(),
            &RemoteTransport::tls("wss://evil.example.com/runtime-host").expect("tls")
        );
        assert_eq!(resolved.credential, None);
    }

    #[test]
    fn remove_drops_the_profile_and_its_credential() {
        let scratch = Scratch::new("remove");
        let store = scratch.store();
        block_on(store.create(&tls_profile("one"), &credential("mrha_one"))).expect("create");
        block_on(store.create(&tls_profile("two"), &credential("mrha_two"))).expect("create");
        assert!(block_on(store.remove("one")).expect("remove"));
        assert!(!block_on(store.remove("one")).expect("already gone"));
        let ids: Vec<_> =
            block_on(store.list()).expect("list").iter().map(|p| p.id().to_owned()).collect();
        assert_eq!(ids, ["two"]);
        let credentials = fs::read_to_string(store.directory().join(REMOTE_CREDENTIALS_FILE))
            .expect("credentials");
        assert!(!credentials.contains("mrha_one"));
        assert!(credentials.contains("mrha_two"));
    }

    #[test]
    fn a_damaged_document_is_reported_and_left_alone() {
        let scratch = Scratch::new("damaged");
        let store = scratch.store();
        fs::create_dir_all(store.directory()).expect("dir");
        let path = store.directory().join(REMOTE_PROFILES_FILE);
        fs::write(&path, "{not json").expect("write");
        assert!(matches!(block_on(store.list()), Err(ProfileStoreError::Invalid { .. })));
        assert!(block_on(store.create(&tls_profile("build"), &credential("mrha_one"))).is_err());
        assert_eq!(fs::read_to_string(&path).expect("kept"), "{not json");
    }

    #[test]
    fn profile_fields_follow_desktops_rules() {
        let transport = || RemoteTransport::tls("wss://h.example.com/x").expect("tls");
        for id in ["", "local", "-x", "a b", &"a".repeat(65)] {
            assert_eq!(
                RemoteHostProfile::new(id, "n", ROOT_ID, transport()),
                Err(ProfileError::InvalidId),
                "{id:?}"
            );
        }
        assert!(RemoteHostProfile::new(&"a".repeat(64), "n", ROOT_ID, transport()).is_ok());
        for name in ["", "  ", "a\u{7}", &"n".repeat(129)] {
            assert_eq!(
                RemoteHostProfile::new("x", name, ROOT_ID, transport()),
                Err(ProfileError::InvalidName),
                "{name:?}"
            );
        }
        assert_eq!(
            RemoteHostProfile::new("x", "n", "abc", transport()),
            Err(ProfileError::InvalidRootId)
        );
        let generated =
            RemoteHostProfile::with_new_id("n", ROOT_ID, transport()).expect("generated");
        assert!(generated.id().starts_with("remote-"));
    }

    #[test]
    fn target_fingerprints_follow_the_endpoint_not_the_name() {
        let tls = tls_profile("build");
        assert_eq!(
            tls.target_fingerprint(),
            tls.renamed("Other").expect("rename").target_fingerprint()
        );
        let ssh = |remote_port| {
            let transport =
                SshTransport::forward("me@box", None, remote_port, "/runtime-host").expect("ssh");
            RemoteHostProfile::new("ssh", "Box", ROOT_ID, RemoteTransport::Ssh(transport))
                .expect("profile")
        };
        assert_ne!(ssh(7000).target_fingerprint(), ssh(7001).target_fingerprint());
        let operator =
            OperatorCommand::node(OperatorPlatform::Posix, "/n", "/m.mjs").expect("operator");
        let activated = SshTransport::activated("me@box", None, operator).expect("ssh");
        let activated =
            RemoteHostProfile::new("ssh", "Box", ROOT_ID, RemoteTransport::Ssh(activated))
                .expect("profile");
        assert_ne!(activated.target_fingerprint(), ssh(7000).target_fingerprint());
        assert_eq!(tls.target_fingerprint().len(), 64);
    }
}
