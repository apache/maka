import type { CandidateStartupFailureReason } from '../candidate-startup-failure.js';
import { RuntimeHostPermanentReconnectError } from './reconnect-lifecycle.js';

export type RuntimeHostStartupFailureReason =
  | CandidateStartupFailureReason
  | 'composition_mismatch'
  | 'startup_timeout'
  | 'host_unresponsive';

export class RuntimeHostStartupError extends RuntimeHostPermanentReconnectError {
  readonly name = 'RuntimeHostStartupError';

  constructor(
    readonly reason: 'stored_data_incompatible' | 'composition_mismatch',
    message: string,
  ) {
    super(message);
  }
}

export function runtimeHostStartupError(reason: RuntimeHostStartupFailureReason): Error {
  switch (reason) {
    case 'stored_data_incompatible':
      return new RuntimeHostStartupError(
        reason,
        'Maka cannot read part of this workspace’s stored data. The workspace was left in place. Update Maka or report diagnostic code STORED_DATA_INCOMPATIBLE.',
      );
    case 'internal_startup_failure':
      return new Error(
        'Runtime Host failed while recovering this workspace. Try again; if the problem persists, report diagnostic code INTERNAL_STARTUP_FAILURE.',
      );
    case 'composition_mismatch':
      return new RuntimeHostStartupError(
        reason,
        'This workspace belongs to a different Runtime Host composition. Diagnostic code: COMPOSITION_MISMATCH.',
      );
    case 'startup_timeout':
      return new Error('Runtime Host did not become ready before the startup deadline');
    case 'host_unresponsive':
      return new Error('Runtime Host stopped responding during startup');
  }
}
