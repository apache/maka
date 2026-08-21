export type HistoryCompactSummarizerFailureReason =
  | 'output_length'
  | 'input_too_large'
  | 'provider_error'
  | 'invalid_provider_state'
  | 'malformed_summary_missing_section'
  | 'malformed_summary_truncated'
  | 'malformed_summary_too_small_for_fold';

export class HistoryCompactSummarizerError extends Error {
  constructor(
    readonly reason: HistoryCompactSummarizerFailureReason,
    options?: ErrorOptions,
  ) {
    super(`History compact summarizer failed: ${reason}`, options);
    this.name = 'HistoryCompactSummarizerError';
  }
}
