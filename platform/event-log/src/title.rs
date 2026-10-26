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

//! Logical title failure evidence does not create a physical model attempt.

use crate::{EventLog, StoreError};
use maka_agent_facts::{
    diagnostics::TitleFailureCause,
    event::{Fact, Invocation},
    execution::ModelBinding,
};
use serde::Serialize;
use sqlx::{Connection, SqliteConnection};
use std::time::SystemTime;

#[derive(Serialize)]
struct Failure {
    // A non-runtime event must not populate the generated runtime event_session.
    opening: Invocation,
    recorded_at: SystemTime,
    cause: TitleFailureCause,
}

impl EventLog {
    pub async fn record_title_failure(
        &self,
        invocation: Invocation,
        cause: TitleFailureCause,
    ) -> Result<u64, StoreError> {
        self.validate_root()?;
        cause
            .validate()
            .map_err(|error| invalid(&error.to_string()))?;
        let commits = self.commits.session(&invocation.session_id);
        self.connection.run(move |connection| Box::pin(async move {
            let mut tx = connection.begin_with("BEGIN IMMEDIATE").await?;
            original_title_binding(&mut tx, &invocation).await?;
            let failure = Failure { opening: invocation, recorded_at: SystemTime::now(), cause };
            let result = sqlx::query("INSERT INTO event_log(event_id,kind,event_json) VALUES (?,'title_failure',?)")
                .bind(uuid::Uuid::new_v4().to_string()).bind(serde_json::to_string(&failure)?)
                .execute(&mut *tx).await?;
            let sequence = crate::sequence_number(result.last_insert_rowid())?;
            tx.commit().await.map_err(StoreError::CommitUnknown)?;
            commits.publish(sequence);
            Ok(sequence)
        })).await
    }
}

/// Original provenance only; current admission and attempt policy belong to the caller.
pub(crate) async fn original_title_binding(
    connection: &mut SqliteConnection,
    invocation: &Invocation,
) -> Result<ModelBinding, StoreError> {
    let opening = crate::message_sources::first_message_opening(connection, &invocation.session_id)
        .await?
        .ok_or_else(|| invalid("Session title has no committed user opening"))?;
    if opening.event.invocation != *invocation {
        return Err(invalid("Session title must use its first user opening"));
    }
    match opening.event.fact {
        Fact::InvocationOpened {
            configuration: Some(config),
            ..
        } => config
            .model
            .ok_or_else(|| invalid("Session title has no frozen model binding")),
        _ => Err(invalid("Session title has no frozen configuration")),
    }
}
fn invalid(message: &str) -> StoreError {
    StoreError::InvalidTransition(message.into())
}
