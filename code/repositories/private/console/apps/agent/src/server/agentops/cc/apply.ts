/**
 * CC-Dev Apply 子命令
 * 将生成的配置应用到 Claude Code
 */

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as crypto from 'crypto'
import type { OperationResult, AuditEntry } from './types'

/**
 * 获取数据根目录
 * 默认: ~/.claude-profile
 * 可通过 CC_PROFILE_HOME 环境变量覆盖
 */
function getDataRoot(): string {
  const envRoot = process.env['CC_PROFILE_HOME']
  if (envRoot) return envRoot

  return path.join(os.homedir(), '.claude-profile')
}

/**
 * 获取 Claude Code 配置文件路径（apply 目标）
 */
function getClaudeSettingsPath(): string {
  // 控制台/测试可通过 CONSOLE_CC_SETTINGS 注入目标路径，避免触碰真实 ~/.claude
  const envPath = process.env['CONSOLE_CC_SETTINGS']
  if (envPath) return envPath
  return path.join(os.homedir(), '.claude', 'settings.json')
}

/**
 * 计算文件哈希（SHA256 前 16 字符）
 */
function computeHash(content: string): string {
  const hash = crypto.createHash('sha256')
  hash.update(content)
  return hash.digest('hex').substring(0, 16)
}

/**
 * 创建备份
 */
function createBackup(filePath: string, backupDir: string): string | null {
  if (!fs.existsSync(filePath)) {
    return null
  }

  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true })
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19)
  const backupName = `settings.json.bak-${timestamp}-${crypto.randomUUID()}`
  const backupPath = path.join(backupDir, backupName)

  fs.copyFileSync(filePath, backupPath, fs.constants.COPYFILE_EXCL)
  return backupPath
}

/**
 * 写入审计日志
 */
function writeAuditLog(entry: AuditEntry, auditDir: string): void {
  if (!fs.existsSync(auditDir)) {
    fs.mkdirSync(auditDir, { recursive: true })
  }

  const auditPath = path.join(auditDir, 'audit.jsonl')
  const line = JSON.stringify(entry) + '\n'
  fs.appendFileSync(auditPath, line, 'utf-8')
}

/**
 * 原子写入文件
 */
function atomicWrite(filePath: string, content: string): void {
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  const tempPath = path.join(dir, `.settings.json.tmp.${process.pid}`)
  fs.writeFileSync(tempPath, content, 'utf-8')
  fs.renameSync(tempPath, filePath)
}

/**
 * Apply 子命令入口
 */
export async function apply(
  options: { dryRun?: boolean; verbose?: boolean; profile?: string } = {}
): Promise<OperationResult> {
  const { dryRun = false, verbose = false, profile } = options

  try {
    // 1. 获取路径
    // 控制台/测试通过 CC_DEV_ROOT 注入配置源根（原 import.meta.url 推导在 Windows 下带 /C:/ 前缀缺陷）
    const scriptRoot = process.env['CC_DEV_ROOT']
      ? process.env['CC_DEV_ROOT']
      : path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
    const runtimeSettingsPath = path.join(scriptRoot, '.claude', 'runtime', 'settings.local.json')

    // 检查运行时配置是否存在
    if (!fs.existsSync(runtimeSettingsPath)) {
      return {
        success: false,
        error: `运行时配置不存在: ${runtimeSettingsPath}\n请先运行 generate 命令`,
      }
    }

    const dataRoot = getDataRoot()
    const targetPath = getClaudeSettingsPath() // apply 目标是 ~/.claude/settings.json
    const backupDir = path.join(dataRoot, 'backups')
    const auditDir = path.join(dataRoot, 'audit')

    // 2. 读取新配置
    const newContent = fs.readFileSync(runtimeSettingsPath, 'utf-8')
    const newHash = computeHash(newContent)

    // 3. 读取旧配置（如果存在）
    let beforeHash = 'empty'
    if (fs.existsSync(targetPath)) {
      const oldContent = fs.readFileSync(targetPath, 'utf-8')
      beforeHash = computeHash(oldContent)
    }

    if (verbose) {
      console.log(`[apply] 源文件: ${runtimeSettingsPath}`)
      console.log(`[apply] 目标文件: ${targetPath}`)
      console.log(`[apply] Before Hash: ${beforeHash}`)
      console.log(`[apply] After Hash: ${newHash}`)
    }

    if (dryRun) {
      console.log('\n=== 预览模式 ===')
      console.log(`将从: ${runtimeSettingsPath}`)
      console.log(`写入: ${targetPath}`)
      console.log(`备份目录: ${backupDir}`)
      console.log(`Hash 变更: ${beforeHash} -> ${newHash}`)
      return { success: true }
    }

    // 4. 创建备份
    const backupPath = createBackup(targetPath, backupDir)
    if (backupPath && verbose) {
      console.log(`[apply] 备份已创建: ${backupPath}`)
    }

    // 5. 原子写入
    atomicWrite(targetPath, newContent)
    console.log(`✓ 配置已应用: ${targetPath}`)

    // 6. 写入审计日志
    const auditEntry: AuditEntry = {
      timestamp: new Date().toISOString(),
      action: 'apply',
      profile,
      beforeHash,
      afterHash: newHash,
      changedKeys: ['*'], // 简化处理，标记全部变更
      backupFile: backupPath || undefined,
      success: true,
    }
    writeAuditLog(auditEntry, auditDir)

    // 7. 验证写入
    const verifyContent = fs.readFileSync(targetPath, 'utf-8')
    const verifyHash = computeHash(verifyContent)

    if (verifyHash !== newHash) {
      return {
        success: false,
        error: '写后验证失败：哈希不匹配',
      }
    }

    if (verbose) {
      console.log(`[apply] 写后验证通过`)
    }

    return { success: true }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
