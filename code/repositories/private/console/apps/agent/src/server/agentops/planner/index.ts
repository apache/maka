/**
 * Planner Module
 * 提供配置变更计划生成能力
 */

// JSON Path utilities
export {
  flatten,
  unflatten,
  setByPath,
  getByPath,
  deleteByPath,
} from './json-path'
export type { FlatObject } from './json-path'

// Managed Scopes
export {
  isInManagedScope,
  filterManagedPaths,
  filterUnmanagedPaths,
} from './managed-scopes'

// Planner
export { generateSteps, createPlan } from './planner'
export type { PlanInput } from './planner'
