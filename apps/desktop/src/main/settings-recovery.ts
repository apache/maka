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

import type { UiCatalog, UiLocale } from '@maka/core/ui-locale';
import type { CorruptSettingsRecovery } from '@maka/storage/settings-store';
import type { ClientSettingsEffects } from './client-settings-effects.js';

interface RecoveryCopy {
  title: string;
  body: string;
}

type RecoveryStatus = CorruptSettingsRecovery['outcome'] | 'refresh-failed';

const COPY = {
  'zh-CN': {
    recovered: {
      title: '设置已恢复为默认值',
      body: '设置文件损坏，已恢复默认设置。请检查隐身模式、隐私和其他偏好。',
    },
    'commit-unknown': {
      title: '设置已重置，保存状态待确认',
      body: '默认设置已写入，但磁盘同步失败，持久保存状态尚未确认。请检查隐身模式和隐私设置。',
    },
    'refresh-failed': {
      title: '运行中的设置刷新失败',
      body: '设置文件已重置，但运行中的设置未能全部刷新。请重启应用并检查隐私设置。',
    },
    backup: '原始文件备份：',
  },
  'zh-TW': {
    recovered: {
      title: '設定已還原為預設值',
      body: '設定檔案損毀，已還原預設設定。請檢查無痕模式、隱私與其他偏好。',
    },
    'commit-unknown': {
      title: '設定已重設，儲存狀態待確認',
      body: '預設設定已寫入，但磁碟同步失敗，尚未確認是否持久儲存。請檢查無痕模式與隱私設定。',
    },
    'refresh-failed': {
      title: '執行中的設定更新失敗',
      body: '設定檔案已重設，但執行中的設定未能全部更新。請重新啟動應用程式並檢查隱私設定。',
    },
    backup: '原始檔案備份：',
  },
  en: {
    recovered: {
      title: 'Settings restored to defaults',
      body: 'The settings file was invalid and has been reset. Please review Incognito, privacy and other preferences.',
    },
    'commit-unknown': {
      title: 'Settings reset; save status uncertain',
      body: 'Default settings were written, but disk synchronization failed and durability is unconfirmed. Please review Incognito and privacy settings.',
    },
    'refresh-failed': {
      title: 'Running settings could not be refreshed',
      body: 'The settings file was reset, but some running settings could not be refreshed. Restart the app and review your privacy settings.',
    },
    backup: 'Original file backup: ',
  },
} satisfies UiCatalog<Record<RecoveryStatus, RecoveryCopy> & { backup: string }>;

export function settingsRecoveryCopy(
  recovery: CorruptSettingsRecovery,
  locale: UiLocale,
  refreshFailed = false,
): RecoveryCopy {
  const copy = COPY[locale];
  const message = copy[refreshFailed ? 'refresh-failed' : recovery.outcome];
  // Preserve the durability warning when reporting a separate refresh failure.
  const warning = refreshFailed && recovery.outcome === 'commit-unknown'
    ? ` ${copy['commit-unknown'].body}`
    : '';
  return {
    title: message.title,
    body: `${message.body}${warning} ${copy.backup}${recovery.backupPath}`,
  };
}

interface SettingsRecoveryReporterDependencies {
  readonly e2e: boolean;
  readonly locale: () => UiLocale;
  readonly notifications: {
    isSupported(): boolean;
    create(copy: RecoveryCopy, failed: () => void): { show(): void };
  };
  /** Receives only the result and paths, never JSON contents or parser errors. */
  readonly log: (message: string) => void;
}

/** Observes recovery without becoming a second settings authority. Notification
 * delivery is best-effort; refresh reuses the existing effects queue and rereads
 * the file after the storage operation releases its own queue. */
export function createSettingsRecoveryReporter(deps: SettingsRecoveryReporterDependencies) {
  let effects: Pick<ClientSettingsEffects, 'refresh'> | undefined;
  let pending: CorruptSettingsRecovery | undefined;

  const log = (message: string): void => {
    try { deps.log(message); } catch { /* Diagnostics must not block recovery. */ }
  };
  const notify = (recovery: CorruptSettingsRecovery, refreshFailed = false): void => {
    if (deps.e2e) return;
    const failed = () => log(`[settings-recovery] notification failed; backup=${recovery.backupPath}`);
    try {
      if (!deps.notifications.isSupported()) {
        log(`[settings-recovery] notifications unavailable; backup=${recovery.backupPath}`);
        return;
      }
      deps.notifications.create(settingsRecoveryCopy(recovery, deps.locale(), refreshFailed), failed).show();
    } catch {
      failed();
    }
  };
  const refresh = (): void => {
    const target = effects;
    const recovery = pending;
    if (!target || !recovery) return;
    pending = undefined;
    // Never await this from onRecovery: refresh can itself be the read that
    // discovers corruption, and both storage and effects serialize operations.
    void Promise.resolve().then(() => target.refresh(true)).catch(() => {
      log(`[settings-recovery] refresh failed; outcome=${recovery.outcome}; backup=${recovery.backupPath}; restart the app`);
      notify(recovery, true);
    });
  };

  return {
    onRecovery(recovery: CorruptSettingsRecovery): void {
      log(`[settings-recovery] outcome=${recovery.outcome}; settings=${recovery.settingsPath}; backup=${recovery.backupPath}`);
      notify(recovery);
      pending = recovery;
      refresh();
    },
    setEffects(value: Pick<ClientSettingsEffects, 'refresh'>): void {
      effects = value;
      refresh();
    },
  };
}
