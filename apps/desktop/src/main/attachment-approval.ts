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
import { resolve } from 'node:path';

export const ATTACHMENT_APPROVAL_TTL_MS = 30 * 60 * 1000;
export const MAX_APPROVED_ATTACHMENT_PATHS = 1000;

/**
 * Token handed to the renderer in place of a local path. The path never leaves
 * the main process; only this opaque id does.
 */
export interface IssuedAttachmentApproval {
  approvalId: string;
  name: string;
  mimeType?: string;
  size: number;
}

/**
 * Path + metadata redeemed from a one-shot token, for main-internal use only.
 */
export interface ApprovedAttachmentPath {
  path: string;
  name: string;
  mimeType?: string;
  size: number;
}

interface ApprovalEntry extends ApprovedAttachmentPath {
  senderId: number;
  issuedAt: number;
}

export interface AttachmentApprovalRegistry {
  /**
   * Stamp each user-chosen path with a one-shot opaque token. The path stays
   * in main; the renderer only ever sees the token + display metadata.
   */
  issueApprovals(
    senderId: number,
    files: readonly { path: string; name: string; mimeType?: string; size: number }[],
  ): IssuedAttachmentApproval[];
  /**
   * Redeem a token for its bound path. Returns null if the token is unknown,
   * belongs to another sender, or has expired. Redemption is one-shot: a
   * second call with the same id returns null.
   */
  peekApproval(senderId: number, approvalId: string): ApprovedAttachmentPath | null;
  consumeApproval(senderId: number, approvalId: string): ApprovedAttachmentPath | null;
  clearSender(senderId: number): void;
  prune(now?: number): void;
  size(): number;
}

export function createAttachmentApprovalRegistry(input: {
  now?: () => number;
  ttlMs?: number;
  maxEntries?: number;
} = {}): AttachmentApprovalRegistry {
  const now = input.now ?? Date.now;
  const ttlMs = input.ttlMs ?? ATTACHMENT_APPROVAL_TTL_MS;
  const maxEntries = input.maxEntries ?? MAX_APPROVED_ATTACHMENT_PATHS;
  const approvals = new Map<string, ApprovalEntry>();

  function prune(current = now()): void {
    for (const [id, entry] of approvals) {
      if (current - entry.issuedAt > ttlMs) approvals.delete(id);
    }
    while (approvals.size > maxEntries) {
      const oldest = approvals.keys().next().value;
      if (!oldest) break;
      approvals.delete(oldest);
    }
  }

  return {
    issueApprovals(senderId, files) {
      const current = now();
      prune(current);
      return files.map((file) => {
        const id = randomUUID();
        approvals.set(id, {
          senderId,
          path: resolve(file.path),
          name: file.name,
          ...(file.mimeType ? { mimeType: file.mimeType } : {}),
          size: file.size,
          issuedAt: current,
        });
        return {
          approvalId: id,
          name: file.name,
          ...(file.mimeType ? { mimeType: file.mimeType } : {}),
          size: file.size,
        };
      });
    },
    peekApproval(senderId, approvalId) {
      prune(now());
      const entry = approvals.get(approvalId);
      if (!entry || entry.senderId !== senderId) return null;
      return {
        path: entry.path,
        name: entry.name,
        ...(entry.mimeType ? { mimeType: entry.mimeType } : {}),
        size: entry.size,
      };
    },
    consumeApproval(senderId, approvalId) {
      prune(now());
      const entry = approvals.get(approvalId);
      if (!entry || entry.senderId !== senderId) return null;
      approvals.delete(approvalId);
      return {
        path: entry.path,
        name: entry.name,
        ...(entry.mimeType ? { mimeType: entry.mimeType } : {}),
        size: entry.size,
      };
    },
    clearSender(senderId) {
      for (const [id, entry] of approvals) {
        if (entry.senderId === senderId) approvals.delete(id);
      }
    },
    prune,
    size() {
      prune(now());
      return approvals.size;
    },
  };
}
