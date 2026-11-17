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
use maka_agent_api::contract::WorkspaceAccess;
use maka_capabilities::call::Scope;
use maka_fs_tools::symbols::LspRequestContext;
use std::sync::atomic::{AtomicBool, Ordering};

struct AbortOnDrop(tokio::task::AbortHandle);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

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
                let (original, ctx, _guard) =
                    owner.symbol_context(&input.session_id, &scope).await?;
                let value = owner
                    .lsp_pool
                    .definition(
                        &ctx,
                        &input.path,
                        input.position,
                        input.symbol.as_deref(),
                        input.hover_only,
                    )
                    .await?;
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
                let (original, ctx, _guard) =
                    owner.symbol_context(&input.session_id, &scope).await?;
                let value = owner
                    .lsp_pool
                    .references(
                        &ctx,
                        &input.path,
                        input.position,
                        input.symbol.as_deref(),
                        input.include_declaration,
                    )
                    .await?;
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
                let (original, ctx, _guard) =
                    owner.symbol_context(&input.session_id, &scope).await?;
                let value = owner
                    .lsp_pool
                    .hover(&ctx, &input.path, input.position)
                    .await?;
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
    ) -> Result<(ResolvedConfiguration, LspRequestContext, AbortOnDrop), String> {
        let (original, directory) = self.file_directory(session_id, None, scope).await?;
        let allow_lsp = original.permissions.access != WorkspaceAccess::ReadOnly;
        let cancel = Arc::new(AtomicBool::new(false));
        let cancel_watch = cancel.clone();
        let scope_cancel = scope.cancellation.clone();
        let stop_cancel = self.stop.clone();
        let task = tokio::spawn(async move {
            tokio::select! {
                _ = scope_cancel.cancelled() => {}
                _ = stop_cancel.cancelled() => {}
            }
            cancel_watch.store(true, Ordering::Relaxed);
        });
        let ctx = LspRequestContext {
            directory,
            allow_lsp,
            cancel,
        };
        Ok((original, ctx, AbortOnDrop(task.abort_handle())))
    }
}
