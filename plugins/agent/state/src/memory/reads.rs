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
use maka_agent_facts::durable::RunId;

pub struct RecordFacts {
    pub run: RunId,
    pub scope: Scope,
    pub facts: Vec<LoadedMemory>,
}
impl Statement for RecordFacts {
    type Value = ();
    type Output = ();
    fn execute(self, c: &Connection) -> Result<Prepared<()>, StoreError> {
        self.scope.validate(c)?;
        let run = self.run.to_string();
        // A repeated read still needs a matching current row. An empty SELECT means
        // the assertion changed between lookup and publication of the tool result.
        let mut record = c.prepare_cached(
            "INSERT INTO agent_memory_tool_inputs(run,namespace,scope,id,assertion,revision)
             SELECT ?1, m.namespace,m.scope,m.id,m.assertion,m.revision FROM agent_memories m
             WHERE m.namespace=?2 AND m.scope=?3 AND m.id=?4 AND m.assertion=?5 AND m.revision=?6 AND m.state='active'
             ON CONFLICT(run,scope,id,assertion,revision) DO UPDATE SET revision=excluded.revision",
        )?;
        for fact in self.facts {
            if record.execute(params![
                run,
                self.scope.namespace,
                fact.scope,
                fact.id.0.to_string(),
                crate::recall::number(fact.assertion.0)?,
                crate::recall::number(fact.revision.0)?
            ])? != 1
            {
                return Err(invalid("memory changed while returning tool output"));
            }
        }
        Ok(Prepared {
            value: (),
            changed: true,
            notification: Notification::NONE,
        })
    }
    fn committed(_: ()) {}
    fn isolated_rejection(error: &StoreError) -> bool {
        matches!(error, StoreError::InvalidTransition(_))
    }
}

pub enum HistorySources {
    Sessions(Vec<String>),
    Attachment { session: String, artifact: String },
    Producer { session: String, run: RunId },
}
impl HistorySources {
    pub fn session(session: &str) -> Self {
        Self::Sessions(vec![session.to_owned()])
    }
}

pub struct RecordHistory {
    pub owner: maka_agent_facts::durable::RunOwner,
    pub execution: maka_agent_facts::durable::ExecutionIdentity,
    pub sources: HistorySources,
    pub before: Option<u64>,
}
impl Statement for RecordHistory {
    type Value = u64;
    type Output = u64;
    fn execute(self, c: &Connection) -> Result<Prepared<u64>, StoreError> {
        let run = self.execution.run_id.to_string();
        let owner = serde_json::to_string(&self.owner)?;
        let model: bool = c.prepare_cached(
            "SELECT b.payload->>'$.backend.kind'='model' FROM agent_run_specs s JOIN contents b ON b.id=s.spec_content_id
             WHERE s.run=?1 AND s.session=?2 AND s.owner=?3 AND b.payload->>'turnId'=?4",
        )?.query_row(params![run, self.execution.session_id, owner, self.execution.turn_id], |r| r.get(0))
            .optional()?.ok_or_else(|| invalid("history reader execution changed"))?;
        if !model {
            CheckReads(self.execution.run_id).execute(c)?;
        }
        let mut changed = false;
        let sessions = match self.sources {
            HistorySources::Sessions(sessions) => {
                if !model {
                    for session in &sessions {
                        authorize_external_history(c, &owner, session, None)?;
                    }
                }
                sessions
            }
            HistorySources::Producer { session, run } => {
                if !model {
                    authorize_external_history(c, &owner, &session, Some(run))?;
                }
                vec![session]
            }
            HistorySources::Attachment { session, artifact } => {
                // Read only accepts original user uploads or verified copies of them.
                // A copy retains the source message's evidence and retirement boundary.
                if !model {
                    let controlled = c.prepare_cached(concat!(super::recall::material_origins_sql!(),
                        " SELECT EXISTS(SELECT 1 FROM origins o
                         CROSS JOIN agent_memory_recall_attachments a ON a.namespace=?1 AND a.session=o.session AND a.artifact=o.artifact
                         CROSS JOIN agent_recall_messages d ON d.id=a.message CROSS JOIN agent_session_history h ON h.sequence=d.sequence
                         CROSS JOIN agent_memory_evidence e ON e.namespace=a.namespace
                         AND CAST(json_extract(e.source,'$.reference.factId') AS TEXT)=h.fact_id
                         AND CAST(json_extract(e.source,'$.reference.itemIndex') AS INTEGER)=d.ordinal)"))?
                        .query_row(params![owner,session,artifact], |r| r.get::<_,bool>(0))?;
                    if controlled {
                        return Err(invalid("agent_memory_executor_unavailable"));
                    }
                }
                let mut origins = c.prepare_cached(concat!(
                    super::recall::material_origins_sql!(),
                    " SELECT DISTINCT session FROM origins WHERE session IS NOT NULL"
                ))?;
                origins
                    .query_map(params![owner, session, artifact], |r| r.get(0))?
                    .collect::<Result<Vec<_>, _>>()?
            }
        };
        let mut visibility = 0;
        for session in sessions {
            let revision = Visibility(session.clone()).execute(c)?;
            visibility = visibility.max(revision);
            if self.before.is_some_and(|before| revision > before) {
                return Err(invalid("history changed while returning tool output"));
            }
            if !model {
                changed |= c.execute("INSERT OR IGNORE INTO agent_memory_external_sources(session,source) VALUES(?,?)",
                    params![self.execution.session_id,session])? != 0;
            }
            // The first read fences the next provider send, even after a freshly masked read.
            changed |= c.execute(
                "INSERT OR IGNORE INTO agent_memory_session_reads VALUES(?,?,?)",
                params![run, session, crate::recall::number(revision)?],
            )? != 0;
        }
        Ok(Prepared {
            value: visibility,
            changed,
            notification: Notification::NONE,
        })
    }
    fn committed(visibility: u64) -> u64 {
        visibility
    }
    fn isolated_rejection(error: &StoreError) -> bool {
        matches!(
            error,
            StoreError::InvalidTransition(_) | StoreError::SessionNotFound
        )
    }
}

// Remote continuations have no per-send Host hook. Trace mixed output to its
// producing Run and the source sessions it previously read. UNION bounds cycles.
fn authorize_external_history(
    c: &Connection,
    owner: &str,
    session: &str,
    producer: Option<RunId>,
) -> Result<(), StoreError> {
    let controlled: bool = c.prepare_cached(
        "WITH RECURSIVE sources(session,producer) AS (
           SELECT ?2,?3 UNION
           SELECT h.session,NULL FROM sources s CROSS JOIN agent_run_specs r ON r.owner=?1 AND r.session=s.session
             AND (s.producer IS NULL OR r.run=s.producer)
           CROSS JOIN agent_memory_session_reads h ON h.run=r.run
           CROSS JOIN contents b ON b.id=r.spec_content_id
           WHERE h.session<>r.session OR b.payload->>'$.backend.kind'='model'
         )
         SELECT EXISTS(SELECT 1 FROM sources s CROSS JOIN agent_memory_evidence e
           WHERE e.namespace=?1 AND e.source->>'kind'='conversation' AND e.source->>'$.reference.sessionId'=s.session
             AND (s.producer IS NULL OR EXISTS(SELECT 1 FROM agent_facts f WHERE f.id=e.source->>'$.reference.factId' AND f.run=s.producer)))
          OR EXISTS(SELECT 1 FROM sources s CROSS JOIN agent_run_specs r ON r.owner=?1 AND r.session=s.session
             AND (s.producer IS NULL OR s.producer=r.run) CROSS JOIN contents b ON b.id=r.spec_content_id
             WHERE b.payload->>'$.memoryProjection.digest' IS NOT NULL
               OR EXISTS(SELECT 1 FROM agent_memory_tool_inputs t WHERE t.run=r.run)
               OR EXISTS(SELECT 1 FROM agent_memory_history_reads h WHERE h.run=r.run)
               OR EXISTS(SELECT 1 FROM agent_memory_session_reads h
                   LEFT JOIN session_control sc ON sc.id=h.session
                   LEFT JOIN agent_memory_session_visibility v ON v.session=h.session
                   WHERE h.run=r.run AND (sc.id IS NULL OR coalesce(v.revision,0)<>h.revision)))
          OR EXISTS(SELECT 1 FROM sources s CROSS JOIN agent_memory_adopted_snapshots a ON a.owner=?1 AND a.session=s.session
             WHERE s.producer IS NULL AND (
               EXISTS(SELECT 1 FROM agent_memory_snapshot_outputs o WHERE o.snapshot=a.snapshot)
               OR EXISTS(SELECT 1 FROM agent_memory_imported_outputs o WHERE o.snapshot=a.snapshot
                         AND (o.read_path IS NULL OR maka_reads_history_resource(o.read_path)))
               OR EXISTS(SELECT 1 FROM agent_history_snapshot_entries f
                         JOIN contents b ON b.content_sha256=f.entry_json->>'$.spec.digest'
                         WHERE f.snapshot=a.snapshot AND f.kind='run' AND b.payload->>'$.memoryProjection.digest' IS NOT NULL)
               OR EXISTS(SELECT 1 FROM agent_memory_evidence e
                         JOIN agent_history_snapshot_entries f ON f.kind='fact' AND f.snapshot=a.snapshot
                         AND json_extract(f.entry_json,'$.id')=e.source->>'$.reference.factId'
                         WHERE e.namespace=?1 AND e.source->>'kind'='conversation')))"
    )?.query_row(params![owner,session,producer.map(|run| run.to_string())], |row|row.get(0))?;
    if controlled {
        return Err(invalid("agent_memory_executor_unavailable"));
    }
    Ok(())
}

pub struct Visibility(pub String);
impl Query for Visibility {
    type Output = u64;
    fn execute(self, c: &Connection) -> Result<u64, StoreError> {
        c.prepare_cached(
            "SELECT coalesce(v.revision,0) FROM session_control s
             LEFT JOIN agent_memory_session_visibility v ON v.session=s.id WHERE s.id=?",
        )?
        .query_row([self.0], |row| row.get(0))
        .optional()?
        .ok_or(StoreError::SessionNotFound)
        .and_then(crate::recall::unsigned)
    }
}
pub struct SearchVisibility;
impl Query for SearchVisibility {
    type Output = u64;
    fn execute(self, c: &Connection) -> Result<u64, StoreError> {
        crate::recall::unsigned(c.query_row(
            "SELECT revision FROM agent_memory_visibility WHERE id=1",
            [],
            |row| row.get(0),
        )?)
    }
}

pub struct ReadAuthority {
    pub facts: bool,
    pub history: bool,
    pub project: Option<String>,
}
pub struct CheckReads(pub RunId);
impl Query for CheckReads {
    type Output = ReadAuthority;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        let mut statement = c.prepare_cached(
            "SELECT EXISTS(SELECT 1 FROM agent_memory_tool_inputs WHERE run=?1 AND revoked=1)
                 OR EXISTS(SELECT 1 FROM agent_memory_history_reads h JOIN agent_memory_visibility v ON v.id=1
                           WHERE h.run=?1 AND h.revision<>v.revision)
                 OR EXISTS(SELECT 1 FROM agent_memory_session_reads h
                           LEFT JOIN session_control s ON s.id=h.session
                           LEFT JOIN agent_memory_session_visibility v ON v.session=h.session
                           WHERE h.run=?1 AND (s.id IS NULL OR h.revision<>coalesce(v.revision,0))),
                    EXISTS(SELECT 1 FROM agent_memory_tool_inputs WHERE run=?1),
                    (SELECT min(scope) FROM agent_memory_tool_inputs WHERE run=?1 AND scope<>'personal'),
                    (SELECT max(scope) FROM agent_memory_tool_inputs WHERE run=?1 AND scope<>'personal'),
                    EXISTS(SELECT 1 FROM agent_memory_history_reads WHERE run=?1)
                    OR EXISTS(SELECT 1 FROM agent_memory_session_reads WHERE run=?1)",
        )?;
        let (revoked, facts, project, last_project, history) =
            statement.query_row([self.0.to_string()], |row| {
                Ok((
                    row.get::<_, bool>(0)?,
                    row.get(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get(4)?,
                ))
            })?;
        if revoked || project != last_project {
            return Err(invalid("memory tool input revoked; start a new Run"));
        }
        Ok(ReadAuthority {
            facts,
            project,
            history,
        })
    }
}

pub struct OriginalAdmission(pub RunId);
impl Query for OriginalAdmission {
    type Output = Option<bool>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        Ok(
            c.prepare_cached("SELECT ordinary FROM agent_memory_legacy_runs WHERE run=?")?
                .query_row([self.0.to_string()], |r| r.get(0))
                .optional()?
                .flatten(),
        )
    }
}

pub(crate) struct OriginalReplay {
    pub run: RunId,
    pub owner: maka_agent_facts::durable::RunOwner,
    pub session: String,
}
impl Query for OriginalReplay {
    type Output = bool;
    fn execute(self, c: &Connection) -> Result<bool, StoreError> {
        Ok(c.prepare_cached("SELECT EXISTS(SELECT 1 FROM agent_memory_legacy_runs l JOIN agent_run_specs s ON s.run=l.run WHERE l.run=? AND l.shared=1 AND s.owner=? AND s.session=?)")?
            .query_row(params![self.run.to_string(), serde_json::to_string(&self.owner)?, self.session], |r| r.get(0))?)
    }
}

pub struct HasReads(pub RunId);
impl Query for HasReads {
    type Output = bool;
    fn execute(self, c: &Connection) -> Result<bool, StoreError> {
        let mut statement = c.prepare_cached(
            "SELECT EXISTS(SELECT 1 FROM agent_memory_tool_inputs WHERE run=?1)
                 OR EXISTS(SELECT 1 FROM agent_memory_history_reads WHERE run=?1)
                    OR EXISTS(SELECT 1 FROM agent_memory_session_reads WHERE run=?1)",
        )?;
        Ok(statement.query_row([self.0.to_string()], |row| row.get(0))?)
    }
}

pub struct ExternalConversation(pub String);
impl Query for ExternalConversation {
    type Output = String;
    fn execute(self, c: &Connection) -> Result<String, StoreError> {
        let epoch: Option<i64> = c
            .prepare_cached("SELECT revision FROM agent_memory_external_epochs WHERE session=?")?
            .query_row([&self.0], |row| row.get(0))
            .optional()?;
        Ok(match epoch {
            None => self.0,
            Some(revision) => format!("memory/{}/{}", crate::recall::unsigned(revision)?, self.0),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_agent_facts::durable::{ExecutionIdentity, RunOwner};
    use uuid::Uuid;

    #[test]
    fn recap_upgrade_preserves_legacy_receipts_without_granting_visibility() {
        let db = Connection::open_in_memory().unwrap();
        let catalog: Vec<_> = maka_event_log::ROOT_MIGRATIONS
            .iter()
            .chain(crate::MIGRATIONS)
            .copied()
            .collect();
        let old: Vec<_> = catalog
            .iter()
            .copied()
            .filter(|m| m.version <= 55)
            .collect();
        maka_event_log::migration::run(&db, &old).unwrap();
        db.execute_batch(r#"INSERT INTO session_control(id,fingerprint,revision,created_at,updated_at,archived,configuration)
             VALUES('source','test',1,0,0,0,'{}');
             INSERT INTO plugin_data VALUES('maka.session-recap','profile','old',4,
               '{"kind":"ready","operationId":"00000000-0000-0000-0000-000000000000","through":1,"modelId":"m","text":"old"}'),
             ('maka.session-recap','profile','deleted',5,
               NULL);"#).unwrap();
        maka_event_log::migration::run(&db, &catalog).unwrap();
        let mut rows=db.prepare("SELECT revision,value_json->>'visibility',value_json->>'$.receipt.text' FROM plugin_data ORDER BY revision").unwrap();
        let receipts = rows
            .query_map([], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, Option<i64>>(1)?,
                    r.get::<_, Option<String>>(2)?,
                ))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(receipts, [(4, None, Some("old".into())), (5, None, None)]);
        assert_eq!(Visibility("source".into()).execute(&db).unwrap(), 0);
        db.execute(
            "UPDATE session_control SET archived=1 WHERE id='source'",
            [],
        )
        .unwrap();
        assert!(Visibility("source".into()).execute(&db).unwrap() > 0);
    }

    #[test]
    fn search_publication_and_replay_follow_only_returned_session_dependencies() {
        let db = Connection::open_in_memory().unwrap();
        let migrations = maka_event_log::ROOT_MIGRATIONS
            .iter()
            .chain(crate::MIGRATIONS)
            .copied()
            .collect::<Vec<_>>();
        maka_event_log::migration::run(&db, &migrations).unwrap();
        let owner = RunOwner {
            deployment: Uuid::new_v4(),
            namespace: maka_plugin_core::composition::InstanceId(vec![Uuid::new_v4()]),
        };
        let execution = |session: &str, backend: &str| {
            let run_id = RunId::new();
            let turn_id = Uuid::new_v4().to_string();
            db.execute("INSERT INTO session_control(id,fingerprint,revision,created_at,updated_at,archived,configuration) VALUES(?,'test',1,0,0,0,'{}')",[session]).unwrap();
            db.execute(
                "INSERT INTO contents(content_sha256,payload) VALUES(?,?)",
                params![
                    turn_id,
                    serde_json::to_vec(
                        &serde_json::json!({"turnId":turn_id,"backend":{"kind":backend}})
                    )
                    .unwrap()
                ],
            )
            .unwrap();
            db.execute(
                "INSERT INTO agent_run_specs VALUES(?,1,?,?,?)",
                params![
                    run_id.to_string(),
                    serde_json::to_string(&owner).unwrap(),
                    session,
                    db.last_insert_rowid()
                ],
            )
            .unwrap();
            ExecutionIdentity {
                session_id: session.into(),
                run_id,
                turn_id,
            }
        };
        let first = execution("first", "model");
        let middle = execution("middle", "model");
        let last = execution("last", "model");
        let unrelated = execution("unrelated", "executor");
        let remote = execution("remote", "executor");
        db.execute(
            "INSERT INTO agent_memory_external_epochs(session) VALUES('remote')",
            [],
        )
        .unwrap();
        let journal = || ExternalConversation("remote".into()).execute(&db).unwrap();
        let read = |reader: &ExecutionIdentity, source: &str, before| {
            RecordHistory {
                owner: owner.clone(),
                execution: reader.clone(),
                sources: HistorySources::session(source),
                before,
            }
            .execute(&db)
        };
        let before = SearchVisibility.execute(&db).unwrap();
        read(&middle, "first", Some(before)).unwrap();
        read(&last, "middle", None).unwrap();
        read(&first, "middle", None).unwrap();
        read(&unrelated, "unrelated", None).unwrap();
        read(&remote, "middle", None).unwrap();
        db.execute(
            "UPDATE session_control SET archived=1 WHERE id='unrelated'",
            [],
        )
        .unwrap();
        assert_eq!(journal(), "memory/0/remote");
        assert!(CheckReads(last.run_id).execute(&db).unwrap().history);
        read(&middle, "first", Some(before)).unwrap();
        db.execute("UPDATE session_control SET archived=1 WHERE id='first'", [])
            .unwrap();
        assert!(
            matches!(read(&middle,"first",Some(before)),Err(StoreError::InvalidTransition(message)) if message.contains("history changed while returning tool output"))
        );
        let current = SearchVisibility.execute(&db).unwrap();
        read(&middle, "first", Some(current)).unwrap();
        assert!(matches!(
            CheckReads(middle.run_id).execute(&db),
            Err(StoreError::InvalidTransition(_))
        ));
        assert!(matches!(
            read(&remote, "middle", Some(current)),
            Err(StoreError::InvalidTransition(_))
        ));
        let rotated = journal();
        assert_ne!(rotated, "memory/0/remote");
        db.execute(
            "UPDATE session_control SET archived=1 WHERE id='middle'",
            [],
        )
        .unwrap();
        assert_eq!(journal(), rotated);
        for run in [middle.run_id, last.run_id] {
            assert!(
                matches!(CheckReads(run).execute(&db),Err(StoreError::InvalidTransition(message)) if message.contains("memory tool input revoked"))
            );
        }
    }
}
