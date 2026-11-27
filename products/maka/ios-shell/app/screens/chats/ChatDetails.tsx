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

import { computed, View } from 'nsh';
import type { AgentSessionMetrics } from '../../bridge';
import { currentLocale, tr } from '../../locale';
import { GroupRow, InsetGroup } from '../../ui';

function contextRatio(metrics: AgentSessionMetrics) {
  const { contextTokens, contextWindow } = metrics;
  return contextTokens != null && contextWindow != null && contextWindow > 0
    ? contextTokens / contextWindow
    : null;
}

function percent(ratio: number) {
  const format = new Intl.NumberFormat(currentLocale(), { style: 'percent' });
  return ratio > 0 && ratio < 0.01 ? '<' + format.format(0.01) : format.format(ratio);
}

function contextReading(metrics: AgentSessionMetrics) {
  const { contextTokens, contextWindow, approximate } = metrics;
  const format = new Intl.NumberFormat(currentLocale());
  const approx = approximate ? '≈' : '';
  const ratio = contextRatio(metrics);
  return [
    contextTokens == null ? null : approx + format.format(contextTokens),
    contextWindow != null && contextWindow > 0 ? format.format(contextWindow) : null,
    ratio == null ? null : approx + percent(ratio),
  ] as const;
}

export function ChatDetails(props: { metrics: AgentSessionMetrics | null; cached: boolean }) {
  const context = computed(() => {
    const metrics = props.metrics;
    if (!metrics) return tr('No usage data yet');
    const [used, window, ratio] = contextReading(metrics);
    if (used !== null && window !== null) {
      const tokens = tr('{used} / {window} tokens', { used, window });
      return ratio === null ? tokens : tokens + ' · ' + ratio;
    }
    if (used !== null) return tr('{used} tokens used', { used });
    if (window !== null) return tr('{window} token window', { window });
    return tr('No usage data yet');
  });
  const speed = () => {
    const tps = props.metrics?.outputTokensPerSecond;
    return tps == null
      ? tr('Not measured')
      : tr('{rate} tok/s', {
          rate: new Intl.NumberFormat(currentLocale(), {
            minimumFractionDigits: 1,
            maximumFractionDigits: 1,
          }).format(tps),
        });
  };
  const source = () => {
    const metrics = props.metrics;
    if (!metrics) return undefined;
    return metrics.connectionId ? metrics.modelId + ' · ' + metrics.connectionId : metrics.modelId;
  };
  return (
    <View style={{ paddingTop: 8 }}>
      <InsetGroup
        variant="glass"
        header={tr('Usage')}
        footer={
          [source(), props.cached ? tr('Last synced') : undefined].filter(Boolean).join(' · ') ||
          undefined
        }
      >
        <GroupRow
          variant="glass"
          title={tr('Context')}
          subtitle={context()}
          divider={!!props.metrics}
        />
        <If when={props.metrics?.contextLastKnown}>
          <GroupRow
            variant="glass"
            title={tr('Last request')}
            subtitle={tr('Context from the last request. Newer content isn’t included.')}
            divider
          />
        </If>
        <If when={props.metrics}>
          <GroupRow variant="glass" title={tr('Output speed')} subtitle={speed()} />
        </If>
      </InsetGroup>
    </View>
  );
}
