import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import type { DesktopRuntimeHostRef } from '../../preload/bridge-contract.js';
import { oauthLoginServiceFor } from '../../renderer/settings/oauth-relogin-service.js';

// Pins the per-service device-code contract behind the connection detail's
// 重新登录 notice. Codex's device-authorization page has no code in its URL —
// the user must type the `stateHint` the flow surfaces, so the notice must
// render it (it silently dropped it before this pin existed). xAI's page
// needs no manual code, matching the catalog panel's `!isXai` guard.

const HOST: DesktopRuntimeHostRef = { profileId: 'default', hostId: 'host-a' };

type MakaWindow = { maka: Record<string, unknown> };
const previousWindow = (globalThis as { window?: unknown }).window;

function installBridgeStubs(): { codexCalls: string[] } {
  const codexCalls: string[] = [];
  const codexStub = new Proxy(
    {},
    {
      get:
        (_target, method: string) =>
        (...args: unknown[]) => {
          codexCalls.push(`${method}:${JSON.stringify(args)}`);
          return Promise.resolve({ ok: true });
        },
    },
  );
  (globalThis as unknown as { window: MakaWindow }).window = {
    maka: { openAiCodex: codexStub, xaiOAuth: {} },
  };
  return { codexCalls };
}

afterEach(() => {
  (globalThis as { window?: unknown }).window = previousWindow;
});

describe('oauthLoginServiceFor device-code contract', () => {
  it('marks Codex as needing the device sign-in code shown', () => {
    installBridgeStubs();
    const service = oauthLoginServiceFor('openai-codex', HOST);
    assert.ok(service, 'codex must be re-login capable');
    assert.equal(service.showsDeviceCode, true);
  });

  it('keeps xAI on the no-code browser flow', () => {
    installBridgeStubs();
    const service = oauthLoginServiceFor('xai-oauth', HOST);
    assert.ok(service, 'xai must be re-login capable');
    assert.equal(service.showsDeviceCode, false);
  });

  it('returns null for providers without a browser-assisted re-login', () => {
    installBridgeStubs();
    assert.equal(oauthLoginServiceFor('openai-compatible', HOST), null);
    assert.equal(oauthLoginServiceFor('claude-subscription', HOST), null);
  });

  it('routes the codex bridge through the host-scoped preload surface', async () => {
    const { codexCalls } = installBridgeStubs();
    const service = oauthLoginServiceFor('openai-codex', HOST);
    assert.ok(service);
    await service.bridge.getAccountState();
    assert.deepEqual(codexCalls, [`getAccountState:${JSON.stringify([HOST])}`]);
  });
});
