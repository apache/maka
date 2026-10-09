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

//! `project.catalog.query` and `project.catalog.mutate`.
//!
//! Source: `packages/runtime-host/src/protocol/project-catalog.ts`
//! (`PROJECT_CATALOG_OPERATION_SPECS`, `decodeProjectCatalogQueryInput`,
//! `decodeProjectCatalogQueryResult`, `decodeProjectCatalogPageItem`,
//! `decodeProjectCatalogMutateInput`, `decodeProjectCatalogMutateResult`,
//! `decodeProjectCatalogProject`).
//!
//! A listing is paged as flat items: a `project` header, then its `alias`
//! and (in the `locations` view) `location` items, all addressed by
//! `projectIndex`.

use serde::{Deserialize, Serialize};

use crate::Operation;

wire_enum! {
    /// `ProjectCatalogView`. `locations` includes paths and is available only
    /// to local-owner connections.
    pub enum ProjectCatalogView {
        Summary = "summary",
        Locations = "locations",
    }
}

/// `ProjectCatalogQueryInput`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub enum ProjectCatalogQueryInput {
    /// First page.
    ListStart { view: ProjectCatalogView },
    /// The page after `cursor` of the listing at `revision`.
    ListContinue {
        view: ProjectCatalogView,
        /// `sha256:<64 hex>`.
        revision: String,
        cursor: String,
    },
    /// Directories the Host offers for registering a project.
    DirectoryRoots,
    #[serde(rename_all = "camelCase")]
    DirectoryListStart { root_id: String, segments: Vec<String> },
    #[serde(rename_all = "camelCase")]
    DirectoryListContinue { root_id: String, segments: Vec<String>, cursor: String },
}

/// `ProjectCatalogQueryResult`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub enum ProjectCatalogQueryResult {
    /// At most 64 items.
    #[serde(rename_all = "camelCase")]
    Page {
        view: ProjectCatalogView,
        revision: String,
        project_count: u64,
        items: Vec<ProjectCatalogPageItem>,
        next_cursor: Option<String>,
    },
    /// The catalog changed between pages; restart with `list_start`.
    RevisionChanged {
        view: ProjectCatalogView,
        expected: String,
        actual: String,
    },
    DirectoryRoots {
        roots: Vec<ProjectDirectoryRoot>,
    },
    #[serde(rename_all = "camelCase")]
    DirectoryPage {
        root_id: String,
        segments: Vec<String>,
        entries: Vec<ProjectDirectoryEntry>,
        next_cursor: Option<String>,
    },
    /// A result kind this client does not recognize.
    #[serde(other, skip_serializing)]
    Unknown,
}

/// `ProjectCatalogPageItem`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub enum ProjectCatalogPageItem {
    #[serde(rename_all = "camelCase")]
    Project {
        project_index: u64,
        id: String,
        name: String,
        alias_count: u64,
        location_count: u64,
        preferred_location_index: Option<u64>,
        /// Epoch milliseconds; `null` when not archived.
        archived_at: Option<u64>,
        available: bool,
    },
    #[serde(rename_all = "camelCase")]
    Alias { project_index: u64, item_index: u64, alias: String },
    #[serde(rename_all = "camelCase")]
    Location { project_index: u64, item_index: u64, location: ProjectCatalogLocation },
    /// An item kind this client does not recognize.
    #[serde(other, skip_serializing)]
    Unknown,
}

/// `ProjectCatalogLocation`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct ProjectCatalogLocation {
    pub path: String,
    pub is_worktree: bool,
}

/// `ProjectDirectoryRoot`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct ProjectDirectoryRoot {
    pub id: String,
    pub label: String,
}

/// `ProjectDirectoryEntry`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct ProjectDirectoryEntry {
    pub name: String,
}

/// `ProjectCatalogMutateInput`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub enum ProjectCatalogMutateInput {
    /// Register the project at an absolute Host path (local owners only).
    Register {
        path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        prefer: Option<bool>,
    },
    #[serde(rename_all = "camelCase")]
    RegisterDirectory { root_id: String, segments: Vec<String> },
    #[serde(rename_all = "camelCase")]
    Relink { project_id: String, path: String },
    #[serde(rename_all = "camelCase")]
    Rename { project_id: String, name: String },
    #[serde(rename_all = "camelCase")]
    Archive { project_id: String },
    #[serde(rename_all = "camelCase")]
    Restore { project_id: String },
}

/// `ProjectCatalogMutateResult`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub enum ProjectCatalogMutateResult {
    Project {
        project: ProjectCatalogProject,
    },
    /// A result kind this client does not recognize.
    #[serde(other, skip_serializing)]
    Unknown,
}

/// `ProjectCatalogProject` (`decodeProjectCatalogProject`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct ProjectCatalogProject {
    pub id: String,
    pub aliases: Vec<String>,
    pub name: String,
    pub location_count: u64,
    pub archived_at: Option<u64>,
    pub available: bool,
}

/// `project.catalog.query` (mode `query`).
#[derive(Debug)]
pub enum ProjectCatalogQuery {}

impl Operation for ProjectCatalogQuery {
    const NAME: &'static str = "project.catalog.query";
    type Input = ProjectCatalogQueryInput;
    type Output = ProjectCatalogQueryResult;
}

/// `project.catalog.mutate` (mode `command`).
#[derive(Debug)]
pub enum ProjectCatalogMutate {}

impl Operation for ProjectCatalogMutate {
    const NAME: &'static str = "project.catalog.mutate";
    type Input = ProjectCatalogMutateInput;
    type Output = ProjectCatalogMutateResult;
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn list_start_encodes_view() {
        assert_eq!(
            serde_json::to_value(ProjectCatalogQueryInput::ListStart {
                view: ProjectCatalogView::Summary
            })
            .expect("encode"),
            json!({"kind": "list_start", "view": "summary"})
        );
    }

    #[test]
    fn page_items_decode() {
        let result: ProjectCatalogQueryResult = serde_json::from_value(json!({
            "kind": "page", "view": "locations", "revision": "sha256:ab", "projectCount": 1,
            "items": [
                {"kind": "project", "projectIndex": 0, "id": "p1", "name": "Maka",
                 "aliasCount": 1, "locationCount": 1, "preferredLocationIndex": 0,
                 "archivedAt": null, "available": true},
                {"kind": "alias", "projectIndex": 0, "itemIndex": 0, "alias": "old-p1"},
                {"kind": "location", "projectIndex": 0, "itemIndex": 0,
                 "location": {"path": "/w", "isWorktree": false}}
            ],
            "nextCursor": null
        }))
        .expect("decode");
        let ProjectCatalogQueryResult::Page { items, .. } = result else { panic!("expected page") };
        assert_eq!(items.len(), 3);
        assert!(
            matches!(&items[2], ProjectCatalogPageItem::Location { location, .. } if location.path == "/w")
        );
    }

    #[test]
    fn mutations_encode_by_kind() {
        assert_eq!(
            serde_json::to_value(ProjectCatalogMutateInput::Register {
                path: "/w".into(),
                prefer: None
            })
            .expect("encode"),
            json!({"kind": "register", "path": "/w"})
        );
        let result: ProjectCatalogMutateResult = serde_json::from_value(json!({
            "kind": "project",
            "project": {"id": "p1", "aliases": [], "name": "w", "locationCount": 1,
                        "archivedAt": null, "available": true}
        }))
        .expect("decode");
        assert!(matches!(result, ProjectCatalogMutateResult::Project { .. }));
    }
}
