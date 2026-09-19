/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

/**
 * Provider account usage, normalized into `@maka/core/connection-usage`.
 *
 * The dispatch is one `switch`: each provider that reports usage owns a mapper
 * from its own endpoints to the shared window list, and every other provider
 * answers `unavailable: unsupported`. The card that renders the result never
 * learns the provider — only the windows and stats this produces.
 */
import type { ProviderType } from '@maka/core/llm-connections';
import type {
  ConnectionUsageReport,
  ConnectionUsageResult,
  UsageStats,
  UsageWindow,
} from '@maka/core/connection-usage';
import { providerReportsUsage } from '@maka/core/connection-usage';
import { commandCodeCliHeaders } from './commandcode-cli-language-model.js';
import { fetchForConnectionEffect, type ConnectionEffectFetch } from './connection-effect-fetch.js';

export interface ConnectionUsageInput {
  readonly providerType: ProviderType;
  readonly apiKey: string | undefined;
  readonly baseUrl: string | undefined;
  /** Injected for tests; production passes nothing and the global fetch is used. */
  readonly fetch?: ConnectionEffectFetch;
}

export async function fetchConnectionUsage(
  input: ConnectionUsageInput,
): Promise<ConnectionUsageResult> {
  if (!providerReportsUsage(input.providerType)) {
    return { kind: 'unavailable', reason: 'unsupported' };
  }
  switch (input.providerType) {
    case 'commandcode-go':
      return fetchCommandCodeGoUsage(input);
    // `commandcode` (the Provider-API plan) is deliberately NOT wired yet: its
    // usage lives behind the same `/alpha/*` endpoints, but only a GO-tier key
    // has been verified against them. Wiring it from inference alone could
    // mis-report a plan's windows, which is worse than showing nothing.
    default:
      return { kind: 'unavailable', reason: 'unsupported' };
  }
}

/**
 * Command Code's account endpoints, fetched together with per-endpoint
 * degradation: whichever endpoints answer, their facts land in the report, and
 * only a total failure (no credential, or nothing answered) becomes
 * `unavailable`.
 */
async function fetchCommandCodeGoUsage(
  input: ConnectionUsageInput,
): Promise<ConnectionUsageResult> {
  if (!input.apiKey) return { kind: 'unavailable', reason: 'no-credential' };
  const base = (input.baseUrl ?? 'https://api.commandcode.ai').replace(/\/+$/u, '');
  const headers = commandCodeCliHeaders(input.apiKey, 'maka');
  // One endpoint's outcome. A 401/403 is kept as `unauthorized` rather than
  // flattened into "no data": the caller has to be able to tell a dead key from
  // an unreachable host, because only one of the two is fixed on this page.
  type Endpoint =
    | { ok: true; body: Record<string, unknown> | undefined }
    | { ok: false; unauthorized: boolean };
  const get = async (path: string): Promise<Endpoint> => {
    try {
      const response = await fetchForConnectionEffect(input.fetch, `${base}${path}`, { headers });
      if (!response.ok) {
        return { ok: false, unauthorized: response.status === 401 || response.status === 403 };
      }
      return {
        ok: true,
        body: (await response.readJson<unknown>()) as Record<string, unknown> | undefined,
      };
    } catch {
      return { ok: false, unauthorized: false };
    }
  };

  const [whoami, summary, credits, subscriptions] = await Promise.all([
    get('/alpha/whoami'),
    get('/alpha/usage/summary'),
    get('/alpha/billing/credits'),
    get('/alpha/billing/subscriptions'),
  ]);
  const endpoints = [whoami, summary, credits, subscriptions];
  const answered = endpoints.filter((endpoint) => endpoint.ok) as Array<
    Extract<Endpoint, { ok: true }>
  >;
  const refused = endpoints.some((endpoint) => !endpoint.ok && endpoint.unauthorized);
  if (answered.length === 0) {
    // Every endpoint failed at once. If any rejection was an auth rejection, the
    // credential is the problem, not the network.
    return { kind: 'unavailable', reason: refused ? 'unauthorized' : 'network' };
  }
  // Some answered and some refused: a key that is valid but lacks a scope. The
  // read is reported (so the card shows what it has) with the refusal flagged, so
  // it can also say why the rest is missing — otherwise a partial report reads
  // as a complete one and the page cannot name the credential as the cause.
  const partiallyUnauthorized = refused;
  const body = (endpoint: Extract<Endpoint, { ok: true }>) => endpoint.body;
  const [whoamiBody, summaryBody, creditsBody, subscriptionsBody] = [
    whoami.ok ? body(whoami) : undefined,
    summary.ok ? body(summary) : undefined,
    credits.ok ? body(credits) : undefined,
    subscriptions.ok ? body(subscriptions) : undefined,
  ];

  const plan = subscriptionFacts(subscriptionsBody);
  const windowLimits = record(record(creditsBody)?.windowLimits);
  const windows: UsageWindow[] = [];
  const fiveHour = parseWindow('fiveHour', windowLimits?.fiveHour);
  if (fiveHour) windows.push(fiveHour);
  const weekly = parseWindow('weekly', windowLimits?.weekly);
  if (weekly) windows.push(weekly);
  const monthly = parseMonthly(creditsBody, plan);
  if (monthly) windows.push(monthly);

  const stats = parseStats(summaryBody);
  const report: ConnectionUsageReport = {
    ...(accountLabel(whoamiBody) !== undefined ? { accountLabel: accountLabel(whoamiBody)! } : {}),
    ...(plan.name !== undefined ? { planLabel: plan.name } : {}),
    ...(stats !== undefined ? { stats } : {}),
    windows,
    ...(plan.periodEnd !== undefined ? { periodEnd: plan.periodEnd } : {}),
    ...(partiallyUnauthorized ? { partiallyUnauthorized: true } : {}),
    fetchedAt: Date.now(),
  };
  return { kind: 'report', report };
}

/**
 * `command-code` subscription plans and their monthly credit allowance. The
 * billing endpoint reports the monthly REMAINING balance, not the total, so the
 * monthly window's cap has to come from the plan — the same table the official
 * CLI resolves `getPlanInfo` from. Longest-prefix match so `individual-pro-v1`
 * wins over `individual-pro`.
 */
const SUBSCRIPTION_PLAN_MONTHLY_CREDITS: Readonly<Record<string, number>> = {
  'individual-go': 10,
  'individual-goat': 70,
  'individual-pro-v1': 80,
  'individual-pro': 30,
  'individual-provider': 15,
  'individual-max': 150,
  'individual-ultra': 300,
  'teams-pro': 40,
};
const SUBSCRIPTION_PLAN_NAMES: Readonly<Record<string, string>> = {
  'individual-go': 'Go',
  'individual-goat': 'GOAT',
  'individual-pro': 'Pro',
  'individual-provider': 'Provider',
  'individual-max': 'Max',
  'individual-ultra': 'Ultra',
  'teams-pro': 'Teams Pro',
};

interface PlanFacts {
  readonly name?: string;
  readonly monthlyCredits?: number;
  readonly periodEnd?: number;
}

function subscriptionFacts(subscriptions: Record<string, unknown> | undefined): PlanFacts {
  const data = record(subscriptions?.data);
  const planId = text(data?.planId);
  const periodEnd = date(data?.currentPeriodEnd);
  if (planId === undefined) return periodEnd === undefined ? {} : { periodEnd };
  const prefixes = Object.keys(SUBSCRIPTION_PLAN_MONTHLY_CREDITS).sort(
    (a, b) => b.length - a.length,
  );
  const prefix = prefixes.find((candidate) => planId.startsWith(candidate));
  return {
    ...(prefix === undefined ? {} : { name: SUBSCRIPTION_PLAN_NAMES[prefix] }),
    ...(prefix === undefined ? {} : { monthlyCredits: SUBSCRIPTION_PLAN_MONTHLY_CREDITS[prefix] }),
    ...(periodEnd === undefined ? {} : { periodEnd }),
  };
}

function parseWindow(id: 'fiveHour' | 'weekly', value: unknown): UsageWindow | undefined {
  const block = record(value);
  if (block === undefined) return undefined;
  const used = number(block.used);
  const cap = number(block.cap);
  if (used === undefined && cap === undefined) return undefined;
  const resetAt = number(block.resetAt);
  return {
    id,
    used: used ?? 0,
    cap: cap ?? 0,
    unit: 'credits',
    ...(resetAt !== undefined && resetAt > 0 ? { resetsAt: resetAt } : {}),
  };
}

/**
 * The monthly window: cap from the plan, consumed = cap − remaining balance.
 * Absent unless both the plan's total and the reported remaining balance are
 * known — an unknown plan would otherwise render `limit − 0`, i.e. a confident
 * "100% used" that is really "we do not know the limit".
 */
function parseMonthly(
  credits: Record<string, unknown> | undefined,
  plan: PlanFacts,
): UsageWindow | undefined {
  const remaining = number(record(record(credits)?.credits)?.monthlyCredits);
  if (plan.monthlyCredits === undefined || remaining === undefined) return undefined;
  const used = Math.max(0, plan.monthlyCredits - remaining);
  return {
    id: 'monthly',
    used,
    cap: plan.monthlyCredits,
    unit: 'credits',
    ...(plan.periodEnd !== undefined ? { resetsAt: plan.periodEnd } : {}),
  };
}

function parseStats(summary: Record<string, unknown> | undefined): UsageStats | undefined {
  if (summary === undefined) return undefined;
  const stats: UsageStats = {
    ...(number(summary.totalCount) !== undefined ? { requests: number(summary.totalCount)! } : {}),
    ...(number(summary.failedCount) !== undefined ? { failed: number(summary.failedCount)! } : {}),
    ...(number(summary.successRate) !== undefined
      ? { successRate: number(summary.successRate)! }
      : {}),
    ...(number(summary.totalCost) !== undefined ? { cost: number(summary.totalCost)! } : {}),
    ...(number(summary.totalTokensIn) !== undefined
      ? { tokensIn: number(summary.totalTokensIn)! }
      : {}),
    ...(number(summary.totalTokensOut) !== undefined
      ? { tokensOut: number(summary.totalTokensOut)! }
      : {}),
  };
  return Object.keys(stats).length > 0 ? stats : undefined;
}

function accountLabel(whoami: Record<string, unknown> | undefined): string | undefined {
  const user = record(whoami?.user);
  return text(user?.userName) ?? text(user?.name);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function date(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}
