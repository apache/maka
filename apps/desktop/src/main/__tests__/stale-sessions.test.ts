/**
 * Tests for the stale-session classifier (sidebar pill, PR108g).
 *
 * The renderer derives `staleSessionIds: Set<string>` from `sessions` x
 * `connections` and passes it to SessionListPanel; rows with matching ids
 * get a dim treatment + "已过期" pill. We lock the classifier down here
 * so future edits don't drift on what counts as stale.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { deriveStaleSessionIds } from '../../renderer/stale-sessions.js';

function session(partial: { id: string; backend?: string; slug?: string }): {
  id: string;
  backend: string;
  llmConnectionSlug: string;
} {
  return {
    id: partial.id,
    backend: partial.backend ?? 'ai-sdk',
    llmConnectionSlug: partial.slug ?? 'zai-coding-plan',
  };
}

describe('deriveStaleSessionIds', () => {
  it('returns empty set when no sessions', () => {
    const result = deriveStaleSessionIds({
      sessions: [],
      knownConnectionSlugs: new Set(['zai-coding-plan']),
    });
    assert.equal(result.size, 0);
  });

  it('flags sessions with backend="fake"', () => {
    const result = deriveStaleSessionIds({
      sessions: [
        session({ id: 'a', backend: 'fake', slug: 'fake' }),
        session({ id: 'b', backend: 'ai-sdk', slug: 'zai-coding-plan' }),
      ],
      knownConnectionSlugs: new Set(['zai-coding-plan']),
    });
    assert.deepEqual([...result], ['a']);
  });

  it('flags sessions whose slug is not in the known connections set', () => {
    const result = deriveStaleSessionIds({
      sessions: [
        session({ id: 'a', backend: 'ai-sdk', slug: 'fake-claude' }),
        session({ id: 'b', backend: 'ai-sdk', slug: 'zai-coding-plan' }),
      ],
      knownConnectionSlugs: new Set(['zai-coding-plan']),
    });
    assert.deepEqual([...result], ['a']);
  });

  it('flags legacy backend kinds (e.g. "claude") if connection also missing', () => {
    const result = deriveStaleSessionIds({
      sessions: [session({ id: 'a', backend: 'claude', slug: 'fake-claude' })],
      knownConnectionSlugs: new Set(['zai-coding-plan']),
    });
    assert.deepEqual([...result], ['a']);
  });

  it('does NOT flag a session whose backend is unknown but slug resolves', () => {
    // We don't penalize "future backend kind we don't know about" if the
    // user's connection still exists. The chat-header banner + send-path
    // guard handle the real readiness check.
    const result = deriveStaleSessionIds({
      sessions: [session({ id: 'a', backend: 'future-backend', slug: 'zai-coding-plan' })],
      knownConnectionSlugs: new Set(['zai-coding-plan']),
    });
    assert.equal(result.size, 0);
  });

  it('reproduces the @WAWQAQ workspace scenario', () => {
    // The on-disk state that triggered the P0 — defaultSlug + apiKey are
    // correct in `llm-connections.json`, but two legacy sessions in
    // sessions/ still reference dead backends:
    //
    //   3b76ea22  backend=claude       slug=fake-claude     ← stale
    //   7280e103  backend=ai-sdk       slug=zai-coding-plan ← OK
    //   fff5cb61  backend=fake         slug=fake            ← stale
    //
    // Without this classifier the user has to click into each session and
    // see the chat-header banner to know which ones are broken.
    const result = deriveStaleSessionIds({
      sessions: [
        session({ id: '3b76ea22', backend: 'claude', slug: 'fake-claude' }),
        session({ id: '7280e103', backend: 'ai-sdk', slug: 'zai-coding-plan' }),
        session({ id: 'fff5cb61', backend: 'fake', slug: 'fake' }),
      ],
      knownConnectionSlugs: new Set(['zai-coding-plan']),
    });
    assert.deepEqual([...result].sort(), ['3b76ea22', 'fff5cb61']);
  });

  it('flags everything when the connection store is empty', () => {
    const result = deriveStaleSessionIds({
      sessions: [
        session({ id: 'a', backend: 'ai-sdk', slug: 'zai-coding-plan' }),
        session({ id: 'b', backend: 'ai-sdk', slug: 'anthropic' }),
      ],
      knownConnectionSlugs: new Set(),
    });
    assert.deepEqual([...result].sort(), ['a', 'b']);
  });
});

describe('stale session list wiring', () => {
  // Pill visibility on active rows is a product invariant; assert it through
  // the panel render, not by grepping Astryx SideNav CSS selectors.

  it('staleSessionIds wires data-stale and pill only on marked sessions', async () => {
    const { makeSessionSummary, renderSessionListPanel } = await import(
      './session-list-render-helpers.js'
    );
    const stale = makeSessionSummary({ id: 'stale-session', name: 'Stale' });
    const healthy = makeSessionSummary({ id: 'healthy-session', name: 'Healthy' });
    const html = renderSessionListPanel({
      sessions: [stale, healthy],
      activeId: healthy.id,
      staleSessionIds: new Set(['stale-session']),
    });

    const staleChunk = html.match(
      /data-session-id="stale-session"[\s\S]*?(?=data-session-id="healthy-session"|$)/,
    )?.[0];
    const healthyChunk = html.match(
      /data-session-id="healthy-session"[\s\S]*?(?=data-session-id=|$)/,
    )?.[0];
    assert.ok(staleChunk, 'expected stale session row markup');
    assert.ok(healthyChunk, 'expected healthy session row markup');
    assert.match(staleChunk, /data-stale="true"/, 'stale session must set data-stale');
    assert.match(
      staleChunk,
      /maka-list-row-stale-pill/,
      'stale session must render the stale pill',
    );
    assert.doesNotMatch(
      healthyChunk,
      /data-stale="true"/,
      'healthy session must not inherit data-stale',
    );
    assert.doesNotMatch(
      healthyChunk,
      /maka-list-row-stale-pill/,
      'healthy session must not render a stale pill',
    );
  });
});
