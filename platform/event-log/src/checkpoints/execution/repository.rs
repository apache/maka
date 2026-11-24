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

use super::*;
use crate::checkpoints::repository::{
    BoundHead, SessionIdentity, SessionRepository, Source, Storage,
};

struct ExecutingRepository {
    repository: Arc<dyn SessionRepository>,
    execution: Execution,
}
impl Storage {
    /// Explicit trusted bootstrap. Grant data alone cannot supply the authority.
    pub fn with_execution(mut self, execution: Execution) -> Result<Self, StoreError> {
        if self.execution.is_some()
            || self.sessions.identity() != execution.repository_identity()
            || self.agent != execution.grant().binding.identity.agent
        {
            return Err(invalid(
                "execution authority does not match checkpoint storage",
            ));
        }
        self.sessions = Arc::new(ExecutingRepository {
            repository: self.sessions,
            execution: execution.clone(),
        });
        self.execution = Some(execution);
        Ok(self)
    }
}
impl SessionRepository for ExecutingRepository {
    fn identity(&self) -> &str {
        self.repository.identity()
    }
    fn object_store_identity(&self) -> &str {
        self.repository.object_store_identity()
    }
    fn lookup(
        &self,
        source: Source,
        agent: Uuid,
    ) -> BoxFuture<'_, Result<Option<Binding>, StoreError>> {
        self.repository.lookup(source, agent)
    }
    fn bind(&self, source: Source, agent: Uuid) -> BoxFuture<'_, Result<Binding, StoreError>> {
        Box::pin(async move {
            let grant = self.execution.grant();
            if source != grant.binding.source || agent != grant.binding.identity.agent {
                return Err(invalid("checkpoint source is outside the execution grant"));
            }
            Ok(grant.binding.clone())
        })
    }
    fn read_head(
        &self,
        identity: SessionIdentity,
    ) -> BoxFuture<'_, Result<Option<BoundHead>, StoreError>> {
        self.repository.read_head(identity)
    }
    fn receipt(&self, request: Commit) -> BoxFuture<'_, Result<Option<CommitReceipt>, StoreError>> {
        self.execution
            .authority()
            .receipt(self.execution.grant.clone(), request)
    }
    fn commit(
        &self,
        request: Commit,
        verified: VerifiedCheckpoint,
    ) -> BoxFuture<'_, Result<CommitReceipt, StoreError>> {
        Box::pin(async move {
            if self.execution.cancellation.is_cancelled() {
                return Err(invalid("Session execution is draining"));
            }
            // The authority atomically arbitrates generation, Head and receipt.
            let result = self
                .execution
                .authority()
                .commit(self.execution.grant.clone(), request, verified)
                .await;
            if result.is_err() {
                self.execution.cancellation.cancel();
            }
            result
        })
    }
}
