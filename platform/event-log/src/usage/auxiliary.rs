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

use super::{AuxiliarySource as Source, Outcome, invalid};
use crate::{EventLog, StoreError};
use maka_agent_facts::execution::ModelBinding;
use maka_agent_facts::language::Language;
use maka_agent_facts::model::ModelUsage;
use maka_plugin_core::operation::RecoveryRef;
use serde::{Deserialize, Serialize};
use sqlx::{Connection, SqliteConnection};
use std::time::SystemTime;
use uuid::Uuid;

#[derive(Serialize, Deserialize)]
pub(super) struct Admission {
    source: Source,
    binding: ModelBinding,
    session_id: Option<String>,
    started_at: SystemTime,
    #[serde(default, skip_serializing_if = "Language::is_english")]
    language: Language,
}

#[derive(Serialize)]
struct Settlement {
    request_id: Uuid,
    outcome: Outcome,
    completed_at: SystemTime,
}

#[derive(Serialize)]
struct Observation {
    request_id: Uuid,
    usage: ModelUsage,
}

impl EventLog {
    /// Called before model dispatch, after a Host SDK effect or first user opening.
    /// The source journal supplies the binding; plugins cannot invent accounting
    /// identity by supplying a Session ID or current provider configuration.
    pub async fn begin_auxiliary_model(
        &self,
        source: Source,
        language: Language,
        quote: Option<maka_agent_facts::pricing::Quote>,
    ) -> Result<Uuid, StoreError> {
        match &source {
            Source::Agent { invocation, .. } | Source::SessionTitle { invocation } => {
                self.check_bound_session(&invocation.session_id)?
            }
            _ => {}
        }
        self.admit_auxiliary_model(source, None, language, quote, true)
            .await
    }

    /// Trusted native owners supply their captured model selection only after
    /// application admission. Validate the complete original receipt before billing.
    pub async fn begin_auxiliary_operation_model(
        &self,
        reference: RecoveryRef,
        binding: ModelBinding,
        session_id: String,
        language: Language,
        quote: Option<maka_agent_facts::pricing::Quote>,
    ) -> Result<Uuid, StoreError> {
        self.operation_domain(&reference)?;
        let source = Source::ApplicationOperation {
            source: reference.source.clone(),
            namespace: reference.namespace.clone(),
            operation: reference.operation,
            fingerprint: reference.fingerprint.clone(),
        };
        self.admit_auxiliary_model(
            source,
            Some((reference, binding, session_id)),
            language,
            quote,
            true,
        )
        .await
    }

    /// RootStore supplies original dispatch custody and a live Session execution lease.
    /// Source pending/once-only facts remain transactional in this operation journal.
    pub(crate) async fn begin_bound_auxiliary_operation_model(
        &self,
        reference: RecoveryRef,
        binding: ModelBinding,
        session_id: String,
        language: Language,
        quote: Option<maka_agent_facts::pricing::Quote>,
    ) -> Result<Uuid, StoreError> {
        self.operation_domain(&reference)?;
        let source = Source::ApplicationOperation {
            source: reference.source.clone(),
            namespace: reference.namespace.clone(),
            operation: reference.operation,
            fingerprint: reference.fingerprint.clone(),
        };
        self.admit_auxiliary_model(
            source,
            Some((reference, binding, session_id)),
            language,
            quote,
            false,
        )
        .await
    }

    async fn admit_auxiliary_model(
        &self,
        source: Source,
        operation: Option<(RecoveryRef, ModelBinding, String)>,
        language: Language,
        quote: Option<maka_agent_facts::pricing::Quote>,
        local_session: bool,
    ) -> Result<Uuid, StoreError> {
        self.validate_root()?;
        let expected_session = self.expected_session.clone();
        let commits = self.commits.notice();
        self.connection
            .run(move |connection| {
                Box::pin(async move {
                    let mut tx = connection.begin_with("BEGIN IMMEDIATE").await?;
                    let (binding, session_id) = if let Some((reference, binding, session)) = operation {
                        crate::applications::operations::require_pending(&mut tx, &reference).await?;
                        if local_session { crate::sessions::removal::require_accepting(&mut tx, &session).await?; }
                        let used: bool = sqlx::query_scalar(
                            "SELECT EXISTS(SELECT 1 FROM event_log WHERE kind='auxiliary_model_started'
                             AND json_extract(event_header, '$.source') = json(?))"
                        ).bind(serde_json::to_string(&source)?).fetch_one(&mut *tx).await?;
                        if used { return Err(invalid("Application operation already attempted its auxiliary model")); }
                        (binding, Some(session))
                    } else { binding(&mut tx, &source).await? };
                    if let Some(expected) = expected_session.as_deref()
                        && session_id.as_deref() != Some(expected)
                    {
                        return Err(invalid("foreign auxiliary Session"));
                    }
                    if let Some(quote) = &quote {
                        quote.validate(&binding.model).map_err(invalid)?;
                    }
                    let commits = commits.for_sessions(session_id.iter().map(String::as_str));
                    let record = Admission {
                        source,
                        language,
                        binding,
                        session_id,
                        started_at: SystemTime::now(),
                    };
                    let id = Uuid::new_v4();
                    let sequence = insert(&mut tx, id, "auxiliary_model_started", &record).await?;
                    if let Some(quote) = &quote {
                        super::valuation::capture(&mut tx, &id.to_string(), quote).await?;
                    }
                    tx.commit().await.map_err(StoreError::CommitUnknown)?;
                    commits.publish(sequence);
                    Ok(id)
                })
            })
            .await
    }

    /// Provider-reported usage is durable even if later semantic validation fails.
    pub async fn observe_auxiliary_model(
        &self,
        id: Uuid,
        usage: ModelUsage,
    ) -> Result<(), StoreError> {
        self.validate_root()?;
        let expected_session = self.expected_session.clone();
        let commits = self.commits.notice();
        self.connection
            .run(move |connection| {
                Box::pin(async move {
                    let mut tx = connection.begin_with("BEGIN IMMEDIATE").await?;
                    let session = require_pending(&mut tx, id, expected_session.as_deref()).await?;
                    let commits = commits.for_sessions(session.iter().map(String::as_str));
                    super::valuation::value(&mut tx, &id.to_string(), &usage).await?;
                    let sequence = insert(
                        &mut tx,
                        Uuid::new_v4(),
                        "auxiliary_model_usage",
                        &Observation {
                            request_id: id,
                            usage,
                        },
                    )
                    .await?;
                    tx.commit().await.map_err(StoreError::CommitUnknown)?;
                    commits.publish(sequence);
                    Ok(())
                })
            })
            .await
    }

    pub async fn settle_auxiliary_model(
        &self,
        id: Uuid,
        outcome: Outcome,
    ) -> Result<(), StoreError> {
        self.validate_root()?;
        let expected_session = self.expected_session.clone();
        let commits = self.commits.notice();
        self.connection
            .run(move |connection| {
                Box::pin(async move {
                    let mut tx = connection.begin_with("BEGIN IMMEDIATE").await?;
                    let session = require_pending(&mut tx, id, expected_session.as_deref()).await?;
                    let commits = commits.for_sessions(session.iter().map(String::as_str));
                    let sequence = settle(&mut tx, id, outcome).await?;
                    tx.commit().await.map_err(StoreError::CommitUnknown)?;
                    commits.publish(sequence);
                    Ok(())
                })
            })
            .await
    }

    /// Exclusive Host startup only; no in-memory provider request survives its
    /// previous owner. A missing result is unknown, never free or safe to replay.
    pub async fn recover_auxiliary_models(&self) -> Result<(), StoreError> {
        self.validate_root()?;
        loop {
            let commits = self.commits.notice();
            let count = self.connection.run(move |connection| Box::pin(async move {
                let mut tx = connection.begin_with("BEGIN IMMEDIATE").await?;
                let ids: Vec<String> = sqlx::query_scalar(
                    "SELECT event_id FROM event_log started
                     WHERE kind = 'auxiliary_model_started' AND NOT EXISTS (
                        SELECT 1 FROM event_log settled WHERE settled.kind = 'auxiliary_model_settled'
                        AND json_extract(settled.event_header, '$.request_id') = started.event_id)
                     ORDER BY sequence LIMIT 128"
                ).fetch_all(&mut *tx).await?;
                let mut last = None;
                for id in &ids {
                    last = Some(settle(&mut tx, Uuid::parse_str(id)
                        .map_err(|_| invalid("invalid auxiliary request identity"))?, Outcome::Unknown).await?);
                }
                tx.commit().await.map_err(StoreError::CommitUnknown)?;
                if let Some(sequence) = last { commits.publish(sequence); }
                Ok(ids.len())
            })).await?;
            if count < 128 {
                return Ok(());
            }
        }
    }
}

async fn binding(
    connection: &mut SqliteConnection,
    source: &Source,
) -> Result<(ModelBinding, Option<String>), StoreError> {
    match source {
        Source::ApplicationOperation { .. } => Err(invalid(
            "Application auxiliary model requires its original operation",
        )),
        Source::SessionTitle { invocation } => {
            crate::sessions::removal::require_accepting(connection, &invocation.session_id).await?;
            let archived: Option<bool> =
                sqlx::query_scalar("SELECT archived FROM session_control WHERE id=?")
                    .bind(&invocation.session_id)
                    .fetch_optional(&mut *connection)
                    .await?;
            match archived {
                Some(false) => {}
                Some(true) => return Err(StoreError::SessionRetired),
                None => return Err(StoreError::SessionNotFound),
            }
            let used: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM event_log WHERE kind='auxiliary_model_started'
                 AND json_extract(event_header,'$.source.kind')='session_title'
                 AND json_extract(event_header,'$.source.invocation.session_id')=?)",
            )
            .bind(&invocation.session_id)
            .fetch_one(&mut *connection)
            .await?;
            if used {
                return Err(invalid("Session title was already attempted"));
            }

            crate::title::original_title_binding(connection, invocation)
                .await
                .map(|binding| (binding, Some(invocation.session_id.clone())))
        }
        Source::Agent {
            invocation,
            operation_id,
        } => {
            let raw: Option<String> = sqlx::query_scalar(
                "SELECT opening.event_header FROM runtime_events opening
                 JOIN runtime_events dispatch ON dispatch.invocation_id = opening.invocation_id
                 WHERE opening.kind = 'invocation_opened' AND opening.invocation_id = ?1
                 AND dispatch.kind = 'tool_dispatched' AND dispatch.operation_id = ?2
                 AND json_extract(dispatch.event_header, '$.fact.name') = 'llm.generate'
                 AND json_extract(dispatch.event_header, '$.fact.call.origin.kind') = 'host_sdk'
                 AND NOT EXISTS (SELECT 1 FROM runtime_events settled
                    WHERE (settled.kind = 'tool_settled' AND settled.operation_id = ?2)
                       OR (settled.kind = 'invocation_ended' AND settled.invocation_id = ?1))",
            )
            .bind(&invocation.invocation_id)
            .bind(operation_id)
            .fetch_optional(connection)
            .await?;
            let event: maka_agent_facts::event::RuntimeEvent = serde_json::from_str(
                &raw.ok_or_else(|| invalid("auxiliary model source is not pending"))?,
            )?;
            if event.invocation != *invocation {
                return Err(invalid("auxiliary model invocation changed"));
            }
            match event.fact {
                maka_agent_facts::event::Fact::InvocationOpened {
                    configuration: Some(config),
                    ..
                } => config
                    .model
                    .map(|binding| (binding, Some(invocation.session_id.clone())))
                    .ok_or_else(|| invalid("auxiliary model has no frozen binding")),
                _ => Err(invalid("auxiliary model has no frozen configuration")),
            }
        }
        Source::HostEffect { id } => {
            let raw: Option<String> = sqlx::query_scalar(
                "SELECT request FROM host_effects WHERE id = ? AND outcome IS NULL",
            )
            .bind(id.to_string())
            .fetch_optional(connection)
            .await?;
            let request: crate::effects::Request = serde_json::from_str(
                &raw.ok_or_else(|| invalid("auxiliary Host effect is not pending"))?,
            )?;
            let session = match request.boundary {
                maka_capabilities::authorization::Boundary::Session { boundary, .. } => {
                    Some(boundary.session_id)
                }
                _ => None,
            };
            match request.operation {
                crate::effects::Operation::Model { model, .. } => Ok((model, session)),
                _ => Err(invalid("Host effect is not a model operation")),
            }
        }
    }
}

async fn require_pending(
    connection: &mut SqliteConnection,
    id: Uuid,
    expected_session: Option<&str>,
) -> Result<Option<String>, StoreError> {
    // Membership and pending status are checked together, in the same transaction
    // that observes/settles this private source admission.
    let session: Option<Option<String>> = sqlx::query_scalar(
        "SELECT json_extract(event_header, '$.session_id') FROM event_log
         WHERE event_id = ?1 AND kind = 'auxiliary_model_started'
         AND (?2 IS NULL OR json_extract(event_header, '$.session_id') = ?2)
         AND NOT EXISTS(SELECT 1 FROM event_log WHERE kind = 'auxiliary_model_settled'
             AND json_extract(event_header, '$.request_id') = ?1)",
    )
    .bind(id.to_string())
    .bind(expected_session)
    .fetch_optional(connection)
    .await?;
    session.ok_or_else(|| invalid("auxiliary model request is not pending"))
}

async fn settle(
    connection: &mut SqliteConnection,
    id: Uuid,
    outcome: Outcome,
) -> Result<u64, StoreError> {
    let sequence = insert(
        &mut *connection,
        Uuid::new_v4(),
        "auxiliary_model_settled",
        &Settlement {
            request_id: id,
            outcome,
            completed_at: SystemTime::now(),
        },
    )
    .await?;
    crate::root_store::usage_meter::settle_auxiliary(connection, id).await?;
    Ok(sequence)
}

async fn insert(
    connection: &mut SqliteConnection,
    id: Uuid,
    kind: &str,
    record: &impl Serialize,
) -> Result<u64, StoreError> {
    let event_id = id.to_string();
    let json = serde_json::to_string(record)?;
    let inserted = crate::canonical_insert::insert(crate::canonical_insert::Record {
        sequence: None,
        event_id: &event_id,
        invocation_id: None,
        kind,
        operation_id: None,
        json: &json,
    })
    .execute(connection)
    .await?;
    crate::sequence_number(inserted.last_insert_rowid())
}
