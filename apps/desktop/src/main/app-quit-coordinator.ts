export interface AppQuitEvent {
  preventDefault(): void;
}

export interface AppQuitCoordinator {
  focusOrCreateWindow(): void;
  getWindowCreationSignal(): AbortSignal | undefined;
  handleBeforeQuit(event: AppQuitEvent): void;
}

export interface AppQuitCoordinatorDeps {
  cleanup(): Promise<void>;
  focusOrCreateWindow(signal: AbortSignal): void;
  onCleanupError(error: unknown): void;
  resumeQuit(): void;
}

type AppQuitPhase = 'running' | 'cleaning' | 'ready-to-exit';

export function createAppQuitCoordinator(deps: AppQuitCoordinatorDeps): AppQuitCoordinator {
  let phase: AppQuitPhase = 'running';
  const windowCreationAbort = new AbortController();

  return {
    focusOrCreateWindow(): void {
      if (phase !== 'running') return;
      deps.focusOrCreateWindow(windowCreationAbort.signal);
    },
    getWindowCreationSignal(): AbortSignal | undefined {
      return phase === 'running' ? windowCreationAbort.signal : undefined;
    },
    handleBeforeQuit(event): void {
      if (phase === 'ready-to-exit') return;
      event.preventDefault();
      if (phase === 'cleaning') return;
      phase = 'cleaning';
      windowCreationAbort.abort();
      const finishCleanup = () => {
        // `before-quit` was cancelled inside Electron's native quit transaction.
        // Resuming from the cleanup Promise's microtask re-enters that transaction:
        // Electron closes the windows but emits `window-all-closed` instead of
        // `will-quit`, leaving the macOS process alive. Start a fresh transaction
        // only after the current event-loop turn has unwound.
        setImmediate(() => {
          phase = 'ready-to-exit';
          deps.resumeQuit();
        });
      };
      void deps.cleanup().then(finishCleanup, (error) => {
        deps.onCleanupError(error);
        finishCleanup();
      });
    },
  };
}
