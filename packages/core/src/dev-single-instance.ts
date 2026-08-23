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
// Single source for the dev single-instance launch contract between the
// Electron main process (the authority) and the dev launcher (the consumer).
// Packaged builds keep the existing behavior (second instance exits 0 and
// the first window is focused); in dev (`!app.isPackaged`) a losing process
// must NOT pretend to have started. A direct launcher reads
// DEV_LOSER_EXIT_CODE; a LaunchServices-detached launcher reads its private,
// one-shot verdict file. The verdict never transfers app-process ownership.

export const DEV_LOSER_EXIT_CODE = 42 as const;
export const DEV_CONFLICT_HANDLED_BY_LAUNCHER_FLAG =
  '--maka-dev-conflict-handled-by-launcher' as const;
export const DEV_LAUNCH_RESULT_FILE_ARG_PREFIX = '--maka-dev-launch-result-file=' as const;

export type DevelopmentLaunchResult = { readonly status: 'winner' } | { readonly status: 'loser' };

export function developmentLaunchResultFile(argv: readonly string[]): string | undefined {
  for (let index = argv.length - 1; index >= 0; index -= 1) {
    const argument = argv[index];
    if (!argument?.startsWith(DEV_LAUNCH_RESULT_FILE_ARG_PREFIX)) continue;
    const file = argument.slice(DEV_LAUNCH_RESULT_FILE_ARG_PREFIX.length);
    return file.length > 0 ? file : undefined;
  }
  return undefined;
}

export function serializeDevelopmentLaunchResult(result: DevelopmentLaunchResult): string {
  return `${JSON.stringify(result)}\n`;
}

export function parseDevelopmentLaunchResult(value: string): DevelopmentLaunchResult | undefined {
  try {
    const result: unknown = JSON.parse(value);
    if (typeof result !== 'object' || result === null || !('status' in result)) return undefined;
    if (result.status === 'loser') return { status: 'loser' };
    if (result.status === 'winner') return { status: 'winner' };
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether the dev loser should show the native dialog: default yes; the flag
 * is a capability promise ("the launcher handles the conflict"), so CI/CLI
 * can suppress the dialog by passing it. Pure so the decision is testable.
 */
export function shouldShowLoserDialog(argv: readonly string[]): boolean {
  return !argv.includes(DEV_CONFLICT_HANDLED_BY_LAUNCHER_FLAG);
}
