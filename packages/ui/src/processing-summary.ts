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

import type { ToolActivityKind } from '@maka/core/events';
import { isInFlightToolStatus } from '@maka/core/tool-result-status';
import type { UiLocale } from '@maka/core/ui-locale';
import type { ToolActivityItem } from './materialize.js';
import type { FoldedTimelineChild } from './timeline-fold.js';
import { redactSecrets } from './redact.js';
import { formatUserVisibleToolText } from './tool-activity/preview-utils.js';

const PROCESSING_SUMMARY_COPY = {
  zh: {
    kind: {
      computer: (count: number) => `操作电脑 ${count} 次`,
      read: (count: number) => `读取 ${count} 个文件`,
      search: (count: number) => `搜索 ${count} 次`,
      websearch: (count: number) => `联网搜索 ${count} 次`,
      webfetch: (count: number) => `抓取 ${count} 个网页`,
      edit: (count: number) => `编辑 ${count} 个文件`,
      command: (count: number) => `运行 ${count} 条命令`,
      explore: (count: number) => `探索 ${count} 次`,
      browser: (count: number) => `浏览器操作 ${count} 次`,
      tool: (count: number) => `调用 ${count} 个工具`,
    },
    join: (parts: readonly string[]) => parts.join('，'),
    failed: (count: number) => `${count} 个失败`,
    interrupted: (count: number) => `${count} 个中断`,
    thinking: '正在深度思考',
    running: (activity: string) => `正在${activity}`,
    runningKind: {
      computer: '正在操作电脑',
      read: '正在读取文件',
      search: '正在搜索',
      websearch: '正在联网搜索',
      webfetch: '正在抓取网页',
      edit: '正在编辑文件',
      command: '正在运行命令',
      explore: '正在探索',
      browser: '正在操作浏览器',
      tool: '正在调用工具',
    },
    fallback: '工作记录',
  },
  en: {
    kind: {
      computer: (count: number) => `${count} computer ${count === 1 ? 'action' : 'actions'}`,
      read: (count: number) => `Read ${count} ${count === 1 ? 'file' : 'files'}`,
      search: (count: number) => `Searched ${count} ${count === 1 ? 'time' : 'times'}`,
      websearch: (count: number) => `Ran ${count} web ${count === 1 ? 'search' : 'searches'}`,
      webfetch: (count: number) => `Fetched ${count} web ${count === 1 ? 'page' : 'pages'}`,
      edit: (count: number) => `Edited ${count} ${count === 1 ? 'file' : 'files'}`,
      command: (count: number) => `Ran ${count} ${count === 1 ? 'command' : 'commands'}`,
      explore: (count: number) => `Explored ${count} ${count === 1 ? 'time' : 'times'}`,
      browser: (count: number) => `Performed ${count} browser ${count === 1 ? 'action' : 'actions'}`,
      tool: (count: number) => `Called ${count} ${count === 1 ? 'tool' : 'tools'}`,
    },
    join: (parts: readonly string[]) => parts.join(', '),
    failed: (count: number) => `${count} failed`,
    interrupted: (count: number) => `${count} interrupted`,
    thinking: 'Thinking',
    running: (activity: string) => `Working: ${activity}`,
    runningKind: {
      computer: 'Using the computer',
      read: 'Reading a file',
      search: 'Searching',
      websearch: 'Searching the web',
      webfetch: 'Fetching a web page',
      edit: 'Editing a file',
      command: 'Running a command',
      explore: 'Exploring',
      browser: 'Using the browser',
      tool: 'Calling a tool',
    },
    fallback: 'Work log',
  },
} satisfies Record<UiLocale, {
  kind: Record<ToolActivityKind, (count: number) => string>;
  join(parts: readonly string[]): string;
  failed(count: number): string;
  interrupted(count: number): string;
  thinking: string;
  running(activity: string): string;
  runningKind: Record<ToolActivityKind, string>;
  fallback: string;
}>;

export function processingTools(
  entries: readonly FoldedTimelineChild[],
): ToolActivityItem[] {
  return entries.flatMap((entry) => entry.kind === 'tools' ? entry.items : []);
}

export function isProcessingRunning(entries: readonly FoldedTimelineChild[]): boolean {
  return entries.some((entry) =>
    entry.kind === 'thinking'
      ? entry.live === true
      : entry.items.some((item) => isInFlightToolStatus(item.status)),
  );
}

export function processingHasError(entries: readonly FoldedTimelineChild[]): boolean {
  return processingTools(entries).some((item) => item.status === 'errored');
}

export function summarizeProcessing(
  entries: readonly FoldedTimelineChild[],
  locale: UiLocale,
): string {
  const copy = PROCESSING_SUMMARY_COPY[locale];
  if (isProcessingRunning(entries)) {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index]!;
      if (entry.kind === 'thinking') {
        if (entry.live === true) return copy.thinking;
        continue;
      }
      const active = [...entry.items]
        .reverse()
        .find((item) => isInFlightToolStatus(item.status));
      if (!active) continue;
      const intent = redactSecrets(formatUserVisibleToolText(active.intent ?? '', locale));
      return intent ? copy.running(intent) : copy.runningKind[activityKindForTool(active)];
    }
  }

  const tools = processingTools(entries);
  const order: ToolActivityKind[] = [];
  const counts = new Map<ToolActivityKind, number>();
  let failed = 0;
  let interrupted = 0;
  for (const tool of tools) {
    const kind = activityKindForTool(tool);
    if (!counts.has(kind)) order.push(kind);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
    if (tool.status === 'errored') failed += 1;
    if (tool.status === 'interrupted') interrupted += 1;
  }
  const parts = order.map((kind) => copy.kind[kind](counts.get(kind) ?? 0));
  if (failed > 0) parts.push(copy.failed(failed));
  if (interrupted > 0) parts.push(copy.interrupted(interrupted));
  return parts.length > 0 ? copy.join(parts) : copy.fallback;
}

function activityKindForTool(item: ToolActivityItem): ToolActivityKind {
  if (item.activityKind) return item.activityKind;
  const name = item.toolName.toLowerCase();
  if (name.startsWith('browser_')) return 'browser';
  switch (name) {
    case 'read':
    case 'list':
      return 'read';
    case 'glob':
    case 'grep':
      return 'search';
    case 'websearch':
    case 'web_search':
      return 'websearch';
    case 'webfetch':
    case 'web_fetch':
      return 'webfetch';
    case 'write':
    case 'edit':
    case 'multiedit':
    case 'apply_patch':
      return 'edit';
    case 'bash':
    case 'shell':
    case 'stopbackgroundtask':
    case 'stop_background_task':
      return 'command';
    case 'exploreagent':
    case 'explore_agent':
      return 'explore';
    default:
      return 'tool';
  }
}
