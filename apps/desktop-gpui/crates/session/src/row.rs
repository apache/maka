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

//! What the sidebar shows for one session.

use gpui_kit::SharedString;
use host_protocol::{SessionCatalogItem, SessionCatalogProjection, SessionStatus, WorkspaceTarget};

/// A presentation snapshot of one catalog session, built once per catalog
/// load so rendering never walks the protocol types.
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub struct SessionRow {
    pub id: SharedString,
    /// The catalog projection's revision, which metadata commands send as
    /// their expected revision.
    pub revision: u64,
    pub name: SharedString,
    /// The session's working directory on the Host.
    pub workspace_path: SharedString,
    /// The registered project the session runs in, when its workspace
    /// names one (`WorkspaceTarget::Project`).
    pub project_id: Option<SharedString>,
    pub status: SessionStatus,
    /// A turn is running (status `running`, or a live run state that lists
    /// running turns).
    pub is_running: bool,
    /// The task waits on the user (a permission or boundary prompt): an
    /// `attention` state, never drawn as `active` (DESIGN.md §9).
    pub is_waiting: bool,
    /// The last activity, in milliseconds since the Unix epoch.
    pub activity_at: u64,
    pub is_flagged: bool,
    /// Archived tasks leave the main list for its Archived group.
    pub is_archived: bool,
}

impl SessionRow {
    /// The row for a catalog item, or `None` for items the sidebar does not
    /// list: legacy records the Host cannot represent and subagent sessions
    /// (they belong under their parent, Phase 2). Archived sessions are
    /// listed, marked [`Self::is_archived`].
    pub fn from_item(item: &SessionCatalogItem) -> Option<Self> {
        match item {
            SessionCatalogItem::Session(session) => Self::from_projection(session),
            SessionCatalogItem::UnsupportedLegacy(_) => None,
        }
    }

    fn from_projection(session: &SessionCatalogProjection) -> Option<Self> {
        if session.parent_session_id.is_some() || session.subagent.is_some() {
            return None;
        }
        let is_waiting = session.status == SessionStatus::WaitingForUser;
        let is_running = !is_waiting && session.status == SessionStatus::Running
            || session
                .live_run_state
                .as_ref()
                .is_some_and(|state| !state.running_turn_ids.is_empty());
        let project_id = match &session.workspace.target {
            WorkspaceTarget::Project { project_id } => Some(project_id.clone().into()),
            _ => None,
        };
        Some(Self {
            id: session.id.clone().into(),
            revision: session.revision,
            name: session.name.clone().into(),
            workspace_path: session.workspace.host_cwd.clone().into(),
            project_id,
            status: session.status.clone(),
            is_running,
            is_waiting,
            activity_at: session.activity_at,
            is_flagged: session.is_flagged,
            is_archived: session.is_archived,
        })
    }

    /// The last component of the workspace path: the folder by name.
    pub fn workspace_name(&self) -> &str {
        workspace::folder_name(&self.workspace_path)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;

    pub(crate) fn projection(id: &str, name: &str) -> Value {
        json!({
            "id": id, "revision": 1,
            "workspace": {"target": {"kind": "host_path", "path": "/work/demo"}, "hostCwd": "/work/demo"},
            "createdAt": 1, "activityAt": 2, "name": name, "isFlagged": false, "isArchived": false,
            "labels": [], "labelsTruncated": false, "hasUnread": false, "status": "active",
            "backend": "ai-sdk", "llmConnectionId": null, "llmConnectionSlug": "env",
            "connectionLocked": false, "model": "m", "permissionMode": "ask",
            "collaborationMode": "agent", "orchestrationMode": "default"
        })
    }

    fn item(value: Value) -> SessionCatalogItem {
        serde_json::from_value(value).expect("catalog item")
    }

    #[test]
    fn a_plain_session_becomes_a_row() {
        let row = SessionRow::from_item(&item(projection("s1", "Plan"))).expect("row");
        assert_eq!(row.id, "s1");
        assert_eq!(row.name, "Plan");
        assert_eq!(row.workspace_name(), "demo");
        assert_eq!(row.activity_at, 2);
        assert!(!row.is_running);
    }

    #[test]
    fn subagent_and_legacy_items_are_not_listed() {
        let mut child = projection("s2", "b");
        child["parentSessionId"] = json!("s0");
        let legacy = json!({"kind": "unsupported_legacy_record", "id": "old", "revision": 1,
                            "reason": "not_wire_representable"});
        for value in [child, legacy] {
            assert_eq!(SessionRow::from_item(&item(value)), None);
        }
    }

    #[test]
    fn archived_flagged_and_project_sessions_are_marked() {
        let mut value = projection("s1", "a");
        value["isArchived"] = json!(true);
        value["isFlagged"] = json!(true);
        value["revision"] = json!(7);
        value["workspace"]["target"] = json!({"kind": "project", "projectId": "p1"});
        let row = SessionRow::from_item(&item(value)).expect("row");
        assert!(row.is_archived && row.is_flagged);
        assert_eq!(row.revision, 7);
        assert_eq!(row.project_id.as_deref(), Some("p1"));
        assert_eq!(row.workspace_path, "/work/demo");
    }

    #[test]
    fn a_live_run_or_a_running_status_reads_as_running() {
        let mut live = projection("s1", "a");
        live["liveRunState"] = json!({"schemaVersion": 1, "runningTurnIds": ["t1"]});
        let mut status = projection("s2", "b");
        status["status"] = json!("running");
        for value in [live, status] {
            assert!(SessionRow::from_item(&item(value)).expect("row").is_running);
        }
    }
}
