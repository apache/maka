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

//! Resource settlement belongs to the native worker, independent of its observer.
use super::*;
use maka_capabilities::call::Scope;

impl Owner {
    pub(super) async fn current_work_scope(
        &self,
        session: &str,
        configuration: &ResolvedConfiguration,
    ) -> Result<maka_event_log::root_store::SessionWorkScope, maka_event_log::StoreError> {
        let directory = workspace::open_workspace(
            &self.workspace_roots,
            &configuration.workspace,
            &self.managed_worktrees,
        )
        .await
        .map_err(maka_event_log::StoreError::InvalidTransition)?;
        let workspace = self.store.workspace(directory).await?;
        self.store
            .session(session)
            .await?
            .work_scope_in(Some(configuration.permission_basis()), &workspace)
            .await
    }
    /// Reuse an actual accepted work scope rather than reacquiring its binding
    /// behind a queued writer. Serialized call observations cannot supply pins.
    pub(super) async fn auxiliary_lease(
        &self,
        scope: &Scope,
        session: &str,
    ) -> Result<maka_event_log::root_store::SessionWorkLease, auxiliary::Error> {
        match scope.work_custody() {
            Some(custody) => self
                .store
                .fork_work(custody.as_ref(), session)
                .map_err(auxiliary::admission_error),
            None => {
                let current = self.session(session).await.map_err(|error| {
                    auxiliary::Error::Admission(maka_agent_facts::tools::ToolError::Failed(error))
                })?;
                let scope = self
                    .current_work_scope(session, &current.configuration)
                    .await
                    .map_err(auxiliary::admission_error)?;
                Ok(scope.accept(CancellationToken::new()).0)
            }
        }
    }

    // An observer can leave, but the original Call and native owner retain the
    // worker through parsing, database closure, and the accepted SQL transaction.
    pub(super) async fn resource_work<T: std::marker::Send + 'static>(
        self: &Arc<Self>,
        scope: &Scope,
        work: impl FnOnce(Arc<Self>, Scope) -> BoxFuture<'static, Result<T, String>>
        + std::marker::Send
        + 'static,
    ) -> Result<T, String> {
        let owner = self.clone();
        let scope = scope.clone();
        let mut ticket = scope.resources.reserve().map_err(|_| "agent_work_closed")?;
        self.workers
            .spawn(async move {
                ticket.start();
                let result = if scope.cancellation.is_cancelled() || owner.stop.is_cancelled() {
                    Err("agent_work_cancelled".into())
                } else {
                    work(owner, scope).await
                };
                ticket.complete(Ok(()));
                result
            })
            .await
            .map_err(|_| "agent_work_unknown".to_owned())?
    }
}
