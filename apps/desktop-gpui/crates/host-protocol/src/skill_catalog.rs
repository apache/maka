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

//! `skill.catalog.query`, `skill.catalog.mutate`, and
//! `skill.catalog.preview-update`: the Skills a workspace sees, the built-in
//! and local-source Skills it can install, and the changes a client makes
//! to them.
//!
//! Source: `packages/runtime-host/src/protocol/skill-catalog.ts`
//! (`SKILL_CATALOG_OPERATION_SPECS`, `decodeQueryInput`, `decodeQueryResult`,
//! `governanceItem`, `bundledItem`, `managedSourceItem`, `decodeMutateInput`,
//! `mutation`, `decodeMutateResult`, `decodePreviewInput`,
//! `decodePreviewResult`).
//!
//! A catalog is read one view at a time (`governance`: the installed Skills
//! and discovery diagnostics; `bundled`: the Skills shipped with Maka;
//! `managed_sources`: the local source library), in pages of at most 128
//! items addressed by the first page's revision. Every change names the
//! revision it was built on; a stale one answers `revision_conflict`, not an
//! error. Queries fail with `host_not_ready`, `host_draining`,
//! `operation_unavailable`, `invalid_request`, `persistence_failed`, or
//! `internal_failure` (`QUERY_ERRORS`), and a mutation also with
//! `commit_outcome_unknown` (`MUTATION_ERRORS`).
//!
//! Item metadata never carries a path or a Skill's body: a client that
//! shows a Skill's file resolves it from the `ref`
//! (`<scope>:<source>:<directory>`) on its own side.

use serde::{Deserialize, Serialize};

use crate::{Operation, WorkspaceProjection, WorkspaceTarget};

wire_enum! {
    /// `SkillCatalogView`.
    pub enum SkillCatalogView {
        /// The installed Skills and the sources that could not be read.
        Governance = "governance",
        /// The Skills that ship with Maka.
        Bundled = "bundled",
        /// The local source library (`~/.maka/skill-sources`).
        ManagedSources = "managed_sources",
    }
}

wire_enum! {
    /// `SkillCatalogSourceType`: where an installed Skill came from.
    pub enum SkillCatalogSourceType {
        Workspace = "workspace",
        Bundled = "bundled",
        Managed = "managed",
        Unknown = "unknown",
    }
}

wire_enum! {
    /// `SkillCatalogValidationStatus`.
    pub enum SkillCatalogValidationStatus {
        Ok = "ok",
        MissingLock = "missing_lock",
        Modified = "modified",
        MetadataError = "metadata_error",
    }
}

wire_enum! {
    /// `SkillCatalogManagedUpdateStatus`: how a Skill installed from a
    /// source compares with that source.
    pub enum SkillCatalogManagedUpdateStatus {
        NotManaged = "not_managed",
        SourceMissing = "source_missing",
        UpToDate = "up_to_date",
        UpdateAvailable = "update_available",
        LocalModified = "local_modified",
        MetadataError = "metadata_error",
    }
}

wire_enum! {
    /// `SkillCatalogRuntimeStatus`.
    pub enum SkillCatalogRuntimeStatus {
        Enabled = "enabled",
        Disabled = "disabled",
        /// The workspace's Skill state file cannot be read.
        StateError = "state_error",
    }
}

wire_enum! {
    /// `SkillCatalogScope`: whose directory a Skill was found in.
    pub enum SkillCatalogScope {
        Project = "project",
        Workspace = "workspace",
        User = "user",
        Custom = "custom",
    }
}

wire_enum! {
    /// `SkillCatalogDiscoverySource`: which client's directory layout.
    pub enum SkillCatalogDiscoverySource {
        Maka = "maka",
        Agents = "agents",
        Legacy = "legacy",
        Custom = "custom",
    }
}

wire_enum! {
    /// `SkillCatalogContextStatus`: whether a Skill reaches the model's
    /// context, and why not.
    pub enum SkillCatalogContextStatus {
        Unknown = "unknown",
        Advertised = "advertised",
        Disabled = "disabled",
        Invalid = "invalid",
        HostIncompatible = "host_incompatible",
        Shadowed = "shadowed",
        Budget = "budget",
    }
}

wire_enum! {
    /// `SkillCatalogValidationCode`.
    pub enum SkillCatalogValidationCode {
        MissingLock = "missing_lock",
        Modified = "modified",
        InvalidJson = "invalid_json",
        IdMismatch = "id_mismatch",
        UnsupportedSchema = "unsupported_schema",
        InvalidHash = "invalid_hash",
        WriteFailed = "write_failed",
        LockSymlink = "lock_symlink",
        MissingFrontmatter = "missing_frontmatter",
        MalformedFrontmatter = "malformed_frontmatter",
        MissingName = "missing_name",
        InvalidName = "invalid_name",
        NameTooLong = "name_too_long",
        MissingDescription = "missing_description",
        InvalidDescription = "invalid_description",
        DescriptionTooLong = "description_too_long",
        InvalidAllowedTools = "invalid_allowed_tools",
        InvalidRequiredTools = "invalid_required_tools",
        InvalidRequiredCapabilities = "invalid_required_capabilities",
        InvalidLicense = "invalid_license",
        InvalidCompatibility = "invalid_compatibility",
        CompatibilityTooLong = "compatibility_too_long",
        InvalidMetadata = "invalid_metadata",
        InvalidCategory = "invalid_category",
        UnsupportedField = "unsupported_field",
        BodyTooLarge = "body_too_large",
        DuplicateId = "duplicate_id",
        DuplicateName = "duplicate_name",
        BlockedPath = "blocked_path",
        ReadFailed = "read_failed",
        ProjectionTruncated = "projection_truncated",
    }
}

wire_enum! {
    /// `SkillCatalogManagedSourceItem.sourceType`: always `local` at this
    /// epoch.
    pub enum SkillCatalogManagedSourceType {
        Local = "local",
    }
}

wire_enum! {
    /// The `sourceType` of an `install` mutation (`mutableSourceType`).
    pub enum SkillInstallSourceType {
        Bundled = "bundled",
        Managed = "managed",
    }
}

wire_enum! {
    /// `SkillCatalogMutationRejectedReason`.
    pub enum SkillCatalogMutationRejectedReason {
        NotFound = "not_found",
        AlreadyExists = "already_exists",
        /// A project's Skills belong to its repository.
        BlockedScope = "blocked_scope",
        NotManaged = "not_managed",
        SourceMissing = "source_missing",
        /// The source changed since the preview the update confirmed.
        SourceChanged = "source_changed",
        SourceInvalid = "source_invalid",
        LocalModified = "local_modified",
        MetadataError = "metadata_error",
        NeedsReview = "needs_review",
        BlockedPath = "blocked_path",
        StateError = "state_error",
    }
}

wire_enum! {
    /// `SkillCatalogPreviewRejectedReason`.
    pub enum SkillCatalogPreviewRejectedReason {
        NotFound = "not_found",
        NotManaged = "not_managed",
        SourceMissing = "source_missing",
        SourceInvalid = "source_invalid",
        MetadataError = "metadata_error",
    }
}

/// `SkillCatalogWorkspaceContext` (`localContext`): the workspace whose
/// Skills are meant, a registered project or a Host directory.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct SkillCatalogWorkspaceContext {
    pub workspace: WorkspaceTarget,
}

impl SkillCatalogWorkspaceContext {
    pub fn new(workspace: WorkspaceTarget) -> Self {
        Self { workspace }
    }
}

/// `SkillCatalogQueryInput` (`decodeQueryInput`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub enum SkillCatalogQueryInput {
    /// The first page of `view`.
    Start { context: SkillCatalogWorkspaceContext, view: SkillCatalogView },
    /// The page after `cursor` of the listing at `revision` (the first
    /// page's).
    Continue {
        context: SkillCatalogWorkspaceContext,
        view: SkillCatalogView,
        /// `sha256:<64 hex>`.
        revision: String,
        cursor: String,
    },
}

/// `SkillCatalogQueryResult` (`decodeQueryResult`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub enum SkillCatalogQueryResult {
    /// At most 128 items of `view`: governance items in the `governance`
    /// view, bundled ones in `bundled`, sources in `managed_sources`.
    #[serde(rename_all = "camelCase")]
    Page {
        view: SkillCatalogView,
        revision: String,
        items: Vec<SkillCatalogPageItem>,
        next_cursor: Option<String>,
        resolved_workspace: WorkspaceProjection,
    },
    /// The catalog changed between pages; read again from the start.
    #[serde(rename_all = "camelCase")]
    RevisionChanged {
        expected_revision: String,
        actual_revision: String,
        resolved_workspace: WorkspaceProjection,
    },
    /// A result kind this client does not recognize.
    #[serde(other, skip_serializing)]
    Unknown,
}

wire_union! {
    /// `SkillCatalogPageItem`, by `kind`. A mutation's `entry` is always a
    /// governance item (`Skill` or `DiscoveryDiagnostic`).
    pub enum SkillCatalogPageItem in "kind" {
        /// An installed Skill.
        Skill(SkillCatalogGovernanceItem) = "skill",
        /// A discovery source that could not be read; its `scope` and
        /// `source` say which, `validationCodes` why.
        DiscoveryDiagnostic(SkillCatalogGovernanceItem) = "discovery_diagnostic",
        Bundled(SkillCatalogBundledItem) = "bundled",
        ManagedSource(SkillCatalogManagedSourceItem) = "managed_source",
    }
}

impl SkillCatalogPageItem {
    /// The governance item, for an installed Skill or a diagnostic.
    pub fn governance(&self) -> Option<&SkillCatalogGovernanceItem> {
        match self {
            Self::Skill(item) | Self::DiscoveryDiagnostic(item) => Some(item),
            _ => None,
        }
    }
}

/// `SkillCatalogGovernanceItem` (`governanceItem`), without its `kind`,
/// which [`SkillCatalogPageItem`] carries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct SkillCatalogGovernanceItem {
    /// `<scope>:<source>:<directory>`, what every change names.
    #[serde(rename = "ref")]
    pub skill_ref: String,
    /// The Skill's directory name, as a person reads it.
    pub id: String,
    /// Empty for a diagnostic.
    pub name: String,
    pub description: String,
    pub declared_tools: Vec<String>,
    pub metadata_truncated: bool,
    pub source_type: SkillCatalogSourceType,
    pub user_modified: bool,
    pub validation_status: SkillCatalogValidationStatus,
    pub validation_codes: Vec<SkillCatalogValidationCode>,
    /// `null` for a Skill that did not come from a source.
    pub managed_update_status: Option<SkillCatalogManagedUpdateStatus>,
    pub enabled: bool,
    pub pinned: bool,
    pub runtime_status: SkillCatalogRuntimeStatus,
    pub scope: SkillCatalogScope,
    pub source: SkillCatalogDiscoverySource,
    pub context_status: SkillCatalogContextStatus,
    /// Its place in the model's context, from 1.
    pub context_rank: Option<u64>,
    /// The `ref` of the Skill with the same id that wins over this one.
    pub shadowed_by: Option<String>,
    pub needs_review: bool,
    /// Whether the client may change or delete it.
    pub manageable: bool,
}

/// `SkillCatalogBundledItem` (`bundledItem`), without its `kind`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct SkillCatalogBundledItem {
    pub id: String,
    pub name: String,
    pub description: String,
    pub category: String,
    pub declared_tools: Vec<String>,
    pub metadata_truncated: bool,
    /// Already installed in the workspace.
    pub installed: bool,
}

/// `SkillCatalogManagedSourceItem` (`managedSourceItem`), without its
/// `kind`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct SkillCatalogManagedSourceItem {
    pub id: String,
    pub name: String,
    pub description: String,
    pub category: String,
    pub source_type: SkillCatalogManagedSourceType,
    pub metadata_truncated: bool,
    /// Already installed in the workspace.
    pub installed: bool,
}

/// `SkillCatalogMutation` (`mutation`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub enum SkillCatalogMutation {
    /// Write the starter Skill into the workspace.
    CreateStarter,
    /// Copy a built-in Skill or a source into the workspace.
    #[serde(rename_all = "camelCase")]
    Install { source_type: SkillInstallSourceType, source_id: String },
    /// Bring a Skill installed from a source up to the source. `force`
    /// overwrites local changes and then names both contents as the
    /// preview hashed them; otherwise both hashes are `null`.
    #[serde(rename_all = "camelCase")]
    UpdateManaged {
        #[serde(rename = "ref")]
        skill_ref: String,
        force: bool,
        expected_current_sha256: Option<String>,
        expected_source_sha256: Option<String>,
    },
    Delete {
        #[serde(rename = "ref")]
        skill_ref: String,
    },
    SetEnabled {
        #[serde(rename = "ref")]
        skill_ref: String,
        enabled: bool,
    },
    /// Keep the Skill in the model's context whatever the budget.
    SetPinned {
        #[serde(rename = "ref")]
        skill_ref: String,
        pinned: bool,
    },
}

impl SkillCatalogMutation {
    /// `update_managed` without overwriting local changes.
    pub fn update_managed(skill_ref: impl Into<String>) -> Self {
        Self::UpdateManaged {
            skill_ref: skill_ref.into(),
            force: false,
            expected_current_sha256: None,
            expected_source_sha256: None,
        }
    }

    /// `update_managed` over local changes, confirming the contents the
    /// preview showed by their hashes.
    pub fn overwrite_managed(
        skill_ref: impl Into<String>,
        expected_current_sha256: impl Into<String>,
        expected_source_sha256: impl Into<String>,
    ) -> Self {
        Self::UpdateManaged {
            skill_ref: skill_ref.into(),
            force: true,
            expected_current_sha256: Some(expected_current_sha256.into()),
            expected_source_sha256: Some(expected_source_sha256.into()),
        }
    }
}

/// `SkillCatalogMutateInput` (`decodeMutateInput`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct SkillCatalogMutateInput {
    pub context: SkillCatalogWorkspaceContext,
    /// The governance revision the change was built on.
    pub expected_revision: String,
    pub mutation: SkillCatalogMutation,
}

impl SkillCatalogMutateInput {
    pub fn new(
        context: SkillCatalogWorkspaceContext,
        expected_revision: impl Into<String>,
        mutation: SkillCatalogMutation,
    ) -> Self {
        Self { context, expected_revision: expected_revision.into(), mutation }
    }
}

/// `SkillCatalogMutateResult` (`decodeMutateResult`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub enum SkillCatalogMutateResult {
    /// Written; `entry` is the Skill as it now stands (`null` once
    /// deleted).
    #[serde(rename_all = "camelCase")]
    Committed {
        revision: String,
        entry: Option<SkillCatalogPageItem>,
        resolved_workspace: WorkspaceProjection,
    },
    /// Nothing to write: the catalog already said so.
    #[serde(rename_all = "camelCase")]
    Unchanged {
        revision: String,
        entry: Option<SkillCatalogPageItem>,
        resolved_workspace: WorkspaceProjection,
    },
    /// `expectedRevision` is stale; read again and rebuild the change.
    #[serde(rename_all = "camelCase")]
    RevisionConflict {
        expected_revision: String,
        actual_revision: String,
        resolved_workspace: WorkspaceProjection,
    },
    #[serde(rename_all = "camelCase")]
    Rejected { reason: SkillCatalogMutationRejectedReason, resolved_workspace: WorkspaceProjection },
    /// A result kind this client does not recognize.
    #[serde(other, skip_serializing)]
    Unknown,
}

/// `SkillCatalogPreviewUpdateInput` (`decodePreviewInput`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct SkillCatalogPreviewUpdateInput {
    pub context: SkillCatalogWorkspaceContext,
    pub expected_revision: String,
    #[serde(rename = "ref")]
    pub skill_ref: String,
}

impl SkillCatalogPreviewUpdateInput {
    pub fn new(
        context: SkillCatalogWorkspaceContext,
        expected_revision: impl Into<String>,
        skill_ref: impl Into<String>,
    ) -> Self {
        Self { context, expected_revision: expected_revision.into(), skill_ref: skill_ref.into() }
    }
}

/// `SkillCatalogPreviewUpdateResult` (`decodePreviewResult`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub enum SkillCatalogPreviewUpdateResult {
    Preview(Box<SkillCatalogPreview>),
    #[serde(rename_all = "camelCase")]
    RevisionConflict {
        expected_revision: String,
        actual_revision: String,
        resolved_workspace: WorkspaceProjection,
    },
    #[serde(rename_all = "camelCase")]
    Rejected {
        reason: SkillCatalogPreviewRejectedReason,
        resolved_workspace: WorkspaceProjection,
    },
    /// A result kind this client does not recognize.
    #[serde(other, skip_serializing)]
    Unknown,
}

/// The `preview` branch of `SkillCatalogPreviewUpdateResult`: the start of
/// the workspace copy and of the source (24 KiB each at most), and the
/// hashes an overwrite confirms.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct SkillCatalogPreview {
    pub revision: String,
    pub current_snippet: String,
    pub source_snippet: String,
    pub current_truncated: bool,
    pub source_truncated: bool,
    /// Whether the Host kept the content the Skill was installed with.
    pub has_managed_baseline: bool,
    pub summary: SkillCatalogPreviewLineSummary,
    pub expected_current_sha256: String,
    pub expected_source_sha256: String,
    pub resolved_workspace: WorkspaceProjection,
}

/// `SkillCatalogPreviewLineSummary` (`lineSummary`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct SkillCatalogPreviewLineSummary {
    pub current_line_count: u64,
    pub source_line_count: u64,
    pub changed_line_count: u64,
}

/// `skill.catalog.query` (mode `query`).
#[derive(Debug)]
pub enum SkillCatalogQuery {}

impl Operation for SkillCatalogQuery {
    const NAME: &'static str = "skill.catalog.query";
    type Input = SkillCatalogQueryInput;
    type Output = SkillCatalogQueryResult;
}

/// `skill.catalog.mutate` (mode `command`).
#[derive(Debug)]
pub enum SkillCatalogMutate {}

impl Operation for SkillCatalogMutate {
    const NAME: &'static str = "skill.catalog.mutate";
    type Input = SkillCatalogMutateInput;
    type Output = SkillCatalogMutateResult;
}

/// `skill.catalog.preview-update` (mode `query`).
#[derive(Debug)]
pub enum SkillCatalogPreviewUpdate {}

impl Operation for SkillCatalogPreviewUpdate {
    const NAME: &'static str = "skill.catalog.preview-update";
    type Input = SkillCatalogPreviewUpdateInput;
    type Output = SkillCatalogPreviewUpdateResult;
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;

    // The samples below are the ones
    // packages/runtime-host/src/__tests__/skill-catalog-protocol.test.ts
    // decodes through `decodeHostFrame` and `decodeClientFrame`.
    const REVISION: &str =
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const NEXT_REVISION: &str =
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    fn context() -> Value {
        json!({"workspace": {"kind": "host_path", "path": "/workspace/project"}})
    }

    fn resolved_workspace() -> Value {
        json!({"target": {"kind": "host_path", "path": "/workspace/project"},
               "hostCwd": "/workspace/project"})
    }

    /// `governanceItem()` of the TypeScript test, with `overrides`.
    fn governance_item(overrides: Value) -> Value {
        let mut item = json!({
            "kind": "skill",
            "ref": "workspace:legacy:research-brief",
            "id": "research-brief",
            "name": "Research brief",
            "description": "Prepare a research brief",
            "declaredTools": ["Read"],
            "metadataTruncated": false,
            "sourceType": "managed",
            "userModified": false,
            "validationStatus": "ok",
            "validationCodes": [],
            "managedUpdateStatus": "up_to_date",
            "enabled": true,
            "pinned": false,
            "runtimeStatus": "enabled",
            "scope": "workspace",
            "source": "legacy",
            "contextStatus": "unknown",
            "contextRank": null,
            "shadowedBy": null,
            "needsReview": false,
            "manageable": true
        });
        if let (Some(item), Value::Object(overrides)) = (item.as_object_mut(), overrides) {
            item.extend(overrides);
        }
        item
    }

    fn page(view: &str, items: Vec<Value>) -> Value {
        json!({"kind": "page", "view": view, "revision": REVISION, "items": items,
               "nextCursor": null, "resolvedWorkspace": resolved_workspace()})
    }

    fn round_trip<T: Serialize + serde::de::DeserializeOwned>(wire: &Value) -> T {
        let decoded: T = serde_json::from_value(wire.clone()).expect("decode");
        assert_eq!(&serde_json::to_value(&decoded).expect("encode"), wire);
        decoded
    }

    #[test]
    fn queries_encode_start_and_continuation() {
        for input in [
            json!({"kind": "start", "context": context(), "view": "governance"}),
            json!({"kind": "start", "context": context(), "view": "bundled"}),
            json!({"kind": "start", "context": context(), "view": "managed_sources"}),
            json!({"kind": "continue", "context": context(), "view": "governance",
                   "revision": REVISION, "cursor": "opaque:+/cursor=="}),
        ] {
            round_trip::<SkillCatalogQueryInput>(&input);
        }
        let project = SkillCatalogQueryInput::Start {
            context: SkillCatalogWorkspaceContext::new(WorkspaceTarget::Project {
                project_id: "p1".into(),
            }),
            view: SkillCatalogView::Governance,
        };
        assert_eq!(
            serde_json::to_value(project).expect("encode"),
            json!({"kind": "start", "context": {"workspace": {"kind": "project",
                   "projectId": "p1"}}, "view": "governance"})
        );
    }

    #[test]
    fn every_view_decodes_its_items() {
        let diagnostic = governance_item(json!({
            "kind": "discovery_diagnostic", "ref": "diagnostic:project:maka:0",
            "id": "source-0", "name": "", "description": "", "declaredTools": [],
            "sourceType": "unknown", "validationStatus": "metadata_error",
            "validationCodes": ["blocked_path"], "managedUpdateStatus": null,
            "enabled": false, "runtimeStatus": "disabled", "scope": "project",
            "source": "maka", "contextStatus": "invalid", "contextRank": null,
            "manageable": false
        }));
        let governance = page("governance", vec![governance_item(json!({})), diagnostic]);
        let SkillCatalogQueryResult::Page { items, resolved_workspace: resolved, .. } =
            round_trip(&governance)
        else {
            panic!("a page");
        };
        let SkillCatalogPageItem::Skill(skill) = &items[0] else { panic!("a Skill") };
        assert_eq!(skill.skill_ref, "workspace:legacy:research-brief");
        assert_eq!(skill.managed_update_status, Some(SkillCatalogManagedUpdateStatus::UpToDate));
        assert_eq!(skill.source_type, SkillCatalogSourceType::Managed);
        assert_eq!(skill.scope, SkillCatalogScope::Workspace);
        let SkillCatalogPageItem::DiscoveryDiagnostic(diagnostic) = &items[1] else {
            panic!("a diagnostic");
        };
        assert_eq!(diagnostic.validation_codes, [SkillCatalogValidationCode::BlockedPath]);
        assert_eq!(diagnostic.managed_update_status, None);
        assert_eq!(resolved.host_cwd, "/workspace/project");

        let bundled = page(
            "bundled",
            vec![json!({"kind": "bundled", "id": "deep-research", "name": "Deep research",
                        "description": "Research a topic", "category": "Productivity",
                        "declaredTools": ["Read"], "metadataTruncated": false,
                        "installed": true})],
        );
        let SkillCatalogQueryResult::Page { items, .. } = round_trip(&bundled) else {
            panic!("a page");
        };
        assert!(matches!(&items[0], SkillCatalogPageItem::Bundled(item) if item.installed));

        let sources = page(
            "managed_sources",
            vec![json!({"kind": "managed_source", "id": "research-brief",
                        "name": "Research brief", "description": "Prepare a research brief",
                        "category": "Research", "sourceType": "local",
                        "metadataTruncated": false, "installed": false})],
        );
        let SkillCatalogQueryResult::Page { items, .. } = round_trip(&sources) else {
            panic!("a page");
        };
        let SkillCatalogPageItem::ManagedSource(source) = &items[0] else { panic!("a source") };
        assert_eq!(source.source_type, SkillCatalogManagedSourceType::Local);

        let changed = json!({"kind": "revision_changed", "expectedRevision": REVISION,
                             "actualRevision": NEXT_REVISION,
                             "resolvedWorkspace": resolved_workspace()});
        assert!(matches!(
            round_trip(&changed),
            SkillCatalogQueryResult::RevisionChanged { actual_revision, .. }
                if actual_revision == NEXT_REVISION
        ));
    }

    #[test]
    fn a_page_item_or_result_this_client_does_not_know_is_kept_apart() {
        let item: SkillCatalogPageItem =
            serde_json::from_value(json!({"kind": "plugin", "id": "p"})).expect("decode");
        assert_eq!(item.tag(), "plugin");
        assert!(item.governance().is_none());
        let result: SkillCatalogQueryResult =
            serde_json::from_value(json!({"kind": "gone"})).expect("decode");
        assert_eq!(result, SkillCatalogQueryResult::Unknown);
        // A governance item without a nullable field it must carry is not
        // one (the TypeScript rejects it too).
        let mut missing = governance_item(json!({}));
        missing.as_object_mut().expect("object").remove("enabled");
        assert!(serde_json::from_value::<SkillCatalogPageItem>(missing).is_err());
    }

    #[test]
    fn every_mutation_encodes_as_the_host_decodes_it() {
        let cases = [
            (SkillCatalogMutation::CreateStarter, json!({"kind": "create_starter"})),
            (
                SkillCatalogMutation::Install {
                    source_type: SkillInstallSourceType::Bundled,
                    source_id: "deep-research".into(),
                },
                json!({"kind": "install", "sourceType": "bundled", "sourceId": "deep-research"}),
            ),
            (
                SkillCatalogMutation::Install {
                    source_type: SkillInstallSourceType::Managed,
                    source_id: "research-brief".into(),
                },
                json!({"kind": "install", "sourceType": "managed", "sourceId": "research-brief"}),
            ),
            (
                SkillCatalogMutation::update_managed("workspace:legacy:research-brief"),
                json!({"kind": "update_managed", "ref": "workspace:legacy:research-brief",
                       "force": false, "expectedCurrentSha256": null,
                       "expectedSourceSha256": null}),
            ),
            (
                SkillCatalogMutation::overwrite_managed(
                    "workspace:legacy:research-brief",
                    REVISION,
                    NEXT_REVISION,
                ),
                json!({"kind": "update_managed", "ref": "workspace:legacy:research-brief",
                       "force": true, "expectedCurrentSha256": REVISION,
                       "expectedSourceSha256": NEXT_REVISION}),
            ),
            (
                SkillCatalogMutation::Delete {
                    skill_ref: "workspace:legacy:research-brief".into(),
                },
                json!({"kind": "delete", "ref": "workspace:legacy:research-brief"}),
            ),
            (
                SkillCatalogMutation::SetEnabled {
                    skill_ref: "user:maka:research-brief".into(),
                    enabled: false,
                },
                json!({"kind": "set_enabled", "ref": "user:maka:research-brief",
                       "enabled": false}),
            ),
            (
                SkillCatalogMutation::SetPinned {
                    skill_ref: "user:maka:research-brief".into(),
                    pinned: true,
                },
                json!({"kind": "set_pinned", "ref": "user:maka:research-brief", "pinned": true}),
            ),
        ];
        for (mutation, wire) in cases {
            let input = SkillCatalogMutateInput::new(
                serde_json::from_value(context()).expect("context"),
                REVISION,
                mutation,
            );
            assert_eq!(
                serde_json::to_value(&input).expect("encode"),
                json!({"context": context(), "expectedRevision": REVISION, "mutation": wire})
            );
            round_trip::<SkillCatalogMutateInput>(
                &json!({"context": context(), "expectedRevision": REVISION, "mutation": wire}),
            );
        }
    }

    #[test]
    fn mutation_outcomes_decode() {
        let committed = json!({"kind": "committed", "revision": NEXT_REVISION,
                               "entry": governance_item(json!({})),
                               "resolvedWorkspace": resolved_workspace()});
        let SkillCatalogMutateResult::Committed { entry: Some(entry), .. } = round_trip(&committed)
        else {
            panic!("committed with its entry");
        };
        assert_eq!(entry.governance().map(|item| item.id.as_str()), Some("research-brief"));
        for result in [
            json!({"kind": "unchanged", "revision": REVISION, "entry": null,
                   "resolvedWorkspace": resolved_workspace()}),
            json!({"kind": "revision_conflict", "expectedRevision": REVISION,
                   "actualRevision": NEXT_REVISION, "resolvedWorkspace": resolved_workspace()}),
            json!({"kind": "rejected", "reason": "blocked_scope",
                   "resolvedWorkspace": resolved_workspace()}),
            json!({"kind": "rejected", "reason": "metadata_error",
                   "resolvedWorkspace": resolved_workspace()}),
        ] {
            round_trip::<SkillCatalogMutateResult>(&result);
        }
        let rejected: SkillCatalogMutateResult = serde_json::from_value(json!({
            "kind": "rejected", "reason": "source_changed",
            "resolvedWorkspace": resolved_workspace()
        }))
        .expect("decode");
        assert!(matches!(
            rejected,
            SkillCatalogMutateResult::Rejected {
                reason: SkillCatalogMutationRejectedReason::SourceChanged,
                ..
            }
        ));
    }

    #[test]
    fn update_previews_decode() {
        let request = json!({"context": context(), "expectedRevision": REVISION,
                             "ref": "workspace:legacy:research-brief"});
        let input = SkillCatalogPreviewUpdateInput::new(
            serde_json::from_value(context()).expect("context"),
            REVISION,
            "workspace:legacy:research-brief",
        );
        assert_eq!(serde_json::to_value(input).expect("encode"), request);
        let preview = json!({
            "kind": "preview", "revision": REVISION,
            "currentSnippet": "old\ncontent\n", "sourceSnippet": "new\ncontent\n",
            "currentTruncated": false, "sourceTruncated": false, "hasManagedBaseline": true,
            "summary": {"currentLineCount": 2, "sourceLineCount": 2, "changedLineCount": 1},
            "expectedCurrentSha256": REVISION, "expectedSourceSha256": NEXT_REVISION,
            "resolvedWorkspace": resolved_workspace()
        });
        let SkillCatalogPreviewUpdateResult::Preview(preview) = round_trip(&preview) else {
            panic!("a preview");
        };
        assert_eq!(preview.summary.changed_line_count, 1);
        assert_eq!(preview.expected_source_sha256, NEXT_REVISION);
        let rejected = json!({"kind": "rejected", "reason": "metadata_error",
                              "resolvedWorkspace": resolved_workspace()});
        assert!(matches!(
            round_trip(&rejected),
            SkillCatalogPreviewUpdateResult::Rejected {
                reason: SkillCatalogPreviewRejectedReason::MetadataError,
                ..
            }
        ));
        // `detail` is not a field of a rejection (the TypeScript rejects it).
        assert!(
            serde_json::from_value::<SkillCatalogPreviewUpdateResult>(json!({
                "kind": "rejected", "reason": "not_found", "detail": "/private/SKILL.md",
                "resolvedWorkspace": resolved_workspace()
            }))
            .is_err()
        );
    }
}
