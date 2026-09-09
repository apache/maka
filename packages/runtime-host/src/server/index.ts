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
  RuntimeHostKernel,
  type RuntimeHostComposition,
} from './host-kernel.js';
export { defineInteractiveRuntimeHostComposition } from './host-composition.js';
export { createUnavailableDomainOperationHandlers } from './operation-dispatcher.js';
export { startExecutionRuntimeHostService } from './execution-service.js';
export { runRuntimeHostProcessLifecycle } from './process-lifecycle.js';
export {
  createPeerMeshOperationHandlers,
  projectPeerMeshQuery,
  projectPeerMeshStatus,
} from './peer-mesh-authority.js';
export { installRuntimeHostLogCapture } from '../process-diagnostics.js';
export {
  readRuntimeHostAccessCredentialMetadata,
  type RuntimeHostAccessCredentialMetadata,
} from './access-credential-metadata.js';
export {
  ExtensionBundleError,
  exportExtensionBundle,
  materializeExtensionPackage,
} from './extension-bundle.js';
export {
  EXTENSION_PACKAGE_MANIFEST_FILE,
  ExtensionPackageManifestError,
  decodeExtensionPackageManifest,
  loadExtensionPackageManifest,
  validateExtensionConfiguration,
  type ExtensionConfigurationProperty,
  type ExtensionConfigurationScalar,
  type ExtensionConfigurationSchema,
  type ExtensionPackageDependency,
  type ExtensionPackageComposition,
  type ExtensionPackageManifest,
  type ExtensionPackageRuntime,
} from './extension-package-manifest.js';
export {
  PluginCompositionPatchError,
  loadPluginCompositionPatch,
} from './plugin-composition-patch.js';
export {
  HostPluginPlatform,
  HostPluginPlatformError,
  type HostPluginPlatformFailure,
} from './plugin-platform.js';
export { HostPluginPlatformCoordinator } from './plugin-platform-coordinator.js';
