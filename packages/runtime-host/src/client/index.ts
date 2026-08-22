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

export {
  connectRuntimeHost,
  connectExistingRuntimeHost,
  connectRemoteRuntimeHost,
  RuntimeHostOperationError,
  RuntimeHostRequestInterruptedError,
  type RuntimeHostConnection,
  type DirectRequestOperationKey,
} from './connection.js';
export {
  LOCAL_RUNTIME_HOST_PROFILE,
  RUNTIME_HOST_ACCESS_CREDENTIAL_MAX_BYTES,
  createClientRuntimeHostCredentialStore,
  createClientRuntimeHostProfileCatalog,
  createFileRuntimeHostProfileCatalog,
  createRuntimeHostProfileCredentialStore,
  connectRemoteRuntimeHostProfile,
  decodeRemoteRuntimeHostProfile,
  remoteRuntimeHostUnavailableError,
  sameRemoteRuntimeHostProfileTarget,
  sameResolvedRuntimeHostProfileTarget,
  type RemoteRuntimeHostProfile,
  type RuntimeHostRemoteTransport,
  type ResolvedRuntimeHostProfile,
  type RuntimeHostProfile,
  type RuntimeHostProfileCatalog,
  type RuntimeHostProfileDocument,
} from './host-profile.js';
export {
  createRuntimeHostReconnectingConnection,
  isRuntimeHostReconnectingConnection,
} from './reconnecting-connection.js';
export {
  normalizeRuntimeHostSshDestination,
  openRuntimeHostSshTunnel,
  type RuntimeHostSshInteraction,
  type RuntimeHostSshProcess,
  type RuntimeHostSshProcessFactory,
  type RuntimeHostSshTunnel,
  type RuntimeHostSshTunnelInput,
} from './ssh-tunnel.js';
export {
  RuntimeHostPermanentReconnectError,
  startRuntimeHostReconnectLifecycle,
  type RuntimeHostReconnectBackoff,
  type RuntimeHostReconnectLifecycle,
} from './reconnect-lifecycle.js';
export {
  RUNTIME_HOST_REMOTE_INCOMPATIBLE_CODE,
  RuntimeHostRemoteCompatibilityError,
  type RuntimeHostRemoteCompatibilityDetails,
} from './remote-compatibility-error.js';
export {
  RuntimeHostSubscriptionError,
  type DecodedSessionTranscriptPage,
  type RuntimeHostSessionSubscription,
} from './session-subscription.js';
export {
  RuntimeHostStartupError,
  runtimeHostStartupError,
} from './startup-error.js';
export {
  RuntimeHostCatalogReadError,
  readRuntimeHostConnectionCatalog,
  readRuntimeHostInvocableSkills,
  readRuntimeHostProjectDetails,
  readRuntimeHostResources,
  readRuntimeHostProjects,
  readRuntimeHostSessions,
  readRuntimeHostSkillCatalog,
} from './catalog-reader.js';
export {
  connectOrSpawnRuntimeHost,
  type ConnectOrSpawnRuntimeHostInput,
  type ConnectOrSpawnRuntimeHostResult,
} from './connect-or-spawn.js';
export {
  createRuntimeHostCandidateLaunchBarrier,
  type RuntimeHostCandidateLaunchBarrier,
} from './candidate-launch-barrier.js';
export { runHostedExecution } from './hosted-execution.js';
export { type ClientCapabilityProvider } from './client-capability.js';
export {
  readRuntimeHostAgentGraphEpochs,
  type AgentGraphEpochDirectory,
} from './agent-graph-reader.js';
export {
  startRuntimeHostCapabilityProviderService,
  type RuntimeHostCapabilityProviderService,
} from './capability-provider-service.js';
export { loadOrCreateRuntimeHostClientInstanceId } from './client-instance-identity.js';
export { consumeAccessCredentialDelivery } from '../control/access-credential-delivery.js';
export {
  createOAuthPresentationClientProvider,
  type OAuthPresentationBackend,
} from './oauth-presentation.js';
