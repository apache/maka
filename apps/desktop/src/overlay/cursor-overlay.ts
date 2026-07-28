// Overlay renderer entry — hosts the ported CursorEngine on a full-window canvas.
// Receives MAIN-computed, window-local coordinates over a one-way bridge and
// animates the agent cursor. Display-only: it never sends anything back (S15).
// The rAF loop blocks on idle (stops when the engine is at rest; the last frame
// persists), so a resting cursor costs no CPU.
import { CursorEngine } from '../renderer/computer-use-overlay/engine/cursor-engine.js';

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

// Codex `CloseEnoughConfiguration.default`, recovered from the inspected build
// (doubles at 0x100d68cd0 / 0x100d68cd8). The action is released only once the
// cursor has effectively landed; releasing earlier makes the click visibly fire
// while the glyph is still travelling.
const CLOSE_ENOUGH_PROGRESS_THRESHOLD = 0.995;
const CLOSE_ENOUGH_DISTANCE_THRESHOLD = 3.157;
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
}
resize();
window.addEventListener('resize', resize);

let running = false;
let last = 0;
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
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  engine.tick(dt);
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
    last = performance.now();
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
