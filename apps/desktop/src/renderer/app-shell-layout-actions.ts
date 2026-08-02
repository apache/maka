import type { KeyboardEvent, PointerEvent } from 'react';
import {
  clampSessionWorkbarWidth,
  SESSION_WORKBAR_MAX_WIDTH,
  SESSION_WORKBAR_MIN_WIDTH,
} from './session-workbar-layout.js';

type NumberStateUpdater = (next: number) => void;

export interface AppShellLayoutActions {
  startWorkbarResize(event: PointerEvent<HTMLDivElement>): void;
  onWorkbarResizeHandleKeyDown(event: KeyboardEvent<HTMLDivElement>): void;
}

export function createAppShellLayoutActions(deps: {
  workbarCollapsed: boolean;
  workbarWidth: number;
  setWorkbarWidth: NumberStateUpdater;
}): AppShellLayoutActions {
  const {
    workbarCollapsed,
    workbarWidth,
    setWorkbarWidth,
  } = deps;

  function startWorkbarResize(event: PointerEvent<HTMLDivElement>) {
    if (workbarCollapsed) return;
    event.preventDefault();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* pointer capture can fail if the target is detached mid-drag */
    }
    const startX = event.clientX;
    const start = workbarWidth;
    document.body.classList.add('isResizingWorkbar');
    let cleaned = false;

    function onMove(moveEvent: globalThis.PointerEvent) {
      setWorkbarWidth(clampSessionWorkbarWidth(start + startX - moveEvent.clientX));
    }

    function cleanupResize() {
      if (cleaned) return;
      cleaned = true;
      document.body.classList.remove('isResizingWorkbar');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', cleanupResize);
      window.removeEventListener('pointercancel', cleanupResize);
      window.removeEventListener('blur', cleanupResize);
    }

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', cleanupResize);
    window.addEventListener('pointercancel', cleanupResize);
    window.addEventListener('blur', cleanupResize);
  }

  function onWorkbarResizeHandleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (workbarCollapsed) return;
    const SMALL = 10;
    const LARGE = 50;
    let next = workbarWidth;
    switch (event.key) {
      case 'ArrowLeft':
        next = workbarWidth + (event.shiftKey ? LARGE : SMALL);
        break;
      case 'ArrowRight':
        next = workbarWidth - (event.shiftKey ? LARGE : SMALL);
        break;
      case 'Home':
        next = SESSION_WORKBAR_MIN_WIDTH;
        break;
      case 'End':
        next = SESSION_WORKBAR_MAX_WIDTH;
        break;
      default:
        return;
    }
    event.preventDefault();
    setWorkbarWidth(clampSessionWorkbarWidth(next));
  }

  return {
    startWorkbarResize,
    onWorkbarResizeHandleKeyDown,
  };
}
