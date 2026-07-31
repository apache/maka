import {
  useCallback,
  useLayoutEffect,
  useRef,
  type RefObject,
} from 'react';

export type ModalFocusTarget =
  | RefObject<HTMLElement | null>
  | (() => HTMLElement | boolean | null | undefined)
  | boolean;

function activeElement(): HTMLElement | null {
  return typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;
}

function resolveFocusTarget(
  target: ModalFocusTarget | undefined,
): HTMLElement | boolean | null | undefined {
  if (typeof target === 'function') return target();
  if (typeof target === 'object' && target) return target.current;
  return target;
}

/**
 * Completes the focus lifecycle when a controlled modal is conditionally
 * unmounted. Astryx restores focus when `isOpen` changes to false, but it
 * cannot do so after its owner removes the dialog in the same update.
 */
export function useModalFocusLifecycle(options: {
  isOpen: boolean;
  initialFocus?: ModalFocusTarget;
  finalFocus?: ModalFocusTarget;
}): void {
  const { isOpen } = options;
  const initialFocusRef = useRef(options.initialFocus);
  const finalFocusRef = useRef(options.finalFocus);
  const openerRef = useRef<HTMLElement | null>(null);
  const renderedOpenRef = useRef(false);
  const committedOpenRef = useRef(false);
  const mountedRef = useRef(false);
  const frameRef = useRef(0);

  initialFocusRef.current = options.initialFocus;
  finalFocusRef.current = options.finalFocus;

  if (isOpen && !renderedOpenRef.current) {
    openerRef.current = activeElement();
  }
  renderedOpenRef.current = isOpen;

  const cancelScheduledFocus = useCallback(() => {
    if (typeof cancelAnimationFrame !== 'undefined') {
      cancelAnimationFrame(frameRef.current);
    }
  }, []);

  const scheduleInitialFocus = useCallback(() => {
    cancelScheduledFocus();
    if (typeof requestAnimationFrame === 'undefined') return;
    frameRef.current = requestAnimationFrame(() => {
      const target = resolveFocusTarget(initialFocusRef.current);
      if (target instanceof HTMLElement && target.isConnected) target.focus();
    });
  }, [cancelScheduledFocus]);

  const scheduleFinalFocus = useCallback(() => {
    cancelScheduledFocus();
    if (typeof requestAnimationFrame === 'undefined') return;
    const opener = openerRef.current;
    frameRef.current = requestAnimationFrame(() => {
      const target = resolveFocusTarget(finalFocusRef.current);
      if (target === false) {
        if (activeElement() === opener) opener?.blur();
        return;
      }
      const destination = target instanceof HTMLElement ? target : opener;
      if (!destination?.isConnected) return;
      const activeDialog = activeElement()?.closest('dialog[open]');
      if (activeDialog && !activeDialog.contains(destination)) return;
      destination.focus();
    });
  }, [cancelScheduledFocus]);

  useLayoutEffect(() => {
    const wasOpen = committedOpenRef.current;
    committedOpenRef.current = isOpen;
    if (isOpen && !wasOpen) scheduleInitialFocus();
    if (!isOpen && wasOpen) scheduleFinalFocus();
  }, [isOpen, scheduleFinalFocus, scheduleInitialFocus]);

  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      queueMicrotask(() => {
        if (!mountedRef.current && committedOpenRef.current) scheduleFinalFocus();
      });
    };
  }, [scheduleFinalFocus]);
}
