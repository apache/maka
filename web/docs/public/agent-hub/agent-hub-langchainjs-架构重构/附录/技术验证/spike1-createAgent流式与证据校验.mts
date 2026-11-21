import { createAgent, tool, toolCallLimitMiddleware, modelCallLimitMiddleware } from 'langchain';
import { MemorySaver } from '@langchain/langgraph';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, AIMessageChunk, ToolMessage, HumanMessage } from '@langchain/core/messages';
import { ChatGenerationChunk } from '@langchain/core/outputs';
import * as z from 'zod';

type Step = { text?: string; toolCalls?: { name: string; args: any }[] };
class ScriptedChatModel extends BaseChatModel {
  i = 0; steps: Step[]; constructor(steps: Step[]) { super({}); this.steps = steps; }
  _llmType() { return 'scripted'; }
  bindTools(_t: any) { return this as any; }
  async *_streamResponseChunks(_m: any, _o: any, rm?: any) {
    const s = this.steps[this.i++] ?? { text: '（剧本结束）' };
    for (const piece of (s.text ?? '').match(/.{1,6}/gs) ?? []) {
      yield new ChatGenerationChunk({ text: piece, message: new AIMessageChunk({ content: piece }) });
      await rm?.handleLLMNewToken(piece);
    }
    if (s.toolCalls?.length) yield new ChatGenerationChunk({ text: '', message: new AIMessageChunk({ content: '', tool_call_chunks: s.toolCalls.map((c, index) => ({ type: 'tool_call_chunk', name: c.name, args: JSON.stringify(c.args), id: `call_${this.i}_${index}`, index })) }) });
  }
  async _generate(m: any, o: any, rm?: any) {
    let acc: any; for await (const c of this._streamResponseChunks(m, o, rm)) acc = acc ? acc.concat(c) : c;
    return { generations: [{ text: acc.text, message: new AIMessage({ content: acc.message.content, tool_calls: acc.message.tool_calls }) }] };
  }
}
const EVIDENCE = { 'ev-survey-02': { id: 'ev-survey-02', source: '入会喜好问卷', quote: '喜欢低香味、浅色系' } };
const searchEvidence = tool(async ({ query }) => {
  const hits = Object.values(EVIDENCE);
  return [hits.map(e => `[${e.id}] ${e.source}：${e.quote}`).join('\n'), hits];
}, { name: 'search_evidence', description: '检索顾客画像证据', schema: z.object({ query: z.string() }), responseFormat: 'content_and_artifact' });
const present = tool(async ({ title, evidenceIds }, runtime: any) => {
  const msgs = runtime.state.messages as any[];
  const lastHuman = msgs.findLastIndex((m) => HumanMessage.isInstance(m));
  const retrieved = new Set(msgs.slice(lastHuman).filter((m) => ToolMessage.isInstance(m) && m.name === 'search_evidence').flatMap((m) => (m.artifact ?? []).map((e: any) => e.id)));
  const bad = evidenceIds.filter((id: string) => !retrieved.has(id));
  if (bad.length) throw new Error(`引用了本轮未检索到的证据：${bad.join(',')}`);
  runtime.writer?.({ type: 'card', payload: { title, evidenceIds } });
  return '卡片已展示给顾客';
}, { name: 'present_recommendation', description: '展示推荐卡片', schema: z.object({ title: z.string(), evidenceIds: z.array(z.string()) }) });

const model = new ScriptedChatModel([
  { toolCalls: [{ name: 'present_recommendation', args: { title: '假引用', evidenceIds: ['ev-fake'] } }] },
  { text: '先查一下画像。', toolCalls: [{ name: 'search_evidence', args: { query: '送礼偏好' } }] },
  { toolCalls: [{ name: 'present_recommendation', args: { title: '送礼首选：轻奢礼盒', evidenceIds: ['ev-survey-02'] } }] },
  { text: '送礼场景我推荐礼盒款。' },
  { text: '第二轮：换成便宜款。' },
]);
const agent = createAgent({ model, tools: [searchEvidence, present], checkpointer: new MemorySaver(), middleware: [toolCallLimitMiddleware({ runLimit: 8, exitBehavior: 'end' }), modelCallLimitMiddleware({ runLimit: 6 })] });
const cfg = { configurable: { thread_id: 't1' }, streamMode: ['messages', 'updates', 'custom'] as const };
for (const q of ['想给妈妈送生日礼物', '换个便宜点的']) {
  console.log('=== 用户:', q);
  for await (const [mode, chunk] of await agent.stream({ messages: [{ role: 'user', content: q }] }, cfg as any)) {
    if (mode === 'messages') { const [msg, meta] = chunk as any; console.log('messages', msg.constructor.name, JSON.stringify(msg.content).slice(0, 40), msg.tool_call_chunks?.length ? 'tcc:' + msg.tool_call_chunks.map((t: any) => t.name).join() : '', 'node=' + meta.langgraph_node, msg.status ?? ''); }
    else if (mode === 'updates') console.log('updates', Object.keys(chunk as any).join(), JSON.stringify(chunk).slice(0, 160));
    else console.log('custom', JSON.stringify(chunk));
  }
}
const st = await agent.getState({ configurable: { thread_id: 't1' } } as any);
console.log('thread messages:', st.values.messages.length, st.values.messages.map((m: any) => m.getType()).join(','));
