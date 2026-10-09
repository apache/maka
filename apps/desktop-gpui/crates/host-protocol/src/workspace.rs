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

//! Workspace targets and projections.
//!
//! Source: `packages/runtime-host/src/protocol/workspace.ts`
//! (`decodeWorkspaceTarget`, `decodeWorkspaceProjection`).

use serde::{Deserialize, Serialize};

/// `WorkspaceTarget`: where a Session runs.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub enum WorkspaceTarget {
    /// A registered project.
    #[serde(rename_all = "camelCase")]
    Project { project_id: String },
    /// An absolute directory on the Host.
    HostPath { path: String },
    /// A target kind this client does not recognize. The payload is dropped;
    /// a recognized kind with a malformed body is still a decode error.
    #[serde(other, skip_serializing)]
    Unknown,
}

/// `WorkspaceProjection`: the target plus the resolved Host directory.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct WorkspaceProjection {
    pub target: WorkspaceTarget,
    /// Absolute path on the Host. Equals `target.path` for `host_path`.
    pub host_cwd: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn targets_decode_by_kind() {
        let project: WorkspaceTarget =
            serde_json::from_value(json!({"kind": "project", "projectId": "p1"})).expect("decode");
        assert_eq!(project, WorkspaceTarget::Project { project_id: "p1".into() });
        let path: WorkspaceTarget =
            serde_json::from_value(json!({"kind": "host_path", "path": "/w"})).expect("decode");
        assert_eq!(path, WorkspaceTarget::HostPath { path: "/w".into() });
    }

    #[test]
    fn unknown_target_kind_is_tolerated() {
        let target: WorkspaceTarget =
            serde_json::from_value(json!({"kind": "remote_path", "uri": "x"})).expect("decode");
        assert_eq!(target, WorkspaceTarget::Unknown);
        let malformed = serde_json::from_value::<WorkspaceTarget>(json!({"kind": "project"}));
        assert!(malformed.is_err());
    }

    #[test]
    fn project_target_encodes_camel_case() {
        let target = WorkspaceTarget::Project { project_id: "p1".into() };
        assert_eq!(
            serde_json::to_value(&target).expect("encode"),
            json!({"kind": "project", "projectId": "p1"})
        );
    }
}
