/**
 * Maps Windows sandbox broker rejections (surfaced on stderr as
 * `broker rejected request (<code>): <message>` by the launcher's
 * broker_client) onto filesystem-worker error classification, so callers see
 * a stable reason instead of a generic worker crash.
 */

export interface WindowsBrokerErrorClassification {
  readonly reason: 'invalid_request' | 'spawn_failed';
  /** True when a retry with a fresh nonce/manifest may succeed. */
  readonly recoverable: boolean;
  readonly brokerCode: string;
}

const BROKER_REJECTION_PATTERN = /broker rejected request \(([a-z_]+)\)/u;

export function classifyWindowsBrokerFailure(
  stderrTail: string | undefined,
): WindowsBrokerErrorClassification | undefined {
  const code = stderrTail?.match(BROKER_REJECTION_PATTERN)?.[1];
  switch (code) {
    case 'invalid_request':
      return { reason: 'invalid_request', recoverable: false, brokerCode: code };
    // Transient identity/nonce races: a fresh request produces a fresh nonce
    // and reconnected PID, so retrying is meaningful.
    case 'client_pid_mismatch':
    case 'nonce_replayed':
    case 'nonce_capacity_exceeded':
      return { reason: 'invalid_request', recoverable: true, brokerCode: code };
    // Policy disagreements between runtime and broker: retrying the same
    // manifest cannot succeed.
    case 'profile_not_approved':
    case 'profile_digest_mismatch':
      return { reason: 'invalid_request', recoverable: false, brokerCode: code };
    case 'appcontainer_launch_failed':
      return { reason: 'spawn_failed', recoverable: false, brokerCode: code };
    default:
      return undefined;
  }
}
