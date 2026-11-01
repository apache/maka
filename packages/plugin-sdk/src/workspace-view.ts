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

import type { AgentAttachmentImageRead, AgentToolImageRead } from './generated/runtime.js';
import { defineUiViewContract } from './workbench.js';

export interface WorkspaceFocusTarget {
  focus(): void;
}

export interface WorkspaceImagePreview {
  readonly source:
    | { kind: 'tool-image'; read: AgentToolImageRead }
    | { kind: 'attachment-image'; read: AgentAttachmentImageRead };
  readonly uri: string;
  readonly width: number;
  readonly height: number;
  restoreFocus?(): boolean;
}

/** Session actions address the workspace owner's resources without retaining its models. */
export interface WorkspaceActions {
  openFiles(target: { sessionId: string }): void;
  openImage(image: WorkspaceImagePreview): void;
  openLink(sessionId: string, target: string, restoreFocus: () => boolean): Promise<void>;
  attachOpener(sessionId: string, node: WorkspaceFocusTarget): void;
}

export interface WorkspaceViewHandle extends WorkspaceActions {
  shown(): boolean;
  hide(): void;
  close(): void;
  focused(): boolean;
  modalSuppressed(): boolean;
}

export interface WorkspaceViewInput {
  /** Mounted conversation identities; each resource request carries its own source. */
  sessions(): readonly string[];
  blocked(): boolean;
  readonly surface: 'pane' | 'overlays';
  readonly docked: boolean;
  report(reason: unknown): void;
  attach(handle: WorkspaceViewHandle): void;
}

export const workspaceViewContract = defineUiViewContract<WorkspaceViewInput>(
  'maka.workspace.preview.v2',
);
