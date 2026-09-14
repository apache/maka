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

import { useEffect, useId, useRef, useState, type ComponentType, type ReactNode } from 'react';
import {
  ICON_SIZE,
  Accessibility as AccessibilityIcon,
  Bell,
  Keyboard,
  Monitor,
  MousePointer2,
  RefreshCcw,
  type LucideProps,
} from '@maka/ui/icons';
import type {
  CapabilitySnapshot,
  CapabilitySnapshotCollection,
  OsPermissionId,
  OsPermissionSnapshot,
  PermissionSnapshot,
} from '@maka/core/capabilities';
import type { UiLocale } from '@maka/core/ui-locale';
import {
  isCapabilityReasonCode,
  isDragGrantPermissionId,
  COMPUTER_HISTORY_PERMISSION_IDS,
  OS_PERMISSION_IDS,
} from '@maka/core/capabilities';
import {
  Banner,
  Button,
  Collapsible,
  CollapsibleGroup,
  HStack,
  List,
  ListItem,
  MetadataList,
  MetadataListItem,
  Text,
  VStack,
} from '@astryxdesign/core';
import { Tab, TabList } from '@astryxdesign/core/TabList';
import { IconButton, RelativeTime, StatusDot, useMountedRef, useToast, useUiLocale } from '@maka/ui';
import { SettingsPage, SettingsSection } from '../../application/contracts/settings-presentation/settings-section.js';
import { getCapabilityReasonCopy } from '../../locales/capability-reason-copy.js';
import { getPermissionCenterCopy, type PermissionCenterCopy } from '../../locales/permission-center-copy.js';
import { botStatusReasonCopy } from '../../locales/settings-bot-copy.js';
import { getSettingsSharedCopy } from '../../locales/settings-shared-copy.js';
import { settingsActionErrorMessage } from '../../application/contracts/settings-presentation/settings-error-copy.js';
import {
  useOptionalRuntimeHostSettingsTarget,
  RuntimeHostSettingsGenerationBoundary,
  type SettingsHostTarget,
} from '../../application/contracts/settings-presentation/runtime-host-settings-target.js';
import { dotForStatus } from '@maka/ui';
import { SettingsSkeletonStack } from '../../application/contracts/settings-presentation/settings-skeleton.js';
import { useActionGuard } from '../../application/contracts/settings-presentation/use-action-guard.js';
import {
  SettingsStatusSummaryFilter,
  type SettingsStatusSummaryOption,
} from '../../application/contracts/settings-presentation/settings-status-summary-filter.js';
import type { PermissionCenterServices } from './ports.js';

const OS_PERMISSION_ICONS: Record<OsPermissionId, ComponentType<LucideProps>> = {
  accessibility: AccessibilityIcon,
  input_monitoring: Keyboard,
  screen_recording: Monitor,
  notifications: Bell,
  automation: MousePointer2,
};

type PermissionStatusFilter = 'granted' | 'pending' | 'denied' | 'other';

export interface PermissionCenterPageProps {
  historyContext?: boolean;
  capabilitiesAction?: ReactNode;
  capabilitiesLabel?: string;
}

export function PermissionCenterPage({ services, historyContext = false, capabilitiesAction, capabilitiesLabel }:
  PermissionCenterPageProps & { services: PermissionCenterServices }) {
  const locale = useUiLocale();
  const copy = getPermissionCenterCopy(locale);
  const [permissions, setPermissions] = useState<PermissionSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [scope, setScope] = useState<'all' | 'history'>(historyContext ? 'history' : 'all');
  const [refreshTick, setRefreshTick] = useState(0);
  const [pendingPermAction, setPendingPermAction] = useState<string | null>(null);
  const [permissionFilter, setPermissionFilter] = useState<PermissionStatusFilter | null>(null);
  const toast = useToast();
  const mountedRef = useMountedRef();
  const permissionActionGuard = useActionGuard<string>();
  const rootRef = useRef<HTMLDivElement>(null);
  const focused = useRef(false);
  const panelId = useId();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    // OS grants belong to this Desktop, not the selected Runtime Host.
    services.permissions.getSnapshot()
      .then((perm) => {
        if (cancelled) return;
        setPermissions(perm);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(settingsActionErrorMessage(err, locale, getSettingsSharedCopy(locale).unknownError));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [services, locale, refreshTick]);

  useEffect(() => {
    const refreshAfterSystemSettings = () => {
      if (document.visibilityState === 'visible') {
        setRefreshTick((tick) => tick + 1);
      }
    };
    window.addEventListener('focus', refreshAfterSystemSettings);
    document.addEventListener('visibilitychange', refreshAfterSystemSettings);
    return () => {
      window.removeEventListener('focus', refreshAfterSystemSettings);
      document.removeEventListener('visibilitychange', refreshAfterSystemSettings);
    };
  }, []);

  useEffect(() => {
    if (!permissions) return;
    setPermissionFilter((current) => {
      if (!current) return current;
      return permissionIdsForFilter(permissions, current).length > 0 ? current : null;
    });
  }, [permissions]);

  useEffect(() => {
    if (!historyContext || scope !== 'history' || !permissions || loading || error || focused.current) return;
    focused.current = true;
    const missing = COMPUTER_HISTORY_PERMISSION_IDS.find((id) => historyPermission(permissions.permissions[id]).status !== 'granted');
    if (!missing) return;
    const row = rootRef.current?.querySelector<HTMLElement>(`[data-permission-id="${missing}"]`);
    row?.focus({ preventScroll: true });
    row?.scrollIntoView({ block: 'nearest' });
  }, [historyContext, scope, permissions, loading, error]);

  async function runPermissionAction(
    permId: OsPermissionId,
    kind: 'request' | 'openSettings' | 'dragGrant',
  ) {
    const actionKey = `${permId}:${kind}`;
    if (!permissionActionGuard.begin(actionKey)) return;
    setPendingPermAction(actionKey);
    setNotice(null);
    try {
      const result =
        kind === 'request'
          ? await services.permissions.requestAccess(permId)
          : kind === 'dragGrant'
            ? await services.permissions.startDragOnboarding(permId)
            : await services.permissions.openSystemSettings(permId);
      if (result.ok) {
        if (mountedRef.current) {
          setNotice(kind === 'request' ? copy.requestChecked : copy.openedSettings);
          // Re-read; a successful action alone never promotes a grant.
          if (kind === 'request') setRefreshTick((tick) => tick + 1);
        }
      } else if (mountedRef.current) {
        toast.error(
          copy.actionFailed,
          permissionActionFailureCopy(result.reason, result.message, copy),
        );
      }
    } catch (err) {
      if (mountedRef.current) {
        toast.error(
          copy.actionFailed,
          settingsActionErrorMessage(err, locale, getSettingsSharedCopy(locale).unknownError),
        );
      }
    } finally {
      if (permissionActionGuard.current === actionKey) {
        permissionActionGuard.finish();
      }
      if (mountedRef.current) setPendingPermAction(null);
    }
  }

  if (loading && !permissions) {
    return (
      <SettingsSkeletonStack label={copy.loading} />
    );
  }

  if (!permissions) {
    return (
      <SettingsPage>
        <Banner
          status="error"
          role="alert"
          title={copy.readFailed}
          description={error ?? copy.noData}
          endContent={(
            <Button variant="primary" onClick={() => setRefreshTick((tick) => tick + 1)} label={copy.readAgain} />
          )}
        />
      </SettingsPage>
    );
  }

  const counts = summarizePermissionStatuses(permissions);
  const visiblePermissionIds = permissionFilter
    ? permissionIdsForFilter(permissions, permissionFilter)
    : OS_PERMISSION_IDS;
  const summaryFilters: Array<SettingsStatusSummaryOption<PermissionStatusFilter>> = [
    { value: 'granted', label: copy.granted, count: counts.granted, tone: 'success' },
    { value: 'pending', label: copy.pending, count: counts.pending, tone: 'warning' },
    { value: 'denied', label: copy.denied, count: counts.denied, tone: 'destructive' },
    { value: 'other', label: copy.other, count: counts.other, tone: 'neutral' },
  ];
  const historyIds = new Set<OsPermissionId>(COMPUTER_HISTORY_PERMISSION_IDS);
  const missingCount = COMPUTER_HISTORY_PERMISSION_IDS.filter((id) => historyPermission(permissions.permissions[id]).status !== 'granted').length;
  const rows = (ids: readonly OsPermissionId[]) => (
    <List hasDividers aria-label={copy.osListAria}>
      {ids.map((id) => (
        <OsPermissionRow
          key={id}
          snapshot={scope === 'history' && historyIds.has(id) ? historyPermission(permissions.permissions[id]) : combinedPermission(permissions.permissions[id])}
          desktopStatus={permissions.permissions[id].status}
          history={scope === 'history' && historyIds.has(id)}
          copy={copy}
          locale={locale}
          busy={pendingPermAction !== null || loading || error !== null}
          pendingKey={pendingPermAction === `${id}:request` ? 'request'
            : pendingPermAction === `${id}:openSettings` ? 'openSettings'
              : pendingPermAction === `${id}:dragGrant` ? 'dragGrant' : null}
          onRequest={() => void runPermissionAction(id, 'request')}
          onOpenSettings={() => void runPermissionAction(id, 'openSettings')}
          onDragGrant={() => void runPermissionAction(id, 'dragGrant')}
        />
      ))}
    </List>
  );

  return (
    <div ref={rootRef} className="settingsPermissionCenter">
      <SettingsPage>
        <HStack gap={3} align="center" justify="between" wrap="wrap">
          <Text type="supporting" size="sm" color="secondary">{copy.localDevice}</Text>
          <HStack gap={2} align="center">
            <Text type="supporting" size="sm" color="secondary">{copy.lastRead}<RelativeTime ts={permissions.checkedAt} /></Text>
            <IconButton label={copy.detectAgain} tooltip={copy.detectAgain} icon={<RefreshCcw size={16} aria-hidden />}
              variant="ghost" isDisabled={loading || pendingPermAction !== null} onClick={() => setRefreshTick((tick) => tick + 1)} />
          </HStack>
        </HStack>
        <TabList role="tablist" value={scope} aria-label={copy.scopeAria} hasDivider onChange={(value) => {
          if (value === 'all' || value === 'history') { focused.current = true; setScope(value); setPermissionFilter(null); }
        }}>
          <Tab id={`${panelId}-all-tab`} value="all" label={copy.allPermissions} panelId={`${panelId}-all`} />
          <Tab id={`${panelId}-history-tab`} value="history" label={copy.historyPermissions} panelId={`${panelId}-history`} />
        </TabList>
        {error ? <Banner status="error" role="alert" title={copy.readFailed} description={error} /> : null}
        {notice ? <Text role="status" type="supporting" size="sm" color="secondary">{notice}</Text> : null}
        <div role="tabpanel" id={`${panelId}-${scope}`} aria-labelledby={`${panelId}-${scope}-tab`} className="settingsPageStack">
          {scope === 'history' ? (
            <>
              <span className="settingsStatus" role="status">
                <StatusDot label={error ? copy.readFailed : missingCount ? copy.historyWaiting(missingCount) : copy.historyReady}
                  variant={dotForStatus(error || missingCount ? 'attention' : 'success')} />
                <Text type="label" size="sm">{error ? copy.readFailed : missingCount ? copy.historyWaiting(missingCount) : copy.historyReady}</Text>
              </span>
              <SettingsSection variant="bare" title={copy.historyRequired} description={copy.historyHelp}>
                {rows(COMPUTER_HISTORY_PERMISSION_IDS)}
              </SettingsSection>
              <SettingsSection variant="bare" title={copy.otherPermissions} description={copy.otherPermissionsHelp}>
                {rows(OS_PERMISSION_IDS.filter((id) => !historyIds.has(id)))}
              </SettingsSection>
            </>
          ) : (
            <SettingsSection variant="bare" title={copy.osSection}>
              <SettingsStatusSummaryFilter<PermissionStatusFilter>
                value={permissionFilter} options={summaryFilters} label={copy.summaryAria}
                optionLabel={(option, selected) => copy.summaryFilterAria(option.label, option.count, selected)}
                onChange={setPermissionFilter}
              />
              {rows(visiblePermissionIds)}
            </SettingsSection>
          )}
          {scope === 'all' ? <CapabilitySection services={services} refreshTick={refreshTick} action={capabilitiesAction} label={capabilitiesLabel} /> : null}
        </div>
      </SettingsPage>
    </div>
  );
}

function historyPermission(snapshot: OsPermissionSnapshot): OsPermissionSnapshot {
  const consumer = snapshot.consumers?.activity_recorder;
  return { ...snapshot, status: consumer?.status ?? 'unknown', reason: consumer?.reason };
}

function combinedPermission(snapshot: OsPermissionSnapshot): OsPermissionSnapshot {
  const consumer = snapshot.consumers?.activity_recorder;
  return snapshot.status === 'granted' && consumer && consumer.status !== 'granted'
    ? { ...snapshot, ...consumer } : snapshot;
}

function CapabilitySection({ services, refreshTick, action, label }: {
  services: PermissionCenterServices;
  refreshTick: number;
  action?: ReactNode;
  label?: string;
}) {
  const host = useOptionalRuntimeHostSettingsTarget();
  const copy = getPermissionCenterCopy(useUiLocale());
  return (
    <SettingsSection variant="bare" title={copy.capabilitiesSection}
      description={label ? `${label} · ${copy.capabilitiesHelp}` : copy.capabilitiesHelp} action={action}>
      {host ? (
        <RuntimeHostSettingsGenerationBoundary>
          <CapabilityContent services={services} host={host} refreshTick={refreshTick} />
        </RuntimeHostSettingsGenerationBoundary>
      ) : (
        <Text role="status" type="supporting" color="secondary">{copy.capabilitiesUnavailable}</Text>
      )}
    </SettingsSection>
  );
}

function CapabilityContent({ services, host, refreshTick }: {
  services: PermissionCenterServices;
  host: SettingsHostTarget;
  refreshTick: number;
}) {
  const locale = useUiLocale();
  const copy = getPermissionCenterCopy(locale);
  const [snapshot, setSnapshot] = useState<CapabilitySnapshotCollection | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setSnapshot(null);
    setError(null);
    services.capabilities.getSnapshot(host).then(
      (value) => { if (!cancelled) setSnapshot(value); },
      (reason) => { if (!cancelled) setError(settingsActionErrorMessage(reason, locale, getSettingsSharedCopy(locale).unknownError)); },
    );
    return () => { cancelled = true; };
  }, [services, host, locale, refreshTick]);
  return (
      error ? <Text role="status" type="supporting" color="secondary">{copy.capabilitiesUnavailable} {error}</Text>
        : !snapshot ? <SettingsSkeletonStack label={copy.loading} />
          : <CollapsibleGroup type="single" hasDividers density="compact" role="group" className="settingsCapabilityGroup" aria-label={copy.capabilityListAria}>
            {snapshot.capabilities.map((capability) => <CapabilityRow key={capability.id} capability={capability} copy={copy} locale={locale} />)}
          </CollapsibleGroup>
  );
}

function summarizePermissionStatuses(snapshot: PermissionSnapshot): {
  granted: number;
  pending: number;
  denied: number;
  other: number;
} {
  let granted = 0;
  let pending = 0;
  let denied = 0;
  let other = 0;
  for (const id of OS_PERMISSION_IDS) {
    const status = combinedPermission(snapshot.permissions[id]).status;
    switch (status) {
      case 'granted':
        granted += 1;
        break;
      case 'not_determined':
        pending += 1;
        break;
      case 'denied':
        denied += 1;
        break;
      default:
        other += 1;
    }
  }
  return { granted, pending, denied, other };
}

function permissionIdsForFilter(
  snapshot: PermissionSnapshot,
  filter: PermissionStatusFilter,
): OsPermissionId[] {
  return OS_PERMISSION_IDS.filter((id) => {
    const status = combinedPermission(snapshot.permissions[id]).status;
    if (filter === 'pending') return status === 'not_determined';
    if (filter === 'other') return status !== 'granted' && status !== 'not_determined' && status !== 'denied';
    return status === filter;
  });
}

function permissionActionFailureCopy(reason: string, message: string | undefined, copy: PermissionCenterCopy): string {
  switch (reason) {
    case 'invalid_id':
      return copy.actionFailures.invalid_id;
    case 'unsupported_platform':
      return copy.actionFailures.unsupported_platform;
    case 'unsupported_permission':
      return copy.actionFailures.unsupported_permission;
    case 'denied':
      return copy.actionFailures.denied;
    case 'already_open':
      return copy.actionFailures.already_open;
    case 'open_settings_failed':
      return copy.actionFailures.open_settings_failed;
    case 'failed':
      return message ?? copy.actionFailures.failed;
    default:
      return message ?? copy.actionFailures.failed;
  }
}

/**
 * One capability row — a Collapsible whose trigger is the row and whose content
 * is that capability's diagnostics.
 *
 * The four-layer breakdown and the required-permission list
 * used to be a `<dl>` and two `<ul>`s with ~180 lines of CSS giving them label
 * columns, tone colors and spacing. They are all "label → value" readouts, so
 * they are Astryx `MetadataList` now.
 *
 * The disclosure itself is no longer ours either: it was a page-level boolean
 * that every row read, so opening one capability opened all of them. Collapsible
 * owns the trigger button, aria-expanded, aria-controls, and the keyboard
 * semantics; CollapsibleGroup owns "only one at a time".
 */
function CapabilityRow(props: {
  capability: CapabilitySnapshot;
  copy: PermissionCenterCopy;
  locale: UiLocale;
}) {
  const { capability } = props;
  const { copy, locale } = props;
  const readinessCopy = copy.readiness[capability.readiness];
  const capabilityLabel = capability.label;
  const featureReason = capabilityReasonText(capability.feature.reason, capability, copy, locale);
  const configurationReason = capabilityReasonText(capability.configuration.reason, capability, copy, locale);
  const runtimeReason = capabilityReasonText(capability.runtimeProbe.reason, capability, copy, locale);

  const layers: Array<{ label: string; value: string; reason?: string }> = [
    {
      label: copy.layers.feature,
      value: copy.layers.featureStates[capability.feature.state],
      ...(featureReason ? { reason: featureReason } : {}),
    },
    {
      label: copy.layers.configuration,
      value: copy.layers.configurationStates[capability.configuration.state],
      ...(configurationReason ? { reason: configurationReason } : {}),
    },
    { label: copy.layers.approval, value: copy.layers.approvalStates[capability.actionApproval.state] },
    { label: copy.layers.memory, value: copy.layers.memoryStates[capability.memoryAcceptance.state] },
    {
      label: copy.layers.runtime,
      value: copy.layers.runtimeStates[capability.runtimeProbe.state],
      ...(runtimeReason ? { reason: runtimeReason } : {}),
    },
  ];

  return (
    <Collapsible
      /* The group owns which row is open, keyed by this value. */
      value={capability.id}
      data-readiness={capability.readiness}
      /* The `data-diagnostics` hook is gone with the page-level flag it
         mirrored: open state now lives in CollapsibleGroup, and the row's own
         trigger already publishes it as `aria-expanded`. The story asserts on
         that instead — the component's real contract rather than an attribute
         we maintained by hand for the test. */
      /* The readiness dot rides the title line: the trigger is a row, and a
         status that describes the capability belongs beside its name, not
         centered against a block that grows when the row expands. */
      trigger={(
        <VStack gap={1} align="start">
          <HStack gap={2} align="center">
            <Text type="label" size="sm">{capabilityLabel}</Text>
            <span className="settingsStatus">
              <StatusDot variant={dotForStatus(readinessCopy.tone)} label={readinessCopy.label} />
              <span>{readinessCopy.label}</span>
            </span>
          </HStack>
          <VStack gap={0.5} align="start">
            <Text type="code" size="sm" color="secondary">{capability.id}</Text>
            <Text type="supporting" size="sm" color="secondary">{readinessCopy.detail}</Text>
          </VStack>
        </VStack>
      )}
    >
      {/* One step of indent, no card. These rows carry no icon column, so
          without it the diagnostics share a left edge with the capability
          name and read as sibling rows rather than as that row's detail.
          A tinted or rounded container instead of the indent would be a
          card inside a row list, which this surface does not do. */}
      <div className="settingsCapabilityDetail">
        <VStack gap={3}>
          {/* Explicit 2 columns: `columns="multi"` laid every item out
              full width, so the five layers became five tall rows and the
              row grew ~5x. `label position: start` keeps each readout on
              one line (label left, value right) like the <dl> it replaced. */}
          <MetadataList
            className="settingsCapabilityMetadata"
            columns={2}
            label={{ position: 'start', width: 92 }}
            aria-label={copy.layers.aria(capabilityLabel)}
          >
            {layers.map((layer) => (
              <MetadataListItem key={layer.label} label={layer.label}>
                {/* Stacked: MetadataListItem flows its children inline, so
                    an unwrapped reason ran straight into the state value
                    ("探测降级maka-cu 未响应握手…"). */}
                <VStack gap={0.5}>
                  <Text type="body">{layer.value}</Text>
                  {layer.reason ? (
                    <Text type="supporting" size="sm" color="secondary">{layer.reason}</Text>
                  ) : null}
                </VStack>
              </MetadataListItem>
            ))}
          </MetadataList>
          {capability.osPermissions.length > 0 && (
            <MetadataList
              className="settingsCapabilityMetadata"
              columns={2}
              label={{ position: 'start', width: 92 }}
              aria-label={copy.requiredPermissionsAria(capabilityLabel)}
              title={copy.requiredPermissions}
            >
              {capability.osPermissions.map((req) => (
                <MetadataListItem key={req.id} label={copy.osPermissions[req.id]?.label ?? req.id}>
                  <span className="settingsStatus">
                    <StatusDot variant={dotForStatus(copy.osStates[req.status].tone)} label={copy.osStates[req.status].label} />
                    <span>{copy.osStates[req.status].label}</span>
                  </span>
                </MetadataListItem>
              ))}
            </MetadataList>
          )}
          {/*
            PR-UX-POLISH-1 commit 2 (yuejing UX audit + xuan
            ROADMAP-SURFACE-0 + kenji boundary 1): unavailable pause/revoke
            chips looked like disabled toggles, which violates the
            capability presentation contract. Keep them hidden until there
            are real actions.
          */}
          {/* The audit slot carries its own sub-heading, the same way
              所需系统权限 does. It used to be a lone 暂无审计记录 line with
              nothing above it — an orphan, which is why it read as short of
              breathing room; the gap was a symptom of the missing parent,
              not of the spacing. With the label, empty and populated states
              hang off the same heading and the two sub-groups are
              parallel. */}
          <VStack gap={1}>
            <Text type="label" size="sm">{copy.auditSection}</Text>
            {capability.auditEvents.length === 0 ? (
              <Text type="supporting" size="sm" color="secondary">{copy.noAudit}</Text>
            ) : (
              <List aria-label={copy.auditAria(capabilityLabel)} density="compact">
                {capability.auditEvents.slice(-3).map((event, index) => (
                  <ListItem
                    key={`${capability.id}-audit-${index}`}
                    label={<Text type="supporting" size="sm" color="secondary">{event}</Text>}
                  />
                ))}
              </List>
            )}
          </VStack>
        </VStack>
      </div>
    </Collapsible>
  );
}

function OsPermissionRow(props: {
  snapshot: OsPermissionSnapshot;
  desktopStatus: OsPermissionSnapshot['status'];
  history: boolean;
  copy: PermissionCenterCopy;
  locale: UiLocale;
  busy: boolean;
  pendingKey: 'request' | 'openSettings' | 'dragGrant' | null;
  onRequest: () => void;
  onOpenSettings: () => void;
  onDragGrant: () => void;
}) {
  const { snapshot, busy, pendingKey } = props;
  const permissionCopy = props.copy.osPermissions[snapshot.id];
  const Icon = OS_PERMISSION_ICONS[snapshot.id];
  const label = permissionCopy?.label ?? snapshot.id;
  const purpose = permissionCopy?.purpose ?? '';
  const impact = permissionCopy?.impact ?? '';
  const stateCopy = props.copy.osStates[snapshot.status];
  const reason = osPermissionReasonText(snapshot, props.copy, props.locale);
  const consumerStatus = snapshot.consumers?.activity_recorder?.status;
  const diverged = snapshot.id === 'accessibility' && consumerStatus !== undefined && consumerStatus !== props.desktopStatus;

  const showRequest = !props.history && snapshot.canRequest && snapshot.status !== 'granted';
  const showOpenSettings = snapshot.canOpenSettings;
  // Drag-to-grant applies to the two permissions macOS gives no
  // programmatic consent dialog for, where the stock path ends in a file
  // picker. `canOpenSettings` is the platform proxy — main only sets it on
  // darwin — so this never renders where the gesture cannot work.
  const showDragGrant =
    isDragGrantPermissionId(snapshot.id)
    && !props.history
    && !diverged
    && snapshot.canOpenSettings
    && snapshot.status !== 'granted';

  const actionCount = Number(showOpenSettings) + Number(showDragGrant) + Number(showRequest);
  const actionCluster = actionCount > 0 && (
    // Keep every action below its description so a single long label cannot
    // squeeze the permission text into a narrow end-slot column.
    (<HStack gap={2} align="center" wrap="wrap">
      {showOpenSettings && (
            <Button
              variant={showRequest || showDragGrant ? 'secondary' : 'primary'}
              size="sm"
              onClick={props.onOpenSettings}
              isDisabled={busy}
              aria-busy={pendingKey === 'openSettings' ? 'true' : undefined}
              label={pendingKey === 'openSettings' ? props.copy.opening : props.copy.openSettings}
            />
          )}
      {/* The guided flow is the primary action where it exists: it does
          what 前往系统设置 does and then stays to help. The plain link
          keeps its place beside it so the manual route is never removed. */}
      {showDragGrant && (
        <Button
          variant="primary"
          size="sm"
          onClick={props.onDragGrant}
          isDisabled={busy}
          aria-busy={pendingKey === 'dragGrant' ? 'true' : undefined}
          label={pendingKey === 'dragGrant' ? props.copy.dragGranting : props.copy.dragGrant}
        />
      )}
      {showRequest && (
        <Button
          /* One primary per row. When the guided flow is present it owns
             the primary slot (see above), so 请求授权 steps down to
             secondary — otherwise the row shipped two filled accent
             buttons side by side and named no recommended path. */
          variant={showDragGrant ? 'secondary' : 'primary'}
          size="sm"
          onClick={props.onRequest}
          isDisabled={busy}
          aria-busy={pendingKey === 'request' ? 'true' : undefined}
          label={pendingKey === 'request' ? props.copy.requesting : props.copy.request}
        />
      )}
    </HStack>)
  );

  return (
    <ListItem
      data-permission-id={snapshot.id}
      data-state={snapshot.status}
      tabIndex={-1}
      /* The plate keeps its class: a status-tinted rounded icon well is
         product artwork (it turns red when a permission is denied), not
         layout, and Astryx's startContent slot has no equivalent. */
      startContent={Icon ? (
        <span className="settingsOsPermissionIcon" aria-hidden="true">
          <Icon size={ICON_SIZE.empty} /> {/* 20 in the 36px plate — the ladder's fill convention */}
        </span>
      ) : undefined}
      label={(
        <HStack gap={2} align="center" wrap="wrap">
          <Text type="label" size="sm">{label}</Text>
          <span className="settingsStatus">
            <StatusDot variant={dotForStatus(stateCopy.tone)} label={stateCopy.label} />
            <span>{stateCopy.label}</span>
          </span>
        </HStack>
      )}
      description={(
        <VStack gap={0.5}>
          <Text type="supporting" size="sm" color="secondary">{purpose}</Text>
          {!props.history && impact ? (
            <Text type="supporting" size="sm" color="secondary">
              {props.copy.impact} {impact}
            </Text>
          ) : null}
          {reason ? (
            <Text type="supporting" size="sm" color="secondary">{reason}</Text>
          ) : null}
          {diverged ? (
            <Text type="supporting" size="sm" color="secondary">
              {props.copy.desktopConsumer}: {props.copy.osStates[props.desktopStatus].label}
              {' · '}{props.copy.historyConsumer}: {props.copy.osStates[consumerStatus].label}
            </Text>
          ) : null}
          {actionCount > 0 ? <div className="settingsRowActionsUnder">{actionCluster}</div> : null}
        </VStack>
      )}
    />
  );
}

function capabilityReasonText(
  reason: string | undefined,
  capability: CapabilitySnapshot,
  copy: PermissionCenterCopy,
  locale: UiLocale,
): string | undefined {
  if (!reason) return undefined;
  if (reason === 'cu_backend_status') {
    const missing = capability.osPermissions
      .filter((permission) => permission.required && permission.status !== 'granted')
      .map((permission) => copy.osPermissions[permission.id]?.label ?? permission.id);
    return copy.cuBackendStatus(missing, capability.runtimeProbe.state);
  }
  if (isCapabilityReasonCode(reason)) {
    return getCapabilityReasonCopy(locale)[reason];
  }
  if (capability.id.startsWith('bot:')) {
    return botStatusReasonCopy(reason, locale) ?? copy.reasonFallback;
  }
  return copy.reasonFallback;
}

function osPermissionReasonText(
  snapshot: OsPermissionSnapshot,
  copy: PermissionCenterCopy,
  locale: UiLocale,
): string | undefined {
  return snapshot.reason
    ? isCapabilityReasonCode(snapshot.reason)
      ? getCapabilityReasonCopy(locale)[snapshot.reason]
      : copy.reasonFallback
    : undefined;
}
