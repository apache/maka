export const EXECUTION_LOG_LEDGERS = ['runtime_event', 'runtime_event_projection'] as const;
export type ExecutionLogLedger = (typeof EXECUTION_LOG_LEDGERS)[number];

export interface ExecutionLogCursor {
  readonly ledger: ExecutionLogLedger;
  readonly streamId: string;
  readonly sequence: number;
  readonly eventId?: string;
}

/** Inclusive coverage of one ordered Runtime log or projection stream. */
export interface ExecutionLogCoverage {
  readonly highWater: ExecutionLogCursor;
  readonly lowWater?: ExecutionLogCursor;
  readonly eventCount?: number;
}
