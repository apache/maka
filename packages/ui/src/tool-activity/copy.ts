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

type BackgroundTerminalStatus = 'running' | 'completed' | 'failed' | 'timed_out' | 'cancelled' | 'orphaned';
type WebCredentialCopyKey = 'env' | 'settings' | 'missing' | 'unknown';
type WebGuidanceKey = 'env' | 'settings' | 'rate_limited' | 'not_configured' | 'timed_out' | 'privacy_mode' | 'unknown';

export interface ToolActivityCopy {
  errorLabel: string;
  /** The two outcomes a tool row spells out next to its name. */
  status: {
    sandboxBlocked: string;
    interrupted: string;
  };
  output: {
    redacted: string;
    truncated: string;
  };
  copy: {
    idle: string;
    pending: string;
    copied: string;
    failed: string;
    actionAriaLabel: (action: string, identity: string) => string;
  };
  sandboxBlocked: {
    title: string;
    description: string;
    copyAriaLabel: (label: string) => string;
  };
  requiresBypass: {
    title: string;
    description: string;
    action: string;
    pending: string;
  };
  /**
   * Row labels for one Computer Use call, derived from its arguments (see
   * `computer-action-label.ts`). The tool's display name is a noun, so every
   * call rendered the same row; these are verb phrases that say what the call
   * did.
   *
   * Each entry uses exactly what the persisted projection carries — the action,
   * the app, the window id, the element id — and nothing more. There is no
   * entry that spells out a typed value, a key name or a coordinate, because
   * the privacy boundary keeps those out of anything a renderer can read, so
   * such an entry could only ever be exercised by a fixture.
   */
  computer: {
    fallback: string;
    listApps: string;
    launchApp: (app: string) => string;
    launchAppUnknown: string;
    observe: string;
    observeApp: (app: string) => string;
    observeWindow: (windowId: number) => string;
    observeMenu: (menu: string) => string;
    screenshot: string;
    screenshotApp: (app: string) => string;
    screenshotWindow: (windowId: number) => string;
    element: (elementId: string) => string;
    elementUnknown: string;
    clickElement: (element: string) => string;
    setValue: (element: string) => string;
    selectText: (element: string) => string;
    secondaryAction: (element: string) => string;
    scrollElement: (element: string) => string;
    elementSequence: (count: number) => string;
    elementSequenceUnknown: string;
    windowAction: string;
    windowMove: string;
    windowResize: string;
    windowMinimize: string;
    targetApp: (app: string) => string;
    targetWindow: (windowId: number) => string;
    runningAction: (action: string, target?: string) => string;
    runningSequence: (current: number, total: number, target?: string) => string;
    scroll: string;
    pressKey: string;
    type: string;
    holdKey: string;
    wait: string;
    zoom: string;
    cursorPosition: string;
    pointer: Record<
      'move' | 'left' | 'right' | 'middle' | 'double' | 'triple' | 'down' | 'up' | 'drag',
      string
    >;
  };
  loadTools: {
    displayName: string;
    genericAction: string;
    genericTitle: string;
    genericDescription: string;
    count: (count: number) => string;
    technicalDetails: string;
    groupId: string;
    toolIds: string;
    groups: Record<
      'browser' | 'computer_use' | 'mcp' | 'rive' | 'agent' | 'settings',
      {
        label: string;
        action: string;
        title: string;
        description: string;
      }
    >;
  };
  permissionDenied: string;
  result: {
    hiddenLines: (count: number) => string;
    ptyFailed: string;
    queued: string;
    notQueued: string;
    queuedPreview: (action: string, preview: string, bytes?: number) => string;
    byteCount: (action: string, bytes: number) => string;
    resizeNotApplied: (size: string) => string;
    resized: (size: string) => string;
    sizeUnchanged: (size: string) => string;
    ptyCompleted: string;
    terminalUnavailable: string;
    noTerminalFrame: string;
    noOutputYet: string;
    noOutput: string;
    exitCode: (code: number) => string;
    managedBySource: string;
    sourceUnavailable: string;
    running: string;
    success: string;
    failed: string;
    timedOut: string;
    cancelled: string;
    disconnected: string;
    terminalTruncated: string;
    terminalRedacted: string;
    streamHidden: (stream: 'stdout' | 'stderr', count: number) => string;
    streamsTruncated: (limit: number) => string;
    outputTruncated: string;
    outputRedacted: string;
    backgroundStatus: Record<BackgroundTerminalStatus, string>;
    backgroundUnknown: (status: string) => string;
    workflow: { action: string; status: string; error: string; nodes: string; diagnostics: string };
    workflowCompleted: string;
    workflowFailed: string;
    fileWritten: (bytes: number, path: string) => string;
    webNoResults: string;
    webResults: (count: number) => string;
    credentialSource: Record<WebCredentialCopyKey, string>;
    webFailure: string;
    webSearch: string;
    webGuidance: Record<WebGuidanceKey, string>;
  };
  agent: {
    subagentStatus: Record<
      'completed' | 'failed' | 'cancelled' | 'running' | 'waiting_for_user',
      string
    >;
    readOnly: string;
  };
}

const TOOL_ACTIVITY_COPY = {
  zh: {
    errorLabel: '错误',
    status: { sandboxBlocked: '可能被沙箱阻止', interrupted: '已中断' },
    output: { redacted: '[已脱敏]', truncated: '输出已截断' },
    copy: {
      idle: '复制',
      pending: '复制中…',
      copied: '已复制',
      failed: '复制失败',
      actionAriaLabel: (action, identity) => `${action}：${identity}`,
    },
    sandboxBlocked: { title: '操作可能被沙箱阻止', description: '沙箱可能阻止了该调用中的至少一项操作。失败前可能已经产生部分结果，请检查输出和工作区状态后再决定是否重试。', copyAriaLabel: (label) => `${label}沙箱诊断信息` },
    requiresBypass: {
      title: '需要“绕过”模式',
      description: '此操作会直接控制本机应用，无法在沙箱模式下执行。',
      action: '切换并重试',
      pending: '正在切换…',
    },
    computer: {
      fallback: '操作电脑',
      listApps: '列出打开的应用',
      launchApp: (app) => `打开「${app}」`,
      launchAppUnknown: '打开应用',
      observe: '观察当前窗口',
      observeApp: (app) => `观察「${app}」窗口`,
      observeWindow: (windowId) => `观察窗口 ${windowId}`,
      observeMenu: (menu) => `查看「${menu}」菜单`,
      screenshot: '截图当前窗口',
      screenshotApp: (app) => `截图「${app}」窗口`,
      screenshotWindow: (windowId) => `截图窗口 ${windowId}`,
      element: (elementId) => `元素 ${elementId}`,
      elementUnknown: '该元素',
      clickElement: (element) => `点击${element}`,
      // The element phrase ends every clause it appears in: it is "元素 e12",
      // and Chinese typography wants a space around the latin id, which a
      // trailing 「的值」/「执行」 would either eat or leave dangling.
      setValue: (element) => `设置值：${element}`,
      selectText: (element) => `选择文本：${element}`,
      secondaryAction: (element) => `次要操作：${element}`,
      scrollElement: (element) => `滚动${element}`,
      elementSequence: (count) => `连续操作 ${count} 个控件`,
      elementSequenceUnknown: '连续操作多个控件',
      windowAction: '操作窗口',
      windowMove: '移动窗口',
      windowResize: '调整窗口大小',
      windowMinimize: '最小化窗口',
      targetApp: (app) => `「${app}」窗口`,
      targetWindow: (windowId) => `窗口 ${windowId}`,
      runningAction: (action, target) => target ? `正在${action} · ${target}` : `正在${action}`,
      runningSequence: (current, total, target) =>
        target
          ? `正在操作${target} · 连续操作第 ${current}/${total} 步`
          : `正在连续操作第 ${current}/${total} 步`,
      scroll: '滚动',
      pressKey: '按下按键',
      type: '输入文本',
      holdKey: '按住按键',
      wait: '等待',
      zoom: '放大查看区域',
      cursorPosition: '读取指针位置',
      pointer: {
        move: '移动指针',
        left: '点击',
        right: '右键点击',
        middle: '中键点击',
        double: '双击',
        triple: '三击',
        down: '按下鼠标',
        up: '松开鼠标',
        drag: '拖动',
      },
    },
    loadTools: {
      displayName: '启用能力',
      genericAction: '启用工具能力',
      genericTitle: '工具能力已启用',
      genericDescription: '现在可以使用这组工具。',
      count: (n) => `${n} 项能力可用`,
      technicalDetails: '技术详情',
      groupId: '工具组',
      toolIds: '工具',
      groups: {
        browser: { label: 'Browser', action: '启用浏览器操作', title: '浏览器操作已启用', description: '可以打开页面、读取内容并与网页交互。' },
        computer_use: { label: 'Computer Use', action: '启用桌面操作', title: '桌面操作已启用', description: '可以查看和操作已授权的本地应用。' },
        mcp: { label: 'MCP', action: '连接 MCP', title: 'MCP 工具已连接', description: '可以调用当前客户端连接的 MCP 服务。' },
        rive: { label: 'Rive', action: '启用 Rive 工作流', title: 'Rive 工作流已启用', description: '可以运行可恢复的多智能体工作流。' },
        agent: { label: 'Agent', action: '启用子智能体', title: '子智能体协作已启用', description: '可以并行分派、跟踪和汇总子任务。' },
        settings: { label: '设置', action: '启用设置工具', title: '设置工具已启用', description: '可以读取或更新当前客户端设置。' },
      },
    },
    permissionDenied: '用户已拒绝权限请求',
    result: {
      hiddenLines: (n) => `… 已隐藏 ${n} 行`, ptyFailed: '后台终端交互失败', queued: '已输入', notQueued: '未输入', queuedPreview: (action, preview, bytes) => bytes === undefined ? `${action}：${preview}` : `${action}：${preview}… · 共 ${bytes} 字节`, byteCount: (action, bytes) => `${action} ${bytes} 字节`, resizeNotApplied: (size) => `未调整为 ${size}`, resized: (size) => `已调整为 ${size}`, sizeUnchanged: (size) => `尺寸已是 ${size}`, ptyCompleted: '后台终端交互已完成', terminalUnavailable: '终端输出不可用', noTerminalFrame: '（无可用终端画面）', noOutputYet: '（尚无输出）', noOutput: '（无输出）', exitCode: (code) => `退出码 ${code}`, managedBySource: '由源任务管理', sourceUnavailable: '源任务不可用', running: '运行中', success: '成功', failed: '失败', timedOut: '已超时', cancelled: '已取消', disconnected: '已断开', terminalTruncated: '终端输出已截断', terminalRedacted: '终端输出已脱敏', streamHidden: (stream, n) => `… ${stream} 已隐藏 ${n} 行`, streamsTruncated: (limit) => `输出已截断 · 每路仅展示前 ${limit} 行`, outputTruncated: '输出已截断', outputRedacted: '输出已脱敏',
      backgroundStatus: { running: '后台运行中', completed: '后台已完成', failed: '后台失败', timed_out: '后台超时', cancelled: '后台已取消', orphaned: '后台任务已断开' }, backgroundUnknown: (status) => `后台 · ${status}`,
      workflow: { action: '动作', status: '状态', error: '错误', nodes: '节点摘要', diagnostics: '诊断片段' }, webNoResults: '没有结果', webResults: (n) => `${n} 条结果`, credentialSource: { env: '环境变量', settings: '本机已保存 key', missing: '未配置', unknown: '来源未知' }, webFailure: '搜索失败', webSearch: '联网搜索', webGuidance: { env: '请检查 TAVILY_API_KEY / MAKA_TAVILY_API_KEY 后重启。', settings: '请在 设置 · 联网搜索 中更新 Tavily key。', rate_limited: 'Tavily 当前限流，请稍后重试或更换可用凭据。', not_configured: '请先完成联网搜索配置后再重试。', timed_out: '请求超时，请稍后重试。', privacy_mode: '隐私模式下不会发起联网搜索。', unknown: '请检查网络或稍后重试。' },
      workflowCompleted: 'Rive 工作流已完成',
      workflowFailed: 'Rive 工作流执行失败',
      fileWritten: (bytes, path) => `已向 ${path} 写入 ${bytes} 字节`,
    },
    agent: {
      subagentStatus: { completed: '已完成', failed: '失败', cancelled: '已取消', running: '运行中', waiting_for_user: '等待用户输入' },
      readOnly: '只读',
    },
  },
  en: {
    errorLabel: 'Error',
    status: { sandboxBlocked: 'Possibly blocked by sandbox', interrupted: 'Interrupted' },
    output: { redacted: '[Redacted]', truncated: 'Output truncated' },
    copy: {
      idle: 'Copy',
      pending: 'Copying…',
      copied: 'Copied',
      failed: 'Copy failed',
      actionAriaLabel: (action, identity) => `${action}: ${identity}`,
    },
    sandboxBlocked: { title: 'Operation may have been blocked by sandbox', description: 'The sandbox may have blocked at least one action in this call. Some effects may have occurred before it failed; check the output and workspace state before retrying.', copyAriaLabel: (label) => `${label} sandbox diagnostics` },
    requiresBypass: {
      title: 'Bypass mode required',
      description: 'This action controls a local app directly and cannot run inside the sandbox.',
      action: 'Switch and retry',
      pending: 'Switching…',
    },
    computer: {
      fallback: 'Use the computer',
      listApps: 'List open apps',
      launchApp: (app) => `Open “${app}”`,
      launchAppUnknown: 'Open an app',
      observe: 'Observe the current window',
      observeApp: (app) => `Observe the “${app}” window`,
      observeWindow: (windowId) => `Observe window ${windowId}`,
      observeMenu: (menu) => `Inspect the “${menu}” menu`,
      screenshot: 'Screenshot the current window',
      screenshotApp: (app) => `Screenshot the “${app}” window`,
      screenshotWindow: (windowId) => `Screenshot window ${windowId}`,
      element: (elementId) => `element ${elementId}`,
      elementUnknown: 'the element',
      clickElement: (element) => `Click ${element}`,
      setValue: (element) => `Set the value of ${element}`,
      selectText: (element) => `Select text in ${element}`,
      secondaryAction: (element) => `Run a secondary action on ${element}`,
      scrollElement: (element) => `Scroll ${element}`,
      elementSequence: (count) => `Operate ${count} controls`,
      elementSequenceUnknown: 'Operate multiple controls',
      windowAction: 'Operate the window',
      windowMove: 'Move the window',
      windowResize: 'Resize the window',
      windowMinimize: 'Minimize the window',
      targetApp: (app) => `“${app}” window`,
      targetWindow: (windowId) => `Window ${windowId}`,
      runningAction: (action, target) => target ? `${action} · ${target}` : action,
      runningSequence: (current, total, target) =>
        target
          ? `Operating ${target} · step ${current}/${total}`
          : `Operating controls · step ${current}/${total}`,
      scroll: 'Scroll',
      pressKey: 'Press a key',
      type: 'Type text',
      holdKey: 'Hold a key',
      wait: 'Wait',
      zoom: 'Zoom into a region',
      cursorPosition: 'Read the pointer position',
      pointer: {
        move: 'Move the pointer',
        left: 'Click',
        right: 'Right-click',
        middle: 'Middle-click',
        double: 'Double-click',
        triple: 'Triple-click',
        down: 'Press the mouse',
        up: 'Release the mouse',
        drag: 'Drag',
      },
    },
    loadTools: {
      displayName: 'Enable capabilities',
      genericAction: 'Enable tool capabilities',
      genericTitle: 'Tool capabilities enabled',
      genericDescription: 'This tool group is ready to use.',
      count: (n) => `${n} ${n === 1 ? 'capability' : 'capabilities'} available`,
      technicalDetails: 'Technical details',
      groupId: 'Group',
      toolIds: 'Tools',
      groups: {
        browser: { label: 'Browser', action: 'Enable browser actions', title: 'Browser actions enabled', description: 'Open pages, read content, and interact with websites.' },
        computer_use: { label: 'Computer Use', action: 'Enable desktop actions', title: 'Desktop actions enabled', description: 'View and operate authorized local applications.' },
        mcp: { label: 'MCP', action: 'Connect MCP', title: 'MCP tools connected', description: 'Use MCP services connected by the current client.' },
        rive: { label: 'Rive', action: 'Enable Rive workflows', title: 'Rive workflows enabled', description: 'Run durable multi-agent workflows.' },
        agent: { label: 'Agent', action: 'Enable subagents', title: 'Subagent collaboration enabled', description: 'Delegate, track, and summarize tasks in parallel.' },
        settings: { label: 'Settings', action: 'Enable settings tools', title: 'Settings tools enabled', description: 'Read or update settings owned by the current client.' },
      },
    },
    permissionDenied: 'User denied the permission request',
    result: {
      hiddenLines: (n) => `… ${n} ${n === 1 ? 'line' : 'lines'} hidden`, ptyFailed: 'Background terminal interaction failed', queued: 'Entered', notQueued: 'Not entered', queuedPreview: (action, preview, bytes) => bytes === undefined ? `${action}: ${preview}` : `${action}: ${preview}… · ${bytes} bytes total`, byteCount: (action, bytes) => `${action} ${bytes} bytes`, resizeNotApplied: (size) => `Not resized to ${size}`, resized: (size) => `Resized to ${size}`, sizeUnchanged: (size) => `Size already ${size}`, ptyCompleted: 'Background terminal interaction completed', terminalUnavailable: 'Terminal output unavailable', noTerminalFrame: '(No terminal frame available)', noOutputYet: '(No output yet)', noOutput: '(No output)', exitCode: (code) => `exit code ${code}`, managedBySource: 'Managed by the source task', sourceUnavailable: 'Source task unavailable', running: 'Running', success: 'Succeeded', failed: 'Failed', timedOut: 'Timed out', cancelled: 'Cancelled', disconnected: 'Disconnected', terminalTruncated: 'Terminal output truncated', terminalRedacted: 'Terminal output redacted', streamHidden: (stream, n) => `… ${n} ${stream} ${n === 1 ? 'line' : 'lines'} hidden`, streamsTruncated: (limit) => `Output truncated · showing the first ${limit} lines of each stream`, outputTruncated: 'Output truncated', outputRedacted: 'Output redacted',
      backgroundStatus: { running: 'Running in background', completed: 'Background task completed', failed: 'Background task failed', timed_out: 'Background task timed out', cancelled: 'Background task cancelled', orphaned: 'Background task disconnected' }, backgroundUnknown: (status) => `Background · ${status}`,
      workflow: { action: 'Action', status: 'Status', error: 'Error', nodes: 'Node summary', diagnostics: 'Diagnostic excerpts' }, webNoResults: 'No results', webResults: (n) => `${n} ${n === 1 ? 'result' : 'results'}`, credentialSource: { env: 'Environment variable', settings: 'Locally saved key', missing: 'Not configured', unknown: 'Unknown source' }, webFailure: 'Search failed', webSearch: 'Web search', webGuidance: { env: 'Check TAVILY_API_KEY / MAKA_TAVILY_API_KEY and restart.', settings: 'Update the Tavily key in Settings · Web search.', rate_limited: 'Tavily is rate-limiting requests. Try again later or use another credential.', not_configured: 'Configure web search before retrying.', timed_out: 'The request timed out. Try again later.', privacy_mode: 'Web search is disabled in privacy mode.', unknown: 'Check the network connection or try again later.' },
      workflowCompleted: 'Rive workflow completed',
      workflowFailed: 'Rive workflow failed',
      fileWritten: (bytes, path) => `Wrote ${bytes} bytes to ${path}`,
    },
    agent: {
      subagentStatus: { completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled', running: 'Running', waiting_for_user: 'Waiting for user input' },
      readOnly: 'Read only',
    },
  },
} satisfies UiCatalog<ToolActivityCopy>;

export function getToolActivityCopy(locale: UiLocale): ToolActivityCopy {
  return TOOL_ACTIVITY_COPY[locale];
}
