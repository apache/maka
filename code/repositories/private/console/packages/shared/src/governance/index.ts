/**
 * 核心类型定义导出
 */

// PRD 相关类型
export type { PRDPriority, PRDItem, PRDStatistics, PRDDocument } from './prd'

// Progress 相关类型
export type { ProgressEntry } from './progress'

// Iteration 相关类型
export type { Iteration, IterationRecord, IterationSteps } from './iteration'

// Milestone 相关类型
export type { MilestoneGroupBy, MilestoneStatistics, Milestone } from './milestone'

// Compliance 相关类型
export type {
  ComplianceRuleId,
  ComplianceSeverity,
  ComplianceRule,
  ComplianceStatus,
  ComplianceViolation,
  ComplianceResult,
  ComplianceContext,
  ComplianceReport,
} from './compliance'

// Audit 相关类型
export type { AuditIntegrity, AuditTrail, IntegrityReport, AuditContext } from './audit'

// Git 相关类型
export type { GitCommit, GitFile, GitFileStatus, GitLogOptions, GitAvailability, GitQueryResult } from './git'

// Spec 相关类型
export type { SpecCompleteness, SpecDocument } from './spec'
