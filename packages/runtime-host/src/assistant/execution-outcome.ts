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

/** An idle failed turn is not a permission request. */
export function awaitingUser(snapshot: any): boolean {
  return (
    snapshot?.agent?.status === 'waiting_for_user' ||
    (snapshot?.agent?.status === 'blocked' && snapshot?.pendingInteractions !== 0)
  );
}

export interface ExecutionFailure {
  kind: string;
  message: string;
  retryable: boolean;
}

const transientKinds = new Set([
  'network',
  'timeout',
  'stream_truncated',
  'provider_unavailable',
  'provider_capacity',
  'rate_limit',
]);

/** Use the terminal record of THIS execution, never an older failure in its Session. */
export async function executionFailure(
  agent: any,
  turnId: string,
): Promise<ExecutionFailure | undefined> {
  const transcript = await agent.transcript();
  if (!Array.isArray(transcript)) return;
  const terminal = [...transcript]
    .reverse()
    .find((m: any) => m?.type === 'turn_state' && m.turnId === turnId);
  if (!terminal || !terminal.errorClass) return;
  return {
    kind: terminal.errorClass,
    message: terminal.failureMessage || `Execution ended: ${terminal.errorClass}`,
    // A declined replay after tool activity must not become an automatic whole-turn replay.
    retryable:
      transientKinds.has(terminal.errorClass) &&
      !['side_effects', 'observable_output', 'budget'].includes(terminal.retry?.because),
  };
}

export function recoveryDelay(failures: number): number {
  return Math.min(30 * 60_000, 30_000 * 2 ** Math.min(Math.max(0, failures - 1), 6));
}
