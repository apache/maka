export {
  RuntimeHostKernel,
  RuntimeHostProcessTerminationRequiredError,
  type RuntimeHostComposition,
  type RuntimeHostCompositionContext,
  type RuntimeHostCompositionFactory,
  type RuntimeHostKernelOptions,
  type RuntimeHostLifecycleMode,
  type RuntimeHostResidency,
} from './host-kernel.js';
export {
  beginRuntimeHostDomainModuleDrain,
  closeRuntimeHostDomainModules,
  composeRuntimeHostDomainHandlers,
  defineInteractiveRuntimeHostComposition,
  defineRuntimeHostComposition,
  HOST_RECOVERY_PHASES,
  INTERACTIVE_HOST_COMPOSITION_DESCRIPTOR,
  normalizeHostCompositionDescriptor,
  recoverRuntimeHostDomainModules,
  type HostCompositionDescriptor,
  type HostRecoveryPhase,
  type RuntimeHostDomainModule,
  type RuntimeHostCompositionSource,
} from './host-composition.js';
export {
  startInteractiveRuntimeHostCandidate,
  type InteractiveRuntimeHostCandidateOptions,
  type InteractiveRuntimeHostCandidateResult,
} from './candidate.js';
export { createUnavailableDomainOperationHandlers } from './operation-dispatcher.js';
export {
  HostExtensionRuntime,
  type HostExtensionToolResolver,
  type HostPreparedPluginPackageInput,
  type HostToolExtensionInput,
  type HostTrustedToolExtensionInput,
  type HostUiExtensionInput,
  type HostExtensionInput,
  type HostExtensionEventDispatchResult,
} from './extension-runtime.js';
export {
  HostExtensionLoaderError,
  InstalledPluginPackageLoader,
  StaticTrustedToolExtensionLoader,
  type HostTrustedToolExtensionLoader,
  type StaticTrustedToolExtension,
} from './extension-loader.js';
export {
  PluginPackageStore,
  PluginPackageStoreError,
  type InstalledPluginPackage,
} from './plugin-package-store.js';
export { PluginHookActivation } from './plugin-hook-activation.js';
export { HostExtensionPackageManagementTools } from './extension-package-management-tools.js';
export {
  decodeExtensionPackageManifest,
  loadExtensionPackageManifest,
  validateExtensionConfiguration,
  type ExtensionPackageManifest,
  type ExtensionPackageDependency,
  type ExtensionConfigurationSchema,
} from './extension-package-manifest.js';
export {
  exportExtensionBundle,
  materializeExtensionPackage,
  ExtensionBundleError,
} from './extension-bundle.js';
export { HostPluginCompositionStore } from './plugin-composition-store.js';
export {
  RuntimeHostRootAlreadyOwnedError,
  startExecutionRuntimeHostService,
  type ExecutionRuntimeHostServiceDependencies,
  type ExecutionRuntimeHostServiceOptions,
} from './execution-service.js';
export {
  runRuntimeHostProcessLifecycle,
  type RuntimeHostProcessLifecycleOptions,
} from './process-lifecycle.js';
export { installRuntimeHostLogCapture } from '../process-diagnostics.js';
export {
  createRuntimeHostListenerSet,
  startRuntimeHostServiceListenerSet,
  startLocalRuntimeHostListenerSet,
  type RuntimeHostListenerSet,
  type RuntimeHostListener,
  type RuntimeHostListenerConnection,
  type RuntimeHostListenerKind,
  type RuntimeHostListenerSetFactory,
  type RuntimeHostListenerSetFactoryInput,
} from './listener-set.js';
export {
  startRuntimeHostWebSocketListener,
  type RuntimeHostWebSocketTls,
  type StartRuntimeHostWebSocketListenerOptions,
} from './websocket-listener.js';
export {
  openRuntimeHostAccessAuthority,
  type RuntimeHostAccessAuthority,
} from './access-authority.js';
export {
  createRuntimeHostConnectionAuthority,
  LOCAL_OWNER_CONNECTION_AUTHORITY,
  type RuntimeHostConnectionAuthority,
} from './connection-authority.js';
export type { RuntimeHostMessageTransport } from '../transport/message-transport.js';
