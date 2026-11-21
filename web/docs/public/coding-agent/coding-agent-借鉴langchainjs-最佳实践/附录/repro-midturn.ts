// 用法：复制到 impls/typescript/scripts/repro-midturn.ts，在 impls/typescript 下运行 node scripts/repro-midturn.ts
// 基线 develop@bbac303 的输出见 附录/README.md
import { runTurn } from '../src/core/agentloop.ts';
import { estimateTokens } from '../src/core/trim.ts';
import { createPermissionGate } from '../src/core/permission.ts';
const LIMIT = 100_000; // 假设 config.contextLimit
let calls = 0; const peaks: number[] = [];
const provider = { async chat(messages: any[], opts: any) {
  calls++; peaks.push(estimateTokens(messages));
  if (calls <= 8) return { message: { role: 'assistant', content: null, tool_calls: [{ id: 'c' + calls, type: 'function', function: { name: 'read', arguments: '{"file_path":"big.log"}' } }] } };
  return { message: { role: 'assistant', content: 'done' } };
} };
const read = { name: 'read', kind: 'tool', description: '', parameters: {}, needsPermission: false, preview: () => '', run: async () => 'x'.repeat(60_000) } as any;
const msgs: any[] = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'analyze' }];
await runTurn(msgs, { provider: provider as any, tools: [read] });
console.log('A. 单轮内每次模型请求前的估算 token：', peaks.join(' → '));
console.log('   超过 contextLimit(' + LIMIT + ') 的请求次数：', peaks.filter(p => p > LIMIT).length, '（轮内无任何治理）');
// B. 截断参数
let got: any = 'unset';
const write = { name: 'write', kind: 'tool', description: '', parameters: {}, needsPermission: false, preview: () => '', run: async (a: any) => { got = a; return '错误：缺少 file_path'; } } as any;
let n = 0;
const p2 = { async chat() { n++; return n === 1 ? { message: { role: 'assistant', content: null, tool_calls: [{ id: 'w1', type: 'function', function: { name: 'write', arguments: '{"file_path":"src/a.ts","content":"export const' } }] } } : { message: { role: 'assistant', content: 'ok' } }; } };
await runTurn([{ role: 'user', content: 'x' }] as any, { provider: p2 as any, tools: [write] });
console.log('B. finish_reason=length 截断的 tool 参数 → 工具实际收到：', JSON.stringify(got));
// C. always 的授权粒度
const yolo = { value: false }; const asked: string[] = [];
const gate = createPermissionGate({ ask: async (r) => { asked.push(r.tool); return 'always'; } }, yolo);
await gate('write', 'a.txt'); const r1 = await gate('bash', 'rm -rf build'); 
console.log('C. 对 write 选 always 后，bash 是否还询问：', asked.includes('bash') ? '询问' : '不再询问（全局 yolo）', '放行=', r1);
// D（WP4 合并后启用）：选 scoped 后 bash 仍应询问
// const grants = new Set<string>(); const asked2: string[] = [];
// const gate2 = createPermissionGate({ ask: async (r) => { asked2.push(r.tool); return 'scoped'; } }, { value: false }, grants);
// await gate2('write', 'a.txt', 'write'); await gate2('bash', 'rm -rf build', 'bash:rm');
// console.log('D. 对 write 选 scoped 后，bash 是否还询问：', asked2.includes('bash') ? '询问' : '不再询问');
