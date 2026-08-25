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
 * Workspace file references clicked in transcript Markdown (`#2664`).
 *
 * Trust model: a reference is untrusted transcript content. Resolution and
 * sandbox-boundary enforcement happen ONLY here, on the trusted side, against
 * the session's Runtime Host workspace root:
 *
 *   - `../` traversal and out-of-root absolute paths fail the containment
 *     check (`isPathInside` against the realpath'd root).
 *   - Symlink escapes fail because the canonical target is resolved through
 *     `realpathAllowMissing` before containment is decided — a link inside the
 *     root pointing outside resolves to its outside target and is rejected.
 *   - Only regular Markdown files inside the root are readable; reads are
 *     size-capped and strictly read-only.
 *
 * Open/reveal go through injected main-process `shell` wrappers (the renderer
 * has no shell access) after the same resolution + containment check. The
 * external-link guard is untouched: `file://` URLs never reach it from here,
 * and its allowlist does not grow.
 */

import { stat } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { basename, isAbsolute, resolve } from 'node:path';
import { isPathInside, realpathAllowMissing } from '@maka/runtime/path-containment';
import type { DesktopRuntimeHostClient } from './runtime-host-client.js';
import {
  handleReconnectableRead,
  type ReconnectableReadIpcMain,
} from './ipc-reconnect-policy.js';
import type {
  WorkspaceFileOpenResult,
  WorkspaceFileRefFailureReason,
  WorkspaceFileTextReadResult,
} from '../preload/workspace-files-contract.js';

type WorkspaceFilesClient = Pick<DesktopRuntimeHostClient, 'getSession'>;

interface RuntimeHostWorkspaceFilesIpcDeps {
  readonly ipcMain: ReconnectableReadIpcMain;
  readonly client: WorkspaceFilesClient;
  /** Remote hosts have no local workspace to resolve against. */
  readonly allowLocalWorkspace?: boolean;
  readonly openPath: (path: string) => Promise<string>;
  readonly showItemInFolder: (path: string) => void;
}

/** References are short path texts; anything longer is not a file reference. */
const MAX_REFERENCE_LENGTH = 2048;
/** Text preview cap — matches the order of the artifact text preview budget. */
const MAX_READ_BYTES = 1024 * 1024;
const MARKDOWN_SUFFIX = /\.(?:md|markdown)$/i;
const PERCENT_ESCAPE = /%[0-9a-f]{2}/i;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export function registerWorkspaceFileRefsIpc(
  deps: RuntimeHostWorkspaceFilesIpcDeps,
): void {
  handleReconnectableRead(
    deps.ipcMain,
    'workspace-files:readText',
    async (_event, sessionId: string, reference: unknown): Promise<WorkspaceFileTextReadResult> => {
      if (deps.allowLocalWorkspace === false) {
        return { ok: false, reason: 'workspace_unavailable' };
      }
      const resolved = await resolveReference(deps.client, sessionId, reference);
      if (!resolved.ok) return resolved;
      try {
        const info = await stat(resolved.path);
        if (!info.isFile()) return { ok: false, reason: 'not_found' };
        if (info.size > MAX_READ_BYTES) return { ok: false, reason: 'too_large' };
        const text = await readFile(resolved.path, 'utf8');
        return { ok: true, name: resolved.name, text };
      } catch (error) {
        const code = typeof error === 'object' && error !== null && 'code' in error
          ? (error as { code?: unknown }).code
          : undefined;
        if (code === 'ENOENT' || code === 'ENOTDIR') {
          return { ok: false, reason: 'not_found' };
        }
        return { ok: false, reason: 'read_failed' };
      }
    },
  );
  deps.ipcMain.handle(
    'workspace-files:openLocally',
    async (_event, sessionId: string, reference: unknown): Promise<WorkspaceFileOpenResult> => {
      if (deps.allowLocalWorkspace === false) {
        return { ok: false, reason: 'workspace_unavailable' };
      }
      const resolved = await resolveReference(deps.client, sessionId, reference);
      if (!resolved.ok) return resolved;
      const error = await deps.openPath(resolved.path);
      if (error) return { ok: false, reason: 'open-failed' };
      return { ok: true, opened: resolved.name };
    },
  );
  deps.ipcMain.handle(
    'workspace-files:revealInFolder',
    async (_event, sessionId: string, reference: unknown): Promise<WorkspaceFileOpenResult> => {
      if (deps.allowLocalWorkspace === false) {
        return { ok: false, reason: 'workspace_unavailable' };
      }
      const resolved = await resolveReference(deps.client, sessionId, reference);
      if (!resolved.ok) return resolved;
      deps.showItemInFolder(resolved.path);
      return { ok: true, opened: resolved.name };
    },
  );
}

type ResolvedReference =
  | { ok: true; path: string; name: string }
  | { ok: false; reason: WorkspaceFileRefFailureReason };

/**
 * Resolve a raw reference against the session's workspace root with full
 * boundary enforcement. Returns typed failures for every rejection so callers
 * never need to guess why a reference was refused.
 */
async function resolveReference(
  client: WorkspaceFilesClient,
  sessionId: string,
  rawReference: unknown,
): Promise<ResolvedReference> {
  const reference = normalizeReference(rawReference);
  if (reference === null) return { ok: false, reason: 'invalid_reference' };

  let session: Awaited<ReturnType<WorkspaceFilesClient['getSession']>> | null;
  try {
    session = await client.getSession(sessionId);
  } catch {
    return { ok: false, reason: 'workspace_unavailable' };
  }
  if (!session) throw new Error(`No such Session: ${sessionId}`);
  const hostCwd = session.workspace?.hostCwd;
  if (typeof hostCwd !== 'string' || hostCwd.length === 0) {
    return { ok: false, reason: 'workspace_unavailable' };
  }

  let rootReal: string;
  try {
    rootReal = await realpathAllowMissing(hostCwd);
  } catch {
    return { ok: false, reason: 'workspace_unavailable' };
  }

  // Absolute references are allowed only to land back inside the root; the
  // containment check below is what rejects out-of-root absolutes.
  const candidate = isAbsolute(reference)
    ? resolve(reference)
    : resolve(rootReal, reference);

  let canonical: string;
  try {
    canonical = await realpathAllowMissing(candidate);
  } catch {
    return { ok: false, reason: 'outside_workspace' };
  }
  // Traversal (`../`), symlink escapes, and out-of-root absolutes all end up
  // here: their canonical target is not inside the realpath'd root.
  if (!isPathInside(rootReal, canonical)) return { ok: false, reason: 'outside_workspace' };

  return { ok: true, path: canonical, name: basename(canonical) };
}

/**
 * Validate and canonicalize percent-escapes in a raw reference. Scheme-prefixed
 * strings (including `file://`), control characters, and oversized inputs are
 * rejected; Markdown-suffix checking happens on the decoded spelling so that
 * percent-encoded space/CJK references resolve identically to raw ones.
 */
function normalizeReference(rawReference: unknown): string | null {
  if (typeof rawReference !== 'string') return null;
  if (rawReference.length === 0 || rawReference.length > MAX_REFERENCE_LENGTH) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(rawReference)) return null;
  if (CONTROL_CHARS.test(rawReference)) return null;

  let candidate = rawReference;
  if (PERCENT_ESCAPE.test(candidate)) {
    try {
      candidate = decodeURIComponent(candidate);
    } catch {
      // Malformed escapes keep the raw spelling; suffix check still applies.
    }
  }
  if (!MARKDOWN_SUFFIX.test(candidate)) return null;
  return candidate;
}
