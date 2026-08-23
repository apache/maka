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

import {
  PROVIDER_DEFAULTS,
  providerAuthRequiresSecret,
  providerSupportsModelDiscovery,
  type ConnectionAuth,
  type ConnectionLastTestStatus,
  type LlmConnection,
  type ProviderType,
} from './llm-connections.js';

export const PROVIDER_AUTH_SETUP_MODES = ['api_key', 'oauth', 'none'] as const;
export type ProviderAuthSetupMode = (typeof PROVIDER_AUTH_SETUP_MODES)[number];

export const PROVIDER_AUTH_STATES = [
  'disabled',
  'not_configured',
  'configured',
  'validated',
  'needs_reauth',
  'error',
] as const;
export type ProviderAuthState = (typeof PROVIDER_AUTH_STATES)[number];

export const PROVIDER_AUTH_ACTIONS = [
  'save_secret',
  'test_credentials',
  'fetch_models',
  'start_oauth',
  'refresh_oauth',
  'revoke_auth',
] as const;
export type ProviderAuthAction = (typeof PROVIDER_AUTH_ACTIONS)[number];

export type ProviderAuthActionAvailability = 'available' | 'hidden';

export interface ProviderAuthContractInput {
  providerType: ProviderType;
  enabled?: boolean;
  hasSecret?: boolean;
  lastTestStatus?: ConnectionLastTestStatus;
}

export interface ProviderAuthContract {
  providerType: ProviderType;
  setupMode: ProviderAuthSetupMode;
  state: ProviderAuthState;
  /**
   * Credential validation only. This is intentionally separate from
   * HealthSignal runtime probes and must not be rendered as "agent is
   * operational".
   */
  validationStatus: ConnectionLastTestStatus | 'not_run' | 'not_required';
  requiresSecret: boolean;
  sendMayUseWithoutSecret: boolean;
  actionAvailability: Record<ProviderAuthAction, ProviderAuthActionAvailability>;
  copy: {
    label: string;
    detail: string;
  };
}

export function deriveProviderAuthContract(input: ProviderAuthContractInput): ProviderAuthContract {
  const defaults = PROVIDER_DEFAULTS[input.providerType];
  const enabled = input.enabled ?? true;
  const hasSecret = Boolean(input.hasSecret);
  // Unknown providerType (legacy seed, or a connection persisted on a branch
  // that registers a provider this build doesn't know) → surface a non-real,
  // non-actionable contract so the settings row renders instead of crashing.
  // Mirrors `isRealConnection` in connection-readiness.ts.
  if (!defaults) {
    return {
      providerType: input.providerType,
      setupMode: 'none',
      state: enabled ? 'not_configured' : 'disabled',
      validationStatus: 'not_required',
      requiresSecret: false,
      sendMayUseWithoutSecret: false,
      actionAvailability: hiddenActions(),
      copy: {
        label: `${input.providerType} 未知或已迁移`,
        detail:
          '该连接使用的 provider 在当前版本未注册；配置会保留，切回支持它的版本即可继续使用。',
      },
    };
  }
  // A provider Maka has retired. The entry stays registered so a stored
  // connection still decodes and renders, but every action leads nowhere: no
  // Runtime adapter to send on, no sign-in to complete, no endpoint to test.
  // Offering any of them would point the user at a dead end, so the contract
  // hides them all — this is what stops the storage layer from admitting a
  // model fetch or a connection test. Deleting the connection is what clears
  // the credential this machine still holds.
  if (defaults.retired === true) {
    return {
      providerType: input.providerType,
      setupMode: 'none',
      state: enabled ? 'configured' : 'disabled',
      validationStatus: 'not_required',
      requiresSecret: true,
      sendMayUseWithoutSecret: false,
      actionAvailability: hiddenActions(),
      copy: {
        label: `${defaults.label} 已停用`,
        detail:
          '这条连接使用的登录方式已从 Maka 移除，无法再登录，也无法用于发送；删除这条连接会一并清除本机保存的凭据。',
      },
    };
  }

  const supportsModelDiscovery = providerSupportsModelDiscovery(input.providerType);
  const actionAvailability = hiddenActions();

  if (!enabled) {
    return {
      providerType: input.providerType,
      setupMode: setupModeForProvider(input.providerType),
      state: 'disabled',
      validationStatus:
        input.lastTestStatus ??
        (providerAuthRequiresSecret(input.providerType) ? 'not_run' : 'not_required'),
      requiresSecret: providerAuthRequiresSecret(input.providerType),
      sendMayUseWithoutSecret: !providerAuthRequiresSecret(input.providerType),
      actionAvailability,
      copy: {
        label: `${defaults.label} 已关闭`,
        detail: '连接被显式关闭；不会作为发送默认连接，也不会触发凭据测试。',
      },
    };
  }

  if (defaults.authKind === 'oauth_token') {
    const validationStatus = input.lastTestStatus ?? 'not_run';
    const state: ProviderAuthState = authStateFromSecretAndTest(hasSecret, input.lastTestStatus);
    return {
      providerType: input.providerType,
      setupMode: 'oauth',
      state,
      validationStatus,
      requiresSecret: true,
      sendMayUseWithoutSecret: false,
      actionAvailability: {
        ...actionAvailability,
        test_credentials: hasSecret ? 'available' : 'hidden',
        fetch_models: hasSecret && supportsModelDiscovery ? 'available' : 'hidden',
        start_oauth: hasSecret ? 'hidden' : 'available',
        refresh_oauth: hasSecret ? 'available' : 'hidden',
        revoke_auth: hasSecret ? 'available' : 'hidden',
      },
      copy: copyForOAuth(defaults.label, state),
    };
  }

  if (defaults.authKind === 'optional_api_key') {
    const state = authStateFromSecretAndTest(true, input.lastTestStatus);
    return {
      providerType: input.providerType,
      setupMode: 'api_key',
      state,
      validationStatus: input.lastTestStatus ?? (hasSecret ? 'not_run' : 'not_required'),
      requiresSecret: false,
      sendMayUseWithoutSecret: true,
      actionAvailability: {
        ...actionAvailability,
        save_secret: 'available',
        test_credentials: 'available',
        fetch_models: supportsModelDiscovery ? 'available' : 'hidden',
        revoke_auth: hasSecret ? 'available' : 'hidden',
      },
      copy: copyForOptionalApiKey(defaults.label, state, hasSecret),
    };
  }

  if (defaults.authKind === 'none') {
    return {
      providerType: input.providerType,
      setupMode: 'none',
      state: 'configured',
      validationStatus: 'not_required',
      requiresSecret: false,
      sendMayUseWithoutSecret: true,
      actionAvailability: {
        ...actionAvailability,
        test_credentials: 'available',
        fetch_models: supportsModelDiscovery ? 'available' : 'hidden',
      },
      copy: {
        label: `${defaults.label} 不需要凭据`,
        detail: '此模型服务不需要密钥；可用性仍取决于本地服务和模型列表。',
      },
    };
  }

  const validationStatus = input.lastTestStatus ?? 'not_run';
  const state: ProviderAuthState = authStateFromSecretAndTest(hasSecret, input.lastTestStatus);
  return {
    providerType: input.providerType,
    setupMode: 'api_key',
    state,
    validationStatus,
    requiresSecret: true,
    sendMayUseWithoutSecret: false,
    actionAvailability: {
      ...actionAvailability,
      save_secret: 'available',
      test_credentials: hasSecret ? 'available' : 'hidden',
      fetch_models: hasSecret && supportsModelDiscovery ? 'available' : 'hidden',
      revoke_auth: hasSecret ? 'available' : 'hidden',
    },
    copy: copyForApiKey(defaults.label, state),
  };
}

export function deriveProviderAuthContractFromConnection(
  connection: Pick<LlmConnection, 'providerType' | 'enabled' | 'lastTestStatus'>,
  hasSecret: boolean,
): ProviderAuthContract {
  return deriveProviderAuthContract({
    providerType: connection.providerType,
    enabled: connection.enabled,
    hasSecret,
    lastTestStatus: connection.lastTestStatus,
  });
}

export function isProviderAuthState(value: unknown): value is ProviderAuthState {
  return typeof value === 'string' && (PROVIDER_AUTH_STATES as readonly string[]).includes(value);
}

function authStateFromSecretAndTest(
  hasSecret: boolean,
  lastTestStatus: ConnectionLastTestStatus | undefined,
): ProviderAuthState {
  if (!hasSecret) return 'not_configured';
  if (lastTestStatus === 'verified') return 'validated';
  if (lastTestStatus === 'needs_reauth') return 'needs_reauth';
  if (lastTestStatus === 'error') return 'error';
  return 'configured';
}

function hiddenActions(): Record<ProviderAuthAction, ProviderAuthActionAvailability> {
  return {
    save_secret: 'hidden',
    test_credentials: 'hidden',
    fetch_models: 'hidden',
    start_oauth: 'hidden',
    refresh_oauth: 'hidden',
    revoke_auth: 'hidden',
  };
}

function setupModeForAuthKind(authKind: ConnectionAuth['kind']): ProviderAuthSetupMode {
  if (authKind === 'none') return 'none';
  if (authKind === 'oauth_token') return 'oauth';
  return 'api_key';
}

function setupModeForProvider(providerType: ProviderType): ProviderAuthSetupMode {
  return setupModeForAuthKind(PROVIDER_DEFAULTS[providerType]?.authKind);
}

function copyForApiKey(label: string, state: ProviderAuthState): ProviderAuthContract['copy'] {
  switch (state) {
    case 'not_configured':
      return {
        label: `${label} 等待模型密钥`,
        detail: '保存凭据后才能测试连接或拉取模型列表。',
      };
    case 'validated':
      return {
        label: `${label} 凭据验证通过`,
        detail: '这只代表凭据和端点验证通过，不代表消息发送、流式响应或中断恢复已经运行可用。',
      };
    case 'needs_reauth':
      return {
        label: `${label} 需要重新授权`,
        detail: '上次凭据测试显示鉴权失败；请替换凭据后重新测试。',
      };
    case 'error':
      return {
        label: `${label} 凭据测试失败`,
        detail: '上次测试未通过；详情必须使用概括后的错误信息，不展示服务商原始响应。',
      };
    case 'configured':
      return {
        label: `${label} 已保存凭据`,
        detail: '凭据已保存，等待验证；测试通过前不要把它展示成运行可用。',
      };
    case 'disabled':
      return {
        label,
        detail: '当前状态不走模型密钥凭据流程。',
      };
  }
}

function copyForOptionalApiKey(
  label: string,
  state: ProviderAuthState,
  hasSecret: boolean,
): ProviderAuthContract['copy'] {
  switch (state) {
    case 'validated':
      return {
        label: `${label} 连接验证通过`,
        detail:
          '这只代表实例端点和鉴权配置验证通过，不代表消息发送、流式响应或中断恢复已经运行可用。',
      };
    case 'needs_reauth':
      return {
        label: `${label} 需要重新授权`,
        detail: '上次连接测试显示鉴权失败；请检查实例鉴权设置或可选模型密钥后重试。',
      };
    case 'error':
      return {
        label: `${label} 连接测试失败`,
        detail: '上次测试未通过；详情必须使用概括后的错误信息，不展示服务商原始响应。',
      };
    case 'configured':
      return {
        label: `${label} 可选模型密钥`,
        detail: hasSecret
          ? '已保存可选模型密钥；也可删除密钥连接未启用鉴权的实例。'
          : '模型密钥可选；未启用鉴权的实例可直接连接。',
      };
    case 'not_configured':
    case 'disabled':
      return {
        label,
        detail: '当前状态不走可选模型密钥流程。',
      };
  }
}

function copyForOAuth(label: string, state: ProviderAuthState): ProviderAuthContract['copy'] {
  switch (state) {
    case 'not_configured':
      return {
        label: `${label} 等待 OAuth 登录`,
        detail: '完成账号登录后才能测试连接、拉取模型列表或用于聊天发送。',
      };
    case 'validated':
      return {
        label: `${label} OAuth 已验证`,
        detail: '这只代表账号令牌和端点验证通过，不代表消息发送、流式响应或中断恢复已经运行可用。',
      };
    case 'needs_reauth':
      return {
        label: `${label} 需要重新登录`,
        detail: '上次 OAuth 测试显示鉴权失败；请回到模型设置重新登录后再测试。',
      };
    case 'error':
      return {
        label: `${label} OAuth 测试失败`,
        detail: '上次测试未通过；详情必须使用概括后的错误信息，不展示服务商原始响应或账号令牌。',
      };
    case 'configured':
      return {
        label: `${label} OAuth 已登录`,
        detail: '账号令牌已保存，等待验证；测试通过前不要把它展示成运行可用。',
      };
    case 'disabled':
      return {
        label,
        detail: '当前状态不走 OAuth 账号流程。',
      };
  }
}
