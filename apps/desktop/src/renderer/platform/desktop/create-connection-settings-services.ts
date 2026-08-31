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

import type { MakaBridge } from '../../../preload/bridge-contract.js';
import type { ConnectionSettingsServices } from '../../features/connection-settings';

export function createDesktopConnectionSettingsServices(
  bridge: () => Pick<MakaBridge, 'connections'> = () => window.maka,
): ConnectionSettingsServices {
  const uncertainTargets = new Map<string, number>();
  let nextAttemptId = 1;

  return {
    forHost: (host) => {
      const targetKey = `${host.profileId}\u0000${host.hostId}`;
      return {
        connections: {
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
            isUncertain: () => uncertainTargets.has(targetKey),
            markDispatched: () => {
              const attemptId = nextAttemptId++;
              uncertainTargets.set(targetKey, attemptId);
              return attemptId;
            },
            settle: (attemptId) => {
              if (uncertainTargets.get(targetKey) === attemptId) {
                uncertainTargets.delete(targetKey);
              }
            },
            restart: () => uncertainTargets.delete(targetKey),
          },
          verify: (input) => bridge().connections.verifyOnboarding(input, host),
          save: (input) => bridge().connections.saveOnboarding(input, host),
        },
      };
    },
  };
}
