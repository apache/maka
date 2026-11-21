/**
 * CC-Dev 类型定义
 * 开发态控制脚本的核心类型
 */

/**
 * 子命令类型
 */
export type SubCommand = 'generate' | 'apply' | 'verify' | 'rollback' | 'audit' | 'help';

/**
 * CLI 参数接口
 */
export interface CliArgs {
  command: SubCommand;
  profile?: string;
  dryRun?: boolean;
  verbose?: boolean;
  help?: boolean;
}

/**
 * Profile 定义
 */
export interface Profile {
  name: string;
  description?: string;
  enabledPlugins?: Record<string, boolean>;
  env?: Record<string, string>;
  language?: string;
}

/**
 * 合并后的配置
 */
export interface MergedSettings {
  enabledPlugins: Record<string, boolean>;
  env: Record<string, string>;
  language?: string;
  // 保留未知字段
  [key: string]: unknown;
}

/**
 * 合并统计
 */
export interface MergeStats {
  basePluginCount: number;
  mergedPluginCount: number;
  enabledCount: number;
  disabledCount: number;
  addedKeys: string[];
  removedKeys: string[];
  changedKeys: string[];
}

/**
 * 审计条目
 */
export interface AuditEntry {
  timestamp: string;
  action: 'generate' | 'apply' | 'verify' | 'rollback' | 'migration';
  profile?: string;
  beforeHash?: string;
  afterHash?: string;
  changedKeys: string[];
  backupFile?: string;
  success: boolean;
  error?: string;
}

/**
 * 验证结果
 */
export interface VerifyResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * 回滚信息
 */
export interface RollbackInfo {
  backupPath: string;
  timestamp: string;
  hash: string;
}

/**
 * 操作结果
 */
export interface OperationResult<T = void> {
  success: boolean;
  data?: T;
  error?: string;
}
