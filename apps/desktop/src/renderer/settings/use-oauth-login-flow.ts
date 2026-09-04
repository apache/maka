/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { useEffect, useRef, useState } from 'react';
import { generalizedErrorMessage, generalizedErrorMessageChinese, redactSecrets } from '@maka/core/redaction';
import { type UiLocale } from '@maka/core/ui-locale';
import {
  useMountedRef,
  useToast,
  useUiLocale,
} from '@maka/ui';
import { createOneShotActionGuard, teardownPendingAuthorization } from './oauth-login-flow-guard';
import { getProviderSettingsCopy } from '../features/connection-settings';
import { useRuntimeHostSettingsErrorReporter } from './runtime-host-settings-target.js';

// Shared browser-assisted OAuth login-flow controller (device-code polling).
//
// Extracted from the SubscriptionLoginModal `startLogin` flow so BOTH the
// OAuth catalog login modals (Codex / xAI) AND the model
// connection detail sheet's 重新登录 affordance drive the same
// getAuthUrl -> openAuthUrl -> refresh -> completeAuthorization sequence with
// one authRequestId lifecycle, one synchronous pending-action guard, and
// cancellation-on-unmount. Every OAuth provider hands authorization to the
// browser, so this is the only login shape the renderer drives.

export type OAuthLoginPendingAction = 'login' | 'logout';

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
  errorMessage?: string;
}

export interface OAuthConnectionIdentity {
  connectionId: string;
  slug: string;
  providerType: 'openai-codex' | 'xai-oauth' | 'github-copilot';
}

export interface OAuthAuthorizationFlowBridge {
  getAuthUrl(): Promise<
    { authRequestId: string; stateHint: string; connection: OAuthConnectionIdentity }
    | { ok: boolean; reason?: string; message: string }
  >;
  openAuthUrl(authRequestId: string): Promise<{ ok: true } | { ok: false; reason: string; message: string }>;
  completeAuthorization(authRequestId: string): Promise<
    { ok: true; connection: OAuthConnectionIdentity }
    | { ok: false; reason: string; message: string }
  >;
  cancelAuthorization(authRequestId?: string): Promise<{ ok: true }>;
  // The selected Host's answer to whether this provider may enrol at all.
  getEnrollmentState(): Promise<{ enabled: boolean }>;
}

export interface OAuthAccountFlowBridge {
  getAccountState(): Promise<unknown>;
  logout(): Promise<{ ok: true } | { ok: false; reason: string; message: string }>;
}

export interface OAuthLoginFlowDisplay {
  name: string;
  shortName: string;
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
  // The Host's answer to whether this provider may begin an interactive login.
  // Undefined until the probe resolves; surfaces read unknown as enabled so a
  // slow Host never hides an action that would in fact succeed.
  enrollmentEnabled: boolean | undefined;
  reportError(title: string, message: string): void;
  startLogin(): Promise<void>;
  logout: (() => Promise<void>) | undefined;
  refresh(): Promise<boolean>;
}

type OAuthLoginFlowParams =
  | {
      mode: 'create';
      authorizationBridge: OAuthAuthorizationFlowBridge;
      display: OAuthLoginFlowDisplay;
      onLoginSuccess(connection: OAuthConnectionIdentity): void | Promise<void>;
    }
  | {
      mode: 'existing';
      authorizationBridge: OAuthAuthorizationFlowBridge;
      accountBridge: OAuthAccountFlowBridge;
      display: OAuthLoginFlowDisplay;
      onLoginSuccess?: (connection: OAuthConnectionIdentity) => void | Promise<void>;
      onAccountChanged?: () => void | Promise<void>;
    };

export function useOAuthLoginFlow(params: OAuthLoginFlowParams): OAuthLoginFlowController {
  const { display } = params;
  const locale = useUiLocale();
  const copy = getProviderSettingsCopy(locale).oauthFlow;
  const authorizationBridge = params.authorizationBridge;
  const accountBridge = params.mode === 'create' ? undefined : params.accountBridge;
  const toast = useToast();
  const reportHostError = useRuntimeHostSettingsErrorReporter();
  const [state, setState] = useState<SubscriptionSnapshot | null>(null);
  const [authRequestId, setAuthRequestId] = useState<string | null>(null);
  const [stateHint, setStateHint] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<OAuthLoginPendingAction | null>(null);
  const [feedback, setFeedback] = useState<{
    readonly errorMessage: string | null;
    readonly enrollmentEnabled: boolean | undefined;
  }>({ errorMessage: null, enrollmentEnabled: undefined });
  const { errorMessage, enrollmentEnabled } = feedback;
  const setErrorMessage = (next: string | null) => {
    setFeedback((current) => ({ ...current, errorMessage: next }));
  };
  const setEnrollmentEnabled = (next: boolean) => {
    setFeedback((current) => ({ ...current, enrollmentEnabled: next }));
  };
  const pendingGuard = useRef(createOneShotActionGuard<OAuthLoginPendingAction>()).current;
  const authRequestIdRef = useRef<string | null>(null);
  const oauthLoginFlowMountedRef = useMountedRef();

  async function refresh(): Promise<boolean> {
    if (!accountBridge) return true;
    try {
      const next = (await accountBridge.getAccountState()) as SubscriptionSnapshot;
      if (!oauthLoginFlowMountedRef.current) return false;
      setState(next);
      setErrorMessage(null);
    } catch (error) {
      if (!oauthLoginFlowMountedRef.current) return false;
      const message = subscriptionActionErrorMessage(error, locale);
      reportHostError(copy.refreshFailed, message);
      setErrorMessage(message);
      return false;
    }
    return true;
  }

  useEffect(() => {
    if (accountBridge) void refresh();
    // Ask the Host whether this provider may enrol. A probe failure leaves the
    // answer unknown, which surfaces read as enabled rather than hiding sign-in.
    void authorizationBridge
      ?.getEnrollmentState()
      .then((result) => {
        if (oauthLoginFlowMountedRef.current) setEnrollmentEnabled(result.enabled);
      })
      .catch(() => undefined);
    return () => {
      pendingGuard.finish();
      if (authorizationBridge) {
        teardownPendingAuthorization(
          authRequestIdRef,
          (id) => void authorizationBridge.cancelAuthorization(id),
        );
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function reportError(title: string, message: string): void {
    reportHostError(title, message);
    setErrorMessage(message);
  }

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
    try {
      const payload = await authorizationBridge.getAuthUrl();
      if ('ok' in payload) {
        if (!oauthLoginFlowMountedRef.current) return;
        const failureMessage = payload.ok ? copy.retry : subscriptionResultMessage(payload.message, copy.startFailedRetry, locale, payload.reason);
        reportHostError(copy.startFailed, failureMessage);
        setErrorMessage(failureMessage);
        return;
      }
      authRequestIdRef.current = payload.authRequestId;
      if (!oauthLoginFlowMountedRef.current) {
        authRequestIdRef.current = null;
        void authorizationBridge.cancelAuthorization(payload.authRequestId);
        return;
      }
      setAuthRequestId(payload.authRequestId);
      setStateHint(payload.stateHint);
      const opened = await authorizationBridge.openAuthUrl(payload.authRequestId);
      if (!oauthLoginFlowMountedRef.current) return;
      if (!opened.ok) {
        const message = subscriptionResultMessage(opened.message, copy.openFailedRetry, locale, opened.reason);
        reportHostError(copy.openFailed, message);
        setErrorMessage(message);
        void authorizationBridge.cancelAuthorization(payload.authRequestId);
        authRequestIdRef.current = null;
        setAuthRequestId(null);
        setStateHint(null);
        return;
      }
      const refreshed = await refresh();
      if (!oauthLoginFlowMountedRef.current || !refreshed) return;
      // Wait for the backend to finish polling the provider.
      const result = await authorizationBridge.completeAuthorization(payload.authRequestId);
      if (!oauthLoginFlowMountedRef.current) return;
      authRequestIdRef.current = null;
      setAuthRequestId(null);
      setStateHint(null);
      if (result.ok) {
        toast.success(copy.loginSuccess, copy.bound(display.name));
        await refresh();
        if (!oauthLoginFlowMountedRef.current) return;
        if (params.onLoginSuccess) await params.onLoginSuccess(result.connection);
      } else {
        const message = subscriptionResultMessage(result.message, copy.incompleteRetry, locale, result.reason);
        reportHostError(copy.incomplete, message);
        setErrorMessage(message);
      }
    } catch (error) {
      if (!oauthLoginFlowMountedRef.current) return;
      const pendingAuthRequestId = authRequestIdRef.current;
      authRequestIdRef.current = null;
      if (pendingAuthRequestId && authorizationBridge) {
        void authorizationBridge.cancelAuthorization(pendingAuthRequestId);
      }
      setAuthRequestId(null);
      setStateHint(null);
      const message = subscriptionActionErrorMessage(error, locale);
      reportHostError(copy.loginFailed, message);
      setErrorMessage(message);
    } finally {
      finishPendingAction();
    }
  }

  async function logout() {
    if (!accountBridge) return;
    if (!beginPendingAction('logout')) return;
    try {
      const ok = await toast.confirm({
        title: copy.logoutTitle(display.name),
        description: copy.logoutDescription,
        confirmLabel: copy.logout,
        cancelLabel: copy.cancel,
        destructive: true,
      });
      if (!ok) return;
      const result = await accountBridge.logout();
      if (!oauthLoginFlowMountedRef.current) return;
      if (result.ok) {
        toast.success(copy.loggedOut, copy.credentialsCleared);
        await refresh();
        if (params.mode === 'existing' && params.onAccountChanged) {
          await params.onAccountChanged();
        }
      } else {
        reportHostError(
          copy.logoutFailed,
          subscriptionResultMessage(result.message, copy.logoutFailedRetry, locale),
        );
      }
    } catch (error) {
      if (!oauthLoginFlowMountedRef.current) return;
      reportHostError(
        copy.logoutFailed,
        subscriptionActionErrorMessage(error, locale),
      );
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
    enrollmentEnabled,
    reportError,
    startLogin,
    logout: accountBridge ? logout : undefined,
    refresh,
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

export function subscriptionResultMessage(message: string | undefined, fallback: string, locale: UiLocale = 'zh', reason?: string): string {
  const raw = redactSecrets(message ?? '').trim();
  // The Host refuses an enrollment this install has not opted into and says so
  // with a typed reason. Read the reason, not the English message: a reworded
  // string or an added locale must not silently disable this branch. The
  // message match stays only as a fallback for callers without a typed reason.
  if (reason === 'experimental_disabled' || /enrollment is disabled for this provider/i.test(raw)) {
    return locale === 'zh'
      ? '本机未启用该账号登录方式；可改用导入兼容凭据，或由管理员启用后重试。'
      : 'This sign-in is not enabled on this install. Import a compatible credential instead, or ask an operator to enable it.';
  }
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
