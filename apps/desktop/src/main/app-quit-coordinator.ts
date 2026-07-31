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
        phase = 'ready-to-exit';
        deps.resumeQuit();
      };
      void deps.cleanup().then(finishCleanup, (error) => {
        deps.onCleanupError(error);
        finishCleanup();
      });
    },
  };
}
