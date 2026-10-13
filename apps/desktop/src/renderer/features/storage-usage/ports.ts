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
  SessionStorageUsage,
  StorageRetentionQueryResult,
  StorageRetentionSetInput,
  StorageRetentionSetResult,
  StorageUsageQueryResult,
} from '@maka/runtime-host/protocol';

/** The Runtime Host a Settings page is pointed at, stated structurally. */
export interface StorageUsageHostTarget {
  readonly profileId: string;
  readonly hostId: string;
}

/**
 * What the storage usage feature needs from the Desktop: two read-only
 * measurements, and one Host's archived-task retention setting. Nothing here
 * deletes data itself; a Host with retention enabled does that on its own.
 */
export interface StorageUsageServices {
  /** Available in the application shell; isolated Settings fixtures need no observer. */
  readonly notices?: RetentionNoticeServices;
  /** One Runtime Host's State Root footprint. */
  loadUsage(host: StorageUsageHostTarget): Promise<StorageUsageQueryResult>;
  /**
   * Per-task storage keyed by Desktop session id. A task whose Host cannot be
   * reached is absent rather than failing the rest.
   */
  loadSessionUsage(
    sessionIds: readonly string[],
  ): Promise<Readonly<Record<string, SessionStorageUsage>>>;
  /** One Host's retention setting, its preview and its latest results. */
  loadRetention(host: StorageUsageHostTarget): Promise<StorageRetentionQueryResult>;
  /** The Desktop's only way to change that setting. */
  setRetention(
    host: StorageUsageHostTarget,
    input: StorageRetentionSetInput,
  ): Promise<StorageRetentionSetResult>;
}

export interface RetentionNoticeHost extends StorageUsageHostTarget {
  readonly name: string;
}

export interface RetentionNoticeState {
  readonly deletionAt?: number;
  readonly warning?: string;
  /** Unlike announcement, viewing the warning in Settings retires its toast. */
  readonly acknowledgedWarning?: string;
  /** Client time, used only to limit reminders during a long cleanup backlog. */
  readonly notifiedAt?: number;
}

export interface RetentionNoticeServices {
  /** Already-connected Hosts only; observing never starts or enables a Host. */
  loadHosts(): Promise<readonly RetentionNoticeHost[]>;
  subscribeChanges(handler: () => void): () => void;
  isVisible(): boolean;
  readSeen(hostId: string): unknown;
  writeSeen(hostId: string, state: RetentionNoticeState): void;
}
