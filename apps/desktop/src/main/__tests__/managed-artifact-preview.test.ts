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

import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';
import { z } from 'zod';
import { ManagedArtifactPreview, PREVIEW_MAX_BYTES } from '../managed-artifact-preview.js';
import { buildManagedArtifactPreviewTools } from '../managed-artifact-preview-tools.js';
import type { DesktopRuntimeHostClient } from '../runtime-host-client.js';

const html = '<!doctype html><title>Counter</title><button onclick="this.textContent=Number(this.textContent)+1">0</button>';
function client(content = html): Pick<DesktopRuntimeHostClient, 'getArtifact' | 'streamArtifact'> {
  const bytes = Buffer.from(content);
  return {
    getArtifact: async () => ({ id: 'a1', sessionId: 's1', turnId: 't1', createdAt: 0, name: 'counter.html', kind: 'html', sizeBytes: bytes.length, source: 'tool_result' }),
    streamArtifact: async (_sessionId, _artifactId, write) => { await write(bytes); return bytes.length; },
  };
}

function status(url: string, options: { host?: string; method?: string; path?: string } = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: options.method ?? 'GET',
      ...(options.path ? { path: options.path } : {}),
      ...(options.host ? { headers: { Host: options.host } } : {}),
    }, (res) => { res.resume(); resolve(res.statusCode!); });
    req.on('error', reject);
    req.end();
  });
}

test('serves exact registered bytes over loopback without claiming a browser load', async () => {
  const service = new ManagedArtifactPreview();
  try {
    const endpoint = await service.prepare('host1', client(), 's1', 'a1');
    assert.equal(new URL(endpoint.url).hostname, '127.0.0.1');
    assert.match(new URL(endpoint.url).pathname, /^\/[a-f0-9]{64}\/index.html$/);
    assert.equal(endpoint.reachable, true);
    assert.equal(endpoint.loaded, false);
    assert.ok(endpoint.expiresAt > Date.now());
    const response = await fetch(endpoint.url);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), html);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    const csp = response.headers.get('content-security-policy')!;
    assert.match(csp, /sandbox allow-scripts;/);
    assert.doesNotMatch(csp, /allow-same-origin|allow-popups|allow-top-navigation/);
    assert.match(csp, /connect-src 'none'/);
    assert.equal(await status(endpoint.url, { method: 'HEAD' }), 200);
    assert.equal(await status(endpoint.url, { method: 'POST' }), 405);
    assert.equal(await status(endpoint.url, { host: 'attacker.example' }), 404);
    for (const path of ['/', '/favicon.ico', '/wrong/index.html', '/../secret', new URL(endpoint.url).pathname + '?query=1']) {
      assert.equal(await status(endpoint.url, { path }), 404);
    }
  } finally { await service.close(); }
});

test('isolates leases by origin and rejects credentials for another preview', async () => {
  const service = new ManagedArtifactPreview();
  try {
    const first = await service.prepare('host1', client(), 's1', 'a1');
    const second = await service.prepare('host2', client('second'), 's1', 'a1');
    assert.notEqual(new URL(first.url).origin, new URL(second.url).origin);
    assert.equal(await status(first.url, { path: new URL(second.url).pathname }), 404);
    await service.closeScope('host1');
    await assert.rejects(fetch(first.url));
    assert.equal(await (await fetch(second.url)).text(), 'second');
    await assert.rejects(service.prepare('host1', client(), 's1', 'a1'), /closed/);
    await service.revoke('host2', 's1', 'a1');
    await assert.rejects(fetch(second.url));
  } finally { await service.close(); }
});

test('expires and closes its listener without deleting the durable Artifact', async () => {
  const service = new ManagedArtifactPreview(25);
  try {
    const source = client();
    const endpoint = await service.prepare('host1', source, 's1', 'a1');
    await new Promise((resolve) => setTimeout(resolve, 60));
    await assert.rejects(fetch(endpoint.url));
    assert.equal((await source.getArtifact('s1', 'a1'))?.kind, 'html');
  } finally { await service.close(); }
});

test('rejects missing, non-HTML, oversized, inconsistent and malformed artifacts', async () => {
  const service = new ManagedArtifactPreview();
  try {
    await assert.rejects(service.prepare('h', client(), '../session', 'a1'), /identity/);
    await assert.rejects(service.prepare('h', { ...client(), getArtifact: async () => null }, 's1', 'a1'), /existing HTML/);
    const source = client();
    const artifact = (await source.getArtifact('s1', 'a1'))!;
    for (const patch of [{ kind: 'file' as const }, { sizeBytes: PREVIEW_MAX_BYTES + 1 }, { sizeBytes: -1 }]) {
      await assert.rejects(service.prepare('h', { ...source, getArtifact: async () => ({ ...artifact, ...patch }) }, 's1', 'a1'));
    }
    await assert.rejects(service.prepare('h', { ...source, streamArtifact: async () => 0 }, 's1', 'a1'), /size mismatch/);
    await assert.rejects(service.prepare('h', { ...source, streamArtifact: async (_s, _a, write) => { await write(Buffer.alloc(PREVIEW_MAX_BYTES + 1)); return 0; } }, 's1', 'a1'), /size mismatch/);
    await assert.rejects(service.prepare('h', { ...source, streamArtifact: async () => { throw new Error('Read failed'); } }, 's1', 'a1'), /Read failed/);
    // Failed preparations release reservations and do not poison subsequent attempts.
    assert.equal((await service.prepare('h', source, 's1', 'a1')).reachable, true);
  } finally { await service.close(); }
});

test('close and cancellation during a stream cannot publish a live endpoint', async () => {
  for (const cancel of [false, true]) {
    const service = new ManagedArtifactPreview();
    const abort = new AbortController();
    const source = client();
    try {
      await assert.rejects(service.prepare('h', {
        ...source,
        streamArtifact: async (...args) => {
          if (cancel) abort.abort(); else await service.closeScope('h');
          return source.streamArtifact(...args);
        },
      }, 's1', 'a1', abort.signal));
    } finally { await service.close(); }
  }
});

test('bounds concurrent preparations before allocating buffers or ports', async () => {
  const service = new ManagedArtifactPreview();
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  const source = client();
  const slow = { ...source, getArtifact: async (s: string, a: string) => { await gate; return source.getArtifact(s, a); } };
  const pending = Array.from({ length: 16 }, () => service.prepare('h', slow, 's1', 'a1'));
  try {
    await assert.rejects(service.prepare('h', slow, 's1', 'a1'), /Too many/);
    resume();
    assert.equal((await Promise.all(pending)).length, 16);
  } finally { resume(); await Promise.allSettled(pending); await service.close(); }
});

test('tool binds to the admitted session and returns endpoint evidence only', async () => {
  const service = new ManagedArtifactPreview();
  try {
    const [tool] = buildManagedArtifactPreviewTools((sessionId, artifactId, signal) => {
      assert.equal(sessionId, 's1');
      return service.prepare('h', client(), sessionId, artifactId, signal);
    });
    assert.equal((tool!.parameters as z.ZodType).safeParse({ artifactId: 'a1', sessionId: 'other' }).success, false);
    const result = await tool!.impl({ artifactId: 'a1' }, { sessionId: 's1', turnId: 't1', cwd: '/tmp', toolCallId: 'c1', abortSignal: new AbortController().signal, emitOutput: () => {} });
    assert.equal((result as { loaded: boolean }).loaded, false);
  } finally { await service.close(); }
});
