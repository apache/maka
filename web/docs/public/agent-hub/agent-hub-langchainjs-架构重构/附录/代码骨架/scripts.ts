// 三个场景的离线剧本：文案与旧 agent.py 逐字一致，保证现有 3 条 E2E 不改即绿。
import { HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { toolsDoneThisTurn, type Policy } from './scripted-model.ts';
import type { Scene } from './data.ts';

export function detectScene(text: string): Scene {
  if (/[送礼]|生日|表白|纪念/.test(text)) return 'gift';
  if (/探望|慰问|看病|安慰/.test(text)) return 'comfort';
  return 'daily';
}

const PLAN = {
  daily: { evidence: ['ev-purchase-01', 'ev-care-03'], skus: ['fl-001', 'fl-002'], title: '本周自用鲜花组合', reason: '结合你的购买节奏与养护习惯，选了低打理、花期长的组合。', answer: '根据你的订单记录，玫瑰类是最稳的选择；上次反馈尤加利难养护，这次换成好打理的洋桔梗盆栽，花期更长。' },
  gift: { evidence: ['ev-survey-02'], skus: ['fl-101', 'fl-102'], title: '送礼首选：轻奢礼盒', reason: '送礼场景优先包装质感与寓意，避开你问卷里不喜欢的浓香型。', answer: '送礼场景我推荐礼盒款：香槟色系符合你浅色系的偏好，永生花款适合希望纪念意义更久的场合。' },
  comfort: { evidence: ['ev-care-03'], skus: ['fl-201', 'fl-202'], title: '探望慰问：素雅安神', reason: '探望场景避免浓香与艳色，以素雅、好养护为主。', answer: '探望慰问以素雅为宜：白绿桔梗无浓香，小雏菊好打理，收花人不需要费心照顾。' },
} as const;

export const floraPolicy: Policy = (messages: BaseMessage[]) => {
  const user = String(messages.findLast((m) => HumanMessage.isInstance(m))?.content ?? '');
  const scene = detectScene(user);
  const plan = PLAN[scene];
  const done = toolsDoneThisTurn(messages);
  if (!done.includes('search_evidence')) return { reasoning: `解析请求：这是${{ daily: '日常自用', gift: '送礼', comfort: '探望慰问' }[scene]}场景。`, toolCalls: [{ name: 'search_evidence', args: {} }] };
  if (!done.includes('search_catalog')) return { toolCalls: [{ name: 'search_catalog', args: { scene } }] };
  if (!done.includes('present_recommendation')) return { toolCalls: [{ name: 'present_recommendation', args: { scene, title: plan.title, reason: plan.reason, skuIds: [...plan.skus], evidenceIds: [...plan.evidence] } }] };
  return { text: plan.answer };
};
