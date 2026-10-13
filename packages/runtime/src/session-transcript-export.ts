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
 * Export one Session's transcript from persistence as Markdown.
 *
 * The three surfaces each expose a partial slice of a transcript — the Desktop
 * export renders only what the viewport has loaded, and the TUI copy is
 * clipboard-bound — so this is the read-side path that hands out the whole
 * Session: messages come from the runtime event ledger (the transcript
 * authority current sessions write; sessions older than the ledger fall back
 * to their stored rows), and the renderer keeps the Desktop export's shape
 * (`## You` / `### Tool calls` / `## Maka`) while restoring what it
 * deliberately drops for the clipboard. Differences, per the #5958 discussion:
 *
 * - **tool results** are included: they are exactly what a debugging reader
 *   needs, and every string that reaches the file passes `redactSecrets`.
 * - **thinking** stays out by default, following the @kenji precedent on the
 *   Desktop export; `includeThinking` is the explicit opt-in.
 * - **operational rows** (token usage, turn state, permission decisions,
 *   system notes, coordination) stay out: they are not something anyone said.
 *
 * No wire, protocol, or storage-schema change: a new reader over data that is
 * already on disk.
 */

import { stat } from 'node:fs/promises';
import type { RuntimeEventStore } from '@maka/core/runtime-event-store';
import type { StoredMessage } from '@maka/core/session';
import { userFacingText } from '@maka/core/session';
import { redactSecrets } from '@maka/core/redaction';
import { openRuntimeEventReadPersistence } from '@maka/storage/runtime-event-persistence';
import { OperationalStateMigrationBlockedError } from '@maka/storage/operational-state-store';
import { createSessionStore, type SessionAuthorityStore } from '@maka/storage/session-store';
import { renderConversationMarkdown } from '@maka/core/conversation-markdown';
import { RuntimeReadModel } from './runtime-read-model.js';

export interface ExportSessionTranscriptMarkdownInput {
  workspaceRoot: string;
  sessionId: string;
  /** Model working notes; off by default per the Desktop-export precedent. */
  includeThinking?: boolean;
  now?: () => number;
}

export type ExportSessionTranscriptMarkdownResult =
  | { ok: true; markdown: string; messageCount: number }
  | {
      ok: false;
      reason:
        | { kind: 'workspace_not_found'; workspaceRoot: string }
        | { kind: 'session_not_found' }
        | { kind: 'schema_unsupported' };
    };

export async function exportSessionTranscriptMarkdown(
  input: ExportSessionTranscriptMarkdownInput,
): Promise<ExportSessionTranscriptMarkdownResult> {
  if (!(await isDirectory(input.workspaceRoot))) {
    return {
      ok: false,
      reason: { kind: 'workspace_not_found', workspaceRoot: input.workspaceRoot },
    };
  }

  // An export is a read-side surface: it must never create or migrate the
  // operational database it reads (a running Host owns those migrations).
  // `require_current` fails closed on an uninitialized workspace and on a
  // schema this build does not understand (#6036 review).
  let store: SessionAuthorityStore;
  try {
    store = createSessionStore(input.workspaceRoot, { schemaMigration: 'require_current' });
  } catch (error) {
    if (error instanceof OperationalStateMigrationBlockedError) {
      return { ok: false, reason: { kind: 'schema_unsupported' } };
    }
    throw error;
  }
  try {
    let sessionName: string;
    try {
      sessionName = (await store.readHeaderSnapshot(input.sessionId)).name;
    } catch {
      return { ok: false, reason: { kind: 'session_not_found' } };
    }
    const messages = await readSessionMessages(input.workspaceRoot, input.sessionId, () =>
      store.readMessagesSnapshot(input.sessionId),
    );
    const markdown = renderSessionTranscriptMarkdown(sessionName, messages, {
      includeThinking: input.includeThinking,
      now: input.now,
    });
    return { ok: true, markdown, messageCount: messages.length };
  } finally {
    await store.close?.();
  }
}

export interface RenderSessionTranscriptMarkdownOptions {
  includeThinking?: boolean;
  includeToolArguments?: boolean;
  now?: () => number;
}

/**
 * Current sessions write the runtime event ledger and leave the legacy message
 * rows empty, so the ledger read model is read first and the legacy rows only
 * serve sessions that predate it. A ledger read that fails to open (no
 * operational-state database) also lands on the legacy rows; a ledger that
 * exists but projects with hard diagnostics fails the export instead of
 * reporting success with zero messages.
 */
async function readSessionMessages(
  workspaceRoot: string,
  sessionId: string,
  readLegacyRows: () => Promise<StoredMessage[]>,
): Promise<StoredMessage[]> {
  const persistence = await openRuntimeEventReadPersistence({ workspaceRoot }).catch(
    () => undefined,
  );
  if (!persistence) return readLegacyRows();
  try {
    // The read store carries every method the read model calls; the runtime
    // reader fragment is narrower than the full write store interface.
    const readModel = new RuntimeReadModel({
      runtimeEventStore: persistence.runtimeEventStore as unknown as RuntimeEventStore,
    });
    const projected = await readModel.getSessionMessages(sessionId);
    return projected.length > 0 ? projected : readLegacyRows();
  } finally {
    persistence.close();
  }
}

/**
 * Serialize stored rows to a Markdown document through the shared core
 * renderer: rows in stored order inside a turn, tool calls with their
 * redacted intent/arguments and result, `## You` / `## Maka` headers.
 */
export function renderSessionTranscriptMarkdown(
  sessionName: string,
  messages: readonly StoredMessage[],
  options: RenderSessionTranscriptMarkdownOptions = {},
): string {
  return renderConversationMarkdown(sessionName, messages, {
    copy: {
      you: 'You',
      assistant: 'Maka',
      toolCalls: 'Tool calls',
      thinking: 'Thinking',
      intentSeparator: ' — ',
    },
    includeThinking: options.includeThinking,
    includeToolResults: true,
    includeToolArguments: true,
    now: options.now,
  });
}

async function isDirectory(path: string): Promise<boolean> {
  return stat(path)
    .then((metadata) => metadata.isDirectory())
    .catch(() => false);
}
