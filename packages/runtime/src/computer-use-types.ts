import type {
  ComputerUseDispatchTier,
  ComputerUseDisplayIdentity,
  ComputerUseEffect,
  ComputerUseErrorCode,
  ComputerUsePageIdentity,
  CuAction,
  CuPoint,
} from '@maka/core/computer-use';
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
      /**
       * The message may be shown to the model.
       *
       * Set only by a backend that guarantees its diagnostics carry no text
       * belonging to the observed application — `maka.cu/2` §1.2 makes that a
       * protocol rule. Absent means withheld, so a backend that forgets is
       * quiet rather than leaky.
       */
      messageIsAppTextFree?: boolean;
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

export interface CuLaunchedApp {
  pid: number;
  bundleId?: string;
  name?: string;
  windows: Array<{ windowId: number; title?: string }>;
  /**
   * False when the launched app took the foreground despite the driver's
   * demotion attempt. Absent when the driver did not run that check.
   */
  focusHeld?: boolean;
}

export interface CuObservedElement {
  elementId: string;
  role: string;
  /**
   * The AX subrole, when the element carries one.
   *
   * `AXSecureTextField` is the one that matters most: it is how a password
   * field is distinguishable from any other text field, and the tool
   * description told the model it could not be told apart — while the executor
   * was sending it and the host was dropping it. It also names the window
   * buttons (`AXCloseButton`, `AXMinimizeButton`, `AXZoomButton`), which
   * otherwise arrive as three unlabelled `AXButton`s.
   */
  subrole?: string;
  label?: string;
  value?: string;
  /**
   * Prompt text a control shows while it is empty.
   *
   * Never folded into `value`, because it is the opposite of one: it reads like
   * content while the field holds nothing, so a model that saw it as a value
   * would skip a field it still has to fill, or read the prompt back as data.
   *
   * The executor sends it and the protocol validates it; it was being dropped
   * on the way here — the third field to go missing at this exact boundary,
   * after `subrole` and `window_action`'s wire schema.
   */
  placeholder?: string;
  /** False when the control is present but cannot currently be actuated. */
  enabled?: boolean;
  /**
   * What this control offers beyond a plain click, from the executor's closed
   * set of normalised names.
   *
   * `secondary_action` takes one of these, and the set was model-invisible: the
   * schema said only "Required for secondary_action", so a model had to guess a
   * name and be told it was outside the protocol's action set. `raise` is the
   * one window-management verb that exists anywhere in this surface, and it was
   * undiscoverable for the same reason.
   */
  actions?: string[];
  /** True for the one element the window currently gives keys to. */
  focused?: boolean;
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

export interface CuObservationDifference {
  baseObservationId: string;
  presentation: 'no-change' | 'difference' | 'full';
  changes: Array<{
    kind: 'remove' | 'insert' | 'update';
    path: number[];
    stableId: number;
    elementId?: string;
  }>;
  removedStableIdRanges: Array<{ start: number; end: number }>;
}

export interface CuObservation {
  observationId: string;
  /**
   * §5.8 — how much of the menu bar this observation walked.
   *
   * Present whenever a menu was asked for. `opened` names the one menu whose
   * commands are listed; without it the observation carries the bar's top level
   * and nothing below, which is the affordable default and is also the state a
   * model has to be told about — a list of menu names with no note that they
   * open reads as a list of things that cannot be used.
   *
   * `unavailable` is the host's own word, not the executor's: it is set when a
   * menu was asked for and the observation came back with no menu bar in it at
   * all. An executor that does not walk the menu bar is a real configuration —
   * the cua-driver backend never returned one — and without this the model read
   * a description promising "every observation already lists the menu titles",
   * asked for a menu, and got a document that did not mention menus.
   */
  menu?: { opened?: string; truncated?: boolean; unavailable?: boolean };
  /**
   * The filter this observation was asked for, echoed so the rendering can say
   * it is showing a part rather than the whole.
   *
   * The filtering itself is done by the renderer, so the host stamps this from
   * the request when the executor does not echo it. It used to be read only
   * from the executor's answer, and the one shipped executor did not return it:
   * a model that asked for a filtered view of a 1,200-element window received
   * all 1,200 elements under a header that said nothing about a query.
   */
  query?: string;
  difference?: CuObservationDifference;
  /** Post-action observations may render only their declared difference. */
  renderDifference?: boolean;
  appId: string;
  pid: number;
  windowId: number;
  windowTitle?: string;
  /**
   * The name the caller used, when it was not the canonical one.
   *
   * An app is identified by its localized display name, so "Dictionary"
   * resolves to 词典 through an alias. A model that got an observation that way
   * will keep saying "Dictionary" on the next call, and the target-hint check
   * compares strings — without this it would answer `target_mismatch` to a name
   * that had just worked.
   */
  appAlias?: string;
  capturedAt?: number;
  windowBounds?: { x: number; y: number; width: number; height: number };
  sourceBoundsPx?: { x: number; y: number; width: number; height: number };
  zIndex?: number;
  /**
   * Screen rectangles stacked above this window. Presentation-only: the agent
   * cursor checks the point it is about to draw at, since a control near the
   * top edge can be visible while the middle of the window is buried.
   */
  obscuringRects?: Array<{ x: number; y: number; width: number; height: number }>;
  bundleId?: string;
  contentFingerprint?: string;
  page?: ComputerUsePageIdentity;
  displays?: ComputerUseDisplayIdentity[];
  /**
   * The tree was cut short, so absence proves nothing.
   *
   * The executor bounds its walk by element count and by a clock, and a window
   * whose accessibility tree is hosted by another process reaches both: an
   * open/save panel measured 1,500 elements in 35s. A partial tree that arrives
   * looking complete is worse than a slow one, because a model reading it
   * concludes the control it wants does not exist and goes looking for another
   * route. This says the list is a prefix, not an inventory.
   */
  truncated?: boolean;
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
      /**
       * Scroll an element rather than a point.
       *
       * The coordinate `scroll` aims at a pixel and needs a visible window to
       * anchor the conversion; this addresses the scroll area itself, which is
       * the difference that shows when the window is behind something else.
       * `maka.cu/2` declares it (`{kind:"scroll", direction, pages}`) and
       * cua-driver advertises `scroll` among its element actions, so both
       * executors already speak it — this is the member that lets Maka say it.
       */
      type: 'scroll_element';
      observationId: string;
      elementId: string;
      direction: 'up' | 'down' | 'left' | 'right';
      /** Pages, the unit both executors declare. Defaults to one. */
      pages?: number;
      elementIdentity?: CuObservedElement['identity'];
    }
  | {
      /**
       * Move, resize or minimise the window an observation describes.
       *
       * A window's position and size are settable accessibility attributes —
       * measured across 17 applications, `AXPosition` on all of them and
       * `AXSize` on 14 — and writing them does not bring the application
       * forward. So this was always reachable; what was missing was a way to
       * say it. A model asked to move a window reached for a title-bar drag
       * instead, which needs a coordinate, which needs the window not to be
       * covered, which a background window always is.
       *
       * `position` is in screen points, the same space as the observation's
       * `windowBounds` and `displays[].logicalBounds`.
       */
      type: 'window_action';
      observationId: string;
      /** The window itself, which is the observation's first element. */
      elementId: string;
      action: 'move' | 'resize' | 'minimize';
      position?: { x: number; y: number };
      size?: { width: number; height: number };
      elementIdentity?: CuObservedElement['identity'];
    }
  | {
      type: 'press_key';
      observationId: string;
      key: string;
      /** The control to focus before the key is posted, when the model named one. */
      elementId?: string;
      elementIdentity?: CuObservedElement['identity'];
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
  /**
   * How long the producer needs, at worst, before `readyForInteraction`
   * resolves on its own.
   *
   * The fence's backstop timeout is a safety net for a presentation layer that
   * dies, not a second opinion on how long a motion takes. When the producer
   * knows its own worst case — the cursor overlay derives it from the spring
   * the release gate is read against — it says so here, and the backstop is
   * sized from it rather than from a constant chosen elsewhere. Absent, the
   * caller's own default applies.
   */
  readyTimeoutMs?: number;
}

export interface CuOverlayHookContext {
  sessionId: string;
  toolCallId: string;
  presentationScreenPoint?: CuPoint;
  /**
   * The window this action is bound to, so a resting cursor can be ordered
   * directly above it. Absent when the action names no window, in which case
   * the cursor rests at a fixed level instead.
   */
  targetWindowId?: number;
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
  /**
   * Ask the native executor to show the Accessibility consent prompt.
   *
   * This is separate from `preflight`: the latter runs before every action and
   * must stay free of presentation side effects. The tool layer invokes this
   * seam at most once, when an explicit Computer Use call first finds the grant
   * missing.
   */
  requestAccessibilityPermission?(signal: AbortSignal): Promise<void>;
  listApps?(signal: AbortSignal): Promise<CuAppSummary[]>;
  /**
   * Start an app in the background. The launched app must not take focus —
   * the whole point of a background launch is that the user keeps theirs.
   */
  launchApp?(
    input: { app: string },
    signal: AbortSignal,
    context: CuRunContext,
  ): Promise<CuLaunchedApp>;
  observeApp?(
    input: {
      app?: string;
      windowId?: number;
      includeScreenshot: boolean;
      menu?: string;
      query?: string;
    },
    signal: AbortSignal,
    context: CuRunContext,
  ): Promise<CuObservation>;
  runSemantic?(
    action: CuSemanticAction,
    signal: AbortSignal,
    context: CuRunContext,
  ): Promise<CuRunResult>;
  captureObservation?(
    input: {
      app?: string;
      windowId?: number;
      /**
       * Pinned to `true` while every caller wanted one. They no longer do: a
       * capture between the steps of a sequence exists to find the next control
       * by name, and asking for pixels there made one slow capture end the
       * whole sequence.
       */
      includeScreenshot: boolean;
      menu?: string;
      query?: string;
    },
    signal: AbortSignal,
    context: CuRunContext,
  ): Promise<CuObservation>;
  /** Execute one normalized action; capture a fresh frame where applicable. */
  run(action: CuAction, signal: AbortSignal, context: CuRunContext): Promise<CuRunResult>;
  clearSession?(sessionId: string): void;
}
