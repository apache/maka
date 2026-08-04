export {
  selectComputerUseBackend,
  CU_BACKEND_IDS,
  DEFAULT_CU_BACKEND_ID,
} from './select-backend.js';
export type {
  ComputerUseBackendSelection,
  CuaDriverSelection,
  CuBackendId,
  MakaCuSelection,
  SelectedComputerUseBackend,
} from './select-backend.js';

export { createCuaDriverBackend } from './cua-driver-backend.js';
export type { CuaDriverBackendOptions, CuaDriverTraceEvent } from './cua-driver-backend.js';
export { normalizeCuaDriverOutcome } from './cua-driver-result.js';
export type { JsonRpcToolResult } from './cua-driver-result.js';
export {
  CuaDriverLifecycleError,
  cuaDriverLifecycleMessage,
  isCuaDriverLifecycleError,
} from './cua-driver-release.js';
export type {
  CuaDriverChildState,
  CuaDriverLifecycleErrorCode,
  CuaDriverReleaseEvent,
  CuaDriverRequestStage,
  CuaDriverRole,
  CuaDriverRoleSnapshot,
} from './cua-driver-release.js';
export { CuaDriverService } from './cua-driver-service.js';
export type {
  CuaDriverJsonRpcResponse,
  CuaDriverServiceOptions,
} from './cua-driver-service.js';
export { resolveCuaPageTextTarget } from './cua-driver-page-target.js';
export type {
  CuaCdpPageTarget,
  CuaFocusedPageElement,
  CuaPageTargetResolverDeps,
  CuaResolvedPageTextTarget,
  CuaSemanticPointerAction,
  CuaSemanticPointerResult,
} from './cua-driver-page-target.js';
export {
  CUA_INSPECT_PREPARED_ELEMENT_SCRIPT,
  buildCuaPrepareElementAtScreenPointScript,
  buildCuaSemanticPointerActionScript,
  parseCuaFocusedPageElement,
  parseCuaSemanticPointerResult,
} from './cua-driver-page-target.js';
export {
  editableElementAtScreenPoint,
  elementAtScreenPoint,
  normalizeCuaSnapshotElement,
  resolveWindowAtDeclaredPoint,
  windowPointFromSnapshot,
} from './cua-driver-snapshot.js';
export type {
  CuaResolvedWindow,
  CuaSnapshotElement,
  CuaWindowBounds,
  CuaWindowRecord,
} from './cua-driver-snapshot.js';

export { createMakaCuBackend } from './maka-cu-backend.js';
export type { MakaCuBackendOptions, MakaCuTraceEvent } from './maka-cu-backend.js';
export {
  MakaCuLifecycleError,
  MakaCuRpcError,
  MakaCuService,
  isMakaCuLifecycleError,
} from './maka-cu-service.js';
export type {
  MakaCuCapabilities,
  MakaCuHandshake,
  MakaCuLimits,
  MakaCuReleaseEvent,
  MakaCuServiceOptions,
  MakaCuServiceSnapshot,
} from './maka-cu-service.js';
export {
  MAKA_CU_PROTOCOL_VERSION,
  MAKA_CU_RPC_ERROR,
  MakaCuProtocolViolation,
  mapMakaCuDomainError,
  readDispatchResult,
  readEnvelope,
  readSnapshot,
} from './maka-cu-protocol.js';
export type {
  MakaCuDispatchResult,
  MakaCuDomainError,
  MakaCuElement,
  MakaCuEnvelope,
  MakaCuSnapshot,
} from './maka-cu-protocol.js';
export { decodeJsonLines } from './stdio-json-rpc.js';
export type { HostLifecycleErrorCode, HostRequestStage } from './stdio-json-rpc.js';

export { resolveCuaDisplaySnapshots } from './display-snapshot.js';
export type { CuaHostDisplay } from './display-snapshot.js';
export { createComputerUseOverlayHook } from './computer-use-overlay-hook.js';
export type {
  CursorActionKind,
  CursorCancelInput,
  CursorCompleteInput,
  CursorMoveInput,
  OverlayCursorSink,
} from './computer-use-overlay-hook.js';
