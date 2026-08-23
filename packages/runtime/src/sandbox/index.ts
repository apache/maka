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

export { SandboxManager } from './sandbox-manager.js';
export {
  createSandboxDiagnosticsProvider,
  toSandboxRunTraceProjection,
} from './diagnostics.js';
export type {
  CreateSandboxDiagnosticsProviderInput,
  ResolveSandboxDiagnosticsInput,
  SandboxDiagnosticCapability,
  SandboxDiagnosticCapabilityStatus,
  SandboxDiagnosticFailureReason,
  SandboxDiagnosticFailureStage,
  SandboxDiagnosticFileSystemMode,
  SandboxDiagnosticNetworkMode,
  SandboxDiagnosticsProvider,
  SandboxDiagnosticsSnapshot,
  SandboxRunTraceProjection,
} from './diagnostics.js';
export {
  SandboxCommandError,
  sandboxErrorMetadata,
  serializeSandboxError,
} from './errors.js';
export type {
  SandboxErrorDomain,
  SandboxErrorMetadata,
  SandboxErrorStage,
  SandboxErrorWithMetadata,
} from './errors.js';
export {
  createBuiltinSandboxManager,
  createDefaultSandboxManager,
  isBuiltinFilesystemWorkerSandboxAvailable,
} from './default-sandbox-manager.js';
export {
  LinuxBubblewrapBackend,
  buildBubblewrapArgv,
  buildNetworkSeccompFilter,
  discoverNestedProtectedMetadataPaths,
} from './linux-sandbox.js';
export type {
  BuildBubblewrapArgvInput,
  LinuxBubblewrapBackendOptions,
} from './linux-sandbox.js';
export {
  LINUX_BWRAP_PROBE_ARGS,
  LINUX_BWRAP_REQUIRED_OPTIONS,
  detectLinuxSandboxCapability,
} from './linux-capability.js';
export type {
  DetectLinuxSandboxCapabilityInput,
  LinuxSandboxCapability,
} from './linux-capability.js';
export {
  MACOS_SEATBELT_BASE_POLICY,
  MACOS_SEATBELT_EXECUTABLE,
  MACOS_SEATBELT_PLATFORM_DEFAULTS_POLICY,
  MacosSeatbeltBackend,
  buildSeatbeltPolicy,
  createSeatbeltExecArgs,
  escapeSeatbeltRegex,
} from './macos-seatbelt.js';
export type {
  BuildSeatbeltPolicyInput,
  BuildSeatbeltPolicyResult,
  CreateSeatbeltExecArgsInput,
} from './macos-seatbelt.js';
export type {
  SandboxBackend,
  SandboxCommand,
  SandboxExecRequest,
  SandboxPathContext,
  SandboxPlatform,
  SandboxSelectionInput,
  SandboxSelectionReason,
  SandboxSelectionResult,
  SandboxTransformFailureReason,
  SandboxTransformRequest,
  SandboxTransformResult,
  SandboxType,
  SandboxablePreference,
} from './types.js';
export { compileWindowsSandboxPolicy } from './windows-profile.js';
export type { WindowsSandboxPolicy } from './windows-profile.js';
export {
  createWindowsBrokerManifestWriter,
  DEFAULT_WINDOWS_BROKER_TIMEOUT_MS,
  WindowsBrokerSandboxBackend,
} from './windows-sandbox.js';
export type {
  WindowsBrokerManifest,
  WindowsSandboxBackendOptions,
} from './windows-sandbox.js';
export { classifyWindowsBrokerFailure } from './windows-broker-errors.js';
export type { WindowsBrokerErrorClassification } from './windows-broker-errors.js';
