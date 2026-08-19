/**
 * Workspace config types.
 */

import type { PersistedBackendKind } from './session.js';
import type { PermissionMode } from './permission.js';

export interface WorkspaceConfig {
  id: string;
  name: string;
  /** Absolute path: ~/.maka/workspaces/{id}/ */
  rootPath: string;
  createdAt: number;
  defaults: {
    permissionMode: PermissionMode;
    backend: PersistedBackendKind;
    llmConnectionSlug?: string;
    model?: string;
  };
}
