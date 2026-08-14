import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  ExtensionUiContributionProjection,
  ExtensionUiSnapshotResult,
  ExtensionUiStateValue,
} from '@maka/runtime-host/protocol';
import { uiExtensionFrameUrl } from './ui-extension-frame-url.js';

const DESKTOP_UI_SCOPE = 'desktop-ui';
const REFRESH_MS = 1_000;

/**
 * The fixed Desktop shell is intentionally tiny. The shipped Maka product UI
 * is the trusted fallback snapshot; installed client-only revisions enter the
 * same root/overlay selection path and may replace the entire product surface.
 */
export function UiExtensionHost({
  officialSnapshot,
}: {
  officialSnapshot: () => ReactNode;
}) {
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
    () => selectUiSnapshots(null, snapshot?.contributions ?? []),
    [snapshot],
  );
  const selectedRoot = safeMode ? selected.official : selected.root;
  return (
    <div
      className="maka-ui-extension-shell"
      data-ui-safe-mode={safeMode || undefined}
      data-ui-composition-id={safeMode ? 'dev.maka.desktop@desktop-build' : snapshot?.digest}
    >
      {selectedRoot.kind === 'sandboxed' ? (
        <SandboxedUiFrame
          contribution={selectedRoot.contribution}
          layer="root"
          onSafeMode={() => setSafeMode(true)}
        />
      ) : (
        <div
          className="maka-ui-official-snapshot"
          data-extension-id={selectedRoot.extensionId}
          data-extension-revision={selectedRoot.revision}
        >
          {officialSnapshot()}
        </div>
      )}
      {!safeMode && selected.overlays.map((item) => (
        <SandboxedUiFrame
          key={`${item.extensionId}:${item.id}`}
          contribution={item}
          layer="overlay"
          onSafeMode={() => setSafeMode(true)}
        />
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
  onSafeMode,
}: {
  contribution: ExtensionUiContributionProjection;
  layer: 'root' | 'overlay';
  onSafeMode: () => void;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const token = useMemo(
    () => crypto.randomUUID(),
    [contribution.bindingId, contribution.revision, contribution.id],
  );
  useLayoutEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      if (isBridgeReady(event.data, token)) {
        postBridgeReady(frameRef.current, token);
        return;
      }
      const request = decodeBridgeRequest(event.data, token);
      if (!request) return;
      if (request.kind === 'safe_mode') {
        onSafeMode();
        return;
      }
      const identity = {
        scopeId: DESKTOP_UI_SCOPE,
        bindingId: contribution.bindingId,
        extensionId: contribution.extensionId,
        revision: contribution.revision,
      };
      const operation = isSessionBridgeRequest(request)
        ? runSessionBridgeRequest(contribution, request)
        : request.kind === 'invoke'
        ? window.maka.runtimeHost.command('extension.ui.rpc.invoke', {
          ...identity,
          method: request.method,
          args: request.args as ExtensionUiStateValue,
        })
        : request.kind === 'get'
          ? window.maka.runtimeHost.query('extension.ui.state.query', {
            ...identity,
            key: request.key,
          })
          : window.maka.runtimeHost.command(
            'extension.ui.state.mutate',
            request.kind === 'set'
              ? { ...identity, key: request.key, kind: 'set', value: request.value as ExtensionUiStateValue }
              : { ...identity, key: request.key, kind: 'delete' },
          );
      void operation.then(
        (result) => frameRef.current?.contentWindow?.postMessage({ channel: 'maka-ui-host/v1', token, id: request.id, ok: true, result }, '*'),
        (error) => frameRef.current?.contentWindow?.postMessage({ channel: 'maka-ui-host/v1', token, id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) }, '*'),
      );
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [contribution, onSafeMode, token]);
  return (
    <iframe
      ref={frameRef}
      className={`maka-ui-extension-frame maka-ui-extension-frame--${layer}`}
      title={`${contribution.extensionId}: ${contribution.id}`}
      data-extension-id={contribution.extensionId}
      data-extension-revision={contribution.revision}
      data-contribution-id={contribution.id}
      sandbox="allow-scripts allow-modals"
      referrerPolicy="no-referrer"
      src={uiExtensionFrameUrl({
        scopeId: DESKTOP_UI_SCOPE,
        bindingId: contribution.bindingId,
        extensionId: contribution.extensionId,
        revision: contribution.revision,
        contributionId: contribution.id,
        token,
      })}
    />
  );
}

function postBridgeReady(frame: HTMLIFrameElement | null, token: string): void {
  frame?.contentWindow?.postMessage({ channel: 'maka-ui-host-ready/v1', token }, '*');
}

function isBridgeReady(value: unknown, token: string): boolean {
  if (!value || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  return message.channel === 'maka-ui-bridge-ready/v1' && message.token === token;
}

type UiBridgeRequest =
  | { id: string; kind: 'safe_mode' }
  | { id: string; kind: 'get' | 'delete'; key: string }
  | { id: string; kind: 'set'; key: string; value: unknown }
  | { id: string; kind: 'invoke'; method: string; args: unknown }
  | { id: string; kind: 'session_list' }
  | { id: string; kind: 'session_send'; sessionId?: string; text: string }
  | { id: string; kind: 'session_stop'; sessionId: string };

function decodeBridgeRequest(value: unknown, token: string): UiBridgeRequest | null {
  if (!value || typeof value !== 'object') return null;
  const request = value as Record<string, unknown>;
  if (request.channel !== 'maka-ui-bridge/v1' || request.token !== token) return null;
  if (typeof request.id !== 'string' || !/^[0-9]{1,16}$/u.test(request.id)) return null;
  if (request.kind === 'safe_mode') return { id: request.id, kind: request.kind };
  if (request.kind === 'invoke') {
    if (typeof request.method !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/u.test(request.method)) return null;
    return { id: request.id, kind: request.kind, method: request.method, args: request.args };
  }
  if (request.kind === 'session_list') return { id: request.id, kind: request.kind };
  if (request.kind === 'session_send') {
    if (
      (request.sessionId !== undefined && !isBridgeIdentifier(request.sessionId)) ||
      typeof request.text !== 'string' ||
      request.text.trim().length === 0 ||
      request.text.length > 64 * 1024
    ) return null;
    return {
      id: request.id,
      kind: request.kind,
      ...(request.sessionId ? { sessionId: request.sessionId } : {}),
      text: request.text,
    };
  }
  if (request.kind === 'session_stop') {
    if (!isBridgeIdentifier(request.sessionId)) return null;
    return { id: request.id, kind: request.kind, sessionId: request.sessionId };
  }
  if (request.kind !== 'get' && request.kind !== 'set' && request.kind !== 'delete') return null;
  if (typeof request.key !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(request.key)) return null;
  return request.kind === 'set'
    ? { id: request.id, kind: request.kind, key: request.key, value: request.value }
    : { id: request.id, kind: request.kind, key: request.key };
}

function isBridgeIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\r\n\0]/u.test(value);
}

function isSessionBridgeRequest(
  request: UiBridgeRequest,
): request is Extract<UiBridgeRequest, { kind: `session_${string}` }> {
  return request.kind === 'session_list' ||
    request.kind === 'session_send' ||
    request.kind === 'session_stop';
}

async function runSessionBridgeRequest(
  contribution: ExtensionUiContributionProjection,
  request: Extract<UiBridgeRequest, { kind: `session_${string}` }>,
): Promise<unknown> {
  if (contribution.surface !== 'app.root' || contribution.sessionAccess !== true) {
    throw new Error('This UI Revision has no Session capability');
  }
  if (request.kind === 'session_list') {
    const sessions = await window.maka.sessions.list();
    return {
      sessions: sessions.map((session) => ({
        id: session.id,
        name: session.name,
        status: session.status,
        lastMessageAt: session.lastMessageAt,
        lastMessagePreview: session.lastMessagePreview,
        runningTurnIds: session.runningTurnIds ?? [],
        model: session.model,
      })),
    };
  }
  if (request.kind === 'session_stop') {
    await window.maka.sessions.stop(request.sessionId, { source: 'stop_button' });
    return { ok: true };
  }
  const session = request.sessionId
    ? (await window.maka.sessions.list()).find(({ id }) => id === request.sessionId)
    : await window.maka.sessions.create();
  if (!session) throw new Error('Maka Session does not exist');
  const turnId = crypto.randomUUID();
  const result = await window.maka.sessions.send(session.id, {
    type: 'send',
    turnId,
    text: request.text.trim(),
  });
  if (!result.ok) throw new Error('Prompt was rejected by Skill invocation');
  return { ok: true, sessionId: session.id, turnId };
}
