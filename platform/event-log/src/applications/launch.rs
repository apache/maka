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

//! Root-owned native launcher selection. Opaque preparation is discarded on completion.
use super::invalid;
use crate::{EventLog, StoreError};
use serde_json::Value;
use sqlx::{Connection, Row};
use uuid::Uuid;

pub struct Launch {
    pub deployment: Uuid,
    pub configuration: Value,
    pub pending: Option<Vec<u8>>,
}
impl EventLog {
    /// Trusted Host configuration changes are separate from source replacement.
    /// Check both authorities in one transaction; the same desired value is an
    /// idempotent retry only while the observed source is still exactly current.
    pub async fn compare_and_set_application_launch_configuration(
        &self,
        source: maka_plugin_core::deployment::DeploymentRef,
        expected: Value,
        configuration: Value,
    ) -> Result<bool, StoreError> {
        source.validate().map_err(|error| invalid(&error))?;
        if source.state_domain != self.application_domain()? {
            return Err(invalid("foreign Host configuration source"));
        }
        let expected = serde_json::to_string(&expected)?;
        let configuration = serde_json::to_string(&configuration)?;
        self.connection.run(move |connection| Box::pin(async move {
            let mut tx = connection.begin_with("BEGIN IMMEDIATE").await?;
            let changed = sqlx::query("UPDATE application_launch SET configuration=? WHERE singleton=1 AND deployment=? AND pending IS NULL AND (configuration=? OR configuration=?) AND EXISTS(SELECT 1 FROM application_deployments WHERE id=? AND revision=?)")
                .bind(&configuration).bind(source.deployment.to_string())
                .bind(expected).bind(&configuration)
                .bind(source.deployment.to_string()).bind(source.revision as i64)
                .execute(&mut *tx).await?.rows_affected() == 1;
            tx.commit().await.map_err(StoreError::CommitUnknown)?;
            Ok(changed)
        })).await
    }

    pub async fn application_launch(&self) -> Result<Option<Launch>, StoreError> {
        self.application_domain()?;
        self.connection.run(|connection| Box::pin(async move {
            let row = sqlx::query("SELECT deployment, configuration, pending FROM application_launch WHERE singleton=1")
                .fetch_optional(connection).await?;
            let Some(row) = row else { return Ok(None); };
            let deployment = Uuid::parse_str(&row.try_get::<String, _>("deployment")?).map_err(|_| invalid("invalid launcher deployment"))?;
            let configuration = row.try_get::<String, _>("configuration")?;
            let pending = row.try_get::<Option<Vec<u8>>, _>("pending")?;
            if deployment.is_nil() || pending.as_ref().is_some_and(Vec::is_empty) {
                return Err(invalid("invalid launcher preparation"));
            }
            Ok(Some(Launch { deployment, configuration: serde_json::from_str(&configuration)?, pending }))
        })).await
    }

    /// Select an existing committed source without starting source preparation.
    /// The observed source must still be current, and an existing selection is
    /// never overwritten.
    pub async fn select_committed_application_launch(
        &self,
        source: maka_plugin_core::deployment::DeploymentRef,
        configuration: Value,
    ) -> Result<(), StoreError> {
        source.validate().map_err(|error| invalid(&error))?;
        if source.state_domain != self.application_domain()? {
            return Err(invalid("foreign launcher source"));
        }
        let configuration = serde_json::to_string(&configuration)?;
        self.connection.run(move |connection| Box::pin(async move {
            let mut tx = connection.begin_with("BEGIN IMMEDIATE").await?;
            let changed = sqlx::query("INSERT INTO application_launch (singleton,deployment,configuration,pending) SELECT 1,id,?,NULL FROM application_deployments WHERE id=? AND revision=?")
                .bind(configuration).bind(source.deployment.to_string()).bind(source.revision as i64)
                .execute(&mut *tx).await?.rows_affected();
            if changed != 1 { return Err(invalid("committed launcher source changed or is missing")); }
            tx.commit().await.map_err(StoreError::CommitUnknown)
        })).await
    }

    /// Create once, before any cross-Root source effects. An unknown COMMIT
    /// remains unknown; reopening reads this same record instead of reauthoring.
    pub async fn begin_application_launch(&self, launch: Launch) -> Result<(), StoreError> {
        self.application_domain()?;
        let configuration = serde_json::to_string(&launch.configuration)?;
        let pending = launch
            .pending
            .ok_or_else(|| invalid("launcher preparation required"))?;
        if launch.deployment.is_nil() || pending.is_empty() {
            return Err(invalid("invalid launcher preparation"));
        }
        self.connection.run(move |connection| Box::pin(async move {
            let mut tx = connection.begin_with("BEGIN IMMEDIATE").await?;
            sqlx::query("INSERT INTO application_launch (singleton,deployment,configuration,pending) VALUES (1,?,?,?)")
                .bind(launch.deployment.to_string()).bind(configuration).bind(pending).execute(&mut *tx).await?;
            tx.commit().await.map_err(StoreError::CommitUnknown)
        })).await
    }

    /// Prepare restoration while holding the application Root. The original connection
    /// authority stays fixed; reopening resumes the exact saved source writes.
    pub async fn begin_application_restore(
        &self,
        deployment: Uuid,
        pending: Vec<u8>,
    ) -> Result<(), StoreError> {
        self.application_domain()?;
        if pending.is_empty() {
            return Err(invalid("invalid or oversized restoration preparation"));
        }
        self.connection.run(move |connection| Box::pin(async move {
            let mut tx = connection.begin_with("BEGIN IMMEDIATE").await?;
            let changed = sqlx::query("UPDATE application_launch SET pending=? WHERE singleton=1 AND deployment=? AND pending IS NULL")
                .bind(pending).bind(deployment.to_string()).execute(&mut *tx).await?.rows_affected();
            if changed != 1 { return Err(invalid("launcher changed or already has unfinished work")); }
            tx.commit().await.map_err(StoreError::CommitUnknown)
        })).await
    }

    /// Called by the trusted launcher after its original source commits have
    /// been confirmed. Never changes an application head or connection input.
    pub async fn complete_application_launch(&self, deployment: Uuid) -> Result<(), StoreError> {
        self.application_domain()?;
        self.connection.run(move |connection| Box::pin(async move {
            let mut tx = connection.begin_with("BEGIN IMMEDIATE").await?;
            let changed = sqlx::query("UPDATE application_launch SET pending=NULL WHERE singleton=1 AND deployment=?")
                .bind(deployment.to_string()).execute(&mut *tx).await?.rows_affected();
            if changed != 1 { return Err(invalid("launcher selection changed")); }
            tx.commit().await.map_err(StoreError::CommitUnknown)
        })).await
    }
}

#[cfg(test)]
mod tests;
