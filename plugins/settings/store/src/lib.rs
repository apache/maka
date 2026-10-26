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

//! Root-owned connection catalog and credential vault. These are control
//! authorities, never model history, and their public revisions are independent.
pub mod access;
mod catalog;
mod changes;
pub mod connection_summaries;
pub mod connection_test;
mod database;
mod effect_snapshot;
pub mod language;
mod mcp_trust;
pub use effect_snapshot::ConnectionObservation;
pub mod model_catalog;
pub mod model_fetch;
pub mod network;
pub mod oauth;
pub mod onboarding;
pub mod plugin_authorization;
mod plugin_credentials;
mod policy;
pub mod pricing;
pub mod projection;
pub mod public_catalog;
mod vault;

pub use maka_event_log::connection::BoxFuture;
use maka_event_log::{StoreError, connection::OwnedConnection, root::RootOwner};
use sqlx::{Connection, SqliteConnection};
use std::sync::Arc;

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("invalid configuration: {0}")]
    Invalid(String),
    #[error("unsupported configuration database")]
    UnsupportedDatabase,
    #[error("configuration commit outcome is unknown")]
    CommitUnknown,
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Sqlx(#[from] sqlx::Error),
    #[error(transparent)]
    Migration(#[from] sqlx::migrate::MigrateError),
    #[error(transparent)]
    Store(StoreError),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

pub type Result<T> = std::result::Result<T, ConfigError>;

impl From<StoreError> for ConfigError {
    fn from(error: StoreError) -> Self {
        match error {
            StoreError::OperationUnknown | StoreError::CommitUnknown(_) => Self::CommitUnknown,
            StoreError::UnsupportedDatabase => Self::UnsupportedDatabase,
            StoreError::Sqlx(error) => Self::Sqlx(error),
            StoreError::Migration(error) => Self::Migration(error),
            StoreError::Io(error) => Self::Io(error),
            error => Self::Store(error),
        }
    }
}

pub(crate) enum TransactionMode {
    Deferred,
    Immediate,
}

pub struct ConfigurationStore {
    connection: OwnedConnection,
}

impl ConfigurationStore {
    pub async fn for_root(owner: Arc<RootOwner>) -> Result<Self> {
        owner.validate_current()?;
        let connection = database::open(owner).await?;
        Ok(Self { connection })
    }

    pub(crate) async fn transaction<T: Send + 'static>(
        &self,
        mode: TransactionMode,
        operation: impl for<'c> FnOnce(&'c mut SqliteConnection) -> BoxFuture<'c, Result<T>>
        + Send
        + 'static,
    ) -> Result<T> {
        self.connection
            .run(move |connection| {
                Box::pin(async move {
                    let mut tx = connection
                        .begin_with(match mode {
                            TransactionMode::Deferred => "BEGIN",
                            TransactionMode::Immediate => "BEGIN IMMEDIATE",
                        })
                        .await?;
                    match operation(&mut tx).await {
                        Ok(value) => Ok(tx
                            .commit()
                            .await
                            .map(|()| value)
                            .map_err(|_| ConfigError::CommitUnknown)),
                        Err(error) => {
                            // Finish rollback before the next accepted job can run.
                            tx.rollback().await?;
                            Ok(Err(error))
                        }
                    }
                })
            })
            .await?
    }

    pub async fn shutdown(&self) -> Result<()> {
        self.connection.shutdown().await?;
        Ok(())
    }

    pub async fn close(self) -> Result<()> {
        self.connection.close().await?;
        Ok(())
    }
}
