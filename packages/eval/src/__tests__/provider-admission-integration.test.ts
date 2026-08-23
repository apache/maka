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
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { meteringCheckpointMacMatches } from '../metering-checkpoint.js';

const execFileAsync = promisify(execFile);
const RESULT_TOKEN = '0123456789abcdef0123456789abcdef';

// The wrapper's exit code projects its semantic status for the relay, which
// cannot read the result frame. Anything other than a completed subject exits
// nonzero, so running one is not an error to the caller — the frame is on
// stdout either way, and the exit code is a second reading of the same fact.
async function runWrapper(
  args: readonly string[],
  env: Record<string, string>,
): Promise<{ stdout: string; exitCode: number }> {
  try {
    const { stdout } = await execFileAsync(process.execPath, [...args], {
      env: { ...process.env, ...env },
    });
    return { stdout, exitCode: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; code?: number };
    if (typeof failure.stdout !== 'string' || typeof failure.code !== 'number') throw error;
    return { stdout: failure.stdout, exitCode: failure.code };
  }
}

// The provider states admission mid-stream and this connection never ends, so
// the request is still in flight when the wrapper is killed. The model work has
// been done and billed regardless, and the checkpoint has to say so: it is the
// difference between an attempt the framework retries and one it records.
test('provider metering checkpoint records admission before the request settles', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: {"type":"response.created"}\n\n');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const root = await mkdtemp(join(tmpdir(), 'maka-provider-checkpoint-'));
  const childPath = join(root, 'child.mjs');
  await writeFile(
    childPath,
    "await fetch(`${process.env.DEEPSEEK_BASE_URL}/responses`,{method:'POST',body:'{}'});",
  );
  const wrapper = new URL('../harbor-external-subject.js', import.meta.url);
  const wrapperProcess = spawn(
    process.execPath,
    [
      wrapper.pathname,
      'opencode',
      `http://127.0.0.1:${address.port}`,
      root,
      process.execPath,
      childPath,
    ],
    {
      env: {
        ...process.env,
        OPENAI_API_KEY: 'upstream-test-key',
        MAKA_EVAL_RESULT_TOKEN: RESULT_TOKEN,
      },
      stdio: 'ignore',
    },
  );
  try {
    const checkpointPath = join(root, 'logs/agent/opencode.provider-usage.json');
    const checkpoint = await waitForCheckpoint(checkpointPath, (value) => {
      return value.admittedRequests === 1;
    });
    assert.equal(checkpoint.schemaVersion, 'maka.external_provider_usage.v2');
    assert.equal(checkpoint.profile, 'opencode');
    assert.equal(meteringCheckpointMacMatches(checkpoint, RESULT_TOKEN), true);
    assert.equal(checkpoint.requests, 1);
    // Admitted while unsettled: the state the old counter could not express.
    assert.equal(checkpoint.inFlightRequests, 1);
    // This is not the proxy's last word, and says so rather than leaving the
    // host to infer it from a count that will read the same either way.
    assert.equal(checkpoint.settled, false);
    // No usage event arrived, so there is nothing to report as spent yet.
    assert.equal(checkpoint.usage, null);
    // Nothing derivable is stored — the host works those out from the counts.
    assert.equal('usageComplete' in checkpoint, false);
    assert.equal('costUsd' in checkpoint, false);
    assert.equal('settledRequests' in checkpoint, false);
  } finally {
    wrapperProcess.kill('SIGKILL');
    await once(wrapperProcess, 'exit').catch(() => undefined);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('provider failures remain infrastructure failures until inference admission', async () => {
  for (const [
    statusCode,
    body,
    expectedStatus,
    admittedRequests,
    usageComplete,
    expectedCacheWrite,
  ] of [
    [429, '{"error":{"type":"rate_limit"}}', 'infra_failed', 0, false, null],
    [200, 'data: {"type":"response.created"}\n\ndata: [DONE]\n\n', 'failed', 1, false, null],
    [
      200,
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":2,"input_tokens_details":{"cached_tokens":3,"cache_write_tokens":4},"output_tokens_details":{"reasoning_tokens":1}}}}\n\ndata: [DONE]\n\n',
      'failed',
      1,
      true,
      4,
    ],
  ] as const) {
    const server = createServer((_request, response) => {
      response.writeHead(statusCode, {
        'content-type': statusCode === 200 ? 'text/event-stream' : 'application/json',
      });
      response.end(body);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const root = await mkdtemp(join(tmpdir(), 'maka-provider-admission-'));
    const child = join(root, 'child.mjs');
    await writeFile(
      child,
      "if(process.env.OPENAI_API_KEY||process.env.ANTHROPIC_API_KEY||process.env.DEEPSEEK_API_KEY!=='maka-eval-local'||process.env.MAKA_EVAL_RESULT_TOKEN)process.exit(9);await fetch(`${process.env.DEEPSEEK_BASE_URL}/responses`,{method:'POST',body:'{}'});console.error('stderr-sentinel-must-not-persist');console.log('stdout-sentinel-must-not-persist');console.log(JSON.stringify({type:'error'}));process.exit(1);\n",
    );
    try {
      const wrapper = new URL('../harbor-external-subject.js', import.meta.url);
      const { stdout, exitCode } = await runWrapper(
        [
          wrapper.pathname,
          'opencode',
          `http://127.0.0.1:${address.port}`,
          root,
          process.execPath,
          child,
        ],
        {
          OPENAI_API_KEY: 'credential-sentinel-must-not-persist',
          MAKA_EVAL_RESULT_TOKEN: RESULT_TOKEN,
        },
      );
      // Neither of these subjects completed, and the relay has to be able to
      // see that without reading the frame.
      assert.equal(exitCode, 1);
      const result = decodeResultFrame(stdout) as {
        status: string;
        costUsd: number | null;
        usage: { cacheWriteTokens: number } | null;
        artifacts: Array<{
          kind: string;
          admittedRequests?: number;
          usageComplete?: boolean;
        }>;
      };
      assert.equal(result.status, expectedStatus);
      const metering = result.artifacts.find(({ kind }) => kind === 'provider-metering');
      assert.equal(metering?.admittedRequests, admittedRequests);
      assert.equal(metering?.usageComplete, usageComplete);
      assert.equal(result.usage?.cacheWriteTokens ?? null, expectedCacheWrite);
      assert.equal(result.costUsd === null, !usageComplete);
      const checkpoint = JSON.parse(
        await readFile(join(root, 'logs/agent/opencode.provider-usage.json'), 'utf8'),
      ) as Record<string, unknown>;
      assert.equal(
        (await stat(join(root, 'logs/agent/opencode.provider-usage.json'))).mode & 0o777,
        0o644,
      );
      assert.equal(checkpoint.requests, 1);
      assert.equal(checkpoint.inFlightRequests, 0);
      // The wrapper survived, so its final checkpoint is the proxy's last word
      // and a host reading it recovers the same figure the frame carries.
      assert.equal(checkpoint.settled, true);
      assert.equal(checkpoint.admittedRequests, admittedRequests);
      assert.equal(checkpoint.usageRequests, expectedCacheWrite === null ? 0 : 1);
      assert.doesNotMatch(
        JSON.stringify(result),
        /(?:credential|stdout|stderr)-sentinel-must-not-persist/u,
      );
      assert.equal(
        (await readdir(join(root, 'logs/agent')).catch(() => [])).some((name) =>
          name.endsWith('.stderr.txt'),
        ),
        false,
      );
      for (const name of await readdir(join(root, 'logs/agent'))) {
        assert.doesNotMatch(
          await readFile(join(root, 'logs/agent', name), 'utf8'),
          /(?:credential|stdout|stderr)-sentinel-must-not-persist|0123456789abcdef0123456789abcdef/u,
        );
      }
    } finally {
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('large canonical Pi settlement remains completed when the CLI exits nonzero', async () => {
  const result = await executePiWithTerminalRecord(2 * 1024 * 1024);
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(result.artifacts.find(({ kind }) => kind === 'external-process')?.exitCode, 1);
});

test('oversized external records are attributed to bounded classification', async () => {
  const result = await executePiWithTerminalRecord(17 * 1024 * 1024);
  assert.equal(result.status, 'infra_failed');
  assert.equal(result.failureReason, 'pi output record exceeded the classification limit');
  const stdout = result.artifacts.find(({ kind }) => kind === 'stdout');
  assert.equal(stdout?.profile, 'pi');
  assert.equal(stdout?.classification, 'record-too-large');
  assert.equal(stdout?.limitBytes, 16 * 1024 * 1024);
  assert.ok((stdout?.bytes ?? 0) > 16 * 1024 * 1024);
  assert.match(stdout?.sha256 ?? '', /^[0-9a-f]{64}$/u);
});

async function executePiWithTerminalRecord(contentBytes: number): Promise<{
  status: string;
  failureReason: string | null;
  artifacts: Array<{
    kind: string;
    profile?: string;
    exitCode?: number;
    bytes?: number;
    sha256?: string;
    classification?: string;
    limitBytes?: number;
  }>;
}> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":2}}}\n\ndata: [DONE]\n\n',
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const root = await mkdtemp(join(tmpdir(), 'maka-pi-terminal-'));
  const child = join(root, 'child.mjs');
  await writeFile(
    child,
    [
      "import {readFile} from 'node:fs/promises';",
      "const config=JSON.parse(await readFile(`${process.env.PI_CODING_AGENT_DIR}/models.json`,'utf8'));",
      "if(process.env.OPENAI_API_KEY!=='maka-eval-local'||process.env.ANTHROPIC_API_KEY||process.env.DEEPSEEK_API_KEY)process.exit(9);",
      "await fetch(`${config.providers['maka-proxy'].baseUrl}/responses`,{method:'POST',body:'{}'});",
      `await new Promise(resolve=>process.stdout.write(JSON.stringify({type:'agent_end',messages:[{role:'assistant',content:'x'.repeat(${contentBytes})}]})+'\\n',resolve));`,
      "console.log(JSON.stringify({type:'agent_settled'}));",
      'process.exit(1);',
      '',
    ].join('\n'),
  );
  try {
    const wrapper = new URL('../harbor-external-subject.js', import.meta.url);
    const { stdout } = await runWrapper(
      [wrapper.pathname, 'pi', `http://127.0.0.1:${address.port}`, root, process.execPath, child],
      { OPENAI_API_KEY: 'upstream-test-key', MAKA_EVAL_RESULT_TOKEN: RESULT_TOKEN },
    );
    return decodeResultFrame(stdout) as Awaited<ReturnType<typeof executePiWithTerminalRecord>>;
  } finally {
    server.close();
    await rm(root, { recursive: true, force: true });
  }
}

// A subject that leaves processes behind is now the ordinary case: the relay
// stops tearing an exited subject's scope down, because a task's own service has
// to reach the verifier. Those processes can reach this proxy too, and one
// arriving while the proxy is draining an earlier request would be admitted
// after the drain had already snapshotted what it was waiting for -- leaving a
// checkpoint that claims settlement over counts that no longer describe the run.
test('a request arriving while the proxy drains is refused, not counted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-provider-late-'));
  const admitted = join(root, 'admitted');
  const outcome = join(root, 'late-request.json');
  let upstreamRequests = 0;
  const server = createServer(async (_request, response) => {
    upstreamRequests += 1;
    // Held open so the drain is a window and not an instant, which is the only
    // shape in which a late request can be observed at all.
    await writeFile(admitted, '');
    setTimeout(() => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":2}}}\n\ndata: [DONE]\n\n',
      );
    }, 800);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const child = join(root, 'child.mjs');
  const straggler = join(root, 'straggler.mjs');
  const childExited = join(root, 'logs/agent/opencode.wrapper-state.json');
  // Outlives its parent and holds the child's stdout pipe open, keeping the
  // wrapper inside runChild until the exit callback publishes its barrier.
  // The second request therefore cannot race ahead of that callback, while a
  // report-time-only admission cut deadlocks instead of satisfying the test.
  await writeFile(
    straggler,
    `import { readFileSync, writeFileSync } from 'node:fs';
const [, , baseUrl, outcomePath, childExitedPath] = process.argv;
const held = fetch(\`\${baseUrl}/responses\`, { method: 'POST', body: '{}' }).catch(() => undefined);
const deadline = Date.now() + 5_000;
let sawChildExit = false;
while (Date.now() < deadline) {
  try {
    if (JSON.parse(readFileSync(childExitedPath, 'utf8')).phase === 'child_exited') {
      sawChildExit = true;
      break;
    }
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 10));
}
if (!sawChildExit) {
  await held;
  writeFileSync(outcomePath, JSON.stringify({ status: -2 }));
  process.exit(2);
}
let status = 0;
try {
  status = (await fetch(\`\${baseUrl}/responses\`, { method: 'POST', body: '{}' })).status;
} catch {
  status = -1;
}
writeFileSync(outcomePath, JSON.stringify({ status }));
await held;
`,
  );
  await writeFile(
    child,
    `import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
spawn(process.execPath, [${JSON.stringify(straggler)}, process.env.DEEPSEEK_BASE_URL, ${JSON.stringify(outcome)}, ${JSON.stringify(childExited)}], {
  detached: true,
  stdio: ['ignore', 'inherit', 'ignore'],
}).unref();
// Exits only once the proxy has a request to drain, so what follows is the
// drain window rather than a race against it.
while (!existsSync(${JSON.stringify(admitted)})) await new Promise((resolve) => setTimeout(resolve, 10));
console.log(JSON.stringify({ type: 'error' }));
process.exit(1);
`,
  );
  try {
    const wrapper = new URL('../harbor-external-subject.js', import.meta.url);
    const { stdout } = await runWrapper(
      [
        wrapper.pathname,
        'opencode',
        `http://127.0.0.1:${address.port}`,
        root,
        process.execPath,
        child,
      ],
      { OPENAI_API_KEY: 'upstream-test-key', MAKA_EVAL_RESULT_TOKEN: RESULT_TOKEN },
    );
    const result = decodeResultFrame(stdout) as {
      artifacts: Array<{ kind: string; requests?: number; usageRequests?: number }>;
    };
    const metering = result.artifacts.find(({ kind }) => kind === 'provider-metering');
    // The held request was waited out rather than abandoned: its usage is what
    // the run spent, and reporting before it landed would understate the bill.
    assert.equal(metering?.requests, 1);
    assert.equal(metering?.usageRequests, 1);

    const late = JSON.parse(await waitForFile(outcome)) as { status: number };
    // Refused rather than forwarded: the provider was never asked, so there is
    // nothing to count, and the settlement the checkpoint states stays true.
    assert.equal(late.status, 503);
    assert.equal(upstreamRequests, 1);

    const checkpoint = JSON.parse(
      await readFile(join(root, 'logs/agent/opencode.provider-usage.json'), 'utf8'),
    ) as Record<string, unknown>;
    assert.equal(checkpoint.settled, true);
    assert.equal(checkpoint.requests, 1);
    assert.equal(checkpoint.inFlightRequests, 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

async function waitForFile(path: string): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const contents = await readFile(path, 'utf8').catch(() => undefined);
    if (contents !== undefined) return contents;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${path}`);
}

function decodeResultFrame(stdout: string): unknown {
  const [prefix, token, length, _digest, encoded] = stdout.trim().split(' ');
  assert.equal(prefix, 'MAKA-EVAL-RESULT-V1');
  assert.equal(token, RESULT_TOKEN);
  const payload = Buffer.from(encoded ?? '', 'base64url');
  assert.equal(payload.byteLength, Number(length));
  return JSON.parse(payload.toString()) as unknown;
}

async function waitForCheckpoint(
  path: string,
  predicate: (value: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const text = await readFile(path, 'utf8').catch(() => undefined);
    if (text) {
      const value = JSON.parse(text) as Record<string, unknown>;
      if (predicate(value)) return value;
    }
    if (Date.now() >= deadline) throw new Error('provider checkpoint did not settle');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
