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

import { open, stat } from 'node:fs/promises';
import { exportSessionTranscriptMarkdown } from '@maka/runtime/session-transcript-export';

const USAGE =
  'maka session-export-markdown --workspace-root <dir> --session <id> --out <file.md> [--include-thinking]';

const FAILURE_EXIT_CODES: Record<string, number> = {
  session_not_found: 2,
  destination_exists: 5,
  workspace_not_found: 6,
};

interface ParsedArgs {
  workspaceRoot: string;
  sessionId: string;
  destination: string;
  includeThinking: boolean;
}

function parseArgs(args: string[]): ParsedArgs {
  const values: Record<string, string> = {};
  let includeThinking = false;
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (name === '--include-thinking') {
      includeThinking = true;
      continue;
    }
    const value = args[index + 1];
    if (!name || !value) throw new Error(USAGE);
    if (name === '--workspace-root') values.workspaceRoot = value;
    else if (name === '--session') values.sessionId = value;
    else if (name === '--out') values.destination = value;
    else throw new Error(USAGE);
    index += 1;
  }
  if (!values.workspaceRoot || !values.sessionId || !values.destination) throw new Error(USAGE);
  return {
    workspaceRoot: values.workspaceRoot,
    sessionId: values.sessionId,
    destination: values.destination,
    includeThinking,
  };
}

export async function runMakaSessionExportMarkdownCli(args: string[]): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(args);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  // Aligned with the bundle exporter: an existing path is never overwritten.
  // The stat is only the friendly precheck; the exclusive creation below is
  // what actually refuses existing destinations — a file created after this
  // check, or a dangling symlink the check reads as absent, both land on EEXIST
  // instead of being truncated or followed.
  if (
    await stat(parsed.destination)
      .then(() => true)
      .catch(() => false)
  ) {
    process.stderr.write(`${JSON.stringify({ kind: 'destination_exists' })}\n`);
    return FAILURE_EXIT_CODES.destination_exists;
  }
  const result = await exportSessionTranscriptMarkdown({
    workspaceRoot: parsed.workspaceRoot,
    sessionId: parsed.sessionId,
    includeThinking: parsed.includeThinking,
  });
  if (!result.ok) {
    process.stderr.write(`${JSON.stringify(result.reason)}\n`);
    return FAILURE_EXIT_CODES[result.reason.kind] ?? 1;
  }
  let destination: Awaited<ReturnType<typeof open>>;
  try {
    destination = await open(parsed.destination, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      process.stderr.write(`${JSON.stringify({ kind: 'destination_exists' })}\n`);
      return FAILURE_EXIT_CODES.destination_exists;
    }
    throw error;
  }
  try {
    await destination.writeFile(result.markdown, 'utf8');
  } finally {
    await destination.close();
  }
  process.stdout.write(
    `${JSON.stringify({
      session: parsed.sessionId,
      out: parsed.destination,
      messageCount: result.messageCount,
    })}\n`,
  );
  return 0;
}
