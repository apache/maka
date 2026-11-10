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

//! One original execution's sticky physical evidence, independent of its final
//! business/journal error. Child summary work explicitly shares this evidence.
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
#[derive(Clone, Default)]
pub struct Evidence(Arc<AtomicBool>);
impl Evidence {
    pub fn confirmed(&self) -> bool {
        !self.0.load(Ordering::Acquire)
    }

    #[track_caller]
    pub fn observe(&self, error: &crate::RunError) {
        if error.is_cleanup_unconfirmed() {
            self.mark();
        }
    }

    #[track_caller]
    pub fn observe_model(&self, error: &maka_model::ModelError) {
        if error.cleanup_unconfirmed() {
            self.mark();
        }
    }

    #[track_caller]
    pub fn observe_tool(&self, error: &maka_agent_facts::tools::ToolError) {
        use maka_agent_facts::tools::ToolError;
        if matches!(
            error,
            ToolError::CleanupUnconfirmed(_) | ToolError::OperationCleanupUnconfirmed { .. }
        ) {
            self.mark();
        }
    }

    #[track_caller]
    fn mark(&self) {
        let caller = std::panic::Location::caller();
        if !self.0.swap(true, Ordering::AcqRel) {
            tracing::error!(
                stage = "execution_cleanup_evidence",
                outcome = "cleanup_unconfirmed",
                file = caller.file(),
                line = caller.line(),
                column = caller.column(),
                "cleanup unconfirmed"
            );
        }
    }

    #[track_caller]
    pub fn unconfirmed(&self) -> crate::RunError {
        self.mark();
        crate::RunError::CleanupUnconfirmed
    }

    #[track_caller]
    pub fn preparation_failed(&self, error: std::io::Error) -> crate::RunError {
        self.mark();
        crate::RunError::PreparationCleanup(error)
    }
}
