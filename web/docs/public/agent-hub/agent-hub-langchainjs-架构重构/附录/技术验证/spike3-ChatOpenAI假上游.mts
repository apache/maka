import { createServer } from 'node:http';
import { ChatOpenAI } from '@langchain/openai';
const frames = [
 { choices: [{ index: 0, delta: { role: 'assistant', content: '', reasoning_content: '先分析送礼场景' } }] },
 { choices: [] },
 { choices: [{ index: 0, delta: { content: '推荐礼盒' } }] },
 { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'search_evidence', arguments: '{"query":' } }] } }] },
 { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"送礼"}' } }] } }] },
 { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
 { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
];
let mode = 'ok';
const srv = createServer((req, res) => { if (mode === '500') { res.writeHead(500, { 'content-type': 'application/json' }).end('{"error":{"message":"boom"}}'); return; }
  res.writeHead(200, { 'content-type': 'text/event-stream' }); for (const f of frames) res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'deepseek-reasoner', ...f })}\n\n`); res.end('data: [DONE]\n\n'); });
await new Promise<void>(r => srv.listen(0, r));
const m = new ChatOpenAI({ model: 'deepseek-reasoner', apiKey: 'x', configuration: { baseURL: `http://127.0.0.1:${(srv.address() as any).port}/v1` }, maxRetries: 0 });
const bound = m.bindTools([{ type: 'function', function: { name: 'search_evidence', description: 'd', parameters: { type: 'object', properties: { query: { type: 'string' } } } } }]);
let acc: any; for await (const c of await bound.stream('hi')) acc = acc ? acc.concat(c) : c;
console.log('content=', JSON.stringify(acc.content), 'reasoning=', JSON.stringify(acc.additional_kwargs?.reasoning_content), 'contentBlocks=', JSON.stringify(acc.contentBlocks?.map((b: any) => b.type)), 'tool_calls=', JSON.stringify(acc.tool_calls), 'usage=', JSON.stringify(acc.usage_metadata), 'finish=', acc.response_metadata?.finish_reason);
mode = '500'; try { await m.invoke('hi'); } catch (e: any) { console.log('500 ->', e.constructor.name, e.status, e.lc_error_code, String(e.message).slice(0, 60)); }
srv.close(); process.exit(0);
