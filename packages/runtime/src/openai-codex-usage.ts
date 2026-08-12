import type { QuotaSnapshot, QuotaWindow } from '@maka/core/oauth-subscription';
import { OAuthTokenEndpointError, requireOAuthDataRecord } from './oauth-provider-contracts.js';
import { readBoundedOAuthJson } from './oauth-login.js';
import { openAiCodexHeaders } from './subscription-auth.js';

export const OPENAI_CODEX_USAGE_ENDPOINT = 'https://chatgpt.com/backend-api/wham/usage';
const USAGE_TIMEOUT_MS = 10_000;
const FIVE_HOURS_SECONDS = 5 * 60 * 60;
const SEVEN_DAYS_SECONDS = 7 * 24 * 60 * 60;

/** Reads ChatGPT/Codex quota windows without sending a model request. */
export async function fetchOpenAiCodexUsage(input: {
  readonly accessToken: string;
  readonly fetchFn?: typeof fetch;
  readonly now?: () => number;
  readonly signal?: AbortSignal;
}): Promise<QuotaSnapshot> {
  const fetchFn = input.fetchFn ?? fetch;
  const signal = input.signal ?? AbortSignal.timeout(USAGE_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchFn(OPENAI_CODEX_USAGE_ENDPOINT, {
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        ...openAiCodexHeaders(input.accessToken),
      },
      signal,
    });
  } catch {
    throw new OAuthTokenEndpointError(signal.aborted ? 'aborted' : 'outcome_unknown');
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new OAuthTokenEndpointError('provider_rejected', response.status);
  }

  const payload = requireOAuthDataRecord(await readBoundedOAuthJson(response, signal));
  const rateLimit = requireOAuthDataRecord(payload.rate_limit);
  const windows = [rateLimit.primary_window, rateLimit.secondary_window]
    .map(quotaWindow)
    .filter((window): window is QuotaWindowWithDuration => window !== undefined);
  const fiveHour = windows.find((window) => window.durationSeconds === FIVE_HOURS_SECONDS);
  const sevenDay = windows.find((window) => window.durationSeconds === SEVEN_DAYS_SECONDS);
  return {
    ...(fiveHour ? { fiveHour: stripDuration(fiveHour) } : {}),
    ...(sevenDay ? { sevenDay: stripDuration(sevenDay) } : {}),
    fetchedAt: (input.now ?? Date.now)(),
  };
}

interface QuotaWindowWithDuration extends QuotaWindow {
  readonly durationSeconds: number;
}

function quotaWindow(value: unknown): QuotaWindowWithDuration | undefined {
  if (value === undefined || value === null) return undefined;
  const record = requireOAuthDataRecord(value);
  if (
    typeof record.used_percent !== 'number' ||
    !Number.isFinite(record.used_percent) ||
    record.used_percent < 0 ||
    record.used_percent > 100 ||
    typeof record.limit_window_seconds !== 'number' ||
    !Number.isFinite(record.limit_window_seconds)
  ) {
    return undefined;
  }
  const resetAt = record.reset_at;
  return {
    utilization: Math.round(record.used_percent),
    resetsAt:
      typeof resetAt === 'number' && Number.isFinite(resetAt)
        ? new Date(resetAt * 1_000).toISOString()
        : '',
    durationSeconds: Math.round(record.limit_window_seconds),
  };
}

function stripDuration(window: QuotaWindowWithDuration): QuotaWindow {
  return { utilization: window.utilization, resetsAt: window.resetsAt };
}
