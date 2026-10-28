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
use maka_agent_facts::interaction::InteractionRequest;
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
    let local = read_from(connection, request_id, expected_session, false).await?;
    let root = read_from(connection, request_id, expected_session, true).await?;
    match (local, root) {
        (Some(_), Some(_)) => Err(invalid(
            "interaction identity exists in multiple authorities",
        )),
        (Some(record), None) | (None, Some(record)) => Ok(Some(record)),
        (None, None) => Ok(None),
    }
}

pub(crate) async fn read_local(
    connection: &mut sqlx::SqliteConnection,
    request_id: &str,
) -> Result<Option<InteractionRecord>, StoreError> {
    read_from(connection, request_id, None, false).await
}

async fn read_from(
    connection: &mut sqlx::SqliteConnection,
    request_id: &str,
    expected_session: Option<&str>,
    root: bool,
) -> Result<Option<InteractionRecord>, StoreError> {
    let sql = if root {
        "SELECT request.session_id, request.created_at, request.record_json, outcome.outcome_json
         FROM root_app_requests AS request LEFT JOIN root_app_outcomes AS outcome
         ON outcome.request_id = request.request_id WHERE request.request_id = ?
         AND (? IS NULL OR request.session_id = ?)"
    } else {
        "SELECT request.session_id, request.created_at, request.record_json, outcome.outcome_json
         FROM interaction_requests AS request LEFT JOIN interaction_outcomes AS outcome
         ON outcome.request_id = request.request_id WHERE request.request_id = ?
         AND (? IS NULL OR request.session_id = ?)"
    };
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
    if root && !matches!(record.request, InteractionRequest::ComputerApp { .. }) {
        return Err(invalid(
            "Root interaction is not computer application consent",
        ));
    }
    Ok(Some(record))
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_agent_facts::{
        event::Invocation,
        interaction::{
            ClosureReason, ComputerAppDecision, ComputerAppDisplay, ComputerAppPlatform,
            GrantCapability, GrantScope,
        },
        workspace::{BindingStamp, PermissionBasis},
    };
    use sqlx::sqlite::SqliteConnectOptions;
    use sqlx::{Connection, SqliteConnection};

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

    fn local(id: &str, turn: &str, run: &str) -> InteractionRecord {
        let mut record = app(id, turn, run);
        record.request = InteractionRequest::ServiceApproval {
            tool_use_id: "tool_service".into(),
            tool_name: "service_tool".into(),
            service: "fixture".into(),
            method: "run".into(),
            binding: "binding".into(),
            through: 1,
        };
        record
    }

    async fn fixture() -> (tempfile::TempDir, SqliteConnection, SqliteConnection) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("control.sqlite");
        let mut root = SqliteConnection::connect_with(
            &SqliteConnectOptions::new()
                .filename(&path)
                .create_if_missing(true),
        )
        .await
        .unwrap();
        crate::schema::initialize_connection(&mut root)
            .await
            .unwrap();
        let control = crate::connection::control::ReadOnlyControl::new(&path).unwrap();
        let mut source = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        crate::schema::initialize_connection_with_control(&mut source, Some(&control))
            .await
            .unwrap();
        (directory, root, source)
    }

    async fn insert(connection: &mut SqliteConnection, record: &InteractionRecord) {
        sqlx::query("INSERT INTO interaction_requests VALUES(?,?,?,?)")
            .bind(&record.request_id)
            .bind(&record.session_id)
            .bind(record.created_at as i64)
            .bind(encode(record).unwrap())
            .execute(connection)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn merged_read_preserves_source_outcomes_scope_and_refuses_ambiguous_identity() {
        let (_directory, mut root, mut source) = fixture().await;
        let mut application = app("application", "turn", "run");
        let mut service = local("service", "turn", "run");
        service.created_at = 3;
        insert(&mut root, &application).await;
        insert(&mut source, &service).await;
        assert_eq!(
            super::super::pending(&mut source, "session").await.unwrap(),
            [service.clone(), application.clone()]
        );
        assert_eq!(
            read_scoped(&mut source, "application", Some("other_session"))
                .await
                .unwrap(),
            None
        );
        assert_eq!(read_local(&mut source, "application").await.unwrap(), None);
        let once = InteractionOutcome::ComputerAppDecision {
            decision: ComputerAppDecision::Once,
            committed_at: 42,
        };
        sqlx::query("INSERT INTO interaction_outcomes VALUES(?,?)")
            .bind("application")
            .bind(encode(&once).unwrap())
            .execute(&mut root)
            .await
            .unwrap();
        application.outcome = Some(once.clone());
        assert_eq!(
            read_scoped(&mut source, "application", Some("session"))
                .await
                .unwrap(),
            Some(application)
        );
        assert_eq!(
            super::super::pending(&mut source, "session").await.unwrap(),
            [service]
        );
        let conflicting = local("application", "turn", "run");
        insert(&mut source, &conflicting).await;
        assert_eq!(
            read_local(&mut source, "application").await.unwrap(),
            Some(conflicting)
        );
        assert!(matches!(
            read_scoped(&mut source, "application", Some("session")).await,
            Err(StoreError::InvalidTransition(message))
                if message == "interaction identity exists in multiple authorities"
        ));
        assert!(equivalent(
            &once,
            &InteractionOutcome::ComputerAppDecision {
                decision: ComputerAppDecision::Once,
                committed_at: 43,
            }
        ));
        assert!(!equivalent(
            &once,
            &InteractionOutcome::ComputerAppDecision {
                decision: ComputerAppDecision::Session,
                committed_at: 42,
            }
        ));
        source.close().await.unwrap();
        root.close().await.unwrap();
    }

    #[tokio::test]
    async fn source_closure_stays_local_and_root_pending_blocks_only_the_exact_run() {
        let (_directory, mut root, mut source) = fixture().await;
        let invocation = Invocation {
            session_id: "session".into(),
            turn_id: "turn".into(),
            run_id: "run".into(),
            invocation_id: "invocation".into(),
        };
        insert(&mut source, &local("service", "turn", "run")).await;
        insert(&mut root, &app("application", "turn", "run")).await;
        insert(&mut root, &app("other_run", "turn", "other_run")).await;
        insert(&mut root, &app("other_turn", "other_turn", "run")).await;
        let closure = InteractionOutcome::Closure {
            reason: ClosureReason::TurnTerminal,
            committed_at: 42,
        };
        let lifecycle = super::super::lifecycle::close_in_transaction;
        assert_eq!(
            lifecycle(&mut source, Some(&invocation), &closure)
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            read_local(&mut source, "service")
                .await
                .unwrap()
                .unwrap()
                .outcome,
            Some(closure.clone())
        );
        assert_eq!(
            read_local(&mut root, "application")
                .await
                .unwrap()
                .unwrap()
                .outcome,
            None
        );
        assert!(matches!(
            super::super::lifecycle::require_closed(&mut source, &invocation).await,
            Err(StoreError::InvalidTransition(message))
                if message == "cannot seal a Run with pending interactions"
        ));
        assert_eq!(
            lifecycle(&mut root, Some(&invocation), &closure)
                .await
                .unwrap(),
            1
        );
        super::super::lifecycle::require_closed(&mut source, &invocation)
            .await
            .unwrap();
        assert_eq!(lifecycle(&mut source, None, &closure).await.unwrap(), 0);
        for id in ["other_run", "other_turn"] {
            assert_eq!(
                read_scoped(&mut source, id, None)
                    .await
                    .unwrap()
                    .unwrap()
                    .outcome,
                None
            );
        }
        source.close().await.unwrap();
        root.close().await.unwrap();
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
