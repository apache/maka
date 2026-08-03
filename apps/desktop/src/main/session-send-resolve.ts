import { randomUUID } from 'node:crypto';
import type { AttachmentRef, QuoteRef, SessionHeader } from '@maka/core';
import type { ArtifactStore } from '@maka/storage';
import { ingestAttachments, resolveIngestItems } from './attachment-ingest.js';
import type { AttachmentApprovalRegistry } from './attachment-approval.js';

export interface SendCommandWithItems {
  type: 'send';
  turnId?: string;
  text: string;
  attachmentItems?: unknown;
  /** Inline quoted excerpts; already normalized at the IPC boundary. */
  quotes?: QuoteRef[];
}

/**
 * Run the send readiness check, then resolve + ingest attachment items, in
 * that order. Readiness failure throws before any token is consumed or
 * artifact created, so the caller can retry with the same approvalId.
 */
export async function resolveSessionSend(input: {
  sessionId: string;
  senderId: number;
  command: SendCommandWithItems;
  ensureCanSend: (sessionId: string) => Promise<void>;
  readHeader: (sessionId: string) => Promise<SessionHeader | null>;
  approvals: AttachmentApprovalRegistry;
  stat: (path: string) => Promise<{ size: number }>;
  artifactStore: ArtifactStore;
  resizeImage: (bytes: Uint8Array) => Promise<Uint8Array>;
}): Promise<{ turnId: string; attachments: AttachmentRef[] }> {
  await input.ensureCanSend(input.sessionId);
  let attachments: AttachmentRef[] = [];
  if (input.command.attachmentItems) {
    const header = await input.readHeader(input.sessionId);
    if (!header) throw new Error('无法读取会话工作目录。');
    const files = await resolveIngestItems({
      senderId: input.senderId,
      items: input.command.attachmentItems,
      approvals: input.approvals,
      stat: input.stat,
    });
    attachments = await ingestAttachments({
      files,
      cwd: header.cwd,
      sessionId: input.sessionId,
      artifactStore: input.artifactStore,
      resizeImage: input.resizeImage,
    });
  }
  return { turnId: input.command.turnId || randomUUID(), attachments };
}
/**
 * What a send does the moment its run goes live.
 *
 * No SessionEvent marks a turn's START — only its end — and the runtime writes
 * `status: 'running'` at the end of `AgentRun.begin`, announcing it to nobody.
 * Without this broadcast the earliest a client learns its turn is running is
 * the `message-appended` riding the FIRST content event, so the whole backend
 * start-up ahead of it looks idle.
 *
 * The broadcast carries the turn id, which is what makes it an ANSWER to a
 * particular send rather than a bare catalog invalidation: a session's status
 * reads the same before a turn starts and after it ends, so a client that just
 * sent cannot otherwise tell "not yet" from "already over".
 *
 * It is emitted BEFORE the revision commit. Nothing in the answer depends on
 * that write, so it must neither be delayed by it nor lost when it throws.
 */
export function createRunStartedHook(input: {
  sessionId: string;
  turnId: string;
  emitSessionsChanged: (sessionId: string, turnId: string) => void;
  commitRevisionVersion: (sessionId: string) => Promise<unknown>;
}): (runId: string, header: { revisionState?: string }) => Promise<void> {
  return async (_runId, header) => {
    input.emitSessionsChanged(input.sessionId, input.turnId);
    if (header.revisionState === 'preparing') {
      await input.commitRevisionVersion(input.sessionId);
    }
  };
}

/** One `sessions:changed` to emit, in order. */
export interface StoppedTurnBroadcast {
  reason: 'status-change' | 'turn-status-change' | 'message-appended';
  turnId?: string;
}

/**
 * The broadcasts that announce a stop, naming the turns it ended.
 *
 * Stopping is the one turn ending a client can be waiting on without ever
 * having seen the turn start — Stop pressed inside the send→run-start window.
 * A client holds a local claim on a turn it submitted until it hears back about
 * that exact turn, so an unnamed stop leaves the claim with nothing to release
 * it, making Stop the one control unable to undo Stop.
 *
 * With no turn running there is nothing to name and the plain invalidations
 * stand: something not tied to a turn is exactly what an unnamed change means.
 */
export function stoppedTurnBroadcasts(
  stoppedTurnIds: readonly string[],
): StoppedTurnBroadcast[] {
  const reasons = ['status-change', 'turn-status-change', 'message-appended'] as const;
  return reasons.flatMap((reason) =>
    stoppedTurnIds.length === 0
      ? [{ reason }]
      : stoppedTurnIds.map((turnId) => ({ reason, turnId })),
  );
}
