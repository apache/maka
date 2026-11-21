// ========================================
// ChatGPT Degrade Checker — 核心类型定义
// 来源：content.js, js/fetch_script.js, js/gpt-export.js
// ========================================

/** 模型配置 */
export interface ModelConfig {
  /** 使用限额（"无限" 或具体数字） */
  limit: number | '无限' | '未知';
  /** 重置周期描述 */
  period: string;
  /** 重置小时数 */
  resetHours: number;
}

/** 模型运行统计 */
export interface ModelStats {
  /** 已使用次数 */
  count: number;
  /** 限额 */
  limit: number | '无限' | '未知';
  /** 周期 */
  period: string;
  /** 重置小时 */
  resetHours: number;
  /** 是否已被激活（使用过） */
  active: boolean;
}

/** PoW 风险信息 */
export interface RiskInfo {
  /** 风险级别颜色 */
  color: string;
  /** 风险等级文本 */
  ipRiskLevel: string;
  /** 风险提示 */
  riskTip: string;
}

/** PoW 状态 */
export interface PoWState {
  /** 难度值（十六进制字符串） */
  difficulty: string;
  /** persona 信息 */
  persona: string | null;
  /** 风险信息 */
  riskInfo: RiskInfo;
}

/** 账号类型 */
export type PlanType =
  | 'free'
  | 'plus'
  | 'pro'
  | 'team'
  | 'enterprise'
  | 'unknown'
  | 'chatgpt-paid'
  | 'chatgpt-freeaccount';

/** 面板状态 */
export interface PanelState {
  expanded: boolean;
  collapsed: boolean;
}

/** 默认模型配置（Pro 账号） */
export const DEFAULT_MODEL_CONFIGS: Record<string, ModelConfig> = {
  'gpt-4o': { limit: 80, period: '3小时', resetHours: 3 },
  'gpt-4o-mini': { limit: '无限', period: '', resetHours: 720 },
  'gpt-4-1-mini': { limit: '无限', period: '', resetHours: 720 },
  'gpt-4': { limit: 40, period: '3小时', resetHours: 3 },
  'gpt-4-1': { limit: 80, period: '3小时', resetHours: 3 },
  'gpt-4-5': { limit: 50, period: '周', resetHours: 168 },
  o3: { limit: 100, period: '周', resetHours: 168 },
  'o3-pro': { limit: 50, period: '周', resetHours: 168 },
  'o1-pro': { limit: 50, period: '周', resetHours: 168 },
  'o4-mini': { limit: 300, period: '天', resetHours: 24 },
  'o4-mini-high': { limit: 100, period: '天', resetHours: 24 },
  'deep-research': { limit: 10, period: '月', resetHours: 720 },
  'gpt-5': { limit: 160, period: '3小时', resetHours: 3 },
  'gpt-5-instant': { limit: 160, period: '3小时', resetHours: 3 },
  'gpt-5-thinking': { limit: 3000, period: '周', resetHours: 168 },
  'gpt-5-1': { limit: 160, period: '3小时', resetHours: 3 },
  'gpt-5-1-instant': { limit: 160, period: '3小时', resetHours: 3 },
  'gpt-5-1-thinking': { limit: 3000, period: '周', resetHours: 168 },
  'gpt-5-2': { limit: 160, period: '3小时', resetHours: 3 },
  'gpt-5-2-instant': { limit: 160, period: '3小时', resetHours: 3 },
  'gpt-5-2-thinking': { limit: 3000, period: '周', resetHours: 168 },
};

/** 风险消息映射 */
export const RISK_MESSAGES: Record<string, string> = {
  unknown: '未知',
  unknownTip: '未获取到风险等级信息',
  highRisk: '高风险',
  highRiskTip: '已被严重降级，建议更换IP或使用其他方式访问',
  mediumRisk: '中风险',
  mediumRiskTip: '中等风险，可能会遇到一些访问限制（可联系作者）',
  lowRisk: '低风险',
  lowRiskTip: '低风险，小概率被降智（可联系作者）',
  normal: '正常',
  normalTip: '正常状态，无需担心',
};

/** 账号类型中文映射 */
export const PLAN_TYPE_NAMES: Record<PlanType, string> = {
  free: '免费版',
  plus: 'Plus',
  pro: 'Pro',
  team: 'Team',
  enterprise: '企业版',
  unknown: '',
  'chatgpt-paid': '付费版',
  'chatgpt-freeaccount': '免费版',
};

/** 页面上下文消息 */
export interface PageMessage {
  type: 'modelStatsUpdate' | 'powChange' | 'userPlanTypeUpdate';
  modelStats?: Record<string, ModelStats>;
  lastRequestTime?: Record<string, string>;
  lastResetTime?: Record<string, string>;
  lastUsedModel?: string;
  difficulty?: string;
  persona?: string | null;
  planType?: PlanType;
}
