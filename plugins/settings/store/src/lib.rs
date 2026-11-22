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
pub use effect_snapshot::{ConnectionObservation, UsageObservation};
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

use maka_event_log::{StoreError, connection::OwnedConnection, root::RootOwner};
use rusqlite::Connection;
use std::sync::{Arc, Weak};

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
    Sqlite(#[from] rusqlite::Error),
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
            StoreError::Sqlite(error) => Self::Sqlite(error),
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
    owner: Weak<RootOwner>,
}

impl ConfigurationStore {
    pub async fn for_root(owner: Arc<RootOwner>) -> Result<Self> {
        owner.validate_current()?;
        let signal_owner = Arc::downgrade(&owner);
        let connection = database::open(owner).await?;
        Ok(Self {
            connection,
            owner: signal_owner,
        })
    }

    pub(crate) async fn transaction<T: Send + 'static>(
        &self,
        mode: TransactionMode,
        operation: impl FnOnce(&Connection) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let owner = self.owner.clone();
        self.connection
            .run(move |connection| {
                let before = connection.total_changes();
                {
                    let tx = rusqlite::Transaction::new_unchecked(
                        connection,
                        match mode {
                            TransactionMode::Deferred => rusqlite::TransactionBehavior::Deferred,
                            TransactionMode::Immediate => rusqlite::TransactionBehavior::Immediate,
                        },
                    )?;
                    match operation(&tx) {
                        Ok(value) => {
                            let result = tx
                                .commit()
                                .map(|()| value)
                                .map_err(|_| ConfigError::CommitUnknown);
                            if connection.total_changes() != before
                                && let Some(owner) = owner.upgrade()
                            {
                                owner.capability_source_changed();
                            }
                            Ok(result)
                        }
                        Err(error) => {
                            // Finish rollback before the next accepted job can run.
                            let rollback = tx.rollback();
                            if rollback.is_err()
                                && connection.total_changes() != before
                                && let Some(owner) = owner.upgrade()
                            {
                                owner.capability_source_changed();
                            }
                            rollback?;
                            Ok(Err(error))
                        }
                    }
                }
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
