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

//! Remote Host pairing tickets, 6-digit SAS verification, and multi-computer
//! saved Host profiles for the iOS / remote workbench client.

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fmt, fs,
    io::{self, Write},
    path::{Component, Path, PathBuf},
};
use tempfile::NamedTempFile;
use thiserror::Error;

pub const PAIRING_URI_PREFIX: &str = "maka://pair/v1?payload=";

#[derive(Debug, Error, PartialEq, Eq)]
pub enum RemoteHostError {
    #[error("required field `{0}` must not be empty")]
    EmptyField(&'static str),
    #[error("invalid Root id `{0}`: must be a single path segment without separators")]
    InvalidRootId(String),
    #[error("host endpoints must not be empty")]
    EmptyEndpoints,
    #[error("invalid pairing ticket URI: {0}")]
    InvalidTicketUri(String),
    #[error("pairing ticket expired at {expires_at_ms} (now={now_ms})")]
    TicketExpired { expires_at_ms: u64, now_ms: u64 },
    #[error("unknown saved Host Root id `{0}`")]
    HostNotFound(String),
    #[error("peer id mismatch for Root `{root_id}`: pinned `{expected}`, incoming `{actual}`")]
    PeerIdMismatch {
        root_id: String,
        expected: String,
        actual: String,
    },
    #[error("saved Host storage error: {0}")]
    Storage(String),
}

fn require_non_empty(field: &'static str, value: &str) -> Result<(), RemoteHostError> {
    if value.trim().is_empty() {
        return Err(RemoteHostError::EmptyField(field));
    }
    Ok(())
}

/// Ensures `root_id` is a single normal path segment so `client_data_dir`
/// cannot traverse outside `<base_dir>/hosts`.
fn require_safe_root_id(root_id: &str) -> Result<(), RemoteHostError> {
    require_non_empty("rootId", root_id)?;
    let mut components = Path::new(root_id).components();
    let is_single_normal = matches!(components.next(), Some(Component::Normal(_)))
        && components.next().is_none()
        && !root_id.contains(['/', '\\']);
    if !is_single_normal {
        return Err(RemoteHostError::InvalidRootId(root_id.to_owned()));
    }
    Ok(())
}

fn require_endpoints(endpoints: &[String]) -> Result<(), RemoteHostError> {
    if endpoints.is_empty() || endpoints.iter().any(|ep| ep.trim().is_empty()) {
        return Err(RemoteHostError::EmptyEndpoints);
    }
    Ok(())
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawPairingTicketV1 {
    root_id: String,
    host_name: String,
    peer_id: String,
    endpoints: Vec<String>,
    pairing_token: String,
    nonce: String,
    expires_at_ms: u64,
}

/// QR / deep-link pairing ticket (`maka://pair/v1?payload=<base64url>`).
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "RawPairingTicketV1", into = "RawPairingTicketV1")]
pub struct PairingTicketV1 {
    root_id: String,
    host_name: String,
    peer_id: String,
    endpoints: Vec<String>,
    pairing_token: String,
    nonce: String,
    expires_at_ms: u64,
}

impl fmt::Debug for PairingTicketV1 {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PairingTicketV1")
            .field("root_id", &self.root_id)
            .field("host_name", &self.host_name)
            .field("peer_id", &self.peer_id)
            .field("endpoints", &self.endpoints)
            .field("pairing_token", &"<redacted>")
            .field("nonce", &self.nonce)
            .field("expires_at_ms", &self.expires_at_ms)
            .finish()
    }
}

impl PairingTicketV1 {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        root_id: impl Into<String>,
        host_name: impl Into<String>,
        peer_id: impl Into<String>,
        endpoints: Vec<String>,
        pairing_token: impl Into<String>,
        nonce: impl Into<String>,
        expires_at_ms: u64,
    ) -> Result<Self, RemoteHostError> {
        let root_id = root_id.into();
        let host_name = host_name.into();
        let peer_id = peer_id.into();
        let pairing_token = pairing_token.into();
        let nonce = nonce.into();
        require_safe_root_id(&root_id)?;
        require_non_empty("hostName", &host_name)?;
        require_non_empty("peerId", &peer_id)?;
        require_endpoints(&endpoints)?;
        require_non_empty("pairingToken", &pairing_token)?;
        require_non_empty("nonce", &nonce)?;
        Ok(Self {
            root_id,
            host_name,
            peer_id,
            endpoints,
            pairing_token,
            nonce,
            expires_at_ms,
        })
    }

    pub fn root_id(&self) -> &str {
        &self.root_id
    }

    pub fn host_name(&self) -> &str {
        &self.host_name
    }

    pub fn peer_id(&self) -> &str {
        &self.peer_id
    }

    pub fn endpoints(&self) -> &[String] {
        &self.endpoints
    }

    pub fn pairing_token(&self) -> &str {
        &self.pairing_token
    }

    pub fn nonce(&self) -> &str {
        &self.nonce
    }

    pub fn expires_at_ms(&self) -> u64 {
        self.expires_at_ms
    }

    pub fn encode_uri(&self) -> Result<String, RemoteHostError> {
        let json =
            serde_json::to_vec(self).map_err(|err| RemoteHostError::Storage(err.to_string()))?;
        Ok(format!(
            "{PAIRING_URI_PREFIX}{}",
            URL_SAFE_NO_PAD.encode(json)
        ))
    }

    pub fn decode_uri(uri: &str, now_ms: u64) -> Result<Self, RemoteHostError> {
        let encoded = uri.trim().strip_prefix(PAIRING_URI_PREFIX).ok_or_else(|| {
            RemoteHostError::InvalidTicketUri("missing maka://pair/v1 prefix".into())
        })?;
        let bytes = URL_SAFE_NO_PAD
            .decode(encoded)
            .map_err(|err| RemoteHostError::InvalidTicketUri(err.to_string()))?;
        let ticket: Self = serde_json::from_slice(&bytes)
            .map_err(|err| RemoteHostError::InvalidTicketUri(err.to_string()))?;
        if now_ms > ticket.expires_at_ms {
            return Err(RemoteHostError::TicketExpired {
                expires_at_ms: ticket.expires_at_ms,
                now_ms,
            });
        }
        Ok(ticket)
    }

    /// Deterministic 6-digit Short Authentication String (SAS).
    pub fn short_auth_code(&self, client_peer_id: &str) -> Result<String, RemoteHostError> {
        require_non_empty("clientPeerId", client_peer_id)?;
        let (first, second) = if self.peer_id.as_str() <= client_peer_id {
            (self.peer_id.as_str(), client_peer_id)
        } else {
            (client_peer_id, self.peer_id.as_str())
        };
        let mut hasher = Sha256::new();
        hasher.update(b"maka-peer-sas-v1\n");
        hasher.update(first.as_bytes());
        hasher.update(b"\n");
        hasher.update(second.as_bytes());
        hasher.update(b"\n");
        hasher.update(self.nonce.as_bytes());
        let digest = hasher.finalize();
        let raw = u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]) % 1_000_000;
        Ok(format!("{raw:06}"))
    }
}

impl TryFrom<RawPairingTicketV1> for PairingTicketV1 {
    type Error = RemoteHostError;

    fn try_from(raw: RawPairingTicketV1) -> Result<Self, Self::Error> {
        Self::new(
            raw.root_id,
            raw.host_name,
            raw.peer_id,
            raw.endpoints,
            raw.pairing_token,
            raw.nonce,
            raw.expires_at_ms,
        )
    }
}

impl From<PairingTicketV1> for RawPairingTicketV1 {
    fn from(ticket: PairingTicketV1) -> Self {
        Self {
            root_id: ticket.root_id,
            host_name: ticket.host_name,
            peer_id: ticket.peer_id,
            endpoints: ticket.endpoints,
            pairing_token: ticket.pairing_token,
            nonce: ticket.nonce,
            expires_at_ms: ticket.expires_at_ms,
        }
    }
}

/// Computer filter mode in the iOS navigation drawer (`全部电脑` vs single computer).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum HostViewFilter {
    #[default]
    AllComputers,
    SingleComputer {
        root_id: String,
    },
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawSavedHostProfile {
    root_id: String,
    host_name: String,
    peer_id: String,
    endpoints: Vec<String>,
    credential_id: String,
    last_connected_at_ms: Option<u64>,
    #[serde(default)]
    collapsed_in_all_view: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "RawSavedHostProfile", into = "RawSavedHostProfile")]
pub struct SavedHostProfile {
    root_id: String,
    host_name: String,
    peer_id: String,
    endpoints: Vec<String>,
    credential_id: String,
    last_connected_at_ms: Option<u64>,
    collapsed_in_all_view: bool,
}

impl SavedHostProfile {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        root_id: impl Into<String>,
        host_name: impl Into<String>,
        peer_id: impl Into<String>,
        endpoints: Vec<String>,
        credential_id: impl Into<String>,
        last_connected_at_ms: Option<u64>,
        collapsed_in_all_view: bool,
    ) -> Result<Self, RemoteHostError> {
        let root_id = root_id.into();
        let host_name = host_name.into();
        let peer_id = peer_id.into();
        let credential_id = credential_id.into();
        require_safe_root_id(&root_id)?;
        require_non_empty("hostName", &host_name)?;
        require_non_empty("peerId", &peer_id)?;
        require_endpoints(&endpoints)?;
        require_non_empty("credentialId", &credential_id)?;
        Ok(Self {
            root_id,
            host_name,
            peer_id,
            endpoints,
            credential_id,
            last_connected_at_ms,
            collapsed_in_all_view,
        })
    }

    pub fn root_id(&self) -> &str {
        &self.root_id
    }

    pub fn host_name(&self) -> &str {
        &self.host_name
    }

    pub fn peer_id(&self) -> &str {
        &self.peer_id
    }

    pub fn endpoints(&self) -> &[String] {
        &self.endpoints
    }

    pub fn credential_id(&self) -> &str {
        &self.credential_id
    }

    pub fn last_connected_at_ms(&self) -> Option<u64> {
        self.last_connected_at_ms
    }

    pub fn collapsed_in_all_view(&self) -> bool {
        self.collapsed_in_all_view
    }

    pub fn client_data_dir(&self, base_dir: &Path) -> PathBuf {
        base_dir.join("hosts").join(&self.root_id)
    }
}

impl TryFrom<RawSavedHostProfile> for SavedHostProfile {
    type Error = RemoteHostError;

    fn try_from(raw: RawSavedHostProfile) -> Result<Self, Self::Error> {
        Self::new(
            raw.root_id,
            raw.host_name,
            raw.peer_id,
            raw.endpoints,
            raw.credential_id,
            raw.last_connected_at_ms,
            raw.collapsed_in_all_view,
        )
    }
}

impl From<SavedHostProfile> for RawSavedHostProfile {
    fn from(profile: SavedHostProfile) -> Self {
        Self {
            root_id: profile.root_id,
            host_name: profile.host_name,
            peer_id: profile.peer_id,
            endpoints: profile.endpoints,
            credential_id: profile.credential_id,
            last_connected_at_ms: profile.last_connected_at_ms,
            collapsed_in_all_view: profile.collapsed_in_all_view,
        }
    }
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistedHostStoreV1 {
    version: u32,
    filter: HostViewFilter,
    hosts: Vec<SavedHostProfile>,
}

#[derive(Clone, Debug)]
pub struct SavedHostStore {
    path: PathBuf,
    filter: HostViewFilter,
    hosts: BTreeMap<String, SavedHostProfile>,
}

impl SavedHostStore {
    pub fn load_or_create(path: impl Into<PathBuf>) -> Result<Self, RemoteHostError> {
        let path = path.into();
        match fs::read(&path) {
            Ok(bytes) => {
                let persisted: PersistedHostStoreV1 = serde_json::from_slice(&bytes)
                    .map_err(|err| RemoteHostError::Storage(err.to_string()))?;
                if persisted.version != 1 {
                    return Err(RemoteHostError::Storage(format!(
                        "unsupported saved-hosts version {}",
                        persisted.version
                    )));
                }
                let mut hosts = BTreeMap::new();
                for profile in persisted.hosts {
                    hosts.insert(profile.root_id.clone(), profile);
                }
                let filter = match persisted.filter {
                    HostViewFilter::SingleComputer { root_id } if hosts.contains_key(&root_id) => {
                        HostViewFilter::SingleComputer { root_id }
                    }
                    _ => HostViewFilter::AllComputers,
                };
                Ok(Self {
                    path,
                    filter,
                    hosts,
                })
            }
            Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(Self {
                path,
                filter: HostViewFilter::AllComputers,
                hosts: BTreeMap::new(),
            }),
            Err(err) => Err(RemoteHostError::Storage(err.to_string())),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn filter(&self) -> &HostViewFilter {
        &self.filter
    }

    /// Validate that `peer_id` matches any already-pinned peer for `root_id`
    /// before performing network or disk side effects.
    pub fn check_peer_for_root(&self, root_id: &str, peer_id: &str) -> Result<(), RemoteHostError> {
        if let Some(existing) = self.hosts.get(root_id)
            && existing.peer_id != peer_id
        {
            return Err(RemoteHostError::PeerIdMismatch {
                root_id: root_id.to_owned(),
                expected: existing.peer_id.clone(),
                actual: peer_id.to_owned(),
            });
        }
        Ok(())
    }

    /// Return a validated next store snapshot with `filter` applied without
    /// touching disk yet (for offloading persistence to a blocking worker).
    pub fn stage_set_filter(&self, filter: HostViewFilter) -> Result<Self, RemoteHostError> {
        if let HostViewFilter::SingleComputer { ref root_id } = filter
            && !self.hosts.contains_key(root_id)
        {
            return Err(RemoteHostError::HostNotFound(root_id.clone()));
        }
        let mut next = self.clone();
        next.filter = filter;
        Ok(next)
    }

    pub fn set_filter(&mut self, filter: HostViewFilter) -> Result<(), RemoteHostError> {
        let next = self.stage_set_filter(filter)?;
        next.persist()?;
        *self = next;
        Ok(())
    }

    /// Return a validated next store snapshot with `profile` upserted without
    /// touching disk yet.
    pub fn stage_upsert_paired_host(
        &self,
        profile: SavedHostProfile,
    ) -> Result<Self, RemoteHostError> {
        self.check_peer_for_root(&profile.root_id, &profile.peer_id)?;
        let mut next = self.clone();
        next.hosts.insert(profile.root_id.clone(), profile);
        Ok(next)
    }

    pub fn upsert_paired_host(&mut self, profile: SavedHostProfile) -> Result<(), RemoteHostError> {
        let next = self.stage_upsert_paired_host(profile)?;
        next.persist()?;
        *self = next;
        Ok(())
    }

    pub fn update_endpoints(
        &mut self,
        root_id: &str,
        peer_id: &str,
        endpoints: Vec<String>,
    ) -> Result<(), RemoteHostError> {
        require_endpoints(&endpoints)?;
        let profile = self
            .hosts
            .get_mut(root_id)
            .ok_or_else(|| RemoteHostError::HostNotFound(root_id.to_owned()))?;
        if profile.peer_id != peer_id {
            return Err(RemoteHostError::PeerIdMismatch {
                root_id: root_id.to_owned(),
                expected: profile.peer_id.clone(),
                actual: peer_id.to_owned(),
            });
        }
        let previous = std::mem::replace(&mut profile.endpoints, endpoints);
        if let Err(err) = self.save() {
            self.hosts.get_mut(root_id).expect("host present").endpoints = previous;
            return Err(err);
        }
        Ok(())
    }

    pub fn set_computer_collapsed(
        &mut self,
        root_id: &str,
        collapsed: bool,
    ) -> Result<(), RemoteHostError> {
        let profile = self
            .hosts
            .get_mut(root_id)
            .ok_or_else(|| RemoteHostError::HostNotFound(root_id.to_owned()))?;
        let previous = profile.collapsed_in_all_view;
        profile.collapsed_in_all_view = collapsed;
        if let Err(err) = self.save() {
            self.hosts
                .get_mut(root_id)
                .expect("host present")
                .collapsed_in_all_view = previous;
            return Err(err);
        }
        Ok(())
    }

    /// Return a next store snapshot with `root_id` removed (and single-host
    /// filter reset if it pointed at `root_id`) without touching disk yet.
    pub fn stage_remove_host(&self, root_id: &str) -> (Self, bool) {
        let mut next = self.clone();
        if next.hosts.remove(root_id).is_none() {
            return (next, false);
        }
        if matches!(&next.filter, HostViewFilter::SingleComputer { root_id: current } if current == root_id)
        {
            next.filter = HostViewFilter::AllComputers;
        }
        (next, true)
    }

    pub fn remove_host(&mut self, root_id: &str) -> Result<bool, RemoteHostError> {
        let (next, removed) = self.stage_remove_host(root_id);
        if !removed {
            return Ok(false);
        }
        next.persist()?;
        *self = next;
        Ok(true)
    }

    pub fn get(&self, root_id: &str) -> Option<&SavedHostProfile> {
        self.hosts.get(root_id)
    }

    pub fn hosts(&self) -> impl ExactSizeIterator<Item = &SavedHostProfile> {
        self.hosts.values()
    }

    /// Atomically persist this store snapshot to disk with 0600 permissions on Unix.
    pub fn persist(&self) -> Result<(), RemoteHostError> {
        let parent = match self.path.parent() {
            Some(dir) if !dir.as_os_str().is_empty() => dir,
            _ => Path::new("."),
        };
        create_private_dir_if_missing(parent)
            .map_err(|err| RemoteHostError::Storage(err.to_string()))?;
        let persisted = PersistedHostStoreV1 {
            version: 1,
            filter: self.filter.clone(),
            hosts: self.hosts.values().cloned().collect(),
        };
        let encoded = serde_json::to_vec_pretty(&persisted)
            .map_err(|err| RemoteHostError::Storage(err.to_string()))?;
        let mut temp = NamedTempFile::new_in(parent)
            .map_err(|err| RemoteHostError::Storage(err.to_string()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            temp.as_file()
                .set_permissions(fs::Permissions::from_mode(0o600))
                .map_err(|err| RemoteHostError::Storage(err.to_string()))?;
        }
        temp.as_file_mut()
            .write_all(&encoded)
            .map_err(|err| RemoteHostError::Storage(err.to_string()))?;
        temp.as_file()
            .sync_all()
            .map_err(|err| RemoteHostError::Storage(err.to_string()))?;
        temp.persist(&self.path)
            .map_err(|err| RemoteHostError::Storage(err.error.to_string()))?;
        Ok(())
    }

    fn save(&self) -> Result<(), RemoteHostError> {
        self.persist()
    }
}

fn create_private_dir_if_missing(dir: &Path) -> io::Result<()> {
    if dir.is_dir() {
        return Ok(());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)
    }
    #[cfg(not(unix))]
    {
        fs::create_dir_all(dir)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn saved_host_store_pairs_rotates_ip_blocks_peer_hijack_and_rolls_back_on_io_error() {
        let temp = TempDir::new().unwrap();
        let store_path = temp.path().join("client").join("saved-hosts.json");
        let now_ms = 1_700_000_000_000u64;

        let ticket = PairingTicketV1::new(
            "root-mac",
            "MacBook Pro (M4 Max)",
            "peer-mac",
            vec![
                "quic://192.168.1.20:9443".into(),
                "wss://relay.example.com/mesh".into(),
            ],
            "tok_secret",
            "nonce_1",
            now_ms + 300_000,
        )
        .unwrap();
        let uri = ticket.encode_uri().unwrap();
        let decoded = PairingTicketV1::decode_uri(&uri, now_ms + 1_000).unwrap();
        assert_eq!(decoded, ticket);
        assert_eq!(decoded.short_auth_code("peer-iphone").unwrap().len(), 6);
        assert!(matches!(
            PairingTicketV1::decode_uri(&uri, now_ms + 300_001),
            Err(RemoteHostError::TicketExpired { .. })
        ));

        let mut store = SavedHostStore::load_or_create(&store_path).unwrap();
        store
            .upsert_paired_host(
                SavedHostProfile::new(
                    decoded.root_id(),
                    decoded.host_name(),
                    decoded.peer_id(),
                    decoded.endpoints().to_vec(),
                    "cred-mac",
                    Some(now_ms),
                    false,
                )
                .unwrap(),
            )
            .unwrap();
        store
            .upsert_paired_host(
                SavedHostProfile::new(
                    "root-ubuntu",
                    "Ubuntu Workstation",
                    "peer-ubuntu",
                    vec!["192.168.1.30:9443".into()],
                    "cred-ubuntu",
                    Some(now_ms),
                    false,
                )
                .unwrap(),
            )
            .unwrap();

        // IP change with matching pinned peer_id succeeds; mismatched peer_id is blocked.
        store
            .update_endpoints("root-mac", "peer-mac", vec!["10.0.0.88:9443".into()])
            .unwrap();
        assert!(matches!(
            store.update_endpoints("root-mac", "peer-evil", vec!["1.2.3.4:9443".into()]),
            Err(RemoteHostError::PeerIdMismatch { .. })
        ));

        store.set_computer_collapsed("root-ubuntu", true).unwrap();
        store
            .set_filter(HostViewFilter::SingleComputer {
                root_id: "root-mac".into(),
            })
            .unwrap();

        let mut reloaded = SavedHostStore::load_or_create(&store_path).unwrap();
        assert_eq!(
            reloaded.get("root-mac").unwrap().endpoints(),
            &["10.0.0.88:9443"]
        );
        assert!(reloaded.get("root-ubuntu").unwrap().collapsed_in_all_view());
        assert!(reloaded.remove_host("root-mac").unwrap());
        assert_eq!(reloaded.filter(), &HostViewFilter::AllComputers);

        // Path-traversal and absolute rootIds must be rejected at construction.
        for bad in ["../outside", "/tmp/evil", "a/b", "a\\b"] {
            assert!(matches!(
                SavedHostProfile::new(
                    bad,
                    "Bad",
                    "peer-bad",
                    vec!["127.0.0.1:9443".into()],
                    "cred",
                    None,
                    false,
                ),
                Err(RemoteHostError::InvalidRootId(_))
            ));
        }

        // Inject a real filesystem persist error (target path occupied by a non-empty directory)
        // and verify every mutating operation fails cleanly and rolls back in-memory state.
        fs::remove_file(&store_path).unwrap();
        fs::create_dir(&store_path).unwrap();
        fs::write(store_path.join("blocker"), b"cannot overwrite dir").unwrap();

        let err_upsert = reloaded
            .upsert_paired_host(
                SavedHostProfile::new(
                    "root-ephemeral",
                    "Should Roll Back",
                    "peer-ephemeral",
                    vec!["ws://127.0.0.1:9999".into()],
                    "cred-ephemeral",
                    Some(now_ms),
                    false,
                )
                .unwrap(),
            )
            .unwrap_err();
        assert!(matches!(err_upsert, RemoteHostError::Storage(_)));
        assert!(reloaded.get("root-ephemeral").is_none());

        let err_filter = reloaded
            .set_filter(HostViewFilter::SingleComputer {
                root_id: "root-ubuntu".into(),
            })
            .unwrap_err();
        assert!(matches!(err_filter, RemoteHostError::Storage(_)));
        assert_eq!(reloaded.filter(), &HostViewFilter::AllComputers);

        let err_remove = reloaded.remove_host("root-ubuntu").unwrap_err();
        assert!(matches!(err_remove, RemoteHostError::Storage(_)));
        assert!(reloaded.get("root-ubuntu").is_some());
    }
}
