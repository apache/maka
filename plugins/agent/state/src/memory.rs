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
    let row = c.query_row("SELECT m.revision,m.mode,m.state,v.body,m.created_at,m.modified_at FROM agent_memories m JOIN agent_memory_versions v ON v.namespace=m.namespace AND v.scope=m.scope AND v.id=m.id AND v.revision=m.assertion WHERE m.namespace=?1 AND m.scope=?2 AND m.id=?3 AND m.state='active'", params![scope.namespace,scope.location,id.0.to_string()], |r| Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get(4)?,r.get(5)?))).optional()?;
    row.map(|(revision, mode, state, body, created_at, modified_at)| {
        Ok(MemoryRecord {
            id: id.clone(),
            revision: revision_value(revision)?,
            mode: serde_json::from_value(serde_json::Value::String(mode))?,
            state: serde_json::from_value(serde_json::Value::String(state))?,
            body,
            created_at,
            modified_at,
        })
    })
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
        let mut statement=c.prepare("SELECT m.id,m.revision,m.mode,v.body,m.created_at,m.modified_at FROM agent_memories m JOIN agent_memory_versions v ON v.namespace=m.namespace AND v.scope=m.scope AND v.id=m.id AND v.revision=m.assertion WHERE m.namespace=?1 AND m.scope=?2 AND m.state='active' AND m.id>?3 ORDER BY m.id LIMIT ?4")?;
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
                ))
            },
        )?;
        rows.map(|r| {
            let (id, revision, mode, body, created_at, modified_at) = r?;
            Ok(MemoryRecord {
                id: MemoryId(uuid::Uuid::parse_str(&id).map_err(|e| invalid(e.to_string()))?),
                revision: revision_value(revision)?,
                mode: serde_json::from_value(serde_json::Value::String(mode))?,
                state: MemoryState::Active,
                body,
                created_at,
                modified_at,
            })
        })
        .collect()
    }
}
// Only the native user-management service constructs this statement. It is not a model tool.
pub struct UserChange {
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
            MemoryResult::Saved { .. } | MemoryResult::Deleted { .. }
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
        let (id, expected, body) = match &self.edit {
            MemoryEdit::Create { body } => (MemoryId(uuid::Uuid::new_v4()), None, Some(body)),
            MemoryEdit::Correct {
                id,
                expected_revision,
                body,
            }
            | MemoryEdit::Restore {
                id,
                expected_revision,
                body,
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
            let normalized = body.replace("\r\n", "\n");
            let digest = hex::encode(Sha256::digest(normalized.trim().as_bytes()));
            c.execute("INSERT INTO agent_memory_versions(namespace,scope,id,revision,body,source,corrects,digest,disposition) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,'current')",params![self.scope.namespace,self.scope.location,key,revision,body,serde_json::to_string(&source)?,corrects,digest])?;
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
        let mut statement=c.prepare("SELECT v.revision,v.body,v.source,v.corrects FROM agent_memory_versions v JOIN agent_memories m ON m.namespace=v.namespace AND m.scope=v.scope AND m.id=v.id WHERE v.namespace=?1 AND v.scope=?2 AND v.id=?3 AND m.state='active' AND v.disposition<>'suppressed' AND v.revision>?4 ORDER BY v.revision LIMIT ?5")?;
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
                ))
            },
        )?;
        rows.map(|r| {
            let (revision, body, source, corrects) = r?;
            Ok(MemoryVersion {
                revision: revision_value(revision)?,
                body,
                source: serde_json::from_str(&source)?,
                corrects: corrects.map(revision_value).transpose()?,
            })
        })
        .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn setup() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(include_str!("../migrations/0043_memory.sql"))
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
    fn namespace_scope_isolation_and_keyset_pagination() {
        let c = setup();
        let mut ids = Vec::new();
        for i in 0..3 {
            let MemoryResult::Saved { id, .. } = change(
                &c,
                scope("host/agent", "folder:/a"),
                MemoryEdit::Create {
                    body: format!("Fact {i}"),
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
