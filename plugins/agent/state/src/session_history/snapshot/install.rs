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
use super::*;
use crate::{Admission, Change, store::Mode};
use sha2::{Digest, Sha256};
use uuid::Uuid;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Adoption {
    pub run: RunId,
    pub admitted: FactId,
    pub installed: FactId,
}

/// A concrete Statement remains typed until Root composes metadata creation or
/// restore and the original SDK Returned in the same transaction.
pub struct AdoptSnapshot {
    source: Snapshot,
    target: HistoryNamespace,
    operation: Uuid,
    spec: RunSpec,
    at: UnixMillis,
    contents: Vec<ContentBlob>,
}
impl Snapshot {
    pub fn adopt(
        &self,
        target: &SessionHistory,
        operation: Uuid,
        spec: RunSpec,
        at: UnixMillis,
        contents: Vec<ContentBlob>,
    ) -> Result<AdoptSnapshot, StoreError> {
        if operation.is_nil() || !self.data.same_root(&target.data) {
            return Err(invalid(
                "snapshot adoption is not attached to the actual target Root",
            ));
        }
        if spec.owner != target.namespace.owner
            || spec.session_id != target.namespace.session
            || !matches!(spec.backend, BackendSpec::Historical {})
        {
            return Err(invalid(
                "historical source metadata differs from the actual target scope",
            ));
        }
        let reference = match &spec.origin {
            RunOrigin::Imported { source } | RunOrigin::Forked { source, .. } => source,
            RunOrigin::Local => {
                return Err(invalid(
                    "snapshot installation cannot claim local execution",
                ));
            }
        };
        if reference != &self.manifest {
            return Err(invalid(
                "historical source does not name its original immutable snapshot",
            ));
        }
        Ok(AdoptSnapshot {
            source: self.clone(),
            target: target.namespace.clone(),
            operation,
            spec,
            at,
            contents,
        })
    }
}
impl AdoptSnapshot {
    pub(crate) fn catalog_inputs(&self) -> (&Snapshot, &RunSpec, UnixMillis) {
        (&self.source, &self.spec, self.at)
    }
    pub fn adoption(&self) -> Result<Adoption, StoreError> {
        Ok(Adoption {
            run: RunId::try_from(self.operation).map_err(invalid)?,
            admitted: fact_id(self.operation, "admitted")?,
            installed: fact_id(self.operation, "installed")?,
        })
    }
}
impl Statement for AdoptSnapshot {
    type Value = Adoption;
    type Output = Adoption;
    fn execute(self, c: &Connection) -> Result<Prepared<Adoption>, StoreError> {
        let adoption = self.adoption()?;
        let old:Option<(String,String,String)>=c.query_row("SELECT a.snapshot,r.owner,r.session FROM agent_history_snapshot_adoptions a JOIN agent_run_specs r ON r.run=a.run WHERE a.run=?",[adoption.run.to_string()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
        if let Some((snapshot, owner, session)) = old {
            if snapshot != self.source.id.to_string()
                || owner != serde_json::to_string(&self.target.owner)?
                || session != self.target.session
            {
                return Err(StoreError::EventConflict);
            }
            let view = crate::sql::load(c, adoption.run, &[], false)?;
            if view.terminal != Some(Terminal::Completed)
                || view.spec.origin == RunOrigin::Local
                || !matches!(view.spec.backend, BackendSpec::Historical {})
            {
                return Err(invalid(
                    "historical installation receipt has an incomplete original marker",
                ));
            }
            return Ok(Prepared {
                value: adoption,
                changed: false,
                notification: Notification::NONE,
            });
        }
        read::authorize(c, &self.source)?;
        if let RunOrigin::Forked { source_run, .. } = &self.spec.origin {
            read::Run(self.source.clone(), *source_run).execute(c)?;
        }
        let active:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM agent_runs WHERE owner=? AND session=? AND local=1 AND terminal IS NULL)",params![serde_json::to_string(&self.target.owner)?,self.target.session],|r|r.get(0))?;
        if active {
            return Err(invalid(
                "historical source cannot replace an active execution",
            ));
        }
        let admission = Admission {
            run: adoption.run,
            id: adoption.admitted,
            spec: self.spec,
            at: self.at,
            contents: self.contents,
            queue: None,
            guard: None,
        };
        let (commit, _) = crate::sql::admit(c, admission)?;
        c.execute(
            "INSERT INTO agent_history_snapshot_adoptions VALUES(?,?,?)",
            params![
                adoption.run.to_string(),
                self.source.id.to_string(),
                adoption.admitted.to_string()
            ],
        )?;
        // Source closure is immutable data. Old grants and background approvals
        // remain only in the opaque snapshot; no current issuer/KV is replayed.
        c.execute("INSERT OR IGNORE INTO agent_content_pins(run,content_id) SELECT ?1,content_id FROM agent_history_snapshot_pins WHERE snapshot=?2",params![adoption.run.to_string(),self.source.id.to_string()])?;
        let sequence: u64 = c.query_row(
            "SELECT sequence FROM agent_facts WHERE id=? AND run=?",
            params![adoption.admitted.to_string(), adoption.run.to_string()],
            |r| read_u64(r, 0),
        )?;
        c.execute("INSERT OR IGNORE INTO agent_history_content_refs(owner,session,run,content_id,first_sequence) SELECT ?1,?2,?3,content_id,?4 FROM agent_history_snapshot_pins WHERE snapshot=?5",params![serde_json::to_string(&self.target.owner)?,self.target.session,adoption.run.to_string(),bind_u64(sequence)?,self.source.id.to_string()])?;
        let done = Change {
            id: adoption.installed,
            at: self.at,
            fact: Fact::RunTerminated {
                terminal: Terminal::Completed,
                diagnostic: None,
            },
        };
        crate::sql::append(
            c,
            adoption.run,
            Some(commit.head),
            &[done],
            crate::sql::AppendMaterial {
                contents: vec![],
                artifacts: &crate::artifacts::ArtifactBatch::default(),
            },
            &Mode::Historical,
            None,
        )?;
        let notification = crate::sql::notification(c, adoption.run, true)?;
        Ok(Prepared {
            value: adoption,
            changed: true,
            notification,
        })
    }
    fn committed(value: Adoption) -> Adoption {
        value
    }
    fn isolated_rejection(error: &StoreError) -> bool {
        matches!(
            error,
            StoreError::InvalidTransition(_)
                | StoreError::EventConflict
                | StoreError::RevisionConflict { .. }
        )
    }
}
fn fact_id(operation: Uuid, kind: &str) -> Result<FactId, StoreError> {
    let hash = Sha256::digest(serde_json::to_vec(&(
        "maka.history-source.install.v1",
        operation,
        kind,
    ))?);
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&hash[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    FactId::try_from(Uuid::from_bytes(bytes)).map_err(invalid)
}
