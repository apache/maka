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

import { useEffect, useEffectEvent } from 'react';
import { ARCHIVE_RETENTION_DAY_MS } from '@maka/core/archive-retention';
import { formatAbsoluteTimestamp } from '@maka/core/relative-time';
import type { SettingsSection } from '@maka/core/settings';
import { formatBytes, useToast, useUiLocale } from '@maka/ui';
import { getArchiveRetentionCopy } from '../locales/archive-retention-copy.js';
import { observeRetentionNotices, type RetentionNotice } from '../model/retention-notices.js';
import type { RetentionNoticeHost } from '../ports.js';
import { useOptionalStorageUsageServices } from '../services-context.js';

/** Shell observer: independent of whether Storage settings is open. */
export function ArchiveRetentionNotices(props: {
  readonly navigation: {
    setSettingsProfileId(profileId: string): void;
    openSettingsSection(section: SettingsSection): void;
  };
}) {
  const services = useOptionalStorageUsageServices();
  const toast = useToast();
  const locale = useUiLocale();
  const copy = getArchiveRetentionCopy(locale);
  const notify = useEffectEvent((host: RetentionNoticeHost, notice: RetentionNotice) => {
    const description = notice.kind === 'deletion'
      ? copy.lastCleanup(
          notice.deletion.count,
          notice.deletion.bytes === undefined ? undefined : formatBytes(notice.deletion.bytes),
          formatAbsoluteTimestamp(notice.deletion.at, locale),
        )
      : notice.kind === 'hold'
        ? copy.held(
            formatAbsoluteTimestamp(notice.hold.until, locale),
            Math.max(1, Math.round((notice.hold.detectedAt - notice.hold.since) / ARCHIVE_RETENTION_DAY_MS)),
          )
        : copy.paused;
    const id = toast.toast({
      title: copy.noticeTitle(host.name),
      diagnosticTarget: { profileId: host.profileId },
      description,
      variant: notice.kind === 'deletion' ? 'info' : 'warning',
      duration: notice.kind === 'deletion' ? 12_000 : 0,
      action: { label: copy.viewArchivedTasks, onClick: () => {
        props.navigation.setSettingsProfileId(host.profileId);
        props.navigation.openSettingsSection('archived-tasks');
      } },
    });
    return () => toast.dismiss(id);
  });
  useEffect(() => {
    if (!services?.notices) return;
    return observeRetentionNotices({ services: { ...services, notices: services.notices }, notify });
  }, [services]);
  return null;
}
