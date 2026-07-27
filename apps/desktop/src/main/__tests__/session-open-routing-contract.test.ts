import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { readRendererShellSource, readRendererShellSources } from './renderer-shell-source-helpers.js';
import { readMainProcessCombinedSource } from './main-process-contract-source-helpers.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');

describe('session open routing contract', () => {
  it('centralizes cross-module session opens through the chat surface', async () => {
    const main = await readRendererShellSource('app-shell.tsx');
    const helper = main.match(/function openSessionInChat\(sessionId: string, turnId\?: string\): void \{[\s\S]*?\n  \}/)?.[0] ?? '';

    assert.match(helper, /setNavSelection\(\{ section: 'sessions', filter: 'chats' \}\);/);
    assert.match(helper, /setActiveId\(sessionId\);/);
    assert.match(helper, /setSearchScrollTarget\(\{ sessionId, turnId, nonce: Date\.now\(\) \}\);/);
    assert.match(helper, /setSearchScrollTarget\(null\);/);
  });

  it('does not pass raw setActiveId to module session links', async () => {
    const main = await readRendererShellSource('app-shell.tsx');

    assert.doesNotMatch(
      main,
      /<DailyReviewPage[\s\S]*?onSelectSession=\{setActiveId\}/,
      'Daily Review session buttons must route back through the chat surface',
    );
    assert.match(
      main,
      /<DailyReviewPage[\s\S]*?onSelectSession=\{openSessionInChat\}/,
      'Daily Review session buttons must use the shell-level session open helper',
    );
  });

  it('opens branched sessions only while the source session is still active', async () => {
    const handlerBlock = await readRendererShellSource('app-shell-turn-actions.ts');
    const branchBlock = handlerBlock.match(/else if \(actionId === 'branch'\) \{[\s\S]*?await refreshSessions\(\);[\s\S]*?\n      \}/)?.[0] ?? '';
    const catchBlock = handlerBlock.match(/catch \(error\) \{([\s\S]*?)\n    \} finally/)?.[1] ?? '';

    assert.match(handlerBlock, /const sessionId = activeIdRef\.current;/);
    assert.match(
      handlerBlock,
      /await window\.maka\.sessions\.regenerateTurn\(sessionId, \{\s*sourceTurnId: turnId,?\s*\}\);[\s\S]*?if \(activeIdRef\.current === sessionId\) \{[\s\S]*?toastApi\.info\(copy\.regenerateStartedTitle, copy\.regenerateStartedDescription\)/,
      'regenerate feedback must stay owned by the source session',
    );
    assert.match(branchBlock, /const newSession = await window\.maka\.sessions\.branchFromTurn/);
    assert.match(branchBlock, /upsertSessionSummary\(newSession\);/);
    assert.match(
      branchBlock,
      /if \(activeIdRef\.current === sessionId\) \{[\s\S]*openSessionInChat\(newSession\.id\);[\s\S]*setMessages\(\[\]\);[\s\S]*await refreshMessages\(newSession\.id\);[\s\S]*toastApi\.success\(copy\.branchCreatedTitle, copy\.branchCreatedDescription\(newSession\.name\)\);[\s\S]*\}/,
      'branch completion must not navigate or toast after the user leaves the source session',
    );
    assert.match(branchBlock, /await refreshSessions\(\);/);
    assert.doesNotMatch(
      branchBlock,
      /openSessionInChat\(newSession\.id\);[\s\S]*await refreshSessions\(\);[\s\S]*toastApi\.success/,
      'branch success feedback must be owned by the active source-session guard',
    );
    assert.match(
      handlerBlock,
      /catch \(error\) \{[\s\S]*if \(activeIdRef\.current !== sessionId\) return;[\s\S]*if \(isSessionWorkspaceUnavailableError\(error\)\) \{[\s\S]*showSessionWorkspaceUnavailableToast\(toastApi, uiLocale\);[\s\S]*\} else \{[\s\S]*toastApi\.error\([\s\S]*copy\.operationFailedTitle,[\s\S]*localizedShellErrorMessage\(error, copy\.operationFailedFallback, uiLocale\)[\s\S]*\);[\s\S]*\}[\s\S]*\} finally \{[\s\S]*clearPendingTurnAction\(key\);[\s\S]*\}/,
      'turn footer failures must stay owned by the source session and preserve workspace recovery copy',
    );
    assert.doesNotMatch(
      handlerBlock,
      /else if \(actionId === 'branch'\) \{[\s\S]*clearPendingTurnAction\(key\);[\s\S]*\}[\s\S]*catch \(error\)/,
      'pending turn actions must not be cleared only by the branch success path',
    );
    assert.doesNotMatch(
      catchBlock,
      /clearPendingTurnAction\(key\);/,
      'pending turn actions must not be cleared only by the error path',
    );
    assert.doesNotMatch(
      handlerBlock,
      /toastApi\.error\('操作失败', cleanErrorMessage\(error\)\)/,
      'turn footer action failures must not echo raw cleaned Error.message in visible toast feedback',
    );
  });

  it('new-chat navigation does not wipe other sessions live renderer state', async () => {
    const source = await readRendererShellSources(['app-shell.tsx', 'use-app-shell-session-workspace.ts']);
    const createSession = source.match(/async function createSession\(\) \{[\s\S]*?\n  \}/)?.[0] ?? '';
    const openNewTaskSurface = source.match(/function openNewTaskSurface\(\) \{[\s\S]*?\n  \}/)?.[0] ?? '';
    const startNewSession = source.match(/function startNewSession\(\): void \{[\s\S]*?\n  \}/)?.[0] ?? '';

    assert.match(createSession, /openNewTaskSurface\(\);/);
    assert.match(openNewTaskSurface, /startNewSession\(\);/);
    assert.match(startNewSession, /setActiveId\(undefined\);/);
    assert.match(openNewTaskSurface, /setNavSelection\(\{ section: 'sessions', filter: 'chats' \}\);/);
    assert.match(openNewTaskSurface, /setSearchScrollTarget\(null\);/);
    assert.match(startNewSession, /setMessages\(\[\]\);/);
    assert.doesNotMatch(
      createSession,
      /setStreamingBySession\(\{\}\)|setLiveToolsBySession\(\{\}\)|setPermissionBySession\(\{\}\)/,
      'new chat should clear only the current empty chat surface, not wipe live state for other running sessions',
    );
  });

  it('keeps persisted mark-read at the renderer message-read IPC boundary', async () => {
    const main = await readMainProcessCombinedSource();
    const readMessagesHandler = main.match(/ipcMain\.handle\('sessions:readMessages'[\s\S]*?\n  \}\);/)?.[0] ?? '';
    const searchHandler = main.match(/ipcMain\.handle\('search:thread'[\s\S]*?\n  \}\);/)?.[0] ?? '';
    const gatewayDeps = main.match(/const openGateway = new OpenGatewayService\(\{[\s\S]*?\n\}\);/)?.[0] ?? '';

    assert.match(readMessagesHandler, /try \{[\s\S]*messages = await runtime\.getMessages\(sessionId\);[\s\S]*\} catch \(error\) \{[\s\S]*throw new Error\(sessionReadMessagesFailureMessage\(error\)\);[\s\S]*\}/);
    assert.match(
      readMessagesHandler,
      /try \{[\s\S]*await runtime\.markSessionRead\(sessionId, latestStoredMessageTs\(messages\)\);[\s\S]*\} catch \{[\s\S]*\}[\s\S]*return messages;/,
      'mark-read write failures must not reject the already-read message payload',
    );
    assert.doesNotMatch(readMessagesHandler, /throw new Error\(sessionMarkReadFailureMessage\(error\)\)/);
    assert.doesNotMatch(readMessagesHandler, /markSessionRead\(sessionId\)\.catch/);
    assert.doesNotMatch(searchHandler, /markSessionRead/);
    assert.match(gatewayDeps, /readMessages: \(sessionId\) => runtime\.getMessages\(sessionId\)/);
    assert.doesNotMatch(gatewayDeps, /markSessionRead/);
  });
});
