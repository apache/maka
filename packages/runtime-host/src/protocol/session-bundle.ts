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

import {
  requireCount,
  requireEntityId,
  requireExactRecord,
  requireShapedRecord,
  requireUtf8String,
} from './codec.js';
import { defineHostPathOperation } from './operation-spec.js';

/** A destination or source path, named on the Host's filesystem. */
export const SESSION_BUNDLE_PATH_MAX_BYTES = 4 * 1024;
/** A hex sha256. */
export const SESSION_BUNDLE_DIGEST_MAX_BYTES = 64;

const BUNDLE_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'invalid_request',
  'not_found',
  // The Session, or one of its descendants, is mid-turn. A bundle carried
  // elsewhere cannot hold half a turn.
  'session_busy',
  // A destination already taken, a Session id the workspace already has, or a
  // payload the target holds under the same name with different content.
  'operation_conflict',
  // The bundle, or the workspace being read, could not be read as one.
  'source_unreadable',
  // The subtree changed between what the caller confirmed and what was fenced.
  'candidate_set_stale',
  'persistence_failed',
  'internal_failure',
] as const;

export interface SessionBundleExportInput {
  readonly sessionId: string;
  /** Absolute path to write. Never overwritten if it already exists. */
  readonly destination: string;
  /**
   * Digest of the subtree the caller told the user this would carry.
   *
   * `sha256` over the Session ids, sorted and newline-joined, root included.
   * The caller reads them from the catalog it holds and the Host discovers the
   * real subtree later, under its fence; a child finishing in that gap would
   * put Sessions in the file that nobody was asked about. A digest rather than
   * a count because two subtrees of the same size are not the same subtree,
   * and rather than the ids themselves because this has to stay bounded.
   */
  readonly expectedSubtreeDigest?: string;
}

export interface SessionBundleExportResult {
  /** The exported Session and its subagent descendants, counted. */
  readonly sessionCount: number;
  readonly compressedBytes: number;
}

export interface SessionBundleImportInput {
  /** Absolute path of the `.maka-session` file to read. */
  readonly source: string;
}

/**
 * Counts, not identities.
 *
 * A frame is bounded, and a list that grows with the subtree can exceed it
 * AFTER the Sessions are committed: the caller is told the operation failed
 * while every row landed, and the retry then reports a conflict against its own
 * work. Nothing downstream needs the ids -- the client re-reads its catalog.
 */
export interface SessionBundleImportResult {
  readonly sessionCount: number;
  readonly artifactFiles: number;
}

export const SESSION_BUNDLE_OPERATION_SPECS = {
  // Both name paths on the Host's filesystem: the desktop picks them with a
  // native dialog, which is the Host's machine in the local case and would be
  // the remote one otherwise.
  'session-bundle.export': defineHostPathOperation<
    SessionBundleExportInput,
    SessionBundleExportResult,
    (typeof BUNDLE_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: BUNDLE_ERRORS,
    decodeInput: decodeSessionBundleExportInput,
    decodeOutput: decodeSessionBundleExportResult,
  }),
  'session-bundle.import': defineHostPathOperation<
    SessionBundleImportInput,
    SessionBundleImportResult,
    (typeof BUNDLE_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: BUNDLE_ERRORS,
    decodeInput: decodeSessionBundleImportInput,
    decodeOutput: decodeSessionBundleImportResult,
  }),
} as const;

export function decodeSessionBundleExportInput(value: unknown): SessionBundleExportInput {
  const record = requireShapedRecord(
    value,
    'Session bundle export input',
    ['sessionId', 'destination'],
    ['expectedSubtreeDigest'],
  );
  return {
    sessionId: requireEntityId(record.sessionId, 'Session id'),
    destination: requireUtf8String(
      record.destination,
      'Session bundle destination',
      SESSION_BUNDLE_PATH_MAX_BYTES,
    ),
    ...(Object.hasOwn(record, 'expectedSubtreeDigest')
      ? {
          expectedSubtreeDigest: requireUtf8String(
            record.expectedSubtreeDigest,
            'Session bundle expected subtree digest',
            SESSION_BUNDLE_DIGEST_MAX_BYTES,
          ),
        }
      : {}),
  };
}

export function decodeSessionBundleExportResult(value: unknown): SessionBundleExportResult {
  const record = requireExactRecord(value, 'Session bundle export result', [
    'sessionCount',
    'compressedBytes',
  ]);
  return {
    sessionCount: requireCount(record.sessionCount, 'Session bundle Session count'),
    compressedBytes: requireCount(record.compressedBytes, 'Session bundle compressed bytes'),
  };
}

export function decodeSessionBundleImportInput(value: unknown): SessionBundleImportInput {
  const record = requireExactRecord(value, 'Session bundle import input', ['source']);
  return {
    source: requireUtf8String(
      record.source,
      'Session bundle source',
      SESSION_BUNDLE_PATH_MAX_BYTES,
    ),
  };
}

export function decodeSessionBundleImportResult(value: unknown): SessionBundleImportResult {
  const record = requireExactRecord(value, 'Session bundle import result', [
    'sessionCount',
    'artifactFiles',
  ]);
  return {
    sessionCount: requireCount(record.sessionCount, 'Session bundle Session count'),
    artifactFiles: requireCount(record.artifactFiles, 'Session bundle artifact files'),
  };
}
