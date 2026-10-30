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
mod management;
impl Owner {
    pub(crate) async fn project_mcp(
        self: &Arc<Self>,
        input: McpRead,
        scope: &maka_capabilities::call::Scope,
    ) -> Result<McpView, String> {
        self.resource_work(scope, move |owner, _| {
            Box::pin(async move {
                let session = owner.session(&input.session_id).await?;
                workspace::validate(
                    &owner.workspace_roots,
                    &session.configuration.workspace,
                    &owner.managed_worktrees,
                )
                .await?;
                let proposal = owner
                    .mcp_projects
                    .proposal(&session.configuration.workspace)
                    .await?;
                owner.mcp_projects.view(&proposal).await
            })
        })
        .await
    }
    pub(crate) async fn trust_project_mcp(
        self: &Arc<Self>,
        input: McpTrust,
        scope: &maka_capabilities::call::Scope,
    ) -> Result<McpTrustResult, String> {
        if scope.identity.agent().is_some() {
            return Err("agent_mcp_user_approval_required".into());
        }
        self.resource_work(scope, move |owner, _| {
            Box::pin(async move {
                let session = owner.session(&input.session_id).await?;
                workspace::validate(
                    &owner.workspace_roots,
                    &session.configuration.workspace,
                    &owner.managed_worktrees,
                )
                .await?;
                let proposal = owner
                    .mcp_projects
                    .proposal(&session.configuration.workspace)
                    .await?;
                if proposal.revision != input.revision {
                    return Ok(McpTrustResult::Changed);
                }
                owner.mcp_projects.trust(&proposal).await?;
                Ok(McpTrustResult::Trusted)
            })
        })
        .await
    }
}
