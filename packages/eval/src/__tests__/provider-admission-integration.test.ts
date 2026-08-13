import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const RESULT_TOKEN = '0123456789abcdef0123456789abcdef';

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
      const { stdout } = await execFileAsync(
        process.execPath,
        [
          wrapper.pathname,
          'opencode',
          `http://127.0.0.1:${address.port}`,
          root,
          process.execPath,
          child,
        ],
        {
          env: {
            ...process.env,
            OPENAI_API_KEY: 'credential-sentinel-must-not-persist',
            MAKA_EVAL_RESULT_TOKEN: RESULT_TOKEN,
          },
        },
      );
      const result = decodeResultFrame(stdout) as {
        status: string;
        costUsd: number | null;
        usage: { cacheWriteTokens: number } | null;
        artifacts: Array<{
          kind: string;
          path?: string;
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
      assert.doesNotMatch(
        JSON.stringify(result),
        /(?:credential|stdout|stderr)-sentinel-must-not-persist/u,
      );
      assert.match(
        await readFile(join(root, 'logs/agent/opencode.jsonl'), 'utf8'),
        /stdout-sentinel-must-not-persist/u,
      );
      assert.match(
        await readFile(join(root, 'logs/agent/opencode.stderr.txt'), 'utf8'),
        /stderr-sentinel-must-not-persist/u,
      );
      assert.equal(
        result.artifacts.find(({ kind }) => kind === 'stdout')?.path,
        '/logs/agent/opencode.jsonl',
      );
      for (const name of await readdir(join(root, 'logs/agent'))) {
        assert.doesNotMatch(
          await readFile(join(root, 'logs/agent', name), 'utf8'),
          /credential-sentinel-must-not-persist|0123456789abcdef0123456789abcdef/u,
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

test('external trajectories are truncated at the persisted byte limit', async () => {
  const result = await executePiWithTerminalRecord(65 * 1024 * 1024);
  const stdout = result.artifacts.find(({ kind }) => kind === 'stdout');
  assert.equal(stdout?.persistedBytes, 64 * 1024 * 1024);
  assert.ok((stdout?.bytes ?? 0) > (stdout?.persistedBytes ?? 0));
  assert.equal(stdout?.truncatedBytes, (stdout?.bytes ?? 0) - (stdout?.persistedBytes ?? 0));
});

test('unbounded tool diagnostics stay in the metering snapshot, not the relay frame', async () => {
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
  const root = await mkdtemp(join(tmpdir(), 'maka-bounded-relay-result-'));
  const child = join(root, 'child.mjs');
  const toolNames = Array.from({ length: 200 }, (_, index) => `tool_${index}`);
  await writeFile(
    child,
    [
      `const tools=${JSON.stringify(toolNames)}.map(name=>({type:'function',function:{name}}));`,
      "await fetch(`${process.env.DEEPSEEK_BASE_URL}/responses`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'deepseek-v4-flash',tools})});",
      "console.log(JSON.stringify({type:'step_finish'}));",
      '',
    ].join('\n'),
  );
  try {
    const wrapper = new URL('../harbor-external-subject.js', import.meta.url);
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        wrapper.pathname,
        'opencode',
        `http://127.0.0.1:${address.port}`,
        root,
        process.execPath,
        child,
      ],
      {
        env: {
          ...process.env,
          OPENAI_API_KEY: 'upstream-test-key',
          MAKA_EVAL_RESULT_TOKEN: RESULT_TOKEN,
        },
      },
    );
    const result = decodeResultFrame(stdout) as {
      artifacts: Array<Record<string, unknown>>;
    };
    const metering = result.artifacts.find(({ kind }) => kind === 'provider-metering');
    assert.equal(metering?.toolNameCount, toolNames.length);
    assert.equal('toolNames' in (metering ?? {}), false);
    const snapshot = JSON.parse(
      await readFile(join(root, 'logs/agent/opencode.metering.json'), 'utf8'),
    ) as { toolNames: string[] };
    assert.deepEqual(snapshot.toolNames, [...toolNames].sort());
    const providerEvents = (
      await readFile(join(root, 'logs/agent/opencode.provider-events.jsonl'), 'utf8')
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; bodyBase64?: string });
    assert.equal(providerEvents[0]?.type, 'provider_request');
    assert.match(
      Buffer.from(providerEvents[0]?.bodyBase64 ?? '', 'base64').toString('utf8'),
      /tool_199/u,
    );
    assert.equal(
      providerEvents.some(({ type }) => type === 'provider_response_chunk'),
      true,
    );
    assert.equal(providerEvents.at(-1)?.type, 'provider_response_end');
  } finally {
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('downstream cancellation aborts an in-flight upstream provider request', async () => {
  const server = createServer(() => undefined);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const root = await mkdtemp(join(tmpdir(), 'maka-provider-abort-'));
  const child = join(root, 'child.mjs');
  await writeFile(
    child,
    [
      'const controller=new AbortController();',
      'setTimeout(()=>controller.abort(),50);',
      "await fetch(`${process.env.DEEPSEEK_BASE_URL}/responses`,{method:'POST',body:'{}',signal:controller.signal}).catch(()=>{});",
      "console.log(JSON.stringify({type:'error'}));",
      '',
    ].join('\n'),
  );
  try {
    const wrapper = new URL('../harbor-external-subject.js', import.meta.url);
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        wrapper.pathname,
        'opencode',
        `http://127.0.0.1:${address.port}`,
        root,
        process.execPath,
        child,
      ],
      {
        env: {
          ...process.env,
          OPENAI_API_KEY: 'upstream-test-key',
          MAKA_EVAL_RESULT_TOKEN: RESULT_TOKEN,
        },
        timeout: 2_000,
      },
    );
    const result = decodeResultFrame(stdout) as { status: string };
    assert.equal(result.status, 'infra_failed');
    assert.match(
      await readFile(join(root, 'logs/agent/opencode.provider-events.jsonl'), 'utf8'),
      /provider_error/u,
    );
  } finally {
    server.closeAllConnections();
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function executePiWithTerminalRecord(contentBytes: number): Promise<{
  status: string;
  failureReason: string | null;
  artifacts: Array<{
    kind: string;
    profile?: string;
    exitCode?: number;
    bytes?: number;
    persistedBytes?: number;
    truncatedBytes?: number;
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
    const { stdout } = await execFileAsync(
      process.execPath,
      [wrapper.pathname, 'pi', `http://127.0.0.1:${address.port}`, root, process.execPath, child],
      {
        env: {
          ...process.env,
          OPENAI_API_KEY: 'upstream-test-key',
          MAKA_EVAL_RESULT_TOKEN: RESULT_TOKEN,
        },
      },
    );
    return decodeResultFrame(stdout) as Awaited<ReturnType<typeof executePiWithTerminalRecord>>;
  } finally {
    server.close();
    await rm(root, { recursive: true, force: true });
  }
}

function decodeResultFrame(stdout: string): unknown {
  const [prefix, token, length, _digest, encoded] = stdout.trim().split(' ');
  assert.equal(prefix, 'MAKA-EVAL-RESULT-V1');
  assert.equal(token, RESULT_TOKEN);
  const payload = Buffer.from(encoded ?? '', 'base64url');
  assert.equal(payload.byteLength, Number(length));
  return JSON.parse(payload.toString()) as unknown;
}
