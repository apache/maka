/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  AppSettings,
  SettingsTestResult,
  UpdateAppSettingsInput,
  UsageRange,
  UsageStats,
} from '@maka/core/settings';
import type { OnboardingMilestone, OnboardingMilestoneId } from '@maka/core/onboarding';
import { createDefaultSettings, mergeSettings, normalizeSettings } from '@maka/core/settings';
import { sanitizeOnboardingMilestones } from '@maka/core/onboarding';
import { readUsageStats } from './usage-stats-store.js';

export interface SettingsStore {
  get(): Promise<AppSettings>;
  update(patch: UpdateAppSettingsInput): Promise<AppSettings>;
  updateIf(
    predicate: (current: AppSettings) => boolean,
    patch: UpdateAppSettingsInput,
  ): Promise<{ applied: boolean; settings: AppSettings }>;
  testNetworkProxy(): Promise<SettingsTestResult>;
  usageStats(range?: UsageRange): Promise<UsageStats>;
  /**
   * PR110b: upsert a single onboarding milestone. Caller passes the
   * desired terminal status; the store stamps `Date.now()` so the
   * renderer cannot tamper with timestamps. Returns the freshly
   * sanitized milestone list. Last-valid-entry-wins dedup applies.
   *
   * @throws if `id` is not in `OnboardingMilestoneId` or status is
   *         not 'completed' | 'skipped'.
   */
  upsertOnboardingMilestone(
    id: OnboardingMilestoneId,
    status: 'completed' | 'skipped',
  ): Promise<OnboardingMilestone[]>;
  /**
   * Remove one milestone entry without disturbing the rest. Used for
   * reversible first-run suggestion dismissal; it still flows through
   * the closed enum so arbitrary renderer strings cannot reshape the
   * onboarding settings section.
   */
  clearOnboardingMilestone(id: OnboardingMilestoneId): Promise<OnboardingMilestone[]>;
}

export function createSettingsStore(workspaceRoot: string): SettingsStore {
  return new FileSettingsStore(workspaceRoot);
}

class FileSettingsStore implements SettingsStore {
  private readonly settingsPath: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly workspaceRoot: string) {
    this.settingsPath = join(workspaceRoot, 'settings.json');
  }

  async get(): Promise<AppSettings> {
    let settings: AppSettings | undefined;
    await this.withQueue(async () => {
      settings = await this.readOrCreate();
    });
    if (!settings) throw new Error('Failed to read settings');
    return settings;
  }

  private async readOrCreate(): Promise<AppSettings> {
    try {
      const text = await readFile(this.settingsPath, 'utf8');
      return normalizeSettings(JSON.parse(text));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const settings = createDefaultSettings();
      await this.write(settings);
      return settings;
    }
  }

  async update(patch: UpdateAppSettingsInput): Promise<AppSettings> {
    let next: AppSettings | undefined;
    await this.withQueue(async () => {
      const current = await this.readOrCreate();
      next = mergeSettings(current, patch);
      await this.write(next);
    });
    if (!next) throw new Error('Failed to update settings');
    return next;
  }

  async updateIf(
    predicate: (current: AppSettings) => boolean,
    patch: UpdateAppSettingsInput,
  ): Promise<{ applied: boolean; settings: AppSettings }> {
    let result: { applied: boolean; settings: AppSettings } | undefined;
    await this.withQueue(async () => {
      const current = await this.readOrCreate();
      if (!predicate(current)) {
        result = { applied: false, settings: current };
        return;
      }
      const next = mergeSettings(current, patch);
      await this.write(next);
      result = { applied: true, settings: next };
    });
    if (!result) throw new Error('Failed to conditionally update settings');
    return result;
  }

  async upsertOnboardingMilestone(
    id: OnboardingMilestoneId,
    status: 'completed' | 'skipped',
  ): Promise<OnboardingMilestone[]> {
    if (status !== 'completed' && status !== 'skipped') {
      throw new Error(`invalid onboarding milestone status: ${String(status)}`);
    }
    const timestamp = Date.now();
    const next: OnboardingMilestone =
      status === 'completed' ? { id, completedAt: timestamp } : { id, skippedAt: timestamp };
    let result: OnboardingMilestone[] | undefined;
    await this.withQueue(async () => {
      const current = await this.readOrCreate();
      // Append the new entry; sanitize() applies last-valid-entry-wins
      // dedup with stable first-seen position. ID validity is enforced
      // by the sanitizer (closed enum).
      const sanitized = sanitizeOnboardingMilestones([...current.onboarding.milestones, next]);
      if (!sanitized.some((entry) => entry.id === id)) {
        // ID was rejected by the validator — propagate so the IPC
        // handler can reject the caller's input.
        throw new Error(`invalid onboarding milestone id: ${String(id)}`);
      }
      const merged: AppSettings = {
        ...current,
        onboarding: { milestones: sanitized },
      };
      await this.write(merged);
      result = sanitized;
    });
    if (!result) throw new Error('Failed to upsert onboarding milestone');
    return result;
  }

  async clearOnboardingMilestone(id: OnboardingMilestoneId): Promise<OnboardingMilestone[]> {
    let result: OnboardingMilestone[] | undefined;
    await this.withQueue(async () => {
      const current = await this.readOrCreate();
      const knownId = sanitizeOnboardingMilestones([{ id }]).some((entry) => entry.id === id);
      if (!knownId) {
        throw new Error(`invalid onboarding milestone id: ${String(id)}`);
      }
      const milestones = current.onboarding.milestones.filter((entry) => entry.id !== id);
      const merged: AppSettings = {
        ...current,
        onboarding: { milestones },
      };
      await this.write(merged);
      result = milestones;
    });
    if (!result) throw new Error('Failed to clear onboarding milestone');
    return result;
  }

  async testNetworkProxy(): Promise<SettingsTestResult> {
    const started = Date.now();
    const settings = await this.get();
    const proxy = settings.network.proxy;
    if (!proxy.enabled) {
      return { ok: true, message: '代理未启用，当前会直接连接。', latencyMs: Date.now() - started };
    }
    if (!proxy.host.trim()) return { ok: false, message: '代理服务器地址不能为空' };
    if (!Number.isInteger(proxy.port) || proxy.port <= 0 || proxy.port > 65535) {
      return { ok: false, message: '代理端口必须在 1-65535 之间' };
    }
    if (proxy.authEnabled && (!proxy.username.trim() || !proxy.password)) {
      return { ok: false, message: '启用代理认证后需要用户名和密码' };
    }
    return {
      ok: true,
      message: `代理配置有效：${proxy.protocol}://${proxy.host}:${proxy.port}`,
      latencyMs: Date.now() - started,
      details: { bypassList: proxy.bypassList, autoBypassDomains: proxy.autoBypassDomains },
    };
  }

  async usageStats(range: UsageRange = '24h'): Promise<UsageStats> {
    return readUsageStats(this.workspaceRoot, range);
  }

  private async write(settings: AppSettings): Promise<void> {
    await mkdir(dirname(this.settingsPath), { recursive: true });
    const tempPath = `${this.settingsPath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
    await rename(tempPath, this.settingsPath);
  }

  private withQueue(operation: () => Promise<void>): Promise<void> {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => {});
    return next;
  }
}
