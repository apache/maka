// 事件翻译层：createAgent 的 stream（messages + custom）→ 现有 AgentStreamEvent 协议。
// 前端 sse-decoder / chat store 一行不改；所有出站事件在这里过 zod（服务端契约守门）。
//
// 映射规则（详见 02-接口契约.md §2）：
//   reasoning_content 增量          → thought（当前段追加）
//   模型发起工具调用                 → thought 新段（"检索顾客画像…"等固定文案，不透传参数）
//   工具 ToolMessage(status=error)  → thought 新段（"校验未通过，重新检索…"）
//   custom 流 card / evidence        → 原样透传（工具里已 parse 过，这里再 parse 一次）
//   模型正文 content                 → token；但每次模型调用的前 PREAMBLE 个字先扣住：
//                                      若随后出现 tool_call_chunk，这段"开场白"改记为 thought
//   首个 card/token 之前             → thought{final:true} 收起思考区（与旧协议相同）
//   正常结束 → done{replyId}；异常 → error{code}，error 与 done 互斥且都只发一次
import { randomUUID } from 'node:crypto';
import { AIMessageChunk, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { ZodError } from 'zod';
import { AgentStreamEvent } from './contracts.ts';

export const PREAMBLE = 24;
const TOOL_THOUGHT: Record<string, string> = {
  search_evidence: '检索顾客画像与历史记录…',
  search_catalog: '查询在售花材与价格…',
  present_recommendation: '整理推荐方案…',
};

type Chunk = ['messages', [BaseMessage, { langgraph_node?: string }]] | ['custom', unknown] | [string, unknown];

export async function* translate(stream: AsyncIterable<Chunk>, signal?: AbortSignal): AsyncGenerator<AgentStreamEvent> {
  let seq = 0;               // 当前思考段序号（0 = 还没有思考段）
  let thoughtsClosed = false;
  let callId: string | undefined; // 当前模型调用（同一调用的增量共享 message.id）
  let held = '';             // 开场白缓冲
  let holding = true;        // 当前调用是否仍在扣留
  let sawToolCall = false;
  let reasoningOpen = false; // 当前调用的 reasoning 是否已开段

  const out = (e: unknown) => AgentStreamEvent.parse(e);
  const newThought = (text: string) => { seq += 1; return out({ type: 'thought', seq, text, final: false }); };
  function* closeThoughts() {
    if (thoughtsClosed) return;
    thoughtsClosed = true;
    if (seq > 0) yield out({ type: 'thought', seq, text: '', final: true });
  }
  function* flushHeldAsToken() {
    if (!held) return;
    yield* closeThoughts();
    yield out({ type: 'token', text: held });
    held = '';
  }
  function* thought(text: string) {
    // 思考区已收起（正文已开始）后又出现的工具调用：不再追加思考段，避免 UI 段落回跳
    if (!thoughtsClosed) yield newThought(text);
  }

  try {
    for await (const [mode, payload] of stream) {
      if (mode === 'custom') {
        const ev = out(payload);
        if (ev.type === 'card' || ev.type === 'evidence') { yield* flushHeldAsToken(); yield* closeThoughts(); yield ev; }
        continue;
      }
      if (mode !== 'messages') continue;
      const [msg, meta] = payload as [BaseMessage, { langgraph_node?: string }];

      if (ToolMessage.isInstance(msg)) {
        if (msg.status === 'error') yield* thought('校验未通过，重新检索后再推荐…');
        continue;
      }
      // 只认 agent 主模型节点；摘要中间件等内部模型调用的输出不进 UI
      if (meta?.langgraph_node !== 'model_request' || !AIMessageChunk.isInstance(msg)) continue;

      if (msg.id !== callId) {
        // 新的一次模型调用：上一次扣住但没等到工具调用的开场白 → 作为正文发出
        if (!sawToolCall) yield* flushHeldAsToken();
        held = ''; holding = true; sawToolCall = false; reasoningOpen = false; callId = msg.id;
      }

      const reasoning = msg.additional_kwargs?.reasoning_content;
      if (typeof reasoning === 'string' && reasoning) {
        // 每次模型调用的 reasoning 开一个新段，同一调用内的后续增量追加到该段
        if (!reasoningOpen) { reasoningOpen = true; yield* thought(reasoning); }
        else if (!thoughtsClosed) yield out({ type: 'thought', seq, text: reasoning, final: false });
      }

      if (msg.tool_call_chunks?.length) {
        if (!sawToolCall && held) { yield* thought(held); held = ''; }
        sawToolCall = true; holding = false;
        for (const c of msg.tool_call_chunks) if (c.name) yield* thought(TOOL_THOUGHT[c.name] ?? `调用工具 ${c.name}…`);
      }

      const text = typeof msg.content === 'string' ? msg.content : msg.content.map((b) => (b.type === 'text' ? (b as { text: string }).text : '')).join('');
      if (!text) continue;
      if (sawToolCall) continue; // 工具调用之后同一调用里的零碎文本不进正文
      if (holding) {
        held += text;
        if ([...held].length > PREAMBLE) { holding = false; yield* flushHeldAsToken(); }
        continue;
      }
      yield* closeThoughts();
      yield out({ type: 'token', text });
    }
    if (!sawToolCall) yield* flushHeldAsToken();
    yield* closeThoughts();
    yield out({ type: 'done', replyId: randomUUID().replaceAll('-', '').slice(0, 12) });
  } catch (err) {
    yield toError(err, signal);
  }
}

export function toError(err: unknown, signal?: AbortSignal): AgentStreamEvent {
  const e = err as { name?: string; status?: number; message?: string };
  if (signal?.aborted || e?.name === 'AbortError') return { type: 'error', code: 'aborted', message: '已停止生成' };
  if (err instanceof ZodError) return { type: 'error', code: 'protocol', message: '智能体输出不符合契约' };
  if (['ModelCallLimitMiddlewareError', 'ToolCallLimitExceededError', 'GraphRecursionError'].includes(e?.name ?? '')) return { type: 'error', code: 'server', message: '本轮推理步数超出上限，请换个说法再试' };
  // 不把上游原始报错（可能含 key / URL）透给前端；详情只进服务端日志
  console.error('[agent] run failed:', e?.status ?? '', e?.message ?? err);
  return { type: 'error', code: 'server', message: e?.status ? `模型服务暂不可用（${e.status}）` : '智能体运行出错' };
}
