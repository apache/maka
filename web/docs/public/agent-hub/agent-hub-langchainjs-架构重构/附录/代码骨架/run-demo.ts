// 骨架自检：同一张图跑离线剧本 3 场景 + 多轮 + 证据校验自我修正 + 超限 + 上游异常 + 中止。
// 运行：cd <含 node_modules 的目录> && node skeleton/run-demo.ts
import assert from 'node:assert/strict';
import { HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { AgentStreamEvent } from './contracts.ts';
import { buildAgent, runTurn } from './agent.ts';
import { ScriptedChatModel, type Policy } from './scripted-model.ts';
import { floraPolicy } from './scripts.ts';

/** 事件序列约束（04-测试与验收.md §3 的可执行版本） */
function checkSequence(evs: AgentStreamEvent[]) {
  const last = evs.at(-1)!;
  assert.ok(last.type === 'done' || last.type === 'error', '最后一个事件必须是 done 或 error');
  assert.equal(evs.filter((e) => e.type === 'done' || e.type === 'error').length, 1, 'done / error 恰好一次');
  let maxSeq = 0;
  let closed = false;
  for (const e of evs) {
    if (e.type === 'thought') {
      assert.ok(!closed, '思考区收起后不再出现 thought');
      assert.ok(e.seq >= maxSeq, 'thought.seq 单调不减');
      maxSeq = e.seq;
      if (e.final) closed = true;
    }
    if ((e.type === 'token' || e.type === 'card') && maxSeq > 0) assert.ok(closed, '首个 token/card 前必须先发 final thought');
  }
  const card = evs.find((e) => e.type === 'card');
  if (card && card.type === 'card') {
    const evIds = evs.filter((e) => e.type === 'evidence').map((e) => (e as { evidence: { id: string } }).evidence.id);
    for (const ref of card.payload.evidenceRefs) assert.ok(evIds.includes(ref.evidenceId), `卡片引用的证据 ${ref.evidenceId} 必须随后下发`);
  }
}

async function collect(gen: AsyncGenerator<AgentStreamEvent>) {
  const evs: AgentStreamEvent[] = [];
  for await (const e of gen) evs.push(AgentStreamEvent.parse(e));
  checkSequence(evs);
  return evs;
}

function show(title: string, evs: AgentStreamEvent[]) {
  console.log(`\n=== ${title}`);
  let tokens = '';
  for (const e of evs) {
    if (e.type === 'token') { tokens += e.text; continue; }
    if (tokens) { console.log(`  token × "${tokens}"`); tokens = ''; }
    if (e.type === 'thought') console.log(`  thought seq=${e.seq} final=${e.final} "${e.text}"`);
    else if (e.type === 'card') console.log(`  card "${e.payload.title}" items=${e.payload.items.map((i) => `${i.id}:${i.priceFen}`).join(',')} refs=${e.payload.evidenceRefs.map((r) => r.evidenceId).join(',')}`);
    else if (e.type === 'evidence') console.log(`  evidence ${e.evidence.id} 可信度 ${e.evidence.credibility}`);
    else console.log(`  ${e.type} ${JSON.stringify(e)}`);
  }
  if (tokens) console.log(`  token × "${tokens}"`);
}

const textOf = (evs: AgentStreamEvent[]) => evs.filter((e) => e.type === 'token').map((e) => (e as { text: string }).text).join('');

// 1) 三场景离线剧本（与旧 agent.py 文案一致）
const agent = buildAgent({ model: new ScriptedChatModel(floraPolicy) });
for (const [i, q] of ['这周想买点花放客厅', '想给妈妈送生日礼物', '下周去医院探望朋友'].entries()) {
  const evs = await collect(runTurn(agent, { message: q, threadId: `scene-${i}` }));
  show(q, evs);
}
const gift = await collect(runTurn(agent, { message: '送礼', threadId: 'e2e-gift' }));
assert.equal(gift.find((e) => e.type === 'card')?.type === 'card' && (gift.find((e) => e.type === 'card') as { payload: { title: string } }).payload.title, '送礼首选：轻奢礼盒');
assert.match(textOf(gift), /送礼场景我推荐礼盒款/);

// 2) 多轮：同一 thread 第二轮能看到上一轮；不同 thread 互不可见
const t2 = await collect(runTurn(agent, { message: '那换成探望朋友呢', threadId: 'scene-1' }));
show('第二轮（同 thread scene-1）', t2);
const state = await agent.getState({ configurable: { thread_id: 'scene-1' } });
const msgs = state.values.messages as BaseMessage[];
console.log(`  thread scene-1 共 ${msgs.length} 条消息，用户消息 ${msgs.filter((m) => HumanMessage.isInstance(m)).length} 条`);
assert.equal(msgs.filter((m) => HumanMessage.isInstance(m)).length, 2);
const other = await agent.getState({ configurable: { thread_id: 'scene-0' } });
assert.equal((other.values.messages as BaseMessage[]).filter((m) => HumanMessage.isInstance(m)).length, 1);

// 3) 证据因果：模型先"凭空"引用证据 → 工具报错回灌 → 自我修正
let tried = false;
const hallucinate: Policy = (messages) => {
  if (!tried) { tried = true; return { text: '我直接给你推荐吧。', toolCalls: [{ name: 'present_recommendation', args: { scene: 'gift', title: '送礼首选：轻奢礼盒', reason: '凭感觉', skuIds: ['fl-101'], evidenceIds: ['ev-fake'] } }] }; }
  return floraPolicy(messages);
};
const fixed = await collect(runTurn(buildAgent({ model: new ScriptedChatModel(hallucinate) }), { message: '想送礼', threadId: 'h' }));
show('幻觉证据 → 校验失败 → 自我修正', fixed);
assert.ok(fixed.some((e) => e.type === 'thought' && e.text.includes('校验未通过')));
assert.ok(!textOf(fixed).includes('我直接给你推荐吧'), '工具调用前的开场白进思考区，不进正文');

// 4) 死循环模型 → 工具超限 continue / 模型超限 error
const looping: Policy = () => ({ toolCalls: [{ name: 'search_evidence', args: {} }] });
const loop = await collect(runTurn(buildAgent({ model: new ScriptedChatModel(looping) }), { message: '随便', threadId: 'loop' }));
show('死循环模型 → 超限', loop);
assert.equal(loop.at(-1)?.type, 'error');
assert.match((loop.at(-1) as { message: string }).message, /步数超出上限/);
assert.equal(fixed.at(-1)?.type, 'done');

// 5) 上游 500
class Boom extends ScriptedChatModel {
  async *_streamResponseChunks(): AsyncGenerator<never> { throw Object.assign(new Error('upstream exploded sk-xxx'), { status: 500 }); }
}
const boom = await collect(runTurn(buildAgent({ model: new Boom(floraPolicy) }), { message: '送礼', threadId: 'boom' }));
show('上游 500', boom);
assert.deepEqual(boom.map((e) => e.type), ['error']);
assert.ok(!JSON.stringify(boom).includes('sk-xxx'), '上游原始报错不外泄');

// 6) 中止：第一个 thought 之后 abort
const ac = new AbortController();
const slow = buildAgent({ model: new ScriptedChatModel(floraPolicy, { delayMs: 30 }) });
const aborted: AgentStreamEvent[] = [];
for await (const e of runTurn(slow, { message: '送礼', threadId: 'abort' }, ac.signal)) { aborted.push(e); if (aborted.length === 1) ac.abort(); }
checkSequence(aborted);
show('中止', aborted);
assert.equal(aborted.at(-1)?.type === 'error' && (aborted.at(-1) as { code: string }).code, 'aborted');

console.log('\n全部断言通过 ✅');
