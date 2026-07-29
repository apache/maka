import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import {
  readRendererShellCombinedSource,
  readRendererShellSource,
  readRendererShellSources,
} from './renderer-shell-source-helpers.js';
import {
  readMainProcessCombinedSource,
  readSessionsIpcSource,
} from './main-process-contract-source-helpers.js';

import {
  normalizeBranchFromTurnInput,
  normalizeSandboxBoundaryResponse,
  normalizeRegenerateTurnInput,
  normalizeReviseBeforeTurnInput,
  normalizeSessionSendCommand,
  normalizeStopSessionInput,
  normalizeUserQuestionResponse,
} from '../permission-response-guard.js';

describe('permission response IPC boundary', () => {
  it('normalizes bounded user-question answers without coercing nulls', () => {
    assert.deepEqual(
      normalizeUserQuestionResponse({ requestId: 'question-1', answers: ['Option A', null], extra: true }),
      { requestId: 'question-1', answers: ['Option A', null] },
    );
    assert.throws(() => normalizeUserQuestionResponse({ requestId: '', answers: ['A'] }), /requestId/);
    assert.throws(() => normalizeUserQuestionResponse({ requestId: 'q', answers: [] }), /answers/);
    assert.throws(() => normalizeUserQuestionResponse({ requestId: 'q', answers: ['A', 'B', 'C', 'D'] }), /answers/);
    assert.throws(() => normalizeUserQuestionResponse({ requestId: 'q', answers: [1] }), /answers/);
  });

  it('registers AskUserQuestion only on the Desktop root tool surface and routes its response', async () => {
    const main = await readMainProcessCombinedSource();
    // Root surface is assembled as toolsBeforeSkill + Skill + SkillSearch +
    // toolsAfterSkill → builtinTools.
    // The tool surface moved into tool-assembly.ts (arch R4), so the block
    // closers are now indented inside assembleDesktopTools — tolerate leading
    // whitespace on the closing bracket.
    const rootBeforeSkill =
      main.match(/const toolsBeforeSkill: MakaTool\[\] = \[[\s\S]*?\n\s*\];/)?.[0] ?? '';
    const rootBuiltin =
      main.match(
        /const builtinTools: MakaTool\[\] = \[[\s\S]*?\.\.\.toolsBeforeSkill,[\s\S]*?skillTool,[\s\S]*?skillSearchTool,[\s\S]*?\.\.\.toolsAfterSkill,[\s\S]*?\];/,
      )?.[0] ?? '';
    const childTools = main.match(/const childAgentTools = buildChildAgentTools\([\s\S]*?\n\s*\]\);/)?.[0] ?? '';
    const handler = main.match(/ipcMain\.handle\('sessions:respondToUserQuestion'[\s\S]*?\n  \}\);/)?.[0] ?? '';

    assert.match(rootBeforeSkill, /buildAskUserQuestionTool\(\)/);
    assert.match(rootBuiltin, /toolsBeforeSkill/);
    assert.doesNotMatch(childTools, /buildAskUserQuestionTool\(\)/);
    assert.match(handler, /const normalized = normalizeUserQuestionResponse\(response\)/);
    assert.match(handler, /await ensureSessionWorkspaceAvailable\(sessionId\)/);
    assert.match(handler, /runtime\.respondToUserQuestion\(sessionId, normalized\)/);
  });

  it('exposes the user-question response through preload and the renderer type boundary', async () => {
    const preload = await readFile(fileURLToPath(new URL('../../../src/preload/preload.ts', import.meta.url)), 'utf8');
    const globalTypes = await readFile(fileURLToPath(new URL('../../../src/preload/bridge-contract.d.ts', import.meta.url)), 'utf8');

    assert.match(preload, /respondToUserQuestion\(sessionId: string, response: UserQuestionResponse\)/);
    assert.match(preload, /ipcRenderer\.invoke\('sessions:respondToUserQuestion', sessionId, response\)/);
    assert.match(globalTypes, /respondToUserQuestion\(sessionId: string, response: UserQuestionResponse\): Promise<void>/);
  });

  it('normalizes boundary allow / deny responses without legacy grant fields', () => {
    assert.deepEqual(
      normalizeSandboxBoundaryResponse({
        requestId: 'permission-1',
        decision: 'allow',
        rememberForTurn: true,
        extra: 'ignored',
      }),
      {
        requestId: 'permission-1',
        decision: 'allow',
      },
    );
    assert.deepEqual(
      normalizeSandboxBoundaryResponse({ requestId: 'permission-2', decision: 'deny' }),
      { requestId: 'permission-2', decision: 'deny' },
    );
  });

  it('rejects malformed renderer decisions instead of treating them as allow', () => {
    assert.throws(() => normalizeSandboxBoundaryResponse(null), /Invalid sandbox boundary response/);
    assert.throws(
      () => normalizeSandboxBoundaryResponse({ requestId: '', decision: 'allow' }),
      /requestId/,
    );
    assert.throws(
      () =>
        normalizeSandboxBoundaryResponse({ requestId: 'permission-1', decision: 'approve' }),
      /decision/,
    );
  });

  it('routes sessions:respondToSandboxBoundary through the main-process normalizer', async () => {
    const mainPath = fileURLToPath(new URL('../../../src/main/main.ts', import.meta.url));
    const main = await readMainProcessCombinedSource();
    const handler = main.match(/ipcMain\.handle\('sessions:respondToSandboxBoundary'[\s\S]*?\n  \}\);/)?.[0] ?? '';

    assert.match(handler, /normalizeSandboxBoundaryResponse\(response\)/);
    assert.match(
      handler,
      /if \(normalized\.decision === 'allow'\) \{[\s\S]*await ensureSessionWorkspaceAvailable\(sessionId\)/,
      'allow must revalidate the workspace before resuming a parked tool; deny must remain available',
    );
    assert.doesNotMatch(handler, /runtime\.respondToSandboxBoundary\(sessionId,\s*response\)/);
    assert.match(
      handler,
      /await runtime\.respondToSandboxBoundary\(sessionId, normalized\);[\s\S]*notifyAgentGraphPermissionResponse\?\.\(sessionId\)/,
      'graph wake settlement must run only after the normalized permission response is accepted',
    );
  });

  it('normalizes turn action inputs before regenerate / branch runtime calls', () => {
    assert.deepEqual(
      normalizeRegenerateTurnInput({ sourceTurnId: 'turn-2' }),
      { sourceTurnId: 'turn-2' },
    );
    assert.deepEqual(
      normalizeBranchFromTurnInput({ sourceTurnId: 'turn-3', name: '  Branch name  ', ignored: 1 }),
      { sourceTurnId: 'turn-3', name: 'Branch name' },
    );
    assert.deepEqual(
      normalizeReviseBeforeTurnInput({ sourceTurnId: 'turn-4', name: 'ignored' }),
      { sourceTurnId: 'turn-4' },
    );
  });

  it('rejects malformed turn action inputs at the IPC boundary', () => {
    assert.throws(() => normalizeRegenerateTurnInput({ sourceTurnId: 'turn-1', turnId: 1 }), /turnId/);
    assert.throws(() => normalizeBranchFromTurnInput({ sourceTurnId: 'turn-1', name: 1 }), /branch name/);
    assert.throws(() => normalizeReviseBeforeTurnInput({ sourceTurnId: 1 }), /revision sourceTurnId/);
  });

  it('routes turn actions through main-process normalizers', async () => {
    const main = await readMainProcessCombinedSource();
    const execution = await readFile(
      fileURLToPath(new URL('../../../src/main/session-execution-ipc-main.ts', import.meta.url)),
      'utf8',
    );
    const regenerateHandler =
      execution.match(
        /deps\.ipcMain\.handle\(\s*'sessions:regenerateTurn'[\s\S]*?\n  \);/,
      )?.[0] ?? '';
    const branchHandler = main.match(/ipcMain\.handle\('sessions:branchFromTurn'[\s\S]*?\n  \);/)?.[0] ?? '';
    const reviseBeforeHandler = main.match(/ipcMain\.handle\('sessions:reviseBeforeTurn'[\s\S]*?\n  \);/)?.[0] ?? '';

    assert.match(regenerateHandler, /normalizeRegenerateTurnInput\(input\)/);
    assert.doesNotMatch(regenerateHandler, /runtime\.regenerateTurn\(sessionId,\s*\{\s*\.\.\.input/);
    assert.match(branchHandler, /handleBranchFromTurn\(sessionId, input/);
    assert.doesNotMatch(branchHandler, /runtime\.branchFromTurn\(sessionId,\s*input\)/);
    assert.match(reviseBeforeHandler, /handleReviseBeforeTurn\(sessionId, input/);
    assert.doesNotMatch(reviseBeforeHandler, /runtime\.reviseBeforeTurn\(sessionId,\s*input\)/);
  });

  it('normalizes session send commands and rejects malformed send payloads', () => {
    assert.deepEqual(
      normalizeSessionSendCommand({
        type: 'send',
        turnId: 'turn-1',
        text: 'hello',
        skillIds: ['weekly-report'],
        attachmentItems: [{ approvalId: 'a', name: 'n' }],
        extra: true,
      }),
      {
        type: 'send',
        turnId: 'turn-1',
        text: 'hello',
        skillIds: ['weekly-report'],
        attachmentItems: [{ approvalId: 'a', name: 'n' }],
      },
    );
    assert.deepEqual(
      normalizeSessionSendCommand({ type: 'send', text: 'hello' }),
      { type: 'send', text: 'hello' },
    );
    assert.deepEqual(
      normalizeSessionSendCommand({ type: 'send', text: '', skillIds: ['weekly-report'] }),
      { type: 'send', text: '', skillIds: ['weekly-report'] },
    );
    assert.deepEqual(
      normalizeSessionSendCommand({
        type: 'send',
        text: '',
        skillIds: ['project:maka:weekly-report'],
      }),
      { type: 'send', text: '', skillIds: ['project:maka:weekly-report'] },
    );
    assert.equal(normalizeSessionSendCommand({ type: 'stop' }), undefined);
    assert.throws(() => normalizeSessionSendCommand(null), /session command/);
    assert.throws(() => normalizeSessionSendCommand({ type: 'send', text: '' }), /send text/);
    assert.throws(
      () => normalizeSessionSendCommand({ type: 'send', text: 'hello', skillIds: ['/bad'] }),
      /skillIds/,
    );
    assert.throws(() => normalizeSessionSendCommand({ type: 'send', turnId: 1, text: 'hello' }), /send turnId/);
  });

  it('accepts only a bounded trusted orchestration override on send', () => {
    assert.deepEqual(
      normalizeSessionSendCommand({
        type: 'send',
        turnId: 'turn-swarm',
        text: 'inspect the repository',
        skillIds: ['weekly-report'],
        turnOrchestration: { mode: 'swarm', source: 'slash_command', ignored: true },
      }),
      {
        type: 'send',
        turnId: 'turn-swarm',
        text: 'inspect the repository',
        skillIds: ['weekly-report'],
        turnOrchestration: { mode: 'swarm', source: 'slash_command' },
      },
    );
    assert.throws(
      () => normalizeSessionSendCommand({
        type: 'send', text: 'hello', turnOrchestration: { mode: 'swarm', source: 'prompt' },
      }),
      /turn orchestration/,
    );
  });

  it('normalizes inline quotes and rejects malformed quote payloads', () => {
    assert.deepEqual(
      normalizeSessionSendCommand({
        type: 'send',
        text: 'explain this',
        quotes: [
          { text: 'the excerpt', label: '  助手回复  ', sourceTurnId: 'turn-9', extra: true },
          { text: 'second' },
        ],
      }),
      {
        type: 'send',
        text: 'explain this',
        quotes: [
          { text: 'the excerpt', label: '助手回复', sourceTurnId: 'turn-9' },
          { text: 'second' },
        ],
      },
    );
    // An empty array carries no reference — drop the key rather than persisting
    // `quotes: []` onto the message.
    assert.deepEqual(
      normalizeSessionSendCommand({ type: 'send', text: 'hi', quotes: [] }),
      { type: 'send', text: 'hi' },
    );
    assert.throws(() => normalizeSessionSendCommand({ type: 'send', text: 'hi', quotes: {} }), /send quotes/);
    assert.throws(
      () => normalizeSessionSendCommand({ type: 'send', text: 'hi', quotes: Array(17).fill({ text: 'x' }) }),
      /send quotes/,
    );
    assert.throws(
      () => normalizeSessionSendCommand({ type: 'send', text: 'hi', quotes: [{ text: '' }] }),
      /send quote text/,
    );
    assert.throws(
      () => normalizeSessionSendCommand({ type: 'send', text: 'hi', quotes: [{ text: 'x', sourceTurnId: 1 }] }),
      /send quote sourceTurnId/,
    );
  });

  it('normalizes stop session input and rejects malformed stop sources', () => {
    assert.deepEqual(normalizeStopSessionInput(undefined), {});
    assert.deepEqual(normalizeStopSessionInput({ source: 'stop_button', extra: true }), { source: 'stop_button' });
    assert.throws(() => normalizeStopSessionInput(null), /stop session input/);
    assert.throws(() => normalizeStopSessionInput({ source: 'toolbar' }), /stop session source/);
  });

  it('routes send and stop IPC payloads through main-process normalizers', async () => {
    const mainPath = fileURLToPath(new URL('../../../src/main/main.ts', import.meta.url));
    const main = await readMainProcessCombinedSource();
    const stopHandler = main.match(/ipcMain\.handle\('sessions:stop'[\s\S]*?\n  \);/)?.[0] ?? '';
    const sendHandler = main.match(/ipcMain\.handle\('sessions:send'[\s\S]*?\n  \);/)?.[0] ?? '';

    assert.match(stopHandler, /normalizeStopSessionInput\(input\)/);
    assert.doesNotMatch(stopHandler, /runtime\.stopSession\(sessionId,\s*input\)/);
    assert.match(stopHandler, /emitSessionsChanged\('status-change',\s*sessionId\)/);
    assert.match(stopHandler, /emitSessionsChanged\('turn-status-change',\s*sessionId\)/);
    assert.match(stopHandler, /emitSessionsChanged\('message-appended',\s*sessionId\)/);
    assert.match(sendHandler, /normalizeSessionSendCommand\(command\)/);
    assert.match(sendHandler, /ensureSessionCanSend/);
    assert.doesNotMatch(sendHandler, /command\.text/);
    assert.doesNotMatch(sendHandler, /command\.attachments/);
  });

  it('renderer stop() and respondToSandboxBoundary() surface IPC failures only for the source session', async () => {
    // The Composer wires onStop via both the button onClick and the
    // Escape key handler, neither of which awaits the returned
    // promise. If stop() lets the IPC reject without try/catch the
    // failure dies as UnhandledPromiseRejection and the user sees
    // nothing while the model keeps streaming. Same applies to
    // respondToSandboxBoundary().
    const renderer = await readRendererShellSources([
      'app-shell.tsx',
      'app-shell-stop-action.ts',
      'app-shell-chat-actions.ts',
      'use-app-shell-session-workspace.ts',
    ]);
    // Match `async function stop()` body up to its closing brace.
    const stop = renderer.match(/async function stop\(\)\s*\{[\s\S]*?\n  \}/);
    assert.ok(stop, 'stop() must exist in main.tsx');
    assert.match(renderer, /const stopPendingRef = useRef<Set<string>>\(new Set\(\)\);/);
    assert.match(renderer, /function addPendingSessionAction\([\s\S]*?pendingRef\.current\.has\(sessionId\)[\s\S]*?pendingRef\.current\.add\(sessionId\)[\s\S]*?setPendingBySession/);
    assert.match(renderer, /function clearPendingSessionAction\([\s\S]*?pendingRef\.current\.delete\(sessionId\)[\s\S]*?omitSessionKey\(current, sessionId\)/);
    assert.match(stop[0], /const sessionId = activeIdRef\.current;/);
    assert.match(stop[0], /if \(!sessionId \|\| !addPendingSessionAction\(sessionId, stopPendingRef, setStopPendingBySession\)\) return;/);
    assert.match(stop[0], /try\s*\{[\s\S]*?await window\.maka\.sessions\.stop/);
    assert.match(stop[0], /await window\.maka\.sessions\.stop\(sessionId, \{ source: 'stop_button' \}\);/);
    assert.match(
      stop[0],
      /catch \(error\)[\s\S]*?if \(activeIdRef\.current === sessionId\) \{[\s\S]*?const copy = getDesktopConversationCopy\(uiLocale\)\.actions;[\s\S]*?toastApi\.error\(copy\.stopFailedTitle, localizedShellErrorMessage\(error, copy\.stopFailedFallback, uiLocale\)\);/,
      'stop failure feedback must not leak onto a different active session',
    );
    assert.doesNotMatch(
      stop[0],
      /toastApi\.error\('停止失败', cleanErrorMessage\(error\)\)/,
      'stop failure feedback must not expose raw IPC/provider/storage details',
    );
    assert.match(stop[0], /finally \{[\s\S]*?clearPendingSessionAction\(sessionId, stopPendingRef, setStopPendingBySession\);[\s\S]*?\}/);
    const respond = renderer.match(/async function respondToSandboxBoundary\([\s\S]*?\n  \}/);
    assert.ok(respond, 'respondToSandboxBoundary() must exist');
    assert.match(respond[0], /const sessionId = activeIdRef\.current;/);
    assert.match(respond[0], /if \(!sessionId\) return;/);
    assert.match(respond[0], /try\s*\{[\s\S]*?await window\.maka\.sessions\.respondToSandboxBoundary\(sessionId, response\);/);
    assert.doesNotMatch(
      respond[0],
      /respondToSandboxBoundary\(activeId, response\)/,
      'permission response IPC must use the captured source session, not render-time activeId',
    );
    assert.match(
      respond[0],
      /catch \(error\)[\s\S]*?if \(activeIdRef\.current !== sessionId\) return;[\s\S]*?toastApi\.error\(\s*copy\.responseFailedTitle,\s*localizedShellErrorMessage\(error, copy\.responseFailedFallback, uiLocale\),?\s*\);/,
      'permission response failure feedback must not leak onto a different active session',
    );
    assert.doesNotMatch(
      respond[0],
      /toastApi\.error\('响应失败', cleanErrorMessage\(error\)\)/,
      'permission response failure feedback must not expose raw IPC/provider/storage details',
    );
  });

  it('renderer responds to a user question for its source session and dequeues only after success', async () => {
    const renderer = await readRendererShellSource('app-shell-chat-actions.ts');
    const respond = renderer.match(/async function respondToUserQuestion\([\s\S]*?\n  \}/)?.[0] ?? '';

    assert.match(respond, /const sessionId = activeIdRef\.current;/);
    assert.match(respond, /await window\.maka\.sessions\.respondToUserQuestion\(sessionId, response\);/);
    assert.match(
      respond,
      /setInteractionBySession\(\(current\) => dequeueInteractionByRequestId\(current, sessionId, response\.requestId\)\);/,
    );
    assert.match(respond, /catch \(error\)[\s\S]*activeIdRef\.current !== sessionId\) return/);
  });

  it('renderer dequeues a boundary prompt only after main accepts its decision', async () => {
    const renderer = await readRendererShellSource('app-shell-chat-actions.ts');
    const respond =
      renderer.match(/async function respondToSandboxBoundary\([\s\S]*?\n  \}/)?.[0] ?? '';

    assert.match(
      respond,
      /await window\.maka\.sessions\.respondToSandboxBoundary\(sessionId, response\);[\s\S]*dequeueInteractionByRequestId\(current, sessionId, response\.requestId\)/,
    );
    assert.match(respond, /catch \(error\)[\s\S]*activeIdRef\.current !== sessionId\) return/);
  });

  it('renderer lets either interaction type take over the mounted composer slot', async () => {
    const shell = await readRendererShellSource('app-shell.tsx');
    const composerRegion = await readRendererShellSource('chat-composer-region.tsx');
    assert.match(shell, /activeQuestion = activeInteraction\?\.type === 'user_question_request'/);
    assert.match(composerRegion, /<UserQuestionPrompt[\s\S]*request=\{activeQuestion\}/);
    assert.match(composerRegion, /hidden=\{[^}]*Boolean\(activeInteraction\)[^}]*\}/);
  });

  it('renderer reload rehydrates only main-owned live sandbox boundary requests', async () => {
    const shell = await readRendererShellSource('app-shell.tsx');
    assert.match(
      shell,
      /listActiveSandboxBoundaryRequests\(activeId\)[\s\S]*reconcileSandboxBoundaryInteractions\(current, activeId, requests\)/,
    );
    assert.match(shell, /sandboxBoundaryInteractionEpochRef[\s\S]*hydrationEpoch/);
    assert.doesNotMatch(
      shell,
      /listPendingSandboxBoundaryRequests/,
      'the renderer must not turn ownerless persisted rows into actionable prompts',
    );
  });

  it('retires an answered e2e-fixture boundary request through the one fixture-state owner', async () => {
    const sessionsIpc = await readSessionsIpcSource();
    const respondHandler =
      sessionsIpc.match(/ipcMain\.handle\('sessions:respondToSandboxBoundary'[\s\S]*?\n  \}\);/)?.[0] ??
      '';

    // The fixture request is rebuilt from its scenario on every read, so unless
    // the answer is remembered the prompt returns and retakes the composer
    // slot. It must be remembered at the fixture-state owner, not next to one
    // of its two exits: the sessions IPC serves the active-request list, and
    // `e2eFixture:getState` hands the renderer a state it seeds its interaction
    // queue from directly, bypassing that list entirely.
    assert.match(respondHandler, /retireE2eFixtureSandboxBoundaryRequest\(normalized\.requestId\)/);
    assert.doesNotMatch(
      sessionsIpc,
      /answeredFixtureSandboxBoundaryRequests/,
      'retirement must not live in a side table only the sessions IPC can see',
    );

    // Allow retires only after the grant lands, matching the runtime, which
    // drops an active request on the acknowledged decision rather than the
    // received one. Deny has nothing to write, so it retires straight away.
    assert.match(
      respondHandler,
      /await applyFixtureSandboxBoundaryExpansion\([\s\S]*?\)\;\s*\}\s*retireE2eFixtureSandboxBoundaryRequest/,
      'a failed expansion must leave the request answerable instead of hiding it',
    );
  });

  it('command palette receives the active boundary-derived mode', async () => {
    const shell = await readRendererShellSource('app-shell.tsx');
    assert.match(
      shell,
      /const commandOptions:[\s\S]*?activeId,\s*activePermissionMode,\s*canSetPermissionMode: activeBoundarySurface\.localInteractionAvailable,\s*connections,/,
    );
    assert.match(shell, /deriveDesktopExecutionBoundarySurface\(/);
    assert.doesNotMatch(shell, /activePermissionMode:\s*activeSessionForView\?\.permissionMode/);
  });

  it('keeps every requested scope inspectable without pushing decisions off-screen', async () => {
    const styles = await readFile(
      fileURLToPath(new URL('../../../src/renderer/styles/interaction-prompts.css', import.meta.url)),
      'utf8',
    );
    const scopes = styles.match(/\.maka-sandbox-boundary-scopes\s*\{[\s\S]*?\}/)?.[0] ?? '';
    const path = styles.match(/\.maka-sandbox-boundary-scopes code\s*\{[\s\S]*?\}/)?.[0] ?? '';

    assert.match(scopes, /max-height:/);
    assert.match(scopes, /overflow-y:\s*auto/);
    assert.match(path, /overflow-wrap:\s*anywhere/);
    assert.match(path, /white-space:\s*normal/);
    assert.doesNotMatch(path, /text-overflow:\s*ellipsis/);
  });

  it('renderer clears the boundary prompt when a session completes', async () => {
    // Without this, a completed session would leave a stranded boundary entry in
    // `interactionBySession[sessionId]`, keeping the prompt visible
    // and blocking the session UI until the user manually navigates
    // away. Mirrors the existing `abort` cleanup.
    const renderer = await readRendererShellSource('app-shell-session-events.ts');
    // Find the 'complete' case in handleSessionEvent — the body must
    // clear the session's interaction queue for every terminal completion.
    const completeCase = renderer.match(/case 'complete':[\s\S]*?break;/);
    assert.ok(completeCase, "'complete' case must exist in renderer event handler");
    assert.match(
      completeCase[0],
      /setInteractionBySession\(\(current\) => clearInteractions\(current, sessionId\)\)/,
      "'complete' case must clear the session's interaction queue — mirrors the abort handler",
    );
  });

  it('toast items carry role="alert" so screen readers announce them (PR-PERMISSION-UI-CLEANUP-0)', async () => {
    const toastPath = fileURLToPath(new URL('../../../../../packages/ui/src/toast.tsx', import.meta.url));
    const toast = await readFile(toastPath, 'utf8');
    assert.match(
      toast,
      /<li[^>]*role="alert"/,
      'each toast <li> must declare role="alert" — the parent aria-live region alone is unreliable on macOS VoiceOver / NVDA',
    );
  });

  it('refreshes active messages when a sessions:changed message-appended event arrives', async () => {
    const renderer = await readRendererShellSource('app-shell-effects.ts');

    // PR-OAUTH-CARD-LIVE-STATE-0: the renderer uses a local
    // `changedSessionId = event.sessionId` shadow var + a truthy
    // guard before comparing to activeIdRef. Match either spelling
    // and allow the intermediate truthy check so this contract
    // doesn't rot when the implementation tweaks the guard shape.
    assert.match(
      renderer,
      /event\.reason === 'message-appended'[\s\S]{0,160}?(?:event\.sessionId|changedSessionId) === (?:options\.|latest\.)?activeIdRef\.current[\s\S]*?(?:options\.|latest\.)?refreshMessages\((?:event\.sessionId|changedSessionId)\)/,
    );
  });

  it('scopes session event error feedback to the active chat surface', async () => {
    const renderer = await readRendererShellSources([
      'app-shell-session-events.ts',
      'model-connection-errors.ts',
    ]);
    const errorBranch = renderer.match(/case 'error':[\s\S]*?case 'abort':/)?.[0] ?? '';
    const helper = renderer.match(/export function sessionEventErrorMessage\([\s\S]*?\n\}/)?.[0] ?? '';

    assert.match(
      helper,
      /localizedShellErrorMessage\(new Error\(event\.message\), fallback, locale\)/,
      'active chat error toasts must classify/redact raw SessionEvent.error.message before visible feedback',
    );

    assert.match(
      errorBranch,
      /setInteractionBySession[\s\S]*if \(activeIdRef\.current === sessionId\) \{[\s\S]*if \(isNoRealConnectionEvent\(event\)\) \{[\s\S]*const reason = noRealConnectionReasonFromEvent\(event\);[\s\S]*showModelSetupToast\(noRealConnectionSetupDescription\(reason, uiLocale\), reason\);[\s\S]*\} else \{[\s\S]*toastApi\.error\(copy\.conversationErrorTitle, sessionEventErrorMessage\(event, uiLocale\)\);[\s\S]*\}[\s\S]*\}[\s\S]*refreshSessions\(\);[\s\S]*refreshMessages\(sessionId, terminalRefreshOptions\(before\)\);/,
      'background session error events may update stored state, but must not show toasts or open Settings on the active chat surface',
    );
    assert.doesNotMatch(errorBranch, /clearLiveTurn\(sessionId\)/, 'error must retain live evidence until refresh confirms handoff');
    assert.doesNotMatch(
      errorBranch,
      /showModelSetupToast\(cleanEventMessage\(event\.message\), noRealConnectionReasonFromEvent\(event\)\)/,
      'model-setup event failures must not expose the cleaned raw event message as visible copy',
    );
    assert.doesNotMatch(
      errorBranch,
      /toastApi\.error\('对话出错', event\.message\)/,
      'SessionEvent.error.message may contain provider/raw transport detail and must not be toasted directly',
    );
  });

  it('keeps newly created sessions selected across immediate refreshSessions() calls', async () => {
    const renderer = await readRendererShellSources([
      'app-shell-session-start-actions.ts',
      'app-shell.tsx',
      'app-shell-effects.ts',
      'use-app-shell-session-list.ts',
      'use-app-shell-session-workspace.ts',
    ]);
    const setActiveId = renderer.match(/function setActiveId\(next: string \| undefined\): void \{[\s\S]*?\n  \}/);
    const refreshSessions = renderer.match(/async function refreshSessions\(\)(?:: Promise<SessionSummary\[]>)? \{[\s\S]*?\n  \}/);
    const bootstrapSessions = renderer.match(/async function bootstrapSessions\(\) \{[\s\S]*?\n  \}/);

    assert.ok(setActiveId, 'renderer must route active session changes through a ref-synchronized setter');
    assert.match(setActiveId[0], /activeIdRef\.current\s*=\s*next/);
    assert.match(setActiveId[0], /setActiveIdState\(next\)/);
    assert.match(
      renderer,
      /const sessionsRef = useRef<SessionSummary\[]>\(\[\]\)/,
      'session refresh failures must preserve the last successful list instead of clearing the sidebar',
    );
    assert.ok(refreshSessions, 'refreshSessions() must exist');
    assert.doesNotMatch(
      refreshSessions[0],
      /setActiveId\(/,
      'refreshSessions() must stay a pure data refresh; background session events must not change selection',
    );
    assert.doesNotMatch(
      refreshSessions[0],
      /if \(!activeId && next\[0\]/,
      'stale activeId closure can re-select an old session after creating a new chat and immediately sending',
    );
    assert.ok(bootstrapSessions, 'boot-only session selection helper must exist');
    assert.match(
      bootstrapSessions[0],
      /const next = await refreshSessions\(\)/,
      'bootstrapSessions() should reuse refreshSessions() for the list pull',
    );
    assert.match(
      bootstrapSessions[0],
      /bootstrapSelectionLease\.reconcile\(collapseSessionRevisions\(next\)\);[\s\S]*bootstrapSelectionLease\.release\(\)/,
      'the fallback bootstrap must share and then release the session owner\'s selection lease',
    );
    assert.match(
      renderer,
      // useLayoutEffect allowed: the snapshot seed moved to a layout
      // effect so users with history don't get a one-frame empty-state
      // flash on startup (the seed must commit before paint).
      /use(?:Layout)?Effect\(\(\) => \{[\s\S]*?void bootstrapSessions\(\)/,
      'initial mount must use the boot-only selector instead of putting selection side effects inside refreshSessions()',
    );
    assert.doesNotMatch(
      renderer,
      /use(?:Layout)?Effect\(\(\) => \{[\s\S]{0,120}?void refreshSessions\(\)/,
      'initial mount should call bootstrapSessions(), not raw refreshSessions(), for boot-only selection',
    );
    const modeSessionHandler = renderer.match(
      /async function startModeSession\([\s\S]*?\): Promise<boolean> \{[\s\S]*?\n  async function handleExpertTeamStart/,
    );
    assert.ok(modeSessionHandler, 'startModeSession() must exist');
    assert.match(
      renderer,
      /const sessionStartPendingRef = useRef\(false\)/,
      'starting a mode session must use a ref-backed pending gate so same-frame double submit cannot start two sessions',
    );
    assert.match(
      modeSessionHandler[0],
      /if \(sessionStartPendingRef\.current\) return false;[\s\S]*?sessionStartPendingRef\.current = true/,
      'starting a mode session must synchronously reject while another start call is in flight',
    );
    assert.match(
      modeSessionHandler[0],
      /const owner = captureComposerImportOwner\(\);[\s\S]*sessionStartPendingRef\.current = true/,
      'the launching shell surface must be captured before async session creation',
    );
    assert.match(
      modeSessionHandler[0],
      /if \(isShellSurfaceOwnerActive\(owner\)\) \{[\s\S]*openSessionInChat\(session\.id\);[\s\S]*\}[\s\S]*await refreshSessions\(\)/,
      'the new session must only be opened if the launching shell surface is still active',
    );
    assert.doesNotMatch(
      modeSessionHandler[0],
      /await refreshSessions\(\)[\s\S]*?setActiveId\(session\.id\)/,
      'refreshing before selecting the new session can briefly select an older session',
    );
    assert.doesNotMatch(
      modeSessionHandler[0],
      /setActiveId\(session\.id\)/,
      'a mode session can be launched from non-chat modules, so raw setActiveId would leave the new session hidden',
    );
    assert.match(
      modeSessionHandler[0],
      /return true;/,
      'a successful start must report success so the caller knows the session exists',
    );
    // #1433: how the catch CLASSIFIES the error (workspace / readiness /
    // unclassified) is asserted behaviorally in
    // app-shell-session-start-actions.test.ts, which rejects with each of
    // the three and checks what actually happens. A source regex cannot
    // tell them apart — `[\s\S]*` does not express nesting, so it would
    // pass with the branches swapped.
    assert.match(
      modeSessionHandler[0],
      /if \(isShellSurfaceOwnerActive\(owner\)\) \{[\s\S]*toastApi\.error\([\s\S]*copy\.sessionStartFailedTitle,[\s\S]*localizedShellErrorMessage\(error, copy\.sessionStartFailedFallback, uiLocale\),[\s\S]*\);[\s\S]*\}[\s\S]*?return false;/,
      'thrown failures should use the locale-aware generalized fallback only while the launching surface is still active',
    );
    assert.doesNotMatch(modeSessionHandler[0], /toastApi\.error\('开始对话失败'/);
    assert.match(
      modeSessionHandler[0],
      /finally \{\s*sessionStartPendingRef\.current = false;\s*\}/,
      'the pending ref must be cleared in finally — nothing else mirrors it, so a leaked lock would wedge the entry point',
    );
  });

  it('reconciles the first mounted onboarding pull after the pre-mount snapshot seed', async () => {
    const renderer = await readRendererShellSource('app-shell.tsx');
    const onboardingSnapshotHook = await readFile(
      fileURLToPath(new URL('../../../src/renderer/use-onboarding-snapshot.ts', import.meta.url)),
      'utf8',
    );

    assert.match(
      onboardingSnapshotHook,
      /firstMountedSnapshot:\s*OnboardingSnapshot \| null/,
      'the snapshot owner must latch the first successful mounted pull separately from the pre-mount seed',
    );
    assert.match(
      renderer,
      /snapshot = onboarding\.firstMountedSnapshot/,
      'AppShell must consume the latched mounted snapshot instead of inferring it from a cumulative generation',
    );
    assert.doesNotMatch(
      renderer,
      /const seededRef = useRef\(false\)/,
      'a one-shot seed drops a newer snapshot returned by the first mounted pull',
    );
    assert.match(
      renderer,
      /const next = seedSessions\(snapshot\.sessions\)/,
      'the mounted pull must replace the session owner even when the latest list is empty',
    );
    assert.match(
      renderer,
      /setConnections\(snapshot\.connections\)/,
      'the mounted pull must replace the connection owner even when the latest list is empty',
    );
  });

  it('keeps normal Composer first-send visible in the newly created session', async () => {
    const renderer = await readRendererShellSources([
      'app-shell-chat-actions.ts',
      'model-connection-errors.ts',
      'app-shell.tsx',
    ]);
    const sendBlock = renderer.match(
      /async function send\([\s\S]*?\n  async function respondToSandboxBoundary/,
    )?.[0] ?? '';
    const newSessionBranch = sendBlock.match(/if \(!initialSessionId\) \{[\s\S]*?return true;/)?.[0] ?? '';
    const existingSessionBranch = sendBlock.match(/const sessionId = initialSessionId;[\s\S]*?return true;/)?.[0] ?? '';
    const refreshUntilTurn = renderer.match(
      /async function refreshMessagesUntilTurn\(sessionId: string, turnId: string\): Promise<void> \{[\s\S]*?\n  \}/,
    )?.[0] ?? '';

    assert.match(sendBlock, /const initialSessionId = activeIdRef\.current;/);
    assert.doesNotMatch(
      sendBlock,
      /if \(!activeId\)|const sessionId = activeId;/,
      'normal Composer send must branch from activeIdRef.current, not stale React state after clicking New Chat',
    );
    assert.match(sendBlock, /const turnId = crypto\.randomUUID\(\)/);
    assert.match(
      newSessionBranch,
      /upsertSessionSummary\(session\)[\s\S]*window\.maka\.sessions\.send\(session\.id, \{\s*type: 'send',\s*turnId,\s*text,[\s\S]*if \(newChatOwner && isNewChatSendSurfaceActive\(newChatOwner\)\) \{[\s\S]*setNavSelection\(\{ section: 'sessions', filter: 'chats' \}\)[\s\S]*setActiveId\(session\.id\)[\s\S]*showOptimisticUserMessage\([\s\S]*session\.id,[\s\S]*turnId,[\s\S]*skillInvocationDisplayText\(text, sendResult\.skillInvocation\),[\s\S]*sendResult\.attachments,[\s\S]*\{[\s\S]*replaceCurrentMessages: true,[\s\S]*\}[\s\S]*\)[\s\S]*\}[\s\S]*if \(activeIdRef\.current === session\.id\) \{[\s\S]*refreshMessagesUntilTurn\(session\.id, turnId\)[\s\S]*\}[\s\S]*refreshSessions\(\)/,
      'normal Composer first-send must switch/show the new user turn only while the empty-chat surface still owns the async continuation',
    );
    assert.doesNotMatch(
      newSessionBranch,
      /setMessages\(\[\]\)/,
      'normal Composer first-send must not leave the newly created chat blank while waiting for storage refresh',
    );
    assert.doesNotMatch(
      newSessionBranch,
      /await refreshSessions\(\)[\s\S]*window\.maka\.sessions\.send\(session\.id/,
      'refreshing the sidebar before sending leaves the current chat surface dependent on a later event-stream race',
    );
    assert.match(
      existingSessionBranch,
      /window\.maka\.sessions\.send\(sessionId, \{\s*type: 'send',\s*turnId,\s*text,[\s\S]*showOptimisticUserMessage\([\s\S]*sessionId,[\s\S]*turnId,[\s\S]*skillInvocationDisplayText\(text, sendResult\.skillInvocation\),[\s\S]*sendResult\.attachments,[\s\S]*\{[\s\S]*\}[\s\S]*\)[\s\S]*refreshMessagesUntilTurn\(sessionId, turnId\)/,
      'existing sessions should also show the user turn immediately before waiting for persisted storage',
    );
    assert.match(
      sendBlock,
      /catch \(error\) \{[\s\S]*removeOptimisticUserMessage\(optimisticSessionId, optimisticTurnId\)[\s\S]*toastApi\.error\(copy\.sendFailedTitle, localizedShellErrorMessage\(error, copy\.sendFailedFallback, uiLocale\)\)/,
      'send readiness failures must remove the optimistic user turn instead of leaving a fake message behind',
    );
    assert.match(
      sendBlock,
      /if \(!sendStillOwnsCurrentSurface\) return false;[\s\S]*if \(isNoRealConnectionError\(error\)\) \{[\s\S]*const reason = noRealConnectionReasonFromError\(error\);[\s\S]*showModelSetupToast\(noRealConnectionSetupDescription\(reason, uiLocale\), reason\);[\s\S]*\} else if \(isSessionWorkspaceUnavailableError\(error\)\)[\s\S]*else \{[\s\S]*toastApi\.error\(copy\.sendFailedTitle, localizedShellErrorMessage\(error, copy\.sendFailedFallback, uiLocale\)\)/,
      'both model-setup feedback and generic send-failure toast must be guarded by the active-session owner check',
    );
    assert.doesNotMatch(
      sendBlock,
      /showModelSetupToast\(cleanErrorMessage\(error\), noRealConnectionReasonFromError\(error\)\)/,
      'model-setup send failures must not expose the cleaned raw exception body as visible copy',
    );
    assert.doesNotMatch(
      sendBlock,
      /toastApi\.error\('发送失败', cleanErrorMessage\(error\)\)/,
      'generic send failure feedback must not expose raw IPC/provider/storage details',
    );
    assert.match(
      renderer,
      /function noRealConnectionSetupDescription\(reason: string \| undefined, locale: UiLocale = 'zh'\): string \{[\s\S]*getDesktopConversationCopy\(locale\)\.model/,
      'model-setup send failures should use the shared reason-driven copy instead of backend exception text',
    );
    const modelSetupToast = renderer.match(/function showModelSetupToast\(description: string, reason\?: string\) \{[\s\S]*?\n  \}/)?.[0] ?? '';
    assert.match(
      modelSetupToast,
      /label: shellCopy\.openModelSettings[\s\S]*onClick: \(\) => openSettingsSection\('models'\)[\s\S]*openSettingsSection\('models'\)/,
      'model-setup feedback must land on Settings · Models, not the last-opened Settings tab',
    );
    assert.doesNotMatch(
      modelSetupToast,
      /onClick: openSettings|openSettings\(\);/,
      'model-setup feedback should not only open Settings because that can restore an unrelated previous section',
    );
    assert.match(
      refreshUntilTurn,
      /readMessages\(sessionId\)[\s\S]*if \(activeIdRef\.current !== sessionId\) return;[\s\S]*hasSentUserTurn = next\.some\(\(message\) => message\.type === 'user' && message\.turnId === turnId\)[\s\S]*if \(hasSentUserTurn\) \{[\s\S]*setMessages\(next\)/,
      'the visible-message wait must be tied to the exact turnId sent by the Composer',
    );
    assert.match(
      refreshUntilTurn,
      /USER_MESSAGE_VISIBLE_TIMEOUT_MS[\s\S]*USER_MESSAGE_VISIBLE_POLL_MS[\s\S]*refreshMessages\(sessionId\)/,
      'the wait must be bounded and fall back to the normal refresh path',
    );
  });
});
