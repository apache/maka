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

//! Immutable decision receipts and a CAS head, in ordinary plugin storage.
//! Opening this repository never replays pending Host work.
use super::{Error, Request, Snapshot, identifier, invalid};
use maka_plugins::storage::{Data, Mutation, Record, Store, StoreError};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};
use std::sync::Arc;

pub struct Repository {
    storage: Arc<dyn Store>,
    prefix: String,
    session: String,
    index: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Head {
    revision: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Decision {
    operation_id: String,
    fingerprint: String,
    snapshot: Snapshot,
}

/// Immutable revisions at a fixed watermark, ordered oldest first. Continuations
/// keep `through_revision` even when another caller advances the current state.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoryPage {
    pub through_revision: u64,
    pub snapshots: Vec<Snapshot>,
    pub next_after: Option<u64>,
}

const MAX_SNAPSHOT_BYTES: usize = 256 * 1024;
const MAX_PAGE_BYTES: usize = 512 * 1024;
const MAX_PAGE_ITEMS: usize = 8;

impl Repository {
    /// Package/scope is already bound by Host. Entry and Session divide the
    /// plugin's domain data, not authorization to query or execute a Session.
    pub fn new(storage: Arc<dyn Store>, entry: &str, session: &str) -> Result<Self, Error> {
        super::text(entry, 256)?;
        if entry.trim() != entry || entry.chars().any(char::is_control) {
            return Err(invalid("invalid Plan entry identity"));
        }
        identifier(session)?;
        Ok(Self {
            storage,
            session: session.into(),
            prefix: format!("plans/{}/", digest(&(entry, session))?),
            index: format!("plan-sessions/{}/{session}", digest(&entry)?),
        })
    }

    pub async fn current(&self) -> Result<Snapshot, Error> {
        self.head().await.map(|(_, snapshot)| snapshot)
    }

    /// Returns the original outcome, not a newer Session state. This is safe
    /// after a lost reply; changed inputs under the same operation are rejected.
    pub async fn receipt(&self, request: &Request) -> Result<Option<Snapshot>, Error> {
        let Some(decision) = self.operation(&request.operation_id).await? else {
            return Ok(None);
        };
        if decision.fingerprint != digest(request)? {
            return Err(Error::Conflict);
        }
        Ok(Some(decision.snapshot))
    }

    /// Observe a pinned decision after a lost reply, without reconstructing
    /// its authorization or retrying it. Absence is not proof of rejection.
    pub async fn outcome(&self, operation_id: &str) -> Result<Option<Snapshot>, Error> {
        Ok(self
            .operation(operation_id)
            .await?
            .map(|decision| decision.snapshot))
    }

    async fn operation(&self, operation_id: &str) -> Result<Option<Decision>, Error> {
        identifier(operation_id)?;
        let record = self.storage.read(self.operation_key(operation_id)?).await?;
        let Some(record) = record else {
            return Ok(None);
        };
        let revision: u64 = decode(record)?;
        let decision = self.decision(revision).await?;
        if decision.operation_id != operation_id {
            return Err(Error::Corrupt(
                "Plan operation index disagrees with its decision".into(),
            ));
        }
        Ok(Some(decision))
    }

    pub async fn apply(&self, request: &Request, now: u64) -> Result<Snapshot, Error> {
        if let Some(snapshot) = self.receipt(request).await? {
            return Ok(snapshot);
        }
        if now >= 1 << 53 {
            return Err(invalid("timestamp exceeds the protocol integer range"));
        }
        let (expected, mut snapshot) = self.head().await?;
        if snapshot.revision != request.expected_revision {
            return self.receipt(request).await?.ok_or(Error::Conflict);
        }
        // Host operation identities are package/scope-local, not Session-local.
        let operation = digest(&(&self.prefix, &request.operation_id))?;
        snapshot.apply(&request.command, &operation, &self.session, now)?;
        snapshot.revision = snapshot
            .revision
            .checked_add(1)
            .filter(|v| *v < 1 << 53)
            .ok_or_else(|| invalid("Plan revision exhausted"))?;
        let head = Head {
            revision: snapshot.revision,
        };
        if serde_json::to_vec(&snapshot).map_err(invalid)?.len() > MAX_SNAPSHOT_BYTES {
            return Err(invalid("Plan snapshot exceeds 256 KiB"));
        }
        let decision = Decision {
            operation_id: request.operation_id.clone(),
            fingerprint: digest(request)?,
            snapshot: snapshot.clone(),
        };
        let mut writes = vec![
            mutation(format!("{}head", self.prefix), expected, &head)?,
            mutation(self.decision_key(snapshot.revision), None, &decision)?,
            mutation(
                self.operation_key(&request.operation_id)?,
                None,
                &snapshot.revision,
            )?,
        ];
        if expected.is_none() {
            writes.push(mutation(self.index.clone(), None, &self.session)?);
        }
        match self.storage.batch(writes).await {
            Ok(_) => Ok(snapshot),
            Err(StoreError::Conflict { .. }) => {
                // A concurrent exact retry may have won the same CAS. Never
                // rebase a different decision onto state the caller did not see.
                self.receipt(request).await?.ok_or(Error::Conflict)
            }
            Err(error) => Err(error.into()),
        }
    }

    pub async fn sessions(storage: &dyn Store, entry: &str) -> Result<Vec<String>, Error> {
        let prefix = format!("plan-sessions/{}/", digest(&entry)?);
        let mut after = None;
        let mut sessions = Vec::new();
        loop {
            let page = storage
                .scan(maka_plugins::storage::Scan {
                    prefix: prefix.clone(),
                    after,
                })
                .await?;
            for item in page.entries {
                let session: String = decode(item.record)?;
                identifier(&session)?;
                sessions.push(session);
            }
            after = page.next_after;
            if after.is_none() {
                return Ok(sessions);
            }
        }
    }

    pub async fn at(&self, revision: u64) -> Result<Snapshot, Error> {
        self.decision(revision)
            .await
            .map(|decision| decision.snapshot)
    }

    /// A bounded historical read, not a live projection assembled across writes.
    pub async fn history(
        &self,
        through_revision: Option<u64>,
        after: u64,
    ) -> Result<HistoryPage, Error> {
        let (_, current) = self.head().await?;
        let through = through_revision.unwrap_or(current.revision);
        if after > through || through > current.revision {
            return Err(invalid(
                "Plan history cursor is outside the committed revisions",
            ));
        }
        let mut page = HistoryPage {
            through_revision: through,
            snapshots: Vec::new(),
            next_after: None,
        };
        let mut bytes = 256; // JSON envelope and separators.
        let mut last = after;
        while last < through && page.snapshots.len() < MAX_PAGE_ITEMS {
            let snapshot = self.decision(last + 1).await?.snapshot;
            let size = serde_json::to_vec(&snapshot).map_err(invalid)?.len();
            if size > MAX_SNAPSHOT_BYTES {
                return Err(Error::Corrupt("oversized Plan snapshot".into()));
            }
            if bytes + size + 1 > MAX_PAGE_BYTES {
                break;
            }
            bytes += size + 1;
            last += 1;
            page.snapshots.push(snapshot);
        }
        page.next_after = (last < through).then_some(last);
        Ok(page)
    }

    async fn head(&self) -> Result<(Option<u64>, Snapshot), Error> {
        let Some(record) = self.storage.read(format!("{}head", self.prefix)).await? else {
            return Ok((None, Snapshot::default()));
        };
        let revision = record.revision;
        let head: Head = decode(record)?;
        let decision = self.decision(head.revision).await?;
        // Receipt is immutable: even if head advanced while reading, this is
        // a complete committed snapshot and its old CAS revision will conflict.
        Ok((Some(revision), decision.snapshot))
    }

    async fn decision(&self, revision: u64) -> Result<Decision, Error> {
        if revision == 0 || revision >= 1 << 53 {
            return Err(Error::Corrupt("invalid Plan revision".into()));
        }
        let record = self
            .storage
            .read(self.decision_key(revision))
            .await?
            .ok_or_else(|| Error::Corrupt("Plan revision has no decision receipt".into()))?;
        let decision: Decision = decode(record)?;
        if decision.snapshot.revision != revision {
            return Err(Error::Corrupt(
                "Plan decision revision disagrees with its key".into(),
            ));
        }
        Ok(decision)
    }

    fn decision_key(&self, revision: u64) -> String {
        format!("{}revisions/{revision:016}", self.prefix)
    }

    fn operation_key(&self, operation: &str) -> Result<String, Error> {
        Ok(format!("{}operations/{}", self.prefix, digest(&operation)?))
    }
}

fn digest(value: &impl Serialize) -> Result<String, Error> {
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(value).map_err(invalid)?)
    ))
}
fn decode<T: DeserializeOwned>(record: Record) -> Result<T, Error> {
    match record.data {
        Data::Present(value) => {
            serde_json::from_value(value).map_err(|e| Error::Corrupt(e.to_string()))
        }
        Data::Deleted => Err(Error::Corrupt("Plan decision was deleted".into())),
    }
}
fn mutation(key: String, revision: Option<u64>, value: &impl Serialize) -> Result<Mutation, Error> {
    let mutation = Mutation {
        key,
        expected_revision: revision,
        data: Data::Present(serde_json::to_value(value).map_err(invalid)?),
    };
    mutation.validate().map_err(invalid)?;
    Ok(mutation)
}
