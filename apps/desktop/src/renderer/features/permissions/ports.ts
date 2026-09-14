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

import type {
  CapabilitySnapshotCollection,
  OsPermissionId,
  PermissionSnapshot,
} from '@maka/core/capabilities';
import type { SettingsHostTarget } from '../../application/contracts/settings-presentation/runtime-host-settings-target.js';

type PermissionActionResult =
  | { ok: true }
  | { ok: false; reason: string; message?: string };

export interface PermissionCenterServices {
  /** OS grants belong to this Desktop, independent of the selected Host. */
  permissions: {
    getSnapshot(): Promise<PermissionSnapshot>;
    requestAccess(id: OsPermissionId): Promise<PermissionActionResult>;
    openSystemSettings(id: OsPermissionId): Promise<PermissionActionResult>;
    startDragOnboarding(id: OsPermissionId): Promise<PermissionActionResult>;
  };
  /** Optional diagnostics use an explicit Host, never a local-permission target. */
  capabilities: {
    getSnapshot(host: SettingsHostTarget): Promise<CapabilitySnapshotCollection>;
  };
}
