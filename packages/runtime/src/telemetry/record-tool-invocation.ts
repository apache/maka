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

import { randomUUID } from 'node:crypto';
import { generalizedErrorMessage } from '@maka/core/redaction';
import type { ToolInvocationRecord } from '@maka/core/usage-stats/types';
import type { TelemetryRepoLite } from './types.js';

const ARGS_SUMMARY_MAX = 512;

export interface ToolRecorderDeps {
  repo: Pick<TelemetryRepoLite, 'insertToolInvocation'>;
}

export async function recordToolInvocation(
  deps: ToolRecorderDeps,
  record: ToolInvocationRecord,
): Promise<void> {
  try {
    const ts = record.startedAt + record.durationMs;
    await deps.repo.insertToolInvocation({
      ...record,
      id: `tool_${record.toolCallId ?? randomUUID()}`,
      argsSummary: truncate(record.argsSummary ?? ''),
      bytesIn: record.bytesIn ?? 0,
      bytesOut: record.bytesOut ?? 0,
      date: new Date(ts).toISOString().slice(0, 10),
      ts,
    });
  } catch (error) {
    console.error(`[telemetry] recordToolInvocation failed: ${generalizedErrorMessage(error)}`);
  }
}

function truncate(value: string): string {
  return value.length <= ARGS_SUMMARY_MAX ? value : `${value.slice(0, ARGS_SUMMARY_MAX - 1)}…`;
}
