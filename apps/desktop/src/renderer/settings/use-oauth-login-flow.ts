import { useEffect, useRef, useState } from 'react';
import { generalizedErrorMessage, generalizedErrorMessageChinese, redactSecrets } from '@maka/core/redaction';
import { type UiLocale } from '@maka/core/ui-locale';
import { useMountedRef, useToast, useUiLocale } from '@maka/ui';
import { createOneShotActionGuard, teardownPendingAuthorization } from './oauth-login-flow-guard';
import { getProviderSettingsCopy } from '../locales/settings-provider-copy';


// Shared browser-assisted OAuth login-flow controller (device-code
// polling / loopback PKCE depending on the provider).
//
// Extracted from the SubscriptionLoginModal `startLogin` flow so BOTH the
// OAuth catalog login modals (Codex / xAI / Antigravity) AND the model
// connection detail sheet's 重新登录 affordance drive the same
// getAuthUrl -> openAuthUrl -> refresh -> completeAuthorization sequence with
// one authRequestId lifecycle, one synchronous pending-action guard, and
// cancellation-on-unmount. Claude's paste-code flow is deliberately NOT
// routed through this hook -- it needs a manual authorization-code step and
// its own experimental gate, so it keeps its bespoke card.
//
// GitHub Copilot rides the same controller through the `direct` account
// flow (#1042): importing an existing GitHub login is one bridge call, so
// there is no browser handoff -- but the snapshot refresh, the one-shot
// pending-action guard, and the unmount safety are identical.

export type OAuthLoginPendingAction = 'login' | 'logout' | 'refresh';

export interface SubscriptionSnapshot {
  runtimeState:
    | 'not_logged_in'
    | 'authorizing'
    | 'authenticated'
    | 'refreshing'
    | 'refresh_failed'
    | 'storage_failed'
    | 'quota_unavailable'
    | 'provider_rejected';
  email?: string;
  plan?: string;
  status?: 'preview';
  errorMessage?: string;
}

export interface OAuthLoginFlowBridge {
  getAuthUrl(): Promise<
    { authRequestId: string; stateHint: string } | { ok: boolean; reason?: string; message: string }
  >;
  openAuthUrl(authRequestId: string): Promise<{ ok: true } | { ok: false; reason: string; message: string }>;
  completeAuthorization(authRequestId: string): Promise<{ ok: true } | { ok: false; reason: string; message: string }>;
  cancelAuthorization(authRequestId?: string): Promise<{ ok: true }>;
  getAccountState(): Promise<unknown>;
  logout(): Promise<{ ok: true } | { ok: false; reason: string; message: string }>;
}

export interface OAuthLoginFlowDisplay {
  name: string;
  shortName: string;
}

export type OAuthDirectActionResult =
  | { ok: true }
  | { ok: false; reason?: string; message: string };

/**
 * Direct-import account flow (GitHub Copilot): no browser handoff, so
 * "login" is a single bridge call. Direct mode keeps the service's original
 * UX instead of the browser-assisted copy: no logout confirm, no success toasts
 * (the refreshed snapshot IS the feedback), and every account-action
 * failure surfaces under one `<display.name> 账号操作失败` title.
 */
export interface OAuthDirectAccountFlow {
  login(): Promise<OAuthDirectActionResult>;
  refreshTokens(): Promise<OAuthDirectActionResult>;
}

export interface OAuthLoginFlowController {
  state: SubscriptionSnapshot | null;
  runtimeState: SubscriptionSnapshot['runtimeState'] | 'loading';
  isLoggedIn: boolean;
  pendingAction: OAuthLoginPendingAction | null;
  authRequestId: string | null;
  stateHint: string | null;
  errorMessage: string | null;
  actionBusy: boolean;
  startLogin(): Promise<void>;
  logout(): Promise<void>;
  refresh(): Promise<boolean>;
  // Direct account flows only (GitHub Copilot 重新验证); undefined for the
  // browser-assisted services so they cannot render a dead action.
  refreshTokens: (() => Promise<void>) | undefined;
}

export function useOAuthLoginFlow(params: {
  bridge: OAuthLoginFlowBridge;
  display: OAuthLoginFlowDisplay;
  // Fired after a successful completeAuthorization (browser handoff done).
  // The detail sheet uses it to re-probe hasSecret + reload connection status;
  // catalog modals use it to refresh both their account card and the shared
  // model connection list without waiting for the modal to close.
  onLoginSuccess?: () => void | Promise<void>;
  // When present, startLogin runs this one-shot import instead of the
  // getAuthUrl -> openAuthUrl -> completeAuthorization handoff, and the
  // controller exposes the extra `refreshTokens` action.
  direct?: OAuthDirectAccountFlow;
}): OAuthLoginFlowController {
  const { bridge, display } = params;
  const locale = useUiLocale();
  const copy = getProviderSettingsCopy(locale).oauthFlow;
  const direct = params.direct;
  const toast = useToast();
  const [state, setState] = useState<SubscriptionSnapshot | null>(null);
  const [authRequestId, setAuthRequestId] = useState<string | null>(null);
  const [stateHint, setStateHint] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<OAuthLoginPendingAction | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const pendingGuard = useRef(createOneShotActionGuard<OAuthLoginPendingAction>()).current;
  const authRequestIdRef = useRef<string | null>(null);
  const oauthLoginFlowMountedRef = useMountedRef();

  async function refresh(): Promise<boolean> {
    try {
      const next = (await bridge.getAccountState()) as SubscriptionSnapshot;
      if (!oauthLoginFlowMountedRef.current) return false;
      setState(next);
      setErrorMessage(null);
    } catch (error) {
      if (!oauthLoginFlowMountedRef.current) return false;
      const message = subscriptionActionErrorMessage(error, locale);
      toast.error(copy.refreshFailed, message);
      setErrorMessage(message);
      return false;
    }
    return true;
  }

  useEffect(() => {
    void refresh();
    return () => {
      pendingGuard.finish();
      teardownPendingAuthorization(authRequestIdRef, (id) => void bridge.cancelAuthorization(id));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function beginPendingAction(action: OAuthLoginPendingAction): boolean {
    if (!pendingGuard.begin(action)) return false;
    setPendingAction(action);
    return true;
  }

  function finishPendingAction() {
    pendingGuard.finish();
    if (oauthLoginFlowMountedRef.current) setPendingAction(null);
  }

  async function startLogin() {
    if (!beginPendingAction('login')) return;
    setErrorMessage(null);
    // Direct-import flow (GitHub Copilot): one bridge call, no authRequestId
    // lifecycle, no success toast — the refreshed snapshot IS the feedback.
    if (direct) {
      try {
        const result = await direct.login();
        if (!oauthLoginFlowMountedRef.current) return;
        if (!result.ok) {
          toast.error(copy.accountActionFailed(display.name), subscriptionResultMessage(result.message, copy.loginFailedRetry, locale));
        }
        await refresh();
        if (!oauthLoginFlowMountedRef.current) return;
        if (result.ok && params.onLoginSuccess) await params.onLoginSuccess();
      } catch (error) {
        if (!oauthLoginFlowMountedRef.current) return;
        toast.error(copy.accountActionFailed(display.name), subscriptionActionErrorMessage(error, locale));
      } finally {
        finishPendingAction();
      }
      return;
    }
    try {
      const payload = await bridge.getAuthUrl();
      if ('ok' in payload) {
        if (!oauthLoginFlowMountedRef.current) return;
        const failureMessage = payload.ok ? copy.retry : subscriptionResultMessage(payload.message, copy.startFailedRetry, locale);
        toast.error(copy.startFailed, failureMessage);
        setErrorMessage(failureMessage);
        return;
      }
      authRequestIdRef.current = payload.authRequestId;
      if (!oauthLoginFlowMountedRef.current) {
        authRequestIdRef.current = null;
        void bridge.cancelAuthorization(payload.authRequestId);
        return;
      }
      setAuthRequestId(payload.authRequestId);
      setStateHint(payload.stateHint);
      const opened = await bridge.openAuthUrl(payload.authRequestId);
      if (!oauthLoginFlowMountedRef.current) return;
      if (!opened.ok) {
        const message = subscriptionResultMessage(opened.message, copy.openFailedRetry, locale);
        toast.error(copy.openFailed, message);
        setErrorMessage(message);
        void bridge.cancelAuthorization(payload.authRequestId);
        authRequestIdRef.current = null;
        setAuthRequestId(null);
        setStateHint(null);
        return;
      }
      const refreshed = await refresh();
      if (!oauthLoginFlowMountedRef.current || !refreshed) return;
      // Loopback / polling -- wait for the backend to complete.
      const result = await bridge.completeAuthorization(payload.authRequestId);
      if (!oauthLoginFlowMountedRef.current) return;
      authRequestIdRef.current = null;
      setAuthRequestId(null);
      setStateHint(null);
      if (result.ok) {
        toast.success(copy.loginSuccess, copy.bound(display.name));
        await refresh();
        if (!oauthLoginFlowMountedRef.current) return;
        if (params.onLoginSuccess) await params.onLoginSuccess();
      } else {
        const message = subscriptionResultMessage(result.message, copy.incompleteRetry, locale);
        toast.error(copy.incomplete, message);
        setErrorMessage(message);
      }
    } catch (error) {
      if (!oauthLoginFlowMountedRef.current) return;
      const pendingAuthRequestId = authRequestIdRef.current;
      authRequestIdRef.current = null;
      if (pendingAuthRequestId) void bridge.cancelAuthorization(pendingAuthRequestId);
      setAuthRequestId(null);
      setStateHint(null);
      const message = subscriptionActionErrorMessage(error, locale);
      toast.error(copy.loginFailed, message);
      setErrorMessage(message);
    } finally {
      finishPendingAction();
    }
  }

  async function logout() {
    if (!beginPendingAction('logout')) return;
    try {
      // Direct-import flows keep their original no-confirm, silent-success
      // logout; only the browser-assisted services confirm the destructive
      // action and toast on success.
      if (!direct) {
        const ok = await toast.confirm({
          title: copy.logoutTitle(display.name),
          description: copy.logoutDescription,
          confirmLabel: copy.logout,
          cancelLabel: copy.cancel,
          destructive: true,
        });
        if (!ok) return;
      }
      const result = await bridge.logout();
      if (!oauthLoginFlowMountedRef.current) return;
      if (result.ok) {
        if (!direct) {
          toast.success(copy.loggedOut, copy.credentialsCleared);
        }
        await refresh();
      } else if (direct) {
        toast.error(copy.accountActionFailed(display.name), subscriptionResultMessage(result.message, copy.logoutFailedRetry, locale));
      } else {
        toast.error(copy.logoutFailed, subscriptionResultMessage(result.message, copy.logoutFailedRetry, locale));
      }
    } catch (error) {
      if (!oauthLoginFlowMountedRef.current) return;
      if (direct) {
        toast.error(copy.accountActionFailed(display.name), subscriptionActionErrorMessage(error, locale));
      } else {
        toast.error(copy.logoutFailed, subscriptionActionErrorMessage(error, locale));
      }
    } finally {
      finishPendingAction();
    }
  }

  async function refreshTokens() {
    if (!direct) return;
    if (!beginPendingAction('refresh')) return;
    try {
      const result = await direct.refreshTokens();
      if (!oauthLoginFlowMountedRef.current) return;
      if (!result.ok) {
        toast.error(copy.accountActionFailed(display.name), subscriptionResultMessage(result.message, copy.reverifyFailedRetry, locale));
      }
      await refresh();
    } catch (error) {
      if (!oauthLoginFlowMountedRef.current) return;
      toast.error(copy.accountActionFailed(display.name), subscriptionActionErrorMessage(error, locale));
    } finally {
      finishPendingAction();
    }
  }

  const runtimeState = state?.runtimeState ?? 'loading';
  const isLoggedIn = runtimeState === 'authenticated' || runtimeState === 'refreshing';
  const actionBusy = pendingAction !== null;

  return {
    state,
    runtimeState,
    isLoggedIn,
    pendingAction,
    authRequestId,
    stateHint,
    errorMessage,
    actionBusy,
    startLogin,
    logout,
    refresh,
    refreshTokens: direct ? refreshTokens : undefined,
  };
}

export function subscriptionActionErrorMessage(error: unknown, locale: UiLocale = 'zh'): string {
  const message = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : '';
  return subscriptionResultMessage(message, getProviderSettingsCopy(locale).oauthFlow.serviceUnavailable, locale);
}

export function subscriptionResultMessage(message: string | undefined, fallback: string, locale: UiLocale = 'zh'): string {
  const raw = redactSecrets(message ?? '').trim();
  if (!raw) return fallback;
  // Host conflict / supersede copy before the coarse keyword classifier turns
  // "authorization" into a generic 鉴权失败 that does not tell the user what to do.
  // This is error-path copy: do not claim a new login already started.
  if (/already in progress|superseded by a new attempt/i.test(raw)) {
    return locale === 'zh'
      ? '上一轮浏览器登录仍在进行或已切换，请再点一次登录，或稍后再试。'
      : 'A previous browser login is still running or was superseded. Try logging in again shortly.';
  }
  if (/did not present OAuth|no matching OAuth presentation/i.test(raw)) {
    return locale === 'zh'
      ? '无法打开系统浏览器完成登录，请检查是否拦截了弹窗后重试。'
      : 'Could not open the system browser for login. Check popup blockers and try again.';
  }
  const classified = locale === 'zh'
    ? generalizedErrorMessageChinese(new Error(raw), '')
    : generalizedErrorMessage(new Error(raw), '');
  if (classified) return classified;
  return locale === 'zh' || !/[\u4e00-\u9fff]/.test(raw) ? raw : fallback;
}
