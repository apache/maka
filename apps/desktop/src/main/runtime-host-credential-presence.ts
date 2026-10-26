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

/**
 * Onboarding credential presence — the boot wiring behind
 * `OnboardingServiceDeps.hasCredential` (#6318).
 *
 * 读失败 = unknown：Host 读失败（catalog 读取、凭据查询、未知 provider
 * 注册项）时抛出，绝不折叠成 `false`——`false` 是「已确认未配置」，
 * 会驱动 onboarding 引导用户重录一个其实已存在的 key。抛出后由
 * OnboardingService 的默认路径传播成整份 snapshot 读取失败，渲染层的
 * onboarding authority 以 `failed` 标记呈现（不产出任何「未配置」断言）；
 * reconnectable 失败照常流向 IPC 重连策略，此处的传播语义与它正交。
 *
 * 只读：不刷新 OAuth token，也不变更任何凭据状态。
 */

import {
  PROVIDER_REGISTRY,
  providerAuthRequiresSecret,
  type LlmConnection,
} from '@maka/core/llm-connections';
import type { CredentialLocator, CredentialStatus } from '@maka/core/runtime-policy';
import type { RuntimeHostConnectionCatalogSnapshot } from '@maka/runtime-host/client';

/** `DesktopRuntimeHostClient` 的结构化子集；测试用假件即可满足。 */
export interface HostCredentialPresenceClient {
  loadConnectionCatalog(): Promise<RuntimeHostConnectionCatalogSnapshot>;
  queryCredential(locator: CredentialLocator): Promise<CredentialStatus | null>;
}

export type HostCredentialPresence = (connection: LlmConnection) => Promise<boolean>;

export function createHostCredentialPresence(
  client: HostCredentialPresenceClient,
): HostCredentialPresence {
  return async (connection) => {
    if (!providerAuthRequiresSecret(connection.providerType)) return true;
    const catalog = await client.loadConnectionCatalog();
    const entry = catalog.connections.find(({ slug }) => slug === connection.slug);
    if (!entry) return false;
    const authKind = PROVIDER_REGISTRY[entry.providerType].authKind;
    const status = await client.queryCredential({
      scope: 'connection',
      connectionId: entry.connectionId,
      kind: authKind === 'oauth_token' ? 'oauth_token' : 'api_key',
    });
    return status?.configured === true;
  };
}
