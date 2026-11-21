import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// 使用本机锁定版本的真实 SDK；不下载包，不访问厂商、不读用户凭据。
const piRoot = process.env.PI_PACKAGE_ROOT ?? '/Users/ggbdpq/.local/share/fnm/aliases/default/lib/node_modules/@earendil-works/pi-coding-agent';
const aiRoot = path.join(piRoot, 'node_modules/@earendil-works/pi-ai');
const load = relative => import(pathToFileURL(path.join(aiRoot, 'dist', relative)));
const { stream: chat } = await load('api/openai-completions.js');
const { stream: anthropic } = await load('api/anthropic-messages.js');
const { stream: responses } = await load('api/openai-responses.js');
const { isContextOverflow } = await load('utils/overflow.js');
const versions = {};
for (const [name, root] of [['pi-coding-agent', piRoot], ['pi-ai', aiRoot]]) {
  versions[name] = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
  assert.equal(versions[name], '1.2.0', `review ${name} changes before using another version`);
}
const hashes = {};
for (const relative of ['api/openai-completions.js', 'api/anthropic-messages.js', 'api/openai-responses.js', 'utils/overflow.js']) {
  hashes[path.join(aiRoot, 'dist', relative)] = createHash('sha256').update(await readFile(path.join(aiRoot, 'dist', relative))).digest('hex');
}
console.log(JSON.stringify({ versions, hashes }));
const fixtureRoot = process.argv[2];
assert.ok(fixtureRoot, 'usage: node pi-consumer-check.mjs FIXTURE_DIR [baseline]');
const baseline = process.argv[3] === 'baseline';
async function* files(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* files(full);
    else if (e.name.endsWith('.sse')) yield full;
  }
}
const clients = { chat: [chat, 'openai-completions', 'openai'], anthropic: [anthropic, 'anthropic-messages', 'anthropic'], responses: [responses, 'openai-responses', 'openai'] };
let tested = 0;
for await (const file of files(fixtureRoot)) {
  const name = path.basename(file, '.sse');
  const [run, api, provider] = clients[name.startsWith('byte-') ? name.slice('byte-'.length) : name.startsWith('context-') ? name.slice('context-'.length) : name.startsWith('ordinary-') ? name.slice('ordinary-'.length) : name] ?? [];
  if (!run) continue;
  const fixture = await readFile(file);
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests++;
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(fixture);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const model = { id: 'm', name: 'fixture', api, provider, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 };
    const result = await run(model, { messages: [{ role: 'user', content: 'hi', timestamp: 0 }] }, { apiKey: 'fixture', signal: AbortSignal.timeout(5000), maxTokens: 64 }).result();
    const overflow = isContextOverflow(result);
    const expected = name.startsWith('context-') || (!baseline && !name.startsWith('ordinary-'));
    console.log(JSON.stringify({ fixture: file, requests, stopReason: result.stopReason, errorMessage: result.errorMessage, overflow, expected }));
    assert.equal(requests, 1, `${name}: only local replay was requested`);
    assert.equal(result.stopReason, 'error', `${name}: SDK must parse a terminal error`);
    assert.equal(overflow, expected, `${name}: actual Pi classifier`);
    tested++;
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}
assert.ok(tested > 0, 'no captured gateway SSE fixtures');
console.log(`PASS: real Pi 1.2.0 consumed ${tested} gateway SSE fixture(s); no summary request or live vendor was run`);
