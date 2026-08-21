export interface DesktopExecutionDiagnosticTarget {
  readonly sessionId: string;
  readonly turnId: string;
  readonly eventId: string;
}

interface DesktopDiagnosticRendererContext {
  readonly rendererUserAgent?: string;
  readonly rendererLocale?: string;
}

export interface DesktopManualDiagnosticInput extends DesktopDiagnosticRendererContext {
  readonly surface: 'manual';
}

export interface DesktopErrorDiagnosticInput extends DesktopDiagnosticRendererContext {
  readonly surface: 'toast' | 'renderer_crash';
  readonly title: string;
  readonly description?: string;
  readonly details?: string;
  readonly execution?: DesktopExecutionDiagnosticTarget;
}

export type DesktopDiagnosticInput = DesktopManualDiagnosticInput | DesktopErrorDiagnosticInput;

export type DesktopDiagnosticCopyResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'clipboard_unavailable' };
