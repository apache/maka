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

//! Caller-owned original references. These records do not assert business journal facts.
use super::invalid;
use crate::{EventLog, StoreError, root::RootOwner};
use maka_plugin_core::{
    composition::InstanceId, deployment::DeploymentRef, operation::RecoveryRef,
};
use serde::{Deserialize, Serialize};
use sqlx::{Connection, Row, SqliteConnection};
use std::sync::Arc;
use uuid::Uuid;

const MAX_PAGE: usize = 1024 * 1024;

/// Caller-owned correlation only; no business outcome or execution authority.
pub fn validate_recovery(value: &serde_json::Value) -> Result<(), StoreError> {
    serde_json::to_string(value)
        .map(|_| ())
        .map_err(StoreError::from)
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CallerIntent {
    pub cursor: u64,
    pub caller: DeploymentRef,
    pub consumer: InstanceId,
    pub reference: RecoveryRef,
    #[serde(default, skip_serializing_if = "serde_json::Value::is_null")]
    pub recovery: serde_json::Value,
}
/// Peer attestation excludes caller-local recovery data. The receiving Host
/// still requires its private admission evidence; this is not a commit token.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CallerConfirmation {
    pub cursor: u64,
    pub caller: DeploymentRef,
    pub consumer: InstanceId,
    pub reference: RecoveryRef,
}
impl CallerIntent {
    /// Checks a bounded observation's shape, not whether a caller committed it.
    /// Deserialized observations are never `RecordedIntent` or effect authority.
    pub fn validate(&self) -> Result<(), StoreError> {
        self.confirmation().validate()?;
        validate_recovery(&self.recovery)?;
        Ok(())
    }
    pub fn confirmation(&self) -> CallerConfirmation {
        CallerConfirmation {
            cursor: self.cursor,
            caller: self.caller.clone(),
            consumer: self.consumer.clone(),
            reference: self.reference.clone(),
        }
    }
}
impl CallerConfirmation {
    pub fn validate(&self) -> Result<(), StoreError> {
        if self.cursor == 0 || self.cursor > i64::MAX as u64 {
            return Err(invalid("invalid caller intent cursor"));
        }
        self.caller.validate().map_err(invalid)?;
        consumer_valid(&self.consumer)?;
        self.reference
            .validate()
            .map_err(|e| invalid(e.to_string()))?;
        Ok(())
    }
}
/// Only a confirmed caller commit constructs this token. It grants no Host authority.
/// Accepted executors retain it through real cleanup, independently of the waiter.
pub struct RecordedIntent {
    intent: CallerIntent,
    _owner: Arc<RootOwner>,
}
impl RecordedIntent {
    pub fn intent(&self) -> &CallerIntent {
        &self.intent
    }
}
fn consumer_valid(consumer: &InstanceId) -> Result<(), StoreError> {
    consumer
        .validate()
        .map_err(|error| invalid(error.to_string()))
}

async fn read(
    connection: &mut SqliteConnection,
    domain: &str,
    deployment: Uuid,
    consumer: &InstanceId,
    operation: Uuid,
) -> Result<Option<CallerIntent>, StoreError> {
    let row = sqlx::query("SELECT cursor, source_revision, reference_json, recovery_json FROM application_intents WHERE deployment=? AND consumer=? AND operation=?")
        .bind(deployment.to_string()).bind(serde_json::to_string(consumer)?).bind(operation.to_string()).fetch_optional(connection).await?;
    row.map(|row| {
        let reference: RecoveryRef =
            serde_json::from_str(&row.try_get::<String, _>("reference_json")?)?;
        let recovery = serde_json::from_str(&row.try_get::<String, _>("recovery_json")?)?;
        reference.validate().map_err(|e| invalid(e.to_string()))?;
        if reference.operation != operation {
            return Err(StoreError::EventConflict);
        }
        let caller = DeploymentRef {
            state_domain: domain.into(),
            deployment,
            revision: row.try_get::<i64, _>("source_revision")? as u64,
        };
        caller.validate().map_err(invalid)?;
        let cursor = row.try_get::<i64, _>("cursor")?;
        if cursor <= 0 {
            return Err(invalid("invalid caller intent cursor"));
        }
        Ok(CallerIntent {
            cursor: cursor as u64,
            caller,
            consumer: consumer.clone(),
            reference,
            recovery,
        })
    })
    .transpose()
}
impl EventLog {
    /// Exact caller correlation across source revisions. This is an observation,
    /// never a dispatch token or permission to retry an absent operation.
    pub async fn application_intent(
        &self,
        deployment: Uuid,
        consumer: InstanceId,
        operation: Uuid,
    ) -> Result<Option<CallerIntent>, StoreError> {
        let domain = self.application_domain()?;
        consumer_valid(&consumer)?;
        if deployment.is_nil() || operation.is_nil() {
            return Err(invalid("invalid caller intent identity"));
        }
        self.connection
            .run(move |connection| {
                Box::pin(async move {
                    read(connection, &domain, deployment, &consumer, operation).await
                })
            })
            .await
    }

    /// Commit the exact original reference before dispatch. An unknown commit gives
    /// no token and cannot authorize sending; lookup only returns observation data.
    pub async fn record_application_intent(
        &self,
        caller: DeploymentRef,
        consumer: InstanceId,
        reference: RecoveryRef,
        recovery: serde_json::Value,
    ) -> Result<RecordedIntent, StoreError> {
        consumer_valid(&consumer)?;
        reference.validate().map_err(|e| invalid(e.to_string()))?;
        validate_recovery(&recovery)?;
        let loaded = self
            .load_application_at(&caller)
            .await?
            .ok_or_else(|| invalid("original caller source missing"))?;
        self.record_application_intent_from(&loaded.snapshot(), consumer, reference, recovery)
            .await
    }

    /// Reuse the immutable original caller evidence retained by an executor.
    /// Actual service admission and confirmed SQL persistence are still required.
    pub async fn record_application_intent_from(
        &self,
        source: &super::SourceSnapshot,
        consumer: InstanceId,
        reference: RecoveryRef,
        recovery: serde_json::Value,
    ) -> Result<RecordedIntent, StoreError> {
        consumer_valid(&consumer)?;
        source.check(self, &consumer)?;
        let caller = source.reference().clone();
        reference.validate().map_err(|e| invalid(e.to_string()))?;
        let encoded = serde_json::to_string(&reference)?;
        let encoded_recovery = serde_json::to_string(&recovery)?;
        let domain = self.application_domain()?;
        let owner = self.root_owner.as_ref().expect("owned caller Root").clone();
        let commits = self.commits.notice();
        self.connection
            .write(
                WriteIntent {
                    domain,
                    caller,
                    consumer,
                    reference,
                    recovery,
                    encoded,
                    encoded_recovery,
                    owner,
                },
                commits,
            )
            .await
    }
    /// Read original caller history across source revisions. The count limit is
    /// an upper bound; the complete JSON array also fits 1 MiB. Continue after
    /// the last returned cursor. Never returns an execution token.
    pub async fn application_intents(
        &self,
        deployment: Uuid,
        consumer: InstanceId,
        after: u64,
        limit: usize,
    ) -> Result<Vec<CallerIntent>, StoreError> {
        consumer_valid(&consumer)?;
        self.application_intent_page(deployment, Some(consumer), after, limit)
            .await
    }

    /// Trusted caller-deployment observation. The native capability adapter
    /// separately grants this scope; returned references never authorize effects.
    pub async fn application_deployment_intents(
        &self,
        deployment: Uuid,
        after: u64,
        limit: usize,
    ) -> Result<Vec<CallerIntent>, StoreError> {
        self.application_intent_page(deployment, None, after, limit)
            .await
    }

    async fn application_intent_page(
        &self,
        deployment: Uuid,
        consumer: Option<InstanceId>,
        after: u64,
        limit: usize,
    ) -> Result<Vec<CallerIntent>, StoreError> {
        let domain = self.application_domain()?;
        if deployment.is_nil() || after > i64::MAX as u64 || !(1..=128).contains(&limit) {
            return Err(invalid("invalid caller intent page"));
        }
        self.connection.run(move |connection| Box::pin(async move {
            let mut tx = connection.begin().await?;
            let mut query = sqlx::QueryBuilder::new("SELECT CASE WHEN length(CAST(operation AS BLOB)) = 36 THEN operation END AS operation, consumer FROM application_intents WHERE deployment=");
            query.push_bind(deployment.to_string());
            if let Some(consumer) = &consumer { query.push(" AND consumer=").push_bind(serde_json::to_string(consumer)?); }
            query.push(" AND cursor>").push_bind(after as i64).push(" ORDER BY cursor LIMIT ").push_bind(limit as i64);
            let operations = query.build().fetch_all(&mut *tx).await?;
            let mut intents = Vec::with_capacity(operations.len());
            let mut bytes = 2; // The complete array, including brackets and commas.
            for row in operations {
                let operation = row.try_get::<Option<String>, _>("operation")?.ok_or_else(|| invalid("invalid caller operation"))?;
                let consumer: InstanceId = serde_json::from_str(&row.try_get::<Option<String>, _>("consumer")?.ok_or_else(|| invalid("invalid caller consumer"))?)?;
                consumer_valid(&consumer)?;
                let intent = read(&mut tx,&domain,deployment,&consumer,Uuid::parse_str(&operation).map_err(|_| invalid("invalid caller operation"))?).await?.ok_or_else(|| invalid("caller intent disappeared"))?;
                let encoded = serde_json::to_string(&intent)?;
                let size = encoded.len() + usize::from(!intents.is_empty());
                if !intents.is_empty() && size > MAX_PAGE.saturating_sub(bytes) { break; }
                bytes += size;
                intents.push(intent);
            }
            tx.commit().await?;
            Ok(intents)
        })).await
    }
}

#[cfg(test)]
mod tests;

pub(crate) struct WriteIntent {
    domain: String,
    caller: DeploymentRef,
    consumer: InstanceId,
    reference: RecoveryRef,
    recovery: serde_json::Value,
    encoded: String,
    encoded_recovery: String,
    owner: Arc<RootOwner>,
}
pub(crate) struct IntentValue {
    intent: CallerIntent,
    owner: Arc<RootOwner>,
}
impl crate::writeback::Statement for WriteIntent {
    type Value = IntentValue;
    type Output = RecordedIntent;
    fn execute(
        self,
        connection: &mut SqliteConnection,
    ) -> crate::connection::BoxFuture<'_, Result<crate::writeback::Prepared<Self::Value>, StoreError>>
    {
        Box::pin(async move {
            let Self {
                domain,
                caller,
                consumer,
                reference,
                recovery,
                encoded,
                encoded_recovery,
                owner,
            } = self;
            let old = read(
                connection,
                &domain,
                caller.deployment,
                &consumer,
                reference.operation,
            )
            .await?;
            let changed = old.is_none();
            let intent = if let Some(old) = old {
                if old.reference != reference || old.recovery != recovery {
                    return Err(StoreError::EventConflict);
                }
                // The first source and original reference survive later caller updates.
                old
            } else {
                super::operations::require_source(connection, &caller).await?;
                let result = sqlx::query("INSERT INTO application_intents (deployment,consumer,operation,source_revision,reference_json,recovery_json) VALUES (?,?,?,?,?,?)")
                    .bind(caller.deployment.to_string()).bind(serde_json::to_string(&consumer)?).bind(reference.operation.to_string()).bind(caller.revision as i64).bind(encoded).bind(encoded_recovery).execute(&mut *connection).await?;
                CallerIntent {
                    cursor: result.last_insert_rowid() as u64,
                    caller,
                    consumer,
                    reference,
                    recovery,
                }
            };
            Ok(crate::writeback::Prepared {
                value: IntentValue { intent, owner },
                changed,
                notification: crate::writeback::Notification::Metadata,
            })
        })
    }
    fn committed(IntentValue { intent, owner }: Self::Value) -> Self::Output {
        RecordedIntent {
            intent,
            _owner: owner,
        }
    }
    fn isolated_rejection(error: &StoreError) -> bool {
        matches!(
            error,
            StoreError::EventConflict | StoreError::InvalidTransition(_)
        )
    }
}
