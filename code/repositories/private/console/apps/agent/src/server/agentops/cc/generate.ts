/**
 * CC-Dev Generate 子命令
 * 合并 base + profile 生成运行时配置
 */

import * as fs from 'fs';
import * as path from 'path';
import type { MergedSettings, MergeStats, OperationResult, Profile } from './types';

/**
 * 获取脚本根目录
 */
function getScriptRoot(): string {
  // 控制台/测试可通过 CC_DEV_ROOT 注入配置源根（.claude/{base,profiles,runtime} 所在目录）
  const envRoot = process.env['CC_DEV_ROOT'];
  if (envRoot) return envRoot;
  // 支持从 src/ 或编译后的目录运行
  const currentDir = path.dirname(new URL(import.meta.url).pathname);
  // 回到 scripts/cc-dev
  return path.resolve(currentDir, '..');
}

/**
 * 深度合并两个对象
 */
function deepMerge<T extends Record<string, unknown>>(base: T, patch: Partial<T>): T {
  const result = { ...base };
  
  for (const key of Object.keys(patch) as (keyof T)[]) {
    const patchValue = patch[key];
    const baseValue = base[key];
    
    if (
      patchValue !== undefined &&
      typeof patchValue === 'object' &&
      patchValue !== null &&
      !Array.isArray(patchValue) &&
      typeof baseValue === 'object' &&
      baseValue !== null &&
      !Array.isArray(baseValue)
    ) {
      // 递归合并对象
      result[key] = deepMerge(
        baseValue as Record<string, unknown>,
        patchValue as Record<string, unknown>
      ) as T[keyof T];
    } else if (patchValue !== undefined) {
      // 直接覆盖（包括数组）
      result[key] = patchValue as T[keyof T];
    }
  }
  
  return result;
}

/**
 * 读取 JSON 文件
 */
function readJson<T>(filePath: string): T {
  const content = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(content) as T;
}

/**
 * 写入 JSON 文件
 */
function writeJson(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

/**
 * 计算合并统计
 */
function computeStats(
  base: MergedSettings,
  merged: MergedSettings
): MergeStats {
  const basePlugins = base.enabledPlugins || {};
  const mergedPlugins = merged.enabledPlugins || {};
  
  const baseKeys = new Set(Object.keys(basePlugins));
  const mergedKeys = new Set(Object.keys(mergedPlugins));
  
  const addedKeys: string[] = [];
  const removedKeys: string[] = [];
  const changedKeys: string[] = [];
  
  // 检查新增和变更
  for (const key of mergedKeys) {
    if (!baseKeys.has(key)) {
      addedKeys.push(key);
    } else if (basePlugins[key] !== mergedPlugins[key]) {
      changedKeys.push(key);
    }
  }
  
  // 检查删除（在 patch 中设为 false 的不算删除，只是禁用）
  for (const key of baseKeys) {
    if (!mergedKeys.has(key)) {
      removedKeys.push(key);
    }
  }
  
  // 统计启用/禁用
  let enabledCount = 0;
  let disabledCount = 0;
  for (const value of Object.values(mergedPlugins)) {
    if (value) enabledCount++;
    else disabledCount++;
  }
  
  return {
    basePluginCount: baseKeys.size,
    mergedPluginCount: mergedKeys.size,
    enabledCount,
    disabledCount,
    addedKeys,
    removedKeys,
    changedKeys,
  };
}

/**
 * Generate 子命令入口
 */
export async function generate(
  profileName: string,
  options: { dryRun?: boolean; verbose?: boolean } = {}
): Promise<OperationResult<{ merged: MergedSettings; stats: MergeStats }>> {
  const { dryRun = false, verbose = false } = options;
  
  try {
    const scriptRoot = getScriptRoot();
    const claudeDir = path.join(scriptRoot, '.claude');
    const baseDir = path.join(claudeDir, 'base');
    const profilesDir = path.join(claudeDir, 'profiles');
    const runtimeDir = path.join(claudeDir, 'runtime');
    
    // 1. 验证路径
    const baseSettingsPath = path.join(baseDir, 'settings.json');
    if (!fs.existsSync(baseSettingsPath)) {
      return {
        success: false,
        error: `未找到 base 配置: ${baseSettingsPath}`,
      };
    }
    
    const profileDir = path.join(profilesDir, profileName);
    const profilePatchPath = path.join(profileDir, 'settings.patch.json');
    if (!fs.existsSync(profilePatchPath)) {
      return {
        success: false,
        error: `未找到 profile '${profileName}' 的配置: ${profilePatchPath}`,
      };
    }
    
    // 2. 读取配置
    const base = readJson<MergedSettings>(baseSettingsPath);
    const patch = readJson<Partial<Profile>>(profilePatchPath);
    
    if (verbose) {
      console.log(`[generate] Base 配置: ${baseSettingsPath}`);
      console.log(`[generate] Profile 补丁: ${profilePatchPath}`);
    }
    
    // 3. 合并配置
    const merged = deepMerge(base, patch as Partial<MergedSettings>);
    
    // 4. 计算统计
    const stats = computeStats(base, merged);
    
    if (verbose || dryRun) {
      console.log('\n=== 合并统计 ===');
      console.log(`Base 插件数: ${stats.basePluginCount}`);
      console.log(`合并后插件数: ${stats.mergedPluginCount}`);
      console.log(`  启用: ${stats.enabledCount}`);
      console.log(`  禁用: ${stats.disabledCount}`);
      
      if (stats.changedKeys.length > 0) {
        console.log(`变更: ${stats.changedKeys.join(', ')}`);
      }
      if (stats.addedKeys.length > 0) {
        console.log(`新增: ${stats.addedKeys.join(', ')}`);
      }
    }
    
    // 5. 输出结果
    if (dryRun) {
      console.log('\n=== 预览模式 - 合并后的配置 ===');
      console.log(JSON.stringify(merged, null, 2));
    } else {
      // 写入 runtime 目录
      const runtimeSettingsPath = path.join(runtimeDir, 'settings.local.json');
      writeJson(runtimeSettingsPath, merged);
      console.log(`\n✓ 配置已生成: ${runtimeSettingsPath}`);
    }
    
    return {
      success: true,
      data: { merged, stats },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
