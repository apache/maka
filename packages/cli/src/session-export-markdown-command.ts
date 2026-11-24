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

import type { RuntimeEventStore } from '@maka/core/runtime-event-store';
import { createSessionStore } from '@maka/storage/session-store';
import { openRuntimeEventReadPersistence } from '@maka/storage/runtime-event-persistence';
import {
  exportSessionTranscriptMarkdownToFile,
  type SessionTranscriptExportSources,
} from '@maka/runtime/session-transcript-export';

const USAGE =
  'maka session-export-markdown --workspace-root <dir> --session <id> --out <file.md> [--include-thinking]';

const FAILURE_EXIT_CODES: Record<string, number> = {
  session_not_found: 2,
  destination_exists: 5,
  workspace_not_found: 6,
};

interface ParsedArgs {
  help?: boolean;
  workspaceRoot?: string;
  sessionId?: string;
  destination?: string;
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
    if (name === '--help' || name === '-h') {
      values.help = '1';
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
  if (values.help) return { help: true, includeThinking };
  if (!values.workspaceRoot || !values.sessionId || !values.destination) throw new Error(USAGE);
  return {
    workspaceRoot: values.workspaceRoot,
    sessionId: values.sessionId,
    destination: values.destination,
    includeThinking,
  };
}

// Concrete store construction stays in composition (storage dependency guard):
// the command opens both read sources — `require_current` so an export can
// never create or migrate the operational database, `access: 'read'` so it
// cannot flip a writer's journal mode — and hands them to the exporter.
const sources: SessionTranscriptExportSources = {
  openSessionStore: (workspaceRoot) =>
    createSessionStore(workspaceRoot, { schemaMigration: 'require_current', access: 'read' }),
  openRuntimeEventLedger: async (workspaceRoot) => {
    const persistence = await openRuntimeEventReadPersistence({ workspaceRoot });
    return {
      // The read persistence carries every method the read model calls; the
      // runtime reader fragment is narrower than the full write store contract.
      runtimeEventStore: persistence.runtimeEventStore as unknown as RuntimeEventStore,
      close: () => persistence.close(),
    };
  },
};

export async function runMakaSessionExportMarkdownCli(args: string[]): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(args);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  // Asking for help is a success, not a usage error: usage goes to stdout and
  // the process exits 0 (#6036 review).
  if (parsed.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (!parsed.workspaceRoot || !parsed.sessionId || !parsed.destination) {
    process.stderr.write(`${USAGE}\n`);
    return 1;
  }
  // Aligned with the bundle exporter: an existing path is never overwritten.
  // The exporter opens the destination with exclusive creation, so a file that
  // appears after startup — or a dangling symlink — lands on
  // `destination_exists` instead of being truncated or followed.
  let result: Awaited<ReturnType<typeof exportSessionTranscriptMarkdownToFile>>;
  try {
    result = await exportSessionTranscriptMarkdownToFile({
      workspaceRoot: parsed.workspaceRoot,
      sessionId: parsed.sessionId,
      outPath: parsed.destination,
      includeThinking: parsed.includeThinking,
      sources,
    });
  } catch (error) {
    // A failure with no structured reason — a destination open error other
    // than EEXIST, ENOSPC mid-write — must still exit cleanly with the
    // message on stderr instead of crashing the process (#6036 review).
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  if (!result.ok) {
    process.stderr.write(`${JSON.stringify(result.reason)}\n`);
    return FAILURE_EXIT_CODES[result.reason.kind] ?? 1;
  }
  process.stdout.write(
    `${JSON.stringify({
      session: parsed.sessionId,
      out: result.outPath,
      messageCount: result.messageCount,
      bytes: result.bytes,
      subagentSessions: result.subagentSessions,
    })}\n`,
  );
  return 0;
}
