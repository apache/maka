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
        let mut statement=c.prepare_cached(&format!("SELECT d.run,d.sequence,h.admission_sequence,h.fact_id,d.ordinal,d.internal FROM agent_recall_messages d JOIN agent_session_history h ON h.owner=d.owner AND h.session=d.session AND h.sequence=d.sequence WHERE d.owner=? AND d.session=? AND d.sequence<=? AND h.admission_sequence>? AND (d.sequence,d.ordinal){comparison}(?,?){visible} ORDER BY d.sequence {order},d.ordinal {order} LIMIT ?"))?;
        let rows = statement
            .query_map(
                params![
                    owner,
                    self.0.session,
                    sql::bind_u64(self.1.through_sequence)?,
                    sql::bind_u64(self.5)?,
                    sql::bind_u64(bound.0)?,
                    sql::bind_u64(bound.1)?,
                    i64::from(self.6)
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
        sql::request(c, &self.0, &self.1, self.2, self.3)
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
