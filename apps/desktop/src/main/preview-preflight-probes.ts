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
 * The OS-touching half of the local preview preflight: the probes that decide
 * a capability's status by actually trying something. Classification lives in
 * preview-preflight.ts and never imports this file, so the statuses stay
 * testable without a filesystem or a socket.
 *
 * Two rules hold for everything here. A probe reports a connection or access
 * outcome as a value, never as a throw, so the classifier — not an exception
 * handler — decides what the outcome proves. And a probe never reads a
 * response body or file content back into the result: the evidence a caller
 * sees is a status code, an errno, and a path.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { join } from 'node:path';
import { browserAutomationAvailable, browserViewHost } from './browser/browser-host.js';
import type {
  LoopbackProbe,
  PreviewPreflightAuthority,
  StagingRootProbe,
} from './preview-preflight.js';

/**
 * A preview endpoint on loopback either answers immediately or is not up yet;
 * a long wait here would only turn a fast, honest `unknown` into a slow one.
 */
const LOOPBACK_PROBE_TIMEOUT_MS = 2_000;

const PROBE_CONTENT = 'maka-preview-preflight';

export interface PreviewPreflightProbeDeps {
  /** The Artifact staging root, or undefined when this client has none. */
  readonly stagingRoot: () => string | undefined;
}

export function createPreviewPreflightAuthority(
  deps: PreviewPreflightProbeDeps,
): PreviewPreflightAuthority {
  return {
    guiSurfaceAvailable: () => browserAutomationAvailable(),
    browserDrivable: ({ sessionId, signal }) => {
      signal.throwIfAborted();
      return browserViewHost().canDrive(sessionId, 'observe', { signal });
    },
    probeStagingRoot: ({ signal }) => probeStagingRoot(deps.stagingRoot(), signal),
    probeLoopback: ({ origin, signal }) => probeLoopback(origin, signal),
  };
}

async function probeStagingRoot(
  root: string | undefined,
  signal: AbortSignal,
): Promise<StagingRootProbe> {
  signal.throwIfAborted();
  if (root === undefined) return { kind: 'not_configured' };
  const path = join(root, `.preview-preflight-${randomUUID()}.probe`);
  try {
    // Creating the root is what the Open action itself does before it
    // materializes an artifact, so probing that way answers the question the
    // caller actually has rather than reporting a directory nobody made yet.
    await mkdir(root, { recursive: true });
    await writeFile(path, PROBE_CONTENT, { encoding: 'utf8', mode: 0o600 });
    // Write-then-read, because a directory that accepts a write but hands back
    // something else is exactly the "not the filesystem you think" case this
    // capability is meant to catch.
    const read = await readFile(path, { encoding: 'utf8' });
    if (read !== PROBE_CONTENT) {
      return { kind: 'unavailable', root, cause: 'a probe file read back different content' };
    }
    return { kind: 'round_tripped', root };
  } catch (error) {
    return { kind: 'unavailable', root, cause: describeCause(error) };
  } finally {
    await rm(path, { force: true }).catch(() => undefined);
  }
}

function probeLoopback(origin: string, signal: AbortSignal): Promise<LoopbackProbe> {
  signal.throwIfAborted();
  const url = new URL(origin);
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise<LoopbackProbe>((resolve, reject) => {
    const probe = send(
      url,
      { method: 'GET', signal, timeout: LOOPBACK_PROBE_TIMEOUT_MS },
      (response) => {
        const status = response.statusCode ?? 0;
        // Drain without reading: the status is the whole observation, and a
        // preview page's content has no business in a capability report.
        response.resume();
        probe.destroy();
        resolve({ kind: 'answered', status });
      },
    );
    probe.on('timeout', () => {
      probe.destroy(new Error(`no response within ${LOOPBACK_PROBE_TIMEOUT_MS}ms`));
    });
    probe.on('error', (error) => {
      // An aborted turn is a cancellation, not a statement about the endpoint.
      if (signal.aborted) reject(error);
      else resolve({ kind: 'no_answer', cause: describeCause(error) });
    });
    probe.end();
  });
}

/** Prefer the errno: ECONNREFUSED says more to a caller than its sentence does. */
function describeCause(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === 'string' && code !== '') return code;
  }
  return error instanceof Error ? error.message : String(error);
}
