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

//! Read-only symbol navigation using the Session's original workspace capability.
use super::*;
use maka_capabilities::call::Scope;
use maka_fs_tools::symbols::LspRequestContext;
use std::sync::atomic::{AtomicBool, Ordering};

impl Owner {
    pub async fn code_definition(
        self: &Arc<Self>,
        input: CodeDefinitionRead,
        scope: &Scope,
    ) -> Result<CodeDefinitionResult, String> {
        input
            .path
            .validate()
            .map_err(|_| "agent_symbols_invalid_path".to_owned())?;
        self.resource_work(scope, move |owner, scope| {
            Box::pin(async move {
                let (original, ctx, guard) =
                    owner.symbol_context(&input.session_id, &scope).await?;
                let result = owner
                    .lsp_pool
                    .definition(
                        &ctx,
                        &input.path,
                        input.position,
                        input.symbol.as_deref(),
                        input.hover_only,
                    )
                    .await;
                drop(guard);
                let value = result?;
                owner
                    .check_file_session(&input.session_id, &original, &scope)
                    .await?;
                Ok(value)
            })
        })
        .await
    }

    pub async fn code_references(
        self: &Arc<Self>,
        input: CodeReferencesRead,
        scope: &Scope,
    ) -> Result<CodeReferencesResult, String> {
        input
            .path
            .validate()
            .map_err(|_| "agent_symbols_invalid_path".to_owned())?;
        self.resource_work(scope, move |owner, scope| {
            Box::pin(async move {
                let (original, ctx, guard) =
                    owner.symbol_context(&input.session_id, &scope).await?;
                let result = owner
                    .lsp_pool
                    .references(
                        &ctx,
                        &input.path,
                        input.position,
                        input.symbol.as_deref(),
                        input.include_declaration,
                    )
                    .await;
                drop(guard);
                let value = result?;
                owner
                    .check_file_session(&input.session_id, &original, &scope)
                    .await?;
                Ok(value)
            })
        })
        .await
    }

    pub async fn code_hover(
        self: &Arc<Self>,
        input: CodeHoverRead,
        scope: &Scope,
    ) -> Result<Option<CodeHoverResult>, String> {
        input
            .path
            .validate()
            .map_err(|_| "agent_symbols_invalid_path".to_owned())?;
        self.resource_work(scope, move |owner, scope| {
            Box::pin(async move {
                let (original, ctx, guard) =
                    owner.symbol_context(&input.session_id, &scope).await?;
                let result = owner
                    .lsp_pool
                    .hover(&ctx, &input.path, input.position)
                    .await;
                drop(guard);
                let value = result?;
                owner
                    .check_file_session(&input.session_id, &original, &scope)
                    .await?;
                Ok(value)
            })
        })
        .await
    }

    async fn symbol_context(
        &self,
        session_id: &str,
        scope: &Scope,
    ) -> Result<
        (
            ResolvedConfiguration,
            LspRequestContext,
            tokio::task::JoinHandle<()>,
        ),
        String,
    > {
        let (original, directory) = self.file_directory(session_id, None, scope).await?;
        let private_root = self
            .store
            .owned_root()
            .map_err(|_| "agent_root_unavailable".to_owned())?
            .canonical_path()
            .to_owned();
        let (resolved_root, _, _) = workspace::open_workspace_observation(
            &self.workspace_roots,
            &original.workspace,
            &self.managed_worktrees,
        )
        .await?;
        let cancel = Arc::new(AtomicBool::new(false));
        let cancel_watch = cancel.clone();
        let scope_cancel = scope.cancellation.clone();
        let stop_cancel = self.stop.clone();
        let guard = tokio::spawn(async move {
            tokio::select! {
                _ = scope_cancel.cancelled() => {}
                _ = stop_cancel.cancelled() => {}
            }
            cancel_watch.store(true, Ordering::Relaxed);
        });
        let ctx = LspRequestContext {
            workspace_root: resolved_root,
            private_root,
            directory,
            cancel,
        };
        Ok((original, ctx, guard))
    }
}
