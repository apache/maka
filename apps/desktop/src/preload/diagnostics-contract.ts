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

export interface DesktopErrorDiagnosticInput {
  readonly surface: 'toast' | 'renderer_crash';
  readonly title: string;
  readonly description?: string;
  readonly details?: string;
  readonly target?: DesktopDiagnosticTarget;
}

export type DesktopDiagnosticInput = DesktopManualDiagnosticInput | DesktopErrorDiagnosticInput;

/**
 * Runtime Host authority attached to one diagnostic request.
 *
 * `none` is intentionally distinct from `default`: renderer-local failures
 * have no Runtime Host whose logs can be attributed to them, while a manual
 * capture with no explicit task asks for the current default Host.
 */
export type DesktopDiagnosticHostTarget = 'none' | 'default' | 'task';

export type DesktopManualDiagnosticWireInput = Omit<DesktopManualDiagnosticInput, 'target'> &
  DesktopDiagnosticRendererContext & {
    readonly hostTarget: Exclude<DesktopDiagnosticHostTarget, 'none'>;
  };

export type DesktopErrorDiagnosticWireInput = Omit<DesktopErrorDiagnosticInput, 'target'> &
  DesktopDiagnosticRendererContext & {
    readonly hostTarget: DesktopDiagnosticHostTarget;
    readonly execution?: DesktopExecutionDiagnosticTarget;
  };

export type DesktopDiagnosticWireInput =
  | DesktopManualDiagnosticWireInput
  | DesktopErrorDiagnosticWireInput;
