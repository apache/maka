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

import { useEffect, useState } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Selector } from '@astryxdesign/core/Selector';
import { Text } from '@astryxdesign/core/Text';
import { ARCHIVE_RETENTION_DAYS } from '@maka/core/archive-retention';
import { formatAbsoluteTimestamp } from '@maka/core/relative-time';
import type { UiLocale } from '@maka/core/ui-locale';
import type { StorageRetentionQueryResult } from '@maka/runtime-host/protocol';
import { formatBytes, Switch, useMountedRef, useToast, useUiLocale } from '@maka/ui';
import {
  SettingsRow,
  SettingsSection,
  useOptionalRuntimeHostSettingsGenerationKey,
  useOptionalRuntimeHostSettingsTarget,
} from '../../../application/contracts/settings-presentation/index.js';
import {
  type ArchiveRetentionCopy,
  getArchiveRetentionCopy,
} from '../locales/archive-retention-copy.js';
import {
  type ArchiveRetentionChange,
  applyArchiveRetentionChange,
  archiveRetentionConfirm,
} from '../model/archive-retention.js';
import { useOptionalStorageUsageServices } from '../services-context.js';

type RetentionState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly retention: StorageRetentionQueryResult }
  | { readonly status: 'failed' };

/** A reading belongs to one Host generation; another Host's setting is never shown. */
interface ScopedRetention {
  readonly hostKey: string | undefined;
  readonly state: RetentionState;
}

/**
 * Settings › Archived tasks › Automatic cleanup: the selected Runtime Host's
 * opt-in retention for archived tasks. The Host decides and deletes; this
 * section shows the setting, the Host's preview and what the last sweep did,
 * and changes the setting only after a confirm that states the preview.
 */
export function ArchiveRetentionSection() {
  const host = useOptionalRuntimeHostSettingsTarget();
  const hostKey = useOptionalRuntimeHostSettingsGenerationKey();
  const services = useOptionalStorageUsageServices();
  const toast = useToast();
  const locale = useUiLocale();
  const copy = getArchiveRetentionCopy(locale);
  const mountedRef = useMountedRef();
  const [scoped, setScoped] = useState<ScopedRetention>({ hostKey, state: { status: 'loading' } });
  const [attempt, setAttempt] = useState(0);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!host || !services) return;
    let current = true;
    services.loadRetention(host, {}).then(
      (retention) => {
        if (current) setScoped({ hostKey, state: { status: 'ready', retention } });
      },
      () => {
        if (current) setScoped({ hostKey, state: { status: 'failed' } });
      },
    );
    return () => {
      current = false;
    };
  }, [attempt, host, hostKey, services]);

  if (!host || !services) return null;
  const state: RetentionState = scoped.hostKey === hostKey ? scoped.state : { status: 'loading' };
  const retention = state.status === 'ready' ? state.retention : undefined;

  async function change(next: ArchiveRetentionChange) {
    if (!host || !services || !retention) return;
    setSaving(true);
    try {
      const result = await applyArchiveRetentionChange({
        services,
        host,
        current: retention,
        next,
        confirm: (preview, applied) =>
          toast.confirm(
            archiveRetentionConfirm({ copy, locale, current: retention, change: applied, preview }),
          ),
      });
      if (result.kind === 'conflict') toast.warning(copy.conflict);
      if (result.kind !== 'cancelled' && mountedRef.current) setAttempt((value) => value + 1);
    } catch {
      toast.error(copy.saveFailed);
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  }

  return (
    <SettingsSection title={copy.title} description={copy.help}>
      {state.status === 'failed' ? (
        <Banner status="error" role="alert" title={copy.loadFailed} />
      ) : null}
      {retention?.lastSweep?.paused ? (
        <Banner status="warning" title={copy.paused} />
      ) : null}
      <SettingsRow
        label={copy.enable}
        description={retention ? retentionSummary(retention, copy, locale) : copy.enableHelp}
        align="start"
        end={(
          <Switch
            label={copy.enable}
            isLabelHidden
            value={retention?.enabled ?? false}
            isDisabled={!retention || saving}
            changeAction={(enabled) =>
              retention ? change({ enabled, days: retention.days }) : undefined
            }
          />
        )}
      />
      <SettingsRow
        label={copy.days}
        description={copy.daysHelp}
        end={(
          <Selector
            label={copy.days}
            isLabelHidden
            size="sm"
            value={String(retention?.days ?? ARCHIVE_RETENTION_DAYS[0])}
            isDisabled={!retention || saving}
            options={ARCHIVE_RETENTION_DAYS.map((days) => ({
              value: String(days),
              label: copy.dayOption(days),
            }))}
            onChange={(value) => {
              const days = ARCHIVE_RETENTION_DAYS.find((option) => String(option) === value);
              if (retention && days !== undefined && days !== retention.days) {
                void change({ enabled: retention.enabled, days });
              }
            }}
          />
        )}
      />
      {retention ? <RetentionResults retention={retention} copy={copy} locale={locale} /> : null}
    </SettingsSection>
  );
}

function retentionSummary(
  retention: StorageRetentionQueryResult,
  copy: ArchiveRetentionCopy,
  locale: UiLocale,
): string {
  const preview = retention.preview;
  if (!retention.enabled || !preview) return copy.enableHelp;
  return preview.count === 0 || preview.eligibleAt === undefined
    ? copy.previewNone
    : copy.preview(preview.count, formatAbsoluteTimestamp(preview.eligibleAt, locale));
}

function RetentionResults(props: {
  readonly retention: StorageRetentionQueryResult;
  readonly copy: ArchiveRetentionCopy;
  readonly locale: UiLocale;
}) {
  const { lastDeletion, lastSweep } = props.retention;
  const needsReview = lastSweep?.paused ? 0 : (lastSweep?.needsReview ?? 0);
  if (!lastDeletion && needsReview === 0) return null;
  return (
    <>
      {lastDeletion ? (
        <Text type="supporting" size="sm" color="secondary">
          {props.copy.lastCleanup(
            lastDeletion.count,
            lastDeletion.bytes === undefined ? undefined : formatBytes(lastDeletion.bytes, props.locale),
            formatAbsoluteTimestamp(lastDeletion.at, props.locale),
          )}
        </Text>
      ) : null}
      {needsReview > 0 ? (
        <Text type="supporting" size="sm" color="secondary">
          {props.copy.needsReview(needsReview)}
        </Text>
      ) : null}
    </>
  );
}
