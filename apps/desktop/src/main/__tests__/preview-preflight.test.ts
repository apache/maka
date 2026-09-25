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
 * `unsupported`, the rule that no result claims a page is ready, and the
 * loopback probe driven against real sockets.
 */

import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { after, describe, it } from 'node:test';
import type { MakaTool, MakaToolContext } from '@maka/runtime/tool-runtime';
import { parseNavigable } from '../browser/logic.js';
import {
  assertLoopbackOrigin,
  buildPreviewPreflightTools,
  classifyBrowserView,
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
    probeLoopback: () => ({ kind: 'answered', status: 200 }),
    ...overrides,
  };
}

function run(
  authority: PreviewPreflightAuthority,
  args: { origin?: string } = {},
  signal?: AbortSignal,
): Promise<PreviewPreflightResult> {
  const [tool] = buildPreviewPreflightTools(authority);
  assert.ok(tool, 'the preflight publishes a tool');
  const preflight = tool as MakaTool<{ origin?: string }, PreviewPreflightResult>;
  return Promise.resolve(preflight.impl(args, ctx(signal)));
}

function capability(result: PreviewPreflightResult, id: PreviewCapabilityId): PreviewCapability {
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
  it('reports exactly what the address policy answers', () => {
    const probes = probeNavigableSchemes();
    assert.deepEqual(
      probes.map((probe) => probe.scheme),
      ['https:', 'http:', 'file:', 'data:'],
    );
    for (const probe of probes) {
      assert.equal(
        probe.navigable,
        parseNavigable(probe.sample) !== null,
        `${probe.scheme} agrees with parseNavigable`,
      );
    }
  });

  it('calls a rejected file:// an unsupported boundary and names the way around it', () => {
    const capability = classifyUrlSchemes(probeNavigableSchemes());
    assert.equal(capability.status, 'unsupported');
    assert.match(capability.evidence, /rejected file:/u);
    assert.match(capability.boundary ?? '', /requires an HTTP origin/u);
    assert.match(capability.boundary ?? '', /use ArtifactPreview/u);
  });

  it('follows the policy if file:// ever becomes navigable', () => {
    const capability = classifyUrlSchemes([
      { sample: 'https://x.invalid/', scheme: 'https:', navigable: true },
      { sample: 'file:///x', scheme: 'file:', navigable: true },
    ]);
    assert.equal(capability.status, 'verified');
  });

  it('separates a missing view host from a check that did not complete', () => {
    assert.equal(classifyGuiSurface({ ok: true, value: true }).status, 'verified');
    assert.equal(classifyGuiSurface({ ok: true, value: false }).status, 'unsupported');

    const unreadable = classifyGuiSurface({ ok: false, cause: 'provider exploded' });
    assert.equal(unreadable.status, 'unknown');
    assert.match(unreadable.evidence, /provider exploded/u);
  });

  it('never calls a refused view unsupported', () => {
    assert.equal(classifyBrowserView({ ok: true, value: true }).status, 'verified');

    const refused = classifyBrowserView({ ok: true, value: false });
    assert.equal(refused.status, 'unknown');
    assert.match(refused.boundary ?? '', /does not prove the browser is unreachable/u);
    assertClaimsNoCause(refused);

    assert.equal(classifyBrowserView({ ok: false, cause: 'host gone' }).status, 'unknown');
  });

  it('treats any HTTP status as proof of a listener, and of nothing more', () => {
    const capability = classifyLoopbackEndpoint({
      origin: 'http://127.0.0.1:8765',
      observed: { ok: true, value: { kind: 'answered', status: 404 } },
    });
    assert.equal(capability.status, 'verified');
    assert.match(capability.evidence, /HTTP 404/u);
    assert.match(capability.boundary ?? '', /not that any particular page exists there/u);
  });

  it('never turns a failed connection into an unsupported capability', () => {
    for (const cause of ['ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'DEPTH_ZERO_SELF_SIGNED_CERT']) {
      const capability = classifyLoopbackEndpoint({
        origin: 'http://127.0.0.1:8765',
        observed: { ok: true, value: { kind: 'no_answer', cause } },
      });
      assert.equal(capability.status, 'unknown', `${cause} is not a settled boundary`);
      assert.match(capability.evidence, new RegExp(cause, 'u'));
      // Something may well have listened: a TLS failure means it did.
      assert.doesNotMatch(capability.evidence, /nothing answered/iu);
      assert.match(capability.boundary ?? '', /does not prove sandbox isolation/u);
      assertClaimsNoCause(capability);
    }
  });
});

describe('preview preflight loopback argument', () => {
  it('reduces an accepted URL to its origin', () => {
    assert.equal(assertLoopbackOrigin('http://127.0.0.1:8765/preview.html'), 'http://127.0.0.1:8765');
    assert.equal(assertLoopbackOrigin('http://[::1]:8765/'), 'http://[::1]:8765');
  });

  it('rejects anything that would make the check an arbitrary outbound request', () => {
    assert.throws(() => assertLoopbackOrigin('example.com'), /Not a URL/u);
    assert.throws(() => assertLoopbackOrigin('file:///tmp/preview.html'), /Only http:\/\/ and https:\/\//u);
    assert.throws(() => assertLoopbackOrigin('http://192.168.1.4:8765/'), /Only 127\.0\.0\.1 and \[::1\]/u);
    assert.throws(() => assertLoopbackOrigin('http://example.com/'), /Only 127\.0\.0\.1 and \[::1\]/u);
    assert.throws(() => assertLoopbackOrigin('http://localhost:8765/'), /"localhost" is excluded/u);
    assert.throws(() => assertLoopbackOrigin('http://user:pw@127.0.0.1:8765/'), /Credentials are not accepted/u);
    assert.throws(() => assertLoopbackOrigin('http://127.0.0.1:8765/?token=x'), /no query or fragment/u);
    assert.throws(() => assertLoopbackOrigin('http://127.0.0.1:8765/#frag'), /no query or fragment/u);
  });
});

describe('preview preflight tool', () => {
  it('reports surface and endpoint separately and claims no page readiness', async () => {
    const result = await run(healthyAuthority(), { origin: 'http://127.0.0.1:8765/preview.html' });
    assert.equal(result.surface, 'verified');
    assert.equal(result.endpoint, 'verified');
    assert.equal('ready' in result, false, 'a listener is not a loaded page; #5235 owns that');
    assert.equal(result.alternative, undefined);
  });

  it('does not report a missing page as showable', async () => {
    // A 404 proves a listener, not the page. The summary must not claim more.
    const result = await run(
      healthyAuthority({ probeLoopback: () => ({ kind: 'answered', status: 404 }) }),
      { origin: 'http://127.0.0.1:8765/missing.html' },
    );
    assert.equal(result.endpoint, 'verified');
    assert.doesNotMatch(result.summary, /can be shown/iu);
    assert.match(result.summary, /does not prove the page you want exists there or loads/u);
  });

  it('keeps an unnamed endpoint from reading as a missing capability', async () => {
    const result = await run(healthyAuthority());
    assert.equal(result.surface, 'verified');
    assert.equal(result.endpoint, 'not_checked');
    assert.equal(result.capabilities.some((entry) => entry.id === 'loopback_endpoint'), false);
  });

  it('gives each summary branch its own answer', async () => {
    const summaries = {
      unsupported: (await run(healthyAuthority({ guiSurfaceAvailable: () => false }))).summary,
      listening: (await run(healthyAuthority(), { origin: 'http://127.0.0.1:8765' })).summary,
      unnamed: (await run(healthyAuthority())).summary,
      unnamedUnproven: (await run(healthyAuthority({ browserDrivable: () => false }))).summary,
      mixed: (
        await run(
          healthyAuthority({ probeLoopback: () => ({ kind: 'no_answer', cause: 'ECONNREFUSED' }) }),
          { origin: 'http://127.0.0.1:8765' },
        )
      ).summary,
    };
    assert.match(summaries.unsupported, /cannot display a page locally/u);
    assert.match(summaries.listening, /something is listening/u);
    assert.match(summaries.unnamed, /No endpoint was named/u);
    assert.match(summaries.unnamedUnproven, /surface itself is unproven/u);
    assert.match(summaries.mixed, /2 verified, 1 unsupported, 1 unknown/u);
    assert.equal(new Set(Object.values(summaries)).size, 5, 'no two branches share a summary');
  });

  it('points an uncovered report at ArtifactPreview without restating its guarantees', async () => {
    const result = await run(healthyAuthority());
    assert.match(result.alternative ?? '', /ArtifactPreview/u);
    assert.match(result.alternative ?? '', /Its description states what the URL/u);
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
    assert.equal(result.surface, 'unsupported');
    assert.equal(capability(result, 'browser_view').status, 'unsupported');
    assert.ok(result.alternative);
  });

  it('keeps an off-screen conversation unproven rather than unsupported', async () => {
    const result = await run(healthyAuthority({ browserDrivable: () => false }));
    assert.equal(result.surface, 'unknown');
    assert.equal(capability(result, 'browser_view').status, 'unknown');
  });

  it('rejects a bad origin as an argument error instead of an unknown capability', async () => {
    await assert.rejects(
      () => run(healthyAuthority(), { origin: 'http://192.168.1.4:8765/' }),
      /Only 127\.0\.0\.1 and \[::1\]/u,
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
    await assert.rejects(() => run(healthyAuthority(), {}, AbortSignal.abort(new Error('gone'))), /gone/u);
  });
});

describe('preview preflight loopback probe', () => {
  const servers: Server[] = [];
  const sockets: Socket[] = [];

  after(async () => {
    for (const socket of sockets) socket.destroy();
    for (const server of servers) await new Promise((resolve) => server.close(resolve));
  });

  async function listen(server: Server): Promise<string> {
    servers.push(server);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    const address = server.address();
    assert.ok(address && typeof address === 'object', 'the probe server is bound');
    return `http://127.0.0.1:${address.port}`;
  }

  const signal = new AbortController().signal;

  it('sends HEAD / and never requests the path it was given', async () => {
    const seen: string[] = [];
    const origin = await listen(
      createServer((request, response) => {
        seen.push(`${request.method} ${request.url}`);
        response.writeHead(404).end();
      }),
    );
    const authority = createPreviewPreflightAuthority();
    const [tool] = buildPreviewPreflightTools(authority);
    const preflight = tool as MakaTool<{ origin?: string }, PreviewPreflightResult>;
    await preflight.impl({ origin: `${origin}/delete-everything` }, ctx());
    assert.deepEqual(seen, ['HEAD /']);
  });

  it('records the status a live endpoint answers with', async () => {
    const origin = await listen(createServer((_request, response) => response.writeHead(404).end()));
    assert.deepEqual(await createPreviewPreflightAuthority().probeLoopback({ origin, signal }), {
      kind: 'answered',
      status: 404,
    });
  });

  it('settles on a 101 that never becomes a response', async () => {
    // Node routes a 101 to `upgrade` and closes the request without emitting
    // `response` or `error`; this is the path that used to hang.
    const server = createServer();
    server.on('connection', (socket) => {
      socket.once('data', () => {
        socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
      });
    });
    const origin = await listen(server);
    const started = Date.now();
    assert.deepEqual(await createPreviewPreflightAuthority().probeLoopback({ origin, signal }), {
      kind: 'answered',
      status: 101,
    });
    assert.ok(Date.now() - started < LOOPBACK_PROBE_TIMEOUT_MS, 'answered without waiting out the deadline');
  });

  it('propagates cancellation from a server that is saying nothing', async () => {
    const server = createServer();
    server.on('connection', (socket) => sockets.push(socket));
    const origin = await listen(server);
    const controller = new AbortController();
    const cancelled = Promise.resolve(
      createPreviewPreflightAuthority().probeLoopback({ origin, signal: controller.signal }),
    );
    controller.abort(new Error('turn ended'));
    await assert.rejects(() => cancelled, /turn ended/u);
  });

  it('enforces its deadline against a server that never answers', async () => {
    const server = createServer();
    server.on('connection', (socket) => sockets.push(socket));
    const origin = await listen(server);
    const probe = await createPreviewPreflightAuthority({ loopbackTimeoutMs: 120 }).probeLoopback({
      origin,
      signal,
    });
    assert.deepEqual(probe, { kind: 'no_answer', cause: 'no response within 120ms' });
  });

  it('reports a TLS handshake against a plain listener as no usable response', async () => {
    // Exercises the https branch without a certificate: something listens,
    // but nothing usable comes back, which is exactly the case "nothing
    // answered" would have misdescribed.
    const plain = await listen(createServer((_request, response) => response.writeHead(200).end()));
    const origin = plain.replace('http://', 'https://');
    const probe = await createPreviewPreflightAuthority().probeLoopback({ origin, signal });
    assert.equal(probe.kind, 'no_answer');
    const capability = classifyLoopbackEndpoint({ origin, observed: { ok: true, value: probe } });
    assert.equal(capability.status, 'unknown');
    assert.match(capability.evidence, /No usable HTTP response/u);
  });

  it('returns a refused connection as a value, not a throw', async () => {
    const server = createServer();
    const origin = await listen(server);
    await new Promise((resolve) => server.close(resolve));
    servers.splice(servers.indexOf(server), 1);
    const probe = await createPreviewPreflightAuthority().probeLoopback({ origin, signal });
    assert.equal(probe.kind, 'no_answer');
    assert.match(probe.kind === 'no_answer' ? probe.cause : '', /^E[A-Z]+$/u);
  });

  it('reports no GUI surface when no Desktop view host is registered', () => {
    assert.equal(createPreviewPreflightAuthority().guiSurfaceAvailable(), false);
  });
});
