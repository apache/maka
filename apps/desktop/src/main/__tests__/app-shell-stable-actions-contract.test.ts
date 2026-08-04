/**
 * Contract for the app-shell action-factory stabilization (issue #1043).
 *
 * The `createAppShell*Actions` factories run in the AppShell render body, so
 * every render allocates fresh handler identities. That churn is observable:
 * the streaming-settle fallback effect lists `settleAssistantStreaming` in its
 * deps and therefore tears down/re-arms its 1s timer on every render while the
 * fallback is armed.
 *
 * `useStableActions` returns a facade created once per component instance.
 * The facade delegates each call to the latest committed render's factory
 * result, so handlers are both identity-stable and always see fresh deps.
 * These tests cover that reusable behavior without pinning AppShell source
 * shape or the current number of action factories.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { createDelegatingActions } from '../../renderer/stable-actions.js';

describe('createDelegatingActions', () => {
  it('keeps facade identity stable while delegating to the latest actions', () => {
    const latest = { current: { greet: (name: string) => `hello ${name}` } };
    const facade = createDelegatingActions(latest);
    const stableGreet = facade.greet;

    // A later render re-runs the factory and swaps the ref contents.
    latest.current = { greet: (name: string) => `hi ${name}` };

    assert.equal(facade.greet, stableGreet, 'facade method identity must not change');
    assert.equal(facade.greet('maka'), 'hi maka', 'calls must reach the latest closure');
  });

  it('fixes the key set at creation even if a later result changes shape', () => {
    const latest = { current: { a: () => 'a', b: () => 'b' } as Record<string, () => string> };
    const facade = createDelegatingActions(latest);
    latest.current = { a: () => 'A2', c: () => 'c' };
    assert.deepEqual(Object.keys(facade), ['a', 'b'], 'facade keys are fixed at creation');
    assert.equal(facade.a(), 'A2', 'surviving keys still delegate to the latest result');
  });
});
