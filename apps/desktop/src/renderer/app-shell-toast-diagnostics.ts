import type { ToastErrorAction } from '@maka/ui';
import type { DesktopErrorDiagnosticInput } from '../preload/diagnostics-contract.js';

type ErrorToastInput = Parameters<ToastErrorAction['onClick']>[0];

export function diagnosticInputForErrorToast(
  input: ErrorToastInput,
): DesktopErrorDiagnosticInput {
  const target = input.diagnosticTarget;
  return {
    surface: 'toast',
    title: input.title,
    ...(input.description ? { description: input.description } : {}),
    ...(input.diagnosticDetails ? { details: input.diagnosticDetails } : {}),
    ...(target && 'profileId' in target
      ? { target: { kind: 'profile', profileId: target.profileId } }
      : target && 'turnId' in target
        ? { execution: target }
        : target
          ? { target: { kind: 'session', sessionId: target.sessionId } }
          : {}),
  };
}
