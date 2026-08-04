import { useEffect, useState, type ComponentType } from 'react';
import {
  Accessibility as AccessibilityIcon,
  Bell,
  Mic,
  Monitor,
  MousePointer2,
  type LucideProps,
} from '@maka/ui/icons';
import type {
  CapabilityId,
  CapabilitySnapshot,
  CapabilitySnapshotCollection,
  OsPermissionId,
  OsPermissionSnapshot,
  PermissionSnapshot,
  UiLocale,
} from '@maka/core';
import { isDragGrantPermissionId, OS_PERMISSION_IDS } from '@maka/core';
import {
  Banner,
  Button,
  HStack,
  List,
  ListItem,
  MetadataList,
  MetadataListItem,
  Text,
  VStack,
} from '@astryxdesign/core';
import { RelativeTime, StatusDot, useMountedRef, useToast, useUiLocale } from '@maka/ui';
import { SettingsPage, SettingsSection } from './settings-section';
import { getPermissionCenterCopy, type PermissionCenterCopy } from '../locales/permission-center-copy';
import { settingsActionErrorMessage } from './settings-error-copy';
import { statusDotVariant } from './settings-status-badge';
import { SettingsSkeletonStack } from './settings-skeleton';
import { useActionGuard } from './use-action-guard';

/**
 * PR-UI-8 — Permission Center read-only page. Consumes `window.maka.permissions.getSnapshot()`
 * and `window.maka.capabilities.getSnapshot()` (both shipped by @xuan PR-REAL-2).
 *
 * Stage 1 Hard Gate contract:
 * - Renders the live snapshot per capability with explicit four-layer breakdown
 *   (OS permission · feature toggle · action approval · memory acceptance), so
 *   the user can see WHY each capability lands on its readiness state.
 * - Surfaces every OS permission separately at the bottom so users can verify
 *   the underlying TCC state without re-deriving it from capabilities.
 * - The page still never pretends to REVOKE OS TCC — that is the OS's to
 *   give and take. It does now guide the grant: the drag-`.app` flow the
 *   original read-only note was waiting on exists (see
 *   `main/permission-overlay/`, docs/permission-onboarding-plan.md), so
 *   accessibility / screen recording offer a guided action beside the
 *   plain "open System Settings" link, which stays put.
 * - Audit hint slot is reserved (`auditEvents` is empty for now) — once
 *   PR-REAL-3 wires the audit log, the slot fills without UI change.
 */
const OS_PERMISSION_ICONS: Record<OsPermissionId, ComponentType<LucideProps>> = {
  accessibility: AccessibilityIcon,
  screen_recording: Monitor,
  microphone: Mic,
  notifications: Bell,
  automation: MousePointer2,
};

export function PermissionCenterPage() {
  const locale = useUiLocale();
  const copy = getPermissionCenterCopy(locale);
  const [permissions, setPermissions] = useState<PermissionSnapshot | null>(null);
  const [capabilities, setCapabilities] = useState<CapabilitySnapshotCollection | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [pendingPermAction, setPendingPermAction] = useState<string | null>(null);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const toast = useToast();
  const mountedRef = useMountedRef();
  const permissionActionGuard = useActionGuard<string>();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      window.maka.permissions.getSnapshot(),
      window.maka.capabilities.getSnapshot(),
    ])
      .then(([perm, caps]) => {
        if (cancelled) return;
        setPermissions(perm);
        setCapabilities(caps);
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
  }, [locale, refreshTick]);

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

  async function runPermissionAction(
    permId: OsPermissionId,
    kind: 'request' | 'openSettings' | 'dragGrant',
  ) {
    const actionKey = `${permId}:${kind}`;
    if (!permissionActionGuard.begin(actionKey)) return;
    setPendingPermAction(actionKey);
    try {
      const result =
        kind === 'request'
          ? await window.maka.permissions.requestAccess(permId)
          : kind === 'dragGrant'
            ? await window.maka.permissions.startDragOnboarding(permId)
            : await window.maka.permissions.openSystemSettings(permId);
      if (result.ok) {
        // A direct request resolves after the user has answered, so refresh
        // now. Deep links and the drag guide resolve as soon as System
        // Settings opens; those refresh when Maka regains focus instead.
        if (kind === 'request' && mountedRef.current) {
          setRefreshTick((tick) => tick + 1);
        }
      } else if (mountedRef.current) {
        toast.error(copy.actionFailed, permissionActionFailureCopy(result.reason, result.message, copy));
      }
    } catch (err) {
      if (mountedRef.current) toast.error(copy.actionFailed, settingsActionErrorMessage(err, locale));
    } finally {
      if (permissionActionGuard.current === actionKey) {
        permissionActionGuard.finish();
      }
      if (mountedRef.current) setPendingPermAction(null);
    }
  }

  if (loading) {
    return (
      <SettingsSkeletonStack label={copy.loading} />
    );
  }

  if (error || !permissions || !capabilities) {
    return (
      <Banner
        status="error"
        role="alert"
        title={copy.readFailed}
        description={error ?? copy.noData}
        endContent={(
          <Button variant="primary" onClick={() => setRefreshTick((tick) => tick + 1)} label={copy.readAgain} />
        )}
      />
    );
  }

  const checkedAtMs = capabilities.checkedAt;
  const counts = summarizePermissionStatuses(permissions);

  return (
    <SettingsPage>
      {/* The page opened with a SectionHeader whose title was the page title
          VERBATIM (权限与能力 twice, ~40px apart) and whose subtitle restated
          the 系统权限 section's own help line below it. Worse, the refresh
          cluster sat in that header's action slot, so the subtitle wrapped
          around it and the paragraph collided with the button.

          Both lines were duplicates, so what is left is the freshness readout
          and its action. */}
      <SettingsSection
        variant="bare"
        title={copy.osSection}
        description={copy.osSectionHelp}
        action={(
          <div className="settingsFormRowControlCluster">
            <Text type="supporting" size="sm" color="secondary">
              {copy.lastRead}<RelativeTime ts={checkedAtMs} />
            </Text>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setRefreshTick((tick) => tick + 1)}
              label={copy.detectAgain}
            />
          </div>
        )}
      >
        <p className="settingsHealthSummaryLine" aria-label={copy.summaryAria}>
          <span data-tone="neutral">{copy.granted} {counts.granted}</span>
          <span data-tone={counts.pending > 0 ? 'warning' : 'neutral'}>{copy.pending} {counts.pending}</span>
          <span data-tone={counts.denied > 0 ? 'destructive' : 'neutral'}>{copy.denied} {counts.denied}</span>
          <span data-tone="neutral">{copy.other} {counts.other}</span>
        </p>
        <List hasDividers aria-label={copy.osListAria}>
            {OS_PERMISSION_IDS.map((id) => (
              <OsPermissionRow
                key={id}
                snapshot={permissions.permissions[id]}
                copy={copy}
                locale={locale}
                busy={pendingPermAction !== null}
                pendingKey={
                  pendingPermAction === `${id}:request`
                    ? 'request'
                    : pendingPermAction === `${id}:openSettings`
                      ? 'openSettings'
                      : pendingPermAction === `${id}:dragGrant`
                        ? 'dragGrant'
                        : null
                }
                onRequest={() => void runPermissionAction(id, 'request')}
                onOpenSettings={() => void runPermissionAction(id, 'openSettings')}
                onDragGrant={() => void runPermissionAction(id, 'dragGrant')}
              />
            ))}
          </List>
      </SettingsSection>

      <SettingsSection
        variant="bare"
        title={copy.capabilitiesSection}
        description={copy.capabilitiesHelp}
        action={(
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setDiagnosticsOpen((open) => !open)}
            aria-expanded={diagnosticsOpen}
            label={diagnosticsOpen ? copy.collapseDetails : copy.expandDetails}
          />
        )}
      >
        <List hasDividers aria-label={copy.capabilityListAria}>
            {capabilities.capabilities.map((capability) => (
              <CapabilityRow
                key={capability.id}
                capability={capability}
                copy={copy}
                locale={locale}
                diagnosticsOpen={diagnosticsOpen}
              />
            ))}
        </List>
      </SettingsSection>

      <Text type="supporting" size="sm" color="secondary">{copy.footnote}</Text>
    </SettingsPage>
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
    const status = snapshot.permissions[id]?.status;
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
 * One capability row.
 *
 * The four-layer breakdown, the required-permission list and the guidance list
 * used to be a `<dl>` and two `<ul>`s with ~180 lines of CSS giving them label
 * columns, tone colors and spacing. They are all "label → value" readouts, so
 * they are Astryx `MetadataList` now, and the diagnostics toggle simply chooses
 * whether to render them rather than driving a `data-diagnostics-open`
 * attribute that CSS then translated into a collapse.
 */
function CapabilityRow(props: {
  capability: CapabilitySnapshot;
  copy: PermissionCenterCopy;
  locale: UiLocale;
  diagnosticsOpen: boolean;
}) {
  const { capability } = props;
  const { copy, locale } = props;
  const readinessCopy = copy.readiness[capability.readiness];
  const capabilityLabel = localizedCapabilityLabel(capability, locale);
  const featureReason = localizedSnapshotText(capability.feature.reason, locale);
  const configurationReason = localizedSnapshotText(capability.configuration.reason, locale);
  const runtimeReason = localizedSnapshotText(capability.runtimeProbe.reason, locale);
  const guidance = localizedCapabilityGuidance(capability, locale, copy);

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
    <ListItem
      data-readiness={capability.readiness}
      /* Contract hook for the DiagnosticsExpanded story. It used to assert on
         `.settingsCapabilityList[data-diagnostics-open]`, but the list is an
         Astryx `List` now and Astryx does not forward arbitrary data-* to it;
         ListItem does, and the row is where the disclosure actually lands. */
      data-diagnostics={props.diagnosticsOpen ? 'open' : 'closed'}
      /* The readiness Badge rides the LABEL row, not endContent. ListItem
         centers endContent against the whole row, so with diagnostics expanded
         the badge floated hundreds of pixels below the title it describes. */
      label={(
        <HStack gap={2} align="center">
          <Text type="label" size="sm">{capabilityLabel}</Text>
          <span className="settingsStatus">
            <StatusDot variant={statusDotVariant(readinessCopy.tone)} label={readinessCopy.label} />
            <span>{readinessCopy.label}</span>
          </span>
        </HStack>
      )}
      description={(
        <VStack gap={2}>
          <VStack gap={0.5}>
            <Text type="code" size="xsm" color="secondary">{prettyCapabilityId(capability.id)}</Text>
            <Text type="supporting" size="sm" color="secondary">{readinessCopy.detail}</Text>
          </VStack>
          {props.diagnosticsOpen ? (
            <VStack gap={3}>
              {/* Explicit 2 columns: `columns="multi"` laid every item out
                  full width, so the five layers became five tall rows and the
                  row grew ~5x. `label position: start` keeps each readout on
                  one line (label left, value right) like the <dl> it replaced. */}
              <MetadataList
                columns={2}
                label={{ position: 'start', width: 92 }}
                aria-label={copy.layers.aria(capabilityLabel)}
              >
                {layers.map((layer) => (
                  <MetadataListItem key={layer.label} label={layer.label}>
                    {/* Stacked: MetadataListItem flows its children inline, so
                        an unwrapped reason ran straight into the state value
                        ("探测降级cua-driver 未响应握手…"). */}
                    <VStack gap={0.5}>
                      <Text type="body" size="sm">{layer.value}</Text>
                      {layer.reason ? (
                        <Text type="supporting" size="xsm" color="secondary">{layer.reason}</Text>
                      ) : null}
                    </VStack>
                  </MetadataListItem>
                ))}
              </MetadataList>
              {capability.osPermissions.length > 0 && (
                <MetadataList
                  columns={2}
                  label={{ position: 'start', width: 92 }}
                  aria-label={copy.requiredPermissionsAria(capabilityLabel)}
                  title={copy.requiredPermissions}
                >
                  {capability.osPermissions.map((req) => (
                    <MetadataListItem key={req.id} label={copy.osPermissions[req.id]?.label ?? req.id}>
                      <span className="settingsStatus">
                        <StatusDot variant={statusDotVariant(copy.osStates[req.status].tone)} label={copy.osStates[req.status].label} />
                        <span>{copy.osStates[req.status].label}</span>
                      </span>
                    </MetadataListItem>
                  ))}
                </MetadataList>
              )}
              {guidance.length > 0 && (
                <VStack gap={1}>
                  <Text type="label" size="sm">{copy.guidance}</Text>
                  <List aria-label={copy.guidanceAria(capabilityLabel)} density="compact">
                    {guidance.map((item, index) => (
                      <ListItem
                        key={`${capability.id}-guidance-${index}`}
                        label={<Text type="supporting" size="sm" color="secondary">{item}</Text>}
                      />
                    ))}
                  </List>
                </VStack>
              )}
              {/*
                PR-UX-POLISH-1 commit 2 (yuejing UX audit + xuan
                ROADMAP-SURFACE-0 + kenji boundary 1): unavailable pause/revoke
                chips looked like disabled toggles, which violates the
                capability presentation contract. Keep them hidden until there
                are real actions.
              */}
              {capability.auditEvents.length === 0 ? (
                <Text type="supporting" size="xsm" color="secondary">{copy.noAudit}</Text>
              ) : (
                <List aria-label={copy.auditAria(capabilityLabel)} density="compact">
                  {capability.auditEvents.slice(-3).map((event, index) => (
                    <ListItem
                      key={`${capability.id}-audit-${index}`}
                      label={<Text type="supporting" size="xsm" color="secondary">{event}</Text>}
                    />
                  ))}
                </List>
              )}
            </VStack>
          ) : null}
        </VStack>
      )}
    />
  );
}

function OsPermissionRow(props: {
  snapshot: OsPermissionSnapshot;
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
  const reason = localizedSnapshotText(snapshot.reason, props.locale);

  const showRequest = snapshot.canRequest && snapshot.status !== 'granted';
  const showOpenSettings = snapshot.canOpenSettings && snapshot.status !== 'granted';
  // Drag-to-grant applies to the two permissions macOS gives no
  // programmatic consent dialog for, where the stock path ends in a file
  // picker. `canOpenSettings` is the platform proxy — main only sets it on
  // darwin — so this never renders where the gesture cannot work.
  const showDragGrant =
    isDragGrantPermissionId(snapshot.id)
    && snapshot.canOpenSettings
    && snapshot.status !== 'granted';

  const actionCount = Number(showOpenSettings) + Number(showDragGrant) + Number(showRequest);
  const actionCluster = actionCount > 0 && (
    /* PR-PERMISSIONS-UNIFIED-CARD-0 (WAWQAQ msg `d3ea9a33` 2026-06-26):
       the action buttons used to stack vertically with two competing
       button styles. Order so the recommended action anchors the right
       edge, with the manual route as a quieter neighbour.

       Placement depends on how many there are: a single action rides the
       row's end slot as before, but the multi-button grant cluster (Screen
       Recording: 前往系统设置 + 引导授权 + 请求授权, ~420px in English)
       crushed the label column into a one-word-per-line sliver. Three
       buttons are a flow, not a row control — they move under the
       description and keep the full card width. */
    <HStack gap={2} align="center" wrap="wrap">
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
    </HStack>
  );

  return (
    <ListItem
      data-state={snapshot.status}
      /* The plate keeps its class: a status-tinted rounded icon well is
         product artwork (it turns red when a permission is denied), not
         layout, and Astryx's startContent slot has no equivalent. */
      startContent={Icon ? (
        <span className="settingsOsPermissionIcon" aria-hidden="true">
          <Icon size={18} />
        </span>
      ) : undefined}
      label={(
        <HStack gap={2} align="center">
          <Text type="label" size="sm">{label}</Text>
          <span className="settingsStatus">
            <StatusDot variant={statusDotVariant(stateCopy.tone)} label={stateCopy.label} />
            <span>{stateCopy.label}</span>
          </span>
        </HStack>
      )}
      description={(
        <VStack gap={0.5}>
          <Text type="supporting" size="sm" color="secondary">{purpose}</Text>
          {impact ? (
            <Text type="supporting" size="xsm" color="secondary">
              {props.copy.impact} {impact}
            </Text>
          ) : null}
          {reason ? (
            <Text type="supporting" size="xsm" color="secondary">{reason}</Text>
          ) : null}
          {actionCount > 1 ? <div className="settingsRowActionsUnder">{actionCluster}</div> : null}
        </VStack>
      )}
      endContent={actionCount === 1 ? actionCluster : undefined}
    />
  );
}

function prettyCapabilityId(id: CapabilityId): string {
  return id;
}

function localizedCapabilityLabel(capability: CapabilitySnapshot, locale: UiLocale): string {
  return capability.label;
}

function localizedSnapshotText(value: string | undefined, locale: UiLocale): string | undefined {
  if (!value || (locale === 'en' && /[\u3400-\u9fff]/u.test(value))) return undefined;
  return value;
}

function localizedCapabilityGuidance(
  capability: CapabilitySnapshot,
  locale: UiLocale,
  copy: PermissionCenterCopy,
): readonly string[] {
  return capability.guidance.filter((item) => locale === 'zh' || !/[\u3400-\u9fff]/u.test(item));
}

function featureTone(state: CapabilitySnapshot['feature']['state']): 'neutral' | 'info' | 'success' | 'warning' | 'destructive' {
  if (state === 'enabled') return 'success';
  if (state === 'partial') return 'warning';
  if (state === 'disabled') return 'info';
  return 'neutral';
}

function configurationTone(state: CapabilitySnapshot['configuration']['state']): 'neutral' | 'info' | 'success' | 'warning' | 'destructive' {
  if (state === 'present') return 'success';
  if (state === 'missing') return 'warning';
  return 'neutral';
}

function actionApprovalTone(state: CapabilitySnapshot['actionApproval']['state']): 'neutral' | 'info' | 'success' | 'warning' | 'destructive' {
  if (state === 'approved') return 'success';
  if (state === 'denied') return 'destructive';
  if (state === 'pending') return 'warning';
  if (state === 'required_per_action' || state === 'required_scoped_lease') return 'info';
  return 'neutral';
}

function memoryAcceptanceTone(state: CapabilitySnapshot['memoryAcceptance']['state']): 'neutral' | 'info' | 'success' | 'warning' | 'destructive' {
  if (state === 'accepted') return 'success';
  if (state === 'draft_required') return 'warning';
  return 'neutral';
}

function runtimeProbeTone(state: CapabilitySnapshot['runtimeProbe']['state']): 'neutral' | 'info' | 'success' | 'warning' | 'destructive' {
  if (state === 'healthy') return 'success';
  if (state === 'degraded') return 'destructive';
  if (state === 'not_run') return 'warning';
  return 'neutral';
}
