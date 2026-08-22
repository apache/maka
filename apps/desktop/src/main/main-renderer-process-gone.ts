import type { RenderProcessGoneDetails } from 'electron';

export function shouldReportMainRendererProcessGone(
  details: RenderProcessGoneDetails,
  shutdownSignal: AbortSignal,
): boolean {
  return !shutdownSignal.aborted && details.reason !== 'clean-exit';
}
