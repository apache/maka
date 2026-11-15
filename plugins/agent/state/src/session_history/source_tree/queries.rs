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
pub(super) struct Latest(pub(super) HistoryNamespace, pub(super) HistoryCut);
impl Query for Latest {
    type Output = Option<RunSource>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::validate_cut(c, &self.0.owner, &self.0.session, &self.1)?;
        let run:Option<String>=c.query_row("SELECT h.run FROM agent_session_history h INDEXED BY agent_session_history_historical WHERE h.owner=? AND h.session=? AND h.historical=1 AND h.sequence<=? ORDER BY h.sequence DESC LIMIT 1",params![serde_json::to_string(&self.0.owner)?,self.0.session,sql::bind_u64(self.1.through_sequence)?],|r|r.get(0)).optional()?;
        let Some(run) = run else { return Ok(None) };
        let source = sql::run_source(c, &self.0, sql::identity(run)?)?;
        if !sql::historical_backend(&source.spec)? || source.spec.origin == RunOrigin::Local {
            return Err(invalid("historical source marker is executable local data"));
        }
        Ok(Some(source))
    }
}
pub(super) struct LivePositions(
    pub(super) HistoryNamespace,
    pub(super) HistoryCut,
    pub(super) Option<(u64, u64)>,
    pub(super) bool,
    pub(super) bool,
    pub(super) u64,
    pub(super) u32,
    pub(super) Option<RunRows>,
);
impl Query for LivePositions {
    type Output = Vec<SnapshotPosition>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        crate::recall::checked_source_cut(c, &self.0.owner, &self.1)?;
        let owner = serde_json::to_string(&self.0.owner)?;
        let bound = self.2.unwrap_or(if self.3 {
            (self.1.through_sequence, i64::MAX as u64)
        } else {
            (0, 0)
        });
        let (comparison, order) = if self.3 {
            ("<=", "DESC")
        } else {
            (">=", "ASC")
        };
        let visible = if self.4 { "" } else { " AND d.internal=0" };
        let (constraint, run, attempt) = match self.7 {
            None => ("?8 IS NULL AND ?9 IS NULL", None, None),
            Some(RunRows::Only { run, .. }) => ("d.run=?8 AND ?9 IS NULL", Some(run), None),
            Some(RunRows::Folded { run, attempt }) => (
                r#"(d.run<>?8 OR (
                    d.role='"compaction"'
                    OR (d.role='"user"' AND coalesce(json_extract(d.origin_json,'$.kind'),'')
                        NOT IN ('session','session_completion','automation','bot_worker'))
                    OR (d.role='"assistant"' AND d.internal=0 AND h.attempt=?9)
                ))"#,
                Some(run),
                Some(attempt),
            ),
        };
        let mut statement = c.prepare_cached(&format!(
            "SELECT d.run,d.sequence,h.admission_sequence,h.fact_id,d.ordinal,d.internal
             FROM agent_recall_messages d
             JOIN agent_session_history h ON h.owner=d.owner AND h.session=d.session AND h.sequence=d.sequence
             WHERE d.owner=?1 AND d.session=?2 AND d.sequence<=?3 AND h.admission_sequence>?4
               AND (d.sequence,d.ordinal){comparison}(?5,?6){visible} AND {constraint}
             ORDER BY d.sequence {order},d.ordinal {order} LIMIT ?7"
        ))?;
        let rows = statement
            .query_map(
                params![
                    owner,
                    self.0.session,
                    sql::bind_u64(self.1.through_sequence)?,
                    sql::bind_u64(self.5)?,
                    sql::bind_u64(bound.0)?,
                    sql::bind_u64(bound.1)?,
                    i64::from(self.6),
                    run.map(|run| run.to_string()),
                    attempt.map(|attempt| attempt.to_string()),
                ],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        sql::read_u64(r, 1)?,
                        sql::read_u64(r, 2)?,
                        r.get::<_, String>(3)?,
                        sql::read_u64(r, 4)?,
                        r.get::<_, bool>(5)?,
                    ))
                },
            )?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter()
            .map(
                |(run, sequence, admission_sequence, fact, item_index, internal)| {
                    Ok(SnapshotPosition::Canonical {
                        run: sql::identity(run)?,
                        sequence,
                        admission_sequence,
                        fact: sql::identity(fact)?,
                        item_index,
                        internal,
                    })
                },
            )
            .collect()
    }
}

pub(super) struct RequestAt(
    pub(super) HistoryNamespace,
    pub(super) HistoryCut,
    pub(super) RunId,
    pub(super) StepId,
);
impl Query for RequestAt {
    type Output = RequestSpec;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::request_preparation(c, &self.0, &self.1, self.2, self.3).map(|(request, _)| request)
    }
}

pub(super) struct LiveToolPositions(
    pub(super) HistoryNamespace,
    pub(super) HistoryCut,
    pub(super) String,
    pub(super) Option<(u64, u64)>,
    pub(super) u64,
    pub(super) u32,
);
impl Query for LiveToolPositions {
    type Output = Vec<SnapshotPosition>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        crate::recall::checked_source_cut(c, &self.0.owner, &self.1)?;
        let bound = self.3.unwrap_or((0, 0));
        let rows:Vec<(String,u64,u64,String,u64,bool)>=c.prepare_cached("SELECT d.run,d.sequence,h.admission_sequence,h.fact_id,d.ordinal,d.internal FROM agent_session_history h INDEXED BY agent_session_history_tool CROSS JOIN agent_recall_messages d ON d.owner=h.owner AND d.session=h.session AND d.sequence=h.sequence WHERE h.owner=?1 AND h.session=?2 AND h.tool_use_id=?3 AND h.sequence<=?4 AND h.admission_sequence>?5 AND (d.sequence,d.ordinal)>(?6,?7) ORDER BY d.sequence,d.ordinal LIMIT ?8")?.query_map(params![serde_json::to_string(&self.0.owner)?,self.0.session,self.2,sql::bind_u64(self.1.through_sequence)?,sql::bind_u64(self.4)?,sql::bind_u64(bound.0)?,sql::bind_u64(bound.1)?,i64::from(self.5)],|r|Ok((r.get(0)?,sql::read_u64(r,1)?,sql::read_u64(r,2)?,r.get(3)?,sql::read_u64(r,4)?,r.get(5)?)))?.collect::<Result<_,_>>()?;
        rows.into_iter()
            .map(
                |(run, sequence, admission_sequence, fact, item_index, internal)| {
                    Ok(SnapshotPosition::Canonical {
                        run: sql::identity(run)?,
                        sequence,
                        admission_sequence,
                        fact: sql::identity(fact)?,
                        item_index,
                        internal,
                    })
                },
            )
            .collect()
    }
}

pub(super) struct EventExists(
    pub(super) HistoryNamespace,
    pub(super) HistoryCut,
    pub(super) u64,
);
impl Query for EventExists {
    type Output = bool;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::validate_cut(c, &self.0.owner, &self.0.session, &self.1)?;
        Ok(c.query_row("SELECT EXISTS(SELECT 1 FROM agent_session_history WHERE owner=? AND session=? AND sequence=? AND sequence<=?)",params![serde_json::to_string(&self.0.owner)?,self.0.session,sql::bind_u64(self.2)?,sql::bind_u64(self.1.through_sequence)?],|r|r.get(0))?)
    }
}

pub(super) struct TerminatedAt(
    pub(super) HistoryNamespace,
    pub(super) HistoryCut,
    pub(super) RunId,
);
impl Query for TerminatedAt {
    type Output = Option<(UnixMillis, Terminal)>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::validate_cut(c, &self.0.owner, &self.0.session, &self.1)?;
        let row: Option<(u32, Vec<u8>, String)> = c.query_row("SELECT f.schema_version,b.payload,b.content_sha256 FROM agent_session_history h JOIN agent_facts f ON f.sequence=h.sequence JOIN contents b ON b.id=f.body_content_id WHERE h.owner=? AND h.session=? AND h.run=? AND h.step IS NULL AND h.kind='run_terminated' AND h.sequence<=?",params![serde_json::to_string(&self.0.owner)?,self.0.session,self.2.to_string(),sql::bind_u64(self.1.through_sequence)?],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
        let Some((version, bytes, digest)) = row else {
            return Ok(None);
        };
        sql::check_bytes(&bytes, &digest)?;
        let record = sql::decode_record(version, &bytes)?;
        match record.fact {
            Fact::RunTerminated { terminal, .. } if record.run == self.2 => {
                Ok(Some((record.at, terminal)))
            }
            _ => Err(invalid("Run termination index names another fact")),
        }
    }
}

pub(super) struct RunAt(
    pub(super) HistoryNamespace,
    pub(super) HistoryCut,
    pub(super) RunId,
);
impl Query for RunAt {
    type Output = RunSource;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::validate_cut(c, &self.0.owner, &self.0.session, &self.1)?;
        let source = sql::run_source(c, &self.0, self.2)?;
        if source.admission_sequence > self.1.through_sequence {
            return Err(invalid("Run source is outside this fixed cut"));
        }
        Ok(source)
    }
}

pub(super) struct FinalAttemptAt(
    pub(super) HistoryNamespace,
    pub(super) HistoryCut,
    pub(super) RunId,
);
impl Query for FinalAttemptAt {
    type Output = Option<ModelAttemptId>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        let attempt: Option<String> = c
            .query_row(
                r#"SELECT r.current_attempt
               FROM agent_runs r
               JOIN agent_session_history h
                 ON h.owner=r.owner AND h.session=r.session AND h.run=r.run
                 AND h.step IS NULL AND h.kind='run_terminated'
               WHERE r.run=?1 AND r.owner=?2 AND r.session=?3 AND h.sequence<=?4
                 AND r.terminal='"completed"' AND r.current_attempt IS NOT NULL"#,
                params![
                    self.2.to_string(),
                    serde_json::to_string(&self.0.owner)?,
                    self.0.session,
                    sql::bind_u64(self.1.through_sequence)?
                ],
                |row| row.get(0),
            )
            .optional()?;
        attempt.map(sql::identity).transpose()
    }
}

/// Read a settled turn's summary from its indexed history coordinates, without
/// decoding the tool results, receipts, or the Run's accumulated execution state.
pub(super) struct CompletedWorkAt {
    pub(super) namespace: HistoryNamespace,
    pub(super) cut: HistoryCut,
    pub(super) run: RunId,
    pub(super) turn: String,
}

impl Query for CompletedWorkAt {
    type Output = Option<CompletedWork>;

    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::validate_cut(c, &self.namespace.owner, &self.namespace.session, &self.cut)?;
        let owner = serde_json::to_string(&self.namespace.owner)?;
        let run = self.run.to_string();
        let through = sql::bind_u64(self.cut.through_sequence)?;
        let Some(attempt) =
            FinalAttemptAt(self.namespace.clone(), self.cut.clone(), self.run).execute(c)?
        else {
            return Ok(None);
        };
        let (thoughts, messages, tools, earlier_output): (u64, u64, u64, u64) =
            c.query_row(
                r#"WITH visible AS (
                     SELECT d.sequence, d.role, d.internal, d.body,
                            coalesce(json_extract(d.origin_json,'$.kind'),'') IN
                              ('session','session_completion','automation','bot_worker') AS activity,
                            h.tool_use_id, h.tool_start, h.attempt
                     FROM agent_recall_messages d INDEXED BY agent_recall_turn
                     JOIN agent_session_history h
                       ON h.owner=d.owner AND h.session=d.session AND h.sequence=d.sequence
                     WHERE d.owner=?1 AND d.session=?2 AND d.turn=?3 AND d.sequence<=?4 AND d.run=?5
                   )
                   SELECT count(CASE WHEN internal AND trim(body)<>'' THEN 1 END),
                          count(CASE WHEN role='"user"' AND activity THEN 1 END),
                          count(DISTINCT CASE WHEN tool_start THEN tool_use_id END),
                          count(CASE WHEN role='"assistant"' AND NOT internal AND attempt<>?6 THEN 1 END)
                   FROM visible
                   HAVING count(CASE WHEN role='"assistant"' AND NOT internal AND attempt=?6 THEN 1 END)>0"#,
                params![owner,self.namespace.session,self.turn,through,run,attempt.to_string()],
                |row| Ok((sql::read_u64(row, 0)?, sql::read_u64(row, 1)?, sql::read_u64(row, 2)?, sql::read_u64(row, 3)?)),
            ).optional()?.unwrap_or_default();
        if earlier_output + thoughts + tools + messages == 0 {
            return Ok(None);
        }
        let image_count = c.query_row(
            "SELECT count(DISTINCT b.artifact)
             FROM agent_artifact_run_bindings b
             JOIN agent_artifacts a ON a.session=b.session AND a.artifact=b.artifact
             JOIN agent_session_history h ON h.fact_id=b.fact
             WHERE b.run=?1 AND b.session=?2 AND h.sequence<=?3 AND b.origin IN ('tool','cell')
               AND json_extract(a.record_json,'$.artifact.mimeType') LIKE 'image/%'",
            params![run, self.namespace.session, through],
            |row| sql::read_u64(row, 0),
        )?;
        let mut images = c.prepare_cached(
            "SELECT DISTINCT h.sequence,h.fact_id
             FROM agent_artifact_run_bindings b
             JOIN agent_artifacts a ON a.session=b.session AND a.artifact=b.artifact
             JOIN agent_session_history h ON h.fact_id=b.fact
             WHERE b.run=?1 AND b.session=?2 AND h.sequence<=?3 AND b.origin IN ('tool','cell')
               AND json_extract(a.record_json,'$.artifact.mimeType') LIKE 'image/%'
             ORDER BY h.sequence DESC LIMIT 4",
        )?;
        let image_sources = images
            .query_map(params![run, self.namespace.session, through], |row| {
                Ok((sql::read_u64(row, 0)?, row.get::<_, String>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .rev()
            .map(|(sequence, fact)| {
                Ok(HistoryRowAddress::Live {
                    sequence,
                    fact: sql::identity(fact)?,
                    item_index: 0,
                })
            })
            .collect::<Result<Vec<_>, StoreError>>()?;
        Ok(Some(CompletedWork {
            attempt,
            thoughts,
            messages,
            tools,
            image_sources,
            image_count,
        }))
    }
}

pub(super) struct ReportedModelAt(
    pub(super) HistoryNamespace,
    pub(super) HistoryCut,
    pub(super) RunId,
    pub(super) StepId,
    pub(super) ModelAttemptId,
);
impl Query for ReportedModelAt {
    type Output = Option<String>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::validate_cut(c, &self.0.owner, &self.0.session, &self.1)?;
        let row: Option<(u32, Vec<u8>, String)> = c
            .query_row(
                "SELECT f.schema_version,b.payload,b.content_sha256
             FROM agent_session_history h
             JOIN agent_facts f ON f.sequence=h.sequence
             JOIN contents b ON b.id=f.body_content_id
             WHERE h.owner=?1 AND h.session=?2 AND h.run=?3 AND h.step=?4
               AND h.kind='model_closed' AND h.attempt=?5 AND h.sequence<=?6",
                params![
                    serde_json::to_string(&self.0.owner)?,
                    self.0.session,
                    self.2.to_string(),
                    self.3.to_string(),
                    self.4.to_string(),
                    sql::bind_u64(self.1.through_sequence)?
                ],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let Some((version, bytes, digest)) = row else {
            return Ok(None);
        };
        sql::check_bytes(&bytes, &digest)?;
        let Fact::ModelClosed {
            outcome, protocol, ..
        } = sql::decode_record(version, &bytes)?.fact
        else {
            return Err(invalid("Model closure index names another fact"));
        };
        if outcome != maka_agent_facts::accounting::Outcome::Success {
            return Ok(None);
        }
        let protocol: maka_agent_facts::context::ModelClosureProtocol =
            serde::Deserialize::deserialize(&protocol)?;
        Ok(protocol.model)
    }
}

pub(super) struct ProjectedToolAt(
    pub(super) HistoryNamespace,
    pub(super) HistoryCut,
    pub(super) RunId,
    pub(super) ToolKey,
);
impl Query for ProjectedToolAt {
    type Output = Option<crate::fold::Tool>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        let row: Option<String> = c
            .query_row(
                "SELECT t.body FROM agent_tools t JOIN agent_runs r ON r.run=t.run
             JOIN agent_facts f ON f.run=r.run AND f.revision=r.revision
             WHERE t.run=?1 AND t.key=?2 AND r.owner=?3 AND r.session=?4 AND f.sequence<=?5",
                params![
                    self.2.to_string(),
                    crate::fold::tool_key(&self.3),
                    serde_json::to_string(&self.0.owner)?,
                    self.0.session,
                    sql::bind_u64(self.1.through_sequence)?
                ],
                |row| row.get(0),
            )
            .optional()?;
        row.map(|body| serde_json::from_str(&body).map_err(StoreError::from))
            .transpose()
    }
}

pub(super) struct ProjectedCellAt(
    pub(super) HistoryNamespace,
    pub(super) HistoryCut,
    pub(super) RunId,
    pub(super) maka_agent_facts::cells::CellId,
);
impl Query for ProjectedCellAt {
    type Output = Option<maka_agent_facts::cells::CellView>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        let row: Option<String> = c
            .query_row(
                "SELECT t.body FROM agent_cells t JOIN agent_runs r ON r.run=t.run
             JOIN agent_facts f ON f.run=r.run AND f.revision=r.revision
             WHERE t.run=?1 AND t.cell=?2 AND r.owner=?3 AND r.session=?4 AND f.sequence<=?5",
                params![
                    self.2.to_string(),
                    self.3.to_string(),
                    serde_json::to_string(&self.0.owner)?,
                    self.0.session,
                    sql::bind_u64(self.1.through_sequence)?
                ],
                |row| row.get(0),
            )
            .optional()?;
        row.map(|body| serde_json::from_str(&body).map_err(StoreError::from))
            .transpose()
    }
}
