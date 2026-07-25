/**
 * Home / empty-state composer model picker.
 *
 * Regression guard for the bug where the model chip below the home composer
 * showed a chevron (and a "选择模型" label) but was a dead `<span>` — clicking
 * it did nothing because the interactive `ChatModelSwitcher` is bound to a live
 * session and the no-session branch fell back to a static chip. The fix routes
 * the no-session branch to an interactive `NewChatModelPicker` whose pick is
 * forwarded to `sessions.create`, so the next new chat starts on the chosen
 * model. This locks:
 *   - the no-session branch renders the interactive picker (not a dead chip);
 *   - the picker does NOT hand-add a second chevron (SelectTrigger owns it);
 *   - both pickers share one `ModelChoiceOptions` list (no duplicated JSX);
 *   - main.tsx wires the pick and forwards it to sessions.create.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { join } from 'node:path';
import {
  readRendererShellCombinedSource,
  readRendererShellSources,
} from './renderer-shell-source-helpers.js';

const repoRoot = process.cwd().endsWith('apps/desktop')
  ? join(process.cwd(), '..', '..')
  : process.cwd();

async function readRepo(path: string): Promise<string> {
  return readFile(join(repoRoot, path), 'utf8');
}

describe('home composer new-chat model picker', () => {
  it('renders an interactive picker (not a dead chip) on the no-session branch', async () => {
    // The pickers live in `chat-model-switcher.tsx`; the composer renders
    // them from `composer.tsx`. Search the union so the contract holds across
    // the seam.
    const ui =
      (await readRepo('packages/ui/src/composer.tsx')) +
      '\n' +
      (await readRepo('packages/ui/src/chat-model-switcher.tsx'));

    // The no-session branch must route to the interactive picker when a pick
    // handler and choices exist, keeping the static chip only as the
    // no-choices fallback.
    assert.match(
      ui,
      /\) : props\.onPickNewChatModel && \(props\.modelChoices\?\.length \?\? 0\) > 0 \? \(\s*<NewChatModelPicker/,
      'composer no-session branch must render <NewChatModelPicker> when a pick handler + choices are present',
    );

    const picker = ui.match(/function NewChatModelPicker\(props: \{[\s\S]*?\}\) \{[\s\S]*?\n\}/)?.[0] ?? '';
    assert.notEqual(picker, '', 'NewChatModelPicker component must exist');
    // Interactive: built on the shared ModelPicker combobox, fires the pick
    // on value change.
    assert.match(picker, /<ModelPicker/, 'NewChatModelPicker must be a real ModelPicker dropdown');
    assert.match(picker, /props\.onPick\(next\)/, 'NewChatModelPicker must call onPick with the chosen model');
    // No hand-added chevron or status dot — ModelPicker's trigger renders the
    // dropdown affordance, and the active-session picker has no red dot. Keep
    // the new-chat trigger visually aligned with it.
    assert.doesNotMatch(
      picker,
      /<ChevronDown/,
      'NewChatModelPicker must not hand-add a chevron (ModelPicker\'s trigger already renders one) — guards the double-chevron regression',
    );
    assert.doesNotMatch(
      picker,
      /maka-composer-model-status/,
      'NewChatModelPicker must not render the red status dot; the active-session model picker has no equivalent marker',
    );
  });

  it('shares one ModelPicker popup between both model pickers', async () => {
    // The pickers live in `chat-model-switcher.tsx`; the shared searchable
    // popup lives in `model-picker.tsx`. Both ChatModelSwitcher and
    // NewChatModelPicker must render it (no duplicated grouped-list JSX).
    const ui = await readRepo('packages/ui/src/chat-model-switcher.tsx');
    const picker = await readRepo('packages/ui/src/model-picker.tsx');
    assert.match(picker, /export function ModelPicker\(/, 'shared ModelPicker component must exist');
    const usages = ui.match(/<ModelPicker/g) ?? [];
    assert.equal(
      usages.length,
      2,
      'both ChatModelSwitcher and NewChatModelPicker must render the shared <ModelPicker> (no duplicated grouped list)',
    );
  });

  it('wires the pick and forwards the chosen model to sessions.create', async () => {
    const renderer = await readRendererShellSources([
      'app-shell.tsx',
      'app-shell-chat-actions.ts',
      'use-shell-chat-model.ts',
    ]);

    assert.match(
      renderer,
      /const \[pendingNewChatModel, setPendingNewChatModel\] = useState</,
      'main.tsx must hold the picked new-chat model in state',
    );
    assert.match(
      renderer,
      /onPickNewChatModel=\{\(input\) => \{[\s\S]*setPendingNewChatModel\(input\);[\s\S]*saveComposerDefaults\(\{ model: input \}\);[\s\S]*\}\}/,
      'main.tsx must wire the composer pick to state and persisted composer defaults',
    );
    // A pick only stays in effect while it is still an offered choice; once the
    // connection/model is removed the picker must fall back to the default so it
    // never shows — nor sends — a model sessions.create would reject.
    assert.match(
      renderer,
      /const validPendingNewChatModel\s*=[\s\S]*?chatModelChoices\.some\(/,
      'main.tsx must drop a stale pendingNewChatModel that is no longer an offered choice',
    );
    // send() forwards only the *validated* pick to sessions.create; absence
    // keeps the backend default behavior unchanged.
    assert.match(
      renderer,
      /\.\.\.\(validPendingNewChatModel\s*\?\s*\{\s*llmConnectionSlug: validPendingNewChatModel\.llmConnectionSlug,\s*model: validPendingNewChatModel\.model,?\s*\}/,
      'send() must forward the validated picked model to sessions.create when one was chosen',
    );
  });

  it('filters the pending new-chat thinking level against the currently picked model', async () => {
    const renderer = await readRendererShellSources([
      'app-shell.tsx',
      'app-shell-chat-actions.ts',
      'use-shell-chat-model.ts',
    ]);

    assert.match(
      renderer,
      /const newChatThinkingLevel\s*=\s*pendingNewChatThinkingLevel && newChatThinkingLevels\.includes\(pendingNewChatThinkingLevel\)\s*\? pendingNewChatThinkingLevel\s*: undefined;/,
      'AppShell must only surface a pending new-chat thinking level when the current new-chat model supports it',
    );
    assert.match(
      renderer,
      /pendingNewChatThinkingLevel:\s*newChatThinkingLevel \?\? null/,
      'send() dependencies must receive the filtered newChatThinkingLevel, not the raw pending state',
    );
    assert.match(
      renderer,
      /\.{3}\(pendingNewChatThinkingLevel \? \{ thinkingLevel: pendingNewChatThinkingLevel \} : \{\}\)/,
      'sessions.create still forwards the dependency field, which must already be filtered by AppShell',
    );
  });

  it('wires composer permission mode picks to the global chat default', async () => {
    const renderer = await readRendererShellCombinedSource();
    const setPermissionModeBlock = renderer.match(/async function setPermissionMode[\s\S]*?async function setSessionModel/)?.[0] ?? '';
    const sendBlock = renderer.match(/async function send\([\s\S]*?\n  async function respondToPermission/)?.[0] ?? '';

    assert.doesNotMatch(
      renderer,
      /saveComposerDefaults\(\{\s*permissionMode:/,
      'permission mode must not be persisted into composer defaults',
    );
    assert.doesNotMatch(
      renderer,
      /const \[pendingNewChatPermissionMode, setPendingNewChatPermissionMode\] = useState<PermissionMode \| null>\(null\)/,
      'composer permission picks are no longer one-shot renderer state',
    );
    assert.doesNotMatch(
      setPermissionModeBlock,
      /setPendingNewChatPermissionMode\(mode\)/,
      'composer permission picks must not be stored for only the next new chat',
    );
    assert.match(
      setPermissionModeBlock,
      /window\.maka\.settings\.update\(\{\s*chatDefaults: \{ permissionMode: mode \},?\s*\}\)/,
      'every composer permission-mode pick must persist the global chat default',
    );
    assert.doesNotMatch(
      sendBlock,
      /\.\.\.\(pendingNewChatPermissionMode \? \{ permissionMode: pendingNewChatPermissionMode \} : \{\}\)/,
      'new-chat sessions.create must never shadow the persisted global default with one-shot renderer state',
    );
  });

  it('does not let stale new-chat send creation steal the active session after navigation', async () => {
    const renderer = await readRendererShellSources([
      'app-shell-chat-actions.ts',
      'app-shell.tsx',
    ]);
    const sendBlock = renderer.match(/async function send\([\s\S]*?\n  async function respondToPermission/)?.[0] ?? '';

    // The three facts this predicate rests on, asserted where each one is now
    // decided rather than re-stated here. The previous version matched the
    // whole four-clause body in one regex, which pinned a SPELLING: the shell
    // had three hand-written predicates over the same question, this locked
    // one of them, and the one it did not lock lost the nav-section half —
    // which is how a failed send could navigate a user who had already left.
    // The three are one rule plus preconditions now, so the chain is what
    // there is to protect.
    assert.match(
      renderer,
      /function isShellSurfaceOwnerActive\(owner: ComposerImportOwner\): boolean \{\s*return navSelectionRef\.current\.section === owner\.navSection && activeIdRef\.current === owner\.sessionId;/,
      'the shell needs exactly one answer to "is this owner still the active surface", and it must compare BOTH the nav section and the session id',
    );
    assert.match(
      renderer,
      /function isComposerImportOwnerActive\(owner: ComposerImportOwner\): boolean \{\s*return owner\.navSection === 'sessions' && isShellSurfaceOwnerActive\(owner\);/,
      'the chat-surface predicate must add its precondition to that one answer, not restate it',
    );
    assert.match(
      renderer,
      /function isNewChatSendSurfaceActive\(owner: ComposerImportOwner\): boolean \{\s*return owner\.sessionId === undefined && isComposerImportOwnerActive\(owner\);/,
      'new-chat sends must capture the empty-chat surface before async session creation',
    );
    // Ordering, which is the thing a behavioral test cannot see: the capture
    // has to happen before the await, or it records where the user ended up
    // instead of where they started.
    assert.match(
      sendBlock,
      /const sendOwner = captureComposerImportOwner\(\);\s*const newChatOwner = initialSessionId \? null : sendOwner;[\s\S]*await window\.maka\.sessions\.create\(/,
      'send() must capture the composer owner before sessions.create()',
    );
    assert.match(sendBlock, /upsertSessionSummary\(session\);/);
    assert.match(
      sendBlock,
      /if \(newChatOwner && isNewChatSendSurfaceActive\(newChatOwner\)\) \{[\s\S]*setNavSelection\(\{ section: 'sessions', filter: 'chats' \}\);[\s\S]*setActiveId\(session\.id\);[\s\S]*showOptimisticUserMessage\([\s\S]*session\.id,[\s\S]*turnId,[\s\S]*skillInvocationDisplayText\(text, sendResult\.skillInvocation\),[\s\S]*sendResult\.attachments,[\s\S]*\{[\s\S]*replaceCurrentMessages: true,[\s\S]*\}[\s\S]*\);[\s\S]*\}/,
      'newly-created sessions may only become active if the user is still on the original empty new-chat surface',
    );
    assert.match(
      sendBlock,
      /await window\.maka\.sessions\.send\(session\.id, \{\s*type: 'send',\s*turnId,\s*text,[\s\S]*\}\);[\s\S]*if \(activeIdRef\.current === session\.id\) \{[\s\S]*await refreshMessagesUntilTurn\(session\.id, turnId\);[\s\S]*\}[\s\S]*await refreshSessions\(\);/,
      'background new-chat sends should continue and refresh the list, but must not poll messages unless the created session is active',
    );
  });
});
