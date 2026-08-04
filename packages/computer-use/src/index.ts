export {
  selectComputerUseBackend,
  CU_BACKEND_IDS,
  DEFAULT_CU_BACKEND_ID,
} from './select-backend.js';
export type {
  ComputerUseBackendSelection,
  CuBackendId,
  MakaCuSelection,
  SelectedComputerUseBackend,
} from './select-backend.js';

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
