/**
 * Source contract for active-session message lifecycle.
 *
 * The chat body must not show messages from the previous session while the
 * newly selected session's message read is still in flight. Once a session is
 * already active, transient refresh failures must preserve the visible log
 * instead of blanking the conversation.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { readRendererShellSources } from './renderer-shell-source-helpers.js';

describe('active session message lifecycle contract', () => {
  it('clears stale messages before reading the selected session and guards late reads', async () => {
    const src = await readRendererShellSources([
      'app-shell-effects.ts',
      'app-shell-chat-actions.ts',
      'app-shell.tsx',
      'app-shell-copy.ts',
      'use-app-shell-session-workspace.ts',
    ]);
    const ui = await readFile(join(process.cwd(), '..', '..', 'packages', 'ui', 'src', 'chat-view.tsx'), 'utf8');
    const activeSessionEffect = src.match(/useLayoutEffect\(\(\) => \{\s*if \(!activeId\) return;[\s\S]*?readMessages\(activeId\)[\s\S]*?\}, \[activeId\]\);/)?.[0] ?? '';
    const activeReadSuccess = src.match(/const applyReadMessages = useEffectEvent\([\s\S]*?const applyReadError = useEffectEvent/)?.[0] ?? '';
    const activeReadCatch = src.match(/const applyReadError = useEffectEvent[\s\S]*?const handleSessionEvent = useEffectEvent/)?.[0] ?? '';
    const refreshMessages = src.match(/async function refreshMessages\(sessionId: string[\s\S]*?\n  \}/)?.[0] ?? '';
    const retryMessages = src.match(/async function retryMessages\(sessionId: string\) \{[\s\S]*?\n  \}/)?.[0] ?? '';

    assert.match(
      src,
      /const \[messageLoadPending, setMessageLoadPending\] = useState\(false\);/,
      'desktop shell must track the selected session message-read pending state',
    );
    assert.match(
      src,
      /const activeMessageLoading = Boolean\(activeId && messageLoadPending\);/,
      'desktop shell must distinguish message-read loading from a genuinely empty session',
    );
    assert.match(
      src,
      /function setActiveId\(next: string \| undefined\): void \{[\s\S]*else if \(next !== activeIdRef\.current\) \{[\s\S]*setMessages\(\[\]\);[\s\S]*setMessageLoadPending\(true\)/,
      'setActiveId must clear stale messages and mark the read pending only when the active session actually changes, in the same React batch as the switch so the empty hero does not flash',
    );
    assert.doesNotMatch(
      activeSessionEffect,
      /const subscribedAt = Date\.now\(\);[\s\S]*setMessages\(\[\]\)/,
      'the active-session read-start effect must not clear messages; a layout-effect clear can wipe an optimistic user message for a brand-new session before the first paint',
    );
    assert.match(
      src,
      /setActiveId\(session\.id\);[\s\S]*?showOptimisticUserMessage\([\s\S]*?session\.id,[\s\S]*?turnId,[\s\S]*?skillInvocationDisplayText\(text, sendResult\.skillInvocation\),[\s\S]*?sendResult\.attachments,[\s\S]*?\{[\s\S]*?replaceCurrentMessages: true,[\s\S]*?\}[\s\S]*?\)/,
      'the new-session-then-send path lets the optimistic user message overwrite the setActiveId clear in the same React batch, so the first message survives until the real read lands',
    );
    assert.match(
      activeReadSuccess,
      /if \(!isDisposed\(\) && options\.activeIdRef\.current === sessionId\) \{[\s\S]*options\.markSessionReadLocally\(sessionId, next\);[\s\S]*if \(next\.length > 0\) options\.setMessages\(next\);[\s\S]*options\.setMessageLoadPending\(false\);[\s\S]*\}/,
      'late active-session reads skip an empty result so an in-flight optimistic user message is not blanked while the same session is still active',
    );
    assert.match(
      activeSessionEffect,
      /applyReadMessages\(activeId, next, \(\) => disposed\)/,
      'active-session reads must pass the current disposed guard into the late-read effect event',
    );
    assert.match(
      activeReadCatch,
      /const message = messageReadErrorMessage\(error, options\.uiLocale\);/,
      'message read failures should preserve trusted diagnostics before falling back to generalized copy',
    );
    assert.match(
      activeReadCatch,
      /const message = messageReadErrorMessage\(error, options\.uiLocale\);[\s\S]*options\.setMessageLoadErrorBySession\(\(current\) => \(\{\s*\.\.\.current,\s*\[sessionId\]: message,?\s*\}\)\);[\s\S]*options\.setMessageLoadPending\(false\);[\s\S]*options\.toastApi\.error\(getDesktopConversationCopy\(options\.uiLocale\)\.actions\.messageReadFailedTitle, message\)/,
      'active-session read failures must clear pending and set a visible per-session load error after stale content was cleared',
    );
    assert.doesNotMatch(activeReadCatch, /const message = cleanErrorMessage\(error\)/);
    assert.doesNotMatch(
      activeReadCatch,
      /已保留当前可见内容/,
      'the active read-failure toast must not claim visible content was preserved after the pre-read clear',
    );
    assert.doesNotMatch(
      activeReadCatch,
      /setMessages\(\[\]\)/,
      'the read-failure catch must not perform a second destructive clear; the setActiveId transition clear is the only stale-content boundary',
    );
    assert.match(
      refreshMessages,
      /try \{[\s\S]*readSettledMessages\(sessionId, options\)[\s\S]*const next = result\.messages[\s\S]*activeIdRef\.current === sessionId[\s\S]*setMessages\(next\)[\s\S]*setMessageLoadErrorBySession[\s\S]*return result\.settled;[\s\S]*\} catch \(error\) \{[\s\S]*const message = messageRefreshErrorMessage\(error, uiLocale\);[\s\S]*setMessageLoadErrorBySession\(\(current\) => \(\{\s*\.\.\.current,\s*\[sessionId\]: message,?\s*\}\)\);[\s\S]*toastApi\.error\(copy\.refreshFailedTitle, message\)/,
      'shared refreshMessages path must surface stage-specific read failures through the same per-session load error state',
    );
    assert.match(refreshMessages, /readSettledMessages\(sessionId, options\)/);
    assert.doesNotMatch(refreshMessages, /await window\.maka\.sessions\.readMessages\(sessionId\)/);
    assert.doesNotMatch(refreshMessages, /const message = cleanErrorMessage\(error\)/);
    assert.match(
      src,
      /const SESSION_READ_MESSAGES_ERROR_MARKER = 'MAKA_SESSION_READ_MESSAGES_ERROR:';[\s\S]*function messageReadErrorMessage\(error: unknown, locale: UiLocale\): string \{[\s\S]*getShellCopy\(locale\)\.errors\.messageRead[\s\S]*function messageRefreshErrorMessage\(error: unknown, locale: UiLocale\): string \{[\s\S]*getShellCopy\(locale\)\.errors\.messageRefresh[\s\S]*function sessionMessageErrorMessage\(error: unknown, fallback: string, locale: UiLocale\): string \{[\s\S]*const markerIndex = raw\.indexOf\(SESSION_READ_MESSAGES_ERROR_MARKER\);[\s\S]*localizedErrorMessage\(error, fallback, locale\)/,
      'read and refresh failures should trust only the machine marker emitted by main before falling back to generic copy',
    );
    assert.doesNotMatch(
      src,
      /TRUSTED_SESSION_MESSAGE_ERROR_PREFIXES|safeSessionMessageErrorMessage|读取进行中的对话缓存失败：|读取对话运行记录失败：|对话内容已读取，但标记已读失败：/,
      'renderer must not treat Chinese user-facing copy as the trust protocol',
    );
    assert.doesNotMatch(
      refreshMessages,
      /catch \(error\) \{[\s\S]*setMessages\(\[\]\)/,
      'background message refresh failures must preserve the visible conversation instead of blanking the chat',
    );
    assert.match(src, /const sessionUi = useAppShellSessionUiState\(\)/);
    assert.match(src, /const messageRetryPendingRef = useRef<Set<string>>\(new Set\(\)\)/);
    assert.match(src, /setMessageRetryPendingBySession: sessionUi\.setMessageRetryPendingBySession/);
    assert.match(
      src,
      /const \{[\s\S]*messageRetryPendingBySession,[\s\S]*\} = sessionUiState;/,
      'desktop shell must keep the ref-backed duplicate guard while exposing per-session retry pending state from the shell UI reducer',
    );
    assert.match(
      src,
      /function addPendingSessionAction\([\s\S]*pendingRef\.current\.has\(sessionId\)[\s\S]*pendingRef\.current\.add\(sessionId\)[\s\S]*setPendingBySession/,
      'manual message-load retry must use a ref-backed same-frame duplicate guard',
    );
    assert.match(
      retryMessages,
      /if \(!addPendingSessionAction\(sessionId, messageRetryPendingRef, setMessageRetryPendingBySession\)\) return;[\s\S]*await refreshMessages\(sessionId\);[\s\S]*finally \{[\s\S]*clearPendingSessionAction\(sessionId, messageRetryPendingRef, setMessageRetryPendingBySession\)/,
      'manual retry must clear its pending state even when refreshMessages fails',
    );
    assert.match(
      src,
      /messages=\{messages\}[\s\S]*messageLoading=\{activeMessageLoading\}[\s\S]*messageLoadError=\{activeId \? messageLoadErrorBySession\[activeId\] : undefined\}[\s\S]*messageLoadRetryPending=\{activeId \? messageRetryPendingBySession\[activeId\] === true : false\}[\s\S]*onRetryMessages=\{activeId \? \(\) => void retryMessages\(activeId\) : undefined\}/,
      'desktop shell must pass the active session load error, pending state, and guarded retry action to ChatView',
    );
    assert.doesNotMatch(
      src,
      /onRetryMessages=\{activeId \? \(\) => void refreshMessages\(activeId\) : undefined\}/,
      'manual retry must not call refreshMessages directly because that allows duplicate read IPCs',
    );
    assert.match(
      ui,
      /messageLoading\?: boolean/,
      'ChatView must accept explicit message-read loading state',
    );
    assert.match(
      ui,
      /props\.messageLoading \? null : props\.messageLoadError \? \([\s\S]*\) : props\.emptyOverride/,
      'ChatView must suppress the stale load error and the normal empty-chat hero while the selected session message read is still in flight',
    );
    assert.match(
      ui,
      /messageLoadRetryPending\?: boolean/,
      'ChatView must accept explicit message-load retry pending state',
    );
    assert.match(
      ui,
      /props\.messageLoadError \? \([\s\S]*role="alert" aria-busy=\{props\.messageLoadRetryPending \? 'true' : undefined\}[\s\S]*title=\{copy\.loadFailed\}[\s\S]*body=\{props\.messageLoadError\}[\s\S]*label: props\.messageLoadRetryPending \? copy\.loading : copy\.retryLoad[\s\S]*disabled: props\.messageLoadRetryPending/,
      'ChatView must render an explicit load-error state instead of the normal empty chat hero',
    );
  });
});
