import type { StatusSemantic } from '@maka/ui';
import { useEffect, useState, type ComponentType } from 'react';
import {
  ICON_SIZE,
  Accessibility as AccessibilityIcon,
  Bell,
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
} from '@maka/core/capabilities';
import type { UiLocale } from '@maka/core/ui-locale';
import { isDragGrantPermissionId, OS_PERMISSION_IDS } from '@maka/core/capabilities';
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
import { RelativeTime, StatusDot, useMountedRef, useToast, useUiLocale } from '@maka/ui';
import { SettingsPage, SettingsSection } from './settings-section';
import { getPermissionCenterCopy, type PermissionCenterCopy } from '../locales/permission-center-copy';
import { settingsActionErrorMessage } from './settings-error-copy';
import { dotForStatus } from '@maka/ui';
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
        <p className="settingsHealthSummaryLine" role="group" aria-label={copy.summaryAria}>
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
      >
        {/* Each capability opens on its own, and only one at a time. The page
            used to carry a single 展开详情 button that unfolded four
            MetadataLists on EVERY row at once — a wall you had to scroll past
            to reach the one capability you came to diagnose. `type="single"`
            makes reading one row the default act; `hasDividers` +
            `density="compact"` is the same edge-to-edge hairline row this
            settings surface uses everywhere else, except now it is the
            component's, not ours. `density` must be stated: hasDividers
            silently defaults items to `balanced`. */}
        {/* `role="group"` is load-bearing, not decoration. CollapsibleGroup's
            wrapper is a bare div with no role of its own, and an aria-label on
            a role-less element names nothing — ARIA prohibits naming `generic`.
            The rows used to sit in a `List`, which ships `role="list"` and can
            carry a name, so without this the section would have quietly lost
            its accessible name in the move. `group` + aria-label is valid and
            gives 功能能力列表 back. */}
        <CollapsibleGroup
          type="single"
          hasDividers
          density="compact"
          role="group"
          className="settingsCapabilityGroup"
          aria-label={copy.capabilityListAria}
        >
          {capabilities.capabilities.map((capability) => (
            <CapabilityRow
              key={capability.id}
              capability={capability}
              copy={copy}
              locale={locale}
            />
          ))}
        </CollapsibleGroup>
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
 * One capability row — a Collapsible whose trigger is the row and whose content
 * is that capability's diagnostics.
 *
 * The four-layer breakdown, the required-permission list and the guidance list
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
            <Text type="code" size="sm" color="secondary">{prettyCapabilityId(capability.id)}</Text>
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
                  <Text type="body" size="sm">{layer.value}</Text>
                  {layer.reason ? (
                    <Text type="supporting" size="sm" color="secondary">{layer.reason}</Text>
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
                    <StatusDot variant={dotForStatus(copy.osStates[req.status].tone)} label={copy.osStates[req.status].label} />
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
      data-state={snapshot.status}
      /* The plate keeps its class: a status-tinted rounded icon well is
         product artwork (it turns red when a permission is denied), not
         layout, and Astryx's startContent slot has no equivalent. */
      startContent={Icon ? (
        <span className="settingsOsPermissionIcon" aria-hidden="true">
          <Icon size={ICON_SIZE.empty} /> {/* 20 in the 36px plate — the ladder's fill convention */}
        </span>
      ) : undefined}
      label={(
        <HStack gap={2} align="center">
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
          {impact ? (
            <Text type="supporting" size="sm" color="secondary">
              {props.copy.impact} {impact}
            </Text>
          ) : null}
          {reason ? (
            <Text type="supporting" size="sm" color="secondary">{reason}</Text>
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

function featureTone(state: CapabilitySnapshot['feature']['state']): StatusSemantic {
  if (state === 'enabled') return 'success';
  if (state === 'partial') return 'attention';
  // A capability the user turned off is a settled fact, not activity.
  if (state === 'disabled') return 'neutral';
  return 'neutral';
}

function configurationTone(state: CapabilitySnapshot['configuration']['state']): StatusSemantic {
  if (state === 'present') return 'success';
  if (state === 'missing') return 'attention';
  return 'neutral';
}

function actionApprovalTone(state: CapabilitySnapshot['actionApproval']['state']): StatusSemantic {
  if (state === 'approved') return 'success';
  if (state === 'denied') return 'error';
  if (state === 'pending') return 'attention';
  // A configured approval policy describes how things will behave, not
  // something happening now.
  if (state === 'required_per_action' || state === 'required_scoped_lease') return 'neutral';
  return 'neutral';
}

function memoryAcceptanceTone(state: CapabilitySnapshot['memoryAcceptance']['state']): StatusSemantic {
  if (state === 'accepted') return 'success';
  if (state === 'draft_required') return 'attention';
  return 'neutral';
}

function runtimeProbeTone(state: CapabilitySnapshot['runtimeProbe']['state']): StatusSemantic {
  if (state === 'healthy') return 'success';
  if (state === 'degraded') return 'error';
  if (state === 'not_run') return 'attention';
  return 'neutral';
}
