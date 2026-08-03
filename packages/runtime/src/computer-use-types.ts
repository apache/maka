import type {
  ComputerUseDispatchTier,
  ComputerUseDisplayIdentity,
  ComputerUseEffect,
  ComputerUseErrorCode,
  ComputerUsePageIdentity,
  CuAction,
  CuPoint,
} from '@maka/core';
import type { CuaBoundAction } from './cua-frame-state.js';

export interface CuScreenshot {
  base64: string;
  mimeType: 'image/png' | 'image/jpeg';
  widthPx: number;
  heightPx: number;
}

export interface CuDispatchEvidence {
  path?: string;
  effect?: ComputerUseEffect;
  reason?: string;
}

export type CuDispatchOutcome =
  | {
      ok: true;
      tier: ComputerUseDispatchTier;
      verified?: boolean;
      evidence?: CuDispatchEvidence;
      completedSubSteps?: number;
    }
  | {
      ok: false;
      error: ComputerUseErrorCode;
      message: string;
      evidence?: CuDispatchEvidence;
      completedSubSteps?: number;
    };

export interface CuRunResult {
  outcome: CuDispatchOutcome;
  /** Final logical screen point resolved by the backend for pointer actions. */
  resolvedScreenPoint?: CuPoint;
  /** Present for `screenshot`, and (by convention) after a mutating action so
   *  the model can SEE the result — the authoritative verification (S17). */
  screenshot?: CuScreenshot;
  observation?: CuObservation;
}

export interface CuAppSummary {
  appId: string;
  pid: number;
  name?: string;
  windowCount: number;
  windows?: Array<{ windowId: number; title?: string }>;
}

export interface CuObservedElement {
  elementId: string;
  role: string;
  label?: string;
  value?: string;
  /** False when the control is present but cannot currently be actuated. */
  enabled?: boolean;
  /** Selection state for controls that carry one (checkbox, radio, tab, row). */
  selected?: boolean;
  /** `elementId` of this element's parent, when the observation reports a tree. */
  parentElementId?: string;
  frame?: { x: number; y: number; width: number; height: number };
  identity?: {
    token?: string;
    role: string;
    label?: string;
    value?: string;
  };
}

export interface CuObservation {
  observationId: string;
  appId: string;
  pid: number;
  windowId: number;
  windowTitle?: string;
  capturedAt?: number;
  windowBounds?: { x: number; y: number; width: number; height: number };
  sourceBoundsPx?: { x: number; y: number; width: number; height: number };
  zIndex?: number;
  bundleId?: string;
  contentFingerprint?: string;
  page?: ComputerUsePageIdentity;
  displays?: ComputerUseDisplayIdentity[];
  elements: CuObservedElement[];
  screenshot?: CuScreenshot;
}

export type CuSemanticAction =
  | {
      type: 'click_element';
      observationId: string;
      elementId: string;
      elementIdentity?: CuObservedElement['identity'];
    }
  | {
      type: 'set_value';
      observationId: string;
      elementId: string;
      value: string;
      elementIdentity?: CuObservedElement['identity'];
    }
  | {
      type: 'select_text';
      observationId: string;
      elementId: string;
      text: string;
      elementIdentity?: CuObservedElement['identity'];
    }
  | {
      type: 'secondary_action';
      observationId: string;
      elementId: string;
      action: string;
      elementIdentity?: CuObservedElement['identity'];
    }
  | {
      type: 'press_key';
      observationId: string;
      key: string;
    };

export interface CuRunContext {
  sessionId: string;
  turnId: string;
  toolCallId: string;
  boundAction?: CuaBoundAction;
}

export interface CuPresentationFence {
  readyForInteraction: Promise<void>;
  finished: Promise<void>;
}

export interface CuOverlayHookContext {
  sessionId: string;
  toolCallId: string;
  presentationScreenPoint?: CuPoint;
}

export interface CuOverlayHook {
  onActionBegin(action: CuAction, context: CuOverlayHookContext): CuPresentationFence | void;
  onActionEnd?(
    action: CuAction,
    result: CuRunResult | undefined,
    context: CuOverlayHookContext,
  ): void | Promise<void>;
}

/**
 * The host dispatch seam. Implemented in @maka/computer-use by the maka-cu
 * backend, which spawns the maka-cu executor and speaks `maka.cu/2` over stdio.
 * Alternative backends can plug in behind this same interface later.
 */
export interface CuDispatchBackend {
  /** Live macOS TCC status. Called at EVERY action-start — cached "granted" is
   *  insufficient because the user can revoke at any time (S12). */
  preflight(signal: AbortSignal): Promise<{ accessibility: boolean; screenRecording: boolean }>;
  listApps?(signal: AbortSignal): Promise<CuAppSummary[]>;
  observeApp?(
    input: { app?: string; windowId?: number; includeScreenshot: boolean },
    signal: AbortSignal,
    context: CuRunContext,
  ): Promise<CuObservation>;
  runSemantic?(
    action: CuSemanticAction,
    signal: AbortSignal,
    context: CuRunContext,
  ): Promise<CuRunResult>;
  captureObservation?(
    input: { app?: string; windowId?: number; includeScreenshot: true },
    signal: AbortSignal,
    context: CuRunContext,
  ): Promise<CuObservation>;
  /** Execute one normalized action; capture a fresh frame where applicable. */
  run(action: CuAction, signal: AbortSignal, context: CuRunContext): Promise<CuRunResult>;
  clearSession?(sessionId: string): void;
}
