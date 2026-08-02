import { useEffect, useMemo, useState } from 'react';
import { useResizable } from '@astryxdesign/core/Resizable';
import { readSessionListCollapsed, readSessionListWidth } from './session-list-layout';
import {
  readSessionWorkbarCollapsed,
  readSessionWorkbarTab,
  readSessionWorkbarWidth,
  SESSION_WORKBAR_MAX_WIDTH,
  SESSION_WORKBAR_MIN_WIDTH,
} from './session-workbar-layout';

/**
 * Owns the shell layout state (issue #1043): widths, collapse flags and the
 * active workbar tab, each hydrated from localStorage on first render and
 * persisted by `useAppShellPersistenceEffects`.
 *
 * `useResizable` owns the workbar's clamping and its pointer/keyboard resizing
 * (issue #1861), but not its persistence: `autoSaveId` writes synchronously on
 * every committed size, which is ~90 localStorage writes for one drag. Storage
 * stays on the same debounced effect as the session list, so seeding
 * `defaultSize` from storage is what closes the loop.
 */
export function useShellLayout() {
  const [sessionListWidth, setSessionListWidth] = useState(() => readSessionListWidth());
  const [sessionListCollapsed, setSessionListCollapsed] = useState(() => readSessionListCollapsed());
  const [workbarCollapsed, setWorkbarCollapsed] = useState(() => readSessionWorkbarCollapsed());
  // Read once: useResizable only consumes defaultSize on its first render, and
  // AppShell re-renders on every stream tick.
  const [workbarDefaultWidth] = useState(() => readSessionWorkbarWidth());
  const workbar = useResizable({
    defaultSize: workbarDefaultWidth,
    minSizePx: SESSION_WORKBAR_MIN_WIDTH,
    maxSizePx: SESSION_WORKBAR_MAX_WIDTH,
  });
  // `_onResizeMove` takes the distance from where the pointer went down, not a
  // per-move increment, so rounding here quantises the drag to whole pixels
  // without accumulating drift. Every other delta the handle sends (arrow keys,
  // Home/End) is already integral. Keeping the hook's own state integral is what
  // lets `aria-valuenow`, the CSS variable and storage agree on one number —
  // rounding at the consumer only fixed the last two.
  const workbarResizable = useMemo(
    () => ({
      ...workbar.props,
      _onResizeMove: (delta: number) => workbar.props._onResizeMove(Math.round(delta)),
    }),
    [workbar.props],
  );
  // Astryx ends a drag on pointerup, pointercancel or unmount, but not on focus
  // loss: Cmd+Tab mid-drag and release outside the app leaves the listeners
  // attached and `body` stuck at `cursor: col-resize; user-select: none`. The
  // deleted hand-rolled resize cleaned up on blur; this routes blur back into
  // Astryx's own cancel path rather than re-growing a second teardown.
  useEffect(() => {
    const cancelDrag = () => window.dispatchEvent(new PointerEvent('pointercancel'));
    window.addEventListener('blur', cancelDrag);
    return () => window.removeEventListener('blur', cancelDrag);
  }, []);
  const [workbarTab, setWorkbarTab] = useState(() => readSessionWorkbarTab());
  return {
    sessionListWidth,
    setSessionListWidth,
    sessionListCollapsed,
    setSessionListCollapsed,
    workbarCollapsed,
    setWorkbarCollapsed,
    workbarWidth: workbar.size,
    workbarResizable,
    workbarTab,
    setWorkbarTab,
  };
}
