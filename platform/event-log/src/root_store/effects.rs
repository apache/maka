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

//! Selected Session custody for a one-shot Host browser lease-child service.
use super::{EventLog, SessionStore, StoreError, gates};
use crate::effects::{Outcome, Record, Request, browser_lease_session};
use maka_plugin_core::storage::Namespace;
use std::sync::Arc;
use uuid::Uuid;

/// Original durable T1 with the accepted Session's existing SQL lifetime pin.
/// Dropping it cannot record success; exclusive recovery keeps an unknown outcome.
#[must_use = "an admitted browser service must retain its original receipt through settlement"]
pub struct BrowserLeaseChildReceipt {
    log: EventLog,
    id: Uuid,
}
impl std::fmt::Debug for BrowserLeaseChildReceipt {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BrowserLeaseChildReceipt")
            .field("id", &self.id)
            .finish_non_exhaustive()
    }
}
impl BrowserLeaseChildReceipt {
    /// Actual durable Host effect identity created at admission.
    pub fn id(&self) -> Uuid {
        self.id
    }
    /// Record one actual service outcome on the same admitted Session writer.
    ///
    /// # Errors
    /// Returns storage/commit errors, including conflict with an already settled
    /// or recovery-marked unknown outcome. No effect or settlement is replayed.
    pub async fn settle(self, outcome: Outcome) -> Result<(), StoreError> {
        self.log.settle_host_effect(self.id, outcome, None).await
    }
}
struct BrowserChildWork(Arc<gates::Gates>);
impl Drop for BrowserChildWork {
    fn drop(&mut self) {
        self.0.finish_work();
    }
}
impl SessionStore {
    /// Durably admit a browser source-lease child service before its first effect.
    /// Observation fields grant no permission; the Host checks the live lease.
    ///
    /// # Errors
    /// Rejects another Session, wrong source/owner/operation/boundary, retired
    /// Session custody, and unconfirmed durable admission.
    pub async fn begin_browser_lease_child(
        &self,
        request: Request,
    ) -> Result<BrowserLeaseChildReceipt, StoreError> {
        self.check_session(browser_lease_session(&request)?)?;
        let dependency: Option<crate::connection::custody::Custody> = if self.work.is_some() {
            None
        } else {
            self.gates.start_work()?;
            Some(Arc::new(BrowserChildWork(self.gates.clone())))
        };
        let mut log = self.scoped().await?;
        if let Some(dependency) = dependency {
            log = log.scoped(dependency);
        }
        let id = log.begin_host_effect(request).await?;
        Ok(BrowserLeaseChildReceipt { log, id })
    }

    /// Read this selected Session's original browser service receipt only.
    ///
    /// # Errors
    /// Returns storage errors or rejects a foreign/non-browser receipt even if
    /// it shares the same package namespace or physical writer.
    pub async fn browser_lease_child_effect(
        &self,
        namespace: Namespace,
        id: Uuid,
    ) -> Result<Option<Record>, StoreError> {
        let log = self.scoped().await?;
        let Some(record) = log.host_effect(namespace, id).await? else {
            return Ok(None);
        };
        self.check_session(browser_lease_session(&record.request)?)?;
        Ok(Some(record))
    }
}
