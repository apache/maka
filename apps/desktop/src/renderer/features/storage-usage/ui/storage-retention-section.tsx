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

import { useEffect, useRef, useState } from 'react';
import { Button, Selector, Switch, formatBytes, useUiLocale } from '@maka/ui';
import { RETENTION_DAYS, type StorageRetentionQueryResult, type RetentionDays } from '@maka/runtime-host/protocol';
import { SettingsRow, SettingsSection, useOptionalRuntimeHostSettingsGenerationKey, useOptionalRuntimeHostSettingsTarget } from '../../../application/contracts/settings-presentation/index.js';
import { getStorageRetentionCopy } from '../../../locales/storage-retention-copy.js';
import { useOptionalStorageUsageServices } from '../services-context.js';

export function StorageRetentionSection() {
  const host = useOptionalRuntimeHostSettingsTarget();
  const hostKey = useOptionalRuntimeHostSettingsGenerationKey();
  const services = useOptionalStorageUsageServices();
  const locale = useUiLocale(); const copy = getStorageRetentionCopy(locale);
  const [snapshot, setSnapshot] = useState<{ key: string | undefined; result: StorageRetentionQueryResult }>();
  const [failed, setFailed] = useState(false); const [saving, setSaving] = useState(false); const [attempt, setAttempt] = useState(0);
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current; setFailed(false); setSaving(false);
    if (!host || !services?.loadRetention) return;
    services.loadRetention(host).then(result => {
      if (generation.current === current) setSnapshot({ key: hostKey, result });
    }, () => { if (generation.current === current) setFailed(true); });
    return () => { generation.current++; };
  }, [host, hostKey, services, attempt]);
  if (!host || !services?.loadRetention || !services.setRetention) return null;
  const result = snapshot && snapshot.key === hostKey ? snapshot.result : undefined;
  const disabled = !result || saving || failed;
  async function save(enabled: boolean, days: RetentionDays) {
    if (!host || !result || !services?.setRetention) return;
    const current = generation.current; setSaving(true);
    try {
      const policy = await services.setRetention(host, { enabled, days, expectedRevision: result.policy.revision });
      if (generation.current === current) {
        setSnapshot({ key: hostKey, result: { ...result, policy } });
        setAttempt(value => value + 1);
      }
    } catch { if (generation.current === current) setFailed(true); }
    finally { if (generation.current === current) setSaving(false); }
  }
  const date = (time: number) => new Date(time).toLocaleString(locale);
  return <SettingsSection title={copy.title} description={copy.help} action={<Button size="sm" variant="ghost" isDisabled={saving} label={copy.refresh} onClick={() => setAttempt(value => value + 1)} />}>
    <SettingsRow label={copy.enabled} end={<Switch label={copy.enabled} isLabelHidden value={result?.policy.enabled ?? false} isDisabled={disabled} onChange={enabled => void save(enabled, result?.policy.days ?? 30)} />} />
    <SettingsRow label={copy.days} end={<Selector label={copy.days} isLabelHidden value={String(result?.policy.days ?? 30)} options={RETENTION_DAYS.map(days => ({ value: String(days), label: copy.dayOption(days) }))} isDisabled={disabled} onChange={days => void save(result?.policy.enabled ?? false, Number(days) as RetentionDays)} />} />
    <SettingsRow label={failed ? copy.failed : !result ? copy.loading : result.preview.eligibleAt === null ? copy.disabled : copy.preview(result.preview.count, date(result.preview.eligibleAt))} />
    {result?.lastDeletion && <SettingsRow label={copy.cleanup(result.lastDeletion.count, result.lastDeletion.estimatedBytes === null ? copy.unknownBytes : formatBytes(result.lastDeletion.estimatedBytes, locale), date(result.lastDeletion.at))} />}
    {result?.lastSweep && <SettingsRow label={copy.needsReview(result.lastSweep.needsReview)} />}
  </SettingsSection>;
}
