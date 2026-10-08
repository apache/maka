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

import { importSessionBundle } from '@maka/runtime/session-import';

const USAGE = 'maka session-import --workspace-root <dir> --bundle <file.maka-session>';

const FAILURE_EXIT_CODES: Record<string, number> = {
  workspace_not_found: 6,
  bundle_unreadable: 2,
  session_exists: 3,
  schema_unsupported: 4,
  conflict: 5,
};

function parseArgs(args: string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name || !value) throw new Error(USAGE);
    if (name === '--workspace-root') values.workspaceRoot = value;
    else if (name === '--bundle') values.source = value;
    else throw new Error(USAGE);
  }
  if (!values.workspaceRoot || !values.source) throw new Error(USAGE);
  return values;
}

export async function runMakaSessionImportCli(args: string[]): Promise<number> {
  let parsed: Record<string, string>;
  try {
    parsed = parseArgs(args);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }
  const result = await importSessionBundle({
    workspaceRoot: parsed.workspaceRoot!,
    source: parsed.source!,
  });
  if (!result.ok) {
    process.stderr.write(`${JSON.stringify(result.reason)}\n`);
    return FAILURE_EXIT_CODES[result.reason.kind] ?? 1;
  }
  process.stdout.write(
    `${JSON.stringify({
      sessionIds: result.sessionIds,
      artifactFiles: result.artifactFiles,
      contextRefs: result.contextRefs,
    })}\n`,
  );
  return 0;
}
