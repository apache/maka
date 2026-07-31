import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { readRenderedSessionHistorySource } from './session-history-owner-source-helpers.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');
const CHAT_MODEL_SWITCHER_PATH = resolve(REPO_ROOT, 'packages', 'ui', 'src', 'chat-model-switcher.tsx');
const MODEL_PICKER_PATH = resolve(REPO_ROOT, 'packages', 'ui', 'src', 'model-picker.tsx');
const SESSION_SETTINGS_ACTIONS_PATH = resolve(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer', 'app-shell-session-settings-actions.ts');
const SESSION_ROW_ACTIONS_PATH = resolve(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer', 'app-shell-session-row-actions.ts');

describe('renderer async action boundary contract', () => {
  it('keeps chat model switching on a rejection-safe local async boundary', async () => {
    const [source, modelPicker, settingsActions] = await Promise.all([
      readFile(CHAT_MODEL_SWITCHER_PATH, 'utf8'),
      readFile(MODEL_PICKER_PATH, 'utf8'),
      readFile(SESSION_SETTINGS_ACTIONS_PATH, 'utf8'),
    ]);

    assert.doesNotMatch(source, /runAsyncActionBoundary|async-action-boundary/, 'ChatModelSwitcher must not depend on a shared swallow-errors helper');
    assert.match(
      source,
      /onValueChange=\{async \(value\) => \{[\s\S]*try \{[\s\S]*await props\.onChange\?\.\(next\);[\s\S]*\} catch \{[\s\S]*\}[\s\S]*\}\}/,
      'model switching must contain delegated action rejection at the product boundary',
    );
    assert.match(modelPicker, /changeAction=\{props\.onValueChange\}/);
    assert.doesNotMatch(
      modelPicker,
      /selectionGuard|selectionPending|createModelSelectionGuard/,
      'the generic ModelPicker must not duplicate product action ownership',
    );
    assert.match(
      settingsActions,
      /async function setSessionModel[\s\S]*catch \(error\) \{[\s\S]*toastApi\.error\(copy\.modelFailedTitle, localizedShellErrorMessage\(error, copy\.modelFallback, uiLocale\)\)/,
      'model switch errors must have visible feedback in the AppShell action owner',
    );
    assert.match(
      settingsActions,
      /async function setSessionThinkingLevel[\s\S]*pendingSessionModelChangesRef\.current\.has\(sessionId\)[\s\S]*window\.maka\.sessions\.setThinkingLevel/,
      'model and thinking mutations must share the session-keyed action owner',
    );
    assert.doesNotMatch(
      source,
      /\.then\(\(\) => props\.onChange\?\.\(next\)\)\s*\.finally\(/,
      'model switching must not chain the action promise directly into finally without a rejection boundary',
    );
  });

  it('keeps session row actions on a rejection-safe local async boundary', async () => {
    const [source, rowActions] = await Promise.all([
      readRenderedSessionHistorySource(),
      readFile(SESSION_ROW_ACTIONS_PATH, 'utf8'),
    ]);

    assert.doesNotMatch(source, /runAsyncActionBoundary|async-action-boundary/, 'SessionRow actions must not depend on a shared swallow-errors helper');
    assert.match(
      source,
      /void \(async \(\) => \{[\s\S]*try \{[\s\S]*await action\(\);[\s\S]*\} catch \{[\s\S]*\} finally \{[\s\S]*pendingActionRef\.current = null;[\s\S]*setPendingAction\(null\);[\s\S]*\}[\s\S]*\}\)\(\);/,
      'session row actions must catch delegated action rejection locally and always release local pending chrome',
    );
    assert.match(
      rowActions,
      /async function runSessionRowAction[\s\S]*catch \(error\) \{[\s\S]*toastApi\.error\(errorTitle, localizedShellErrorMessage\(error, copy\.actionFallback, uiLocale\)\)/,
      'session row action errors must have visible feedback in the AppShell action owner',
    );
    assert.doesNotMatch(
      source,
      /Promise\.resolve\(\)\.then\(action\)\.finally\(/,
      'session row actions must not chain action promises directly into finally without a rejection boundary',
    );
  });
});
