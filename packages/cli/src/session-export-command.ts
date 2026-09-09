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

import { exportSessionBundle } from '@maka/runtime/session-export';

const USAGE = 'maka session-export --workspace-root <dir> --session <id> --out <file.maka-session>';

const FAILURE_EXIT_CODES: Record<string, number> = {
  session_not_found: 2,
  session_active: 3,
  artifact_missing: 4,
  destination_exists: 5,
  workspace_not_found: 6,
};

function parseArgs(args: string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name || !value) throw new Error(USAGE);
    if (name === '--workspace-root') values.workspaceRoot = value;
    else if (name === '--session') values.sessionId = value;
    else if (name === '--out') values.destination = value;
    else throw new Error(USAGE);
  }
  if (!values.workspaceRoot || !values.sessionId || !values.destination) throw new Error(USAGE);
  return values;
}

export async function runMakaSessionExportCli(args: string[]): Promise<number> {
  let parsed: Record<string, string>;
  try {
    parsed = parseArgs(args);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  const result = await exportSessionBundle({
    workspaceRoot: parsed.workspaceRoot,
    sessionId: parsed.sessionId,
    destination: parsed.destination,
  });
  if (!result.ok) {
    process.stderr.write(`${JSON.stringify(result.reason)}\n`);
    return FAILURE_EXIT_CODES[result.reason.kind] ?? 1;
  }
  process.stdout.write(
    `${JSON.stringify({
      export: result.export,
      archiveDigest: result.artifact.archiveDigest,
      compressedBytes: result.artifact.compressedBytes,
    })}\n`,
  );
  return 0;
}
