import type { ProblemStatus } from '@/features/algo/types/problem';

/** 做题状态到中文标签的映射。 */
export const PROBLEM_STATUS_LABELS: Record<ProblemStatus, string> = {
  'not-started': '未开始',
  attempted: '已尝试',
  solved: '已通过',
};

/** 状态到状态点配色 class 的映射。 */
export const PROBLEM_STATUS_DOT_CLASSES: Record<ProblemStatus, string> = {
  'not-started': 'bg-muted-foreground/40',
  attempted: 'bg-warning',
  solved: 'bg-success',
};

/** 状态到卡片左侧强调色条 class 的映射(视觉层次:已通过=翡翠绿,已尝试=琥珀)。 */
export const PROBLEM_STATUS_BAR_CLASSES: Record<ProblemStatus, string> = {
  'not-started': 'bg-border',
  attempted: 'bg-warning/70',
  solved: 'bg-success/80',
};

/**
 * 状态机:solved 是终态,attempted 不能覆盖 solved。
 *
 * @param current - 当前状态。
 * @param passed - 本次判题是否全部通过。
 * @returns 迁移后的状态。
 */
export function nextStatus(current: ProblemStatus, passed: boolean): ProblemStatus {
  if (current === 'solved') return 'solved';
  return passed ? 'solved' : 'attempted';
}
