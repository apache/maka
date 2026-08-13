import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

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
      "if(process.env.OPENAI_API_KEY||process.env.ANTHROPIC_API_KEY||process.env.DEEPSEEK_API_KEY!=='maka-eval-local')process.exit(9);await fetch(`${process.env.DEEPSEEK_BASE_URL}/responses`,{method:'POST',body:'{}'});console.log(JSON.stringify({type:'error'}));process.exit(1);\n",
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
        { env: { ...process.env, OPENAI_API_KEY: 'test-key' } },
      );
      const result = JSON.parse(stdout) as {
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
    } finally {
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('canonical Pi settlement remains completed when the CLI exits nonzero', async () => {
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
      "console.log(JSON.stringify({type:'agent_end',messages:[]}));",
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
      { env: { ...process.env, OPENAI_API_KEY: 'upstream-test-key' } },
    );
    const result = JSON.parse(stdout) as {
      status: string;
      artifacts: Array<{ kind: string; exitCode?: number }>;
    };
    assert.equal(result.status, 'completed');
    assert.equal(result.artifacts.find(({ kind }) => kind === 'external-process')?.exitCode, 1);
  } finally {
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});
