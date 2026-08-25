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

/**
 * Contract for workspace-file-reference IPC (`workspace-files:*`).
 *
 * A reference is the raw text exactly as written in transcript Markdown.
 * All resolution and sandbox-boundary enforcement happens in desktop main
 * against the session's Runtime Host workspace root; the renderer never
 * receives absolute paths, mirroring the artifacts pane contract.
 */

export type WorkspaceFileRefFailureReason =
  | 'invalid_reference'
  | 'not_found'
  | 'outside_workspace'
  | 'unsupported_type'
  | 'too_large'
  | 'read_failed'
  | 'workspace_unavailable';

export type WorkspaceFileTextReadResult =
  | { ok: true; name: string; text: string }
  | { ok: false; reason: WorkspaceFileRefFailureReason };

export type WorkspaceFileOpenResult =
  | { ok: true; opened: string }
  | { ok: false; reason: WorkspaceFileRefFailureReason | 'open-failed' };
