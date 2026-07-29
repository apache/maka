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
import { Button, Badge, Chip, EmptyState, RelativeTime, SectionHeader, StatTile, useMountedRef, useToast, useUiLocale } from '@maka/ui';
import { getPermissionCenterCopy, type PermissionCenterCopy } from '../locales/permission-center-copy';
import { settingsActionErrorMessage } from './settings-error-copy';
import { statusBadgeVariant } from './settings-status-badge';
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
        // Refresh snapshot so the user sees the new state when they
        // return from System Settings.
        if (mountedRef.current) setRefreshTick((tick) => tick + 1);
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
      <div className="settingsPermissionPage">
        <div className="settingsPermissionError" role="alert">
          <strong>{copy.readFailed}</strong>
          <small>{error ?? copy.noData}</small>
          <Button type="button" onClick={() => setRefreshTick((tick) => tick + 1)}>
            {copy.readAgain}
          </Button>
        </div>
      </div>
    );
  }

  const checkedAtMs = capabilities.checkedAt;
  const counts = summarizePermissionStatuses(permissions);

  return (
    <div className="settingsPermissionPage">
      {/* Polish wave Item 5: the intro was a second gray PageHeader banner
          restating the page title. Converged onto SectionHeader — the unique
          "open Privacy & Security directly" explainer stays as the subtitle;
          the last-read timestamp + re-detect button move into the action slot. */}
      <SectionHeader
        as="h3"
        title={copy.title}
        subtitle={copy.subtitle}
        action={
          <>
            <small className="whitespace-nowrap text-[length:var(--font-size-caption)] text-foreground-secondary">
              {copy.lastRead}<RelativeTime ts={checkedAtMs} className="settingsHelpInlineTime" />
            </small>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setRefreshTick((tick) => tick + 1)}
            >
              {copy.detectAgain}
            </Button>
          </>
        }
      />

      <section className="settingsPermissionSummary" aria-label={copy.summaryAria}>
        <PermissionSummaryTile label={copy.granted} value={counts.granted} tone="neutral" />
        <PermissionSummaryTile label={copy.pending} value={counts.pending} tone="warning" />
        <PermissionSummaryTile label={copy.denied} value={counts.denied} tone="destructive" />
        <PermissionSummaryTile label={copy.other} value={counts.other} tone="neutral" />
      </section>

      <section aria-label={copy.osSection} className="settingsPermissionSection">
        <header>
          <h4>{copy.osSection}</h4>
          <small>{copy.osSectionHelp}</small>
        </header>
        <ul className="settingsOsPermissionList" aria-label={copy.osListAria}>
          {OS_PERMISSION_IDS.map((id) => (
            <OsPermissionRow
              key={id}
              snapshot={permissions.permissions[id]}
              copy={copy}
              locale={locale}
              busy={pendingPermAction !== null}
              pendingKey={pendingPermAction === `${id}:request` ? 'request' : pendingPermAction === `${id}:openSettings` ? 'openSettings' : null}
              onRequest={() => void runPermissionAction(id, 'request')}
              onOpenSettings={() => void runPermissionAction(id, 'openSettings')}
              onDragGrant={() => void runPermissionAction(id, 'dragGrant')}
            />
          ))}
        </ul>
      </section>

      <section aria-label={copy.capabilitiesSection} className="settingsPermissionSection">
        <SectionHeader
          className="settingsPermissionSectionHeader"
          as="h4"
          title={copy.capabilitiesSection}
          subtitle={copy.capabilitiesHelp}
          action={
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setDiagnosticsOpen((open) => !open)}
              aria-expanded={diagnosticsOpen}
            >
              {diagnosticsOpen ? copy.collapseDetails : copy.expandDetails}
            </Button>
          }
        />
        <ul className="settingsCapabilityList" aria-label={copy.capabilityListAria} data-diagnostics-open={diagnosticsOpen ? 'true' : undefined}>
          {capabilities.capabilities.map((capability) => (
            <CapabilityRow key={capability.id} capability={capability} copy={copy} locale={locale} />
          ))}
        </ul>
      </section>

      <p className="settingsPermissionFootnote">
        {copy.footnote}
      </p>
    </div>
  );
}

function PermissionSummaryTile(props: {
  label: string;
  value: number;
  tone: 'success' | 'warning' | 'destructive' | 'neutral';
}) {
  // Convergence R4: StatTile owns the recipe (incl. the zero-is-not-an-
  // exception tone gate this tile pioneered).
  return (
    <StatTile
      className="settingsPermissionSummaryTile"
      label={props.label}
      value={props.value}
      tone={props.tone}
    />
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
    case 'failed':
      return message ?? copy.actionFailures.failed;
    default:
      return message ?? copy.actionFailures.failed;
  }
}

function CapabilityRow(props: { capability: CapabilitySnapshot; copy: PermissionCenterCopy; locale: UiLocale }) {
  const { capability } = props;
  const { copy, locale } = props;
  const readinessCopy = copy.readiness[capability.readiness];
  const capabilityLabel = localizedCapabilityLabel(capability, locale);
  const featureReason = localizedSnapshotText(capability.feature.reason, locale);
  const configurationReason = localizedSnapshotText(capability.configuration.reason, locale);
  const runtimeReason = localizedSnapshotText(capability.runtimeProbe.reason, locale);
  const guidance = localizedCapabilityGuidance(capability, locale, copy);

  return (
    <li className="settingsCapabilityRow" data-readiness={capability.readiness}>
      <div className="settingsCapabilityHeader">
        <div className="settingsCapabilityHeading">
          <strong>{capabilityLabel}</strong>
          <small className="settingsCapabilityId">{prettyCapabilityId(capability.id)}</small>
        </div>
        <Chip variant={readinessCopy.tone}>{readinessCopy.label}</Chip>
      </div>
      <p className="settingsCapabilityDetail">{readinessCopy.detail}</p>
      <dl className="settingsCapabilityLayers" aria-label={copy.layers.aria(capabilityLabel)}>
        <div>
          <dt>{copy.layers.feature}</dt>
          <dd data-tone={featureTone(capability.feature.state)}>
            {copy.layers.featureStates[capability.feature.state]}
            {featureReason && <small>{featureReason}</small>}
          </dd>
        </div>
        <div>
          <dt>{copy.layers.configuration}</dt>
          <dd data-tone={configurationTone(capability.configuration.state)}>
            {copy.layers.configurationStates[capability.configuration.state]}
            {configurationReason && <small>{configurationReason}</small>}
          </dd>
        </div>
        <div>
          <dt>{copy.layers.approval}</dt>
          <dd data-tone={actionApprovalTone(capability.actionApproval.state)}>
            {copy.layers.approvalStates[capability.actionApproval.state]}
          </dd>
        </div>
        <div>
          <dt>{copy.layers.memory}</dt>
          <dd data-tone={memoryAcceptanceTone(capability.memoryAcceptance.state)}>
            {copy.layers.memoryStates[capability.memoryAcceptance.state]}
          </dd>
        </div>
        <div>
          <dt>{copy.layers.runtime}</dt>
          <dd data-tone={runtimeProbeTone(capability.runtimeProbe.state)}>
            {copy.layers.runtimeStates[capability.runtimeProbe.state]}
            {runtimeReason && <small>{runtimeReason}</small>}
          </dd>
        </div>
      </dl>
      {capability.osPermissions.length > 0 && (
        <div className="settingsCapabilityOsPermissions">
          <span>{copy.requiredPermissions}</span>
          <ul aria-label={copy.requiredPermissionsAria(capabilityLabel)}>
            {capability.osPermissions.map((req) => (
              <li key={req.id}>
                <span>{copy.osPermissions[req.id]?.label ?? req.id}</span>
                <em data-tone={copy.osStates[req.status].tone}>
                  {copy.osStates[req.status].label}
                </em>
              </li>
            ))}
          </ul>
        </div>
      )}
      {guidance.length > 0 && (
        <div className="settingsCapabilityGuidance">
          <span>{copy.guidance}</span>
          <ul aria-label={copy.guidanceAria(capabilityLabel)}>
            {guidance.map((item, index) => (
              <li key={`${capability.id}-guidance-${index}`}>{item}</li>
            ))}
          </ul>
        </div>
      )}
      {/*
        PR-UX-POLISH-1 commit 2 (yuejing UX audit + xuan ROADMAP-SURFACE-0 +
        kenji boundary 1): unavailable pause/revoke chips looked like
        disabled toggles, which violates the capability presentation
        contract. Keep them hidden until there are real actions with
        `data-state="available"`.
      */}
      <div className="settingsCapabilityAuditSlot" aria-hidden={capability.auditEvents.length === 0}>
        {capability.auditEvents.length === 0 ? (
          <EmptyState variant="inline" title={copy.noAudit} body="" />
        ) : (
          <ul aria-label={copy.auditAria(capabilityLabel)}>
            {capability.auditEvents.slice(-3).map((event, index) => (
              <li key={`${capability.id}-audit-${index}`}>{event}</li>
            ))}
          </ul>
        )}
      </div>
    </li>
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

  return (
    <li className="settingsOsPermissionRow" data-state={snapshot.status}>
      <div className="settingsOsPermissionIcon" aria-hidden="true">
        {Icon ? <Icon size={18} /> : null}
      </div>
      <div className="settingsOsPermissionBody">
        <div className="settingsOsPermissionHeading">
          <strong>{label}</strong>
          <Badge variant={statusBadgeVariant(stateCopy.tone)}>{stateCopy.label}</Badge>
        </div>
        <small className="settingsOsPermissionPurpose">{purpose}</small>
        {impact ? (
          <small className="settingsOsPermissionImpact">
            <span className="settingsOsPermissionImpactLabel">{props.copy.impact}</span>
            <span>{impact}</span>
          </small>
        ) : null}
        {reason ? (
          <small className="settingsOsPermissionReason">{reason}</small>
        ) : null}
      </div>
      {/* PR-PERMISSIONS-UNIFIED-CARD-0 (WAWQAQ msg `d3ea9a33`
          2026-06-26): the action buttons used to stack vertically with
          two competing button styles (primary + secondary). Order so
          the primary "请求授权" anchors the right edge, with the
          system-settings link as a quieter ghost variant on the left.
          When only one button is shown (e.g. the OS doesn't expose a
          request flow for the permission), it still falls under the
          primary slot — no awkward "lonely secondary" state. */}
      <div className="settingsOsPermissionActions">
        {/* Affordance honesty (round 8): ghost next to the primary read as a
            plain text label — a clickable action sitting beside a real button
            needs its own visible edge. Secondary keeps it quieter than
            请求授权 without hiding that it's a button. */}
        {showOpenSettings && (
          <Button
            type="button"
            variant={showRequest || showDragGrant ? 'secondary' : 'default'}
            size="sm"
            onClick={props.onOpenSettings}
            disabled={busy}
            aria-busy={pendingKey === 'openSettings' ? 'true' : undefined}
          >
            {pendingKey === 'openSettings' ? props.copy.opening : props.copy.openSettings}
          </Button>
        )}
        {/* The guided flow is the primary action where it exists: it does
            what 前往系统设置 does and then stays to help. The plain link
            keeps its place beside it so the manual route is never removed. */}
        {showDragGrant && (
          <Button
            type="button"
            size="sm"
            onClick={props.onDragGrant}
            disabled={busy}
            aria-busy={pendingKey === 'dragGrant' ? 'true' : undefined}
          >
            {pendingKey === 'dragGrant' ? props.copy.dragGranting : props.copy.dragGrant}
          </Button>
        )}
        {showRequest && (
          <Button
            type="button"
            size="sm"
            onClick={props.onRequest}
            disabled={busy}
            aria-busy={pendingKey === 'request' ? 'true' : undefined}
          >
            {pendingKey === 'request' ? props.copy.requesting : props.copy.request}
          </Button>
        )}
      </div>
    </li>
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
