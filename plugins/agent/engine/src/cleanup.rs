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
pub(crate) struct Evidence(Arc<AtomicBool>);
tokio::task_local! { static CURRENT: Evidence; }
impl Evidence {
    pub fn scope<F: std::future::Future>(
        &self,
        future: F,
    ) -> impl std::future::Future<Output = F::Output> + use<F> {
        CURRENT.scope(self.clone(), future)
    }
    pub fn confirmed(&self) -> bool {
        !self.0.load(Ordering::Acquire)
    }
}
pub(crate) fn current() -> Evidence {
    CURRENT.try_with(Clone::clone).unwrap_or_default()
}
#[track_caller]
pub(crate) fn unconfirmed() -> crate::RunError {
    let caller = std::panic::Location::caller();
    let _ = CURRENT.try_with(|evidence| {
        if !evidence.0.swap(true, Ordering::AcqRel) {
            tracing::error!(
                stage = "execution_cleanup_evidence",
                outcome = "cleanup_unconfirmed",
                file = caller.file(),
                line = caller.line(),
                column = caller.column(),
                "cleanup unconfirmed"
            );
        }
    });
    crate::RunError::CleanupUnconfirmed
}

#[track_caller]
pub(crate) fn preparation_failed(error: std::io::Error) -> crate::RunError {
    let _ = unconfirmed();
    crate::RunError::PreparationCleanup(error)
}
