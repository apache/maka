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
    pub(in crate::owner) async fn authorize_model_request(
        self: &Arc<Self>,
        request: &RequestSpec,
        model: &PreparedModel,
        cancellation: &CancellationToken,
    ) -> Result<(), RunError> {
        let view = self.fresh().await.map_err(RunError::InvalidInput)?;
        let current = self.live_configuration().await?;
        let owner = self.owner().map_err(RunError::InvalidInput)?;
        let selection: crate::tools::SelectionSnapshot = owner
            .run_content(view.run, &view.spec.tool_selection)
            .await?;
        let (mcp, mode) = self.current_model_tools(&current.workspace)?;
        let catalog = owner.run_catalog(self.clone(), &mcp, &selection)?;
        let excluded: Vec<_> = catalog
            .definitions()
            .filter(|tool| {
                current
                    .tools
                    .as_ref()
                    .is_some_and(|allowed| !allowed.contains(&tool.name))
            })
            .map(|tool| tool.name.as_str())
            .collect();
        let catalog = catalog.excluding(&excluded);
        let catalog = if view.spec.tool_discovery {
            catalog.with_discovery()
        } else {
            catalog
        };
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
        self.validate_model_tools(request, &catalog, &bound.all(), &mcp, mode)
            .await
    }

    pub(in crate::owner) async fn validate_model_tools(
        self: &Arc<Self>,
        request: &RequestSpec,
        raw: &maka_tools::ToolCatalog,
        bound: &maka_tools::ToolCatalog,
        mcp: &crate::mcp::Catalog,
        mode: maka_agent_facts::execution::ToolMode,
    ) -> Result<(), RunError> {
        validate_tool_digest(request)?;
        let view = self.fresh().await.map_err(RunError::InvalidInput)?;
        let owner = self.owner().map_err(RunError::InvalidInput)?;
        let current = self.live_configuration().await?;
        let selection: crate::tools::SelectionSnapshot = owner
            .run_content(view.run, &view.spec.tool_selection)
            .await?;
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
            request
                .composition
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
