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
 * Import a `.maka-session` bundle into a workspace.
 *
 * The mirror of the export: `hydrate()` verifies and unpacks what `pack()`
 * sealed, and `importSessionBundleState()` merges what the export policy
 * prepared. This module is the thin part -- verify, merge, report.
 *
 * The bundle names its connection by slug; nothing here resolves it. A Session
 * whose slug this workspace does not have arrives in the state the app already
 * shows for that: stale, and routable once the user picks a connection.
 */

import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  SessionBundleFileError,
  type SessionBundleLimits,
} from '@maka/storage/session-bundle-contract';
import { createSessionBundleFileService } from '@maka/storage/session-bundle-file-service';
import {
  importSessionBundleState,
  SessionBundleImportError,
} from '@maka/storage/session-bundle-policy';
import { SESSION_EXPORT_BUNDLE_LIMITS, type SessionExportManifest } from './session-export.js';

export interface ImportSessionBundleInput {
  workspaceRoot: string;
  /** The `.maka-session` file to read. */
  source: string;
  limits?: SessionBundleLimits;
}

export type ImportSessionBundleFailure =
  | { kind: 'workspace_not_found'; workspaceRoot: string }
  | { kind: 'bundle_unreadable'; message: string }
  /** One of the bundle's Sessions is already in this workspace. */
  | { kind: 'session_exists'; message: string }
  /** The bundle was made against a schema this workspace does not read. */
  | { kind: 'schema_unsupported'; message: string }
  | { kind: 'conflict'; message: string }
  | { kind: 'io_failed'; message: string };

export type ImportSessionBundleResult =
  | {
      ok: true;
      sessionIds: string[];
      artifactFiles: number;
      contextRefs: number;
      manifest: SessionExportManifest | undefined;
    }
  | { ok: false; reason: ImportSessionBundleFailure };

export async function importSessionBundle(
  input: ImportSessionBundleInput,
): Promise<ImportSessionBundleResult> {
  if (!(await isDirectory(input.workspaceRoot))) {
    return {
      ok: false,
      reason: { kind: 'workspace_not_found', workspaceRoot: input.workspaceRoot },
    };
  }
  const limits = input.limits ?? SESSION_EXPORT_BUNDLE_LIMITS;
  const staging = await mkdtemp(join(tmpdir(), 'maka-session-import-'));
  try {
    const service = createSessionBundleFileService();
    // Read the identity before hydrating: the codec verifies a bundle against a
    // Session id, and the bundle is the only thing that knows which one.
    const inspection = await service.inspect({ source: { path: input.source }, limits });
    const manifest = readExportManifest(inspection.stateIdentity.bytes);
    const hydration = await service.hydrate({
      source: { path: input.source },
      limits,
      expectedSessionId: manifest?.rootSessionId ?? inspection.manifest.envelope.sessionId,
      destinationRoot: join(staging, 'hydrated'),
    });

    const merged = await importSessionBundleState({
      stateRoot: input.workspaceRoot,
      bundleStateRoot: hydration.stateRoot,
    });
    return { ok: true, ...merged, manifest };
  } catch (error) {
    if (error instanceof SessionBundleImportError) {
      switch (error.code) {
        case 'session_exists':
          return { ok: false, reason: { kind: 'session_exists', message: error.message } };
        case 'schema_unsupported':
          return { ok: false, reason: { kind: 'schema_unsupported', message: error.message } };
        case 'conflict':
          return { ok: false, reason: { kind: 'conflict', message: error.message } };
        default:
          return { ok: false, reason: { kind: 'io_failed', message: error.message } };
      }
    }
    if (error instanceof SessionBundleFileError) {
      return { ok: false, reason: { kind: 'bundle_unreadable', message: error.message } };
    }
    return { ok: false, reason: { kind: 'io_failed', message: String(error) } };
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

function readExportManifest(bytes: Uint8Array): SessionExportManifest | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as SessionExportManifest;
    return parsed.format === 'maka.session-export' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  return stat(path)
    .then((metadata) => metadata.isDirectory())
    .catch(() => false);
}
