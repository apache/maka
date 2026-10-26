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

//! Fixed Session history inherited before a fresh Run. This is source evidence,
//! not permission to resume or replay that Run's effects.

use super::{
    ModelContextSource, SourceEvidence, evidence, invalid, latest_main, proof, read, safety,
    selection::Selection,
};
use crate::{EventLog, StoreError};
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::Invocation;
use maka_agent_facts::event::InvocationInput;
use maka_agent_facts::event::LogScope;
use sqlx::{Connection, SqliteConnection};

impl EventLog {
    /// Source identity before a fresh Run, without materializing its history.
    pub async fn source_before_run(
        &self,
        invocation: &Invocation,
    ) -> Result<SourceEvidence, StoreError> {
        self.validate_root()?;
        for id in [
            &invocation.session_id,
            &invocation.turn_id,
            &invocation.run_id,
            &invocation.invocation_id,
        ] {
            crate::sessions::validate_id(id)?;
        }
        let invocation = invocation.clone();
        self.connection
            .read_interruptible(move |connection| {
                Box::pin(async move {
                    let mut tx = connection.begin().await?;
                    let selected = crate::turns::run_invocation(
                        &mut tx,
                        &invocation.session_id,
                        &invocation.run_id,
                    )
                    .await?;
                    if selected.as_deref() != Some(&invocation.invocation_id) {
                        return Err(invalid("base Run identity is missing or changed"));
                    }
                    let row:Option<(i64,String,Option<String>)>=sqlx::query_as("SELECT opening_sequence,identity_json,parent_invocation_id FROM context_source_lineages WHERE invocation_id=?")
                        .bind(&invocation.invocation_id).fetch_optional(&mut *tx).await?;
                    let Some((sequence,identity,parent))=row else {return Err(invalid("Session base requires an exact fresh Message opening"));};
                    if parent.is_some() || serde_json::from_str::<Invocation>(&identity)?!=invocation {
                        return Err(invalid("Session base requires an exact fresh Message opening"));
                    }
                    let high =
                        evidence::high_water(&mut tx, &invocation.session_id, sequence)
                            .await?;
                    if high > 0 {
                        safety::closed_boundary(&mut tx, &invocation.session_id, high).await?;
                    }
                    safety::require_safe_through(&mut tx, &invocation.session_id, None, high)
                        .await?;
                    let source = evidence::evidence(&mut tx, &invocation.session_id, high).await?;
                    tx.commit().await?;
                    Ok(source)
                })
            })
            .await
    }

    /// Capture the complete closed Session base before this exact fresh opening.
    /// The opening's own message belongs to its Run segment, not to this base.
    pub async fn context_before_run(
        &self,
        invocation: &Invocation,
        max_events: usize,
        max_bytes: usize,
    ) -> Result<ModelContextSource, StoreError> {
        self.validate_root()?;
        for id in [
            &invocation.session_id,
            &invocation.turn_id,
            &invocation.run_id,
            &invocation.invocation_id,
        ] {
            crate::sessions::validate_id(id)?;
        }
        let invocation = invocation.clone();
        self.connection
            .run(move |connection| {
                Box::pin(async move {
                    let mut tx = connection.begin().await?;
                    let selected = crate::turns::run_invocation(
                        &mut tx,
                        &invocation.session_id,
                        &invocation.run_id,
                    )
                    .await?;
                    if selected.as_deref() != Some(&invocation.invocation_id) {
                        return Err(invalid("base Run identity is missing or changed"));
                    }
                    let (sequence, opening) = proof::by_kind(
                        &mut tx,
                        &invocation.invocation_id,
                        "invocation_opened",
                        None,
                    )
                    .await?;
                    if opening.invocation != invocation
                        || !matches!(
                            opening.fact,
                            Fact::InvocationOpened {
                                input: InvocationInput::Message { .. },
                                ..
                            }
                        )
                    {
                        return Err(invalid(
                            "Session base requires an exact fresh Message opening",
                        ));
                    }
                    let high_water =
                        evidence::high_water(&mut tx, &invocation.session_id, sequence as i64)
                            .await?;
                    let source = closed(
                        &mut tx,
                        &invocation.session_id,
                        high_water,
                        max_events,
                        max_bytes,
                    )
                    .await?;
                    tx.commit().await?;
                    Ok(source)
                })
            })
            .await
    }

    /// Rebuild exactly the recorded closed Session base, including its then-current
    /// checkpoint, archive projection and Main diagnostics. Later facts are excluded.
    /// The expected raw digest authenticates the entire source, not only the visible tail.
    pub async fn read_frozen_model_context(
        &self,
        expected: &SourceEvidence,
        max_events: usize,
        max_bytes: usize,
    ) -> Result<ModelContextSource, StoreError> {
        self.validate_root()?;
        let session = match &expected.scope {
            LogScope::Session { id } | LogScope::Lineage { session_id: id, .. } => id,
            LogScope::Root => {
                return Err(invalid(
                    "frozen context requires a Session or lineage scope",
                ));
            }
        };
        crate::sessions::validate_id(session)?;
        if expected.high_water >= i64::MAX as u64 {
            return Err(invalid("frozen context cut exceeds ledger capacity"));
        }
        let (scope, high_water, digest) = (
            expected.scope.clone(),
            expected.high_water,
            expected.digest.clone(),
        );
        self.connection
            .run(move |connection| {
                Box::pin(async move {
                    let mut tx = connection.begin().await?;
                    let selection = Selection::resolve(&mut tx, &scope).await?;
                    let source =
                        closed_selected(&mut tx, &selection, high_water, max_events, max_bytes)
                            .await?;
                    if source.source_evidence.digest != digest {
                        return Err(invalid("frozen Session context source changed"));
                    }
                    tx.commit().await?;
                    Ok(source)
                })
            })
            .await
    }
}

async fn closed(
    connection: &mut SqliteConnection,
    session: &str,
    high_water: u64,
    max_events: usize,
    max_bytes: usize,
) -> Result<ModelContextSource, StoreError> {
    closed_selected(
        connection,
        &Selection::session(session),
        high_water,
        max_events,
        max_bytes,
    )
    .await
}

pub(super) async fn closed_selected(
    connection: &mut SqliteConnection,
    selection: &Selection,
    high_water: u64,
    max_events: usize,
    max_bytes: usize,
) -> Result<ModelContextSource, StoreError> {
    let session = selection
        .session
        .as_deref()
        .ok_or_else(|| invalid("context requires a Session"))?;
    if high_water > 0 {
        safety::closed_boundary(connection, session, high_water).await?;
    }
    safety::require_safe_through(connection, session, None, high_water).await?;
    let latest_main = latest_main::read_selected(connection, selection, high_water).await?;
    read::materialize_selected(
        connection,
        selection,
        high_water,
        high_water + 1,
        max_events,
        max_bytes,
        latest_main,
    )
    .await
}

pub(crate) async fn verify_base(
    connection: &mut SqliteConnection,
    invocation: &Invocation,
    opening_sequence: u64,
    expected: &maka_agent_facts::continuation::SessionBase,
) -> Result<(), StoreError> {
    if fresh_base(connection, invocation, opening_sequence).await? != *expected {
        return Err(invalid("continuation's fresh Session base changed"));
    }
    Ok(())
}

pub(crate) async fn fresh_base(
    connection: &mut SqliteConnection,
    invocation: &Invocation,
    opening_sequence: u64,
) -> Result<maka_agent_facts::continuation::SessionBase, StoreError> {
    let session = &invocation.session_id;
    let through = evidence::high_water(connection, session, opening_sequence as i64).await?;
    Ok(maka_agent_facts::continuation::SessionBase {
        high_water: through,
        digest: evidence::evidence(connection, session, through)
            .await?
            .digest,
    })
}
