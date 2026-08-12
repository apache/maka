/**
 * Behavioral coverage for createKeyedActionGuard — the framework-free
 * multi-latch sibling of useOAuthLoginFlow's one-shot action guard, consumed
 * through useKeyedActionGuard by Settings components that hold several
 * independent action latches at once (the connection detail sheet's mutually
 * excluding actions and the memory controller's per-row action keys).
 *
 * The hook itself needs a DOM + React to render; the guard is pulled out
 * precisely so the safety behaviors the pages rely on — synchronous
 * re-entrancy rejection, per-key independence, exclusive acquisition, and
 * owner-checked release across reset() — are testable directly, without a
 * renderer.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { createKeyedActionGuard } from '../../renderer/settings/action-guard.js';

describe('keyed action guard', () => {
  it('admits the first action per key and rejects a concurrent same-key action', () => {
    const guard = createKeyedActionGuard<string>();
    assert.equal(guard.has('save'), false);
    const release = guard.begin('save');
    assert.ok(release, 'first save must be admitted');
    assert.equal(guard.has('save'), true);
    // A double-click must be rejected synchronously, before React re-renders
    // the disabled button.
    assert.equal(guard.begin('save'), null, 'a second save must be rejected while one is pending');
    assert.equal(guard.size, 1);
  });

  it('lets different keys run in parallel and releases them independently', () => {
    const guard = createKeyedActionGuard<string>();
    const releaseSave = guard.begin('save');
    const releaseTest = guard.begin('test');
    assert.ok(releaseSave && releaseTest, 'independent keys must both be admitted');
    assert.equal(guard.size, 2);

    releaseSave!();
    assert.equal(guard.has('save'), false, 'releasing save must free its key');
    assert.equal(guard.has('test'), true, 'releasing save must not free test');
    assert.ok(guard.begin('save'), 'save must be admitted again after release');

    releaseTest!();
    assert.equal(guard.size, 1);
  });

  it('beginExclusive admits only while nothing is in flight', () => {
    const guard = createKeyedActionGuard<string>();
    const releaseFetch = guard.begin('fetch-models');
    assert.ok(releaseFetch);
    assert.equal(guard.beginExclusive('save'), null, 'exclusive save must be rejected while a fetch is pending');

    releaseFetch!();
    const releaseSave = guard.beginExclusive('save');
    assert.ok(releaseSave, 'exclusive save must be admitted once the sheet is idle');
    assert.equal(guard.beginExclusive('test'), null, 'a second exclusive begin must be rejected while the hold stands');
    // Plain per-key begin stays independent: an exclusive hold does not
    // block other keys (the post-save silent model refresh overlaps save
    // exactly this way), just like the hand-rolled independent refs did.
    const releaseTest = guard.begin('test');
    assert.ok(releaseTest, 'per-key begin must stay independent of an exclusive hold');
    releaseTest!();

    releaseSave!();
    assert.ok(guard.beginExclusive('test'), 'exclusive begin must be admitted again after the exclusive release');
  });

  it('keeps a stale release from stripping a newer hold after reset', () => {
    const guard = createKeyedActionGuard<string>();
    const staleRelease = guard.begin('save');
    assert.ok(staleRelease);

    // Teardown (unmount / StrictMode remount simulation) drops every hold;
    // the same key can be acquired again right after.
    guard.reset();
    assert.equal(guard.size, 0);
    const nextRelease = guard.begin('save');
    assert.ok(nextRelease, 'save must be re-acquirable after reset');

    staleRelease!();
    assert.equal(guard.has('save'), true, 'the stale release must not strip the newer hold');

    nextRelease!();
    assert.equal(guard.has('save'), false, 'the owning release still frees the key');
  });

  it('reset drops every in-flight hold', () => {
    const guard = createKeyedActionGuard<string>();
    assert.ok(guard.begin('save'));
    assert.ok(guard.begin('test'));
    assert.equal(guard.size, 2);
    guard.reset();
    assert.equal(guard.size, 0);
    assert.equal(guard.has('save'), false);
    assert.equal(guard.has('test'), false);
  });
});
