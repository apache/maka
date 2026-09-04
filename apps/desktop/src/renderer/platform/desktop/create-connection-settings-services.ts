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

import type {
  DesktopRuntimeHostRef,
  MakaBridge,
} from '../../../preload/bridge-contract.js';
import type {
  ConnectionOAuthProviderBridge,
  ConnectionSettingsServices,
} from '../../features/connection-settings';

type DesktopConnectionSettingsBridge = Pick<
  MakaBridge,
  'connections' | 'openAiCodex' | 'xaiOAuth' | 'githubCopilotSubscription'
>;
type DesktopOAuthProviderBridge =
  | MakaBridge['openAiCodex']
  | MakaBridge['xaiOAuth']
  | MakaBridge['githubCopilotSubscription'];

export function createDesktopConnectionSettingsServices(
  bridge: () => DesktopConnectionSettingsBridge = () => window.maka,
): ConnectionSettingsServices {
  const uncertainTargets = new Map<string, number>();
  const uncertaintyListeners = new Map<string, Set<() => void>>();
  let nextAttemptId = 1;

  const notifyUncertaintyChanged = (targetKey: string) => {
    for (const listener of [...(uncertaintyListeners.get(targetKey) ?? [])]) listener();
  };

  return {
    forHost: (host) => {
      const targetKey = `${host.profileId}\u0000${host.hostId}`;
      return {
        connections: {
          oauth: {
            openAiCodex: bindOAuthProvider(() => bridge().openAiCodex, host),
            xaiOAuth: bindOAuthProvider(() => bridge().xaiOAuth, host),
            githubCopilotSubscription: {
              ...bindOAuthProvider(() => bridge().githubCopilotSubscription, host),
              connectExistingLogin: () =>
                bridge().githubCopilotSubscription.connectExistingLogin(host),
            },
          },
          getSnapshot: () => bridge().connections.getSnapshot(undefined, host),
          setDefault: (connection) => bridge().connections.setDefault(connection, host),
          setDefaultModel: (input) => bridge().connections.setDefaultModel(input, host),
          create: (input) => bridge().connections.create(input, host),
          update: (connection, patch) => bridge().connections.update(connection, patch, host),
          delete: (connection) => bridge().connections.delete(connection, host),
          test: (connection, options) => bridge().connections.test(connection, options, host),
          fetchModels: (connection) => bridge().connections.fetchModels(connection, host),
          hasSecret: (connection) => bridge().connections.hasSecret(connection, host),
          getRequestHeaders: (connection) => bridge().connections.getRequestHeaders(connection, host),
          setRequestHeaders: (connection, headers) =>
            bridge().connections.setRequestHeaders(connection, headers, host),
          subscribeEvents: (handler) => bridge().connections.subscribeEvents(handler, host),
        },
        apiKeyOnboarding: {
          saveUncertainty: {
            getSnapshot: () => uncertainTargets.has(targetKey),
            subscribe: (listener) => {
              const listeners = uncertaintyListeners.get(targetKey) ?? new Set<() => void>();
              listeners.add(listener);
              uncertaintyListeners.set(targetKey, listeners);
              return () => {
                listeners.delete(listener);
                if (listeners.size === 0) uncertaintyListeners.delete(targetKey);
              };
            },
            restart: () => {
              if (uncertainTargets.delete(targetKey)) notifyUncertaintyChanged(targetKey);
            },
          },
          verify: (input) => bridge().connections.verifyOnboarding(input, host),
          save: async (input) => {
            const attemptId = nextAttemptId++;
            const wasUncertain = uncertainTargets.has(targetKey);
            uncertainTargets.set(targetKey, attemptId);
            if (!wasUncertain) notifyUncertaintyChanged(targetKey);
            const outcome = await bridge().connections.saveOnboarding(input, host);
            if (outcome.kind !== 'outcome_unknown') {
              if (uncertainTargets.get(targetKey) === attemptId) {
                uncertainTargets.delete(targetKey);
                notifyUncertaintyChanged(targetKey);
              }
            }
            return outcome;
          },
        },
      };
    },
  };
}

function bindOAuthProvider(
  provider: () => DesktopOAuthProviderBridge,
  host: DesktopRuntimeHostRef,
): ConnectionOAuthProviderBridge {
  return {
    getAuthUrl: (target) => provider().getAuthUrl(host, target),
    openAuthUrl: (authRequestId) => provider().openAuthUrl(authRequestId, host),
    completeAuthorization: (authRequestId) =>
      provider().completeAuthorization(authRequestId, host),
    cancelAuthorization: (authRequestId) =>
      provider().cancelAuthorization(authRequestId, host),
    getEnrollmentState: () => provider().getEnrollmentState(host),
    getAccountState: async (connectionId) => {
      const value = await provider().getAccountState(host, connectionId);
      if (
        value &&
        typeof value === 'object' &&
        'ok' in value &&
        value.ok === false &&
        'message' in value &&
        typeof value.message === 'string'
      ) {
        throw new Error(value.message);
      }
      return value;
    },
    logout: (connectionId) => provider().logout(host, connectionId),
  };
}
