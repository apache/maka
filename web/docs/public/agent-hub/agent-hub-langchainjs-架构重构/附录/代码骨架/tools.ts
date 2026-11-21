// 三个工具：检索证据、查询在售商品、展示推荐卡片（A2UI 即工具）。
// 证据因果：present_recommendation 只接受"本轮 search_evidence 真的返回过"的证据 id，
// 只接受"本轮 search_catalog 真的返回过"的 skuId；不满足就抛错 → ToolNode 回灌错误 → 模型自我修正。
import { tool } from 'langchain';
import { HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import * as z from 'zod';
import { CardEvent, EvidenceEvent, FlowerCardPayload } from './contracts.ts';
import { CATALOG, EVIDENCE, type Scene } from './data.ts';

/** 本轮（最后一条用户消息之后）某个工具返回的 artifact 里出现过的 id 集合 */
function idsSeenThisTurn(messages: BaseMessage[], toolName: string): Set<string> {
  const start = messages.findLastIndex((m) => HumanMessage.isInstance(m));
  const ids = new Set<string>();
  for (const m of messages.slice(start + 1)) {
    if (ToolMessage.isInstance(m) && m.name === toolName && m.status !== 'error') {
      for (const item of (m.artifact as { id: string }[] | undefined) ?? []) ids.add(item.id);
    }
  }
  return ids;
}

export const searchEvidence = tool(
  async ({ kinds }) => {
    const hits = Object.values(EVIDENCE).filter((e) => !kinds?.length || kinds.includes(e.sourceKind));
    // content 给模型看（带 id 才能引用）；artifact 给服务端校验与 UI 用，不进模型上下文
    const content = hits.map((e) => `[${e.id}] ${e.source}（可信度 ${e.credibility}）：${e.quote}`).join('\n') || '没有相关证据';
    return [content, hits];
  },
  {
    name: 'search_evidence',
    description: '检索当前顾客的画像证据（订单记录、喜好问卷、养护回访）。推荐前必须先调用，推荐卡片只能引用这里返回的证据 id。',
    schema: z.object({ kinds: z.array(z.enum(['purchase_history', 'preference_survey', 'care_record'])).optional() }),
    responseFormat: 'content_and_artifact',
  },
);

export const searchCatalog = tool(
  async ({ scene, maxPriceFen }) => {
    const hits = CATALOG.filter((s) => (!scene || s.scenes.includes(scene as Scene)) && (!maxPriceFen || s.priceFen <= maxPriceFen))
      .map(({ scenes: _s, ...item }) => item);
    const content = hits.map((s) => `[${s.id}] ${s.name} ${s.typeLabel} ¥${(s.priceFen / 100).toFixed(0)}`).join('\n') || '没有符合条件的在售商品';
    return [content, hits];
  },
  {
    name: 'search_catalog',
    description: '查询在售花材商品。推荐卡片里的商品只能从这里返回的 skuId 中选择。',
    schema: z.object({ scene: z.enum(['daily', 'gift', 'comfort']).optional(), maxPriceFen: z.number().int().positive().optional() }),
    responseFormat: 'content_and_artifact',
  },
);

export const presentRecommendation = tool(
  async (input, runtime) => {
    const messages = (runtime.state as { messages: BaseMessage[] }).messages;
    const evidenceSeen = idsSeenThisTurn(messages, 'search_evidence');
    const skuSeen = idsSeenThisTurn(messages, 'search_catalog');
    const badEvidence = input.evidenceIds.filter((id) => !evidenceSeen.has(id));
    const badSku = input.skuIds.filter((id) => !skuSeen.has(id));
    if (badEvidence.length || badSku.length) {
      // 抛错 = ToolMessage(status:error) 回灌给模型，让它先检索再推荐
      throw new Error(
        [badEvidence.length && `证据 ${badEvidence.join('、')} 不在本轮检索结果中，请先调用 search_evidence`,
         badSku.length && `商品 ${badSku.join('、')} 不在本轮查询结果中，请先调用 search_catalog`].filter(Boolean).join('；'),
      );
    }
    const payload = FlowerCardPayload.parse({
      scene: input.scene,
      title: input.title,
      reason: input.reason,
      items: input.skuIds.map((id) => { const { scenes: _s, ...item } = CATALOG.find((s) => s.id === id)!; return item; }),
      evidenceRefs: input.evidenceIds.map((id) => ({ evidenceId: id, label: EVIDENCE[id].source })),
    });
    // custom 流：卡片与它引用的证据按 card → evidence[] 顺序直达翻译层（与旧协议顺序一致）
    runtime.writer?.(CardEvent.parse({ type: 'card', payload }));
    for (const ref of payload.evidenceRefs) runtime.writer?.(EvidenceEvent.parse({ type: 'evidence', evidence: EVIDENCE[ref.evidenceId] }));
    return `推荐卡片已展示（${payload.items.map((i) => i.name).join('、')}）。接下来用一两句话说明推荐理由，不要重复卡片内容。`;
  },
  {
    name: 'present_recommendation',
    description: '把推荐以卡片形式展示给顾客。每次回答最多调用一次。',
    schema: z.object({
      scene: z.enum(['daily', 'gift', 'comfort']),
      title: z.string().min(1).max(30),
      reason: z.string().min(1).max(80),
      skuIds: z.array(z.string()).min(1).max(3),
      evidenceIds: z.array(z.string()).min(1),
    }),
  },
);

export const TOOLS = [searchEvidence, searchCatalog, presentRecommendation];
