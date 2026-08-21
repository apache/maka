export interface DesktopExecutionDiagnosticTarget {
  readonly sessionId: string;
  readonly turnId: string;
  readonly eventId: string;
}

interface DesktopDiagnosticRendererContext {
  readonly rendererUserAgent?: string;
  readonly rendererLocale?: string;
}

export type DesktopManualDiagnosticTarget =
  | {
      readonly kind: 'session';
      readonly sessionId: string;
    }
  | {
      readonly kind: 'profile';
      readonly profileId: string;
    };

export interface DesktopManualDiagnosticInput {
  readonly surface: 'manual';
  readonly target?: DesktopManualDiagnosticTarget;
}

export interface DesktopErrorDiagnosticInput {
  readonly surface: 'toast' | 'renderer_crash';
  readonly title: string;
  readonly description?: string;
  readonly details?: string;
  readonly execution?: DesktopExecutionDiagnosticTarget;
}

export type DesktopDiagnosticInput = DesktopManualDiagnosticInput | DesktopErrorDiagnosticInput;

export type DesktopManualDiagnosticRuntimeHost =
  | { readonly kind: 'default' }
  | { readonly kind: 'target'; readonly hostId: string }
  | { readonly kind: 'unavailable' };

export type DesktopManualDiagnosticWireInput = Omit<DesktopManualDiagnosticInput, 'target'> &
  DesktopDiagnosticRendererContext & {
    readonly runtimeHost: DesktopManualDiagnosticRuntimeHost;
  };

export type DesktopErrorDiagnosticWireInput = DesktopErrorDiagnosticInput &
  DesktopDiagnosticRendererContext;

export type DesktopDiagnosticWireInput =
  | DesktopManualDiagnosticWireInput
  | DesktopErrorDiagnosticWireInput;
