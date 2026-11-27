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

//! Fresh authorization for new model dispatch and body replay, never source observations.
use super::*;
use crate::owner::driver::{
    same_tool_contract, source_authority_changed, tool_contract_digest, validate_tool_digest,
};
use maka_agent_engine::{PreparedModel, RunError};
use maka_agent_facts::durable::RequestSpec;
use std::collections::BTreeMap;

impl RunAccess {
    pub(in crate::owner) fn bind_model_tools(
        &self,
        mcp: Arc<crate::mcp::Catalog>,
        mode: maka_agent_facts::execution::ToolMode,
    ) {
        assert!(
            self.model_tools.set((mcp, mode)).is_ok(),
            "one actual activation binds its model tools once"
        );
    }
    pub(in crate::owner) fn current_model_tools(
        &self,
        workspace: &crate::contract::Workspace,
    ) -> Result<
        (
            Arc<crate::mcp::Catalog>,
            maka_agent_facts::execution::ToolMode,
        ),
        RunError,
    > {
        let (activation, mode) = self
            .model_tools
            .get()
            .ok_or_else(|| source_authority_changed("actual activation tools are unavailable"))?;
        let owner = self.owner().map_err(RunError::InvalidInput)?;
        Ok((
            owner
                .mcp_projects
                .current_activation(workspace, &self.execution.session_id, activation)
                .map_err(source_authority_changed)?,
            *mode,
        ))
    }
    pub(in crate::owner) async fn authorize_request_tools(
        self: &Arc<Self>,
        request: &RequestSpec,
        model: &PreparedModel,
        cancellation: &CancellationToken,
    ) -> Result<(), RunError> {
        self.owner()
            .map_err(RunError::InvalidInput)?
            .require_execution(&self.execution.session_id)
            .await
            .map_err(RunError::InvalidInput)?;
        let view = self.fresh().await.map_err(RunError::InvalidInput)?;
        let current = self.live_configuration().await?;
        let owner = self.owner().map_err(RunError::InvalidInput)?;
        let selection = owner
            .selection_snapshot(&owner.durable, view.run, &view.spec.tool_selection)
            .await?;
        let (mcp, mode) = self.current_model_tools(&current.workspace)?;
        let catalog = owner.run_catalog(self.clone(), &mcp, &selection)?;
        let catalog = Self::select_live_tools(&catalog, &current, view.spec.tool_discovery);
        let availability = maka_tools::availability::Availability::new(
            catalog.clone(),
            maka_tools::availability::LoadedTools::new(owner.durable.cells().reader(
                self.execution.session_id.clone(),
                tokio::runtime::Handle::current(),
            )),
        );
        let bound = availability
            .capture(
                Some(model.provider.tool_context()),
                self.execution.clone(),
                Some(self.custody.clone()),
                current.workspace.path,
                cancellation.clone(),
            )
            .await?;
        self.validate_model_tools_with_selection(
            request,
            None,
            Some(&selection),
            &catalog,
            &bound.all(),
            &mcp,
            mode,
        )
        .await
    }

    pub(in crate::owner) async fn authorize_request_memory(
        &self,
        request: &RequestSpec,
        model: &PreparedModel,
        budget: &maka_agent_facts::context::PreparedContextBreakdown,
        memory: Option<&MemoryProjection>,
    ) -> Result<(), RunError> {
        use maka_agent_state::memory::{pinned::Authorize, reads::CheckReads};

        fn memory_read_failure(error: maka_event_log::StoreError) -> RunError {
            match error {
                maka_event_log::StoreError::InvalidTransition(message) => {
                    RunError::FrozenMemoryDenied(message)
                }
                error => source_authority_changed(error.to_string()),
            }
        }

        let run = self.execution.run_id;
        let data = self.data_writer().map_err(source_authority_changed)?;
        let reads = data
            .query(CheckReads(run))
            .await
            .map_err(memory_read_failure)?;
        let spec = self.spec();
        if spec.memory_projection.is_none() && !reads.facts {
            return Ok(());
        }

        let owner = self.owner().map_err(RunError::InvalidInput)?;
        // The policy and the Run ledger live in separate databases. An unchanged
        // policy revision brackets the snapshot that authorizes all protected input.
        let mut policy = owner
            .configuration
            .runtime_policy()
            .await
            .map_err(|e| source_authority_changed(e.to_string()))?;
        const MAX_POLICY_CHECKS: usize = 3;
        for _ in 0..MAX_POLICY_CHECKS {
            if !policy.policy.memory.enabled || !policy.policy.memory.agent_read_enabled {
                return Err(RunError::FrozenMemoryDenied(
                    "admitted memory read permission revoked".into(),
                ));
            }
            let current = self.current_configuration().await?;
            if current.tools.is_some() {
                return Err(RunError::FrozenMemoryDenied(
                    "admitted memory read permission revoked".into(),
                ));
            }
            let mut dependencies = Vec::new();
            if let Some(memory) = memory {
                if request.accounting.purpose == maka_agent_facts::context::ModelPurpose::Main {
                    let limit = model.context.as_ref().and_then(|c| {
                        maka_agent_facts::context::effective_input_limit(
                            c.model_context_window,
                            c.context_window,
                        )
                    });
                    memory
                        .check_window(limit, budget.fixed_tokens())
                        .map_err(source_authority_changed)?;
                }
                dependencies = memory
                    .entries
                    .iter()
                    .map(|entry| entry.loaded.clone())
                    .collect();
            }

            let scope = if reads.project.is_some()
                || dependencies.iter().any(|entry| entry.scope != "personal")
            {
                owner
                    .project_memory_scope(&self.execution.session_id, &current)
                    .await
                    .map_err(source_authority_changed)?
            } else {
                let mut scope = owner
                    .memory_scope(MemoryScope::Personal)
                    .await
                    .map_err(source_authority_changed)?;
                scope.binding = Some((
                    self.execution.session_id.clone(),
                    current.permission_basis(),
                ));
                scope
            };
            data.query(Authorize {
                run,
                scope,
                dependencies,
            })
            .await
            .map_err(memory_read_failure)?;
            let current_policy = owner
                .configuration
                .runtime_policy()
                .await
                .map_err(|e| source_authority_changed(e.to_string()))?;
            if current_policy.revision == policy.revision {
                return Ok(());
            }
            policy = current_policy;
        }
        Err(RunError::FrozenMemoryDenied(
            "memory policy changed repeatedly during authorization; retry in a new Run".into(),
        ))
    }

    pub(in crate::owner) async fn validate_model_tools(
        self: &Arc<Self>,
        request: &RequestSpec,
        surface: &maka_agent_facts::composition::CompositionSurface,
        raw: &maka_tools::ToolCatalog,
        bound: &maka_tools::ToolCatalog,
        mcp: &crate::mcp::Catalog,
        mode: maka_agent_facts::execution::ToolMode,
    ) -> Result<(), RunError> {
        self.validate_model_tools_with_selection(
            request,
            Some(surface),
            None,
            raw,
            bound,
            mcp,
            mode,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    async fn validate_model_tools_with_selection(
        self: &Arc<Self>,
        request: &RequestSpec,
        surface: Option<&maka_agent_facts::composition::CompositionSurface>,
        selection: Option<&crate::tools::SelectionSnapshot>,
        raw: &maka_tools::ToolCatalog,
        bound: &maka_tools::ToolCatalog,
        mcp: &crate::mcp::Catalog,
        mode: maka_agent_facts::execution::ToolMode,
    ) -> Result<(), RunError> {
        let view = self.fresh().await.map_err(RunError::InvalidInput)?;
        let owner = self.owner().map_err(RunError::InvalidInput)?;
        let loaded_surface;
        let surface = match surface {
            Some(surface) => surface,
            None => {
                loaded_surface = owner
                    .run_content(view.run, &request.composition.surface)
                    .await?;
                &loaded_surface
            }
        };
        validate_tool_digest(request, surface)?;
        let current = self.live_configuration().await?;
        let loaded;
        let selection = match selection {
            Some(selection) => selection,
            None => {
                loaded = owner
                    .selection_snapshot(&owner.durable, view.run, &view.spec.tool_selection)
                    .await?;
                &loaded
            }
        };
        let code = mode == maka_agent_facts::execution::ToolMode::CodeMode;
        let contracts: BTreeMap<String, String> = if code {
            let provenance: serde_json::Value =
                owner.run_content(view.run, &request.provenance).await?;
            serde_json::from_value(
                provenance
                    .get("toolContracts")
                    .ok_or_else(|| {
                        source_authority_changed(
                            "original request-bound tool contracts are unavailable",
                        )
                    })?
                    .clone(),
            )
            .map_err(RunError::Json)?
        } else {
            BTreeMap::new()
        };
        let selected: Vec<_> = if code {
            contracts
                .keys()
                .map(|name| {
                    selection
                        .definitions
                        .iter()
                        .find(|tool| &tool.name == name)
                        .ok_or_else(|| {
                            source_authority_changed(format!(
                                "selected tool {name} lost its original declaration"
                            ))
                        })
                })
                .collect::<Result<_, _>>()?
        } else {
            surface
                .tools
                .iter()
                .filter(|tool| tool.name != maka_tools::availability::SEARCH)
                .map(Arc::as_ref)
                .collect()
        };
        if let Some(name) =
            mcp.unavailable_selected_binding(selected.iter().map(|tool| tool.name.as_str()))
        {
            return Err(source_authority_changed(format!(
                "selected tool {name} MCP connection is unavailable"
            )));
        }
        for original in &selected {
            if current
                .tools
                .as_ref()
                .is_some_and(|names| !names.contains(&original.name))
            {
                return Err(source_authority_changed(format!(
                    "selected tool {} is outside current authority",
                    original.name
                )));
            }
            let declared = raw
                .definitions()
                .find(|tool| tool.name == original.name)
                .ok_or_else(|| {
                    source_authority_changed(format!(
                        "selected tool {} is no longer bound",
                        original.name
                    ))
                })?;
            if code && !same_tool_contract(original, declared) {
                return Err(source_authority_changed(format!(
                    "selected tool {} declaration changed",
                    original.name
                )));
            }
            if selection.internal_bindings.get(&original.name) != mcp.bindings.get(&original.name) {
                return Err(source_authority_changed(format!(
                    "selected tool {} internal binding changed",
                    original.name
                )));
            }
            if !selection.matches_service(&original.name, &owner.tool_basis) {
                return Err(source_authority_changed(format!(
                    "selected tool {} binding changed",
                    original.name
                )));
            }
        }
        for original in &selected {
            let actual = bound
                .definitions()
                .find(|tool| tool.name == original.name)
                .ok_or_else(|| {
                    source_authority_changed(format!(
                        "selected tool {} is unavailable in the current scope",
                        original.name
                    ))
                })?;
            let matches = if code {
                contracts.get(&original.name) == Some(&tool_contract_digest(actual)?)
            } else {
                same_tool_contract(original, actual)
            };
            if !matches {
                return Err(source_authority_changed(format!(
                    "selected tool {} request contract changed",
                    original.name
                )));
            }
        }
        let current = self.live_configuration().await?;
        for original in selected {
            if current
                .tools
                .as_ref()
                .is_some_and(|names| !names.contains(&original.name))
            {
                return Err(source_authority_changed(format!(
                    "selected tool {} is outside current authority",
                    original.name
                )));
            }
        }
        Ok(())
    }
}
