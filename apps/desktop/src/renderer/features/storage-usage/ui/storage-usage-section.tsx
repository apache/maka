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
import { Button, formatBytes, useUiLocale } from '@maka/ui';
import { STORAGE_USAGE_KINDS, type StorageUsageQueryResult } from '@maka/runtime-host/protocol';
import {
  SettingsRow,
  SettingsSection,
  useOptionalRuntimeHostSettingsGenerationKey,
  useOptionalRuntimeHostSettingsTarget,
} from '../../../application/contracts/settings-presentation/index.js';
import { getStorageUsageCopy } from '../../../locales/storage-usage-copy.js';
import { useOptionalStorageUsageServices } from '../services-context.js';

type Measurement =
  | { readonly status: 'loading'; readonly previous?: StorageUsageQueryResult }
  | { readonly status: 'ready'; readonly usage: StorageUsageQueryResult }
  | { readonly status: 'failed' };

/** Measurements belong to one Host generation; another Host's numbers are never shown. */
interface ScopedMeasurement {
  readonly hostKey: string | undefined;
  readonly measurement: Measurement;
}

/**
 * Settings · Data · Storage: what the selected Runtime Host's data occupies.
 * Read-only by design; it offers no action that deletes or compacts data.
 */
export function StorageUsageSection(props: { readonly hostVerified: boolean }) {
  const host = useOptionalRuntimeHostSettingsTarget();
  const hostKey = useOptionalRuntimeHostSettingsGenerationKey();
  const services = useOptionalStorageUsageServices();
  const locale = useUiLocale();
  const copy = getStorageUsageCopy(locale);
  const [scoped, setScoped] = useState<ScopedMeasurement>({
    hostKey,
    measurement: { status: 'loading' },
  });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!host || !services || !props.hostVerified) return;
    let current = true;
    setScoped((previous) => ({
      hostKey,
      measurement: {
        status: 'loading',
        // A refresh keeps the last figures on screen; a new Host starts empty.
        ...(previous.hostKey === hostKey && previous.measurement.status === 'ready'
          ? { previous: previous.measurement.usage }
          : {}),
      },
    }));
    services.loadUsage(host).then(
      (usage) => {
        if (current) setScoped({ hostKey, measurement: { status: 'ready', usage } });
      },
      () => {
        if (current) setScoped({ hostKey, measurement: { status: 'failed' } });
      },
    );
    return () => {
      current = false;
    };
  }, [attempt, host, hostKey, props.hostVerified, services]);

  if (!host || !services) return null;
  const measurement: Measurement =
    scoped.hostKey === hostKey ? scoped.measurement : { status: 'loading' };
  const usage =
    measurement.status === 'ready'
      ? measurement.usage
      : measurement.status === 'loading'
        ? measurement.previous
        : undefined;
  const size = (bytes: number, exact: boolean) => {
    const formatted = formatBytes(bytes, locale);
    return exact ? formatted : copy.approximately(formatted);
  };
  const totals = usage
    ? STORAGE_USAGE_KINDS.flatMap((kind) => usage.totals.filter((total) => total.kind === kind))
    : [];
  const totalBytes = totals.reduce((sum, total) => sum + total.bytes, 0);
  const placeholder = measurement.status === 'failed' ? copy.loadFailed : copy.loading;

  return (
    <SettingsSection
      title={copy.title}
      description={copy.help}
      action={(
        <Button
          variant="ghost"
          size="sm"
          label={copy.refresh}
          isDisabled={!props.hostVerified}
          isLoading={measurement.status === 'loading' && props.hostVerified}
          onClick={() => setAttempt((value) => value + 1)}
        />
      )}
    >
      {measurement.status === 'failed' ? (
        <Banner status="error" role="alert" title={copy.loadFailed} />
      ) : null}
      <SettingsRow
        label={copy.total}
        description={copy.totalDetail}
        align="start"
        end={(
          <span className="settingsReadOnlyValue">
            {usage ? size(totalBytes, totals.every((total) => total.exact)) : placeholder}
          </span>
        )}
      />
      {totals.map((total) => (
        <SettingsRow
          key={total.kind}
          label={copy.kinds[total.kind].label}
          description={copy.kinds[total.kind].detail}
          align="start"
          end={<span className="settingsReadOnlyValue">{size(total.bytes, total.exact)}</span>}
        />
      ))}
      {usage ? (
        <>
          <SettingsRow
            label={copy.reclaimable}
            description={copy.reclaimableDetail}
            align="start"
            end={(
              <span className="settingsReadOnlyValue">
                {formatBytes(usage.reclaimableBytes, locale)}
              </span>
            )}
          />
          <SettingsRow
            label={copy.worktrees}
            description={copy.worktreesDetail}
            align="start"
            end={(
              <span className="settingsReadOnlyValue">
                {copy.worktreeCount(usage.worktreeCount)}
              </span>
            )}
          />
        </>
      ) : null}
    </SettingsSection>
  );
}
