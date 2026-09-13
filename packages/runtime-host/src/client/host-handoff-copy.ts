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
        replacement_required: '需要切換 WSL 背景服務',
        busy: '背景服務仍在使用中',
        activity_unknown: '需要確認是否停止背景服務',
        operator_required: '背景服務需要手動更新',
        repair_required: '背景服務需要修復',
        retry_required: '暫時無法完成交接',
      }
    : zh
      ? {
          replacement_required: '需要切换 WSL 后台服务',
          busy: '后台服务仍在使用中',
          activity_unknown: '需要确认是否停止后台服务',
          operator_required: '后台服务需要手动更新',
          repair_required: '后台服务需要修复',
          retry_required: '暂时无法完成交接',
        }
      : {
          replacement_required: 'Switch the WSL background service',
          busy: 'Your background service is still in use',
          activity_unknown: 'Confirm before stopping the service',
          operator_required: 'The background service needs a manual update',
          repair_required: 'Your background service needs repair',
          retry_required: 'The handoff could not finish yet',
        };
  const descriptions = tw
    ? {
        replacement_required:
          '目前尚未更新。選擇繼續後，將透過已安裝的管理程式安全停止舊服務並啟動選定版本；有進行中的工作時會另行確認。',
        busy: '其他連線或正在執行的工作阻止了自動交接。停止並繼續可能中斷這些工作。',
        activity_unknown:
          '背景服務與目前用戶端不相容，且無法確認有哪些工作仍在執行。停止並繼續會重新啟動服務，可能中斷其他視窗或裝置上的工作。',
        operator_required: `目前無法從這裡更新背景服務。請透過 ${view.target.name} 上管理此服務的應用程式或命令更新，再重試。`,
        repair_required:
          '上次啟動或交接失敗。請查看下方診斷資訊，修復原因後再重試；如果狀態沒有改變，重複重試通常不會解決問題。',
        retry_required: '服務狀態發生了變化，或交接尚未完成。可以安全重試，不會預設中斷工作。',
      }
    : zh
      ? {
          replacement_required:
            '当前尚未更新。选择继续后，将通过已安装的管理程序安全停止旧服务并启动选定版本；有活动工作时会另行确认。',
          busy: '其它连接或正在执行的工作阻止了自动交接。停止并继续可能中断这些工作。',
          activity_unknown:
            '后台服务与当前客户端不兼容，且无法确认有哪些工作仍在运行。停止并继续会重新启动服务，可能中断其他窗口或设备上的工作。',
          operator_required: `目前无法从这里更新后台服务。请通过 ${view.target.name} 上管理此服务的应用或命令更新，然后重试。`,
          repair_required:
            '上次启动或交接失败。请查看下方诊断信息，修复原因后再重试；如果状态没有变化，重复重试通常不会解决问题。',
          retry_required: '服务状态发生了变化，或交接尚未完成。可以安全重试，不会默认中断工作。',
        }
      : {
          replacement_required:
            'No update is running. Continue to retire the old service through its installed operator and start the selected version. Interrupting active work requires a separate confirmation.',
          busy: 'Other connections or work in progress prevent an automatic handoff. Stopping the service may interrupt that work.',
          activity_unknown:
            'The background service is incompatible with this client, and its active work is unknown. Stop and continue restarts it and may interrupt work in other windows or devices.',
          operator_required: `This client cannot update the background service here. Use its managing app or operator command on ${view.target.name}, then retry.`,
          repair_required:
            'The last startup or handoff failed. Review the diagnostic below, correct the cause, then retry. Repeating the same action without a state change will usually fail again.',
          retry_required:
            'The service changed or the handoff has not finished. A safe retry will not interrupt work by default.',
        };
  if (view.recoveryBlocker && view.reason === 'operator_required') {
    const guidance = zh
      ? tw
        ? {
            managed:
              '此背景服務由安裝它的 Maka 管理。如果由 Desktop 安裝，請在該 Desktop 中開啟此工作區，然後選擇「停止舊服務並繼續」；否則請使用安裝它的 Maka 更新服務，再回到這裡重試。',
            owner: '此背景服務屬於另一個 Maka 安裝。請使用管理它的 Maka 安裝更新，再重試。',
            installation:
              '這次啟動使用暫存安裝，無法接管現有背景服務。請使用已安裝的 Maka 更新服務，再重試。',
            identity:
              '無法確認舊背景服務的處理程序身分，因此不能安全停止它。請關閉啟動它的 Maka 或透過其管理程式停止服務，再重試。',
          }
        : {
            managed:
              '此后台服务由安装它的 Maka 管理。如果由 Desktop 安装，请在该 Desktop 中打开此工作区，然后选择“停止旧服务并继续”；否则请使用安装它的 Maka 更新服务，再回到这里重试。',
            owner: '此后台服务属于另一个 Maka 安装。请使用管理它的 Maka 安装更新，然后重试。',
            installation:
              '本次启动使用临时安装，无法接管现有后台服务。请使用已安装的 Maka 更新服务，然后重试。',
            identity:
              '无法确认旧后台服务的进程身份，因此不能安全停止它。请关闭启动它的 Maka 或通过其管理程序停止服务，然后重试。',
          }
      : {
          managed:
            'This background service is managed by the Maka installation that created it. If Desktop installed it, open this workspace there and choose Stop old service and continue. Otherwise update the service with that Maka installation, then return here and retry.',
          owner:
            'Another Maka installation owns this background service. Update it using that installation, then retry.',
          installation:
            'This temporary installation cannot take over the existing background service. Update it using an installed Maka, then retry.',
          identity:
            'The old background process could not be identified safely. Close the Maka instance that started it or stop it through its operator, then retry.',
        };
    descriptions.operator_required = guidance[view.recoveryBlocker];
  }
  if (view.manualRecheck && view.reason === 'busy') {
    descriptions.busy = zh
      ? tw
        ? '舊服務拒絕安全停止；這可能是其他連線或背景工作所致。關閉其他用戶端後可再次嘗試安全停止，或明確選擇中斷工作並繼續。'
        : '旧服务拒绝安全停止；这可能是其他连接或后台工作所致。关闭其他客户端后可再次尝试安全停止，或明确选择中断工作并继续。'
      : 'The old service refused safe retirement. Other connections or background work may be keeping it in use. Close other clients and try stopping safely again, or explicitly interrupt work and continue.';
  }
  if (view.manualRecheck && view.reason === 'operator_required') {
    titles.operator_required = zh
      ? tw
        ? '無法連線到背景服務'
        : '无法连接后台服务'
      : 'Cannot connect to the background service';
    descriptions.operator_required = zh
      ? tw
        ? '目前版本無法連線，且尚未執行更新。請查看診斷或更新用戶端，完成後重新檢查。'
        : '当前版本无法连接，且尚未执行更新。请查看诊断或更新客户端，完成后重新检查。'
      : 'These builds cannot connect and no update is running. Check the diagnostic or update the client, then recheck.';
  }
  const packageChange = view.packageChange
    ? `${view.target.name}: ${view.packageChange.current} → ${view.packageChange.target}`
    : '';
  const activity = view.activity;
  const background = activity?.drainResidencies;
  const backgroundFacts = !activity
    ? ''
    : background !== undefined
      ? tw
        ? `${background} 個背景工作`
        : zh
          ? `${background} 个后台工作`
          : `${background} background activities`
      : tw
        ? '背景工作數量未知'
        : zh
          ? '后台工作数量未知'
          : 'Background activity count unknown';
  const facts = activity
    ? tw
      ? `${activity.connections} 個連線 · ${activity.activeOperations} 個進行中的操作`
      : zh
        ? `${activity.connections} 个连接 · ${activity.activeOperations} 个进行中的操作`
        : `${activity.connections} connections · ${activity.activeOperations} operations in progress`
    : '';
  const waiting = view.manualRecheck
    ? zh
      ? tw
        ? '重新檢查只會重試連線，不會更新服務。'
        : '重新检查只会重试连接，不会更新服务。'
      : 'Recheck retries the connection without updating the service.'
    : view.mayExitNaturally
      ? tw
        ? 'Maka 會持續檢查，並在可以安全繼續時自動繼續。'
        : zh
          ? 'Maka 会持续检查，并在可以安全继续时自动继续。'
          : 'Maka keeps checking and continues automatically when it is safe.'
      : tw
        ? 'Maka 會持續檢查。若狀態沒有改變，等待或重試不會解決此問題。'
        : zh
          ? 'Maka 会持续检查。若状态没有变化，等待或重试不会解决此问题。'
          : 'Maka keeps checking. Waiting or retrying will not resolve this unless the service state changes.';
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
        retry: view.manualRecheck ? '重新檢查' : '安全重試',
        replace: '停止舊服務並繼續',
        interrupt: view.manualRecheck
          ? '中斷工作並繼續'
          : view.operation === 'repair'
            ? '中斷並修復'
            : '停止並繼續',
      }
    : zh
      ? {
          cancel: '取消',
          retry: view.manualRecheck ? '重新检查' : '安全重试',
          replace: '停止旧服务并继续',
          interrupt: view.manualRecheck
            ? '中断工作并继续'
            : view.operation === 'repair'
              ? '中断并修复'
              : '停止并继续',
        }
      : {
          cancel: 'Cancel',
          retry: view.manualRecheck ? 'Recheck' : 'Retry safely',
          replace: 'Stop old service and continue',
          interrupt: view.manualRecheck
            ? 'Interrupt work and continue'
            : view.operation === 'repair'
              ? 'Interrupt and repair'
              : 'Stop and continue',
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
        : [packageChange, facts, backgroundFacts, waiting, repairNotice, view.operatorStep]
            .filter(Boolean)
            .join('\n'),
    actions: view.actions.map((action) => ({ action, label: labels[action] })),
  };
}
