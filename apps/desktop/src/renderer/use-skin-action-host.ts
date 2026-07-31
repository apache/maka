import { useEffect, useEffectEvent, useRef } from 'react';
import type { SkinActionName } from '../preload/bridge-contract';

const TRUSTED_GESTURE_WINDOW_MS = 2_500;
const MAX_SUBMIT_TEXT_LENGTH = 32_000;
const SKIN_OWNER_SELECTOR = '[data-maka-skin-overlay], [data-maka-skin-mount]';

function isSkinOwnedTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(SKIN_OWNER_SELECTOR));
}

function respond(
  request: HTMLElement,
  result: { ok: true; value?: unknown } | { ok: false; error: string },
): void {
  request.dataset.makaSkinActionOk = String(result.ok);
  if (result.ok) {
    if (result.value !== undefined) {
      request.dataset.makaSkinActionResult = JSON.stringify(result.value);
    }
  } else {
    request.dataset.makaSkinActionError = result.error;
  }
  request.dispatchEvent(new Event('maka:skin-action-response'));
}

export function useSkinActionHost(options: {
  sessionIds: ReadonlySet<string>;
  canSubmit: boolean;
  canStop: boolean;
  switchSession(sessionId: string): void;
  createTask(): void | Promise<void>;
  submit(text: string): void | Promise<unknown>;
  stop(): void | Promise<void>;
}): void {
  const lastTrustedGestureAtRef = useRef(0);

  const handleRequest = useEffectEvent(async (request: HTMLElement) => {
    const action = request.dataset.makaSkinAction as SkinActionName | undefined;
    if (
      action !== 'navigation.switch-session' &&
      action !== 'task.new' &&
      action !== 'composer.submit' &&
      action !== 'generation.stop'
    ) {
      respond(request, { ok: false, error: 'Unknown skin action.' });
      return;
    }
    if (Date.now() - lastTrustedGestureAtRef.current > TRUSTED_GESTURE_WINDOW_MS) {
      respond(request, {
        ok: false,
        error: 'This action requires a recent trusted click or key press in skin-owned UI.',
      });
      return;
    }
    // One trusted gesture authorizes at most one action request. A skin cannot
    // turn one click into a burst of navigation, submissions, or stops.
    lastTrustedGestureAtRef.current = 0;

    let input: Record<string, unknown>;
    try {
      const parsed = JSON.parse(request.dataset.makaSkinActionInput ?? '{}') as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      input = parsed as Record<string, unknown>;
    } catch {
      respond(request, { ok: false, error: 'Skin action input is invalid.' });
      return;
    }
    const submitText = action === 'composer.submit' && typeof input.text === 'string'
      ? input.text.trim()
      : '';
    if (
      action === 'composer.submit' &&
      (!submitText || submitText.length > MAX_SUBMIT_TEXT_LENGTH)
    ) {
      respond(request, { ok: false, error: 'Prompt text is empty or too large.' });
      return;
    }
    if (
      action === 'navigation.switch-session' &&
      (typeof input.sessionId !== 'string' || !options.sessionIds.has(input.sessionId))
    ) {
      respond(request, { ok: false, error: 'The requested session is not available.' });
      return;
    }
    if (action === 'composer.submit' && !options.canSubmit) {
      respond(request, {
        ok: false,
        error: 'Prompt submission is unavailable while the composer is busy or owns staged user content.',
      });
      return;
    }
    if (action === 'generation.stop' && !options.canStop) {
      respond(request, { ok: false, error: 'There is no active generation to stop.' });
      return;
    }
    if (!(await window.maka.skins.authorizeAction(
      action,
      action === 'composer.submit' ? { textPreview: submitText } : undefined,
    ))) {
      respond(request, { ok: false, error: 'This skin action was not permitted.' });
      return;
    }

    try {
      switch (action) {
        case 'navigation.switch-session': {
          options.switchSession(input.sessionId as string);
          break;
        }
        case 'task.new':
          await options.createTask();
          break;
        case 'composer.submit': {
          await options.submit(submitText);
          break;
        }
        case 'generation.stop':
          await options.stop();
          break;
      }
      respond(request, { ok: true });
    } catch (error) {
      respond(request, {
        ok: false,
        error: error instanceof Error ? error.message : 'Skin action failed.',
      });
    }
  });

  useEffect(() => {
    const rememberTrustedGesture = (event: Event) => {
      if (event.isTrusted && isSkinOwnedTarget(event.target)) {
        lastTrustedGestureAtRef.current = Date.now();
      }
    };
    const receiveRequest = (event: Event) => {
      if (!(event.target instanceof HTMLElement) || !isSkinOwnedTarget(event.target)) return;
      void handleRequest(event.target);
    };
    window.addEventListener('pointerdown', rememberTrustedGesture, true);
    window.addEventListener('keydown', rememberTrustedGesture, true);
    window.addEventListener('maka:skin-action-request', receiveRequest);
    return () => {
      window.removeEventListener('pointerdown', rememberTrustedGesture, true);
      window.removeEventListener('keydown', rememberTrustedGesture, true);
      window.removeEventListener('maka:skin-action-request', receiveRequest);
    };
  }, []);
}
