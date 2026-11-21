// Agent 装配：唯一的 createAgent 调用点。mock / 真实模式只差 model 一个参数。
import { createAgent, modelCallLimitMiddleware, summarizationMiddleware, toolCallLimitMiddleware } from 'langchain';
import { MemorySaver } from '@langchain/langgraph';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { TOOLS } from './tools.ts';
import { translate } from './translate.ts';
import type { AgentStreamEvent } from './contracts.ts';

export const SYSTEM_PROMPT = `你是"花语"鲜花店的选购顾问。
工作方式：
1. 先调用 search_evidence 了解顾客画像，再调用 search_catalog 查询在售商品；
2. 用 present_recommendation 展示推荐卡片：商品只能用 search_catalog 返回的 skuId，依据只能用 search_evidence 返回的证据 id；
3. 卡片展示后，用一两句话说明理由，不要复述价格与商品清单。
不要编造价格、库存或顾客信息；工具报错时按提示修正后重试。`;

export function buildAgent(opts: { model: BaseChatModel; summaryModel?: BaseChatModel; checkpointer?: MemorySaver }) {
  return createAgent({
    model: opts.model,
    tools: TOOLS,
    systemPrompt: SYSTEM_PROMPT,
    checkpointer: opts.checkpointer ?? new MemorySaver(),
    middleware: [
      // 长对话压缩：用独立（便宜）模型，避免摘要调用混进主模型的流
      ...(opts.summaryModel ? [summarizationMiddleware({ model: opts.summaryModel, trigger: { tokens: 6000 }, keep: { messages: 12 } })] : []),
      // 工具调用超限：实测 langchain 1.5.18 下默认的 continue 在"本步全部被拦截"时会直接结束本轮、
      // 没有任何正文（用户看到空回答）；end 注入的是英文 AIMessage 且不在 model_request 节点。
      // 因此两类限额都用 error，由翻译层统一映射为 error{code:server} + 中文提示。
      toolCallLimitMiddleware({ runLimit: 6, exitBehavior: 'error' }),
      // 模型调用超限：硬停 → 翻译层映射为 error{code:server}
      modelCallLimitMiddleware({ runLimit: 8, exitBehavior: 'error' }),
    ],
  });
}

export type FloraAgent = ReturnType<typeof buildAgent>;

export async function* runTurn(agent: FloraAgent, input: { message: string; threadId: string }, signal?: AbortSignal): AsyncGenerator<AgentStreamEvent> {
  let stream;
  try {
    stream = await agent.stream(
      { messages: [{ role: 'user', content: input.message }] },
      // recursionLimit 按"图步数"计：每轮 模型+工具 循环在挂了中间件后约 5 步（before_model/model_request/after_model×2/tools），
      // 默认 25 只够 ~5 轮，会抢在 modelCallLimit 之前触发 → 显式放宽，让业务限额先生效
      { configurable: { thread_id: input.threadId }, streamMode: ['messages', 'custom'], signal, recursionLimit: 100 },
    );
  } catch (err) {
    const { toError } = await import('./translate.ts');
    yield toError(err, signal);
    return;
  }
  yield* translate(stream as never, signal);
}
