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

use crate::store::invalid;
use maka_agent_facts::memory::*;
use maka_event_log::{
    StoreError,
    connection::Query,
    writeback::{Notification, Prepared, Statement},
};
use rusqlite::{Connection, OptionalExtension, params};
use sha2::{Digest, Sha256};

mod matching;

fn revision_value(value: i64) -> Result<MemoryRevision, StoreError> {
    Ok(MemoryRevision(
        u64::try_from(value).map_err(|_| invalid("negative memory revision"))?,
    ))
}

#[derive(Clone)]
pub struct Scope {
    pub namespace: String,
    pub location: String,
    pub binding: Option<(String, maka_sandbox::workspace::PermissionBasis)>,
}

impl Scope {
    fn validate(&self, c: &Connection) -> Result<(), StoreError> {
        if let Some((session, expected)) = &self.binding
            && crate::interactions::sql::current_basis(c, session)? != Some(*expected)
        {
            return Err(invalid("memory scope binding changed"));
        }
        Ok(())
    }
}

fn record(
    c: &Connection,
    scope: &Scope,
    id: &MemoryId,
) -> Result<Option<MemoryRecord>, StoreError> {
    scope.validate(c)?;
    let row = c.query_row("SELECT m.revision,m.mode,m.state,v.body,m.created_at,m.modified_at,v.metadata,m.assertion FROM agent_memories m JOIN agent_memory_versions v ON v.namespace=m.namespace AND v.scope=m.scope AND v.id=m.id AND v.revision=m.assertion WHERE m.namespace=?1 AND m.scope=?2 AND m.id=?3 AND m.state='active'", params![scope.namespace,scope.location,id.0.to_string()], |r| Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get(4)?,r.get(5)?,r.get::<_,String>(6)?,r.get::<_,i64>(7)?))).optional()?;
    row.map(
        |(revision, mode, state, body, created_at, modified_at, metadata, assertion)| {
            Ok(MemoryRecord {
                assertion: revision_value(assertion)?,
                id: id.clone(),
                revision: revision_value(revision)?,
                mode: serde_json::from_value(serde_json::Value::String(mode))?,
                state: serde_json::from_value(serde_json::Value::String(state))?,
                body,
                metadata: serde_json::from_str(&metadata)?,
                created_at,
                modified_at,
            })
        },
    )
    .transpose()
}
pub struct Read {
    pub scope: Scope,
    pub id: MemoryId,
}
impl Query for Read {
    type Output = Option<MemoryRecord>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        record(c, &self.scope, &self.id)
    }
}
pub struct Page {
    pub scope: Scope,
    pub after: Option<MemoryId>,
    pub limit: u32,
}
impl Query for Page {
    type Output = Vec<MemoryRecord>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        self.scope.validate(c)?;
        if !(1..=101).contains(&self.limit) {
            return Err(invalid("memory page limit"));
        }
        let mut statement=c.prepare("SELECT m.id,m.revision,m.mode,v.body,m.created_at,m.modified_at,v.metadata,m.assertion FROM agent_memories m JOIN agent_memory_versions v ON v.namespace=m.namespace AND v.scope=m.scope AND v.id=m.id AND v.revision=m.assertion WHERE m.namespace=?1 AND m.scope=?2 AND m.state='active' AND m.id>?3 ORDER BY m.id LIMIT ?4")?;
        let rows = statement.query_map(
            params![
                self.scope.namespace,
                self.scope.location,
                self.after.map(|id| id.0.to_string()).unwrap_or_default(),
                self.limit
            ],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get::<_, String>(6)?,
                    r.get::<_, i64>(7)?,
                ))
            },
        )?;
        rows.map(|r| {
            let (id, revision, mode, body, created_at, modified_at, metadata, assertion) = r?;
            Ok(MemoryRecord {
                assertion: revision_value(assertion)?,
                id: MemoryId(uuid::Uuid::parse_str(&id).map_err(|e| invalid(e.to_string()))?),
                revision: revision_value(revision)?,
                mode: serde_json::from_value(serde_json::Value::String(mode))?,
                state: MemoryState::Active,
                body,
                metadata: serde_json::from_str(&metadata)?,
                created_at,
                modified_at,
            })
        })
        .collect()
    }
}
// Only the native user-management service constructs this statement. It is not a model tool.
pub struct UserChange {
    pub source_scope: Option<Scope>,
    pub scope: Scope,
    pub edit: MemoryEdit,
    pub operation: uuid::Uuid,
    pub at: i64,
}
impl Statement for UserChange {
    type Value = MemoryResult;
    type Output = MemoryResult;
    fn execute(self, c: &Connection) -> Result<Prepared<Self::Value>, StoreError> {
        let result = self.apply(c)?;
        let changed = matches!(
            result,
            MemoryResult::Saved { .. }
                | MemoryResult::Deleted { .. }
                | MemoryResult::EvidenceAdded { .. }
        );
        Ok(Prepared {
            value: result,
            changed,
            notification: Notification::NONE,
        })
    }
    fn committed(value: Self::Value) -> Self::Output {
        value
    }
    fn isolated_rejection(_: &StoreError) -> bool {
        false
    }
}
impl UserChange {
    fn apply(self, c: &Connection) -> Result<MemoryResult, StoreError> {
        self.scope.validate(c)?;
        if let Some(source) = &self.source_scope {
            source.validate(c)?;
        }
        if let MemoryEdit::AddEvidence {
            id,
            expected_revision,
            assertion,
            reference,
        } = &self.edit
        {
            return append_evidence(
                c,
                &self.scope,
                id,
                *expected_revision,
                *assertion,
                reference,
                self.operation,
            );
        }
        let (id, expected, body) = match &self.edit {
            MemoryEdit::AddEvidence { .. } => unreachable!(),
            MemoryEdit::Create { body, .. } => (MemoryId(uuid::Uuid::new_v4()), None, Some(body)),
            MemoryEdit::Correct {
                id,
                expected_revision,
                body,
                ..
            }
            | MemoryEdit::Restore {
                id,
                expected_revision,
                body,
                ..
            } => (id.clone(), Some(*expected_revision), Some(body)),
            MemoryEdit::SetAlways {
                id,
                expected_revision,
                ..
            }
            | MemoryEdit::Delete {
                id,
                expected_revision,
            } => (id.clone(), Some(*expected_revision), None),
        };
        if body.is_some_and(|b| b.trim().is_empty() || b.len() > 16384) {
            return Err(invalid("memory body must contain 1..16384 UTF-8 bytes"));
        }
        let metadata = match &self.edit {
            MemoryEdit::Create { metadata, .. }
            | MemoryEdit::Correct { metadata, .. }
            | MemoryEdit::Restore { metadata, .. } => Some(metadata),
            _ => None,
        };
        if metadata.is_some_and(|m| matches!(m.temporal, MemoryTemporal::Interval { start, end: Some(end) } if end <= start)) {
            return Err(invalid("memory validity must be a nonempty interval"));
        }
        if let MemoryEdit::Create { body, metadata } = &self.edit
            && let Some(result) =
                matching::create(c, &self.scope, body, metadata, self.operation, self.at)?
        {
            return Ok(result);
        }
        let key = id.0.to_string();
        let current=c.query_row("SELECT revision,assertion,state,mode FROM agent_memories WHERE namespace=?1 AND scope=?2 AND id=?3",params![self.scope.namespace,self.scope.location,key],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,i64>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?))).optional()?;
        let mut corrects = None;
        let revision = if let Some(expected) = expected {
            let Some((revision, assertion, state, _)) = &current else {
                return Ok(MemoryResult::NotFound);
            };
            if *revision as u64 != expected.0 {
                return Ok(MemoryResult::Conflict {
                    actual: revision_value(*revision)?,
                });
            }
            if matches!(self.edit, MemoryEdit::Restore { .. }) != (state == "suppressed") {
                return Ok(MemoryResult::InvalidState);
            }
            if body.is_some() {
                corrects = Some(*assertion);
            }
            revision
                .checked_add(1)
                .ok_or_else(|| invalid("memory revision exhausted"))?
        } else {
            1
        };
        let deleted = matches!(self.edit, MemoryEdit::Delete { .. });
        let mode = match self.edit {
            MemoryEdit::SetAlways { always: true, .. } => "user_always",
            MemoryEdit::Correct { .. }
                if current.as_ref().is_some_and(|row| row.3 == "user_always") =>
            {
                "user_always"
            }
            _ => "user_recall",
        };
        let assertion = if body.is_some() {
            revision
        } else {
            current
                .as_ref()
                .ok_or_else(|| invalid("memory assertion missing"))?
                .1
        };
        c.execute("INSERT INTO agent_memories(namespace,scope,id,revision,assertion,mode,state,created_at,modified_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?8) ON CONFLICT(namespace,scope,id) DO UPDATE SET revision=excluded.revision,assertion=excluded.assertion,mode=excluded.mode,state=excluded.state,modified_at=excluded.modified_at",params![self.scope.namespace,self.scope.location,key,revision,assertion,mode,if deleted{"suppressed"}else{"active"},self.at])?;
        if let Some(body) = body {
            c.execute("UPDATE agent_memory_versions SET disposition='corrected' WHERE namespace=?1 AND scope=?2 AND id=?3 AND disposition='current'",params![self.scope.namespace,self.scope.location,key])?;
            let source = MemorySource::UserOperation {
                operation_id: self.operation,
                observed_at: self.at,
            };
            let digest = matching::digest(body);
            c.execute("INSERT INTO agent_memory_versions(namespace,scope,id,revision,body,source,corrects,digest,disposition,metadata) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,'current',?9)",params![self.scope.namespace,self.scope.location,key,revision,body,serde_json::to_string(&source)?,corrects,digest,serde_json::to_string(metadata.ok_or_else(|| invalid("missing assertion metadata"))?)?])?;
        }
        if body.is_some() {
            c.execute("INSERT INTO agent_memory_evidence(namespace,scope,id,assertion,source,source_key) SELECT namespace,scope,id,revision,source,source FROM agent_memory_versions WHERE namespace=?1 AND scope=?2 AND id=?3 AND revision=?4", params![self.scope.namespace,self.scope.location,key,revision])?;
        }
        if deleted {
            c.execute("UPDATE agent_memory_versions SET disposition='suppressed' WHERE namespace=?1 AND scope=?2 AND id=?3",params![self.scope.namespace,self.scope.location,key])?;
        }
        c.execute("INSERT INTO agent_memory_scopes(namespace,scope,revision) VALUES(?1,?2,1) ON CONFLICT(namespace,scope) DO UPDATE SET revision=revision+1",params![self.scope.namespace,self.scope.location])?;
        Ok(if deleted {
            MemoryResult::Deleted {
                id,
                revision: revision_value(revision)?,
            }
        } else {
            MemoryResult::Saved {
                id,
                revision: revision_value(revision)?,
            }
        })
    }
}

pub struct History {
    pub scope: Scope,
    pub id: MemoryId,
    pub after: Option<MemoryRevision>,
    pub limit: u32,
}
impl Query for History {
    type Output = Vec<MemoryVersion>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        self.scope.validate(c)?;
        if !(1..=101).contains(&self.limit) {
            return Err(invalid("memory history limit"));
        }
        let mut statement=c.prepare("SELECT v.revision,v.body,v.source,v.corrects,v.metadata,v.generation FROM agent_memory_versions v JOIN agent_memories m ON m.namespace=v.namespace AND m.scope=v.scope AND m.id=v.id WHERE v.namespace=?1 AND v.scope=?2 AND v.id=?3 AND m.state='active' AND v.disposition<>'suppressed' AND v.revision>?4 ORDER BY v.revision LIMIT ?5")?;
        let rows = statement.query_map(
            params![
                self.scope.namespace,
                self.scope.location,
                self.id.0.to_string(),
                i64::try_from(self.after.map(|r| r.0).unwrap_or(0))
                    .map_err(|_| invalid("memory history cursor overflow"))?,
                self.limit
            ],
            |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<i64>>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, String>(5)?,
                ))
            },
        )?;
        rows.map(|r| {
            let (revision, body, source, corrects, metadata, generation) = r?;
            Ok(MemoryVersion {
                revision: revision_value(revision)?,
                body,
                source: serde_json::from_str(&source)?,
                metadata: serde_json::from_str(&metadata)?,
                generation: serde_json::from_value(serde_json::Value::String(generation))?,
                corrects: corrects.map(revision_value).transpose()?,
            })
        })
        .collect()
    }
}

fn append_evidence(
    c: &Connection,
    scope: &Scope,
    id: &MemoryId,
    expected: MemoryRevision,
    assertion: MemoryRevision,
    reference: &MemoryEvidenceReference,
    operation: uuid::Uuid,
) -> Result<MemoryResult, StoreError> {
    let key = id.0.to_string();
    let current: Option<(i64, i64, String)> = c.query_row("SELECT revision,assertion,state FROM agent_memories WHERE namespace=? AND scope=? AND id=?", params![scope.namespace,scope.location,key], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
    let Some((revision, current_assertion, state)) = current else {
        return Ok(MemoryResult::NotFound);
    };
    if revision as u64 != expected.0 {
        return Ok(MemoryResult::Conflict {
            actual: revision_value(revision)?,
        });
    }
    if state != "active" || current_assertion as u64 != assertion.0 {
        return Ok(MemoryResult::InvalidState);
    }
    let (body, fact, observed_at) = evidence_source(
        c,
        &scope.namespace,
        &reference.session_id,
        reference.sequence,
        reference.item_index,
    )?;
    if fact != reference.fact_id.to_string()
        || hex::encode(Sha256::digest(body.as_bytes())) != reference.fingerprint
        || reference.quote.is_empty()
        || reference.quote.len() > 16384
        || body.get(reference.start as usize..reference.end as usize)
            != Some(reference.quote.as_str())
    {
        return Err(invalid("memory evidence does not match immutable source"));
    }
    let source_key = hex::encode(Sha256::digest(serde_json::to_vec(reference)?));
    let source = MemorySource::Conversation {
        reference: reference.clone(),
        observed_at,
        operation_id: operation,
    };
    let inserted = c.execute("INSERT INTO agent_memory_evidence(namespace,scope,id,assertion,source,source_key) VALUES(?,?,?,?,?,?) ON CONFLICT(namespace,scope,id,assertion,source_key) DO NOTHING", params![scope.namespace,scope.location,key,current_assertion,serde_json::to_string(&source)?,source_key])?;
    if inserted == 0 {
        return Ok(MemoryResult::Saved {
            id: id.clone(),
            revision: expected,
        });
    }
    let next = revision
        .checked_add(1)
        .ok_or_else(|| invalid("memory revision exhausted"))?;
    c.execute(
        "UPDATE agent_memories SET revision=? WHERE namespace=? AND scope=? AND id=?",
        params![next, scope.namespace, scope.location, key],
    )?;
    c.execute(
        "UPDATE agent_memory_scopes SET revision=revision+1 WHERE namespace=? AND scope=?",
        params![scope.namespace, scope.location],
    )?;
    Ok(MemoryResult::Saved {
        id: id.clone(),
        revision: revision_value(next)?,
    })
}
pub struct Evidence {
    pub scope: Scope,
    pub id: MemoryId,
    pub assertion: MemoryRevision,
    pub after: Option<u64>,
    pub limit: u32,
}
impl Query for Evidence {
    type Output = Vec<MemoryEvidence>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        self.scope.validate(c)?;
        if !(1..=101).contains(&self.limit) {
            return Err(invalid("memory evidence limit"));
        }
        let mut statement = c.prepare("SELECT e.sequence,e.source FROM agent_memory_evidence e JOIN agent_memories m ON m.namespace=e.namespace AND m.scope=e.scope AND m.id=e.id JOIN agent_memory_versions v ON v.namespace=e.namespace AND v.scope=e.scope AND v.id=e.id AND v.revision=e.assertion WHERE e.namespace=? AND e.scope=? AND e.id=? AND e.assertion=? AND e.sequence>? AND m.state='active' AND v.disposition<>'suppressed' ORDER BY e.sequence LIMIT ?")?;
        let rows = statement.query_map(
            params![
                self.scope.namespace,
                self.scope.location,
                self.id.0.to_string(),
                i64::try_from(self.assertion.0).map_err(|_| invalid("assertion overflow"))?,
                i64::try_from(self.after.unwrap_or(0))
                    .map_err(|_| invalid("evidence cursor overflow"))?,
                self.limit
            ],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)),
        )?;
        rows.map(|row| {
            let (id, source) = row?;
            Ok(MemoryEvidence {
                id: u64::try_from(id).map_err(|_| invalid("negative evidence cursor"))?,
                source: serde_json::from_str(&source)?,
            })
        })
        .collect()
    }
}

fn evidence_source(
    c: &Connection,
    namespace: &str,
    session: &str,
    sequence: u64,
    item_index: u64,
) -> Result<(String, String, i64), StoreError> {
    let source: Option<(String, String, i64, String)> = c.query_row(
        "SELECT d.body,h.fact_id,d.at,s.configuration FROM agent_recall_messages d JOIN agent_session_history h ON h.owner=d.owner AND h.session=d.session AND h.sequence=d.sequence JOIN session_control s ON s.id=d.session WHERE d.owner=?1 AND d.session=?2 AND d.sequence=?3 AND d.ordinal=?4 AND d.internal=0 AND s.archived=0 AND NOT EXISTS(SELECT 1 FROM session_retirements WHERE session_id=d.session AND remove_session=1)",
        params![namespace,session,i64::try_from(sequence).map_err(|_| invalid("source sequence overflow"))?,i64::try_from(item_index).map_err(|_| invalid("source ordinal overflow"))?],
        |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
    let Some((body, fact, observed_at, configuration)) = source else {
        return Err(invalid("memory evidence source unavailable"));
    };
    let configuration: serde_json::Value = serde_json::from_str(&configuration)?;
    if configuration
        .get("incognito")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        return Err(invalid("memory evidence source is incognito"));
    }
    Ok((body, fact, observed_at))
}
pub struct CaptureEvidence {
    pub scope: Scope,
    pub selection: MemorySourceSelection,
}
impl Query for CaptureEvidence {
    type Output = MemoryEvidenceReference;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        self.scope.validate(c)?;
        let selected = self.selection;
        let (body, fact, _) = evidence_source(
            c,
            &self.scope.namespace,
            &selected.session_id,
            selected.sequence,
            selected.item_index,
        )?;
        if selected.quote.is_empty()
            || selected.quote.len() > 16384
            || body.get(selected.start as usize..selected.end as usize)
                != Some(selected.quote.as_str())
        {
            return Err(invalid("memory evidence span does not match source"));
        }
        Ok(MemoryEvidenceReference {
            session_id: selected.session_id,
            sequence: selected.sequence,
            item_index: selected.item_index,
            fact_id: uuid::Uuid::parse_str(&fact).map_err(|e| invalid(e.to_string()))?,
            fingerprint: hex::encode(Sha256::digest(body.as_bytes())),
            start: selected.start,
            end: selected.end,
            quote: selected.quote,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn setup() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(include_str!("../migrations/0043_memory.sql"))
            .unwrap();
        c.execute_batch(include_str!("../migrations/0044_memory_metadata.sql"))
            .unwrap();
        c.execute_batch(include_str!("../migrations/0045_memory_evidence.sql"))
            .unwrap();
        c
    }
    fn scope(namespace: &str, location: &str) -> Scope {
        Scope {
            namespace: namespace.into(),
            location: location.into(),
            binding: None,
        }
    }
    fn change(c: &Connection, scope: Scope, edit: MemoryEdit) -> MemoryResult {
        UserChange {
            source_scope: None,
            scope,
            edit,
            operation: uuid::Uuid::new_v4(),
            at: 1,
        }
        .execute(c)
        .unwrap()
        .value
    }
    #[test]
    fn correction_retains_version_evidence_and_suppression_in_one_transaction() {
        let c = setup();
        let MemoryResult::Saved { id, .. } = change(
            &c,
            scope("host/agent", "personal"),
            MemoryEdit::Create {
                body: "Original".into(),
                metadata: MemoryMetadata::default(),
            },
        ) else {
            panic!()
        };
        c.execute("UPDATE agent_memories SET mode='auto_recall'", [])
            .unwrap();
        change(
            &c,
            scope("host/agent", "personal"),
            MemoryEdit::Correct {
                id: id.clone(),
                expected_revision: MemoryRevision(1),
                body: "Corrected".into(),
                metadata: MemoryMetadata::default(),
            },
        );
        assert_eq!(
            record(&c, &scope("host/agent", "personal"), &id)
                .unwrap()
                .unwrap()
                .mode,
            MemoryMode::UserRecall
        );
        let versions = History {
            scope: scope("host/agent", "personal"),
            id: id.clone(),
            after: None,
            limit: 10,
        }
        .execute(&c)
        .unwrap();
        assert_eq!(versions[1].corrects, Some(MemoryRevision(1)));
        assert_ne!(versions[0].source, versions[1].source);
        c.execute_batch("BEGIN").unwrap();
        change(
            &c,
            scope("host/agent", "personal"),
            MemoryEdit::Delete {
                id: id.clone(),
                expected_revision: MemoryRevision(2),
            },
        );
        assert!(
            record(&c, &scope("host/agent", "personal"), &id)
                .unwrap()
                .is_none()
        );
        c.execute_batch("ROLLBACK").unwrap();
        assert_eq!(
            record(&c, &scope("host/agent", "personal"), &id)
                .unwrap()
                .unwrap()
                .body,
            "Corrected"
        );
        change(
            &c,
            scope("host/agent", "personal"),
            MemoryEdit::Delete {
                id: id.clone(),
                expected_revision: MemoryRevision(2),
            },
        );
        assert_eq!(
            c.query_row(
                "SELECT count(*) FROM agent_memory_versions WHERE disposition='suppressed'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            2
        );
        assert_eq!(
            c.query_row("SELECT revision FROM agent_memory_scopes", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            3
        );
    }
    #[test]
    fn exact_create_reuses_assertion_and_preserves_priority() {
        let c = setup();
        let scope = || scope("host/agent", "personal");
        let create = |body: &str| MemoryEdit::Create {
            body: body.into(),
            metadata: MemoryMetadata::default(),
        };
        let MemoryResult::Saved { id, .. } =
            change(&c, scope(), create("Prefer Chinese\r\nfor discussions"))
        else {
            panic!()
        };
        change(
            &c,
            scope(),
            MemoryEdit::SetAlways {
                id: id.clone(),
                expected_revision: MemoryRevision(1),
                always: true,
            },
        );
        let before = record(&c, &scope(), &id).unwrap().unwrap();
        let result = change(&c, scope(), create("  Prefer Chinese\nfor discussions  "));
        let MemoryResult::EvidenceAdded {
            id: matched,
            revision,
        } = result
        else {
            panic!()
        };
        assert_eq!(matched, id);
        assert_eq!(revision, MemoryRevision(3));
        let after = record(&c, &scope(), &id).unwrap().unwrap();
        assert_eq!(after.mode, MemoryMode::UserAlways);
        assert_eq!(after.body, before.body);
        assert_eq!(after.assertion, before.assertion);
        assert_eq!(after.modified_at, before.modified_at);
        assert_eq!(
            Evidence {
                scope: scope(),
                id,
                assertion: MemoryRevision(1),
                after: None,
                limit: 100
            }
            .execute(&c)
            .unwrap()
            .len(),
            2
        );
        assert_eq!(
            Page {
                scope: scope(),
                after: None,
                limit: 100
            }
            .execute(&c)
            .unwrap()
            .len(),
            1
        );
    }

    #[test]
    fn exact_matching_respects_scope_metadata_negation_and_case() {
        let c = setup();
        for (location, body, metadata) in [
            ("personal", "Use Postgres", MemoryMetadata::default()),
            ("project", "Use Postgres", MemoryMetadata::default()),
            ("personal", "Do not use Postgres", MemoryMetadata::default()),
            ("personal", "Use postgres", MemoryMetadata::default()),
            (
                "personal",
                "Use Postgres",
                MemoryMetadata {
                    temporal: MemoryTemporal::Interval {
                        start: 10,
                        end: Some(20),
                    },
                    ..Default::default()
                },
            ),
        ] {
            assert!(matches!(
                change(
                    &c,
                    scope("host/agent", location),
                    MemoryEdit::Create {
                        body: body.into(),
                        metadata
                    }
                ),
                MemoryResult::Saved { .. }
            ));
        }
    }

    #[test]
    fn deleted_and_corrected_assertions_block_new_ids_until_explicit_restore() {
        let c = setup();
        let scope = || scope("host/agent", "personal");
        let create = |body: &str| MemoryEdit::Create {
            body: body.into(),
            metadata: MemoryMetadata::default(),
        };
        let MemoryResult::Saved { id, .. } = change(&c, scope(), create("Use Chinese")) else {
            panic!()
        };
        change(
            &c,
            scope(),
            MemoryEdit::Correct {
                id: id.clone(),
                expected_revision: MemoryRevision(1),
                body: "Use English".into(),
                metadata: MemoryMetadata::default(),
            },
        );
        assert!(matches!(
            change(&c, scope(), create("Use Chinese")),
            MemoryResult::Suppressed
        ));
        change(
            &c,
            scope(),
            MemoryEdit::Delete {
                id: id.clone(),
                expected_revision: MemoryRevision(2),
            },
        );
        assert!(matches!(
            change(&c, scope(), create("Use English")),
            MemoryResult::Suppressed
        ));
        assert!(matches!(
            change(&c, scope(), create("Use Chinese")),
            MemoryResult::Suppressed
        ));
        assert!(
            Page {
                scope: scope(),
                after: None,
                limit: 10
            }
            .execute(&c)
            .unwrap()
            .is_empty()
        );
        change(
            &c,
            scope(),
            MemoryEdit::Restore {
                id: id.clone(),
                expected_revision: MemoryRevision(3),
                body: "Use English".into(),
                metadata: MemoryMetadata::default(),
            },
        );
        assert!(matches!(
            change(&c, scope(), create("Use English")),
            MemoryResult::EvidenceAdded { .. }
        ));
        assert!(matches!(
            change(&c, scope(), create("Use Chinese")),
            MemoryResult::Suppressed
        ));
    }

    #[test]
    fn explicit_duplicate_confirms_auto_fact_and_replay_does_not_add_evidence() {
        let c = setup();
        let scope = || scope("host/agent", "personal");
        let edit = || MemoryEdit::Create {
            body: "Use Chinese".into(),
            metadata: MemoryMetadata::default(),
        };
        let MemoryResult::Saved { id, .. } = change(&c, scope(), edit()) else {
            panic!()
        };
        c.execute("UPDATE agent_memories SET mode='auto_recall'", [])
            .unwrap();
        let operation = uuid::Uuid::new_v4();
        for _ in 0..2 {
            let result = UserChange {
                source_scope: None,
                scope: scope(),
                edit: edit(),
                operation,
                at: 50,
            }
            .execute(&c)
            .unwrap()
            .value;
            assert!(matches!(
                result,
                MemoryResult::EvidenceAdded {
                    revision: MemoryRevision(2),
                    ..
                }
            ));
        }
        let record = record(&c, &scope(), &id).unwrap().unwrap();
        assert_eq!(record.mode, MemoryMode::UserRecall);
        assert_eq!(record.modified_at, 1);
        let mut explain = c
            .prepare(&format!("EXPLAIN QUERY PLAN {}", matching::RESTRICTED_SQL))
            .unwrap();
        let plans: Vec<String> = explain
            .query_map(
                params![
                    "host/agent",
                    "personal",
                    matching::digest("Use Chinese"),
                    serde_json::to_string(&MemoryMetadata::default()).unwrap()
                ],
                |r| r.get(3),
            )
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert!(
            plans
                .iter()
                .any(|plan| plan.contains("agent_memory_matching")),
            "{plans:?}"
        );
    }

    #[test]
    fn existing_memory_versions_gain_metadata_and_evidence_without_body_changes() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(include_str!("../migrations/0043_memory.sql"))
            .unwrap();
        let id = MemoryId(uuid::Uuid::new_v4());
        let source = MemorySource::UserOperation {
            operation_id: uuid::Uuid::new_v4(),
            observed_at: 123,
        };
        c.execute("INSERT INTO agent_memories VALUES('host/agent','personal',?1,1,1,'user_always','active',123,123)", [id.0.to_string()]).unwrap();
        c.execute("INSERT INTO agent_memory_versions VALUES('host/agent','personal',?1,1,'Original body',?2,NULL,'original-digest','current')", params![id.0.to_string(),serde_json::to_string(&source).unwrap()]).unwrap();
        c.execute_batch(include_str!("../migrations/0044_memory_metadata.sql"))
            .unwrap();
        c.execute_batch(include_str!("../migrations/0045_memory_evidence.sql"))
            .unwrap();
        let current = record(&c, &scope("host/agent", "personal"), &id)
            .unwrap()
            .unwrap();
        assert_eq!(current.body, "Original body");
        assert_eq!(current.mode, MemoryMode::UserAlways);
        assert_eq!(current.metadata, MemoryMetadata::default());
        let evidence = Evidence {
            scope: scope("host/agent", "personal"),
            id,
            assertion: MemoryRevision(1),
            after: None,
            limit: 10,
        }
        .execute(&c)
        .unwrap();
        assert_eq!(evidence.len(), 1);
        assert_eq!(evidence[0].source, source);
    }
    #[test]
    fn assertion_metadata_is_versioned_and_invalid_time_is_rejected() {
        let c = setup();
        let metadata = MemoryMetadata {
            kind: MemoryKind::Preference,
            statement: MemoryStatement::Preference,
            temporal: MemoryTemporal::Interval {
                start: 10,
                end: Some(20),
            },
        };
        let MemoryResult::Saved { id, .. } = change(
            &c,
            scope("host/agent", "personal"),
            MemoryEdit::Create {
                body: "Use Chinese during this project".into(),
                metadata: metadata.clone(),
            },
        ) else {
            panic!()
        };
        assert_eq!(
            record(&c, &scope("host/agent", "personal"), &id)
                .unwrap()
                .unwrap()
                .metadata,
            metadata
        );
        let invalid = UserChange {
            source_scope: None,
            scope: scope("host/agent", "personal"),
            operation: uuid::Uuid::new_v4(),
            at: 2,
            edit: MemoryEdit::Correct {
                id: id.clone(),
                expected_revision: MemoryRevision(1),
                body: "Invalid".into(),
                metadata: MemoryMetadata {
                    temporal: MemoryTemporal::Interval {
                        start: 20,
                        end: Some(10),
                    },
                    ..Default::default()
                },
            },
        }
        .execute(&c);
        assert!(invalid.is_err());
        change(
            &c,
            scope("host/agent", "personal"),
            MemoryEdit::Correct {
                id: id.clone(),
                expected_revision: MemoryRevision(1),
                body: "Use English".into(),
                metadata: MemoryMetadata::default(),
            },
        );
        let versions = History {
            scope: scope("host/agent", "personal"),
            id,
            after: None,
            limit: 10,
        }
        .execute(&c)
        .unwrap();
        assert_eq!(versions[0].metadata, metadata);
        assert_eq!(versions[1].metadata, MemoryMetadata::default());
    }
    #[test]
    fn evidence_is_verified_incremental_and_never_carried_to_a_correction() {
        let c = setup();
        c.execute_batch("CREATE TABLE session_control(id TEXT PRIMARY KEY, configuration TEXT, archived INTEGER); CREATE TABLE session_retirements(session_id TEXT, remove_session INTEGER); CREATE TABLE agent_recall_messages(owner TEXT,session TEXT,sequence INTEGER,ordinal INTEGER,body TEXT,at INTEGER,internal INTEGER); CREATE TABLE agent_session_history(owner TEXT,session TEXT,sequence INTEGER,fact_id TEXT);").unwrap();
        let text = "Prefer 中文";
        let fact = uuid::Uuid::new_v4();
        c.execute("INSERT INTO session_control VALUES('s','{}',0)", [])
            .unwrap();
        c.execute(
            "INSERT INTO agent_recall_messages VALUES('host/agent','s',1,0,?,100,0)",
            [text],
        )
        .unwrap();
        c.execute(
            "INSERT INTO agent_session_history VALUES('host/agent','s',1,?)",
            [fact.to_string()],
        )
        .unwrap();
        let MemoryResult::Saved { id, .. } = change(
            &c,
            scope("host/agent", "personal"),
            MemoryEdit::Create {
                body: "Chinese preference".into(),
                metadata: MemoryMetadata::default(),
            },
        ) else {
            panic!()
        };
        let reference = MemoryEvidenceReference {
            session_id: "s".into(),
            sequence: 1,
            item_index: 0,
            fact_id: fact,
            fingerprint: hex::encode(Sha256::digest(text.as_bytes())),
            start: 7,
            end: text.len() as u32,
            quote: "中文".into(),
        };
        let before = record(&c, &scope("host/agent", "personal"), &id)
            .unwrap()
            .unwrap();
        let append = |reference, expected| {
            UserChange {
                source_scope: None,
                scope: scope("host/agent", "personal"),
                operation: uuid::Uuid::new_v4(),
                at: 200,
                edit: MemoryEdit::AddEvidence {
                    id: id.clone(),
                    expected_revision: MemoryRevision(expected),
                    assertion: MemoryRevision(1),
                    reference,
                },
            }
            .execute(&c)
        };
        let mut forged = reference.clone();
        forged.quote = "English".into();
        assert!(append(forged, 1).is_err());
        assert!(matches!(
            append(reference.clone(), 1).unwrap().value,
            MemoryResult::Saved {
                revision: MemoryRevision(2),
                ..
            }
        ));
        assert!(matches!(
            append(reference.clone(), 2).unwrap().value,
            MemoryResult::Saved {
                revision: MemoryRevision(2),
                ..
            }
        ));
        let after = record(&c, &scope("host/agent", "personal"), &id)
            .unwrap()
            .unwrap();
        assert_eq!(after.assertion, before.assertion);
        assert_eq!(after.mode, before.mode);
        assert_eq!(after.metadata, before.metadata);
        assert_eq!(after.modified_at, before.modified_at);
        let MemoryResult::Saved { id: other, .. } = change(
            &c,
            scope("host/agent", "personal"),
            MemoryEdit::Create {
                body: "Another fact from the same source".into(),
                metadata: MemoryMetadata::default(),
            },
        ) else {
            panic!()
        };
        assert!(matches!(
            change(
                &c,
                scope("host/agent", "personal"),
                MemoryEdit::AddEvidence {
                    id: other,
                    expected_revision: MemoryRevision(1),
                    assertion: MemoryRevision(1),
                    reference: reference.clone(),
                },
            ),
            MemoryResult::Saved {
                revision: MemoryRevision(2),
                ..
            }
        ));
        let evidence = |assertion, after| {
            Evidence {
                scope: scope("host/agent", "personal"),
                id: id.clone(),
                assertion: MemoryRevision(assertion),
                after,
                limit: 1,
            }
            .execute(&c)
            .unwrap()
        };
        let first = evidence(1, None);
        let second = evidence(1, Some(first[0].id));
        assert!(matches!(
            first[0].source,
            MemorySource::UserOperation { .. }
        ));
        assert!(matches!(
            second[0].source,
            MemorySource::Conversation {
                observed_at: 100,
                ..
            }
        ));
        change(
            &c,
            scope("host/agent", "personal"),
            MemoryEdit::Correct {
                id: id.clone(),
                expected_revision: MemoryRevision(2),
                body: "English preference".into(),
                metadata: MemoryMetadata::default(),
            },
        );
        assert!(matches!(
            evidence(3, None)[0].source,
            MemorySource::UserOperation { .. }
        ));
        assert!(matches!(
            append(reference, 3).unwrap().value,
            MemoryResult::InvalidState
        ));
        change(
            &c,
            scope("host/agent", "personal"),
            MemoryEdit::Delete {
                id: id.clone(),
                expected_revision: MemoryRevision(3),
            },
        );
        assert!(evidence(1, None).is_empty());
        assert!(evidence(3, None).is_empty());
    }
    #[test]
    fn namespace_scope_isolation_and_keyset_pagination() {
        let c = setup();
        let mut ids = Vec::new();
        for i in 0..3 {
            let MemoryResult::Saved { id, .. } = change(
                &c,
                scope("host/agent", "folder:/a"),
                MemoryEdit::Create {
                    body: format!("Fact {i}"),
                    metadata: MemoryMetadata::default(),
                },
            ) else {
                panic!()
            };
            ids.push(id);
        }
        for other in [
            scope("other/agent", "folder:/a"),
            scope("host/other", "folder:/a"),
            scope("host/agent", "folder:/b"),
        ] {
            assert!(record(&c, &other, &ids[0]).unwrap().is_none());
            assert!(matches!(
                change(
                    &c,
                    other,
                    MemoryEdit::Delete {
                        id: ids[0].clone(),
                        expected_revision: MemoryRevision(1)
                    }
                ),
                MemoryResult::NotFound
            ));
        }
        let first = Page {
            scope: scope("host/agent", "folder:/a"),
            after: None,
            limit: 2,
        }
        .execute(&c)
        .unwrap();
        let second = Page {
            scope: scope("host/agent", "folder:/a"),
            after: Some(first[1].id.clone()),
            limit: 2,
        }
        .execute(&c)
        .unwrap();
        assert_eq!(second.len(), 1);
        assert!(first.iter().all(|r| r.id != second[0].id));
        let plan:String=c.query_row("EXPLAIN QUERY PLAN SELECT id FROM agent_memories WHERE namespace='host/agent' AND scope='folder:/a' AND state='active' AND id>'' ORDER BY id LIMIT 10",[],|r|r.get(3)).unwrap();
        assert!(plan.contains("agent_memories_active"), "{plan}");
    }
}
