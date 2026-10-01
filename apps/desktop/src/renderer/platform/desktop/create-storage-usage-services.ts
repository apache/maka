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

import type { MakaBridge } from '../../../preload/bridge-contract.js';
import type { StorageUsageServices } from '../../features/storage-usage';

export type DesktopStorageUsageBridge = Pick<MakaBridge, 'storage'>;

/** Binds the storage usage feature to the Desktop bridge. */
export function createDesktopStorageUsageServices(
  bridge: DesktopStorageUsageBridge = window.maka,
): StorageUsageServices {
  return {
    loadRetention: (host) => bridge.storage.retentionQuery(host),
    setRetention: (host, input) => bridge.storage.retentionSet(input, host),
    loadUsage: (host) => bridge.storage.usage(host),
    // No host argument: each task is measured by the Host that holds it, and
    // the bridge routes by the projected id for exactly that reason.
    loadSessionUsage: (sessionIds) => bridge.storage.sessionUsage(sessionIds),
  };
}
