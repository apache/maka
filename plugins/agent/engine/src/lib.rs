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

//! Durable logical execution. There is one policy and one capability-driven driver.
pub mod cleanup;
pub mod context_input;
mod continuation;
pub mod history;
mod model_source;
pub mod preparation;
pub mod prepared_prompt;
pub use model_source::{ModelSource, PreparedModel};
mod driver;
pub mod ports;
pub mod pricing;
mod reconcile;
pub use driver::{
    DriverExit, ExternalCleanupPublication, ExternalWitness, ModelCleanupPublication, ModelWitness,
    PendingPublication, PublicationResolution, PublicationWitness,
};
use maka_agent_facts::event::CommitError;
use maka_agent_facts::tools::ToolError;
use maka_agent_state::Store;
use maka_event_log::StoreError;
use maka_model::ModelError;

#[derive(Clone)]
pub struct Engine {
    store: Store,
}
impl Engine {
    pub fn new(store: Store) -> Self {
        Self { store }
    }
    pub fn store(&self) -> &Store {
        &self.store
    }
}

#[derive(Debug, thiserror::Error)]
pub enum RunError {
    #[error("execution blocked: {0:?}")]
    Blocked(Box<maka_agent_facts::durable::BlockerKind>),
    #[error("canonical publication outcome is uncertain: {source}")]
    PublicationUncertain {
        publication: Box<driver::PendingPublication>,
        #[source]
        source: StoreError,
    },
    #[error("session already has an active invocation")]
    Busy,
    /// Preflight became stale; no invocation was opened or source claimed.
    #[error("Session tool loading changed during continuation preparation; prepare again")]
    ContinuationChanged,
    #[error("session requires reconciliation before another invocation: {0}")]
    ReconciliationRequired(String),
    #[error("invalid execution input: {0}")]
    InvalidInput(String),
    #[error("model is unavailable")]
    ModelUnavailable,
    #[error("execution isolation is unavailable: {0}")]
    IsolationUnavailable(String),
    #[error("context compaction failed: {0}")]
    CompactionFailed(String),
    #[error("pending input no longer matches the original compaction prefix or route")]
    CompactionMismatch,
    #[error("execution cancelled")]
    Cancelled,
    #[error("model output was incomplete; local tools from this response were not executed")]
    ModelIncomplete,
    #[error(transparent)]
    Commit(#[from] CommitError),
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error(transparent)]
    Model(#[from] ModelError),
    #[error(transparent)]
    Tool(#[from] ToolError),
    /// Physical ownership is uncertain; an enclosing native owner must retain
    /// its Root and capacity rather than infer cleanup from business completion.
    #[error("execution cleanup is unconfirmed")]
    CleanupUnconfirmed,
    #[error("execution worker failed: {0}")]
    Internal(String),
    #[error("execution data JSON failed: {0}")]
    Json(#[source] serde_json::Error),
    #[error("model input preparation failed: {0}")]
    Preparation(#[from] std::io::Error),
    #[error("model input cleanup was not confirmed: {0}")]
    PreparationCleanup(#[source] std::io::Error),
}

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
struct PreparationCancelled(&'static str);

fn preparation_cancelled(message: &'static str) -> std::io::Error {
    std::io::Error::other(PreparationCancelled(message))
}

impl From<maka_agent_facts::durable::BlockerKind> for RunError {
    fn from(reason: maka_agent_facts::durable::BlockerKind) -> Self {
        Self::Blocked(Box::new(reason))
    }
}

impl RunError {
    // Only our cancellation signal is terminal cancellation; I/O and cleanup keep their cause.
    fn preparation(error: std::io::Error) -> Self {
        if error
            .get_ref()
            .is_some_and(|cause| cause.is::<PreparationCancelled>())
        {
            Self::Cancelled
        } else {
            Self::Preparation(error)
        }
    }

    /// Explicit unconfirmed cleanup in this error. Absence is not proof of
    /// cleanup; only the original RunningCompletion carries that observation.
    pub fn is_cleanup_unconfirmed(&self) -> bool {
        matches!(
            self,
            Self::CleanupUnconfirmed
                | Self::PreparationCleanup(_)
                | Self::Model(ModelError::CleanupUnconfirmed)
                | Self::Tool(
                    ToolError::CleanupUnconfirmed(_)
                        | ToolError::OperationCleanupUnconfirmed { .. }
                )
        )
    }
}

pub fn digest(value: &impl serde::Serialize) -> Result<String, RunError> {
    use sha2::{Digest, Sha256};
    struct Writer(Sha256);
    impl std::io::Write for Writer {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.update(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut writer = Writer(Sha256::new());
    serde_json::to_writer(&mut writer, value).map_err(|e| RunError::Internal(e.to_string()))?;
    Ok(format!("sha256:{}", hex::encode(writer.0.finalize())))
}
