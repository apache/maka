import { useEffect, useState } from 'react';
import type {
  HealthSignal,
  HealthSignalLayer,
  HealthSnapshot,
} from '@maka/core';
import { HEALTH_SIGNAL_LAYERS } from '@maka/core';
import { Item } from '@astryxdesign/core';
import { Button, Badge, RelativeTime, SectionHeader, StatTile, useUiLocale, Banner } from '@maka/ui';
import { getHealthCenterCopy, type HealthCenterCopy } from '../locales/settings-health-copy';
import { settingsActionErrorMessage } from './settings-error-copy';
import { SettingsSkeletonStack } from './settings-skeleton';
import { statusBadgeVariant } from './settings-status-badge';

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
      .getSnapshot()
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
  }, [locale, refreshTick]);

  if (loading) {
    return (
      <SettingsSkeletonStack label={copy.loading} />
    );
  }

  if (error || !snapshot) {
    return (
      <div className="settingsHealthPage">
        <Banner
          status="error"
          title={copy.readFailed}
          description={error ?? copy.noData}
          endContent={<Button variant="primary" onClick={() => setRefreshTick((tick) => tick + 1)} label={copy.readAgain} />} />
      </div>
    );
  }

  const healthCheckedAtMs = snapshot.checkedAt;
  const signalsByLayer = groupSignalsByLayer(snapshot.signals);
  const blocksSendCount = snapshot.signals.filter((signal) => signal.blocksSend).length;
  const blocksCapabilityCount = snapshot.signals.filter((signal) => signal.blocksCapability).length;

  return (
    <div className="settingsHealthPage">
      {/* Polish wave Item 5: the intro was a second gray PageHeader banner
          restating the page title. Converged onto SectionHeader — the unique
          layer explainer + runtime caveat stay as the subtitle; the read-only
          badge, last-read timestamp, and refresh move into the action slot. */}
      <SectionHeader
        as="h3"
        title={copy.title}
        subtitle={
          <>
            {copy.subtitle} <strong>{copy.validationWarning}</strong>
          </>
        }
        action={
          <>
            <Badge variant="neutral" label={copy.badge} />
            <small className="whitespace-nowrap text-[length:var(--font-size-caption)] text-foreground-secondary">
              {copy.lastRead}<RelativeTime ts={healthCheckedAtMs} className="settingsHelpInlineTime" />
            </small>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setRefreshTick((tick) => tick + 1)}
              label={copy.refresh}
            />
          </>
        }
      />

      {/* PR-HEALTH-SUMMARY-LIST-A11Y-0 (round 19/30): fifth
          application of the ARIA list semantics fix. Was
          `<section role="list">` containing 5 `<div
          role="listitem">` tiles — switched to semantic
          `<ul>` / `<li>`. The HealthSummaryTile component
          drops its `role="listitem"` because the `<li>`
          wrapper already carries it. */}
      <ul aria-label={copy.summaryAria} className="settingsHealthSummary">
        <HealthSummaryTile tone="neutral" label={copy.statuses.ok.label} count={snapshot.summary.ok} />
        <HealthSummaryTile tone="info" label={copy.statuses.info.label} count={snapshot.summary.info} />
        <HealthSummaryTile tone="warning" label={copy.statuses.warning.label} count={snapshot.summary.warning} />
        <HealthSummaryTile tone="destructive" label={copy.statuses.error.label} count={snapshot.summary.error} />
        <HealthSummaryTile tone="neutral" label={copy.statuses.unknown.label} count={snapshot.summary.unknown} />
      </ul>

      {(blocksSendCount > 0 || blocksCapabilityCount > 0) && (
        <div className="settingsHealthBlockers" role="status">
          {blocksSendCount > 0 && (
            <Badge className="settingsHealthBlockerBadge" variant="error" label={copy.blockers.send(blocksSendCount)} />
          )}
          {blocksCapabilityCount > 0 && (
            <Badge className="settingsHealthBlockerBadge" variant="warning" label={copy.blockers.capability(blocksCapabilityCount)} />
          )}
        </div>
      )}

      {HEALTH_SIGNAL_LAYERS.map((layer) => {
        const signals = signalsByLayer[layer];
        if (!signals || signals.length === 0) return null;
        const layerCopy = copy.layers[layer];
        return (
          <section key={layer} className="settingsHealthLayer" aria-label={copy.layerAria(layerCopy.label)}>
            <header>
              <h4>{layerCopy.label}</h4>
              <small>{layerCopy.description}</small>
            </header>
            <ul className="settingsHealthSignalList" aria-label={copy.layerListAria(layerCopy.label)}>
              {signals.map((signal) => (
                <HealthSignalRow key={signal.id} signal={signal} copy={copy} />
              ))}
            </ul>
          </section>
        );
      })}

      <p className="settingsHealthFootnote">
        {copy.footnote}
      </p>
    </div>
  );
}

function HealthSummaryTile(props: {
  tone: 'neutral' | 'info' | 'success' | 'warning' | 'destructive';
  label: string;
  count: number;
}) {
  // Convergence R4: same StatTile as the permission summary — the two
  // recipes were literal twins hand-rolled twice.
  return (
    <StatTile
      as="li"
      className="settingsHealthSummaryTile"
      label={props.label}
      value={props.count}
      tone={props.tone}
    />
  );
}

function HealthSignalRow(props: { signal: HealthSignal; copy: HealthCenterCopy }) {
  const { signal, copy } = props;
  const statusCopy = copy.statuses[signal.status];
  const detail = copy.signalDetail(signal);
  return (
    <Item
      as="li"
      align="start"
      className="settingsHealthSignalRow"
      label={(
        <span className="settingsHealthSignalIdentity">
            <strong className="text-[length:var(--font-size-ui)] font-semibold text-foreground">{copy.signalLabel(signal)}</strong>
            <small className="text-[length:var(--font-size-caption)] uppercase tracking-wider text-muted-foreground">{copy.scopes[signal.scope]}</small>
        </span>
      )}
      description={(
        <span className="settingsHealthSignalDescription">
          <span>{copy.signalMessage(signal)}</span>
          {detail && <small>{detail}</small>}
          <span className="settingsHealthSignalMeta">
            <span>{copy.source}{copy.sources[signal.source]}</span>
            <span>{copy.checked}<RelativeTime ts={signal.checkedAt} className="settingsHelpInlineTime" /></span>
            {signal.blocksSend && <Badge variant="error" label={copy.blocksSend} />}
            {signal.blocksCapability && <Badge variant="warning" label={copy.blocksCapability} />}
          </span>
        </span>
      )}
      endContent={<Badge variant={statusBadgeVariant(statusCopy.tone)} label={statusCopy.label} />}
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
