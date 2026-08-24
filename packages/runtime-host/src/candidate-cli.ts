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

import type { InteractiveRuntimeHostCandidateOptions } from './server/candidate.js';
import { isCandidateStartupAttemptId } from './candidate-startup-failure.js';

export interface ParsedInteractiveRuntimeHostCandidateArguments
  extends InteractiveRuntimeHostCandidateOptions {
  readonly startupAttemptId: string;
}

export function parseInteractiveRuntimeHostCandidateArguments(
  args: readonly string[],
): ParsedInteractiveRuntimeHostCandidateArguments {
  const allowedKeys = new Set([
    'root',
    'expected-root-id',
    'startup-attempt-id',
    'initial-connection-timeout-ms',
    'idle-grace-ms',
    'handshake-timeout-ms',
    'generation',
  ]);
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error('Invalid Runtime Host candidate arguments');
    }
    const name = key.slice(2);
    if (!allowedKeys.has(name) || values.has(name)) {
      throw new Error(`Invalid Runtime Host candidate argument: ${key}`);
    }
    values.set(name, value);
  }
  const rootPath = values.get('root');
  if (!rootPath) throw new Error('Runtime Host candidate requires --root');
  const expectedRootId = values.get('expected-root-id');
  if (!expectedRootId || !/^[a-f0-9]{64}$/.test(expectedRootId)) {
    throw new Error('Runtime Host candidate requires a valid --expected-root-id');
  }
  const startupAttemptId = values.get('startup-attempt-id');
  if (!isCandidateStartupAttemptId(startupAttemptId)) {
    throw new Error('Runtime Host candidate requires a valid --startup-attempt-id');
  }
  return {
    rootPath,
    expectedRootId,
    startupAttemptId,
    initialConnectionTimeoutMs: readOptionalInteger(values, 'initial-connection-timeout-ms'),
    idleGraceMs: readOptionalInteger(values, 'idle-grace-ms'),
    handshakeTimeoutMs: readOptionalInteger(values, 'handshake-timeout-ms'),
    ...(values.has('generation') ? { generation: readGeneration(values) } : {}),
  };
}

function readGeneration(values: Map<string, string>): string {
  const value = values.get('generation');
  if (!value || value.length > 128) throw new Error('Invalid --generation');
  return value;
}

function readOptionalInteger(values: Map<string, string>, key: string): number | undefined {
  const raw = values.get(key);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`Invalid --${key}`);
  return value;
}
