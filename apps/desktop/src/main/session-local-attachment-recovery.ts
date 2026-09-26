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
import { AttachmentIngestBlockedError, MAX_ATTACHMENT_COUNT } from '@maka/core/attachments';
import type { DesktopTargetScope } from '../shared/runtime-host-identity.js';
import { ATTACHMENT_APPROVAL_TTL_MS, type IssuedAttachmentApproval } from './attachment-approval.js';
import { MAX_LOCAL_MESSAGE_BYTES } from './session-local-store.js';

interface RecoveryOwner {
  senderId: number;
  partition: string;
  scope: DesktopTargetScope;
  sessionId: string;
}
interface RecoveryEntry {
  owner: string;
  senderId: number;
  partition: string;
  issuedAt: number;
  leases: number;
  releaseRequested: boolean;
  attachment: { name: string; mimeType: string; content: Uint8Array };
}

function ownerKey(owner: RecoveryOwner): string {
  return JSON.stringify([owner.senderId, owner.partition, owner.scope.hostId, owner.scope.targetEpoch, owner.sessionId]);
}

/** Main-only byte snapshots. Tokens cannot be redeemed by preview or Host-direct ingest. */
export class SessionLocalAttachmentRecovery {
  readonly #entries = new Map<string, RecoveryEntry>();
  constructor(private readonly now: () => number = Date.now) {}

  #prune(): void {
    for (const [id, entry] of this.#entries) {
      if (this.now() - entry.issuedAt > ATTACHMENT_APPROVAL_TTL_MS) this.#entries.delete(id);
    }
  }

  issue(owner: RecoveryOwner, attachments: readonly RecoveryEntry['attachment'][]): IssuedAttachmentApproval[] {
    this.#prune();
    if (attachments.length > MAX_ATTACHMENT_COUNT) throw new AttachmentIngestBlockedError('count_limit');
    // Do not evict another live composer's approvals to make room for a read.
    const bytes = [...this.#entries.values()].reduce((sum, entry) => sum + entry.attachment.content.byteLength, 0);
    if (this.#entries.size + attachments.length > 1000 ||
        bytes + attachments.reduce((sum, item) => sum + item.content.byteLength, 0) > 2 * MAX_LOCAL_MESSAGE_BYTES) {
      throw new AttachmentIngestBlockedError('total_size_exceeded');
    }
    return attachments.map((attachment) => {
      const approvalId = `local-recovery:${randomUUID()}`;
      this.#entries.set(approvalId, {
        owner: ownerKey(owner), senderId: owner.senderId, partition: owner.partition, issuedAt: this.now(),
        leases: 0, releaseRequested: false,
        attachment: { ...attachment, content: new Uint8Array(attachment.content) },
      });
      return { approvalId, name: attachment.name, mimeType: attachment.mimeType, size: attachment.content.byteLength };
    });
  }

  /** Cleanup is sender-scoped, not target-scoped: an abandoned old target can still be released. */
  release(senderId: number, ids: unknown): void {
    if (!Array.isArray(ids) || ids.length > 1000 ||
        [...ids].some((id) => typeof id !== 'string' || !id || id.length > 256)) {
      throw new AttachmentIngestBlockedError('items_invalid');
    }
    this.#prune();
    for (const id of ids) {
      const entry = this.#entries.get(id);
      if (!entry || entry.senderId !== senderId) continue;
      entry.releaseRequested = true;
      if (!entry.leases) this.#entries.delete(id);
    }
  }

  prepare(owner: RecoveryOwner, items: unknown): {
    items: unknown[];
    commit<T>(admit: () => T): T;
    dispose(): void;
  } {
    this.#prune();
    if (!Array.isArray(items)) throw new AttachmentIngestBlockedError('items_invalid');
    if (items.length > MAX_ATTACHMENT_COUNT) throw new AttachmentIngestBlockedError('count_limit');
    const ids = new Set<string>();
    const key = ownerKey(owner);
    const requireEntry = (id: string, allowReleased = false): RecoveryEntry => {
      this.#prune();
      const entry = this.#entries.get(id);
      if (!entry || entry.owner !== key || (entry.releaseRequested && !allowReleased))
        throw new AttachmentIngestBlockedError('source_expired');
      return entry;
    };
    const expanded = items.map((item) => {
      if (!item || typeof item !== 'object' || !('approvalId' in item) ||
          typeof item.approvalId !== 'string' || !item.approvalId.startsWith('local-recovery:')) return item;
      if (ids.has(item.approvalId)) throw new AttachmentIngestBlockedError('duplicate_source');
      ids.add(item.approvalId);
      const { attachment } = requireEntry(item.approvalId);
      // Ignore renderer-supplied metadata; the stored snapshot owns both bytes and MIME.
      return { name: attachment.name, mimeType: attachment.mimeType, base64: Buffer.from(attachment.content).toString('base64') };
    });
    // Acquire only after every item passes validation, so a partial preparation
    // cannot retain a snapshot forever. Cleanup may not interrupt these sends.
    const leasedEntries = [...ids].map((id) => requireEntry(id));
    for (const entry of leasedEntries) entry.leases += 1;
    let disposed = false;
    return {
      items: expanded,
      commit: (admit) => {
        if (disposed) throw new AttachmentIngestBlockedError('source_expired');
        // Admission is synchronous (SQLite enqueue): no event-loop turn may
        // occur between revalidation, durable acceptance, and consumption.
        // A lease defers explicit cleanup, never expiration or authority revocation.
        for (const id of ids) requireEntry(id, true);
        const result = admit();
        for (const id of ids) this.#entries.delete(id);
        return result;
      },
      dispose: () => {
        if (disposed) return;
        disposed = true;
        for (const id of ids) {
          const entry = this.#entries.get(id);
          if (!entry) continue;
          entry.leases -= 1;
          if (entry.releaseRequested && !entry.leases) this.#entries.delete(id);
        }
      },
    };
  }

  clear(partition?: string): void {
    for (const [id, entry] of this.#entries) {
      if (partition === undefined || entry.partition === partition) this.#entries.delete(id);
    }
  }
}
