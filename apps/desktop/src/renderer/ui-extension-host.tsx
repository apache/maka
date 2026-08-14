import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  ExtensionUiContributionProjection,
  ExtensionUiSnapshotResult,
  ExtensionUiStateValue,
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
  const frameRef = useRef<HTMLIFrameElement>(null);
  const token = useMemo(
    () => crypto.randomUUID(),
    [contribution.bindingId, contribution.revision, contribution.id],
  );
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      const request = decodeBridgeRequest(event.data, token);
      if (!request) return;
      const identity = {
        scopeId: DESKTOP_UI_SCOPE,
        bindingId: contribution.bindingId,
        extensionId: contribution.extensionId,
        revision: contribution.revision,
      };
      const operation = request.kind === 'invoke'
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
  }, [contribution, token]);
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
      srcDoc={withUiSandboxPolicy(
        contribution.document,
        contribution.network,
        contribution.hostState || (contribution.hostMethods?.length ?? 0) > 0 ? token : undefined,
      )}
    />
  );
}

export function withUiSandboxPolicy(document: string, network: boolean, bridgeToken?: string): string {
  const networkPolicy = network
    ? "connect-src https: wss:; img-src data: blob: https:; media-src blob: https:; font-src data: https:;"
    : "connect-src 'none'; img-src data: blob:; media-src blob:; font-src data:;";
  const policy = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; navigate-to 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; ${networkPolicy}">`;
  const bridge = bridgeToken ? `<script>${bridgeBootstrap(bridgeToken)}</script>` : '';
  const head = /^\s*(?:<!doctype[^>]*>\s*)?<html(?:\s[^>]*)?>\s*<head(?:\s[^>]*)?>/iu;
  if (head.test(document)) return document.replace(head, (match) => `${match}${policy}${bridge}`);
  return `<!doctype html><html><head>${policy}${bridge}</head><body>${document}</body></html>`;
}

function bridgeBootstrap(token: string): string {
  return `(function(){const token=${JSON.stringify(token)},pending=new Map();let sequence=0;window.addEventListener('message',function(event){const data=event.data;if(event.source!==parent||!data||data.channel!=='maka-ui-host/v1'||data.token!==token)return;const task=pending.get(data.id);if(!task)return;pending.delete(data.id);data.ok?task.resolve(data.result):task.reject(new Error(data.error||'Host request failed'));});function call(message){return new Promise(function(resolve,reject){const id=String(++sequence);pending.set(id,{resolve,reject});parent.postMessage(Object.assign({channel:'maka-ui-bridge/v1',token,id},message),'*');});}Object.defineProperty(window,'makaUI',{value:Object.freeze({getState:function(key){return call({kind:'get',key:key});},setState:function(key,value){return call({kind:'set',key:key,value:value});},deleteState:function(key){return call({kind:'delete',key:key});},invoke:function(method,args){return call({kind:'invoke',method:method,args:args===undefined?null:args});}}),writable:false,configurable:false});})();`;
}

type UiBridgeRequest =
  | { id: string; kind: 'get' | 'delete'; key: string }
  | { id: string; kind: 'set'; key: string; value: unknown }
  | { id: string; kind: 'invoke'; method: string; args: unknown };

function decodeBridgeRequest(value: unknown, token: string): UiBridgeRequest | null {
  if (!value || typeof value !== 'object') return null;
  const request = value as Record<string, unknown>;
  if (request.channel !== 'maka-ui-bridge/v1' || request.token !== token) return null;
  if (typeof request.id !== 'string' || !/^[0-9]{1,16}$/u.test(request.id)) return null;
  if (request.kind === 'invoke') {
    if (typeof request.method !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/u.test(request.method)) return null;
    return { id: request.id, kind: request.kind, method: request.method, args: request.args };
  }
  if (request.kind !== 'get' && request.kind !== 'set' && request.kind !== 'delete') return null;
  if (typeof request.key !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(request.key)) return null;
  return request.kind === 'set'
    ? { id: request.id, kind: request.kind, key: request.key, value: request.value }
    : { id: request.id, kind: request.kind, key: request.key };
}
