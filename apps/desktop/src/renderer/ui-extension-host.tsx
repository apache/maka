import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type {
  ExtensionUiContributionProjection,
  ExtensionUiSnapshotResult,
} from '@maka/runtime-host/protocol';

const DESKTOP_UI_SCOPE = 'desktop-ui';
const REFRESH_MS = 1_000;

/**
 * The fixed Desktop shell is intentionally tiny. The shipped Maka product UI
 * is the trusted fallback snapshot; installed client-only revisions enter the
 * same root/overlay selection path and may replace the entire product surface.
 */
export function UiExtensionHost({ officialSnapshot }: { officialSnapshot: ReactNode }) {
  const [snapshot, setSnapshot] = useState<ExtensionUiSnapshotResult | null>(null);
  const [safeMode, setSafeMode] = useState(false);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        const next = await window.maka.runtimeHost.query('extension.ui.snapshot', {
          scopeId: DESKTOP_UI_SCOPE,
        });
        if (!disposed) setSnapshot((current) => (current?.digest === next.digest ? current : next));
      } catch {
        // Fail open to the compiled official snapshot while the Host reconnects.
      } finally {
        if (!disposed) timer = setTimeout(refresh, REFRESH_MS);
      }
    };
    void refresh();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    const recover = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key === 'Backspace') {
        event.preventDefault();
        setSafeMode(true);
      }
    };
    window.addEventListener('keydown', recover, { capture: true });
    return () => window.removeEventListener('keydown', recover, { capture: true });
  }, []);

  const selected = useMemo(
    () => selectUiSnapshots(officialSnapshot, snapshot?.contributions ?? []),
    [officialSnapshot, snapshot],
  );
  const selectedRoot = safeMode ? selected.official : selected.root;
  return (
    <div className="maka-ui-extension-shell" data-ui-safe-mode={safeMode || undefined}>
      {selectedRoot.kind === 'sandboxed' ? (
        <SandboxedUiFrame contribution={selectedRoot.contribution} layer="root" />
      ) : (
        <div
          className="maka-ui-official-snapshot"
          data-extension-id={selectedRoot.extensionId}
          data-extension-revision={selectedRoot.revision}
        >
          {selectedRoot.node}
        </div>
      )}
      {!safeMode && selected.overlays.map((item) => (
        <SandboxedUiFrame key={`${item.extensionId}:${item.id}`} contribution={item} layer="overlay" />
      ))}
    </div>
  );
}

type UiSnapshotCandidate =
  | {
      readonly kind: 'official';
      readonly extensionId: 'dev.maka.desktop';
      readonly revision: 'desktop-build';
      readonly id: 'official-root';
      readonly priority: -10_000;
      readonly node: ReactNode;
    }
  | {
      readonly kind: 'sandboxed';
      readonly extensionId: string;
      readonly revision: string;
      readonly id: string;
      readonly priority: number;
      readonly contribution: ExtensionUiContributionProjection;
    };

export function selectUiSnapshots(
  officialNode: ReactNode,
  contributions: readonly ExtensionUiContributionProjection[],
) {
  const official: UiSnapshotCandidate = Object.freeze({
    kind: 'official',
    extensionId: 'dev.maka.desktop',
    revision: 'desktop-build',
    id: 'official-root',
    priority: -10_000,
    node: officialNode,
  });
  const ordered = [...contributions].sort(
    (left, right) =>
      right.priority - left.priority ||
      left.extensionId.localeCompare(right.extensionId) ||
      left.id.localeCompare(right.id),
  );
  const dynamicRoot = ordered.find(({ surface }) => surface === 'app.root');
  return Object.freeze({
    official,
    root: dynamicRoot && dynamicRoot.priority > official.priority
      ? Object.freeze({
          kind: 'sandboxed' as const,
          extensionId: dynamicRoot.extensionId,
          revision: dynamicRoot.revision,
          id: dynamicRoot.id,
          priority: dynamicRoot.priority,
          contribution: dynamicRoot,
        })
      : official,
    overlays: Object.freeze(ordered.filter(({ surface }) => surface === 'app.overlay')),
  });
}

function SandboxedUiFrame({
  contribution,
  layer,
}: {
  contribution: ExtensionUiContributionProjection;
  layer: 'root' | 'overlay';
}) {
  return (
    <iframe
      className={`maka-ui-extension-frame maka-ui-extension-frame--${layer}`}
      title={`${contribution.extensionId}: ${contribution.id}`}
      data-extension-id={contribution.extensionId}
      data-extension-revision={contribution.revision}
      data-contribution-id={contribution.id}
      sandbox="allow-scripts allow-modals"
      referrerPolicy="no-referrer"
      srcDoc={withUiSandboxPolicy(contribution.document, contribution.network)}
    />
  );
}

export function withUiSandboxPolicy(document: string, network: boolean): string {
  const networkPolicy = network
    ? "connect-src https: wss:; img-src data: blob: https:; media-src blob: https:; font-src data: https:;"
    : "connect-src 'none'; img-src data: blob:; media-src blob:; font-src data:;";
  const policy = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; navigate-to 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; ${networkPolicy}">`;
  const head = /^\s*(?:<!doctype[^>]*>\s*)?<html(?:\s[^>]*)?>\s*<head(?:\s[^>]*)?>/iu;
  if (head.test(document)) return document.replace(head, (match) => `${match}${policy}`);
  return `<!doctype html><html><head>${policy}</head><body>${document}</body></html>`;
}
