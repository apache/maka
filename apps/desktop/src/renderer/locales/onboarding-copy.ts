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

import type { OnboardingState } from '@maka/core/onboarding';
import type { UiCatalog, UiLocale } from '@maka/core/ui-locale';
import type { OnboardingHeroCopy } from '../onboarding-hero-copy.js';

// Blocked states are keyed by reason, not just by kind: a new blocked reason
// then cannot ship without its own copy.
type VisibleOnboardingKind =
  | Exclude<OnboardingState['kind'], 'ready_with_history' | 'ready_empty' | 'blocked'>
  | `blocked:${Extract<OnboardingState, { kind: 'blocked' }>['reason']}`;
type LocalizedOnboardingHeroCopy = Omit<
  OnboardingHeroCopy,
  'kind' | 'connectionSlug' | 'cta'
> & {
  cta: Pick<OnboardingHeroCopy['cta'], 'label'>;
};

export interface OnboardingCatalog {
  hero: Record<VisibleOnboardingKind, LocalizedOnboardingHeroCopy>;
  needsConnection: {
    pickLabel: string;
    browseProviders: string;
  };
  refresh: {
    connection: string;
    credentials: string;
    model: string;
    blocked: string;
  };
  connectionLabel: string;
  skip: string;
  snapshotErrorFallback: string;
}

const ONBOARDING_COPY_BY_LOCALE: UiCatalog<OnboardingCatalog> = {
  zh: {
    hero: {
      needs_connection: {
        eyebrow: '欢迎使用 Maka',
        title: '接入一个 AI，开始第一项任务。',
        body: 'Maka 在本地运行，使用你自己的模型账号或 API key。先选一个常用服务商。',
        cta: { label: '浏览全部服务商' },
      },
      needs_connection_credentials: {
        eyebrow: '继续设置连接',
        title: '补齐这个连接的凭据。',
        body: '添加 API key 或完成账号登录，Maka 才能调用模型。',
        cta: { label: '配置连接凭据' },
      },
      needs_model: {
        eyebrow: '继续设置连接',
        title: '为这个连接启用一个可用模型。',
        body: '启用一个可用于对话的模型，新任务就可以开始了。',
        cta: { label: '选择可用模型' },
      },
      'blocked:all_connections_unhealthy': {
        eyebrow: '连接需要处理',
        title: '模型连接暂时不可用。',
        body: '现有连接都没有通过验证。检查凭据、登录状态或网络后重新测试。',
        cta: { label: '修复模型连接' },
        tone: 'destructive',
      },
      'blocked:all_connections_retired': {
        eyebrow: '连接需要处理',
        title: '现有连接的登录方式已停用。',
        body: '这些连接使用的登录方式已从 Maka 移除，无法再登录，也无法用于对话。添加一个新的模型连接即可继续。',
        cta: { label: '添加模型连接' },
        tone: 'destructive',
      },
    },
    needsConnection: {
      pickLabel: '选择常用服务商',
      browseProviders: '浏览全部服务商',
    },
    refresh: {
      connection: '重新检测连接',
      credentials: '重新检测凭据',
      model: '重新检测模型',
      blocked: '重新检测连接',
    },
    connectionLabel: '连接',
    skip: '跳过引导',
    snapshotErrorFallback: '首次使用状态暂时不可用，请稍后重试。',
  },
  en: {
    hero: {
      needs_connection: {
        eyebrow: 'Welcome to Maka',
        title: 'Connect an AI and start your first task.',
        body: 'Maka runs locally with your own model account or API key. Choose a common provider to continue.',
        cta: { label: 'Browse all providers' },
      },
      needs_connection_credentials: {
        eyebrow: 'Continue connection setup',
        title: 'Add credentials for this connection.',
        body: 'Add an API key or finish account sign-in so Maka can call the model.',
        cta: { label: 'Configure credentials' },
      },
      needs_model: {
        eyebrow: 'Continue connection setup',
        title: 'Enable an available model for this connection.',
        body: 'Enable a conversation-capable model and your first task can begin.',
        cta: { label: 'Choose an available model' },
      },
      'blocked:all_connections_unhealthy': {
        eyebrow: 'Connection needs attention',
        title: 'Model connections are temporarily unavailable.',
        body: 'No existing connection passed verification. Check credentials, sign-in status, or network access, then test again.',
        cta: { label: 'Fix model connections' },
        tone: 'destructive',
      },
      'blocked:all_connections_retired': {
        eyebrow: 'Connection needs attention',
        title: 'The sign-in your connections use is retired.',
        body: 'The sign-in these connections use was removed from Maka. They can no longer be signed into or used in a conversation. Add a new model connection to continue.',
        cta: { label: 'Add a model connection' },
        tone: 'destructive',
      },
    },
    needsConnection: {
      pickLabel: 'Choose a common provider',
      browseProviders: 'Browse all providers',
    },
    refresh: {
      connection: 'Check connections again',
      credentials: 'Check credentials again',
      model: 'Check models again',
      blocked: 'Check connections again',
    },
    connectionLabel: 'Connection',
    skip: 'Skip onboarding',
    snapshotErrorFallback: 'First-run status is temporarily unavailable. Try again later.',
  },
};

export function getOnboardingCopy(locale: UiLocale): OnboardingCatalog {
  return ONBOARDING_COPY_BY_LOCALE[locale];
}
