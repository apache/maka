export interface DesktopExecutionDiagnosticTarget {
  readonly sessionId: string;
  readonly turnId: string;
  readonly eventId: string;
  readonly profileId?: never;
}

interface DesktopDiagnosticRendererContext {
  readonly rendererUserAgent?: string;
  readonly rendererLocale?: string;
}

export type DesktopManualDiagnosticTarget =
  | {
      readonly sessionId: string;
      readonly profileId?: never;
      readonly turnId?: never;
      readonly eventId?: never;
    }
  | {
      readonly profileId: string;
      readonly sessionId?: never;
      readonly turnId?: never;
      readonly eventId?: never;
    };

export type DesktopDiagnosticTarget =
  | DesktopManualDiagnosticTarget
  | DesktopExecutionDiagnosticTarget;

export interface DesktopManualDiagnosticInput {
  readonly surface: 'manual';
  readonly target?: DesktopManualDiagnosticTarget;
}

interface DesktopErrorDiagnosticDetails {
  readonly title: string;
  readonly description?: string;
  readonly details?: string;
}

export type DesktopErrorDiagnosticInput = DesktopErrorDiagnosticDetails &
  (
    | {
        readonly surface: 'toast';
        readonly target?: DesktopDiagnosticTarget;
      }
    | {
        readonly surface: 'renderer_crash';
        readonly target?: never;
      }
  );

export type DesktopDiagnosticInput = DesktopManualDiagnosticInput | DesktopErrorDiagnosticInput;

export type DesktopManualDiagnosticWireInput = Omit<DesktopManualDiagnosticInput, 'target'> &
  DesktopDiagnosticRendererContext & {
    readonly hostTarget: 'default' | 'task';
  };

export type DesktopErrorDiagnosticWireInput = DesktopErrorDiagnosticDetails &
  DesktopDiagnosticRendererContext &
  (
    | {
        readonly surface: 'toast';
        readonly hostTarget: 'none';
        readonly execution?: never;
      }
    | {
        readonly surface: 'toast';
        readonly hostTarget: 'task';
        readonly execution?: DesktopExecutionDiagnosticTarget;
      }
    | {
        readonly surface: 'renderer_crash';
        readonly hostTarget: 'none';
        readonly execution?: never;
      }
  );

export type DesktopDiagnosticWireInput =
  | DesktopManualDiagnosticWireInput
  | DesktopErrorDiagnosticWireInput;
