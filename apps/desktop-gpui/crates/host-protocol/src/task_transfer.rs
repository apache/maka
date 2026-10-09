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

//! Moving tasks in and out: another local agent's conversations read and
//! converted by the Host (`external-session.source.query`,
//! `external-session.catalog.query`, `external-session.import`), and a
//! task with its subagent subtree written to or read from a
//! `.maka-session` file on the Host's filesystem (`session-bundle.export`,
//! `session-bundle.import`).
//!
//! Source: `packages/runtime-host/src/protocol/external-session.ts`
//! (`EXTERNAL_SESSION_OPERATION_SPECS`, `decodeExternalSessionCatalogQueryInput`,
//! `decodeExternalSessionCatalogQueryResult`, `decodeExternalSessionSummary`,
//! `decodeExternalSessionImportInput`, `decodeExternalSessionImportResult`)
//! and `session-bundle.ts` (`SESSION_BUNDLE_OPERATION_SPECS` and its
//! decoders). Catalog errors add `source_limit_exceeded`; import errors add
//! `not_found`, `operation_conflict`, `commit_outcome_unknown`,
//! `model_unavailable`, and `source_unreadable`; bundle errors are
//! `not_found`, `session_busy`, `operation_conflict`, `source_unreadable`,
//! `candidate_set_stale`, and the common ones.

use serde::{Deserialize, Serialize};

use crate::{Operation, SessionCatalogItem, WorkspaceTarget};

/// `EXTERNAL_SESSION_PAGE_MAX_ITEMS`: conversations a catalog page holds.
pub const EXTERNAL_SESSION_PAGE_MAX_ITEMS: usize = 16;
/// `EXTERNAL_SESSION_QUERY_TEXT_MAX_BYTES`: the longest search, in UTF-8.
pub const EXTERNAL_SESSION_QUERY_TEXT_MAX_BYTES: usize = 800;

/// `ExternalSessionSourceQueryInput`: the empty object.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, serde(deny_unknown_fields))]
pub struct ExternalSessionSourceQueryInput {}

/// `ExternalSessionSourceQueryResult`: the agents installed on the Host's
/// machine, by adapter id (`codex`, `claude-code`, `opencode`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct ExternalSessionSourceQueryResult {
    pub adapter_ids: Vec<String>,
}

/// `external-session.source.query` (mode `query`).
#[derive(Debug)]
pub enum ExternalSessionSourceQuery {}

impl Operation for ExternalSessionSourceQuery {
    const NAME: &'static str = "external-session.source.query";
    type Input = ExternalSessionSourceQueryInput;
    type Output = ExternalSessionSourceQueryResult;
}

/// `ExternalSessionCatalogQueryInput`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct ExternalSessionCatalogQueryInput {
    pub adapter_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include_archived: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<WorkspaceTarget>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    /// Matched against a conversation's title and folder, before paging.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

impl ExternalSessionCatalogQueryInput {
    /// A page of `adapter_id`'s conversations, as Desktop asks for them:
    /// with the archived filter, the search when there is one, and the
    /// cursor of the page before.
    pub fn new(
        adapter_id: impl Into<String>,
        include_archived: bool,
        text: Option<String>,
        cursor: Option<String>,
    ) -> Self {
        Self {
            adapter_id: adapter_id.into(),
            include_archived: Some(include_archived),
            workspace: None,
            cursor,
            text,
        }
    }
}

/// `ExternalSessionCatalogItem.importState`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct ExternalSessionImportState {
    /// How many times the conversation was imported.
    pub imported_count: u64,
    /// The tasks it became, newest first, at most eight.
    pub imported_session_ids: Vec<String>,
    pub is_importing: bool,
}

/// `ExternalSessionCatalogItem` (`decodeExternalSessionSummary`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct ExternalSessionCatalogItem {
    /// The source's own id: unique within its adapter.
    pub id: String,
    pub name: String,
    /// The conversation's folder on the Host; may be empty.
    pub host_cwd: String,
    pub import_state: ExternalSessionImportState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived: Option<bool>,
}

/// `ExternalSessionCatalogQueryResult`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct ExternalSessionCatalogQueryResult {
    pub sessions: Vec<ExternalSessionCatalogItem>,
    /// `None` on the last page.
    pub next_cursor: Option<String>,
}

/// `external-session.catalog.query` (mode `query`).
#[derive(Debug)]
pub enum ExternalSessionCatalogQuery {}

impl Operation for ExternalSessionCatalogQuery {
    const NAME: &'static str = "external-session.catalog.query";
    type Input = ExternalSessionCatalogQueryInput;
    type Output = ExternalSessionCatalogQueryResult;
}

/// `ExternalSessionImportInput`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct ExternalSessionImportInput {
    pub adapter_id: String,
    pub source_session_id: String,
    /// Where the task goes; without it the Host keeps the source's folder.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<WorkspaceTarget>,
}

impl ExternalSessionImportInput {
    pub fn new(
        adapter_id: impl Into<String>,
        source_session_id: impl Into<String>,
        workspace: Option<WorkspaceTarget>,
    ) -> Self {
        Self {
            adapter_id: adapter_id.into(),
            source_session_id: source_session_id.into(),
            workspace,
        }
    }
}

wire_enum! {
    /// `ExternalSessionLimit.kind` (`EXTERNAL_SESSION_LIMIT_KINDS`).
    pub enum ExternalSessionLimitKind {
        TranscriptBytes = "transcript_bytes",
        RecordBytes = "record_bytes",
        Records = "records",
        ConvertedBytes = "converted_bytes",
        Messages = "messages",
    }
}

/// `ExternalSessionLimit`: the limit a source went over, and its maximum.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct ExternalSessionLimit {
    pub kind: ExternalSessionLimitKind,
    pub max: u64,
}

/// `ExternalSessionImportResult`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub enum ExternalSessionImportResult {
    /// The task the conversation became.
    Imported { session: Box<SessionCatalogItem> },
    /// The source is over a limit; nothing was written.
    SourceLimitExceeded { limit: ExternalSessionLimit },
    /// A result kind this client does not recognize.
    #[serde(other, skip_serializing)]
    Unknown,
}

/// `external-session.import` (mode `command`).
#[derive(Debug)]
pub enum ExternalSessionImport {}

impl Operation for ExternalSessionImport {
    const NAME: &'static str = "external-session.import";
    type Input = ExternalSessionImportInput;
    type Output = ExternalSessionImportResult;
}

/// `SessionBundleExportInput`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct SessionBundleExportInput {
    pub session_id: String,
    /// An absolute path on the Host; never overwritten.
    pub destination: String,
    /// `sha256` (hex) over the subtree's Session ids, sorted and joined by
    /// newlines, root included: the set the person was told the file holds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_subtree_digest: Option<String>,
}

impl SessionBundleExportInput {
    pub fn new(
        session_id: impl Into<String>,
        destination: impl Into<String>,
        expected_subtree_digest: Option<String>,
    ) -> Self {
        Self {
            session_id: session_id.into(),
            destination: destination.into(),
            expected_subtree_digest,
        }
    }
}

/// `SessionBundleExportResult`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct SessionBundleExportResult {
    /// The task and its subagent descendants.
    pub session_count: u64,
    pub compressed_bytes: u64,
}

/// `session-bundle.export` (mode `command`).
#[derive(Debug)]
pub enum SessionBundleExport {}

impl Operation for SessionBundleExport {
    const NAME: &'static str = "session-bundle.export";
    type Input = SessionBundleExportInput;
    type Output = SessionBundleExportResult;
}

/// `SessionBundleImportInput`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct SessionBundleImportInput {
    /// The `.maka-session` file, an absolute path on the Host.
    pub source: String,
}

impl SessionBundleImportInput {
    pub fn new(source: impl Into<String>) -> Self {
        Self { source: source.into() }
    }
}

/// `SessionBundleImportResult`: counts, not identities.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct SessionBundleImportResult {
    pub session_count: u64,
    pub artifact_files: u64,
}

/// `session-bundle.import` (mode `command`).
#[derive(Debug)]
pub enum SessionBundleImport {}

impl Operation for SessionBundleImport {
    const NAME: &'static str = "session-bundle.import";
    type Input = SessionBundleImportInput;
    type Output = SessionBundleImportResult;
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;

    fn round_trip<T: Serialize + serde::de::DeserializeOwned>(wire: &Value) -> T {
        let decoded: T = serde_json::from_value(wire.clone()).expect("decode");
        assert_eq!(&serde_json::to_value(&decoded).expect("encode"), wire);
        decoded
    }

    #[test]
    fn external_session_queries_encode_as_the_host_decodes_them() {
        assert_eq!(
            serde_json::to_value(ExternalSessionSourceQueryInput::default()).expect("encode"),
            json!({})
        );
        let sources: ExternalSessionSourceQueryResult =
            round_trip(&json!({"adapterIds": ["codex", "claude-code"]}));
        assert_eq!(sources.adapter_ids, ["codex", "claude-code"]);
        assert_eq!(
            serde_json::to_value(ExternalSessionCatalogQueryInput::new(
                "codex",
                false,
                Some("parser".into()),
                Some("c:2".into())
            ))
            .expect("encode"),
            json!({"adapterId": "codex", "includeArchived": false, "text": "parser",
                   "cursor": "c:2"})
        );
        let page: ExternalSessionCatalogQueryResult = round_trip(&json!({
            "sessions": [
                {"id": "rollout-1", "name": "Fix the parser", "hostCwd": "/work/parser",
                 "importState": {"importedCount": 2, "importedSessionIds": ["s2", "s1"],
                                 "isImporting": false},
                 "createdAt": 1, "updatedAt": 2, "archived": true},
                {"id": "rollout-2", "name": "Untitled", "hostCwd": "",
                 "importState": {"importedCount": 0, "importedSessionIds": [],
                                 "isImporting": true}}
            ],
            "nextCursor": "c:3"
        }));
        assert_eq!(page.sessions[0].import_state.imported_session_ids[0], "s2");
        assert_eq!(page.sessions[1].updated_at, None);
    }

    #[test]
    fn an_import_names_the_task_or_the_limit() {
        assert_eq!(
            serde_json::to_value(ExternalSessionImportInput::new(
                "codex",
                "rollout-1",
                Some(WorkspaceTarget::Project { project_id: "p1".into() })
            ))
            .expect("encode"),
            json!({"adapterId": "codex", "sourceSessionId": "rollout-1",
                   "workspace": {"kind": "project", "projectId": "p1"}})
        );
        let limited: ExternalSessionImportResult = round_trip(
            &json!({"kind": "source_limit_exceeded", "limit": {"kind": "messages", "max": 5000}}),
        );
        let ExternalSessionImportResult::SourceLimitExceeded { limit } = limited else {
            panic!("a limit");
        };
        assert_eq!(limit.kind, ExternalSessionLimitKind::Messages);
        let imported: ExternalSessionImportResult = serde_json::from_value(json!({
            "kind": "imported",
            "session": {"kind": "unsupported_legacy_record", "id": "s9", "revision": 1,
                        "reason": "not_wire_representable"}
        }))
        .expect("decode");
        let ExternalSessionImportResult::Imported { session } = imported else {
            panic!("imported");
        };
        assert_eq!(session.id(), "s9");
    }

    #[test]
    fn bundles_encode_and_their_counts_decode() {
        assert_eq!(
            serde_json::to_value(SessionBundleExportInput::new(
                "s1",
                "/tmp/Plan.maka-session",
                Some("ab".repeat(32))
            ))
            .expect("encode"),
            json!({"sessionId": "s1", "destination": "/tmp/Plan.maka-session",
                   "expectedSubtreeDigest": "ab".repeat(32)})
        );
        let exported: SessionBundleExportResult =
            round_trip(&json!({"sessionCount": 3, "compressedBytes": 2048}));
        assert_eq!(exported.session_count, 3);
        assert_eq!(
            serde_json::to_value(SessionBundleImportInput::new("/tmp/x.maka-session"))
                .expect("encode"),
            json!({"source": "/tmp/x.maka-session"})
        );
        let imported: SessionBundleImportResult =
            round_trip(&json!({"sessionCount": 2, "artifactFiles": 5}));
        assert_eq!(imported.artifact_files, 5);
    }
}
