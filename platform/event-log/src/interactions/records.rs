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

use crate::StoreError;
use maka_agent_facts::interaction::GrantTarget;
use maka_agent_facts::interaction::InteractionOutcome;
use maka_agent_facts::interaction::InteractionRecord;
use maka_agent_facts::interaction::entity_id;
use serde::{Serialize, de::DeserializeOwned};
use sqlx::Row;

pub(crate) fn invalid(message: &str) -> StoreError {
    StoreError::InvalidTransition(message.into())
}

pub(crate) fn encode(value: &impl Serialize) -> Result<String, StoreError> {
    Ok(maka_agent_facts::capability::json::stringify(value)?)
}

pub(crate) fn decode<T: DeserializeOwned>(json: &str) -> Result<T, StoreError> {
    Ok(serde_json::from_str(json)?)
}

/// Browser grants apply to all tools on the same origin and contract.
/// MCP scope already contains its server/tool; outer display labels are not authority.
pub(crate) fn authority_key(session: &str, target: &GrantTarget) -> Result<String, StoreError> {
    entity_id(session).map_err(invalid)?;
    target.validate().map_err(invalid)?;
    Ok(serde_json::to_string(&(
        session,
        &target.provider_id,
        &target.contract_id,
        target.capability,
        &target.scope,
    ))?)
}

pub(crate) fn equivalent(left: &InteractionOutcome, right: &InteractionOutcome) -> bool {
    match (left, right) {
        (
            InteractionOutcome::SessionApprovalDecision { decision: left, .. },
            InteractionOutcome::SessionApprovalDecision {
                decision: right, ..
            },
        ) => left == right,
        (
            InteractionOutcome::ServiceApprovalDecision { decision: left, .. },
            InteractionOutcome::ServiceApprovalDecision {
                decision: right, ..
            },
        ) => left == right,
        (
            InteractionOutcome::ComputerAppDecision { decision: left, .. },
            InteractionOutcome::ComputerAppDecision {
                decision: right, ..
            },
        ) => left == right,
        (
            InteractionOutcome::PermissionsDecision { decision: left, .. },
            InteractionOutcome::PermissionsDecision {
                decision: right, ..
            },
        ) => left == right,
        (
            InteractionOutcome::QuestionAnswer { answers: left, .. },
            InteractionOutcome::QuestionAnswer { answers: right, .. },
        ) => left == right,
        (
            InteractionOutcome::FormAnswer { result: left, .. },
            InteractionOutcome::FormAnswer { result: right, .. },
        ) => left == right,
        (
            InteractionOutcome::ClientCapabilityDecision { decision: left, .. },
            InteractionOutcome::ClientCapabilityDecision {
                decision: right, ..
            },
        ) => left == right,
        (
            InteractionOutcome::SystemPermissionGranted { .. },
            InteractionOutcome::SystemPermissionGranted { .. },
        ) => true,
        (
            InteractionOutcome::Closure { reason: left, .. },
            InteractionOutcome::Closure { reason: right, .. },
        ) => left == right,
        _ => false,
    }
}

pub(crate) async fn read_scoped(
    connection: &mut sqlx::SqliteConnection,
    request_id: &str,
    expected_session: Option<&str>,
) -> Result<Option<InteractionRecord>, StoreError> {
    read_from(connection, request_id, expected_session).await
}

pub(crate) async fn read_local(
    connection: &mut sqlx::SqliteConnection,
    request_id: &str,
) -> Result<Option<InteractionRecord>, StoreError> {
    read_from(connection, request_id, None).await
}

async fn read_from(
    connection: &mut sqlx::SqliteConnection,
    request_id: &str,
    expected_session: Option<&str>,
) -> Result<Option<InteractionRecord>, StoreError> {
    let sql =
        "SELECT request.session_id,request.created_at,request.record_json,outcome.outcome_json
        FROM interaction_requests AS request LEFT JOIN interaction_outcomes AS outcome
        ON outcome.request_id=request.request_id WHERE request.request_id=?
        AND (? IS NULL OR request.session_id=?)";
    let row = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(request_id)
        .bind(expected_session)
        .bind(expected_session)
        .fetch_optional(connection)
        .await?;
    let Some(row) = row else { return Ok(None) };
    let mut record: InteractionRecord = decode(row.try_get(2)?)?;
    if record.outcome.is_some()
        || record.request_id != request_id
        || record.session_id != row.try_get::<&str, _>(0)?
        || i64::try_from(record.created_at).ok() != Some(row.try_get(1)?)
    {
        return Err(invalid("stored interaction identity changed"));
    }
    record.outcome = row.try_get::<Option<&str>, _>(3)?.map(decode).transpose()?;
    record.validate().map_err(invalid)?;
    Ok(Some(record))
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_agent_facts::{
        interaction::{
            ComputerAppDecision, ComputerAppDisplay, ComputerAppPlatform, GrantCapability,
            GrantScope, InteractionRequest,
        },
        workspace::{BindingStamp, PermissionBasis},
    };

    fn app(id: &str, turn: &str, run: &str) -> InteractionRecord {
        InteractionRecord {
            session_id: "session".into(),
            turn_id: turn.into(),
            run_id: run.into(),
            request_id: id.into(),
            created_at: 7,
            request: InteractionRequest::ComputerApp {
                tool_use_id: "tool_app".into(),
                native_operation_id: format!("native-{id}"),
                target: GrantTarget {
                    provider_id: "computer".into(),
                    contract_id: "desktop".into(),
                    server_id: "workspace_computer".into(),
                    tool_name: "cua".into(),
                    capability: GrantCapability::ComputerUse,
                    scope: GrantScope::ComputerApp {
                        platform: ComputerAppPlatform::Macos,
                        application_id: "org.example.Editor".into(),
                    },
                },
                basis: PermissionBasis {
                    boundary_revision: 0,
                    binding: BindingStamp {
                        id: "00000000-0000-4000-8000-000000000001".parse().unwrap(),
                        permission_epoch: 0,
                    },
                },
                display: ComputerAppDisplay {
                    name: "Example Editor".into(),
                    app_path: "/Volumes/Work/Example Editor.app".into(),
                    risk: None,
                    warning: None,
                },
                allow_always: false,
                authority_revision: 0,
            },
            outcome: None,
        }
    }

    #[tokio::test]
    async fn event_log_cannot_publish_or_decide_root_application_authority() {
        let directory = tempfile::tempdir().unwrap();
        let log = crate::EventLog::open(&directory.path().join("source.sqlite"))
            .await
            .unwrap();
        assert!(matches!(
            log.establish_interaction(&app("application", "turn", "run"))
                .await,
            Err(StoreError::InvalidTransition(message))
                if message == "computer application consent is owned by the Root"
        ));
        assert!(matches!(
            log.commit_interaction_outcome(
                "application",
                InteractionOutcome::ComputerAppDecision {
                    decision: ComputerAppDecision::Once,
                    committed_at: 42,
                },
            )
            .await,
            Err(StoreError::InvalidTransition(message))
                if message == "computer application consent is owned by the Root"
        ));
        log.close().await.unwrap();
    }
}
