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

import type {
  AgentGraphClientOperator,
  AgentGraphClientSnapshot,
} from '@maka/runtime/stream-graph-read-model';
import type { UiCatalog, UiLocale } from '@maka/core/ui-locale';

export interface AgentGraphPanelCopy {
  title: string;
  loading: string;
  retry: string;
  collapse: string;
  expand: string;
  dismiss: string;
  stop: string;
  stopping: string;
  stopFailed: string;
  loadFailed: string;
  openSession: string;
  operators: string;
  selectedResults: string;
  epoch: string;
  currentEpoch: string;
  historicalEpoch: string;
  cappedEpochs(count: number): string;
  noOperators: string;
  hiddenOperators(count: number): string;
  progress(settled: number, total: number, hasOmitted: boolean): string;
  status(status: AgentGraphClientSnapshot['status']): string;
  operatorStatus(status: AgentGraphClientOperator['status']): string;
  wait(operator: AgentGraphClientOperator): string | undefined;
}

const AGENT_GRAPH_PANEL_COPY = {
  'zh-CN': {
    title: 'Agent Graph',
    loading: '正在读取 Graph 状态…',
    retry: '重试',
    collapse: '收起 Agent Graph',
    expand: '展开 Agent Graph',
    dismiss: '关闭 Agent Graph',
    stop: '停止 Graph',
    stopping: '停止中…',
    stopFailed: '停止 Graph 失败，请重试。',
    loadFailed: 'Graph 状态刷新失败。',
    openSession: '打开子任务',
    operators: 'Operators',
    selectedResults: '已选择结果',
    epoch: 'Graph 运行轮次',
    currentEpoch: '当前',
    historicalEpoch: '历史记录（只读）',
    cappedEpochs: (count) => `仅显示最近 ${count} 次运行`,
    noOperators: '等待主 Agent 创建 operator…',
    hiddenOperators: (count) => `另有 ${count} 个 operator`,
    progress: (settled, total, hasOmitted) =>
      hasOmitted ? `可见 ${settled}/${total} 已结束` : `${settled}/${total} 已结束`,
    status: (status) =>
      ({
        empty: '等待调度',
        active: '运行中',
        closing: '收尾中',
        waiting: '等待中',
        stopped: '已停止',
        failed: '失败',
        completed: '已完成',
      })[status],
    operatorStatus: (status) =>
      ({
        not_started: '未启动',
        waiting: '等待',
        runnable: '可运行',
        running: '运行中',
        blocked: '受阻',
        completed: '完成',
        failed: '失败',
        aborted: '中止',
        cancelled: '取消',
      })[status],
    wait: waitReasonZh,
  },
  'zh-TW': {
    title: 'Agent Graph',
    loading: '正在讀取 Graph 狀態…',
    retry: '重試',
    collapse: '收起 Agent Graph',
    expand: '展開 Agent Graph',
    dismiss: '關閉 Agent Graph',
    stop: '停止 Graph',
    stopping: '停止中…',
    stopFailed: '停止 Graph 失敗，請重試。',
    loadFailed: 'Graph 狀態重新整理失敗。',
    openSession: '開啟子任務',
    operators: 'Operators',
    selectedResults: '已選取結果',
    epoch: 'Graph 執行輪次',
    currentEpoch: '目前',
    historicalEpoch: '歷史記錄（唯讀）',
    cappedEpochs: (count) => `僅顯示最近 ${count} 次執行`,
    noOperators: '等待主 Agent 建立 operator…',
    hiddenOperators: (count) => `另有 ${count} 個 operator`,
    progress: (settled, total, hasOmitted) =>
      hasOmitted ? `可見項目中 ${settled}/${total} 已結束` : `${settled}/${total} 已結束`,
    status: (status) =>
      ({
        empty: '等待排程',
        active: '執行中',
        closing: '收尾中',
        waiting: '等待中',
        stopped: '已停止',
        failed: '失敗',
        completed: '已完成',
      })[status],
    operatorStatus: (status) =>
      ({
        not_started: '尚未啟動',
        waiting: '等待',
        runnable: '可執行',
        running: '執行中',
        blocked: '受阻',
        completed: '完成',
        failed: '失敗',
        aborted: '已中止',
        cancelled: '已取消',
      })[status],
    wait: waitReasonZhTw,
  },
  en: {
    title: 'Agent Graph',
    loading: 'Loading graph state…',
    retry: 'Retry',
    collapse: 'Collapse Agent Graph',
    expand: 'Expand Agent Graph',
    dismiss: 'Dismiss Agent Graph',
    stop: 'Stop graph',
    stopping: 'Stopping…',
    stopFailed: 'Could not stop the graph. Try again.',
    loadFailed: 'Could not refresh graph state.',
    openSession: 'Open child task',
    operators: 'Operators',
    selectedResults: 'Selected results',
    epoch: 'Graph run',
    currentEpoch: 'Current',
    historicalEpoch: 'History (read-only)',
    cappedEpochs: (count) => `Showing the newest ${count} runs`,
    noOperators: 'Waiting for the main agent to create an operator…',
    hiddenOperators: (count) => `${count} more operator${count === 1 ? '' : 's'}`,
    progress: (settled, total, hasOmitted) =>
      hasOmitted ? `${settled}/${total} visible settled` : `${settled}/${total} settled`,
    status: (status) =>
      ({
        empty: 'Awaiting schedule',
        active: 'Running',
        closing: 'Finishing',
        waiting: 'Waiting',
        stopped: 'Stopped',
        failed: 'Failed',
        completed: 'Completed',
      })[status],
    operatorStatus: (status) =>
      ({
        not_started: 'Not started',
        waiting: 'Waiting',
        runnable: 'Runnable',
        running: 'Running',
        blocked: 'Blocked',
        completed: 'Completed',
        failed: 'Failed',
        aborted: 'Aborted',
        cancelled: 'Cancelled',
      })[status],
    wait: waitReasonEn,
  },
} satisfies UiCatalog<AgentGraphPanelCopy>;

export function getAgentGraphPanelCopy(locale: UiLocale): AgentGraphPanelCopy {
  return AGENT_GRAPH_PANEL_COPY[locale];
}

function firstWait(operator: AgentGraphClientOperator) {
  return operator.readiness.find((readiness) => readiness.status === 'waiting')?.waitingFor[0];
}

function waitReasonEn(operator: AgentGraphClientOperator): string | undefined {
  const wait = firstWait(operator);
  if (!wait) return undefined;
  if (wait.kind === 'input_route') {
    return `Waiting for input from ${wait.upstreamOperatorIds.join(', ')}`;
  }
  if (wait.kind === 'activation_missing') {
    return `Waiting for ${wait.operatorId} activation`;
  }
  return `Waiting for ${wait.operatorId} to settle`;
}

function waitReasonZh(operator: AgentGraphClientOperator): string | undefined {
  const wait = firstWait(operator);
  if (!wait) return undefined;
  if (wait.kind === 'input_route') {
    return `等待 ${wait.upstreamOperatorIds.join('、')} 的输入`;
  }
  if (wait.kind === 'activation_missing') {
    return `等待 ${wait.operatorId} activation`;
  }
  return `等待 ${wait.operatorId} 结束`;
}

function waitReasonZhTw(operator: AgentGraphClientOperator): string | undefined {
  const wait = firstWait(operator);
  if (!wait) return undefined;
  if (wait.kind === 'input_route') {
    return `等待 ${wait.upstreamOperatorIds.join('、')} 的輸入`;
  }
  if (wait.kind === 'activation_missing') {
    return `等待 ${wait.operatorId} 啟用`;
  }
  return `等待 ${wait.operatorId} 結束`;
}
