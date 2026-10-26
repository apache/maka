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

//! Opaque native UI snapshots, scoped to an actual persisted UI instance.
use super::invalid;
use crate::{EventLog, StoreError};
use maka_plugin_core::{
    composition::{ExecutionLocation, InstanceId},
    deployment::DeploymentRef,
};
use serde_json::Value;
use sqlx::{Connection, Row};
use std::sync::{Arc, Weak};

const MAX_REVISION: u64 = (1 << 53) - 1;

#[derive(Clone, Debug, PartialEq)]
pub struct Checkpoint {
    pub revision: u64,
    pub format: String,
    pub data_source: Value,
    pub metadata: Value,
    pub content: Vec<u8>,
}
/// This capability comes from a checked original source, never guest JSON.
/// Idle capabilities retain no SQL or Root authority; accepted calls retain it.
#[derive(Clone)]
pub struct Checkpoints {
    store: Weak<EventLog>,
    stop: Option<tokio_util::sync::CancellationToken>,
    deployment: String,
    instance: String,
}
fn key_valid(key: &str) -> Result<(), StoreError> {
    if key.is_empty() || key.chars().any(char::is_control) {
        return Err(invalid("invalid UI checkpoint key"));
    }
    Ok(())
}
impl EventLog {
    pub async fn ui_checkpoints(
        self: &Arc<Self>,
        source: &DeploymentRef,
        instance: &InstanceId,
    ) -> Result<Checkpoints, StoreError> {
        let loaded = self
            .load_application_at(source)
            .await?
            .ok_or_else(|| invalid("original UI checkpoint source missing"))?;
        self.ui_checkpoints_from(&loaded.snapshot(), instance)
    }

    pub fn ui_checkpoints_from(
        self: &Arc<Self>,
        source: &super::SourceSnapshot,
        instance: &InstanceId,
    ) -> Result<Checkpoints, StoreError> {
        source.check(self, instance)?;
        if source.location() != ExecutionLocation::Ui {
            return Err(invalid("UI checkpoints require a UI deployment"));
        }
        Ok(Checkpoints {
            store: Arc::downgrade(self),
            stop: None,
            deployment: source.reference().deployment.to_string(),
            instance: serde_json::to_string(instance)?,
        })
    }
}
impl Checkpoints {
    pub(crate) fn with_shutdown(mut self, stop: tokio_util::sync::CancellationToken) -> Self {
        self.stop = Some(stop);
        self
    }
    fn owner(&self) -> Result<Arc<EventLog>, StoreError> {
        if self.stop.as_ref().is_some_and(|stop| stop.is_cancelled()) {
            return Err(StoreError::ConnectionClosed);
        }
        self.store.upgrade().ok_or(StoreError::ConnectionClosed)
    }

    /// Admit all stored encoded fields before fetching them. The callback
    /// and payload read share one SQLite snapshot; its token follows the result.
    pub async fn read<T: Send + 'static>(
        &self,
        key: &str,
        admit: impl FnOnce(usize) -> Result<T, StoreError> + Send + 'static,
    ) -> Result<Option<(Checkpoint, T)>, StoreError> {
        key_valid(key)?;
        let store = self.owner()?;
        store.validate_root()?;
        let deployment = self.deployment.clone();
        let instance = self.instance.clone();
        let key = key.to_owned();
        store.connection.run(move |connection| Box::pin(async move {
            let mut tx = connection.begin().await?;
            let lengths: Option<(i64, i64, i64, i64)> = sqlx::query_as("SELECT length(CAST(content AS BLOB)), length(CAST(format AS BLOB)), length(CAST(data_source_json AS BLOB)), length(CAST(metadata_json AS BLOB)) FROM application_ui_checkpoints WHERE deployment=? AND instance=? AND key=?")
                .bind(&deployment).bind(&instance).bind(&key).fetch_optional(&mut *tx).await?;
            let Some((content_length, format_length, source_length, metadata_length)) = lengths else {
                tx.commit().await?;
                return Ok(None);
            };
            let mut total = 0_usize;
            for length in [content_length, format_length, source_length, metadata_length] {
                let length = usize::try_from(length).map_err(|_| invalid("invalid UI checkpoint field length"))?;
                total = total.checked_add(length).ok_or_else(|| invalid("UI checkpoint size overflow"))?;
            }
            let content_length = usize::try_from(content_length).map_err(|_| invalid("invalid UI checkpoint content length"))?;
            let token = admit(total)?;
            let row = sqlx::query("SELECT revision, format, data_source_json AS source, metadata_json AS metadata, content
                FROM application_ui_checkpoints WHERE deployment=? AND instance=? AND key=?")
                .bind(deployment).bind(instance).bind(key).fetch_one(&mut *tx).await?;
            let revision: i64 = row.try_get("revision")?;
            if !(1..=MAX_REVISION as i64).contains(&revision) { return Err(invalid("invalid UI checkpoint revision")); }
            let format: String = row.try_get("format")?;
            if format.is_empty() { return Err(invalid("invalid UI checkpoint format")); }
            let data_source = serde_json::from_str(&row.try_get::<String, _>("source")?).map_err(|error| invalid(format!("invalid UI checkpoint source: {error}")))?;
            let metadata = serde_json::from_str(&row.try_get::<String, _>("metadata")?).map_err(|error| invalid(format!("invalid UI checkpoint metadata: {error}")))?;
            let content: Vec<u8> = row.try_get("content")?;
            if content.len() != content_length { return Err(invalid("UI checkpoint content length changed")); }
            tx.commit().await?;
            Ok(Some((Checkpoint { revision: revision as u64, format, data_source, metadata, content }, token)))
        })).await
    }

    /// Empty snapshots remain CAS tombstones; a stale writer cannot recreate a
    /// deleted key after another mount has already saved and cleared it.
    pub async fn write(
        &self,
        key: &str,
        expected: Option<u64>,
        format: &str,
        data_source: &Value,
        metadata: &Value,
        content: Vec<u8>,
    ) -> Result<u64, StoreError> {
        key_valid(key)?;
        let store = self.owner()?;
        store.validate_root()?;
        if format.is_empty() || expected.is_some_and(|value| value == 0 || value >= MAX_REVISION) {
            return Err(invalid("invalid UI checkpoint"));
        }
        let source = serde_json::to_string(data_source)?;
        let metadata = serde_json::to_string(metadata)?;
        let deployment = self.deployment.clone();
        let instance = self.instance.clone();
        let key = key.to_owned();
        let format = format.to_owned();
        store.connection.run(move |connection| Box::pin(async move {
            let mut tx = connection.begin_with("BEGIN IMMEDIATE").await?;
            let current: Option<(i64, Option<String>, Option<String>)> = sqlx::query_as("SELECT revision, format, data_source_json FROM application_ui_checkpoints WHERE deployment=? AND instance=? AND key=?")
                .bind(&deployment).bind(&instance).bind(&key).fetch_optional(&mut *tx).await?;
            let actual = current.as_ref().map(|row| row.0 as u64);
            if actual != expected { return Err(StoreError::RevisionConflict {
                expected: expected.map_or_else(|| "absent".into(), |revision| revision.to_string()),
                actual: actual.map_or_else(|| "absent".into(), |revision| revision.to_string()),
            }); }
            if current.is_some_and(|(_, previous_format, previous_source)| previous_format.as_deref() != Some(format.as_str()) || previous_source.as_deref() != Some(source.as_str())) {
                return Err(invalid("UI checkpoint format or data source changed"));
            }
            let revision = actual.unwrap_or(0) + 1;
            sqlx::query("INSERT INTO application_ui_checkpoints (deployment,instance,key,revision,format,data_source_json,metadata_json,content) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(deployment,instance,key) DO UPDATE SET revision=excluded.revision,metadata_json=excluded.metadata_json,content=excluded.content")
                .bind(deployment).bind(instance).bind(key).bind(revision as i64).bind(format).bind(source).bind(metadata).bind(content).execute(&mut *tx).await?;
            tx.commit().await.map_err(StoreError::CommitUnknown)?;
            Ok(revision)
        })).await
    }
}

#[cfg(test)]
mod tests;
