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

// Overlay renderer entry — hosts the ported CursorEngine on a full-window canvas.
// Receives MAIN-computed, window-local coordinates over a one-way bridge and
// animates the agent cursor. Display-only: it never sends anything back (S15).
// The rAF loop blocks on idle (stops when the engine is at rest; the last frame
// persists), so a resting cursor costs no CPU.
import {
  CURSOR_CLOSE_ENOUGH,
  CursorEngine,
} from '../renderer/computer-use-overlay/engine/cursor-engine.js';

interface MovePayload {
  actionId: string;
  x: number;
  y: number;
  kind?: 'move' | 'click' | 'drag' | 'scroll';
  pressed?: boolean;
  instant?: boolean;
}
interface CompletePayload { actionId?: string; x: number; y: number; kind?: 'move' | 'click' | 'drag' | 'scroll'; pulse?: boolean }
interface CancelPayload { actionId: string }
interface ResetPayload { sessionId: string; generation: number }
declare global {
  interface Window {
    cursorOverlay?: {
      onMove(cb: (p: MovePayload) => void): void;
      onComplete(cb: (p: CompletePayload) => void): void;
      onCancel(cb: (p: CancelPayload) => void): void;
      onReset(cb: (p: ResetPayload) => void): void;
      reportPresentationPhase(
        sessionId: string,
        generation: number,
        actionId: string,
        phase: 'readyForInteraction' | 'finished',
      ): void;
    };
  }
}

// Codex `CloseEnoughConfiguration.default`. The thresholds themselves live in
// the engine module, next to the spring they are read against and next to
// `cursorPresentationReadyDeadlineMs`, which the runtime's fence is sized from:
// a gate the fence is shorter than releases the action mid-flight anyway.
const CLOSE_ENOUGH_PROGRESS_THRESHOLD = CURSOR_CLOSE_ENOUGH.progress;
const CLOSE_ENOUGH_DISTANCE_THRESHOLD = CURSOR_CLOSE_ENOUGH.distance;
// Follow-up: Codex additionally models `CursorNextInteractionTiming { closeEnough,
// finished }`, letting each caller pick between firing at "close enough" and
// firing only at full stop. Maka always uses the closeEnough gate below; adding
// the mode requires a bridge-payload change and is tracked separately.

const canvas = document.getElementById('cursor') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const engine = new CursorEngine();
let dpr = window.devicePixelRatio || 1;

function resize(): void {
  dpr = window.devicePixelRatio || 1;
  engine.setViewport(window.innerWidth, window.innerHeight);
  canvas.width = Math.floor(window.innerWidth * dpr);
  canvas.height = Math.floor(window.innerHeight * dpr);
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
  watchDevicePixelRatio();
}

// `resize` is not enough on its own. The overlay is `movable: false` and
// `resizable: false` and already spans the union of every display, so it is
// never dragged anywhere and never resized by a person — the only way its
// `devicePixelRatio` changes is a display's scale factor changing underneath
// it. When that happens without moving any display, the union rect is
// identical, so `innerWidth`/`innerHeight` do not change and no resize event
// fires, while the backing store stays at the old ratio — a blurry glyph (the
// drawn point stays correct; only the resolution is wrong). Tearing the window
// down used to hide this, because any `display-metrics-changed` rebuilt it; the
// union rect is now compared before rebuilding, which is exactly the case that
// comparison suppresses. A resolution media query is the one signal that fires
// for it, and it fires while the render loop is idle.
let dprQuery: MediaQueryList | undefined;
function onDevicePixelRatioChange(): void {
  resize();
}
function watchDevicePixelRatio(): void {
  if (typeof window.matchMedia !== 'function') return;
  dprQuery?.removeEventListener('change', onDevicePixelRatioChange);
  dprQuery = window.matchMedia(`(resolution: ${dpr}dppx)`);
  dprQuery.addEventListener('change', onDevicePixelRatioChange);
}
resize();
window.addEventListener('resize', resize);

let running = false;
let activeActionId: string | null = null;
let readySent = false;
let waitForNativeCompletion = false;
let sessionId = '';
let generation = 0;

function reportPhase(phase: 'readyForInteraction' | 'finished'): void {
  if (!activeActionId) return;
  window.cursorOverlay?.reportPresentationPhase(
    sessionId,
    generation,
    activeActionId,
    phase,
  );
}

function loop(now: number): void {
  // The engine owns the frame clock. This line used to be
  // `engine.tick(Math.min(0.05, (now - last) / 1000))`, which truncated a long
  // frame to the integrator's stability bound one call before the engine
  // sub-stepped it — so the release gate opened later in wall clock the slower
  // the overlay painted, and the deadline the runtime's fence is sized from
  // held only at frame rates nobody had measured.
  engine.tickTo(now);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  engine.paint(ctx, 0, 0); // MAIN sends window-local coords, so origin is (0,0)
  if (
    !readySent
    && (
      !engine.hasMotionPath()
      || engine.motionProgress() >= CLOSE_ENOUGH_PROGRESS_THRESHOLD
      || engine.motionDistanceRemaining() <= CLOSE_ENOUGH_DISTANCE_THRESHOLD
    )
  ) {
    readySent = true;
    reportPhase('readyForInteraction');
  }
  if (engine.isMoving()) {
    requestAnimationFrame(loop);
  } else {
    running = false; // block on idle — leave the last frame painted
    if (!waitForNativeCompletion) {
      reportPhase('finished');
      activeActionId = null;
    }
  }
}
function kick(): void {
  if (!running) {
    running = true;
    requestAnimationFrame(loop);
  }
}

window.cursorOverlay?.onReset((p) => {
  sessionId = p.sessionId;
  generation = p.generation;
  engine.setSession(sessionId);
  kick();
});
window.cursorOverlay?.onMove((p) => {
  activeActionId = p.actionId;
  readySent = false;
  waitForNativeCompletion = true;
  if (p.instant === true) engine.completeAt(p.x, p.y);
  else engine.moveTo(p.x, p.y);
  engine.pressed = p.pressed === true;
  kick();
});
window.cursorOverlay?.onComplete((p) => {
  if (p.actionId && activeActionId && p.actionId !== activeActionId) return;
  if (p.actionId) activeActionId = p.actionId;
  waitForNativeCompletion = false;
  engine.completeAt(p.x, p.y, p.pulse === true);
  kick();
});
window.cursorOverlay?.onCancel((p) => {
  if (!activeActionId || p.actionId !== activeActionId) return;
  engine.cancel();
  readySent = true;
  waitForNativeCompletion = false;
  kick();
});
