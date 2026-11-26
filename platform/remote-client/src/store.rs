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

use crate::RemoteClientError;
use maka_remote_pairing::{PairingTicketPayload, RelayEndpoint};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs, io,
    path::{Path, PathBuf},
};

/// Routing and identity for a paired Host; deliberately no invitation or
/// relay credential fields.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostProfile {
    root_id: String,
    host_name: String,
    host_peer_id: String,
    relays: Vec<RelayEndpoint>,
    direct_endpoints: Vec<String>,
}

impl HostProfile {
    pub(crate) fn from_ticket(payload: &PairingTicketPayload) -> Self {
        Self {
            root_id: payload.root_id.clone(),
            host_name: payload.host_name.clone(),
            host_peer_id: payload.host_peer_id.clone(),
            relays: payload.relays.clone(),
            direct_endpoints: payload.direct_endpoints.clone(),
        }
    }

    pub fn root_id(&self) -> &str {
        &self.root_id
    }
    pub fn host_name(&self) -> &str {
        &self.host_name
    }
    pub fn host_peer_id(&self) -> &str {
        &self.host_peer_id
    }
    pub fn relays(&self) -> &[RelayEndpoint] {
        &self.relays
    }
    pub fn direct_endpoints(&self) -> &[String] {
        &self.direct_endpoints
    }
}

pub struct SavedHosts {
    path: PathBuf,
    profiles: BTreeMap<String, HostProfile>,
}

impl SavedHosts {
    pub fn load(path: impl Into<PathBuf>) -> Result<Self, RemoteClientError> {
        let path = path.into();
        let profiles = match fs::File::open(&path) {
            Ok(file) => serde_json::from_reader::<_, Vec<HostProfile>>(io::BufReader::new(file))?
                .into_iter()
                .map(|profile| (profile.root_id.clone(), profile))
                .collect(),
            Err(error) if error.kind() == io::ErrorKind::NotFound => BTreeMap::new(),
            Err(error) => return Err(error.into()),
        };
        Ok(Self { path, profiles })
    }

    pub fn get(&self, root_id: &str) -> Option<&HostProfile> {
        self.profiles.get(root_id)
    }

    pub fn hosts(&self) -> impl ExactSizeIterator<Item = &HostProfile> {
        self.profiles.values()
    }

    pub(crate) fn check_host_key(&self, profile: &HostProfile) -> Result<(), RemoteClientError> {
        if let Some(previous) = self.get(profile.root_id())
            && previous.host_peer_id != profile.host_peer_id
        {
            return Err(RemoteClientError::Protocol(
                "saved Host key differs from the pairing ticket".into(),
            ));
        }
        Ok(())
    }

    pub fn save(&mut self, profile: HostProfile) -> Result<(), RemoteClientError> {
        self.check_host_key(&profile)?;
        self.persist(
            self.hosts()
                .filter(|saved| saved.root_id != profile.root_id)
                .chain([&profile]),
        )?;
        self.profiles.insert(profile.root_id.clone(), profile);
        Ok(())
    }

    pub fn remove(&mut self, root_id: &str) -> Result<bool, RemoteClientError> {
        if self.get(root_id).is_none() {
            return Ok(false);
        }
        self.persist(self.hosts().filter(|saved| saved.root_id != root_id))?;
        self.profiles.remove(root_id);
        Ok(true)
    }

    fn persist<'a>(
        &self,
        profiles: impl Iterator<Item = &'a HostProfile>,
    ) -> Result<(), RemoteClientError> {
        let parent = self
            .path
            .parent()
            .filter(|dir| !dir.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        fs::create_dir_all(parent)?;
        // tempfile creates the file with 0600 permissions on Unix.
        let mut file = tempfile::NamedTempFile::new_in(parent)?;
        serde_json::to_writer(&mut file, &profiles.collect::<Vec<_>>())?;
        file.as_file().sync_all()?;
        file.persist(&self.path).map_err(|error| error.error)?;
        Ok(())
    }
}
