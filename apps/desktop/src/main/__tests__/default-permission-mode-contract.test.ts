/**
 * Regression contract for Settings → 通用 → 默认权限模式 (chatDefaults.
 * permissionMode).
 *
 * Two bug classes this guards:
 *
 * 1. Renderer-side shadow authority. An early draft had the renderer
 *    resolve the default locally or store a one-shot composer pick and send
 *    an explicit `permissionMode` to sessions:create -- which made main.ts's
 *    settings-backed fallback unreachable. The contract now is: composer
 *    permission picks update the persisted chat default, and the renderer
 *    always omits permissionMode when creating a session.
 *
 * 2. Settings-store coupling. The pre-feature fallback was a synchronous
 *    `'ask'` literal that could never fail. Reading the configured
 *    default from settingsStore must not change that guarantee: a
 *    corrupted settings.json (get() rethrows anything but ENOENT) must
 *    fall back to 'ask', not reject session creation.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { readRendererShellSources } from './renderer-shell-source-helpers.js';
import { readSettingsCombinedSource } from './settings-contract-source-helpers.js';
import {
  REPO_ROOT,
  mainProcessSourceFiles,
  readMainTsSource,
  readSessionsIpcSource,
} from './main-process-contract-source-helpers.js';

describe('default permission mode contract', () => {
  it('renderer always omits permissionMode when creating sessions', async () => {
    const src = await readRendererShellSources(['app-shell-chat-actions.ts']);

    assert.doesNotMatch(
      src,
      /\.\.\.\(pendingNewChatPermissionMode \? \{ permissionMode: pendingNewChatPermissionMode \} : \{\}\)/,
      'send() must not shadow the persisted global default with renderer-only permission state',
    );
    assert.doesNotMatch(
      src,
      /permissionMode: pendingNewChatPermissionMode \?\?/,
      'send() must not fall back to any renderer-side default -- a renderer copy of the setting can be stale (cold-start race) and would shadow the main-process authority',
    );
  });

  /**
   * What the resolution DOES is covered behaviorally in
   * create-session-input.test.ts — the mode's boundary outranking both the
   * request and the configured default, the refusal of a directly-requested
   * `explore`, the never-rejects settings fallback. The only thing left for a
   * source contract is the one thing behavior cannot show: that no SECOND
   * place resolves a permission-mode default.
   */
  it('exactly one place in the main process resolves a permission-mode default', async () => {
    // Read EVERY main-process module, not the curated combined source. This
    // assertion is now the only guard on the single-authority invariant — the
    // two regexes that used to sit beside it became behavioral tests in
    // create-session-input.test.ts — and the curated list covered 47 of ~100
    // files, so a second resolver in an unlisted module would leave it green.
    // A count over a hand-maintained subset is a count of the subset.
    //
    // RECURSIVE, and that word is load-bearing: the first version of this fix
    // read the top level only, which is 100 of the 133 production modules.
    // `browser/`, `oauth/`, `search/`, `e2e-fixture/` and three more sit below
    // it and do write `permissionMode`, so a second resolver there was exactly
    // the unlisted module the rewrite was supposed to stop being possible.
    const modules = (await mainProcessSourceFiles()).map((path) => relative(REPO_ROOT, path));
    const sources = await Promise.all(
      modules.map(async (name) => ({ name, source: await readFile(join(REPO_ROOT, name), 'utf8') })),
    );

    // Call sites only — the definition in permission-mode-default.ts is
    // `export async function resolveDefaultPermissionMode(`, excluded by the
    // absence of a preceding `function `.
    const callSites = sources.flatMap(({ name, source }) =>
      (source.match(/(?<!function )resolveDefaultPermissionMode\(/g) ?? []).map(() => name),
    );
    assert.deepEqual(
      callSites,
      ['apps/desktop/src/main/create-session-input.ts'], // applied by sessions:create
      `every permission-mode fallback must route through the one resolver call in create-session-input.ts (found: ${callSites.join(', ') || 'none'})`,
    );

    const inlineReads = sources
      .filter(({ source }) => /\?\? \(await settingsStore\.get\(\)\)\.chatDefaults\.permissionMode/.test(source))
      .map(({ name }) => name);
    assert.deepEqual(
      inlineReads,
      [],
      `no unguarded inline settings read may remain as a permission-mode fallback (found in: ${inlineReads.join(', ')})`,
    );
    assert.doesNotMatch(
      await readMainTsSource(),
      /async function resolveDefaultPermissionMode/,
      'the resolver must live in ./permission-mode-default.ts, not inline in main.ts (so its never-rejects fallback is unit-testable)',
    );
  });

  /**
   * #1433: the derivation is what `quickChat:start` existed for. It has to
   * stay a pure function the handler applies, not drift back into the
   * `ipcMain.handle` closure where no test can call it — which is how the
   * invariants above ended up asserted by regex in the first place.
   */
  it('sessions:create applies the resolution rather than re-deriving it inline', async () => {
    const src = await readSessionsIpcSource();
    assert.match(
      src,
      /await resolveCreateSessionInput\(input, \{ readSettings: \(\) => settingsStore\.get\(\) \}\)/,
      'sessions:create must apply the extracted resolution, injecting the settings read',
    );
    assert.doesNotMatch(
      src,
      /isChatDefaultPermissionMode|DEEP_RESEARCH_SESSION_LABEL/,
      'the handler must not re-derive a permission boundary or a mode label of its own',
    );
  });

  it('app-shell keeps a display-only mirror, loaded on mount and re-synced when Settings closes', async () => {
    const src = await readRendererShellSources(['app-shell.tsx', 'use-shell-appearance.ts']);

    assert.match(
      src,
      /const \[defaultPermissionMode, setDefaultPermissionMode\] = useState<ChatDefaultPermissionMode>\('ask'\);/,
      'app-shell.tsx must track the configured default for composer-chip display (typed as ChatDefaultPermissionMode — the configured default can never be explore)',
    );
    assert.match(
      src,
      /setDefaultPermissionMode\(next\.chatDefaults\?\.permissionMode \?\? 'ask'\)/,
      'refreshShellSettings (mount-time load) must read chatDefaults.permissionMode from the settings snapshot',
    );

    // settings-surface.tsx keeps independent AppSettings state and never
    // notifies app-shell.tsx live; without a close-time re-read, a change
    // made in Settings would show a stale composer chip until app restart.
    const closeSettingsMatch = src.match(/function closeSettings\(\) \{([\s\S]*?)\n {2}\}/);
    assert.ok(closeSettingsMatch, 'closeSettings() must exist');
    assert.match(
      closeSettingsMatch![1],
      /setDefaultPermissionMode\(next\.chatDefaults\?\.permissionMode \?\? 'ask'\);/,
      'closing Settings must re-read chatDefaults.permissionMode so the composer chip reflects the change',
    );
  });
});

describe('General settings page 默认权限模式 picker', () => {
  it('describes the setting itself, not the currently-selected option', async () => {
    const src = await readSettingsCombinedSource();
    const row = src.match(/<strong>\{copy\.defaultPermission\}<\/strong>([\s\S]*?)<\/div>/)?.[1] ?? '';
    assert.ok(row, '默认权限模式 row must exist');

    // Regression guard: this line used to read the SELECTED option's own
    // hint, which just duplicated what the dropdown already shows once
    // opened. It must be a fixed description of what the setting controls.
    assert.doesNotMatch(
      row,
      /PERMISSION_MODE_META\[props\.permissionMode\]\.hint/,
      '默认权限模式 row description must not echo the selected option\'s own hint text (duplicates the dropdown)',
    );
    assert.match(
      row,
      /<small>\{copy\.defaultPermissionHelp\}<\/small>/,
      '默认权限模式 row must show a fixed description of the setting itself',
    );
    assert.match(src, /defaultPermission: '默认权限模式'/);
    assert.match(src, /defaultPermission: 'Default permission mode'/);
  });

  it('renders the shared PermissionModeSelect so options and hints cannot drift from the composer picker', async () => {
    const src = await readSettingsCombinedSource();
    assert.match(
      src,
      /<PermissionModeSelect\s+activeMode=\{props\.permissionMode\}/,
      '默认权限模式 must render the shared popup from @maka/ui (label + hint per option, same markup as the composer picker), not a bespoke copy',
    );
  });

  it('persistPermissionMode carries the same re-entrancy guard as persistDefault', async () => {
    const src = await readSettingsCombinedSource();
    const fn = src.match(/async function persistPermissionMode\([\s\S]*?\n {2}\}/)?.[0] ?? '';
    assert.ok(fn, 'persistPermissionMode must exist');
    assert.match(
      fn,
      /const releaseSave = persistGuard\.begin\('permission-mode'\);[\s\S]*if \(!releaseSave\) return;/,
      'overlapping settings.update calls have no ordering guarantee -- the shared keyed guard must reject re-entrant saves like persistDefault does',
    );
  });
});
