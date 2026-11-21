/**
 * Services 导出
 */

// PRD Parser Service
export {
  validatePRDDocument,
  parsePRDContent,
  getNextPRDItem,
  checkStatisticsConsistency,
  type PRDParseError,
  type PRDParseResult,
  type PRDValidationResult,
} from './prd-parser'

// Progress Parser Service
export {
  parseProgressContent,
  toProgressEntry,
  getValidProgressEntries,
  type ParsedProgressEntry,
  type ProgressParseResult,
} from './progress-parser'

// Spec Parser Service
export {
  scanSpecs,
  readSpec,
  readAllSpecs,
  isSpecComplete,
  getMissingFiles,
  type FileSystemAdapter,
  type SpecScanResult,
  type SpecReadResult,
} from './spec-parser'

// File Watch Service
export {
  createDebouncer,
  EventAccumulator,
  MockFileWatcher,
  isPathInWatchScope,
  createFileChangeEvent,
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_WATCH_DIRS,
  type FileChangeType,
  type FileChangeEvent,
  type FileWatcherOptions,
  type FileWatcherStatus,
  type IFileWatcher,
} from './file-watch'

// Git Service
export {
  MockGitService,
  createUnverifiableResult,
  createSuccessResult,
  isGitQuerySuccess,
  getGitQueryData,
  parseGitLogLine,
  type GitExecutor,
  type IGitService,
} from './git-service'

// Compliance Checker Service
export {
  RULE_ONE_PRD_PER_COMMIT,
  RULE_TYPECHECK_GATE,
  RULE_APPEND_ONLY_PROGRESS,
  RULE_COMMIT_CONVENTION,
  COMPLIANCE_RULES,
  createComplianceResult,
  createViolation,
  checkOnePrdPerCommit,
  checkTypecheckGate,
  checkAppendOnlyProgress,
  checkCommitConvention,
  checkAllCompliance,
  getComplianceSummary,
  type ComplianceRuleName,
  type ComplianceCheckContext,
} from './compliance-checker'

// Audit Service
export {
  extractPrdIdFromProgress,
  extractPrdIdFromCommit,
  groupProgressByPrdId,
  groupCommitsByPrdId,
  determineIntegrity,
  buildTrailForPrd,
  buildAuditTrails,
  generateIntegrityReport,
  filterTrailsByIntegrity,
  getIncompleteTrails,
  validateTrailConsistency,
  validateAllTrailsConsistency,
  type AuditBuildResult,
  type TrailMatcherOptions,
} from './audit-service'
