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

//! Which Host a window opens on and which remote Hosts are offered: the
//! Host selection beside the remote profiles.
//!
//! Mirrors Desktop's preferences document (`DesktopRuntimeHostPreferences`,
//! `readRuntimeHostPreferences`, `writeRuntimeHostPreferences`, and the
//! normalization in `resolveDesktopRuntimeHostStartup`, all in
//! `apps/desktop/src/main/runtime-host-profile-service.ts`):
//! `{ "schemaVersion": 2, "defaultProfileId": "local", "enabledRemoteProfileIds": [] }`.
//! The default is `local` or a saved remote profile, and a remote default is
//! always enabled. A document that is not valid JSON, or not that shape,
//! reads as the Local defaults, as Desktop reads it.
//!
//! Desktop keeps every enabled Host connected at once; this client's window
//! talks to one Host at a time, so here "enabled" means offered: the Hosts a
//! window can be switched to. The rules are Desktop's: the local Host is
//! always enabled, the default cannot be disabled, a Host must be enabled to
//! become the default, and one whose pairing is unfinished cannot be
//! enabled.

use serde::{Deserialize, Serialize};

use crate::profiles::{LOCAL_PROFILE_ID, ProfileStoreError, RemoteProfileStore};
use crate::profiles::{read_document, write_private};

/// The selection document inside the client's config directory (Desktop's
/// `PREFERENCES_FILE`).
pub const HOST_SELECTION_FILE: &str = "runtime-host-profile-selection.json";

/// `PREFERENCES_SCHEMA_VERSION`.
const SELECTION_SCHEMA_VERSION: u32 = 2;

/// Larger than any valid selection of the 32 profiles a store keeps.
const SELECTION_DOCUMENT_MAX_BYTES: u64 = 16 * 1024;

/// The default Host and the enabled remote ones.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostSelection {
    schema_version: u32,
    default_profile_id: String,
    enabled_remote_profile_ids: Vec<String>,
}

impl Default for HostSelection {
    /// `defaultPreferences`: the local Host, nothing else enabled.
    fn default() -> Self {
        Self {
            schema_version: SELECTION_SCHEMA_VERSION,
            default_profile_id: LOCAL_PROFILE_ID.to_owned(),
            enabled_remote_profile_ids: Vec::new(),
        }
    }
}

impl HostSelection {
    /// The profile id a window opens on: [`LOCAL_PROFILE_ID`] or a remote
    /// profile's.
    pub fn default_profile_id(&self) -> &str {
        &self.default_profile_id
    }

    /// Whether the default is the local Host.
    pub fn default_is_local(&self) -> bool {
        self.default_profile_id == LOCAL_PROFILE_ID
    }

    /// The enabled remote profiles, sorted by id.
    pub fn enabled_remote_profile_ids(&self) -> &[String] {
        &self.enabled_remote_profile_ids
    }

    /// Whether the profile `id` is offered; the local Host always is.
    pub fn is_enabled(&self, id: &str) -> bool {
        id == LOCAL_PROFILE_ID
            || self.enabled_remote_profile_ids.iter().any(|enabled| enabled == id)
    }

    /// `isRuntimeHostPreferences`: schema 2, no `local` among the enabled
    /// ids, and no id twice.
    fn is_valid(&self) -> bool {
        let mut seen = std::collections::HashSet::new();
        self.schema_version == SELECTION_SCHEMA_VERSION
            && self
                .enabled_remote_profile_ids
                .iter()
                .all(|id| id != LOCAL_PROFILE_ID && seen.insert(id.as_str()))
    }

    /// The normalization of `resolveDesktopRuntimeHostStartup`: ids of
    /// profiles that are gone are dropped, a default that is gone becomes
    /// `local`, and a remote default is enabled.
    fn normalized(&self, profile_ids: &[String]) -> Self {
        let saved = |id: &String| profile_ids.contains(id);
        let default_profile_id = if self.default_is_local() || saved(&self.default_profile_id) {
            self.default_profile_id.clone()
        } else {
            LOCAL_PROFILE_ID.to_owned()
        };
        let mut enabled: Vec<String> =
            self.enabled_remote_profile_ids.iter().filter(|id| saved(id)).cloned().collect();
        if default_profile_id != LOCAL_PROFILE_ID && !enabled.contains(&default_profile_id) {
            enabled.push(default_profile_id.clone());
        }
        enabled.sort();
        Self {
            schema_version: SELECTION_SCHEMA_VERSION,
            default_profile_id,
            enabled_remote_profile_ids: enabled,
        }
    }

    /// `withEnabled`.
    fn with_enabled(&self, id: &str, enabled: bool) -> Self {
        let mut ids: Vec<String> =
            self.enabled_remote_profile_ids.iter().filter(|saved| *saved != id).cloned().collect();
        if enabled {
            ids.push(id.to_owned());
        }
        ids.sort();
        Self { enabled_remote_profile_ids: ids, ..self.clone() }
    }
}

impl RemoteProfileStore {
    /// The selection, normalized against the saved profiles. When the
    /// normalization changed it, the normalized selection is written back,
    /// as Desktop does at startup.
    pub async fn selection(&self) -> Result<HostSelection, ProfileStoreError> {
        let _guard = self.writes.lock().await;
        let stored = self.read_selection().await?;
        let normalized = stored.normalized(&self.profile_ids().await?);
        if normalized != stored {
            self.write_selection(&normalized).await?;
        }
        Ok(normalized)
    }

    /// Offers the remote profile `id` for switching, or stops offering it.
    /// The local Host cannot be disabled, nor can the default; a profile
    /// whose pairing is unfinished cannot be enabled.
    pub async fn set_enabled(
        &self,
        id: &str,
        enabled: bool,
    ) -> Result<HostSelection, ProfileStoreError> {
        let _guard = self.writes.lock().await;
        if id == LOCAL_PROFILE_ID {
            return if enabled {
                self.read_selection().await
            } else {
                Err(ProfileStoreError::LocalProfile)
            };
        }
        let resolved = self.resolve(id).await?;
        let current = self.read_selection().await?.normalized(&self.profile_ids().await?);
        if !enabled && current.default_profile_id == id {
            return Err(ProfileStoreError::DefaultProfile(id.to_owned()));
        }
        if enabled && resolved.pairing_pending {
            return Err(ProfileStoreError::PairingPending(id.to_owned()));
        }
        let next = current.with_enabled(id, enabled);
        self.write_selection(&next).await?;
        Ok(next)
    }

    /// Makes `id` (the local Host's or an enabled remote profile's) the
    /// Host a window opens on.
    pub async fn set_default(&self, id: &str) -> Result<HostSelection, ProfileStoreError> {
        let _guard = self.writes.lock().await;
        let current = self.read_selection().await?.normalized(&self.profile_ids().await?);
        if !current.is_enabled(id) {
            return Err(ProfileStoreError::NotEnabled(id.to_owned()));
        }
        let next = HostSelection { default_profile_id: id.to_owned(), ..current };
        self.write_selection(&next).await?;
        Ok(next)
    }

    /// The document as stored: the defaults when it is missing or not a
    /// selection (`readRuntimeHostPreferences`).
    pub(crate) async fn read_selection(&self) -> Result<HostSelection, ProfileStoreError> {
        let path = self.selection_path();
        let Some(bytes) = read_document(&path, SELECTION_DOCUMENT_MAX_BYTES).await? else {
            return Ok(HostSelection::default());
        };
        match serde_json::from_slice::<HostSelection>(&bytes) {
            Ok(selection) if selection.is_valid() => Ok(selection),
            _ => {
                log::warn!("{} is invalid; using the local Runtime Host", path.display());
                Ok(HostSelection::default())
            }
        }
    }

    async fn write_selection(&self, selection: &HostSelection) -> Result<(), ProfileStoreError> {
        let path = self.selection_path();
        let mut bytes = serde_json::to_vec_pretty(selection)
            .map_err(|error| ProfileStoreError::Io { path: path.clone(), source: error.into() })?;
        bytes.push(b'\n');
        write_private(&path, &bytes).await.map_err(|source| ProfileStoreError::Io { path, source })
    }
}

#[cfg(test)]
// Test setup reads and writes fixture files synchronously.
#[allow(clippy::disallowed_methods)]
mod tests {
    use std::fs;
    use std::path::PathBuf;

    use futures_lite::future::block_on;
    use host_protocol::{AccessCredential, RemoteTransport};
    use serde_json::json;

    use super::*;
    use crate::{CLIENT_CONFIG_DIRECTORY, RemoteHostProfile};

    const ROOT_ID: &str = "67d440f2c07d4cf4e9f56a52aa2bf8e435c71602ddda6244987e201de0c4fb8d";

    struct Scratch(PathBuf);

    impl Scratch {
        fn new(name: &str) -> Self {
            Self(
                std::env::temp_dir().join(format!(
                    "host-client-selection-{name}-{}",
                    uuid::Uuid::new_v4().simple()
                )),
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

    fn profile(id: &str) -> RemoteHostProfile {
        let transport = RemoteTransport::tls("wss://build.example.com/runtime-host").expect("tls");
        RemoteHostProfile::new(id, "Build box", ROOT_ID, transport).expect("profile")
    }

    fn credential() -> AccessCredential {
        AccessCredential::new("mrha_one").expect("credential")
    }

    fn stored(store: &RemoteProfileStore) -> serde_json::Value {
        serde_json::from_slice(
            &fs::read(store.directory().join(HOST_SELECTION_FILE)).expect("file"),
        )
        .expect("json")
    }

    #[test]
    fn without_a_document_the_local_host_is_the_default() {
        let scratch = Scratch::new("empty");
        let selection = block_on(scratch.store().selection()).expect("selection");
        assert_eq!(selection, HostSelection::default());
        assert!(selection.default_is_local());
        assert!(selection.is_enabled(LOCAL_PROFILE_ID));
        assert!(!selection.is_enabled("build"));
    }

    #[test]
    fn enabling_and_the_default_follow_desktops_rules() {
        let scratch = Scratch::new("rules");
        let store = scratch.store();
        block_on(store.create(&profile("build"), &credential())).expect("create");

        assert!(matches!(
            block_on(store.set_default("build")),
            Err(ProfileStoreError::NotEnabled(_))
        ));
        block_on(store.set_enabled("build", true)).expect("enable");
        let selection = block_on(store.set_default("build")).expect("default");
        assert_eq!(selection.default_profile_id(), "build");
        assert_eq!(
            stored(&store),
            json!({
                "schemaVersion": 2,
                "defaultProfileId": "build",
                "enabledRemoteProfileIds": ["build"]
            })
        );
        assert!(matches!(
            block_on(store.set_enabled("build", false)),
            Err(ProfileStoreError::DefaultProfile(_))
        ));
        assert!(matches!(
            block_on(store.remove("build")),
            Err(ProfileStoreError::DefaultProfile(_))
        ));
        assert!(matches!(
            block_on(store.set_enabled(LOCAL_PROFILE_ID, false)),
            Err(ProfileStoreError::LocalProfile)
        ));

        block_on(store.set_default(LOCAL_PROFILE_ID)).expect("back to local");
        assert!(matches!(
            block_on(store.remove("build")),
            Err(ProfileStoreError::ProfileEnabled(_))
        ));
        block_on(store.set_enabled("build", false)).expect("disable");
        assert!(block_on(store.remove("build")).expect("remove"));
        assert!(matches!(
            block_on(store.set_enabled("build", true)),
            Err(ProfileStoreError::UnknownProfile(_))
        ));
    }

    #[test]
    fn a_pairing_that_did_not_finish_cannot_be_enabled() {
        let scratch = Scratch::new("pending");
        let store = scratch.store();
        block_on(store.create_pending(&profile("code"), &credential())).expect("create");
        let resolved = block_on(store.resolve("code")).expect("resolve");
        assert!(resolved.pairing_pending);
        assert_eq!(resolved.credential, Some(credential()));
        assert!(matches!(
            block_on(store.set_enabled("code", true)),
            Err(ProfileStoreError::PairingPending(_))
        ));
        let entries = block_on(store.entries()).expect("entries");
        assert!(entries[0].pairing_pending && entries[0].has_credential);

        assert!(block_on(store.mark_paired("code")).expect("paired"));
        assert!(!block_on(store.resolve("code")).expect("resolve").pairing_pending);
        block_on(store.set_enabled("code", true)).expect("enable");
        let credentials =
            fs::read_to_string(store.directory().join(crate::REMOTE_CREDENTIALS_FILE))
                .expect("file");
        assert!(!credentials.contains("pending"), "{credentials}");
    }

    #[test]
    fn a_selection_naming_removed_profiles_is_normalized_and_written_back() {
        let scratch = Scratch::new("normalize");
        let store = scratch.store();
        block_on(store.create(&profile("kept"), &credential())).expect("create");
        fs::write(
            store.directory().join(HOST_SELECTION_FILE),
            json!({
                "schemaVersion": 2,
                "defaultProfileId": "kept",
                "enabledRemoteProfileIds": ["gone"]
            })
            .to_string(),
        )
        .expect("write");
        let selection = block_on(store.selection()).expect("selection");
        assert_eq!(selection.default_profile_id(), "kept");
        assert_eq!(selection.enabled_remote_profile_ids(), ["kept"]);
        assert_eq!(stored(&store)["enabledRemoteProfileIds"], json!(["kept"]));

        fs::write(
            store.directory().join(HOST_SELECTION_FILE),
            json!({"schemaVersion": 2, "defaultProfileId": "gone", "enabledRemoteProfileIds": []})
                .to_string(),
        )
        .expect("write");
        assert!(block_on(store.selection()).expect("selection").default_is_local());
    }

    #[test]
    fn a_damaged_selection_reads_as_the_local_defaults() {
        let scratch = Scratch::new("damaged");
        let store = scratch.store();
        fs::create_dir_all(store.directory()).expect("dir");
        for damaged in [
            "{not json".to_owned(),
            json!({"schemaVersion": 3, "defaultProfileId": "x", "enabledRemoteProfileIds": []})
                .to_string(),
            json!({"schemaVersion": 2, "defaultProfileId": "x", "enabledRemoteProfileIds": ["local"]})
                .to_string(),
            json!({"schemaVersion": 2, "defaultProfileId": "x", "enabledRemoteProfileIds": ["a", "a"]})
                .to_string(),
        ] {
            fs::write(store.directory().join(HOST_SELECTION_FILE), &damaged).expect("write");
            assert_eq!(
                block_on(store.read_selection()).expect("selection"),
                HostSelection::default(),
                "{damaged}"
            );
        }
    }
}
