import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bubble, Marker, markerVariants, Message, previewVariants, toolVariants } from '../primitives/chat.js';
import { cn } from '../ui.js';

const chatTurnSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'chat-turn.tsx'),
  'utf8',
);

// The re-anchored renderer selectors key off the primitives' own `data-slot` /
// `data-role` / `data-variant`, so a consumer must never be able to clobber
// them. Both primitives are hook-free pure functions, so calling them directly
// and inspecting the returned element's props proves the structural hooks win
// over conflicting props — no DOM, no renderer needed.
test('Message keeps its own data-slot/data-role over conflicting props', () => {
  const el = Message({
    variant: 'assistant',
    'data-slot': 'spoofed',
    'data-role': 'user',
  } as never);
  const props = el.props as Record<string, unknown>;
  assert.equal(props['data-slot'], 'message');
  assert.equal(props['data-role'], 'assistant');
});

test('Bubble keeps its own data-slot/data-variant over conflicting props', () => {
  const el = Bubble({
    variant: 'user',
    'data-slot': 'spoofed',
    'data-variant': 'assistant',
  } as never);
  const props = el.props as Record<string, unknown>;
  assert.equal(props['data-slot'], 'bubble');
  assert.equal(props['data-variant'], 'user');
});

test('Marker keeps its own data-slot/data-variant but forwards the styling data-* hooks', () => {
  const el = Marker({
    variant: 'footer-action',
    as: 'span',
    'data-slot': 'spoofed',
    'data-variant': 'aborted',
    // The literalized `data-[kind=…]:` variants read this off the element, so it
    // must flow through unchanged.
    'data-kind': 'model',
  } as never);
  const props = el.props as Record<string, unknown>;
  assert.equal(el.type, 'span');
  assert.equal(props['data-slot'], 'marker');
  assert.equal(props['data-variant'], 'footer-action');
  assert.equal(props['data-kind'], 'model');
});

test('markerVariants leaves shared Button geometry and interaction states to the primitive', () => {
  // The lineage badge + footer action render as UiButton and apply the shell via
  // className, so the cva must return a non-empty literal utility string.
  const footerAction = markerVariants({ variant: 'footer-action' });
  assert.match(footerAction, /data-\[copy-feedback=copied\]:text-\[color:var\(--link\)\]/);
  assert.ok(!/\b(?:h-|min-h-|px-|py-|text-xs|hover:bg-|focus-visible:)/.test(footerAction));
  const lineageBadge = markerVariants({ variant: 'lineage-badge' });
  assert.match(lineageBadge, /rounded-\[var\(--radius-pill\)\]/);
  assert.match(lineageBadge, /data-\[direction=forward\]:/);
  assert.ok(!/\b(?:h-|min-h-|px-|py-|text-xs|hover:bg-|focus-visible:)/.test(lineageBadge));
});

// Footer actions and lineage badges are ordinary Astryx actions. Check the
// production wiring rather than synthesizing a merge that a call site could
// forget to use.
test('chat footer actions and lineage badges consume the governed Button tiers', () => {
  assert.doesNotMatch(
    chatTurnSource,
    /<BaseButton\b[^>]*markerVariants\(\{ variant: '(?:footer-action|lineage-badge)' \}\)/,
  );
  assert.match(
    chatTurnSource,
    /<UiIconButton[\s\S]*?variant="ghost"[\s\S]*?size="sm"[\s\S]*?className=\{markerVariants\(\{ variant: 'footer-action' \}\)\}/,
  );
  assert.match(
    chatTurnSource,
    /<UiButton\b[^>]*\n\s*key=[^]*?variant="ghost"\n\s*size="sm"\n\s*className=\{markerVariants\(\{ variant: 'lineage-badge' \}\)\}/,
  );
});

// PR3b — the tool-activity card shell. The full per-part shell is proven by the
// computed-style diff harness (20 rows, 0 delta), so this does NOT enumerate the
// leaf literals. It keeps two guards the diff can't make at the source level:
// the shell stays LITERAL (no semantic scale a refactor could swap in), and —
// the subtle one — cva's RUNTIME output must preserve the `waiting_permission`
// `\_` escape as a SINGLE backslash. Tailwind turns a bare `_` in an arbitrary
// value into a space; the `String.raw` source keeps source==runtime at one `\_`,
// and any build/refactor that re-doubles or drops it silently breaks the
// `waiting_permission` border/dot tint (invisible until rendered — the diff
// harness caught exactly this).
// PR4 — the web-search error card layers `web-search-error` over `web-search`
// via `cn`. Unlike the pure-container previews (source string == computed style
// for free), this one only holds if both the base border/bg AND the error
// override use the SAME utility property form so tailwind-merge COLLAPSES them —
// then the error, last in `cn`, wins deterministically. A bare
// `[border-color: …]`/`[background: …]` longhand would survive un-collapsed and
// then lose to the base `[border: …]` shorthand by Tailwind's emission order,
// silently dropping the destructive tint (invisible until rendered — the exact
// regression this pins). No browser, no emission-order dependency: the merged
// string itself is the proof.
test('web-search-error tint collapses the neutral base border/bg so the destructive pixels win', () => {
  const merged = cn(
    previewVariants({ part: 'web-search' }),
    previewVariants({ part: 'web-search-error' }),
  );
  // the neutral base border + background must be merged OUT…
  assert.ok(
    !merged.includes('[border:1px_solid_var(--foreground-10)]'),
    'neutral base border must be collapsed by the error tint',
  );
  assert.ok(
    !merged.split(/\s+/).includes('bg-[var(--foreground-3)]'),
    'neutral base background must be collapsed by the error tint',
  );
  // …and only the destructive tints survive (kept as the collapse-safe
  // `[border: …]` shorthand + `bg-[ …]` util, never a bare longhand).
  assert.match(merged, /\[border:1px_solid_color-mix\(in_oklab,var\(--destructive-text\)_32%/);
  assert.match(merged, /bg-\[color-mix\(in_oklab,var\(--destructive-text\)_8%/);
  assert.ok(
    !merged.includes('[border-color:color-mix') && !merged.includes('[background:color-mix'),
    'the error tint must use the collapse-safe shorthand/util forms, never a bare longhand',
  );
});

test('toolVariants stays literal and emits the single-backslash waiting_permission escape', () => {
  const item = toolVariants({ part: 'item' });
  const dot = toolVariants({ part: 'dot' });
  for (const cls of [item, dot]) {
    assert.ok(
      // Typography (text-*) converged onto the scale by #546 PR0, so text-xs/sm
      // are allowed here; only radius scale + recolor drift stays banned.
      !cls.split(/\s+/).some((u) => ['rounded-lg', 'rounded-md', 'rounded-xl', 'bg-primary'].includes(u)),
      'tool shell must stay literal on radius, not the semantic scale / a recolor',
    );
  }
  // exactly one backslash before the underscore (source == runtime via String.raw)
  assert.ok(item.includes('data-[status=waiting\\_permission]:[border-color:'), 'item must keep the single-backslash waiting_permission border escape');
  assert.ok(dot.includes('data-[status=waiting\\_permission]:bg-[var(--info)]'), 'dot must keep the single-backslash waiting_permission bg escape');
  // never the bare underscore form (Tailwind would read it as a space)
  assert.ok(!item.includes('data-[status=waiting_permission]') && !dot.includes('data-[status=waiting_permission]'), 'the bare waiting_permission form must never reach the className');
  // the running dot keeps the governed ring keyframe, never Tailwind animate-pulse
  assert.match(dot, /\[animation:maka-tool-pulse_1\.5s_ease-in-out_infinite\]/);
  assert.ok(!dot.split(/\s+/).includes('animate-pulse'), 'running dot must use the governed maka-tool-pulse ring');
});
