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
 * Local preview preflight: the verified / unsupported / unknown classification
 * for every capability, the rule that a connection outcome may never become
 * `unsupported`, and the probes driven against a real directory and a real
 * loopback socket.
 */

import { strict as assert } from 'node:assert';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import type { MakaTool, MakaToolContext } from '@maka/runtime/tool-runtime';
import {
  assertLoopbackOrigin,
  buildPreviewPreflightTools,
  classifyBrowserReachability,
  classifyFilesystemVisibility,
  classifyGuiSurface,
  classifyLoopbackEndpoint,
  classifyUrlSchemes,
  probeNavigableSchemes,
  type PreviewCapability,
  type PreviewCapabilityId,
  type PreviewPreflightAuthority,
  type PreviewPreflightResult,
} from '../preview-preflight.js';
import {
  createPreviewPreflightAuthority,
  LOOPBACK_PROBE_TIMEOUT_MS,
} from '../preview-preflight-probes.js';

function ctx(signal?: AbortSignal): MakaToolContext {
  return {
    sessionId: 's1',
    turnId: 't1',
    cwd: '/tmp',
    toolCallId: 'c1',
    abortSignal: signal ?? new AbortController().signal,
    emitOutput: () => {},
  };
}

/** Everything observable and healthy; each test spoils only what it is about. */
function healthyAuthority(
  overrides: Partial<PreviewPreflightAuthority> = {},
): PreviewPreflightAuthority {
  return {
    guiSurfaceAvailable: () => true,
    browserDrivable: () => true,
    probeStagingRoot: () => ({ kind: 'round_tripped', root: '/tmp/maka-runtime-host-artifacts' }),
    probeLoopback: () => ({ kind: 'answered', status: 200 }),
    ...overrides,
  };
}

function preflightTool(
  authority: PreviewPreflightAuthority,
): MakaTool<{ origin?: string }, PreviewPreflightResult> {
  const [tool] = buildPreviewPreflightTools(authority);
  assert.ok(tool, 'the preflight offer publishes a tool');
  return tool as MakaTool<{ origin?: string }, PreviewPreflightResult>;
}

function run(
  authority: PreviewPreflightAuthority,
  args: { origin?: string } = {},
  signal?: AbortSignal,
): Promise<PreviewPreflightResult> {
  return Promise.resolve(preflightTool(authority).impl(args, ctx(signal)));
}

function capability(
  result: PreviewPreflightResult,
  id: PreviewCapabilityId,
): PreviewCapability {
  const found = result.capabilities.find((entry) => entry.id === id);
  assert.ok(found, `the report covers ${id}`);
  return found;
}

/** No status may read as a cause the probe did not establish. */
function assertClaimsNoCause(capability: PreviewCapability): void {
  const text = `${capability.evidence} ${capability.boundary ?? ''}`;
  assert.doesNotMatch(
    text,
    /(?:is|are|was|were) (?:sandbox|isolat)/iu,
    `${capability.id} must not assert an isolation cause: ${text}`,
  );
}

describe('preview preflight capability classification', () => {
  it('reports the real address policy rather than a restatement of it', () => {
    const probes = probeNavigableSchemes();
    const navigable = new Map(probes.map((probe) => [probe.scheme, probe.navigable]));
    assert.equal(navigable.get('https:'), true);
    assert.equal(navigable.get('http:'), true);
    assert.equal(navigable.get('file:'), false);
    assert.equal(navigable.get('data:'), false);
  });

  it('calls a rejected file:// scheme an unsupported boundary and explains it', () => {
    const capability = classifyUrlSchemes(probeNavigableSchemes());
    assert.equal(capability.status, 'unsupported');
    assert.match(capability.evidence, /accepted https:, http:/u);
    assert.match(capability.evidence, /rejected file:, data:/u);
    assert.match(capability.boundary ?? '', /requires an HTTP origin/u);
    assert.match(capability.boundary ?? '', /deliberate boundary, not a missing feature/u);
    // A boundary the caller cannot move must name the way around it.
    assert.match(capability.boundary ?? '', /use ArtifactPreview to serve the same content over http/u);
  });

  it('follows the policy if file:// ever becomes navigable', () => {
    const capability = classifyUrlSchemes([
      { scheme: 'https:', navigable: true },
      { scheme: 'file:', navigable: true },
    ]);
    assert.equal(capability.status, 'verified');
  });

  it('separates a missing view host from a check that did not complete', () => {
    assert.equal(classifyGuiSurface({ ok: true, value: true }).status, 'verified');

    const absent = classifyGuiSurface({ ok: true, value: false });
    assert.equal(absent.status, 'unsupported');
    assert.match(absent.boundary ?? '', /only inside the desktop app/u);

    const unreadable = classifyGuiSurface({ ok: false, cause: 'provider exploded' });
    assert.equal(unreadable.status, 'unknown');
    assert.match(unreadable.evidence, /provider exploded/u);
    assert.match(unreadable.boundary ?? '', /does not mean the client is headless/u);
  });

  it('keeps a verified staging root from implying the generating process shares it', () => {
    const capability = classifyFilesystemVisibility({
      ok: true,
      value: { kind: 'round_tripped', root: '/tmp/staging' },
    });
    assert.equal(capability.status, 'verified');
    assert.match(capability.evidence, /Created, read back, and removed a probe file under \/tmp\/staging/u);
    assert.match(capability.boundary ?? '', /does not prove that the shell or sandboxed runtime/u);
  });

  it('reports an unreachable staging root as unknown with its cause', () => {
    const capability = classifyFilesystemVisibility({
      ok: true,
      value: { kind: 'unavailable', root: '/tmp/staging', cause: 'EACCES' },
    });
    assert.equal(capability.status, 'unknown');
    assert.match(capability.evidence, /EACCES/u);
    assert.match(capability.boundary ?? '', /does not distinguish a missing directory/u);
    assertClaimsNoCause(capability);
  });

  it('reports a client with no staging root as unsupported', () => {
    const capability = classifyFilesystemVisibility({ ok: true, value: { kind: 'not_configured' } });
    assert.equal(capability.status, 'unsupported');
  });

  it('treats a refused view as unknown and visibility-scoped, never as isolation', () => {
    const capability = classifyBrowserReachability({
      guiSurface: classifyGuiSurface({ ok: true, value: true }),
      drivable: { ok: true, value: false },
    });
    assert.equal(capability.status, 'unknown');
    assert.match(capability.boundary ?? '', /conversation the user is looking at/u);
    assert.match(capability.boundary ?? '', /does not prove the browser is unreachable/u);
    assertClaimsNoCause(capability);
  });

  it('will not call a view reachable when it was never asked', () => {
    const capability = classifyBrowserReachability({
      guiSurface: classifyGuiSurface({ ok: true, value: true }),
    });
    assert.equal(capability.status, 'unknown');
    assert.match(capability.evidence, /was not asked/u);
  });

  it('reports reachability as unsupported only when there is no view host at all', () => {
    const capability = classifyBrowserReachability({
      guiSurface: classifyGuiSurface({ ok: true, value: false }),
      drivable: { ok: true, value: false },
    });
    assert.equal(capability.status, 'unsupported');
  });

  it('accepts any HTTP answer as evidence that something listened', () => {
    const capability = classifyLoopbackEndpoint({
      origin: 'http://127.0.0.1:8765/',
      observed: { ok: true, value: { kind: 'answered', status: 404 } },
    });
    assert.equal(capability.status, 'verified');
    assert.match(capability.evidence, /answered with HTTP 404/u);
    // Symmetry: an answer to this process is not an answer for the browser.
    assert.match(capability.boundary ?? '', /does not prove the embedded browser shares/u);
  });

  it('never turns a failed connection into an unsupported capability', () => {
    for (const cause of ['ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH']) {
      const capability = classifyLoopbackEndpoint({
        origin: 'http://127.0.0.1:8765/',
        observed: { ok: true, value: { kind: 'no_answer', cause } },
      });
      assert.equal(capability.status, 'unknown', `${cause} is not a settled boundary`);
      assert.match(capability.evidence, new RegExp(cause, 'u'));
      assert.match(capability.boundary ?? '', /does not prove sandbox isolation/u);
      assert.match(capability.boundary ?? '', /nothing answered this process at that address/u);
      assertClaimsNoCause(capability);
    }
  });
});

describe('preview preflight loopback argument', () => {
  it('accepts a bounded loopback URL', () => {
    assert.equal(
      assertLoopbackOrigin('http://127.0.0.1:8765/preview.html'),
      'http://127.0.0.1:8765/preview.html',
    );
    assert.equal(assertLoopbackOrigin('http://[::1]:8765/'), 'http://[::1]:8765/');
  });

  it('rejects anything that would make the check an arbitrary outbound request', () => {
    assert.throws(() => assertLoopbackOrigin('example.com'), /Not a URL/u);
    assert.throws(() => assertLoopbackOrigin('file:///tmp/preview.html'), /Only http:\/\/ and https:\/\//u);
    assert.throws(() => assertLoopbackOrigin('http://192.168.1.4:8765/'), /Only the loopback interface/u);
    assert.throws(() => assertLoopbackOrigin('http://example.com/'), /Only the loopback interface/u);
    // Resolves through the host, so it can point somewhere other than loopback.
    assert.throws(() => assertLoopbackOrigin('http://localhost:8765/'), /"localhost" is excluded/u);
    assert.throws(() => assertLoopbackOrigin('http://user:pw@127.0.0.1:8765/'), /Credentials are not accepted/u);
    assert.throws(() => assertLoopbackOrigin('http://127.0.0.1:8765/?token=x'), /no query or fragment/u);
    assert.throws(() => assertLoopbackOrigin('http://127.0.0.1:8765/#frag'), /no query or fragment/u);
  });
});

describe('preview preflight tool', () => {
  it('claims ready only on a verified surface and an endpoint that answered', async () => {
    const result = await run(healthyAuthority(), { origin: 'http://127.0.0.1:8765/preview.html' });
    assert.equal(result.ready, true);
    assert.equal(result.surface, 'verified');
    assert.equal(result.endpoint, 'verified');
    assert.equal(result.alternative, undefined);
    assert.equal(capability(result, 'loopback_endpoint').status, 'verified');
  });

  it('never claims ready from the absence of an error', async () => {
    // Everything else is verified; only the endpoint is unproven.
    const result = await run(
      healthyAuthority({ probeLoopback: () => ({ kind: 'no_answer', cause: 'ECONNREFUSED' }) }),
      { origin: 'http://127.0.0.1:8765/preview.html' },
    );
    assert.equal(result.ready, false);
    assert.equal(result.surface, 'verified');
    assert.equal(result.endpoint, 'unknown');
    assert.equal(capability(result, 'loopback_endpoint').status, 'unknown');
  });

  it('keeps an unnamed endpoint from reading as a missing capability', async () => {
    const result = await run(healthyAuthority());
    // The surface stands on its own evidence; only the endpoint is unanswered.
    assert.equal(result.surface, 'verified');
    assert.equal(result.endpoint, 'not_checked');
    assert.equal(result.ready, false);
    assert.equal(
      result.capabilities.some((entry) => entry.id === 'loopback_endpoint'),
      false,
      'an endpoint that was never named produces no capability entry',
    );
  });

  it('separates a settled surface boundary from an unproven one', async () => {
    const headless = await run(healthyAuthority({ guiSurfaceAvailable: () => false }));
    assert.equal(headless.surface, 'unsupported');

    const offScreen = await run(healthyAuthority({ browserDrivable: () => false }));
    assert.equal(offScreen.surface, 'unknown');
    assert.doesNotMatch(offScreen.summary, /cannot display/u);
  });

  it('points an unready report at the managed preview endpoint', async () => {
    const result = await run(healthyAuthority());
    assert.match(result.alternative ?? '', /ArtifactPreview/u);
    assert.match(result.alternative ?? '', /no shell server and no file:\/\/ navigation/u);
    // The handoff must carry its own caveat, not just its happy path.
    assert.match(result.alternative ?? '', /not a browser load/u);
  });

  it('covers every capability with an observation behind its status', async () => {
    const result = await run(healthyAuthority(), { origin: 'http://127.0.0.1:8765/' });
    assert.deepEqual(
      result.capabilities.map((entry) => entry.id),
      ['gui_surface', 'url_schemes', 'filesystem_visibility', 'browser_reachability', 'loopback_endpoint'],
    );
    for (const entry of result.capabilities) {
      assert.notEqual(entry.evidence.trim(), '', `${entry.id} names its observation`);
    }
  });

  it('reports a headless client without asking a view host that cannot answer', async () => {
    let asked = 0;
    const result = await run(
      healthyAuthority({
        guiSurfaceAvailable: () => false,
        browserDrivable: () => {
          asked += 1;
          throw new Error('Browser automation is only available inside the desktop app.');
        },
      }),
    );
    assert.equal(asked, 0, 'a settled unsupported answer is not downgraded to unknown by a throw');
    assert.equal(capability(result, 'gui_surface').status, 'unsupported');
    assert.equal(capability(result, 'browser_reachability').status, 'unsupported');
    assert.ok(result.alternative, 'a client that cannot preview is still told what to do instead');
  });

  it('turns a probe that fails into an unknown carrying its cause', async () => {
    const result = await run(
      healthyAuthority({
        probeStagingRoot: () => {
          throw new Error('staging probe exploded');
        },
      }),
    );
    const filesystem = capability(result, 'filesystem_visibility');
    assert.equal(filesystem.status, 'unknown');
    assert.match(filesystem.evidence, /staging probe exploded/u);
    // Materializing a file is a separate question from displaying a page, so a
    // failed staging probe must not drag the surface down with it.
    assert.equal(result.surface, 'verified');
  });

  it('rejects a bad origin as an argument error instead of an unknown capability', async () => {
    await assert.rejects(
      () => run(healthyAuthority(), { origin: 'http://192.168.1.4:8765/' }),
      /Only the loopback interface/u,
    );
  });

  it('propagates cancellation instead of reporting it as a finding', async () => {
    const controller = new AbortController();
    await assert.rejects(
      () =>
        run(
          healthyAuthority({
            guiSurfaceAvailable: () => {
              controller.abort(new Error('turn ended'));
              throw new Error('turn ended');
            },
          }),
          {},
          controller.signal,
        ),
      /turn ended/u,
    );

    const already = AbortSignal.abort(new Error('already gone'));
    await assert.rejects(() => run(healthyAuthority(), {}, already), /already gone/u);
  });
});

describe('preview preflight probes', () => {
  const servers: Server[] = [];
  const sockets: Socket[] = [];
  const roots: string[] = [];

  after(async () => {
    for (const socket of sockets) socket.destroy();
    for (const server of servers) await new Promise((resolve) => server.close(resolve));
    for (const root of roots) await rm(root, { recursive: true, force: true }).catch(() => undefined);
  });

  async function tempRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'maka-preflight-'));
    roots.push(root);
    return root;
  }

  function listen(): Promise<Server> {
    const server = createServer((_request, response) => {
      response.writeHead(404).end('nope');
    });
    servers.push(server);
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
  }

  function originOf(server: Server): string {
    const address = server.address();
    assert.ok(address && typeof address === 'object', 'the probe server is bound');
    return `http://127.0.0.1:${address.port}/`;
  }

  const signal = new AbortController().signal;

  it('round-trips a probe file under a real staging root and leaves nothing behind', async () => {
    const root = await tempRoot();
    const authority = createPreviewPreflightAuthority({ stagingRoot: () => root });
    assert.deepEqual(await authority.probeStagingRoot({ signal }), { kind: 'round_tripped', root });
    const { readdir } = await import('node:fs/promises');
    assert.deepEqual(await readdir(root), []);
  });

  it('reports an unusable staging root as unavailable with its errno', async () => {
    const root = await tempRoot();
    const blocked = join(root, 'not-a-directory');
    await writeFile(blocked, 'x', 'utf8');
    const authority = createPreviewPreflightAuthority({ stagingRoot: () => blocked });
    const probe = await authority.probeStagingRoot({ signal });
    assert.equal(probe.kind, 'unavailable');
    assert.match(probe.kind === 'unavailable' ? probe.cause : '', /^E[A-Z]+$/u);
  });

  it('reports a client with no staging root instead of inventing a path', async () => {
    const authority = createPreviewPreflightAuthority({ stagingRoot: () => undefined });
    assert.deepEqual(await authority.probeStagingRoot({ signal }), { kind: 'not_configured' });
  });

  it('records the status a live loopback endpoint answers with', async () => {
    const server = await listen();
    const authority = createPreviewPreflightAuthority({ stagingRoot: () => undefined });
    assert.deepEqual(await authority.probeLoopback({ origin: originOf(server), signal }), {
      kind: 'answered',
      status: 404,
    });
  });

  it('answers from the status line without waiting for or reading a large body', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      // Larger than the probe will ever drain, and deliberately still open when
      // the probe answers: a preview page's bytes must not gate the report.
      response.write('x'.repeat(4 * 1024 * 1024));
      setTimeout(() => response.end(), 50);
    });
    servers.push(server);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    const authority = createPreviewPreflightAuthority({ stagingRoot: () => undefined });
    assert.deepEqual(await authority.probeLoopback({ origin: originOf(server), signal }), {
      kind: 'answered',
      status: 200,
    });
    // Give the torn-down body a turn of the loop to surface anything it emits.
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  /** A server that answers 101, which Node routes to `upgrade`, not `response`. */
  async function listenUpgrading(): Promise<Server> {
    const server = createServer();
    server.on('connection', (socket) => {
      socket.once('data', () => {
        socket.write(
          'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
        );
      });
    });
    servers.push(server);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    return server;
  }

  /** A server that accepts the connection and then says nothing at all. */
  async function listenSilent(): Promise<Server> {
    const server = createServer();
    server.on('connection', (socket) => sockets.push(socket));
    servers.push(server);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    return server;
  }

  it('settles on a 101 that never becomes a response', async () => {
    const server = await listenUpgrading();
    const authority = createPreviewPreflightAuthority({ stagingRoot: () => undefined });
    const started = Date.now();
    // A 101 still proves something listened, which is all this capability claims.
    assert.deepEqual(await authority.probeLoopback({ origin: originOf(server), signal }), {
      kind: 'answered',
      status: 101,
    });
    assert.ok(
      Date.now() - started < LOOPBACK_PROBE_TIMEOUT_MS,
      'the answer arrives without waiting out the deadline',
    );
  });

  it('propagates cancellation from a server that is saying nothing', async () => {
    const silent = await listenSilent();
    const controller = new AbortController();
    const authority = createPreviewPreflightAuthority({ stagingRoot: () => undefined });
    // Nothing will ever arrive on this socket, so the probe's own abort
    // listener is the only thing that can settle it before the deadline.
    const cancelled = Promise.resolve(
      authority.probeLoopback({ origin: originOf(silent), signal: controller.signal }),
    );
    controller.abort(new Error('turn ended'));
    await assert.rejects(() => cancelled, /turn ended/u);
  });

  it('enforces its deadline against a server that never answers', async () => {
    const server = await listenSilent();
    const authority = createPreviewPreflightAuthority({
      stagingRoot: () => undefined,
      loopbackTimeoutMs: 120,
    });
    const probe = await authority.probeLoopback({ origin: originOf(server), signal });
    assert.equal(probe.kind, 'no_answer');
    assert.match(probe.kind === 'no_answer' ? probe.cause : '', /no response within 120ms/u);
  });

  it('returns a refused connection as a value, not a throw', async () => {
    const server = await listen();
    const origin = originOf(server);
    await new Promise((resolve) => server.close(resolve));
    const authority = createPreviewPreflightAuthority({ stagingRoot: () => undefined });
    const probe = await authority.probeLoopback({ origin, signal });
    assert.equal(probe.kind, 'no_answer');
    assert.match(probe.kind === 'no_answer' ? probe.cause : '', /^E[A-Z]+$/u);
  });

  it('reports no GUI surface when no Desktop view host is registered', () => {
    const authority = createPreviewPreflightAuthority({ stagingRoot: () => undefined });
    assert.equal(authority.guiSurfaceAvailable(), false);
  });
});
