import type { ProviderType } from '@maka/core/llm-connections';
import type { DesktopRuntimeHostRef } from '../../preload/bridge-contract.js';
import { runtimeHostOAuthLoginBridge } from './runtime-host-settings-bridge.js';
import type { OAuthLoginFlowBridge } from './use-oauth-login-flow.js';

// Maps an OAuth model-connection provider type to the browser-assisted login
// service that can re-run its authorization from inside the connection dialog. Only
// the browser-assisted services (Codex and xAI) are one-button-drivable
// here; Claude's paste-code flow and plain API-key providers return null so the
// notice falls back to prose instead of rendering a dead button.
//
// A leaf module (no React, no hook imports) so the mapping stays loadable by
// the node:test suite that pins the device-code contract.
export interface OAuthLoginService {
  bridge: OAuthLoginFlowBridge;
  display: { name: string; shortName: string };
  // Codex's device-authorization page requires the user to type the code the
  // flow surfaces as `stateHint` — the verification URL does not embed it, so
  // the notice must show it or the login cannot be completed. xAI's page
  // needs no manual code, mirroring the catalog panel's `!isXai` guard.
  showsDeviceCode: boolean;
}

export function oauthLoginServiceFor(
  providerType: ProviderType,
  host: DesktopRuntimeHostRef,
): OAuthLoginService | null {
  switch (providerType) {
    case 'openai-codex':
      return {
        bridge: runtimeHostOAuthLoginBridge(window.maka.openAiCodex, host),
        display: { name: 'OpenAI Codex', shortName: 'Codex' },
        showsDeviceCode: true,
      };
    case 'xai-oauth':
      return {
        bridge: runtimeHostOAuthLoginBridge(window.maka.xaiOAuth, host),
        display: { name: 'xAI Grok', shortName: 'SuperGrok / X Premium' },
        showsDeviceCode: false,
      };
    default:
      return null;
  }
}
