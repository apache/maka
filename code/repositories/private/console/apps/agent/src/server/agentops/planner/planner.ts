/**
 * Planner - 生成配置变更计划
 *
 * 强覆盖策略（authoritative override）：
 * 1. 主配置声明的 key -> set（设置为主配置的值）
 * 2. managedScopes 内但主配置未声明 -> delete（删除现有值）
 * 3. 非 managedScopes -> 不处理（保留用户自定义配置）
 */

import type {
  Target,
  TargetType,
  PatchStep,
  Plan,
  PlanSummary,
  ProfileConfig,
} from '@ggbdpq/console-shared'

import { flatten, type FlatObject } from './json-path'
import { isInManagedScope } from './managed-scopes'

// ============================================================================
// Types
// ============================================================================

export interface PlanInput {
  /** Profile 配置 */
  profile: ProfileConfig
  /** 目标类型 */
  targetType: TargetType
  /** 当前配置内容 */
  currentSettings: Record<string, unknown>
  /** 配置文件路径 */
  configPath: string
}

// ============================================================================
// High Risk Detection
// ============================================================================

/**
 * 高风险路径模式
 * 删除这些路径的配置可能导致严重问题
 */
const HIGH_RISK_PATTERNS = [
  /^editor\.defaultFormatter$/,
  /^files\.exclude/,
  /^files\.associations/,
  /^workbench\.colorTheme$/,
  /^terminal\.integrated\.shell/,
  /^remote\./,
  /^extensions\./,
]

/**
 * 检查路径是否为高风险操作
 */
function isHighRiskPath(path: string): boolean {
  return HIGH_RISK_PATTERNS.some((pattern) => pattern.test(path))
}

// ============================================================================
// Planner Implementation
// ============================================================================

/**
 * 生成单个目标的 PatchStep 列表
 */
export function generateSteps(input: PlanInput): PatchStep[] {
  const { profile, targetType, currentSettings, configPath } = input
  const { managedScopes, settings: profileSettings } = profile

  // 扁平化配置
  const currentFlat = flatten(currentSettings)
  const profileFlat = profileSettings as FlatObject

  const steps: PatchStep[] = []
  const processedPaths = new Set<string>()

  const target: Target = {
    type: targetType,
    fileType: 'settings',
    path: configPath,
  }

  // 1. 处理主配置声明的 key -> set
  for (const [path, newValue] of Object.entries(profileFlat)) {
    processedPaths.add(path)

    const oldValue = currentFlat[path]
    const hasChanged = !deepEqual(oldValue, newValue)

    if (hasChanged) {
      steps.push({
        target,
        op: 'set',
        path,
        value: newValue,
        oldValue,
        highRisk: isHighRiskPath(path),
      })
    }
  }

  // 2. 处理 managedScopes 内但主配置未声明 -> delete
  for (const path of Object.keys(currentFlat)) {
    if (processedPaths.has(path)) {
      continue
    }

    if (isInManagedScope(path, managedScopes)) {
      steps.push({
        target,
        op: 'delete',
        path,
        oldValue: currentFlat[path],
        highRisk: isHighRiskPath(path),
      })
    }
    // 3. 非 managedScopes -> 不处理
  }

  // 稳定排序：先按 op (delete < set)，再按 path 字典序
  steps.sort((a, b) => {
    if (a.op !== b.op) {
      return a.op === 'delete' ? -1 : 1
    }
    return a.path.localeCompare(b.path)
  })

  return steps
}

/**
 * 生成完整的执行计划
 */
export function createPlan(inputs: PlanInput[]): Plan {
  const allSteps: PatchStep[] = []
  const targets: Target[] = []

  for (const input of inputs) {
    const steps = generateSteps(input)
    allSteps.push(...steps)

    targets.push({
      type: input.targetType,
      fileType: 'settings',
      path: input.configPath,
    })
  }

  // 计算摘要
  const summary = calculateSummary(allSteps)

  return {
    targets,
    steps: allSteps,
    summary,
    createdAt: new Date().toISOString(),
  }
}

/**
 * 计算计划摘要
 */
function calculateSummary(steps: PatchStep[]): PlanSummary {
  let changed = 0
  let deleted = 0
  let highRisk = 0

  for (const step of steps) {
    if (step.op === 'set') {
      changed++
    } else if (step.op === 'delete') {
      deleted++
    }

    if (step.highRisk) {
      highRisk++
    }
  }

  return { changed, deleted, highRisk }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * 深度比较两个值是否相等
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true
  }

  if (
    typeof a !== 'object' ||
    typeof b !== 'object' ||
    a === null ||
    b === null
  ) {
    return false
  }

  if (Array.isArray(a) !== Array.isArray(b)) {
    return false
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      return false
    }
    return a.every((item, index) => deepEqual(item, b[index]))
  }

  const aObj = a as Record<string, unknown>
  const bObj = b as Record<string, unknown>
  const aKeys = Object.keys(aObj)
  const bKeys = Object.keys(bObj)

  if (aKeys.length !== bKeys.length) {
    return false
  }

  return aKeys.every((key) => deepEqual(aObj[key], bObj[key]))
}
