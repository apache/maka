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

interface RecoveryCopy {
  title: string;
  message: string;
  body: string;
  detail: string;
  acknowledge: string;
}

const COPY = {
  'zh-CN': {
    recovered: {
      title: '设置已恢复为默认值',
      body: '设置文件不是有效的 JSON，已恢复默认设置。',
    },
    'commit-unknown': {
      title: '设置已重置，保存状态待确认',
      body: '默认设置已写入，但磁盘同步失败，持久保存状态尚未确认。请重启应用并检查设置。',
    },
    review: '偏好、机器人配置和首次使用设置均已重置。请检查隐身模式、隐私和其他偏好；如需找回原配置，请先退出 Maka，再检查下面的原始文件备份。',
    settings: '设置文件：',
    backup: '原始文件备份：',
    acknowledge: '知道了',
  },
  'zh-TW': {
    recovered: {
      title: '設定已還原為預設值',
      body: '設定檔案不是有效的 JSON，已還原預設設定。',
    },
    'commit-unknown': {
      title: '設定已重設，儲存狀態待確認',
      body: '預設設定已寫入，但磁碟同步失敗，尚未確認是否持久儲存。請重新啟動應用程式並檢查設定。',
    },
    review: '偏好、機器人設定與首次使用設定均已重設。請檢查無痕模式、隱私與其他偏好；如需找回原設定，請先結束 Maka，再檢查下方的原始檔案備份。',
    settings: '設定檔案：',
    backup: '原始檔案備份：',
    acknowledge: '知道了',
  },
  en: {
    recovered: {
      title: 'Settings restored to defaults',
      body: 'The settings file contained invalid JSON and has been reset to defaults.',
    },
    'commit-unknown': {
      title: 'Settings reset; save status uncertain',
      body: 'Default settings were written, but disk synchronization failed and durability is unconfirmed. Restart Maka and check your settings.',
    },
    review: 'Preferences, bot configuration and onboarding settings have been reset. Review Incognito, privacy and other preferences. To recover your previous configuration, quit Maka first, then inspect the original file backup below.',
    settings: 'Settings file: ',
    backup: 'Original file backup: ',
    acknowledge: 'OK',
  },
} satisfies UiCatalog<Record<CorruptSettingsRecovery['outcome'], { title: string; body: string }> & {
  review: string; settings: string; backup: string; acknowledge: string;
}>;

export function settingsRecoveryCopy(
  recovery: CorruptSettingsRecovery,
  locale: UiLocale,
): RecoveryCopy {
  const copy = COPY[locale];
  const message = copy[recovery.outcome];
  return {
    title: message.title,
    message: message.body,
    // Native banners can truncate their body; put the actionable path first.
    body: `${copy.backup}${recovery.backupPath}\n${message.body}`,
    detail: `${copy.review}\n\n${copy.settings}${recovery.settingsPath}\n${copy.backup}${recovery.backupPath}`,
    acknowledge: copy.acknowledge,
  };
}

interface SettingsRecoveryReporterDependencies {
  readonly e2e: boolean;
  readonly locale: () => UiLocale;
  readonly notifications: {
    isSupported(): boolean;
    show(copy: Pick<RecoveryCopy, 'title' | 'body'>, failed: () => void): void;
  };
  /** False leaves the notice pending until a usable window becomes available.
   * Resolves true only after the app's persistent dialog has been dismissed. */
  readonly showNotice: (copy: RecoveryCopy) => Promise<boolean>;
  /** Receives only the result and paths, never JSON contents or parser errors. */
  readonly log: (message: string) => void;
}

/** Keeps recovery guidance until the app can display it. The existing startup
 * and file-watcher paths remain the only settings-effect refresh authorities. */
export function createSettingsRecoveryReporter(deps: SettingsRecoveryReporterDependencies) {
  const pending: CorruptSettingsRecovery[] = [];
  let presenting = false;
  let presentationRequested = false;

  const log = (message: string): void => {
    try { deps.log(message); } catch { /* Diagnostics must not block recovery. */ }
  };
  const notify = (recovery: CorruptSettingsRecovery): void => {
    if (deps.e2e) return;
    const failed = () => log(`[settings-recovery] notification failed; backup=${recovery.backupPath}`);
    try {
      if (!deps.notifications.isSupported()) {
        log(`[settings-recovery] notifications unavailable; backup=${recovery.backupPath}`);
        return;
      }
      deps.notifications.show(settingsRecoveryCopy(recovery, deps.locale()), failed);
    } catch {
      failed();
    }
  };
  const present = (): void => {
    if (pending.length === 0) return;
    presentationRequested = true;
    if (presenting) return;
    presenting = true;
    // The dialog's theme lookup can read settings. Start after the recovery
    // observer returns, without waiting inside the serialized storage read.
    void Promise.resolve().then(async () => {
      while (pending.length > 0) {
        presentationRequested = false;
        const recovery = pending[0];
        try {
          if (!await deps.showNotice(settingsRecoveryCopy(recovery, deps.locale()))) return;
        } catch {
          log(`[settings-recovery] app notice failed; backup=${recovery.backupPath}`);
          return;
        }
        pending.shift();
      }
    }).finally(() => {
      presenting = false;
      if (presentationRequested) present();
    });
  };

  return {
    onRecovery(recovery: CorruptSettingsRecovery): void {
      log(`[settings-recovery] outcome=${recovery.outcome}; settings=${recovery.settingsPath}; backup=${recovery.backupPath}`);
      pending.push(recovery);
      notify(recovery);
      present();
    },
    onWindowReady: present,
  };
}
