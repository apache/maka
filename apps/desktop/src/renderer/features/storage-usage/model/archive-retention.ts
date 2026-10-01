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

import type { ArchiveRetentionDays } from '@maka/core/archive-retention';
import { formatAbsoluteTimestamp } from '@maka/core/relative-time';
import type { UiLocale } from '@maka/core/ui-locale';
import type {
  StorageRetentionPreview,
  StorageRetentionSetting,
} from '@maka/runtime-host/protocol';
import type { ConfirmInput } from '@maka/ui';
import type { ArchiveRetentionCopy } from '../locales/archive-retention-copy.js';
import type { StorageUsageHostTarget, StorageUsageServices } from '../ports.js';

export interface ArchiveRetentionChange {
  readonly enabled: boolean;
  readonly days: ArchiveRetentionDays;
}

export type ArchiveRetentionChangeResult =
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'committed'; readonly setting: StorageRetentionSetting }
  /** The setting moved on the Host since it was read; read it again. */
  | { readonly kind: 'conflict' };

/** The confirm a change that starts the clock asks, stating the Host's preview. */
export function archiveRetentionConfirm(input: {
  readonly copy: ArchiveRetentionCopy;
  readonly locale: UiLocale;
  readonly current: StorageRetentionSetting;
  readonly change: ArchiveRetentionChange;
  readonly preview: StorageRetentionPreview;
}): ConfirmInput {
  const { copy, preview } = input;
  return {
    title: input.current.enabled ? copy.confirmChangeTitle : copy.confirmEnableTitle,
    description: copy.confirmDescription(
      input.change.days,
      preview.count,
      preview.eligibleAt === undefined
        ? undefined
        : formatAbsoluteTimestamp(preview.eligibleAt, input.locale),
    ),
    confirmLabel: input.current.enabled ? copy.confirmChange : copy.confirmEnable,
    cancelLabel: copy.cancel,
    destructive: true,
  };
}

/**
 * Applies one change to a Host's retention setting. A change that starts the
 * clock — enabling, or new days while enabled — is confirmed first with the
 * Host's own preview of what it would cover; turning the setting off, or
 * picking days while it is off, deletes nothing and is applied directly.
 */
export async function applyArchiveRetentionChange(input: {
  readonly services: Pick<StorageUsageServices, 'loadRetention' | 'setRetention'>;
  readonly host: StorageUsageHostTarget;
  readonly current: StorageRetentionSetting;
  readonly next: ArchiveRetentionChange;
  readonly confirm: (preview: StorageRetentionPreview, change: ArchiveRetentionChange) => Promise<boolean>;
}): Promise<ArchiveRetentionChangeResult> {
  const { current, next } = input;
  if (next.enabled) {
    const { preview } = await input.services.loadRetention(input.host, { previewDays: next.days });
    if (!(await input.confirm(preview ?? { count: 0 }, next))) return { kind: 'cancelled' };
  }
  const result = await input.services.setRetention(input.host, {
    expectedRevision: current.revision,
    enabled: next.enabled,
    days: next.days,
  });
  return result.kind === 'committed'
    ? { kind: 'committed', setting: result.setting }
    : { kind: 'conflict' };
}
