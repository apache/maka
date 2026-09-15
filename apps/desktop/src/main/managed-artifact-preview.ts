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

import { randomBytes } from 'node:crypto';
import { createServer, request, type Server } from 'node:http';
import { isCanonicalArtifactEntityId } from '@maka/core/artifacts';
import type { DesktopRuntimeHostClient } from './runtime-host-client.js';

export const PREVIEW_MAX_BYTES = 8 * 1024 * 1024;
const MAX_PREVIEWS = 16;
const PREVIEW_TTL_MS = 30 * 60 * 1000;
const READ_DEADLINE_MS = 30_000;

export interface ArtifactPreviewEndpoint {
  readonly url: string;
  readonly expiresAt: number;
  readonly reachable: true;
  readonly loaded: false;
}

type ArtifactClient = Pick<DesktopRuntimeHostClient, 'getArtifact' | 'streamArtifact'>;
interface Lease {
  scope: string;
  sessionId: string;
  artifactId: string;
  server: Server;
  timer?: ReturnType<typeof setTimeout>;
  url?: string;
}

/** Desktop-owned, bounded, ephemeral HTML snapshots. No workspace directory is served. */
export class ManagedArtifactPreview {
  private readonly leases = new Set<Lease>();
  private readonly retiredScopes = new Set<string>();
  private closed = false;

  constructor(private readonly ttlMs = PREVIEW_TTL_MS) {}

  async releaseUrl(url: string): Promise<void> {
    const lease = [...this.leases].find((entry) => entry.url === url);
    if (lease) await this.release(lease);
  }

  async prepare(
    scope: string,
    client: ArtifactClient,
    sessionId: string,
    artifactId: string,
    signal?: AbortSignal,
  ): Promise<ArtifactPreviewEndpoint> {
    if (!isCanonicalArtifactEntityId(sessionId) || !isCanonicalArtifactEntityId(artifactId)) {
      throw new Error('Invalid Artifact identity');
    }
    if (this.closed || this.retiredScopes.has(scope)) throw new Error('Preview owner is closed');
    if (this.leases.size >= MAX_PREVIEWS) throw new Error('Too many active previews; wait for expiry');
    signal?.throwIfAborted();
    // Reserve before asynchronous reads, so concurrent preparations cannot exceed the bound.
    const lease: Lease = { scope, sessionId, artifactId, server: createServer() };
    this.leases.add(lease);
    const assertActive = () => {
      signal?.throwIfAborted();
      if (!this.leases.has(lease)) throw new Error('Preview owner is closed');
    };
    try {
      const artifact = await withDeadline(client.getArtifact(sessionId, artifactId), signal);
      assertActive();
      if (!artifact || artifact.kind !== 'html') throw new Error('An existing HTML Artifact is required');
      if (!Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes < 0 || artifact.sizeBytes > PREVIEW_MAX_BYTES) {
        throw new Error('HTML preview exceeds the 8 MiB limit; use Save As instead');
      }
      const chunks: Buffer[] = [];
      let size = 0;
      const total = await withDeadline(client.streamArtifact(sessionId, artifactId, async (chunk) => {
        assertActive();
        size += chunk.byteLength;
        if (size > artifact.sizeBytes || size > PREVIEW_MAX_BYTES) throw new Error('Artifact size mismatch');
        chunks.push(Buffer.from(chunk));
      }), signal);
      assertActive();
      if (size !== artifact.sizeBytes || total !== size) throw new Error('Artifact size mismatch');
      const bytes = Buffer.concat(chunks, size);
      const path = `/${randomBytes(32).toString('hex')}/index.html`;
      let host = '';
      // One origin per lease and a sandbox without same-origin authority keep previews isolated.
      lease.server.on('request', (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        if (req.headers.host !== host || req.url !== path || !this.leases.has(lease)) {
          res.writeHead(404).end();
          return;
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { Allow: 'GET, HEAD' }).end();
          return;
        }
        res.setHeader('Content-Security-Policy', "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': bytes.length });
        res.end(req.method === 'HEAD' ? undefined : bytes);
      });
      lease.server.requestTimeout = 5_000;
      lease.server.headersTimeout = 5_000;
      lease.server.maxConnections = 16;
      await new Promise<void>((resolve, reject) => {
        lease.server.once('error', reject);
        lease.server.listen(0, '127.0.0.1', () => {
          lease.server.removeListener('error', reject);
          resolve();
        });
      });
      assertActive();
      const address = lease.server.address();
      if (!address || typeof address === 'string') throw new Error('Preview listener is unavailable');
      host = `127.0.0.1:${address.port}`;
      const url = `http://${host}${path}`;
      lease.url = url;
      // A listening socket alone is not readiness evidence. Check the exact authorized route.
      await new Promise<void>((resolve, reject) => {
        const probe = request(url, { method: 'HEAD', signal: AbortSignal.timeout(3_000) }, (response) => {
          response.resume();
          if (response.statusCode === 200 && response.headers['content-length'] === String(bytes.length)) resolve();
          else reject(new Error('Preview endpoint health check failed'));
        });
        probe.on('error', reject);
        probe.end();
      });
      assertActive();
      const expiresAt = Date.now() + this.ttlMs;
      lease.timer = setTimeout(() => { void this.release(lease); }, this.ttlMs);
      lease.timer.unref();
      lease.server.unref();
      return { url, expiresAt, reachable: true, loaded: false };
    } catch (error) {
      await this.release(lease);
      throw error;
    }
  }

  async revoke(scope: string, sessionId: string, artifactId: string): Promise<void> {
    await Promise.all([...this.leases].filter((lease) => lease.scope === scope && lease.sessionId === sessionId && lease.artifactId === artifactId).map((lease) => this.release(lease)));
  }

  async closeScope(scope: string): Promise<void> {
    this.retiredScopes.add(scope);
    await Promise.all([...this.leases].filter((lease) => lease.scope === scope).map((lease) => this.release(lease)));
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.leases].map((lease) => this.release(lease)));
  }

  private async release(lease: Lease): Promise<void> {
    this.leases.delete(lease);
    clearTimeout(lease.timer);
    await new Promise<void>((resolve) => {
      lease.server.close(() => resolve());
      lease.server.closeAllConnections();
    });
    lease.server.removeAllListeners('request');
  }
}

async function withDeadline<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  const timeout = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => reject(new Error('Artifact preview read timed out')), READ_DEADLINE_MS);
    timer.unref();
  });
  const cancelled = signal ? new Promise<never>((_, reject) => {
    if (signal.aborted) reject(signal.reason ?? new Error('The preview request was cancelled'));
    else signal.addEventListener('abort', () => reject(signal.reason ?? new Error('The preview request was cancelled')), { once: true });
  }) : undefined;
  return Promise.race([promise, timeout, ...(cancelled ? [cancelled] : [])]);
}
