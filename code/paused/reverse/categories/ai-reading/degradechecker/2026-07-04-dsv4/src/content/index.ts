// ========================================
// ChatGPT Degrade Checker — 内容脚本类型
// 来源：content.js
// 职责：模型统计面板UI、PoW风险显示、聊天导出触发
// ========================================

import type { ModelStats, PoWState, PlanType, PageMessage, RiskInfo } from '../types';
import { RISK_MESSAGES } from '../types';

/**
 * 根据 PoW 难度值计算风险级别
 * 难度值越低（前导零越多）→ 风险越高
 */
export function getRiskColorAndLevel(difficulty: string): RiskInfo {
  if (!difficulty || difficulty === 'unknown') {
    return {
      color: '#e63946',
      ipRiskLevel: RISK_MESSAGES.unknown,
      riskTip: RISK_MESSAGES.unknownTip,
    };
  }

  const clean = difficulty.startsWith('0x') ? difficulty.slice(2) : difficulty;
  const trimmed = clean.replace(/^0+/, '');
  const riskLevel = trimmed.length;

  switch (riskLevel) {
    case 0:
    case 1:
    case 2:
      return {
        color: '#e63946',
        ipRiskLevel: RISK_MESSAGES.highRisk,
        riskTip: RISK_MESSAGES.highRiskTip,
      };
    case 3:
      return {
        color: '#FAB12F',
        ipRiskLevel: RISK_MESSAGES.mediumRisk,
        riskTip: RISK_MESSAGES.mediumRiskTip,
      };
    case 4:
      return {
        color: '#859F3D',
        ipRiskLevel: RISK_MESSAGES.lowRisk,
        riskTip: RISK_MESSAGES.lowRiskTip,
      };
    default:
      return {
        color: '#2a9d8f',
        ipRiskLevel: RISK_MESSAGES.normal,
        riskTip: RISK_MESSAGES.normalTip,
      };
  }
}

/**
 * 格式化相对时间
 */
export function formatTimeAgo(dateString: string): string {
  if (!dateString) return '从未使用';
  const diff = Math.floor((Date.now() - new Date(dateString).getTime()) / 1000);
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)}分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}小时前`;
  return `${Math.floor(diff / 86400)}天前`;
}

/**
 * 计算下次重置倒计时
 */
export function calculateNextReset(model: string, modelStats: Record<string, ModelStats>, lastResetTime: Record<string, string>): string {
  const stats = modelStats[model];
  if (!stats?.active || !lastResetTime[model] || !stats.resetHours) return '未使用';

  const lastReset = new Date(lastResetTime[model]);
  const nextReset = new Date(lastReset.getTime() + stats.resetHours * 3600000);
  const diff = Math.floor((nextReset.getTime() - Date.now()) / 1000);

  if (diff < 0) return '即将重置';
  if (diff < 60) return '不到1分钟';
  if (diff < 3600) return `${Math.floor(diff / 60)}分钟`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}小时`;
  return `${Math.floor(diff / 86400)}天`;
}
