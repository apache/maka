// What the metering proxy observed, and nothing that can be worked out from it.
//
// These counts cross a process boundary twice: the wrapper reports them in its
// result frame, and writes them to a checkpoint the host reads when the wrapper
// was killed before it could report. Anything derivable — settled requests,
// missing usage, whether the figure is complete, what it cost — is computed by
// `deriveMetering` on whichever side needs it, so the two sides cannot hold two
// versions of a value neither of them owns.
//
// `inFlightRequests` is the only field that separates the two readers: it is
// zero by construction once the proxy has settled, and may be positive in a
// checkpoint written mid-request.
export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

export interface ProviderMeteringCounts {
  readonly usage: ProviderUsage | null;
  // Whether the proxy had settled when these counts were taken. Only the proxy
  // can observe that, and no arrangement of the counts implies it: a checkpoint
  // written between two requests carries the same zero in flight as a final one.
  readonly settled: boolean;
  readonly requests: number;
  readonly inFlightRequests: number;
  readonly admittedRequests: number;
  readonly usageRequests: number;
  readonly removedWebTools: number;
  readonly models: readonly string[];
  readonly toolNames: readonly string[];
}

export interface DerivedMetering {
  readonly settledRequests: number;
  readonly missingUsageRequests: number;
  readonly usageComplete: boolean;
  readonly costUsd: number | null;
  readonly tokenBasis: 'complete' | 'lower-bound';
}

// Cost is reported only for a complete figure. A partial token count is still
// worth recording as a lower bound, but a cost derived from it would enter the
// result kernel as a number indistinguishable from a settled one.
export function deriveMetering(counts: ProviderMeteringCounts): DerivedMetering {
  const usageComplete =
    counts.settled &&
    counts.admittedRequests > 0 &&
    counts.usageRequests === counts.admittedRequests;
  return {
    settledRequests: counts.requests - counts.inFlightRequests,
    missingUsageRequests: counts.admittedRequests - counts.usageRequests,
    usageComplete,
    costUsd: counts.usage && usageComplete ? deepSeekCostUsd(counts.usage) : null,
    tokenBasis: usageComplete ? 'complete' : 'lower-bound',
  };
}

// Published DeepSeek V4 Flash prices, in USD per million tokens. Eval bills
// every arm from this table rather than from each arm's own transcription of
// it, so a difference in reported cost can only come from a difference in what
// the agent spent. Pi is additionally handed the table for its own display; the
// other frameworks are given no cost block at all, which is why their figures
// are not consulted here.
//
// Rates as published 2026-08-17, normalized at the off-peak band: DeepSeek
// bills peak hours (01:00–04:00 and 06:00–10:00 UTC) at exactly double these,
// and the checkpoint records no request timestamps to split by.
//
// DeepSeek bills input in exactly two kinds, cache hit and cache miss, and
// charges nothing for writing the cache — a written token is a miss token. So
// `cacheWrite` is the miss rate rather than a rate of its own: it exists to
// keep a provider that reports cache writes separately from being billed at
// zero, and for DeepSeek itself it never applies, because the API reports only
// `prompt_cache_hit_tokens` and `prompt_cache_miss_tokens`.
export const DEEPSEEK_V4_FLASH_COST = {
  input: 0.22,
  output: 0.66,
  cacheRead: 0.007,
  cacheWrite: 0.22,
} as const;

// `inputTokens` is normalized to include both cached kinds, so each kind is
// subtracted out and charged at its own rate. Leaving cache writes subtracted
// but unpriced billed them at zero.
export function deepSeekCostUsd(usage: ProviderUsage): number {
  const uncached = Math.max(0, usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens);
  return (
    (uncached * DEEPSEEK_V4_FLASH_COST.input +
      usage.cacheReadTokens * DEEPSEEK_V4_FLASH_COST.cacheRead +
      usage.cacheWriteTokens * DEEPSEEK_V4_FLASH_COST.cacheWrite +
      usage.outputTokens * DEEPSEEK_V4_FLASH_COST.output) /
    1_000_000
  );
}
