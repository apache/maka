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
  DesktopOAuthLoginTarget,
  DesktopRuntimeHostRef,
  MakaBridge,
} from '../../preload/bridge-contract.js';
import type {
  OAuthAccountFlowBridge,
  OAuthAuthorizationFlowBridge,
} from './use-oauth-login-flow.js';

type RuntimeHostOAuthBridge = MakaBridge['openAiCodex'] | MakaBridge['xaiOAuth'];

export function runtimeHostOAuthAuthorizationBridge(
  bridge: RuntimeHostOAuthBridge,
  host: DesktopRuntimeHostRef,
  target: DesktopOAuthLoginTarget,
): OAuthAuthorizationFlowBridge {
  return {
    getAuthUrl: () => bridge.getAuthUrl(host, target),
    openAuthUrl: (authRequestId) => bridge.openAuthUrl(authRequestId, host),
    completeAuthorization: (authRequestId) => bridge.completeAuthorization(authRequestId, host),
    cancelAuthorization: (authRequestId) => bridge.cancelAuthorization(authRequestId, host),
  };
}

export function runtimeHostOAuthAccountBridge(
  bridge: RuntimeHostOAuthBridge,
  host: DesktopRuntimeHostRef,
  connectionId: string,
): OAuthAccountFlowBridge {
  return {
    getAccountState: async () => requireOAuthAccountState(
      await bridge.getAccountState(host, connectionId),
    ),
    logout: () => bridge.logout(host, connectionId),
  };
}

function requireOAuthAccountState(value: unknown): unknown {
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
}

export function runtimeHostOAuthExistingLoginBridges(
  bridge: RuntimeHostOAuthBridge,
  host: DesktopRuntimeHostRef,
  connectionId: string,
): {
  authorizationBridge: OAuthAuthorizationFlowBridge;
  accountBridge: OAuthAccountFlowBridge;
} {
  return {
    authorizationBridge: runtimeHostOAuthAuthorizationBridge(
      bridge,
      host,
      { kind: 'existing', connectionId },
    ),
    accountBridge: runtimeHostOAuthAccountBridge(bridge, host, connectionId),
  };
}
