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

use std::{collections::HashSet, path::PathBuf};

use libp2p::{Multiaddr, PeerId};
use serde_json::{Map, Value, json};
use tokio::{io::AsyncWriteExt as _, sync::watch, task::JoinHandle};

use super::{PeerError, coordination_relay_peer_id, supported_relay_address};

const MAX_ANCHOR_PEERS: usize = 8;
const MAX_ADDRESSES_PER_ANCHOR: usize = 4;
const MAX_STATE_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct RelayAnchor {
    pub peer_id: PeerId,
    pub addresses: Vec<Multiaddr>,
}

pub(super) struct RelayAnchorHistory {
    anchors: Vec<RelayAnchor>,
    updates: Option<watch::Sender<Option<Vec<RelayAnchor>>>>,
    writer: Option<JoinHandle<()>>,
}

impl RelayAnchorHistory {
    pub async fn open(path: Option<PathBuf>, local_peer_id: PeerId) -> Self {
        let anchors = match path.as_ref() {
            Some(path) => match read(path, local_peer_id).await {
                Ok(anchors) => anchors,
                Err(error) => {
                    eprintln!(
                        "[peer-relay-anchor] ignored unusable history: {}: {}",
                        error.code, error.message
                    );
                    Vec::new()
                }
            },
            None => Vec::new(),
        };
        let Some(path) = path else {
            return Self {
                anchors,
                updates: None,
                writer: None,
            };
        };
        // History is a snapshot, not a journal. Coalesce churn into one pending
        // latest value so slow storage cannot create an unbounded write queue.
        let (updates, mut receiver) = watch::channel::<Option<Vec<RelayAnchor>>>(None);
        let writer = tokio::spawn(async move {
            while receiver.changed().await.is_ok() {
                let Some(anchors) = receiver.borrow_and_update().clone() else {
                    continue;
                };
                if let Err(error) = write(&path, local_peer_id, &anchors).await {
                    eprintln!(
                        "[peer-relay-anchor] could not persist history: {}: {}",
                        error.code, error.message
                    );
                }
            }
        });
        Self {
            anchors,
            updates: Some(updates),
            writer: Some(writer),
        }
    }

    pub fn anchors(&self) -> &[RelayAnchor] {
        &self.anchors
    }

    pub fn remember(&mut self, peer_id: PeerId, addresses: &[Multiaddr]) {
        let mut accepted = Vec::new();
        for address in addresses {
            if coordination_relay_peer_id(address).ok() == Some(peer_id)
                && supported_relay_address(address, false)
                && !accepted.contains(address)
            {
                accepted.push(address.clone());
                if accepted.len() == MAX_ADDRESSES_PER_ANCHOR {
                    break;
                }
            }
        }
        if accepted.is_empty() {
            return;
        }
        if let Some(anchor) = self
            .anchors
            .iter_mut()
            .find(|anchor| anchor.peer_id == peer_id)
        {
            if anchor.addresses == accepted {
                return;
            }
            anchor.addresses = accepted;
        } else {
            self.anchors.insert(
                0,
                RelayAnchor {
                    peer_id,
                    addresses: accepted,
                },
            );
        }
        self.anchors.truncate(MAX_ANCHOR_PEERS);
        if let Some(updates) = &self.updates {
            updates.send_replace(Some(self.anchors.clone()));
        }
    }

    pub async fn close(mut self) {
        self.updates.take();
        if let Some(writer) = self.writer.take() {
            let _ = writer.await;
        }
    }
}

async fn read(path: &PathBuf, expected_peer_id: PeerId) -> Result<Vec<RelayAnchor>, PeerError> {
    let bytes = match tokio::fs::read(path).await {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(invalid_state(error)),
    };
    if bytes.len() > MAX_STATE_BYTES {
        return Err(invalid_state("relay anchor history is too large"));
    }
    let document = serde_json::from_slice::<Value>(&bytes).map_err(invalid_state)?;
    let record = exact_object(&document, &["version", "localPeerId", "anchors"])?;
    if record.get("version").and_then(Value::as_u64) != Some(1)
        || record.get("localPeerId").and_then(Value::as_str)
            != Some(expected_peer_id.to_string().as_str())
    {
        return Err(invalid_state(
            "relay anchor history belongs to another peer",
        ));
    }
    let entries = record
        .get("anchors")
        .and_then(Value::as_array)
        .filter(|entries| entries.len() <= MAX_ANCHOR_PEERS)
        .ok_or_else(|| invalid_state("invalid relay anchor entries"))?;
    let mut seen = HashSet::new();
    let mut anchors = Vec::with_capacity(entries.len());
    for entry in entries {
        let entry = exact_object(entry, &["peerId", "addresses"])?;
        let peer_id = entry
            .get("peerId")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid_state("invalid relay anchor peer"))?
            .parse::<PeerId>()
            .map_err(invalid_state)?;
        if peer_id == expected_peer_id || !seen.insert(peer_id) {
            return Err(invalid_state("duplicate or local relay anchor peer"));
        }
        let addresses = entry
            .get("addresses")
            .and_then(Value::as_array)
            .filter(|addresses| {
                !addresses.is_empty() && addresses.len() <= MAX_ADDRESSES_PER_ANCHOR
            })
            .ok_or_else(|| invalid_state("invalid relay anchor addresses"))?
            .iter()
            .map(|address| {
                address
                    .as_str()
                    .ok_or_else(|| invalid_state("invalid relay anchor address"))?
                    .parse::<Multiaddr>()
                    .map_err(invalid_state)
            })
            .collect::<Result<Vec<_>, _>>()?;
        if addresses.iter().any(|address| {
            coordination_relay_peer_id(address).ok() != Some(peer_id)
                || !supported_relay_address(address, false)
        }) || addresses.iter().collect::<HashSet<_>>().len() != addresses.len()
        {
            return Err(invalid_state(
                "relay anchor address is not bound to its peer",
            ));
        }
        anchors.push(RelayAnchor { peer_id, addresses });
    }
    Ok(anchors)
}

async fn write(
    path: &PathBuf,
    local_peer_id: PeerId,
    anchors: &[RelayAnchor],
) -> Result<(), PeerError> {
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(invalid_state)?;
    }
    let document = json!({
        "version": 1,
        "localPeerId": local_peer_id.to_string(),
        "anchors": anchors.iter().map(|anchor| json!({
            "peerId": anchor.peer_id.to_string(),
            "addresses": anchor.addresses.iter().map(ToString::to_string).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
    });
    let bytes = serde_json::to_vec_pretty(&document).map_err(invalid_state)?;
    if bytes.len() > MAX_STATE_BYTES {
        return Err(invalid_state("relay anchor history is too large"));
    }
    let temporary = path.with_extension("tmp");
    let _ = tokio::fs::remove_file(&temporary).await;
    let mut options = tokio::fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        options.mode(0o600);
    }
    let mut file = options.open(&temporary).await.map_err(invalid_state)?;
    file.write_all(&bytes).await.map_err(invalid_state)?;
    file.write_all(b"\n").await.map_err(invalid_state)?;
    file.sync_all().await.map_err(invalid_state)?;
    drop(file);
    #[cfg(windows)]
    if tokio::fs::try_exists(path).await.unwrap_or(false) {
        tokio::fs::remove_file(path).await.map_err(invalid_state)?;
    }
    if let Err(error) = tokio::fs::rename(&temporary, path).await {
        let _ = tokio::fs::remove_file(&temporary).await;
        return Err(invalid_state(error));
    }
    Ok(())
}

fn exact_object<'a>(value: &'a Value, keys: &[&str]) -> Result<&'a Map<String, Value>, PeerError> {
    let record = value
        .as_object()
        .ok_or_else(|| invalid_state("invalid relay anchor document"))?;
    if record.len() != keys.len() || keys.iter().any(|key| !record.contains_key(*key)) {
        return Err(invalid_state("invalid relay anchor document fields"));
    }
    Ok(record)
}

fn invalid_state(error: impl std::fmt::Display) -> PeerError {
    PeerError::new("peer_native_failed", error.to_string())
}
