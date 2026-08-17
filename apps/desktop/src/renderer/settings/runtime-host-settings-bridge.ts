import type { DesktopRuntimeHostRef } from '../../preload/bridge-contract.js';
import type { ConnectionsBridge } from './provider-panel-shared.js';
import type { OAuthLoginFlowBridge } from './use-oauth-login-flow.js';

export type RuntimeHostSettingsConnectionsBridge = ConnectionsBridge & {
  setDefaultModel(input: { slug: string; model: string } | null): Promise<void>;
};

export function runtimeHostConnectionsBridge(
  host: DesktopRuntimeHostRef,
): RuntimeHostSettingsConnectionsBridge {
  return {
    getSnapshot: () => window.maka.connections.getSnapshot(undefined, host),
    setDefault: (slug) => window.maka.connections.setDefault(slug, host),
    setDefaultModel: (input) => window.maka.connections.setDefaultModel(input, host),
    create: (input) => window.maka.connections.create(input, host),
    update: (slug, patch) => window.maka.connections.update(slug, patch, host),
    delete: (slug) => window.maka.connections.delete(slug, host),
    test: (slug, options) => window.maka.connections.test(slug, options, host),
    fetchModels: (slug) => window.maka.connections.fetchModels(slug, host),
    hasSecret: (slug) => window.maka.connections.hasSecret(slug, host),
    getRequestHeaders: (slug) => window.maka.connections.getRequestHeaders(slug, host),
    setRequestHeaders: (slug, headers) =>
      window.maka.connections.setRequestHeaders(slug, headers, host),
    subscribeEvents: (handler) =>
      window.maka.connections.subscribeEvents(handler, host),
  };
}

export function runtimeHostOAuthLoginBridge(
  bridge: typeof window.maka.openAiCodex | typeof window.maka.xaiOAuth,
  host: DesktopRuntimeHostRef,
): OAuthLoginFlowBridge {
  return {
    getAuthUrl: () =>
      bridge.getAuthUrl(host) as ReturnType<OAuthLoginFlowBridge['getAuthUrl']>,
    openAuthUrl: (authRequestId) => bridge.openAuthUrl(authRequestId, host),
    completeAuthorization: (authRequestId) =>
      bridge.completeAuthorization(authRequestId, host),
    cancelAuthorization: (authRequestId) =>
      bridge.cancelAuthorization(authRequestId, host),
    getAccountState: () => bridge.getAccountState(host),
    logout: () => bridge.logout(host),
  };
}
