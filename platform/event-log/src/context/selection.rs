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

//! A disposable SQL selection derived from immutable openings, never an authority or cache.
use crate::{StoreError, sequence_number};
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::Invocation;
use maka_agent_facts::event::LogScope;
use maka_agent_facts::event::RuntimeEvent;
use sqlx::SqliteConnection;

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct Selection {
    pub scope: LogScope,
    pub session: Option<String>,
    pub lineage: Option<String>,
}

impl Selection {
    pub fn session(session: &str) -> Self {
        Self {
            scope: LogScope::Session { id: session.into() },
            session: Some(session.into()),
            lineage: None,
        }
    }

    pub async fn resolve(
        connection: &mut SqliteConnection,
        scope: &LogScope,
    ) -> Result<Self, StoreError> {
        let (session, run) = match scope {
            LogScope::Root => {
                return Ok(Self {
                    scope: scope.clone(),
                    session: None,
                    lineage: None,
                });
            }
            LogScope::Session { id } => {
                crate::sessions::validate_id(id)?;
                return Ok(Self::session(id));
            }
            LogScope::Lineage { session_id, run_id } => (session_id, run_id),
        };
        crate::sessions::validate_id(session)?;
        crate::sessions::validate_id(run)?;
        let invocation = crate::turns::run_invocation(connection, session, run)
            .await?
            .ok_or_else(|| super::invalid("lineage root Run is missing"))?;
        let base: i64 = sqlx::query_scalar(
            "SELECT base_sequence FROM context_source_lineages WHERE invocation_id=?",
        )
        .bind(&invocation)
        .fetch_optional(connection)
        .await?
        .ok_or_else(|| super::invalid("opening does not inherit model history"))?;
        let lineage = serde_json::to_string(&serde_json::json!({"base":base,"run":invocation}))?;
        Ok(Self {
            scope: scope.clone(),
            session: Some(session.clone()),
            lineage: Some(lineage),
        })
    }

    /// The canonical opening authenticates selection independently of the read cut.
    /// In particular, pre-turn compaction reads before this opening.
    pub async fn for_opening(
        connection: &mut SqliteConnection,
        opening: &RuntimeEvent,
    ) -> Result<Self, StoreError> {
        let Fact::InvocationOpened { input, .. } = &opening.fact else {
            return Err(super::invalid("selection requires a canonical opening"));
        };
        if input.inherited_claim().is_some() {
            Self::resolve(
                connection,
                &LogScope::Lineage {
                    session_id: opening.invocation.session_id.clone(),
                    run_id: opening.invocation.run_id.clone(),
                },
            )
            .await
        } else {
            Ok(Self::session(&opening.invocation.session_id))
        }
    }

    pub async fn for_invocation(
        connection: &mut SqliteConnection,
        invocation: &Invocation,
    ) -> Result<Self, StoreError> {
        let (_, opening) = super::proof::by_kind(
            connection,
            &invocation.invocation_id,
            "invocation_opened",
            None,
        )
        .await?;
        if opening.invocation != *invocation {
            return Err(super::invalid("selection opening identity changed"));
        }
        Self::for_opening(connection, &opening).await
    }

    /// Test one candidate using immutable logarithmic ancestry jumps.
    pub(crate) fn lineage_contains(candidate: &str, parameter: &str) -> String {
        format!("context_lineage_contains(json_extract({parameter},'$.run'),{candidate})")
    }

    /// Alias and parameter are internal SQL identifiers, never client values.
    pub fn predicate(alias: &str, parameter: &str) -> String {
        let contains = Self::lineage_contains(&format!("{alias}.invocation_id"), parameter);
        format!(
            "({parameter} IS NULL OR {alias}.sequence<=json_extract({parameter},'$.base') OR {contains})"
        )
    }

    /// Inherited archives are frozen at copy time. New archives belong to this
    /// owner and follow its time and lineage fences, never the source's changes.
    pub fn archive_predicate(target: &str, archive: &str, before: &str, lineage: &str) -> String {
        let filter = Self::predicate(archive, lineage);
        format!(
            "(({target}.inherited = 1 AND {archive}.sequence = {target}.archive_sequence)
            OR (json_extract({archive}.event_header,'$.invocation.session_id') = {target}.owner_session_id
                AND {archive}.sequence < {before} AND {filter}))"
        )
    }

    pub async fn high_water(
        &self,
        connection: &mut SqliteConnection,
        through: u64,
    ) -> Result<u64, StoreError> {
        let filter = Self::predicate("e", "?3");
        let session = self
            .session
            .as_deref()
            .ok_or_else(|| super::invalid("context requires a Session"))?;
        sequence_number(
            sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
                "SELECT MAX(
                    (SELECT COALESCE(MAX(e.sequence),0) FROM runtime_events e WHERE e.sequence <= ?1
                     AND (e.event_header IS NOT NULL AND e.event_session=?2) AND {filter}),
                    (SELECT COALESCE(MAX(h.sequence),0) FROM session_history_members h
                     JOIN runtime_events e ON e.sequence=h.sequence
                     WHERE h.session_id=?2 AND h.sequence <= ?1 AND {filter}))"
            )))
            .bind(through as i64)
            .bind(session)
            .bind(&self.lineage)
            .fetch_one(connection)
            .await?,
        )
    }
}
