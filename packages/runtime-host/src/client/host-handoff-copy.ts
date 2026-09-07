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

import type { UiLocale } from '@maka/core/ui-locale';
import type { HostHandoffAction, HostHandoffView } from './host-handoff.js';

/** Shared consequence-oriented copy, not a second lifecycle policy. */
export function formatHostHandoff(
  view: HostHandoffView,
  locale: UiLocale,
): {
  title: string;
  description: string;
  detail: string;
  actions: readonly { action: HostHandoffAction; label: string }[];
} {
  const zh = locale !== 'en';
  const tw = locale === 'zh-TW';
  const titles = tw
    ? {
        busy: '背景服務仍在使用中',
        activity_unknown: '需要確認是否停止背景服務',
        operator_required: '需要在服務所在位置處理',
        repair_required: '背景服務需要修復',
        retry_required: '暫時無法完成交接',
      }
    : zh
      ? {
          busy: '后台服务仍在使用中',
          activity_unknown: '需要确认是否停止后台服务',
          operator_required: '需要在服务所在位置处理',
          repair_required: '后台服务需要修复',
          retry_required: '暂时无法完成交接',
        }
      : {
          busy: 'Your background service is still in use',
          activity_unknown: 'Confirm before stopping the service',
          operator_required: 'Action is needed where the service runs',
          repair_required: 'Your background service needs repair',
          retry_required: 'The handoff could not finish yet',
        };
  const descriptions = tw
    ? {
        busy: '其他連線或正在執行的工作阻止了自動交接。停止並繼續可能中斷這些工作。',
        activity_unknown:
          '這個版本無法提供足夠的活動資訊。停止服務可能中斷其他視窗或裝置上的工作。',
        operator_required: `目前的用戶端沒有替換此服務的權限。請在 ${view.target.name} 上，由管理該服務的使用者更新或停止服務。`,
        repair_required: '上次啟動或交接未能完成。可以安全重試；若仍失敗，請複製診斷資訊。',
        retry_required: '服務狀態發生了變化，或交接尚未完成。可以安全重試，不會預設中斷工作。',
      }
    : zh
      ? {
          busy: '其它连接或正在执行的工作阻止了自动交接。停止并继续可能中断这些工作。',
          activity_unknown:
            '这个版本无法提供足够的活动信息。停止服务可能中断其它窗口或设备上的工作。',
          operator_required: `当前客户端没有替换此服务的权限。请在 ${view.target.name} 上，由管理该服务的用户更新或停止服务。`,
          repair_required: '上次启动或交接未能完成。可以安全重试；若仍失败，请复制诊断信息。',
          retry_required: '服务状态发生了变化，或交接尚未完成。可以安全重试，不会默认中断工作。',
        }
      : {
          busy: 'Other connections or work in progress prevent an automatic handoff. Stopping the service may interrupt that work.',
          activity_unknown:
            'This version cannot provide enough activity information. Stopping it may interrupt work in other windows or on other devices.',
          operator_required: `This client cannot replace the service. Ask its operator to update or stop it on ${view.target.name}.`,
          repair_required:
            'The last startup or handoff did not finish. Retry safely, or copy diagnostics if it still fails.',
          retry_required:
            'The service changed or the handoff has not finished. A safe retry will not interrupt work by default.',
        };
  const activity = view.activity;
  const facts = activity
    ? tw
      ? `${activity.connections} 個連線 · ${activity.activeOperations} 個進行中的操作`
      : zh
        ? `${activity.connections} 个连接 · ${activity.activeOperations} 个进行中的操作`
        : `${activity.connections} connections · ${activity.activeOperations} operations in progress`
    : '';
  const waiting = view.mayExitNaturally
    ? tw
      ? 'Maka 會持續檢查，並在可以安全繼續時自動繼續。'
      : zh
        ? 'Maka 会持续检查，并在可以安全继续时自动继续。'
        : 'Maka keeps checking and continues automatically when it is safe.'
    : tw
      ? 'Maka 會持續檢查。常駐服務不會僅因等待而結束，可能需要你採取操作。'
      : zh
        ? 'Maka 会持续检查。常驻服务不会仅因等待而退出，可能需要你采取操作。'
        : 'Maka keeps checking. A persistent service will not exit just because you wait; action may be needed.';
  const repairNotice =
    view.operation === 'repair'
      ? tw
        ? '修復將使用目前應用程式配套的版本，可能替換現有服務版本。'
        : zh
          ? '修复将使用当前应用配套的版本，可能替换现有服务版本。'
          : 'Repair uses the version supplied with this app and may replace the installed service version.'
      : '';
  const labels = tw
    ? {
        cancel: '取消',
        retry: '安全重試',
        interrupt: view.operation === 'repair' ? '中斷並修復' : '停止並繼續',
      }
    : zh
      ? {
          cancel: '取消',
          retry: '安全重试',
          interrupt: view.operation === 'repair' ? '中断并修复' : '停止并继续',
        }
      : {
          cancel: 'Cancel',
          retry: 'Retry safely',
          interrupt: view.operation === 'repair' ? 'Interrupt and repair' : 'Stop and continue',
        };
  const phases = tw
    ? {
        checking: '正在檢查服務',
        staging: '正在準備更新',
        pausing: '正在等待安全暫停點',
        retiring: '正在停止舊服務',
        replacing: '正在替換服務',
        verifying: '正在確認工作區已就緒',
      }
    : zh
      ? {
          checking: '正在检查服务',
          staging: '正在准备更新',
          pausing: '正在等待安全暂停点',
          retiring: '正在停止旧服务',
          replacing: '正在替换服务',
          verifying: '正在确认工作区已就绪',
        }
      : {
          checking: 'Checking the service',
          staging: 'Preparing the update',
          pausing: 'Waiting for a safe pause point',
          retiring: 'Stopping the previous service',
          replacing: 'Replacing the service',
          verifying: 'Verifying your workspace is ready',
        };
  return {
    title:
      view.state === 'progress'
        ? tw
          ? '正在繼續開啟工作區'
          : zh
            ? '正在继续打开工作区'
            : 'Continuing to your workspace'
        : titles[view.reason],
    description:
      view.state === 'progress' ? phases[view.phase ?? 'checking'] : descriptions[view.reason],
    detail:
      view.state === 'progress'
        ? tw
          ? '正在完成交接或安全收尾，請稍候。'
          : zh
            ? '正在完成交接或安全收尾，请稍候。'
            : 'Finishing the handoff or its safe recovery. Please wait.'
        : [facts, waiting, repairNotice, view.operatorStep].filter(Boolean).join('\n'),
    actions: view.actions.map((action) => ({ action, label: labels[action] })),
  };
}
