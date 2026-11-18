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

use super::ModelOperation;
use serde::{Deserialize, Serialize};

/// ChatGPT subscription facts. Account/connection identify provenance, not replay permission.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CodexRequestProvenance {
    pub connection_id: String,
    pub account_id: Option<String>,
    pub compatibility: Option<CodexCompatibility>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CodexCompatibility {
    pub comp_hash: String,
    /// Unix seconds, matching the canonical account inventory timestamp.
    pub fetched_at: u64,
}

/// Call only with ChatGPT provenance on both sides. Recorded observations do not
/// expire with the catalog; a later catalog cannot certify a missing old hash.
/// Native re-compaction may ask the producing model to convert its own old state.
pub fn codex_replay_allowed(
    same_model: bool,
    hashes_match: Option<bool>,
    operation: ModelOperation,
) -> bool {
    (same_model && operation == ModelOperation::CodexCompaction)
        || hashes_match.unwrap_or(same_model)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CodexPreflightStage {
    Previous,
    Fallback,
    Current,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CodexContinuation {
    pub model: String,
    pub model_context_window: Option<u64>,
    pub provenance: CodexRequestProvenance,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CodexPreflight {
    pub stage: CodexPreflightStage,
    pub target: CodexContinuation,
}

impl CodexPreflight {
    pub fn retry_with_target(
        &self,
        compactor: &str,
        failure: &crate::model::error::ModelError,
    ) -> bool {
        use crate::model::error::{ModelError, ProviderFailureReason};
        self.stage == CodexPreflightStage::Previous
            && compactor != self.target.model
            && match failure {
                ModelError::ContextOverflow {
                    observed_output: false,
                }
                | ModelError::Http { .. } => true,
                ModelError::Provider(failure) => {
                    failure.replay_safe()
                        && !matches!(
                            failure.reason(),
                            ProviderFailureReason::QuotaExhausted
                                | ProviderFailureReason::StreamTruncated
                        )
                }
                _ => false,
            }
    }
}
