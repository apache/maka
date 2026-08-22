import type { RenderProcessGoneDetails } from 'electron';

interface RenderProcessGoneSource {
  once(
    event: 'render-process-gone',
    listener: (event: unknown, details: RenderProcessGoneDetails) => void,
  ): void;
}

export function observeMainRendererProcessGone(deps: {
  readonly source: RenderProcessGoneSource;
  readonly shutdownSignal: AbortSignal;
  readonly onUnexpectedExit: (details: RenderProcessGoneDetails) => void;
}): void {
  deps.source.once('render-process-gone', (_event, details) => {
    if (deps.shutdownSignal.aborted || details.reason === 'clean-exit') return;
    deps.onUnexpectedExit(details);
  });
}
