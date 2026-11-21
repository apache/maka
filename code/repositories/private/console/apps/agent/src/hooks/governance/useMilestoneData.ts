/**
 * Milestone 数据 Hook
 * 按 priority 或自定义规则聚合 PRD 数据
 */
import { useMemo } from 'react'
import { usePRDData } from './usePRDData'
import type { Milestone, MilestoneGroupBy, MilestoneStatistics } from '@ggbdpq/console-shared'
import type { PRDItem } from '@ggbdpq/console-shared'

export interface UseMilestoneDataResult {
  /** Milestone 列表 */
  data: readonly Milestone[]
  /** 是否加载中 */
  loading: boolean
  /** 错误信息 */
  error: string | null
  /** 重新加载 */
  reload: () => void
}

/**
 * 计算 Milestone 统计信息
 */
function calculateStatistics(items: readonly PRDItem[]): MilestoneStatistics {
  const total = items.length
  const completed = items.filter((item) => item.passes).length
  const percentage = total > 0 ? Math.round((completed / total) * 100) : 0

  return {
    total,
    completed,
    completion: `${percentage}%`,
  }
}

/**
 * 按优先级分组 PRD
 */
function groupByPriority(items: readonly PRDItem[]): readonly Milestone[] {
  const priorityGroups = new Map<string, PRDItem[]>()

  // 初始化优先级组
  priorityGroups.set('P0', [])
  priorityGroups.set('P1', [])
  priorityGroups.set('P2', [])

  // 分组
  for (const item of items) {
    const priority = item.priority
    const existing = priorityGroups.get(priority) ?? []
    existing.push(item)
    priorityGroups.set(priority, existing)
  }

  // 转换为 Milestone
  const milestones: Milestone[] = []
  const priorityOrder = ['P0', 'P1', 'P2']

  for (const priority of priorityOrder) {
    const prdItems = priorityGroups.get(priority) ?? []
    if (prdItems.length > 0) {
      milestones.push({
        name: `${priority} 任务`,
        groupBy: 'priority',
        prdItems,
        statistics: calculateStatistics(prdItems),
      })
    }
  }

  return milestones
}

/**
 * 按组件分组 PRD
 */
function groupByComponent(items: readonly PRDItem[]): readonly Milestone[] {
  const componentGroups = new Map<string, PRDItem[]>()

  // 分组
  for (const item of items) {
    // 提取组件类别（简化处理：取组件名前缀）
    let category = '其他'
    if (item.component.startsWith('UI')) {
      category = 'UI 组件'
    } else if (item.component.includes('Service')) {
      category = '服务层'
    } else if (item.component.includes('Parser')) {
      category = '解析器'
    } else if (item.component.includes('Types') || item.component.includes('Fixtures')) {
      category = '基础设施'
    }

    const existing = componentGroups.get(category) ?? []
    existing.push(item)
    componentGroups.set(category, existing)
  }

  // 转换为 Milestone
  const milestones: Milestone[] = []
  const categoryOrder = ['基础设施', '解析器', '服务层', 'UI 组件', '其他']

  for (const category of categoryOrder) {
    const prdItems = componentGroups.get(category) ?? []
    if (prdItems.length > 0) {
      milestones.push({
        name: category,
        groupBy: 'component',
        prdItems,
        statistics: calculateStatistics(prdItems),
      })
    }
  }

  return milestones
}

/**
 * 获取 Milestone 数据的 Hook
 */
export function useMilestoneData(groupBy: MilestoneGroupBy = 'priority'): UseMilestoneDataResult {
  const { data: prdData, loading, error, reload } = usePRDData()

  // 按分组规则聚合
  const milestones = useMemo<readonly Milestone[]>(() => {
    if (!prdData?.items) return []

    switch (groupBy) {
      case 'priority':
        return groupByPriority(prdData.items)
      case 'component':
        return groupByComponent(prdData.items)
      default:
        return groupByPriority(prdData.items)
    }
  }, [prdData, groupBy])

  return {
    data: milestones,
    loading,
    error,
    reload,
  }
}
