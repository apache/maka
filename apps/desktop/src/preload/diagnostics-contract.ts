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

export type DesktopDiagnosticHostTarget = 'default' | 'task';

export type DesktopManualDiagnosticWireInput = Omit<DesktopManualDiagnosticInput, 'target'> &
  DesktopDiagnosticRendererContext & {
    readonly hostTarget: DesktopDiagnosticHostTarget;
  };

export type DesktopErrorDiagnosticWireInput = DesktopErrorDiagnosticInput &
  DesktopDiagnosticRendererContext & {
    readonly hostTarget: DesktopDiagnosticHostTarget;
  };

export type DesktopDiagnosticWireInput =
  | DesktopManualDiagnosticWireInput
  | DesktopErrorDiagnosticWireInput;
