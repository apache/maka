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

import { useCallback, useEffect, useState } from 'react';
import { Button, HStack, Text, VStack, useUiLocale } from '@maka/ui';
import type { ConnectionUsageReadResult } from '@maka/runtime-host/protocol';
import type { ProviderType } from '@maka/core/llm-connections';
import { providerReportsUsage } from '@maka/core/connection-usage';
import type { DesktopConnectionIdentity } from '../../../shared/desktop-connection-snapshot.js';
import { getProviderSettingsCopy } from './settings-provider-copy.js';

type UsageCopy = ReturnType<typeof getProviderSettingsCopy>['detail']['usage'];
type Report = Extract<ConnectionUsageReadResult, { kind: 'report' }>['report'];
type UsageWindow = Report['windows'][number];

type LoadState =
  | { readonly phase: 'loading' }
  | { readonly phase: 'ready'; readonly result: ConnectionUsageReadResult };

/**
 * The account-usage section on a connection's settings page. Renders whatever
 * the Host reported: the account/plan line, the stat tiles, then one bar per
 * window. Every block is optional — a provider that reports no stats, or two
 * windows instead of three, simply yields fewer blocks, never a zero
 * placeholder. Nothing is drawn for a block the provider did not speak to.
 */
export function ConnectionUsageSection(props: {
  /**
   * The identity fields as separate strings, not a `DesktopConnectionIdentity`
   * object: structural typing would silently accept the whole projected
   * connection (which has these fields and more), and the IPC boundary rejects
   * any record carrying extra keys. Two strings make that mistake impossible.
   */
  readonly connectionId: string;
  readonly slug: string;
  readonly providerType: ProviderType;
  readonly load: (connection: DesktopConnectionIdentity) => Promise<ConnectionUsageReadResult>;
}) {
  const copy = getProviderSettingsCopy(useUiLocale()).detail.usage;
  const [state, setState] = useState<LoadState>({ phase: 'loading' });
  const { load } = props;
  const connection: DesktopConnectionIdentity = {
    connectionId: props.connectionId,
    slug: props.slug,
  };
  const supported = providerReportsUsage(props.providerType);

  const refresh = useCallback(() => {
    let cancelled = false;
    setState({ phase: 'loading' });
    void load(connection)
      .then((result) => {
        if (!cancelled) setState({ phase: 'ready', result });
      })
      .catch(() => {
        if (!cancelled) setState({ phase: 'ready', result: { kind: 'unavailable', reason: 'network' } });
      });
    return () => {
      cancelled = true;
    };
  }, [connection, load]);

  useEffect(() => {
    if (supported) refresh();
  }, [refresh, supported]);

  if (!supported) return null;

  return (
    <ConnectionUsageBody
      phase={state.phase}
      result={state.phase === 'loading' ? undefined : state.result}
      copy={copy}
      onRefresh={() => {
        refresh();
      }}
    />
  );
}

/**
 * The section body without its container: the legacy settings page owns the
 * `SettingsSection` wrapper, so this feature stays free of legacy imports.
 */
function ConnectionUsageBody(props: {
  phase: LoadState['phase'];
  result: ConnectionUsageReadResult | undefined;
  copy: UsageCopy;
  onRefresh(): void;
}) {
  const { result, copy } = props;
  return (
    <VStack gap={3}>
      {props.phase === 'loading' || result === undefined ? null : result.kind === 'report' ? (
        <UsageReport report={result.report} copy={copy} />
      ) : (
        <Text type="supporting" color="secondary">
          {result.reason === 'unsupported'
            ? copy.unsupported
            : result.reason === 'unauthorized'
              ? copy.unauthorized
              : copy.unavailable}
        </Text>
      )}
      <HStack justify="end">
        <Button
          variant="ghost"
          size="sm"
          isDisabled={props.phase === 'loading'}
          clickAction={props.onRefresh}
          label={copy.refresh}
        >
          {props.phase === 'loading' ? copy.refreshing : copy.refresh}
        </Button>
      </HStack>
    </VStack>
  );
}

function UsageReport(props: { report: Report; copy: UsageCopy }) {
  const { report, copy } = props;
  // The account line only exists when there is something to put on it.
  const badges = [report.accountLabel, report.planLabel].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  const stats = report.stats;
  return (
    <VStack gap={3}>
      {report.partiallyUnauthorized ? (
        // Some endpoints refused the key, so what is shown here is real but
        // incomplete. Saying so is the point: otherwise a partial report reads
        // as a complete one and the page cannot name the credential as the cause.
        <Text type="supporting" color="secondary">
          {copy.partiallyUnauthorized}
        </Text>
      ) : null}
      {badges.length > 0 ? (
        <HStack gap={2} vAlign="center" wrap="wrap">
          <Text type="label">{copy.current}</Text>
          {badges.map((badge) => (
            <Text key={badge} size="sm">
              {badge}
            </Text>
          ))}
        </HStack>
      ) : null}

      {stats ? (
        <HStack gap={3} wrap="wrap">
          {stats.requests !== null ? (
            <StatTile
              label={copy.requests}
              value={formatCount(stats.requests)}
              detail={stats.failed !== null ? copy.failed(stats.failed) : undefined}
            />
          ) : null}
          {stats.successRate !== null ? (
            <StatTile label={copy.successRate} value={`${stats.successRate.toFixed(2)}%`} />
          ) : null}
          {stats.cost !== null ? (
            <StatTile label={copy.cost} value={formatCredits(stats.cost)} />
          ) : null}
          {stats.tokensIn !== null || stats.tokensOut !== null ? (
            <StatTile
              label={copy.tokens}
              value={formatTokens((stats.tokensIn ?? 0) + (stats.tokensOut ?? 0))}
              detail={
                stats.tokensIn !== null && stats.tokensOut !== null
                  ? copy.tokensBreakdown(formatTokens(stats.tokensIn), formatTokens(stats.tokensOut))
                  : undefined
              }
            />
          ) : null}
        </HStack>
      ) : null}

      {report.windows.map((window) => (
        <UsageWindowBar key={window.id} window={window} copy={copy} />
      ))}

      <HStack justify="between" vAlign="center">
        <Text type="supporting" color="secondary">
          {report.periodEnd !== null ? copy.periodEnd(formatDate(report.periodEnd)) : ''}
        </Text>
        <Text type="supporting" color="secondary">
          {copy.updatedAt(formatTime(report.fetchedAt))}
        </Text>
      </HStack>
    </VStack>
  );
}

function StatTile(props: { label: string; value: string; detail?: string }) {
  return (
    <VStack gap={1}>
      <Text type="supporting" color="secondary">
        {props.label}
      </Text>
      <Text type="label">{props.value}</Text>
      {props.detail ? (
        <Text type="supporting" color="secondary">
          {props.detail}
        </Text>
      ) : null}
    </VStack>
  );
}

/**
 * One window as a labelled bar: `used / cap` on the right, and the reset line
 * below only when the provider reported a reset. An uncapped window says so
 * instead of drawing a bar it cannot fill.
 */
function UsageWindowBar(props: { window: UsageWindow; copy: UsageCopy }) {
  const { window: win, copy } = props;
  const label =
    copy.windowLabels[win.id as keyof UsageCopy['windowLabels']] ?? win.label ?? win.id;
  if (win.unlimited === true) {
    return (
      <VStack gap={1}>
        <HStack justify="between" vAlign="center">
          <Text type="label">{label}</Text>
          <Text type="supporting" color="secondary">
            {copy.unlimited}
          </Text>
        </HStack>
      </VStack>
    );
  }
  const percent = win.cap > 0 ? Math.min(100, Math.max(0, (win.used / win.cap) * 100)) : 0;
  return (
    <VStack gap={1}>
      <HStack justify="between" vAlign="center">
        <Text type="label">{label}</Text>
        <Text type="supporting" color="secondary">
          {`${formatCredits(win.used)} / ${formatCredits(win.cap)}`}
        </Text>
      </HStack>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={win.cap}
        aria-valuenow={win.used}
        style={{ height: 6, borderRadius: 3, background: 'var(--maka-color-border, #e5e5e5)' }}
      >
        <div
          style={{
            width: `${percent}%`,
            height: '100%',
            borderRadius: 3,
            background: 'var(--maka-color-accent, #333)',
          }}
        />
      </div>
      {win.resetsAt !== null ? (
        <Text type="supporting" color="secondary">
          {copy.resetsAt(formatDate(win.resetsAt))}
        </Text>
      ) : null}
    </VStack>
  );
}

function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

/** Credits are dollar-denominated; two decimals keeps the bar's arithmetic legible. */
function formatCredits(value: number): string {
  return `$${value.toFixed(2)}`;
}

function formatTokens(value: number): string {
  const million = 1_000_000;
  if (value >= million) return `${(value / million).toFixed(1)}M`;
  const thousand = 1_000;
  if (value >= thousand) return `${(value / thousand).toFixed(1)}K`;
  return String(value);
}

function formatDate(millis: number): string {
  return new Date(millis).toLocaleDateString();
}

function formatTime(millis: number): string {
  return new Date(millis).toLocaleTimeString();
}
