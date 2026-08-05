import type { QuotaSnapshot, QuotaWindow } from '@maka/core/oauth-subscription';
import {
  OAuthTokenEndpointError,
  OAUTH_PROVIDER_CONTRACTS,
  requireOAuthDataRecord,
} from './oauth-provider-contracts.js';
import { readBoundedOAuthJson } from './oauth-login.js';

export const CLAUDE_SUBSCRIPTION_USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
const USAGE_TIMEOUT_MS = 30_000;
const RESET_TIMESTAMP_MAX_CHARS = 128;

export async function fetchClaudeSubscriptionUsage(input: {
  readonly accessToken: string;
  readonly fetchFn?: typeof fetch;
  readonly now?: () => number;
  readonly signal?: AbortSignal;
}): Promise<QuotaSnapshot> {
  const fetchFn = input.fetchFn ?? fetch;
  const signal = input.signal ?? AbortSignal.timeout(USAGE_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchFn(CLAUDE_SUBSCRIPTION_USAGE_ENDPOINT, {
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        'User-Agent': OAUTH_PROVIDER_CONTRACTS['claude-subscription'].tokenUserAgent,
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
  const fiveHour = quotaWindow(payload.five_hour);
  const sevenDay = quotaWindow(payload.seven_day);
  return {
    ...(fiveHour ? { fiveHour } : {}),
    ...(sevenDay ? { sevenDay } : {}),
    fetchedAt: (input.now ?? Date.now)(),
  };
}

function quotaWindow(value: unknown): QuotaWindow | undefined {
  if (value === undefined) return undefined;
  const record = requireOAuthDataRecord(value);
  if (
    typeof record.utilization !== 'number' ||
    !Number.isFinite(record.utilization) ||
    record.utilization < 0 ||
    record.utilization > 100
  ) {
    return undefined;
  }
  const resetsAt = record.resets_at;
  return {
    utilization: Math.round(record.utilization),
    resetsAt:
      typeof resetsAt === 'string' && resetsAt.length <= RESET_TIMESTAMP_MAX_CHARS ? resetsAt : '',
  };
}
