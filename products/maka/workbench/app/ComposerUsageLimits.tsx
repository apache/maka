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

import { Canvas, cleanup, effect, lifecycle, platform, signal, Text, untracked, View } from 'nsh';
import { Button, Popover } from 'nsh/base';
import type { ComposerBackend } from '../../../../packages/plugin-sdk/src/composer-view.js';
import { composerToolbar, useToolbarCompact } from './composerToolbar';
import {
  isExternalUsageRuntime,
  summarizeComposerUsage,
  watchComposerUsage,
  type ComposerUsageHost,
  type ComposerUsageObservation,
  type ComposerUsageSummary,
  type ComposerUsageTarget,
} from './composerUsageSummary';
import { useHost } from './host';
import { tr } from './locale';
import {
  C,
  captionTextStyle,
  floatingStyle,
  menuDetailTextStyle,
  textTooltip,
  toolbarControlStyle,
} from './ui';
import { usageLabel, UsageLimitsList, usageNumber, type UsageLimit } from './UsageLimits';

function targetForBackend(backend: ComposerBackend): ComposerUsageTarget | null {
  if (!backend) return null;
  if (backend.kind === 'model') {
    return {
      key: `model:${backend.connectionId}`,
      kind: 'connection',
      connectionId: backend.connectionId,
    };
  }
  const runtime = backend.selection.settings.runtime;
  if (isExternalUsageRuntime(runtime)) {
    return { key: `external:${runtime}`, kind: 'external', runtime };
  }
  return null;
}

function usageTooltip(source: string, summary: ComposerUsageSummary | null): string {
  if (!summary) return '';
  if (summary.kind === 'balance') {
    return [source, `${usageLabel(summary.limit)} ${summary.text}`].filter(Boolean).join(' · ');
  }
  const remaining = tr('{percent}% remaining', { percent: usageNumber(summary.remainingPercent) });
  return [source, `${usageLabel(summary.limit)} · ${remaining}`].filter(Boolean).join(' · ');
}

function ComposerUsagePopover(props: {
  sourceName: () => string;
  refreshFailed: () => boolean;
  limits: () => UsageLimit[];
  summary: () => ComposerUsageSummary | null;
}) {
  const open = signal(false);
  const windowSummary = () => {
    const current = props.summary();
    return current?.kind === 'window' ? current : null;
  };
  const balanceSummary = () => {
    const current = props.summary();
    return current?.kind === 'balance' ? current : null;
  };
  const fillColor = () => {
    const tone = windowSummary()?.tone;
    return tone === 'danger' ? C.danger : tone === 'warning' ? C.warning : C.accent;
  };
  const labelColor = () => {
    const tone = windowSummary()?.tone;
    return tone === 'danger' ? C.danger : tone === 'warning' ? C.warning : C.secondary;
  };
  const windowWideText = () => {
    const current = windowSummary();
    if (!current) return '';
    return current.shortWindow
      ? `${current.shortWindow} ${current.remainingPercent}%`
      : `${current.remainingPercent}%`;
  };
  const tooltipText = () => usageTooltip(props.sourceName(), props.summary());

  return (
    <Popover
      open={open()}
      onOpenChange={({ open: next }) => open.set(next)}
      closeOnEscape
      closeOnPressOutside
      placement="top"
      align="end"
      offset={8}
      margin={8}
      popupStyle={{
        ...floatingStyle(),
        width: 272,
        padding: 12,
        gap: 10,
      }}
      trigger={
        <Button
          accessibilityLabel={tooltipText()}
          tooltip={textTooltip(() => (open() ? undefined : tooltipText()))}
          style={{
            ...toolbarControlStyle,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
            flexShrink: 0,
          }}
          hoverStyle={{ backgroundColor: C.line }}
          focusStyle={{ backgroundColor: C.line }}
          activeStyle={{ backgroundColor: C.surface }}
        >
          <If when={balanceSummary() !== null}>
            <Text style={[{ ...captionTextStyle, color: C.secondary }, { numberOfLines: 1 }]}>
              {balanceSummary()?.text ?? ''}
            </Text>
          </If>
          <If when={windowSummary() !== null && useToolbarCompact()}>
            <Canvas
              accessibilityElementsHidden
              style={[{ width: 15, height: 15 }, { pointerEvents: 'none' }]}
              draw={(cx) => {
                const current = windowSummary();
                if (!current) return;
                cx.lineWidth = 1.5;
                cx.lineCap = 'round';
                cx.strokeStyle = C.line;
                cx.beginPath();
                cx.arc(7.5, 7.5, 5.75, 0, Math.PI * 2);
                cx.stroke();
                const start = -Math.PI / 2;
                const share = Math.max(0.04, current.remainingPercent / 100);
                cx.strokeStyle = fillColor();
                cx.beginPath();
                cx.arc(7.5, 7.5, 5.75, start, start + share * Math.PI * 2);
                cx.stroke();
              }}
            />
            <Text
              style={[{ fontSize: 12, lineHeight: 16, color: labelColor() }, { numberOfLines: 1 }]}
            >
              {`${windowSummary()?.remainingPercent ?? 0}%`}
            </Text>
          </If>
          <If when={windowSummary() !== null && !useToolbarCompact()}>
            <View
              accessibilityElementsHidden
              style={{
                width: 24,
                height: 4,
                borderRadius: 2,
                backgroundColor: C.line,
                overflow: 'hidden',
              }}
            >
              <View
                style={{
                  width: `${windowSummary()?.remainingPercent ?? 0}%`,
                  height: 4,
                  borderRadius: 2,
                  backgroundColor: fillColor(),
                }}
              />
            </View>
            <Text
              style={[{ fontSize: 12, lineHeight: 16, color: labelColor() }, { numberOfLines: 1 }]}
            >
              {windowWideText()}
            </Text>
          </If>
        </Button>
      }
    >
      <View style={{ gap: 10 }}>
        <If when={props.sourceName()}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
            }}
          >
            <Text style={{ fontSize: 12, lineHeight: 16, fontWeight: '600', color: C.text }}>
              {props.sourceName()}
            </Text>
            <If when={props.refreshFailed()}>
              <Text style={{ ...menuDetailTextStyle, color: C.muted }}>
                {tr('Last usage refresh failed')}
              </Text>
            </If>
          </View>
        </If>
        <UsageLimitsList limits={props.limits} showRemaining />
      </View>
    </Popover>
  );
}

export function ComposerUsageLimits(props: { backend: () => ComposerBackend }) {
  const host = useHost();
  const observation = signal<ComposerUsageObservation | null>(null);

  let activeKey: string | null = null;
  let watchId = 0;
  let stop: (() => void) | undefined;
  cleanup(() => {
    watchId++;
    stop?.();
  });

  effect(() => {
    const id = ++watchId;
    stop?.();
    stop = undefined;
    if (platform.idiom === 'terminal' || !composerToolbar.usageLimits()) {
      activeKey = null;
      observation.set(null);
      return;
    }
    const target = targetForBackend(props.backend());
    if (!target) {
      activeKey = null;
      observation.set(null);
      return;
    }
    if (target.key !== activeKey) {
      activeKey = target.key;
      observation.set(null);
    }
    if (lifecycle() !== 'active') return;
    stop = watchComposerUsage(
      host as unknown as ComposerUsageHost,
      target,
      (next) => {
        if (watchId === id) observation.set(next);
      },
      untracked(observation),
    );
  });

  const limits = () => {
    const result = observation()?.reading.result;
    return result?.kind === 'ready' ? result.limits : [];
  };
  const summary = () => summarizeComposerUsage(limits(), usageNumber);

  return (
    <If when={composerToolbar.usageLimits() && summary() !== null}>
      <ComposerUsagePopover
        sourceName={() => observation()?.sourceName ?? ''}
        refreshFailed={() => observation()?.reading.refreshFailed ?? false}
        limits={limits}
        summary={summary}
      />
    </If>
  );
}
