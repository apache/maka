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

import type { Result } from '@maka/core/result';
import type { DesktopSessionUsageSummary } from './bridge-contract.js';

/** The narrow invoke surface the usage overview needs; injectable for tests. */
export type UsageSummaryInvoke = (
  channel: 'usage:summary',
  scope: unknown,
  args: Record<string, unknown>,
) => Promise<Result<DesktopSessionUsageSummary>>;

/**
 * The overview reads the Session's whole metered spend and, separately, the
 * agent loop's own calls: auxiliary prompts do not share the main loop's
 * cached prefix, so a blended rate under-reports it (#5691).
 *
 * The main-only read refines the cache rate; losing it must not lose the
 * overview — but it must also not pass the blended rate off as the main
 * loop's, so the failure is marked and the rate hides itself (#5691).
 */
export async function loadSessionUsageSummaryVia(
  invoke: UsageSummaryInvoke,
  session: { readonly scope: unknown; readonly sessionId: string },
): Promise<Result<DesktopSessionUsageSummary>> {
  const summaryQuery = { range: 'all' as const, sessionId: session.sessionId };
  // A rejected secondary invoke (transport/IPC crash rather than an
  // operation-level failure) must not take the whole overview down with it —
  // it marks the summary unavailable like any other main-read failure (#5691
  // review).
  const [summary, main] = (await Promise.all([
    invoke('usage:summary', session.scope, summaryQuery),
    invoke('usage:summary', session.scope, { ...summaryQuery, callKinds: ['main'] }).catch(
      () => ({ ok: false, error: { code: 'persistence_failed', message: 'usage read failed' } }),
    ),
  ])) as [Result<DesktopSessionUsageSummary>, Result<DesktopSessionUsageSummary>];
  if (!summary.ok) return summary;
  return main.ok
    ? { ...summary, data: { ...summary.data, mainSummary: main.data } }
    : { ...summary, data: { ...summary.data, mainSummaryUnavailable: true } };
}
