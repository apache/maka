import { createAgent, tool } from 'langchain';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, AIMessageChunk } from '@langchain/core/messages';
import { ChatGenerationChunk } from '@langchain/core/outputs';
class Slow extends BaseChatModel { mode: string; constructor(mode: string) { super({}); this.mode = mode; }
  _llmType() { return 's'; } bindTools() { return this as any; }
  async *_streamResponseChunks(_m: any, o: any) { if (this.mode === 'throw') throw Object.assign(new Error('上游 HTTP 500'), { status: 500 });
    for (let i = 0; i < 50; i++) { o.signal?.throwIfAborted(); await new Promise(r => setTimeout(r, 20)); yield new ChatGenerationChunk({ text: '字', message: new AIMessageChunk({ content: '字' }) }); } }
  async _generate(m: any, o: any) { let t = ''; for await (const c of this._streamResponseChunks(m, o)) t += c.text; return { generations: [{ text: t, message: new AIMessage(t) }] }; } }
for (const mode of ['abort', 'throw']) {
  const agent = createAgent({ model: new Slow(mode), tools: [] });
  const ac = new AbortController(); let n = 0; setTimeout(() => ac.abort(), 150);
  try { for await (const [m, c] of await agent.stream({ messages: [{ role: 'user', content: 'hi' }] }, { streamMode: ['messages'], signal: ac.signal } as any)) n++; console.log(mode, 'ended normally', n); }
  catch (e: any) { console.log(mode, 'chunks=', n, 'err.name=', e.name, 'msg=', e.message, 'status=', e.status); }
}
