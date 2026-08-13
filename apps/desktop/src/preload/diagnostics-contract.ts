export interface DesktopExecutionDiagnosticTarget {
  readonly sessionId: string;
  readonly turnId: string;
  readonly eventId: string;
}

export interface DesktopErrorDiagnosticInput {
  readonly surface: 'toast' | 'renderer_crash';
  readonly title: string;
  readonly description?: string;
  readonly details?: string;
  readonly execution?: DesktopExecutionDiagnosticTarget;
  readonly rendererUserAgent?: string;
  readonly rendererLocale?: string;
}

export type DesktopDiagnosticCopyResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'clipboard_unavailable' };
