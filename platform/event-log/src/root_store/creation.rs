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
use serde::Deserialize;
use serde_json::Value;

/// Confirmed, rolled-back admission outcomes. Storage failures never become a
/// rejected request; they retain their recovery obligation and original error.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, thiserror::Error)]
#[serde(rename_all = "camelCase")]
pub enum CreationRejection {
    #[error("Session identity is already occupied")]
    IdentityConflict,
    #[error("source revision changed from {expected} to {actual}")]
    SourceRevisionConflict { expected: u64, actual: u64 },
    #[error("creation dependency is missing")]
    MissingDependency,
    #[error("source history is managed by another owner")]
    ManagedSource,
    #[error("source Turn does not exist")]
    HistoryTurnMissing,
    #[error("revision Turn has no editable input")]
    RevisionInputMissing,
    #[error("revision family exhausted")]
    RevisionFamilyExhausted,
    #[error("history cut splits a logical Turn")]
    HistoryTurnSplit,
    #[error("source history is unsettled")]
    HistoryUnsettled,
    #[error("source provider effect is unresolved")]
    HistoryProviderEffectUnresolved,
    #[error("Session identity has been retired")]
    Retired,
    #[error("workspace binding does not exist")]
    MissingWorkspaceBinding,
    #[error("workspace attachment changed before creation")]
    StaleWorkspaceBinding,
}

pub(super) fn validate_configuration(configuration: &Value) -> Result<(), StoreError> {
    if crate::workspace_bindings::attached(configuration)?.is_some() {
        let boundary = configuration
            .get("boundary_revision")
            .and_then(Value::as_u64)
            .filter(|revision| *revision <= 9_007_199_254_740_991);
        if boundary.is_none() {
            return Err(StoreError::InvalidTransition(
                "invalid Session permission boundary".into(),
            ));
        }
    }
    Ok(())
}

pub(super) async fn commit(
    store: &EventLog,
    id: &str,
    fingerprint: &str,
    configuration: Value,
    now: u64,
) -> Result<Option<CreationRejection>, StoreError> {
    let id = id.to_owned();
    let fingerprint = fingerprint.to_owned();
    store
        .connection
        .run(move |connection| {
            Box::pin(async move {
                let mut tx = connection.begin_with("BEGIN IMMEDIATE").await?;
                // Receipt recovery precedes mutable attachment checks. This also handles
                // a lost partition commit response followed by a workspace relocation.
                let previous: Option<String> =
                    sqlx::query_scalar("SELECT fingerprint FROM session_control WHERE id=?")
                        .bind(&id)
                        .fetch_optional(&mut *tx)
                        .await?;
                if let Some(previous) = previous {
                    tx.rollback().await?;
                    return Ok(
                        (previous != fingerprint).then_some(CreationRejection::IdentityConflict)
                    );
                }
                match crate::sessions::removal::require_accepting(&mut tx, &id).await {
                    Ok(()) => {}
                    Err(StoreError::SessionRetired) => {
                        tx.rollback().await?;
                        return Ok(Some(CreationRejection::Retired));
                    }
                    Err(error) => return Err(error),
                }
                if let Some(reference) = crate::workspace_bindings::attached(&configuration)? {
                    let current =
                        crate::workspace_bindings::read::<Value>(&mut tx, reference.id).await?;
                    let rejection = match current {
                        None => Some(CreationRejection::MissingWorkspaceBinding),
                        Some(binding) if binding.reference() != reference => {
                            Some(CreationRejection::StaleWorkspaceBinding)
                        }
                        Some(_) => None,
                    };
                    if let Some(rejection) = rejection {
                        tx.rollback().await?;
                        return Ok(Some(rejection));
                    }
                }
                match crate::sessions::insert(
                    &mut tx,
                    &id,
                    &fingerprint,
                    &serde_json::to_string(&configuration)?,
                    now,
                )
                .await
                {
                    Ok(()) => {}
                    Err(StoreError::SessionConflict) => {
                        tx.rollback().await?;
                        return Ok(Some(CreationRejection::IdentityConflict));
                    }
                    Err(error) => return Err(error),
                }
                tx.commit().await.map_err(StoreError::CommitUnknown)?;
                Ok(None)
            })
        })
        .await
}
