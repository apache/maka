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
 * What this feature needs from the Desktop, and nothing more.
 *
 * The bridge is the composition zone's to hold. A feature that reached for it
 * directly would be a feature that only runs in Electron, which is the coupling
 * these ports exist to refuse.
 */
export type SessionBundleFailureReason =
  | 'canceled'
  // The subtree changed between the confirmation and the fence.
  | 'candidate_set_stale'
  | 'not_found'
  | 'session_busy'
  | 'operation_conflict'
  | 'source_unreadable'
  | 'failed';

/** Stated here, not imported: a feature that named a preload module would only
 *  run inside Electron. The Desktop's bridge satisfies this structurally. */
export type SessionBundleExportOutcome =
  | { readonly ok: true; readonly sessionCount: number; readonly path: string }
  | { readonly ok: false; readonly reason: SessionBundleFailureReason; readonly detail?: string };

export type SessionBundleImportOutcome =
  | { readonly ok: true; readonly sessionCount: number }
  | { readonly ok: false; readonly reason: SessionBundleFailureReason; readonly detail?: string };

export interface SessionBundleServices {
  /** Picks a destination, then writes the Session and its subagent subtree. */
  exportBundle(input: {
    readonly sessionId: string;
    readonly suggestedName: string;
    /**
     * The Session ids the user was shown, root included.
     *
     * Read from the catalog this renderer has; the save dialog opens, and only
     * then does the Host discover and fence the real subtree. Another client
     * can finish spawning a child in that gap, so the file would hold Sessions
     * nobody was asked about. These become a digest at the boundary where the
     * ids are already the Host's own, and the Host compares it against what it
     * fenced -- a digest, because two subtrees of the same size are not the
     * same subtree.
     */
    readonly confirmedSubtree?: readonly string[];
  }): Promise<SessionBundleExportOutcome>;
  /** Picks a `.maka-session` file and merges it into this workspace. */
  importBundle(): Promise<SessionBundleImportOutcome>;
}
