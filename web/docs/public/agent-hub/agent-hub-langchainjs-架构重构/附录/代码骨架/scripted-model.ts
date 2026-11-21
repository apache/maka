// 离线模式的"策略模型"：按会话状态决定下一步（不是按调用次数出队），
// 因此多轮对话、工具报错重试、刷新重放都能确定性复现，且走的是与真实模型完全相同的
// createAgent → 工具 → 中间件 → 翻译层链路（mock 与真实模式只差这一个类）。
// 注意两点（技术验证得出）：
// 1. 必须在 _streamResponseChunks 里对每个 chunk 调用 runManager.handleLLMNewToken(text, …, { chunk })，
//    否则 messages 流拿不到增量；且要传 chunk 本身，reasoning / tool_call_chunks 才会随增量出现
//    （langgraph StreamMessagesHandler：某次调用一旦发过增量，结束时就不再补发整条消息）；
// 2. Node 24 strip-only 不支持参数属性（constructor(public x)），字段要显式声明。
import { BaseChatModel, type BaseChatModelParams } from '@langchain/core/language_models/chat_models';
import { AIMessage, AIMessageChunk, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { ChatGenerationChunk, type ChatResult } from '@langchain/core/outputs';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';

export type Step = { text?: string; reasoning?: string; toolCalls?: { name: string; args: Record<string, unknown> }[] };
export type Policy = (messages: BaseMessage[]) => Step;

export class ScriptedChatModel extends BaseChatModel {
  policy: Policy;
  delayMs: number;
  constructor(policy: Policy, opts: BaseChatModelParams & { delayMs?: number } = {}) {
    super(opts);
    this.policy = policy;
    this.delayMs = opts.delayMs ?? 0;
  }
  _llmType() { return 'scripted'; }
  // createAgent 会调用 bindTools；策略模型自己知道工具名，直接返回自身
  bindTools() { return this as never; }

  async *_streamResponseChunks(messages: BaseMessage[], options: this['ParsedCallOptions'], runManager?: CallbackManagerForLLMRun) {
    const step = this.policy(messages);
    let callIndex = 0;
    const emit = async (chunk: ChatGenerationChunk) => {
      options.signal?.throwIfAborted();
      if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
      await runManager?.handleLLMNewToken(chunk.text, undefined, undefined, undefined, undefined, { chunk });
      return chunk;
    };
    // 与 deepseek / ChatOpenAI 一致：思考内容走 additional_kwargs.reasoning_content
    for (const piece of step.reasoning?.match(/.{1,12}/gsu) ?? []) {
      yield await emit(new ChatGenerationChunk({ text: '', message: new AIMessageChunk({ content: '', additional_kwargs: { reasoning_content: piece } }) }));
    }
    for (const piece of step.text?.match(/.{1,6}/gsu) ?? []) {
      yield await emit(new ChatGenerationChunk({ text: piece, message: new AIMessageChunk({ content: piece }) }));
    }
    if (step.toolCalls?.length) {
      yield await emit(new ChatGenerationChunk({
        text: '',
        message: new AIMessageChunk({
          content: '',
          tool_call_chunks: step.toolCalls.map((c) => ({ type: 'tool_call_chunk' as const, name: c.name, args: JSON.stringify(c.args), id: `call_${messages.length}_${callIndex}`, index: callIndex++ })),
        }),
      }));
    }
  }

  async _generate(messages: BaseMessage[], options: this['ParsedCallOptions'], runManager?: CallbackManagerForLLMRun): Promise<ChatResult> {
    let acc: ChatGenerationChunk | undefined;
    for await (const c of this._streamResponseChunks(messages, options, runManager)) acc = acc ? acc.concat(c) : c;
    const m = acc?.message as AIMessageChunk | undefined;
    return { generations: [{ text: acc?.text ?? '', message: new AIMessage({ content: m?.content ?? '', tool_calls: m?.tool_calls, additional_kwargs: m?.additional_kwargs }) }] };
  }
}

/** 本轮已拿到结果的工具名（最后一条用户消息之后、status 不是 error 的） */
export function toolsDoneThisTurn(messages: BaseMessage[]): string[] {
  const start = messages.findLastIndex((m) => HumanMessage.isInstance(m));
  return messages.slice(start + 1).filter((m) => ToolMessage.isInstance(m) && m.status !== 'error').map((m) => (m as ToolMessage).name ?? '');
}
