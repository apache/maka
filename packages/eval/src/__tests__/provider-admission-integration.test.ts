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
  for (const [statusCode, body, expectedStatus, admittedRequests] of [
    [429, '{"error":{"type":"rate_limit"}}', 'infra_failed', 0],
    [200, 'data: {"type":"response.created"}\n\ndata: [DONE]\n\n', 'failed', 1],
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
      "await fetch(`${process.env.DEEPSEEK_BASE_URL}/responses`, {method:'POST',body:'{}'}); console.log(JSON.stringify({type:'error'})); process.exit(1);\n",
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
        artifacts: Array<{ kind: string; admittedRequests?: number }>;
      };
      assert.equal(result.status, expectedStatus);
      assert.equal(
        result.artifacts.find(({ kind }) => kind === 'provider-metering')?.admittedRequests,
        admittedRequests,
      );
    } finally {
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  }
});
