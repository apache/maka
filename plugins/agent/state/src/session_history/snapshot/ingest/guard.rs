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

impl SessionHistory {
    pub async fn validate_restore_source(&self, source: &Snapshot) -> Result<(), StoreError> {
        self.data
            .query(RestoreBasis::new(self, source).await?)
            .await
    }
    /// Root separately guards metadata rebinding; this protects the unchanged
    /// original history, allowing only completed installations of this source.
    pub async fn guard_restore<S: Statement>(
        &self,
        source: &Snapshot,
        inner: S,
    ) -> Result<impl Statement<Value = S::Value, Output = S::Output> + use<S>, StoreError> {
        Ok(GuardRestore {
            basis: RestoreBasis::new(self, source).await?,
            inner,
        })
    }
}
struct RestoreBasis {
    namespace: HistoryNamespace,
    source: Snapshot,
    cut: HistoryCut,
}
impl RestoreBasis {
    async fn new(history: &SessionHistory, source: &Snapshot) -> Result<Self, StoreError> {
        if !source.same_root(&history.data) {
            return Err(invalid("restore source belongs to another actual Root"));
        }
        let Origin::Canonical { cut } = source.manifest().await?.origin else {
            return Err(invalid(
                "workspace restore requires an original canonical Session prefix",
            ));
        };
        if cut.owner != history.namespace.owner || cut.session != history.namespace.session {
            return Err(invalid(
                "restore source belongs to another original Session namespace",
            ));
        }
        Ok(Self {
            namespace: history.namespace.clone(),
            source: source.clone(),
            cut,
        })
    }
    fn validate(&self, c: &Connection) -> Result<(), StoreError> {
        use crate::session_history::sql;
        read::authorize(c, &self.source)?;
        sql::validate_cut(c, &self.namespace.owner, &self.namespace.session, &self.cut)?;
        let current = sql::capture_at(c, &self.namespace.owner, &self.namespace.session, None)?;
        let owner = serde_json::to_string(&self.namespace.owner)?;
        let mut after = self.cut.through_sequence;
        let mut next=c.prepare_cached("SELECT h.sequence,h.run,h.kind,h.fact_id,f.revision FROM agent_session_history h JOIN agent_facts f ON f.sequence=h.sequence WHERE h.owner=?1 AND h.session=?2 AND h.sequence>?3 AND h.sequence<=?4 ORDER BY h.sequence LIMIT 1")?;
        while after < current.through_sequence {
            let (sequence, run, kind, fact, revision): (u64, String, String, String, u64) = next
                .query_row(
                    params![
                        owner,
                        self.namespace.session,
                        bind_u64(after)?,
                        bind_u64(current.through_sequence)?
                    ],
                    |row| {
                        Ok((
                            read_u64(row, 0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            read_u64(row, 4)?,
                        ))
                    },
                )?;
            if kind != "run_admitted" || revision != 1 {
                return Err(invalid("workspace restore source history advanced"));
            }
            let run = sql::identity(run)?;
            let original = sql::run_source(c, &self.namespace, run)?;
            let receipt: Option<(String, String)> = c
                .query_row(
                    "SELECT snapshot,fact FROM agent_history_snapshot_adoptions WHERE run=?",
                    [run.to_string()],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            if receipt != Some((self.source.id.to_string(), fact.clone()))
                || original.admission_sequence != sequence
                || original.admission.id.to_string() != fact
                || !matches!(original.spec.backend, BackendSpec::Historical {})
                || !matches!(original.spec.trigger, Trigger::HistorySource)
                || original.spec.origin
                    != (RunOrigin::Imported {
                        source: self.source.reference().clone(),
                    })
            {
                return Err(invalid(
                    "workspace restore suffix is not an original installation of this source",
                ));
            }
            // Adoption atomically installs exactly admission + Completed. Any
            // later fact makes this more than an inert source installation.
            let view = crate::sql::load(c, run, &[], false)?;
            let count: u64 = c.query_row(
                "SELECT count(*) FROM agent_facts WHERE run=?",
                [run.to_string()],
                |row| read_u64(row, 0),
            )?;
            if view.revision != 2 || view.terminal != Some(Terminal::Completed) || count != 2 {
                return Err(invalid(
                    "workspace restore source installation is partial or has additional execution",
                ));
            }
            let (sequence, terminal_run, kind, _, revision): (u64, String, String, String, u64) =
                next.query_row(
                    params![
                        owner,
                        self.namespace.session,
                        bind_u64(sequence)?,
                        bind_u64(current.through_sequence)?
                    ],
                    |row| {
                        Ok((
                            read_u64(row, 0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            read_u64(row, 4)?,
                        ))
                    },
                )?;
            if terminal_run != run.to_string() || kind != "run_terminated" || revision != 2 {
                return Err(invalid(
                    "workspace restore source installation is not closed at the original boundary",
                ));
            }
            after = sequence;
        }
        Ok(())
    }
}
impl Query for RestoreBasis {
    type Output = ();
    fn execute(self, c: &Connection) -> Result<(), StoreError> {
        self.validate(c)
    }
}
struct GuardRestore<S> {
    basis: RestoreBasis,
    inner: S,
}
impl<S: Statement> Statement for GuardRestore<S> {
    type Value = S::Value;
    type Output = S::Output;
    const PREPARE_OFF_THREAD: bool = S::PREPARE_OFF_THREAD;
    fn prepare(mut self) -> Result<Self, StoreError> {
        self.inner = self.inner.prepare()?;
        Ok(self)
    }
    fn retain(&self) -> Vec<Arc<dyn Send + Sync>> {
        self.inner.retain()
    }
    fn execute(self, c: &Connection) -> Result<Prepared<Self::Value>, StoreError> {
        self.basis.validate(c)?;
        self.inner.execute(c)
    }
    fn committed(value: Self::Value) -> Self::Output {
        S::committed(value)
    }
    fn isolated_rejection(error: &StoreError) -> bool {
        S::isolated_rejection(error)
            || matches!(
                error.underlying(),
                StoreError::InvalidTransition(_) | StoreError::EventConflict
            )
    }
}
