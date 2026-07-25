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
import { describe, it } from 'node:test';
import { readRendererShellSources } from './renderer-shell-source-helpers.js';
import { readSettingsCombinedSource } from './settings-contract-source-helpers.js';
import {
  readMainProcessCombinedSource,
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

  it('main.ts routes every session-creation fallback through the extracted resolver (single authority)', async () => {
    // The resolver lives in ./permission-mode-default.ts as an injected pure
    // function so its never-rejects fallback is unit-testable in isolation
    // (see permission-mode-default.test.ts). main.ts must import it and route
    // EVERY permission-mode fallback through it by injecting settingsStore.get
    // — no inline definition and no unguarded inline settings read may remain.
    // Read main.ts only (not the combined source): the resolver now lives in
    // ./permission-mode-default.ts, which is part of the combined list, and
    // its `export async function resolveDefaultPermissionMode` would falsely
    // trip the no-inline assertion below.
    const src = await readMainTsSource();

    assert.match(
      src,
      /import \{ resolveDefaultPermissionMode \} from '\.\/permission-mode-default\.js';/,
      'main.ts must import the extracted resolver',
    );
    assert.doesNotMatch(
      src,
      /async function resolveDefaultPermissionMode/,
      'the resolver must live in ./permission-mode-default.ts, not inline in main.ts (so its never-rejects fallback is unit-testable)',
    );

    // sessions:create must inject settingsStore.get into the resolver, proving
    // it routes through the single authority instead of reading settings
    // inline. Count across the combined main-process source so the file split
    // does not weaken the invariant. #1433 merged the third caller
    // (quickChat:start) into sessions:create and then hoisted the resolution
    // above the fake/ai-sdk branch, so ONE call site is now the full set — a
    // new session-creation path that reads settings its own way, or a branch
    // that re-resolves the default on its own, would push this back over.
    const combined = await readMainProcessCombinedSource();
    const routedCalls = combined.match(/resolveDefaultPermissionMode\(\(\) => settingsStore\.get\(\)\)/g) ?? [];
    assert.equal(
      routedCalls.length,
      1, // the single hoisted resolution both sessions:create branches share
      `all session-creation fallbacks must route through resolveDefaultPermissionMode(() => settingsStore.get()) (found ${routedCalls.length}, expected exactly one)`,
    );
    assert.doesNotMatch(
      src,
      /\?\? \(await settingsStore\.get\(\)\)\.chatDefaults\.permissionMode/,
      'no unguarded inline settings read may remain as a permission-mode fallback',
    );
  });

  /**
   * #1433: Deep Research is a read-only boundary, so it must win over both
   * the renderer's request and the configured default.
   */
  it('a mode-forced boundary outranks the configured default', async () => {
    const src = await readSessionsIpcSource();
    assert.match(
      src,
      /const permissionMode =\s*modeSeed\?\.permissionMode \?\?\s*input\?\.permissionMode \?\?\s*\(await resolveDefaultPermissionMode/,
      'the mode seed must be consulted before the renderer request and before the configured default',
    );
  });

  /**
   * #1433: `explore` is a boundary a mode confers, never one a caller may
   * open a session at — core already names the pickable set
   * `ChatDefaultPermissionMode`. Without this refusal the seed is only a
   * default: a renderer could ask for `explore` outright and get it without
   * the Deep Research label, tools or system prompt that define the mode.
   * `sessions:setPermissionMode` stays the separate, deliberate path for
   * moving an EXISTING session (the quote companion relies on it), so the
   * guard belongs on creation only.
   */
  it('sessions:create refuses a directly-requested explore boundary', async () => {
    const src = await readSessionsIpcSource();
    assert.match(
      src,
      /if \(input\?\.permissionMode !== undefined && !isChatDefaultPermissionMode\(input\.permissionMode\)\) \{\s*throw new TypeError/,
      'a directly-requested permission mode must be validated against the pickable set, so explore can only arrive via the mode seed',
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
