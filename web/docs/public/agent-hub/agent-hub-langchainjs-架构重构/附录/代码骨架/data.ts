// 演示数据：证据库从 apps/api/app/evidence.py 原样迁移；商品目录取自原剧本里出现过的 6 个 SKU。
// 价格、名称、类型只以这里为准——模型只能引用 skuId，不能自己报价（防"幻觉价格"进入下单链路）。
import type { Evidence, FlowerItem } from './contracts.ts';

export const EVIDENCE: Record<string, Evidence> = {
  'ev-purchase-01': { id: 'ev-purchase-01', source: '近 90 天订单记录', sourceKind: 'purchase_history', credibility: 88, quote: '顾客近 90 天购买 3 次鲜切花，均为玫瑰类，单价偏好 50-80 元档。', analyzedAt: '2026-09-10 20:15' },
  'ev-survey-02': { id: 'ev-survey-02', source: '入会喜好问卷', sourceKind: 'preference_survey', credibility: 72, quote: "问卷勾选'喜欢低香味、浅色系'，但对'香槟色'未表态（样本较旧，可信度降级）。", analyzedAt: '2026-08-02 11:30' },
  'ev-care-03': { id: 'ev-care-03', source: '养护回访记录', sourceKind: 'care_record', credibility: 91, quote: "上次回访顾客反馈'尤加利叶养不活'，本次推荐应避免需高频打理的配叶。", analyzedAt: '2026-09-12 09:05' },
};

export type Scene = 'daily' | 'gift' | 'comfort';
export const CATALOG: (FlowerItem & { scenes: Scene[] })[] = [
  { id: 'fl-001', name: '香槟色玫瑰 9 支', priceFen: 6900, typeLabel: '花束', emoji: '🌹', scenes: ['daily'] },
  { id: 'fl-002', name: '洋桔梗小盆栽', priceFen: 3500, typeLabel: '盆栽', emoji: '🪴', scenes: ['daily'] },
  { id: 'fl-101', name: '香槟乌梅礼盒', priceFen: 12800, typeLabel: '花盒', emoji: '🎁', scenes: ['gift'] },
  { id: 'fl-102', name: '永生花圆舞曲', priceFen: 19800, typeLabel: '永生花', emoji: '✨', scenes: ['gift'] },
  { id: 'fl-201', name: '白绿桔梗花束', priceFen: 8800, typeLabel: '花束', emoji: '🤍', scenes: ['comfort'] },
  { id: 'fl-202', name: '小雏菊盆栽', priceFen: 4200, typeLabel: '盆栽', emoji: '🌼', scenes: ['comfort'] },
];
