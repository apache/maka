export type HistoryCompactSummarizerFailureReason =
  | 'output_length'
  | 'provider_error'
  | 'malformed_summary';

export class HistoryCompactSummarizerError extends Error {
  constructor(
    readonly reason: HistoryCompactSummarizerFailureReason,
    options?: ErrorOptions,
  ) {
    super(`History compact summarizer failed: ${reason}`, options);
    this.name = 'HistoryCompactSummarizerError';
  }
}
