import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readRendererShellCombinedSource } from './renderer-shell-source-helpers.js';
import { readRenderedSessionHistorySource } from './session-history-owner-source-helpers.js';

describe('session row actions fail soft', () => {
  it('surfaces sidebar session action failures instead of leaving fire-and-forget rejections', async () => {
    const main = await readRendererShellCombinedSource();

    assert.match(main, /async function runSessionRowAction\([\s\S]*errorTitle: string,[\s\S]*try \{[\s\S]*await action\(\);[\s\S]*\} catch \(error\) \{[\s\S]*toastApi\.error\(errorTitle, localizedShellErrorMessage\(error, copy\.actionFallback, uiLocale\)\)/);
    assert.match(main, /async function flagSession\(sessionId: string, flagged: boolean\) \{[\s\S]*runSessionRowAction\(sessionId, 'flag', flagged \? copy\.flagFailedTitle : copy\.unflagFailedTitle[\s\S]*window\.maka\.sessions\.setFlagged\(sessionId, flagged, \{ revisionFamily: true \}\)[\s\S]*refreshSessions\(\)/);
    assert.match(main, /async function archiveSession\(sessionId: string\) \{[\s\S]*revisionFamilySessionIds\(sessionsRef\.current, sessionId\)[\s\S]*window\.maka\.sessions\.archive\(sessionId, \{ revisionFamily: true \}\)[\s\S]*familyIds\.includes\(activeIdRef\.current\)[\s\S]*setActiveId\(undefined\)[\s\S]*setMessages\(\[\]\)[\s\S]*for \(const id of familyIds\) clearSessionRendererState\(id\)[\s\S]*refreshSessions\(\)/);
    assert.match(main, /async function unarchiveSession\(sessionId: string\) \{[\s\S]*window\.maka\.sessions\.unarchive\(sessionId, \{ revisionFamily: true \}\)[\s\S]*refreshSessions\(\)/);
    assert.match(main, /async function renameSession\(sessionId: string, name: string\) \{[\s\S]*window\.maka\.sessions\.rename\(sessionId, name, \{ revisionFamily: true \}\)[\s\S]*refreshSessions\(\)/);
    assert.match(main, /async function deleteSession\(sessionId: string\) \{[\s\S]*toastApi\.confirm\([\s\S]*revisionFamilySessionIds\(sessionsRef\.current, sessionId\)[\s\S]*window\.maka\.sessions\.remove\(sessionId, \{ revisionFamily: true \}\)[\s\S]*familyIds\.includes\(activeIdRef\.current\)[\s\S]*setActiveId\(undefined\)[\s\S]*setMessages\(\[\]\)[\s\S]*for \(const id of familyIds\) clearSessionRendererState\(id\)[\s\S]*refreshSessions\(\)[\s\S]*toastApi\.success\(copy\.deletedTitle\(name\)\)/);
    assert.doesNotMatch(
      main,
      /toastApi\.error\((?:flagged \? '标记会话失败' : '取消标记失败'|'归档会话失败'|'恢复会话失败'|'重命名会话失败'|'删除会话失败'), cleanErrorMessage\(error\)\)/,
      'sidebar row action failures must not echo raw cleaned Error.message in visible toast feedback',
    );
  });

  it('gates duplicate sidebar row actions before IPC or confirm dialogs can double-fire', async () => {
    const main = await readRendererShellCombinedSource();
    const sessionListBlock = main.match(/<SessionListPanel[\s\S]*?\/>/)?.[0] ?? '';

    assert.match(main, /const sessionRowActionRegistry = useKeyedPendingRegistry\(\);/);
    assert.match(
      main,
      /pendingSessionRowActionsRef: sessionRowActionRegistry\.keysRef/,
      'the row-action dedup Set the sidebar handlers guard on must be backed by the shared keyed-pending registry',
    );
    assert.match(main, /const sessionPrefix = `\$\{sessionId\}:`;/);
    assert.match(main, /Array\.from\(pendingSessionRowActionsRef\.current\)\.some\(\(key\) => key\.startsWith\(sessionPrefix\)\)/);
    assert.match(main, /pendingSessionRowActionsRef\.current\.add\(key\);[\s\S]*catch \(error\) \{[\s\S]*toastApi\.error\(errorTitle, localizedShellErrorMessage\(error, copy\.actionFallback, uiLocale\)\)[\s\S]*finally \{[\s\S]*pendingSessionRowActionsRef\.current\.delete\(key\);/);
    assert.match(main, /const sessionRowActions = useMemo<NonNullable<Parameters<typeof SessionListPanel>\[0\]\['rowActions'\]>>\([\s\S]*onToggleFlag: \(sessionId, next\) => sessionRowActionHandlers.flagSession\(sessionId, next\),[\s\S]*onArchive: \(sessionId\) => sessionRowActionHandlers.archiveSession\(sessionId\),[\s\S]*onUnarchive: \(sessionId\) => sessionRowActionHandlers.unarchiveSession\(sessionId\),[\s\S]*onRename: \(sessionId, name\) => sessionRowActionHandlers.renameSession\(sessionId, name\),[\s\S]*onDelete: \(sessionId\) => sessionRowActionHandlers.deleteSession\(sessionId\),/);
    assert.match(main, /rowActions=\{sessionRowActions\}/);
    assert.match(sessionListBlock, /onSelectSession=\{[^}]+\}/);
    assert.match(sessionListBlock, /rowActions=\{[^}]+\}/);
    assert.doesNotMatch(sessionListBlock, /onSelectSession=\{\(sessionId\)/);
    assert.doesNotMatch(sessionListBlock, /rowActions=\{\{/);
    assert.doesNotMatch(main, /onDelete: \(sessionId\) => void sessionRowActionHandlers.deleteSession\(sessionId\)/);
    assert.doesNotMatch(main, /onToggleFlag: \(sessionId, next\) => void sessionRowActionHandlers.flagSession\(sessionId, next\)/);
  });

  it('cleans active session renderer state consistently after archive or delete', async () => {
    const main = await readRendererShellCombinedSource();
    const cleanupBlock = main.match(/function clearSessionRendererState\(sessionId: string\): void \{[\s\S]*?\n  \}/)?.[0] ?? '';
    const ownedCleanupBlock = main.match(/function clearOwnedSessionState\(sessionId: string\): void \{[\s\S]*?\n  \}/)?.[0] ?? '';

    assert.match(cleanupBlock, /clearOwnedSessionState\(sessionId\);/);
    assert.match(ownedCleanupBlock, /messageRetryPendingRef\.current\.delete\(sessionId\);/);
    assert.match(ownedCleanupBlock, /stopPendingRef\.current\.delete\(sessionId\);/);
    assert.match(cleanupBlock, /turnActionRegistry\.clearForSession\(sessionId\);/);
    assert.match(cleanupBlock, /permissionModeChangeRegistry\.keysRef\.current\.delete\(sessionId\);/);
    assert.match(cleanupBlock, /sessionModelChangeRegistry\.keysRef\.current\.delete\(sessionId\);/);
    assert.match(
      ownedCleanupBlock,
      /sessionUi\.clearSessionUiState\(sessionId\);/,
      'archive/delete cleanup must use the centralized per-session UI state cleanup',
    );

    assert.match(
      main,
      /event\.reason === 'deleted'[\s\S]*setActiveId\(undefined\);[\s\S]*setMessages\(\[\]\);[\s\S]*clearSessionRendererState\(deletedSessionId\);/,
      'session deleted events must use the same renderer cleanup as row actions',
    );
    assert.match(
      main,
      /async function archiveSession\(sessionId: string\) \{[\s\S]*window\.maka\.sessions\.archive\(sessionId, \{ revisionFamily: true \}\)[\s\S]*familyIds\.includes\(activeIdRef\.current\)[\s\S]*setActiveId\(undefined\);[\s\S]*setMessages\(\[\]\);[\s\S]*for \(const id of familyIds\) clearSessionRendererState\(id\);/,
      'archiving the active session must clear streaming, permission, pending, and health state',
    );
    assert.match(
      main,
      /async function deleteSession\(sessionId: string\) \{[\s\S]*window\.maka\.sessions\.remove\(sessionId, \{ revisionFamily: true \}\)[\s\S]*familyIds\.includes\(activeIdRef\.current\)[\s\S]*setActiveId\(undefined\);[\s\S]*setMessages\(\[\]\);[\s\S]*for \(const id of familyIds\) clearSessionRendererState\(id\);/,
      'deleting a session must clear renderer state even after the row unmounts',
    );
  });

  it('keeps sidebar menu actions single-flight while a row action is pending', async () => {
    const ui = await readRenderedSessionHistorySource();

    assert.match(ui, /type SessionRowActionId = 'flag' \| 'archive' \| 'rename' \| 'delete';/);
    assert.match(ui, /onToggleFlag\(sessionId: string, next: boolean\): void \| Promise<void>;/);
    assert.match(ui, /onDelete\(sessionId: string\): void \| Promise<void>;/);
    assert.match(ui, /const \[pendingAction,\s*setPendingAction\] = useState<SessionRowActionId \| null>\(null\);/);
    assert.match(ui, /const rowMountedRef = useMountedRef\(\);/);
    assert.match(ui, /const pendingActionRef = useRef<SessionRowActionId \| null>\(null\);/);
    assert.match(
      ui,
      /if \(pendingActionRef\.current\) return;[\s\S]*pendingActionRef\.current = actionId;[\s\S]*void \(async \(\) => \{[\s\S]*try \{[\s\S]*await action\(\);[\s\S]*\} catch \{[\s\S]*\} finally \{/,
    );
    assert.match(
      ui,
      /useEffect\(\(\) => \{\s*return \(\) => \{\s*pendingActionRef\.current = null;\s*\};\s*\}, \[\]\)/,
      'SessionRow must release pending ownership when archive/delete/filter changes unmount the row',
    );
    assert.match(
      ui,
      /pendingActionRef\.current = null;[\s\S]*if \(rowMountedRef\.current\) setPendingAction\(null\);/,
      'SessionRow action cleanup must not write pending state after the row unmounts',
    );
    assert.match(
      ui,
      /<Menu[\s\S]*?button=\{\{[\s\S]*?isDisabled:\s*actionBusy[\s\S]*?<MenuItem[\s\S]*?isDisabled=\{actionBusy\}/,
      'the overflow trigger and its menu actions must be disabled while the row owns an action',
    );
    assert.doesNotMatch(ui, /aria-busy=\{pendingAction ===/);
    assert.doesNotMatch(ui, /data-pending=\{pendingAction ===/);
  });
});
