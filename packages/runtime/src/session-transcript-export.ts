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

import { openSync, writeSync, closeSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { RuntimeEventStore } from '@maka/core/runtime-event-store';
import type { SessionHeader, StoredMessage } from '@maka/core/session';
import { userFacingText } from '@maka/core/session';
import { redactSecrets } from '@maka/core/redaction';
import { OperationalStateMigrationBlockedError } from '@maka/storage/operational-state-store';
import { renderConversationMarkdown } from '@maka/core/conversation-markdown';
import { RuntimeReadModel } from './runtime-read-model.js';

/** The slice of the Session authority store an export reads. */
export interface SessionTranscriptSessionStore {
  readHeaderSnapshot(sessionId: string): Promise<SessionHeader>;
  readMessagesSnapshot(sessionId: string): Promise<StoredMessage[]>;
  listHeaders(): Promise<SessionHeader[]>;
  close?(): Promise<void>;
}

/** One open of a workspace's runtime event ledger. */
export interface SessionTranscriptEventLedger {
  runtimeEventStore: RuntimeEventStore;
  close(): unknown;
}

/**
 * Storage openers handed in by the entry point. The storage dependency guard
 * keeps concrete store construction out of the runtime package, so an export
 * cannot build its own readers: the CLI command opens both sources — with
 * `require_current` so an export never creates or migrates the operational
 * database, and `access: 'read'` so it cannot flip a writer's journal mode —
 * and passes them in (#6036 review).
 */
export interface SessionTranscriptExportSources {
  openSessionStore(workspaceRoot: string): SessionTranscriptSessionStore;
  openRuntimeEventLedger(workspaceRoot: string): Promise<SessionTranscriptEventLedger>;
}

export interface ExportSessionTranscriptMarkdownInput {
  workspaceRoot: string;
  sessionId: string;
  /** Model working notes; off by default per the Desktop-export precedent. */
  includeThinking?: boolean;
  now?: () => number;
  sources: SessionTranscriptExportSources;
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
  // Composition opens the store with `require_current`, which fails closed on
  // an uninitialized workspace and on a schema this build does not understand
  // (#6036 review).
  let store: SessionTranscriptSessionStore;
  try {
    store = input.sources.openSessionStore(input.workspaceRoot);
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
    const messages = await readSessionMessages(
      input.sources,
      input.workspaceRoot,
      input.sessionId,
      () => store.readMessagesSnapshot(input.sessionId),
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

export interface ExportSessionTranscriptMarkdownToFileInput
  extends ExportSessionTranscriptMarkdownInput {
  outPath: string;
}

export type ExportSessionTranscriptMarkdownToFileResult =
  | {
      ok: true;
      outPath: string;
      messageCount: number;
      bytes: number;
      subagentSessions: number;
    }
  | {
      ok: false;
      outPath: string;
      reason:
        | { kind: 'workspace_not_found'; workspaceRoot: string }
        | { kind: 'session_not_found' }
        | { kind: 'schema_unsupported' }
        | { kind: 'destination_exists' };
    };

/**
 * Stream the same transcript to a file handle instead of a string: the core
 * renderer emits one chunk per turn and each chunk is written as it lands, so
 * peak memory stays bounded by the largest turn rather than the whole
 * document (#6036 review). Sessions the main one spawned as subagents render
 * after it under their own title, so a debugging export carries the whole
 * story.
 */
export async function exportSessionTranscriptMarkdownToFile(
  input: ExportSessionTranscriptMarkdownToFileInput,
): Promise<ExportSessionTranscriptMarkdownToFileResult> {
  if (!(await isDirectory(input.workspaceRoot))) {
    return {
      ok: false,
      outPath: input.outPath,
      reason: { kind: 'workspace_not_found', workspaceRoot: input.workspaceRoot },
    };
  }

  let store: SessionTranscriptSessionStore;
  try {
    store = input.sources.openSessionStore(input.workspaceRoot);
  } catch (error) {
    if (error instanceof OperationalStateMigrationBlockedError) {
      return { ok: false, outPath: input.outPath, reason: { kind: 'schema_unsupported' } };
    }
    throw error;
  }
  // Declared at function scope so the finally can close it no matter where the
  // export stops.
  let handle: number | undefined;
  try {
    let sessionName: string;
    try {
      sessionName = (await store.readHeaderSnapshot(input.sessionId)).name;
    } catch {
      return { ok: false, outPath: input.outPath, reason: { kind: 'session_not_found' } };
    }
    const mainMessages = await readSessionMessages(
      input.sources,
      input.workspaceRoot,
      input.sessionId,
      () => store.readMessagesSnapshot(input.sessionId),
    );

    // Exclusive creation, aligned with the bundle exporter: an existing path
    // is never overwritten, and opening at write time closes the stat/open
    // window the friendly precheck cannot (#6036 review). Every failure that
    // can be known before writing happens above — a failed export never
    // leaves an empty file behind.
    try {
      handle = openSync(input.outPath, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        return { ok: false, outPath: input.outPath, reason: { kind: 'destination_exists' } };
      }
      throw error;
    }

    let bytes = 0;
    const openHandle = handle;
    const emit = (chunk: string): void => {
      const buffer = Buffer.from(chunk, 'utf8');
      // writeSync may accept fewer bytes than asked (short write); looping
      // until the buffer is drained is the contract, and a partial write
      // must never be reported as a successful export (#6036 review).
      let written = 0;
      while (written < buffer.length) {
        written += writeSync(openHandle, buffer, written);
      }
      bytes += buffer.length;
    };
    const renderOptions = {
      includeThinking: input.includeThinking,
      includeToolResults: true,
      includeToolArguments: true,
      now: input.now,
      emit,
    };

    renderConversationMarkdown(sessionName, mainMessages, {
      copy: {
        you: 'You',
        assistant: 'Maka',
        toolCalls: 'Tool calls',
        thinking: 'Thinking',
        intentSeparator: ' — ',
      },
      ...renderOptions,
    });

    let subagentSessions = 0;
    for (const header of await store.listHeaders()) {
      if (header.subagentParent?.parentSessionId !== input.sessionId) continue;
      subagentSessions += 1;
      emit(`\n\n# ${header.name}\n\n`);
      try {
        const childMessages = await readSessionMessages(
          input.sources,
          input.workspaceRoot,
          header.id,
          () => store.readMessagesSnapshot(header.id),
        );
        renderConversationMarkdown(header.name, childMessages, {
          copy: {
            you: 'You',
            assistant: 'Maka',
            toolCalls: 'Tool calls',
            thinking: 'Thinking',
            intentSeparator: ' — ',
          },
          ...renderOptions,
        });
      } catch {
        // A child that no longer projects (deleted mid-export, unreadable
        // ledger) must not lose the rest of the document.
        emit(`[subagent session ${header.id} could not be rendered]\n\n`);
      }
    }

    return {
      ok: true,
      outPath: input.outPath,
      messageCount: mainMessages.length,
      bytes,
      subagentSessions,
    };
  } finally {
    if (handle !== undefined) closeSync(handle);
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
  sources: SessionTranscriptExportSources,
  workspaceRoot: string,
  sessionId: string,
  readLegacyRows: () => Promise<StoredMessage[]>,
): Promise<StoredMessage[]> {
  const ledger = await sources.openRuntimeEventLedger(workspaceRoot).catch(() => undefined);
  if (!ledger) return readLegacyRows();
  try {
    const readModel = new RuntimeReadModel({ runtimeEventStore: ledger.runtimeEventStore });
    const projected = await readModel.getSessionMessages(sessionId);
    return projected.length > 0 ? projected : readLegacyRows();
  } finally {
    await ledger.close();
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
