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

use super::{Error, Skills};
use crate::api::*;
use maka_runtime::execution::WorkspaceProjection;
use serde::Serialize;

pub(super) mod governance;

impl Skills {
    /// Host resolves and authorizes the workspace before entering the domain.
    pub async fn query(
        &self,
        input: &CatalogInput,
        workspace: WorkspaceProjection,
        workspace_files: maka_plugins::filesystem::ReadDirectory,
    ) -> Result<CatalogResult, Error> {
        let _view = self.mutations.read().await;
        self.query_inner(input, workspace, workspace_files).await
    }

    /// Called while the domain mutation lock is already held.
    pub(super) async fn query_inner(
        &self,
        input: &CatalogInput,
        workspace: WorkspaceProjection,
        workspace_files: maka_plugins::filesystem::ReadDirectory,
    ) -> Result<CatalogResult, Error> {
        let (sources, preferences) = self.governance(&workspace_files).await?;
        let governance = governance::items(&sources, preferences.as_ref());
        let revision = revision(input.context(), &workspace, &sources, preferences.as_ref())?;
        let cursor_revision =
            maka_runtime::artifact::content_digest(&encode(&(&revision, input.view()))?);
        let offset = match input {
            CatalogInput::Start { .. } | CatalogInput::Lookup { .. } => 0,
            CatalogInput::Continue {
                revision: expected,
                cursor,
                ..
            } => {
                if expected != &revision {
                    return Ok(CatalogResult::RevisionChanged {
                        expected_revision: expected.clone(),
                        actual_revision: revision,
                        resolved_workspace: workspace,
                    });
                }
                super::page::decode_cursor(cursor, &cursor_revision)?
            }
        };
        let mut items = match input.view() {
            CatalogView::Bundled => sources
                .bundled
                .iter()
                .map(|s| {
                    let fields = &s.document.manifest;
                    let (name, tn) = bounded(&fields.name, 256);
                    let (description, td) = bounded(&fields.description, 4096);
                    let (category, tc) = bounded(
                        fields
                            .attributes
                            .category
                            .as_deref()
                            .filter(|s| !s.is_empty())
                            .unwrap_or("效率工具"),
                        128,
                    );
                    let tools = &fields.attributes.allowed_tools;
                    let declared_tools: Vec<_> =
                        tools.iter().take(16).map(|s| bounded(s, 128).0).collect();
                    let tt = tools.len() != declared_tools.len()
                        || tools.iter().zip(&declared_tools).any(|(a, b)| a != b);
                    CatalogItem::Bundled {
                        id: s.id.into(),
                        name,
                        description,
                        category,
                        declared_tools,
                        metadata_truncated: tn || td || tc || tt,
                        installed: sources.publication.occupied.contains(&s.id.to_lowercase()),
                    }
                })
                .collect::<Vec<_>>(),
            CatalogView::ManagedSources => {
                let installed = sources.installed_managed_sources();
                let valid = sources.managed.discovery.inventory.iter().map(|s| {
                    (
                        &s.location.id,
                        Some(s.document.manifest.name.as_str()),
                        Some(s.document.manifest.description.as_str()),
                        s.document.manifest.attributes.category.as_deref(),
                    )
                });
                let rejected = sources.managed.discovery.rejected.iter().map(|s| {
                    (
                        &s.location.id,
                        s.document.manifest.name.as_deref(),
                        s.document.manifest.description.as_deref(),
                        s.document.manifest.attributes.category.as_deref(),
                    )
                });
                valid
                    .chain(rejected)
                    .filter(|(id, ..)| crate::safe_source_id(id))
                    .map(|(id, name, description, category)| {
                        let (name, tn) = bounded(name.filter(|s| !s.is_empty()).unwrap_or(id), 256);
                        let (description, td) = bounded(description.unwrap_or(""), 4096);
                        let category = managed_category(category).to_owned();
                        CatalogItem::ManagedSource {
                            id: id.clone(),
                            name,
                            description,
                            category,
                            source_type: ManagedSourceType::Local,
                            metadata_truncated: tn || td,
                            installed: installed.contains(&id.to_ascii_lowercase()),
                        }
                    })
                    .collect()
            }
            CatalogView::Governance => governance,
        };
        if let CatalogInput::Lookup { reference, .. } = input {
            items.retain(|item| matches!(item, CatalogItem::Skill(item) | CatalogItem::DiscoveryDiagnostic(item) if &item.reference == reference));
        }
        items.sort_by(|a, b| key(a).cmp(&key(b)));
        if offset > items.len()
            || matches!(input, CatalogInput::Continue { .. }) && offset == items.len()
        {
            return Err(Error::Invalid("Invalid skill source cursor".into()));
        }
        let view = input.view();
        let user_recovery = self
            .user_recovery
            .lock()
            .unwrap()
            .as_ref()
            .map(|message| bounded(message, 2048).0);
        let workspace_overhead = ",\"resolvedWorkspace\":".len() + encode(&workspace)?.len();
        let mut selected = Vec::new();
        let mut bytes = 0;
        for item in &items[offset..] {
            let end = offset + selected.len() + 1;
            let next_cursor =
                (end < items.len()).then(|| super::page::cursor(&cursor_revision, end));
            let envelope = CatalogResult::Page {
                user_recovery: user_recovery.clone(),
                view,
                revision: revision.clone(),
                items: Vec::new(),
                next_cursor,
                resolved_workspace: workspace.clone(),
            };
            let size = encode(item)?.len();
            if selected.len() == MAX_ITEMS
                || encode(&envelope)?.len() - workspace_overhead + bytes + size + selected.len()
                    > MAX_PAGE_BYTES
            {
                if selected.is_empty() {
                    return Err(Error::Projection(
                        "Skill source metadata cannot fit a page".into(),
                    ));
                }
                break;
            }
            bytes += size;
            selected.push(item.clone());
        }
        let end = offset + selected.len();
        Ok(CatalogResult::Page {
            user_recovery,
            view,
            revision: revision.clone(),
            items: selected,
            next_cursor: (end < items.len()).then(|| super::page::cursor(&cursor_revision, end)),
            resolved_workspace: workspace,
        })
    }
}

fn key(item: &CatalogItem) -> (&str, &str) {
    match item {
        CatalogItem::Bundled { name, id, .. } | CatalogItem::ManagedSource { name, id, .. } => {
            (name, id)
        }
        CatalogItem::Skill(item) | CatalogItem::DiscoveryDiagnostic(item) => {
            (&item.name, &item.reference)
        }
    }
}
pub(super) fn managed_category(category: Option<&str>) -> &str {
    category
        .filter(|value| {
            matches!(
                *value,
                "内容创作"
                    | "数据与AI"
                    | "设计与UI"
                    | "DevOps与部署"
                    | "文档与写作"
                    | "效率工具"
                    | "研究与分析"
            )
        })
        .unwrap_or("效率工具")
}
pub(super) fn bounded(text: &str, max: usize) -> (String, bool) {
    let end = text.floor_char_boundary(text.len().min(max));
    (text[..end].into(), end < text.len())
}
fn encode(value: &impl Serialize) -> Result<Vec<u8>, Error> {
    serde_json::to_vec(value).map_err(Error::from)
}

pub(super) fn revision(
    context: &WorkspaceContext,
    workspace: &WorkspaceProjection,
    sources: &crate::SourceCatalog,
    preferences: Option<&super::PreferenceSnapshot>,
) -> Result<String, Error> {
    let governance = governance::items(sources, preferences);
    Ok(maka_runtime::artifact::content_digest(&encode(&(
        "skill.catalog.v3",
        context,
        &workspace,
        &sources.publication.occupied,
        &sources.publication.origins,
        &governance,
        preferences.as_ref().map(|p| p.revision),
        sources
            .publication
            .discovery
            .inventory
            .iter()
            .map(|s| (&s.location.reference, &s.content_sha256))
            .collect::<Vec<_>>(),
        sources
            .publication
            .discovery
            .rejected
            .iter()
            .map(|s| (&s.location.reference, &s.content_sha256))
            .collect::<Vec<_>>(),
        sources
            .bundled
            .iter()
            .map(|s| (s.id, &s.content_sha256))
            .collect::<Vec<_>>(),
        sources
            .managed
            .discovery
            .inventory
            .iter()
            .map(|s| (&s.location.id, &s.content_sha256))
            .collect::<Vec<_>>(),
        sources
            .managed
            .discovery
            .rejected
            .iter()
            .map(|s| (&s.location.id, &s.content_sha256))
            .collect::<Vec<_>>(),
    ))?))
}
