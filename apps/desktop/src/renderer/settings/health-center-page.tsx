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
import type {
  HealthSignal,
  HealthSignalLayer,
  HealthSnapshot,
} from '@maka/core/health';
import { HEALTH_SIGNAL_LAYERS } from '@maka/core/health';
import { Text, VStack } from '@astryxdesign/core';
import { Button, RelativeTime, StatusDot, useUiLocale, Banner } from '@maka/ui';
import { getHealthCenterCopy, type HealthCenterCopy } from '../locales/settings-health-copy';
import { settingsActionErrorMessage } from './settings-error-copy';
import { SettingsPage, SettingsRow, SettingsSection } from './settings-section';
import { SettingsSkeletonStack } from './settings-skeleton';
import { dotForStatus } from '@maka/ui';
import { useRuntimeHostSettingsTarget } from './runtime-host-settings-target.js';

/**
 * PR-UI-9 — Health Center read-only page. Consumes `window.maka.health.getSnapshot()`
 * (shipped by @xuan PR-HC-1).
 *
 * Hard contract (per @xuan): "validation/config/permission/runtime 别聚成
 * 一个绿点". The UI groups signals by `layer` and renders each in its own
 * section so the user sees WHICH layer is okay and WHICH is degraded.
 *
 * Status semantics ≠ tone-by-color only. `ok` (validation pass) on an LLM
 * connection does NOT promote it to operational — that requires a runtime
 * probe in PR-REAL-4. The detail copy below makes the distinction explicit.
 *
 * Read-only boundary: no test buttons, no repair flows. Test/repair entries
 * will be wired in PR-HC-2 once typed actions are exposed.
*/
export function HealthCenterPage() {
  const host = useRuntimeHostSettingsTarget();
  const locale = useUiLocale();
  const copy = getHealthCenterCopy(locale);
  const [snapshot, setSnapshot] = useState<HealthSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    window.maka.health
      .getSnapshot(host)
      .then((next) => {
        if (cancelled) return;
        setSnapshot(next);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(settingsActionErrorMessage(err, locale));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [host, locale, refreshTick]);

  if (loading) {
    return (
      <SettingsSkeletonStack label={copy.loading} />
    );
  }

  if (error || !snapshot) {
    return (
      <SettingsPage>
        <Banner
          status="error"
          title={copy.readFailed}
          description={error ?? copy.noData}
          endContent={<Button variant="primary" onClick={() => setRefreshTick((tick) => tick + 1)} label={copy.readAgain} />} />
      </SettingsPage>
    );
  }

  const healthCheckedAtMs = snapshot.checkedAt;
  const signalsByLayer = groupSignalsByLayer(snapshot.signals);
  const blocksSendCount = snapshot.signals.filter((signal) => signal.blocksSend).length;
  const blocksCapabilityCount = snapshot.signals.filter((signal) => signal.blocksCapability).length;
  const summaryParts: Array<{ key: string; label: string; count: number; tone: 'neutral' | 'warning' | 'destructive' }> = [
    { key: 'ok', label: copy.statuses.ok.label, count: snapshot.summary.ok, tone: 'neutral' },
    { key: 'info', label: copy.statuses.info.label, count: snapshot.summary.info, tone: 'neutral' },
    { key: 'warning', label: copy.statuses.warning.label, count: snapshot.summary.warning, tone: 'warning' },
    { key: 'error', label: copy.statuses.error.label, count: snapshot.summary.error, tone: 'destructive' },
    { key: 'unknown', label: copy.statuses.unknown.label, count: snapshot.summary.unknown, tone: 'neutral' },
  ];

  return (
    <SettingsPage>
      <SettingsSection
        /* The header used to name the internal layer taxonomy — 配置 · 验证 ·
           权限 · 功能 · 操作审批 · 记忆 · 运行态 · 存储 — and then draw the
           distinction 「验证通过 ≠ 运行可用」 in bold. Both are how the health
           model is built, not what the user came to find out. The layers are
           still the page's own subheadings, where they read as grouping rather
           than as a schema. */
        description={copy.subtitle}
        action={(
          <div className="settingsFormRowControlCluster">
            <small className="settingsHealthMetaLabel">
              {copy.lastRead}<RelativeTime ts={healthCheckedAtMs} />
            </small>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setRefreshTick((tick) => tick + 1)}
              label={copy.refresh}
            />
          </div>
        )}
      >
        <p className="settingsHealthSummaryLine" role="group" aria-label={copy.summaryAria}>
          {summaryParts.map((part) => (
            <span key={part.key} data-tone={part.count > 0 ? part.tone : 'neutral'}>
              {part.label} {part.count}
            </span>
          ))}
        </p>
      </SettingsSection>

      {blocksSendCount > 0 && (
        <Banner
          status="error"
          role="status"
          title={copy.blockers.send(blocksSendCount)}
          description={blocksCapabilityCount > 0 ? copy.blockers.capability(blocksCapabilityCount) : undefined}
        />
      )}
      {blocksSendCount === 0 && blocksCapabilityCount > 0 && (
        <Banner
          status="warning"
          role="status"
          title={copy.blockers.capability(blocksCapabilityCount)}
        />
      )}

      <SettingsSection>
        {HEALTH_SIGNAL_LAYERS.flatMap((layer) => {
          const signals = signalsByLayer[layer];
          if (!signals || signals.length === 0) return [];
          const layerCopy = copy.layers[layer];
          return [
            <VStack key={`${layer}-head`} gap={0} className="settingsRowsSubheading">
              <Text type="supporting" size="sm" weight="medium">{layerCopy.label}</Text>
              <Text type="supporting" size="sm" color="secondary">{layerCopy.description}</Text>
            </VStack>,
            ...signals.map((signal) => (
              <HealthSignalRow key={signal.id} signal={signal} copy={copy} />
            )),
          ];
        })}
      </SettingsSection>

      <Text as="p" type="supporting" size="sm" color="secondary">{copy.footnote}</Text>
    </SettingsPage>
  );
}

function HealthSignalRow(props: { signal: HealthSignal; copy: HealthCenterCopy }) {
  const { signal, copy } = props;
  const statusCopy = copy.statuses[signal.status];
  const detail = copy.signalDetail(signal);
  return (
    <SettingsRow
      align="start"
      label={(
        <span className="settingsHealthSignalIdentity">
            <strong className="settingsHealthSignalLabel">{copy.signalLabel(signal)}</strong>
            <small className="settingsHealthSignalScope">{copy.scopes[signal.scope]}</small>
        </span>
      )}
      description={(
        <span className="settingsHealthSignalDescription">
          <span>{copy.signalMessage(signal)}</span>
          {detail && <small>{detail}</small>}
          <span className="settingsHealthSignalMeta">
            {/* UX audit (owner msg `30f736ed`): every row used to repeat
                「来源：能力快照 · 读取：1秒钟前」 under the header's own
                「最近一次读取」.

                Measured before cutting, because the spec asked whether any row
                genuinely differs: across 14 signals every `checkedAt` was
                exactly the snapshot's, delta 0 — so the per-row timestamp was
                the same fact printed 14 more times, and it goes.

                Source is not the same story: 12 rows read from the capability
                snapshot, but one is a live connection test and one a runtime
                probe, and "this was actually exercised" is worth saying. So it
                shows only where it is not the page's default reading — the two
                rows that carry information keep it, the twelve repetitions
                stop. */}
            {signal.source !== 'capability_snapshot' && (
              <span>{copy.source}{copy.sources[signal.source]}</span>
            )}
            {signal.blocksSend && <span data-tone="destructive">{copy.blocksSend}</span>}
            {signal.blocksCapability && <span data-tone="warning">{copy.blocksCapability}</span>}
          </span>
        </span>
      )}
      end={(
        <span className="settingsStatus">
          <StatusDot variant={dotForStatus(statusCopy.tone)} label={statusCopy.label} />
          <span>{statusCopy.label}</span>
        </span>
      )}
    />
  );
}

function groupSignalsByLayer(signals: HealthSignal[]): Record<HealthSignalLayer, HealthSignal[]> {
  const byLayer: Record<HealthSignalLayer, HealthSignal[]> = {
    configuration: [],
    validation: [],
    permission: [],
    feature: [],
    action_approval: [],
    memory_acceptance: [],
    runtime_probe: [],
    storage: [],
  };
  for (const signal of signals) {
    byLayer[signal.layer].push(signal);
  }
  return byLayer;
}
