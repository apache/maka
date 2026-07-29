/**
 * Tests for SessionStatus + SessionBlockedReason presentation helpers
 * (PR109b).
 *
 * Lock down the two contracts @kenji called out:
 *  - blocked-reason copy must never expose the enum identifier
 *  - status tone matrix follows the design-system tokens
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import {
  SANDBOX_BOUNDARY_RESTART_CLOSURE_CLASS,
  SESSION_BLOCKED_REASONS,
  SESSION_STATUSES,
} from '@maka/core';
import { readRendererShellCombinedSource } from './renderer-shell-source-helpers.js';
import { renderSessionListPanel } from './session-list-render-helpers.js';
import {
  deriveFailedTurnRecovery,
  describeBlockedReason,
  describeTurnErrorClass,
  presentSessionStatus,
  sessionStatusAriaLabel,
} from '../../renderer/session-status-presentation.js';

const REPO_ROOT = resolve(process.cwd(), '..', '..');

describe('presentSessionStatus', () => {
  it('covers every SessionStatus enum value', () => {
    for (const status of SESSION_STATUSES) {
      const presentation = presentSessionStatus(status);
      assert.ok(presentation.label, `${status} should have a label`);
      assert.ok(presentation.tone, `${status} should have a tone`);
    }
  });

  it('labels are Chinese (no English fallback)', () => {
    for (const status of SESSION_STATUSES) {
      const presentation = presentSessionStatus(status);
      assert.match(presentation.label, /[一-鿿]/, `${status} label should contain Chinese chars`);
      assert.doesNotMatch(presentation.label, /[a-zA-Z]/, `${status} label should have no Latin letters`);
    }
  });

  it('terminal states (archived, aborted) are not interactive', () => {
    assert.equal(presentSessionStatus('archived').interactive, false);
    assert.equal(presentSessionStatus('aborted').interactive, false);
  });

  it('working states (active, running, etc.) are interactive', () => {
    for (const status of ['active', 'running', 'waiting_for_user', 'blocked', 'review', 'done'] as const) {
      assert.equal(presentSessionStatus(status).interactive, true, `${status} should be interactive`);
    }
  });

  it('tones map to a small closed vocabulary', () => {
    const allowedTones = new Set(['accent', 'warning', 'destructive', 'info', 'success', 'muted', 'neutral']);
    for (const status of SESSION_STATUSES) {
      const tone = presentSessionStatus(status).tone;
      assert.ok(allowedTones.has(tone), `${status} tone ${tone} not in allowed set`);
    }
  });

  it('blocked is warning (recoverable, not a hard failure)', () => {
    assert.equal(presentSessionStatus('blocked').tone, 'warning');
  });

  it('done is success', () => {
    assert.equal(presentSessionStatus('done').tone, 'success');
  });
});

describe('describeBlockedReason (@kenji generalized copy contract)', () => {
  it('covers every SessionBlockedReason enum value', () => {
    for (const reason of SESSION_BLOCKED_REASONS) {
      const text = describeBlockedReason(reason);
      assert.ok(text, `${reason} should have copy`);
    }
  });

  it('NEVER returns the raw enum identifier as the label', () => {
    for (const reason of SESSION_BLOCKED_REASONS) {
      const text = describeBlockedReason(reason);
      // Each enum identifier must not appear literally in the copy
      assert.doesNotMatch(text, new RegExp(reason), `copy "${text}" leaks enum identifier ${reason}`);
    }
  });

  it('all blocked copy is Chinese', () => {
    for (const reason of SESSION_BLOCKED_REASONS) {
      const text = describeBlockedReason(reason);
      assert.match(text, /[一-鿿]/, `"${text}" should contain Chinese chars`);
      assert.doesNotMatch(text, /[a-zA-Z]/, `"${text}" should have no Latin letters`);
    }
  });

  it('falls back to "unknown" copy when reason is undefined', () => {
    const fallback = describeBlockedReason(undefined);
    assert.equal(fallback, describeBlockedReason('unknown'));
  });

  it('NO_REAL_CONNECTION maps to user-facing model-connection phrasing', () => {
    const text = describeBlockedReason('NO_REAL_CONNECTION');
    assert.equal(text, '等待配置可用模型连接');
    assert.doesNotMatch(text, /缺少可用模型连接/);
  });

  it('keeps the shared UI blocked-reason tooltip in sync with actionable waiting copy', async () => {
    const markup = renderSessionListPanel({
      session: {
        status: 'blocked',
        blockedReason: 'NO_REAL_CONNECTION',
      },
    });

    assert.match(markup, /等待配置可用模型连接/);
    assert.doesNotMatch(markup, /缺少可用模型连接/);
  });

  it('auth maps to re-login phrasing', () => {
    assert.match(describeBlockedReason('auth'), /登录|登陆/);
  });
});

describe('sessionStatusAriaLabel', () => {
  it('non-blocked status returns just the status label', () => {
    assert.equal(sessionStatusAriaLabel('running'), '进行中');
    assert.equal(sessionStatusAriaLabel('active'), '可继续');
  });

  it('blocked status combines status label + blocked reason', () => {
    const text = sessionStatusAriaLabel('blocked', 'auth');
    assert.match(text, /需要处理/);
    assert.match(text, /登录|登陆/);
    // Separator stays consistent
    assert.match(text, / · /);
  });

  it('blocked without reason falls back to actionable recovery copy', () => {
    const text = sessionStatusAriaLabel('blocked');
    assert.match(text, /需要处理/);
    assert.match(text, /运行中断，可重试/);
    assert.doesNotMatch(text, /未知阻塞/);
  });
});

describe('permission mode transition guard copy', () => {
  // PR-MOVE-PERMISSION-MODE (2026-06-23): the permission-mode picker no
  // longer lives in the chat header — it moved into the composer's
  // left-controls dropdown. Disabled-reason copy is now computed at the
  // <Composer/> call site in main.tsx and passed down via the
  // `permissionModeDisabledReason` prop, so the gating contract pins
  // main.tsx, not components.tsx.
  it('passes a disabled-reason for running, waiting, streaming, and pending sessions', async () => {
    const renderer = await readRendererShellCombinedSource();
    const composerReasonBlock = renderer.match(/permissionModeDisabledReason=\{[\s\S]*?\}\s*onPermissionModeChange/)?.[0] ?? '';

    assert.ok(composerReasonBlock, 'main.tsx must pass permissionModeDisabledReason to the <Composer/>');
    assert.match(composerReasonBlock, /pendingPermissionModeBySession\[activeId\] === true/);
    assert.match(composerReasonBlock, /shellCopy\.permissionModeChanging/);
    assert.match(composerReasonBlock, /activeStreamingLive/);
    assert.doesNotMatch(composerReasonBlock, /activeStreaming\.length > 0/);
    assert.match(composerReasonBlock, /shellCopy\.permissionModeStreaming/);
    assert.match(composerReasonBlock, /activeSessionForView\?\.status === 'running'/);
    assert.match(composerReasonBlock, /shellCopy\.permissionModeRunning/);
    assert.match(composerReasonBlock, /activeSessionForView\?\.status === 'waiting_for_user'/);
    assert.match(composerReasonBlock, /shellCopy\.permissionModeWaiting/);
  });

  it('composer permission picker disables itself when the composer is disabled, pending, or a disabledReason is present', async () => {
    // The picker must respect the composer's own `disabled` state (the
    // interaction-wait freeze, driven by `Boolean(activeInteraction)` in
    // app-shell.tsx), not only the separately-computed `permissionModeDisabledReason`
    // (which keys off `status === 'waiting_for_user'`). The two are NOT fully
    // coupled: a pending permission can set `props.disabled` before the session
    // status flips to `waiting_for_user`, leaving a window where the composer is
    // frozen (permission-hint pulsing, attach button + textarea disabled) but
    // the mode picker stays clickable. CDP-verified on the `permission-destructive`
    // fixture: before this guard the Select trigger read `disabled=false`,
    // `pointer-events:auto`; after, `disabled=true`, `pointer-events:none`.
    const ui = await readFile(join(REPO_ROOT, 'packages/ui/src/composer.tsx'), 'utf8');
    const dropdownBlock = ui.match(/props\.onPermissionModeChange \? \([\s\S]*?\) : null/)?.[0] ?? '';

    assert.ok(dropdownBlock, 'composer.tsx must render a PermissionModeSelect picker');
    assert.match(dropdownBlock, /<PermissionModeSelect/);
    assert.match(dropdownBlock, /disabled=\{props\.disabled \|\| props\.permissionModePending === true \|\| Boolean\(props\.permissionModeDisabledReason\)\}/);
    assert.match(dropdownBlock, /disabledReason=\{props\.permissionModeDisabledReason\}/);
  });

  it('composer permission picker uses the shared Base UI Select', async () => {
    const ui = await readFile(join(REPO_ROOT, 'packages/ui/src/composer.tsx'), 'utf8');
    const menuModule = await readFile(join(REPO_ROOT, 'packages/ui/src/permission-mode-menu.tsx'), 'utf8');

    // Three-mode picker: explore is retired from the picker entirely
    // (read-only mode has no useful runtime toggle for normal chat —
    // Deep-Research sessions set it internally). The list is DERIVED from
    // @maka/core's canonical CHAT_DEFAULT_PERMISSION_MODES (itself derived
    // from PERMISSION_MODES minus 'explore') — not a hand-copied literal
    // that can drift when a new mode is added.
    assert.match(
      menuModule,
      /export const PERMISSION_MODE_ORDER: readonly ChatDefaultPermissionMode\[\] = CHAT_DEFAULT_PERMISSION_MODES;/,
    );

    // Permission picker is Base UI Select (the correct primitive for a
    // single-value choice), not a hand-styled Menu + chip. The composer
    // renders the shared PermissionModeSelect so option markup can't drift
    // from the Settings picker; keyboard arrow/Home/End is delegated to
    // the Select primitive.
    const dropdownBlock = ui.match(/props\.onPermissionModeChange \? \([\s\S]*?\) : null/)?.[0] ?? '';
    assert.match(dropdownBlock, /<PermissionModeSelect/);
    assert.match(dropdownBlock, /activeMode=\{props\.permissionMode/);
    assert.match(dropdownBlock, /void props\.onPermissionModeChange\?\.\(mode\);/);
    assert.match(menuModule, /export function PermissionModeSelect/);
    assert.match(menuModule, /PERMISSION_MODE_ORDER\.map\(\(mode\) =>/);
  });

  it('updates the active session boundary or the new-session default and scrubs failures before toast', async () => {
    const renderer = await readRendererShellCombinedSource();
    const setPermissionModeBlock = renderer.match(/async function setPermissionMode[\s\S]*?async function setSessionModel/)?.[0] ?? '';

    assert.match(renderer, /const permissionModeChangeRegistry = useKeyedPendingRegistry\(\);/);
    assert.match(
      renderer,
      /pendingPermissionModeChangesRef: permissionModeChangeRegistry\.keysRef/,
      'the permission-mode-change dedup Set the setPermissionMode action guards on must be backed by the shared keyed-pending registry',
    );
    assert.match(renderer, /const sessionUi = useAppShellSessionUiState\(\);[\s\S]*setPendingPermissionModeBySession: sessionUi\.setPendingPermissionModeBySession/);
    assert.match(renderer, /const \{[\s\S]*pendingPermissionModeBySession,[\s\S]*\} = sessionUiState;/);
    assert.match(
      setPermissionModeBlock,
      /if \(mode !== 'ask' && mode !== 'bypass'\) return;[\s\S]*const sessionId = activeIdRef\.current;[\s\S]*const pendingKey = sessionId \?\? '__global_permission_mode__';[\s\S]*pendingPermissionModeChangesRef\.current\.has\(pendingKey\)/,
      'Boundary changes must accept only Auto or Bypass, capture the active session id, and gate duplicate active/global saves',
    );
    assert.match(
      setPermissionModeBlock,
      /mode === 'bypass'[\s\S]*toastApi\.confirm\(\{[\s\S]*destructive: true/,
      'Bypass must require a destructive confirmation before changing the session boundary',
    );
    assert.match(setPermissionModeBlock, /pendingPermissionModeChangesRef\.current\.add\(pendingKey\);[\s\S]*if \(sessionId\)\s*setPendingPermissionModeBySession\(\(current\) => \(\{\s*\.\.\.current,\s*\[sessionId\]: true,?\s*\}\)\);/);
    assert.match(
      setPermissionModeBlock,
      /if \(sessionId\) \{[\s\S]*window\.maka\.sessions\.setPermissionMode\(sessionId, mode\)[\s\S]*\} else \{[\s\S]*window\.maka\.settings\.update\(\{\s*chatDefaults: \{ permissionMode: mode \},?\s*\}\)/,
      'Boundary changes must update the active session without changing the default, or update the default when no session is active',
    );
    assert.match(setPermissionModeBlock, /nextMode = next\.permissionMode === 'bypass' \? 'bypass' : 'ask';/);
    assert.match(setPermissionModeBlock, /nextMode = result\.settings\.chatDefaults\.permissionMode;/);
    assert.match(setPermissionModeBlock, /setDefaultPermissionMode\(nextMode\);/);
    assert.match(
      setPermissionModeBlock,
      /setSessions\(\(prev\) =>\s*prev\.map\(\(session\) => \(session\.id === sessionId \? next : session\)\),?\s*\);/,
    );
    assert.match(
      setPermissionModeBlock,
      /toastApi\.success\(\s*copy\.permissionSwitched\(copy\.permissionLabels\[nextMode\]\),\s*copy\.permissionDescriptions\[nextMode\],?\s*\);/,
    );
    assert.match(setPermissionModeBlock, /await refreshSessions\(\)/, 'Permission mode changes must still refresh the sidebar/session list');
    assert.match(
      setPermissionModeBlock,
      /catch \(error\) \{[\s\S]*toastApi\.error\(copy\.permissionFailedTitle, localizedShellErrorMessage\(error, copy\.permissionFallback, uiLocale\)\)/,
      'Permission mode failures must use shared Chinese error classification/redaction before reaching toast',
    );
    assert.match(setPermissionModeBlock, /finally \{[\s\S]*pendingPermissionModeChangesRef\.current\.delete\(pendingKey\);[\s\S]*\}/);
    assert.match(setPermissionModeBlock, /if \(sessionId\) setPendingPermissionModeBySession\(\(current\) => omitSessionKey\(current, sessionId\)\);/);
    assert.match(renderer, /permissionModePending=\{activeId \? pendingPermissionModeBySession\[activeId\] === true : false\}/);
    assert.match(
      renderer,
      /onPermissionModeChange=\{\s*activeBoundarySurface\.localInteractionAvailable\s*\? \(mode\) => setPermissionMode\(mode\)\s*: undefined\s*\}/,
    );
    assert.match(
      renderer,
      /onboardingComposerHidden=\{\s*onboardingComposerHidden \|\| !activeBoundarySurface\.localInteractionAvailable\s*\}/,
    );
    assert.doesNotMatch(renderer, /onPermissionModeChange=\{\(mode\) => void setPermissionMode\(mode\)\}/);
    assert.doesNotMatch(
      setPermissionModeBlock,
      /error instanceof Error \? error\.message : String\(error\)/,
      'Permission mode failures must not render raw thrown Error.message',
    );
    assert.doesNotMatch(setPermissionModeBlock, /setPendingNewChatPermissionMode\(mode\)/);
    assert.doesNotMatch(setPermissionModeBlock, /window\.maka\.sessions\.setPermissionMode\(activeId, mode\)/);
  });

  it('uses the configured default permission mode without one-shot new-chat state', async () => {
    const renderer = await readRendererShellCombinedSource();
    const sendBlock = renderer.match(/async function send\([\s\S]*?\n  async function respondToSandboxBoundary/)?.[0] ?? '';

    assert.doesNotMatch(
      renderer,
      /const \[pendingNewChatPermissionMode, setPendingNewChatPermissionMode\] = useState<PermissionMode \| null>\(null\)/,
      'The shell must not keep renderer-only permission mode state while no session is active',
    );
    assert.doesNotMatch(
      sendBlock,
      /\.\.\.\(pendingNewChatPermissionMode \? \{ permissionMode: pendingNewChatPermissionMode \} : \{\}\)/,
      'New session creation must omit permissionMode so main.ts resolves the configured Settings -> General default as the single authority',
    );
    assert.doesNotMatch(
      sendBlock,
      /setPendingNewChatPermissionMode\(null\)/,
      'Successful first send must not clear a removed renderer-only permission mode pick',
    );
    assert.match(
      renderer,
      /permissionMode=\{activePermissionMode\}/,
      'The Composer mode chip must show the active session boundary and use the configured default only before a session exists',
    );
    assert.match(renderer, /setDefaultPermissionMode\(next\.chatDefaults\?\.permissionMode \?\? 'ask'\)/);
    assert.match(
      renderer,
      /permissionModeDisabledReason=\{[\s\S]*activeId && activeSessionForView\?\.status === 'running'/,
      'No-session default permission changes must stay enabled while running/waiting guards apply only to existing sessions',
    );
  });
});

describe('describeTurnErrorClass (PR109e-d @kenji gate #3)', () => {
  it('returns Chinese label for known timeout class', () => {
    assert.match(describeTurnErrorClass('timeout'), /超时/);
  });

  it('returns Chinese label for known auth / 401 / 403 classes', () => {
    for (const cls of ['auth', '401', '403']) {
      assert.match(describeTurnErrorClass(cls), /鉴权/, `${cls} should map to 鉴权失败`);
    }
  });

  it('returns Chinese label for rate_limit / rate_exceeded', () => {
    for (const cls of ['rate_limit', 'rate_exceeded']) {
      assert.match(describeTurnErrorClass(cls), /速率/, `${cls} should map to rate-limit phrasing`);
    }
  });

  it('returns Chinese label for network / fetch / econn classes', () => {
    for (const cls of ['network', 'fetch_failed', 'econnrefused']) {
      assert.match(describeTurnErrorClass(cls), /网络/, `${cls} should map to network error`);
    }
  });

  it('returns Chinese label for provider_unavailable / 5xx codes', () => {
    for (const cls of ['provider_unavailable', '500', '503']) {
      const text = describeTurnErrorClass(cls);
      assert.equal(text, '模型服务返回错误', `${cls} should map to provider error copy`);
      assert.doesNotMatch(text, /暂不可用/);
    }
  });

  it('returns specific labels for context overflow and provider billing', () => {
    assert.equal(describeTurnErrorClass('context_overflow'), '上下文窗口已超出限制');
    assert.equal(describeTurnErrorClass('provider_billing'), '模型服务计费受限');
  });

  it('returns Chinese label for tool_failed', () => {
    assert.match(describeTurnErrorClass('tool_failed'), /工具/);
  });

  it('distinguishes a tool step cap from a failed tool call', () => {
    assert.equal(describeTurnErrorClass('tool_step_cap_reached'), '达到工具步骤上限');
    assert.deepEqual(deriveFailedTurnRecovery({
      errorClass: 'tool_step_cap_reached',
      partialOutputRetained: true,
      toolActivityCount: 1,
      erroredToolCount: 0,
    }), {
      action: 'continue',
      label: '任务可能尚未完成，可以继续',
    });
  });

  it('returns a specific Chinese label for app restart recovery', () => {
    assert.equal(describeTurnErrorClass('app_restarted'), '本地应用重启，上一轮没有完成');
  });

  it('explains a sandbox boundary request the host restart closed (#1612)', () => {
    // The prompt the user never answered must read as a named closure, not as
    // a bare restart and not as the generic "等待权限确认" catch-all.
    const text = describeTurnErrorClass(SANDBOX_BOUNDARY_RESTART_CLOSURE_CLASS);
    assert.equal(text, '本地应用重启，等待确认的「允许访问工作区以外的内容」请求已按拒绝关闭');
    assert.notEqual(text, describeTurnErrorClass('app_restarted'));
    assert.notEqual(text, describeTurnErrorClass('permission_required'));
    assert.doesNotMatch(text, new RegExp(SANDBOX_BOUNDARY_RESTART_CLOSURE_CLASS));
    assert.equal(
      describeTurnErrorClass(SANDBOX_BOUNDARY_RESTART_CLOSURE_CLASS.toUpperCase()),
      text,
    );
  });

  it('falls back to "未知错误" for unrecognized classes', () => {
    for (const cls of [undefined, 'xyz', 'something_new', '']) {
      assert.match(describeTurnErrorClass(cls), /未知/, `${JSON.stringify(cls)} should fall back to 未知错误`);
    }
  });

  it('NEVER returns the raw enum identifier verbatim (Chinese-only)', () => {
    // Per @kenji review: UI must not display the raw `errorClass`.
    for (const cls of ['timeout', 'auth', 'rate_limit', 'network', 'tool_failed', 'provider_unavailable']) {
      const text = describeTurnErrorClass(cls);
      assert.match(text, /[一-鿿]/, `${cls} should produce Chinese text`);
      assert.doesNotMatch(text, new RegExp(`\\b${cls}\\b`), `${cls} copy "${text}" leaks enum identifier`);
    }
  });

  it('is case-insensitive', () => {
    assert.equal(describeTurnErrorClass('TIMEOUT'), describeTurnErrorClass('timeout'));
    assert.equal(describeTurnErrorClass('Network'), describeTurnErrorClass('network'));
  });
});

describe('deriveFailedTurnRecovery (PawWork run-incident lite)', () => {
  it('routes app restart failures to safe resume instead of blind retry', () => {
    const result = deriveFailedTurnRecovery({
      errorClass: 'app_restarted',
      partialOutputRetained: false,
      toolActivityCount: 0,
      erroredToolCount: 0,
    });

    assert.equal(result.action, 'continue');
    assert.match(result.label, /安全恢复/);
  });

  it('offers retry, not resume, for a boundary request closed by the restart (#1612)', () => {
    const result = deriveFailedTurnRecovery({
      errorClass: SANDBOX_BOUNDARY_RESTART_CLOSURE_CLASS,
      partialOutputRetained: false,
      toolActivityCount: 0,
      erroredToolCount: 0,
    });

    assert.equal(result.action, 'retry');
    assert.match(result.label, /重试本轮/);
  });

  it('asks the user to inspect tool output when a tool failed', () => {
    const result = deriveFailedTurnRecovery({
      errorClass: 'tool_failed',
      partialOutputRetained: false,
      toolActivityCount: 1,
      erroredToolCount: 1,
    });
    assert.equal(result.action, 'inspect_tool');
    assert.match(result.label, /工具|结果/);
  });

  it('routes auth failures to connection/login checks before retrying', () => {
    for (const cls of ['auth', '401', '403']) {
      const result = deriveFailedTurnRecovery({
        errorClass: cls,
        partialOutputRetained: false,
        toolActivityCount: 0,
        erroredToolCount: 0,
      });
      assert.equal(result.action, 'check_connection');
      assert.match(result.label, /模型|连接|登录/);
    }
  });

  it('routes provider billing failures to connection/account checks before retrying', () => {
    const result = deriveFailedTurnRecovery({
      errorClass: 'provider_billing',
      partialOutputRetained: false,
      toolActivityCount: 0,
      erroredToolCount: 0,
    });
    assert.equal(result.action, 'check_connection');
    assert.match(result.label, /模型|连接|登录/);
  });

  it('offers continue when partial output was retained and no tool failed', () => {
    const result = deriveFailedTurnRecovery({
      errorClass: 'timeout',
      partialOutputRetained: true,
      toolActivityCount: 0,
      erroredToolCount: 0,
    });
    assert.equal(result.action, 'continue');
    assert.match(result.label, /保留|继续/);
  });

  it('offers direct retry only when no side-effect or partial-output evidence exists', () => {
    const result = deriveFailedTurnRecovery({
      errorClass: 'timeout',
      partialOutputRetained: false,
      toolActivityCount: 0,
      erroredToolCount: 0,
    });
    assert.equal(result.action, 'retry');
    assert.match(result.label, /重试/);
  });

  it('keeps all recovery labels Chinese and does not echo raw error classes', () => {
    for (const errorClass of ['timeout', 'auth', 'tool_failed', 'provider_unavailable']) {
      const text = deriveFailedTurnRecovery({
        errorClass,
        partialOutputRetained: errorClass === 'provider_unavailable',
        toolActivityCount: errorClass === 'tool_failed' ? 1 : 0,
        erroredToolCount: errorClass === 'tool_failed' ? 1 : 0,
      }).label;
      assert.match(text, /[一-鿿]/);
      assert.ok(!text.includes(errorClass), `${errorClass} leaked into "${text}"`);
    }
  });
});
