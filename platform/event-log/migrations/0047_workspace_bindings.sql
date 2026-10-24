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

-- A canonical selection is shared by an owner's Sessions. Existing identities
-- may converge after relocation; references never require a Session-wide rewrite.
CREATE TABLE workspace_bindings (
    id TEXT PRIMARY KEY,
    owner_scope TEXT NOT NULL,
    selection_digest TEXT NOT NULL,
    workspace_json TEXT NOT NULL CHECK(json_valid(workspace_json)),
    permission_epoch INTEGER NOT NULL CHECK(permission_epoch BETWEEN 0 AND 9007199254740991),
    metadata_epoch INTEGER NOT NULL CHECK(metadata_epoch BETWEEN 0 AND 9007199254740991)
) WITHOUT ROWID;
CREATE INDEX workspace_bindings_selection ON workspace_bindings(owner_scope,selection_digest,id);
CREATE INDEX workspace_bindings_project ON workspace_bindings(owner_scope,json_extract(workspace_json,'$.projectId'),id);
CREATE INDEX workspace_bindings_path ON workspace_bindings(json_extract(workspace_json,'$.path'),id);
CREATE INDEX workspace_bindings_identity ON workspace_bindings(json_extract(workspace_json,'$.identity'),id);
CREATE INDEX session_workspace_binding ON session_control(json_extract(configuration,'$.workspace.id'),id);
-- A relink checks the maximum effective revision with one index seek per binding,
-- rather than reading all member Sessions to check arithmetic overflow.
CREATE INDEX session_binding_metadata_headroom ON session_control(
    json_extract(configuration,'$.workspace.id'),
    revision-json_extract(configuration,'$.workspace.metadataEpochAtAttach') DESC
);
CREATE INDEX session_binding_permission_headroom ON session_control(
    json_extract(configuration,'$.workspace.id'),
    json_extract(configuration,'$.boundary_revision')-json_extract(configuration,'$.workspace.permissionEpochAtAttach') DESC
);
