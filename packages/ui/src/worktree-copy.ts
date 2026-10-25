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
const en = {
  chooseTitle: 'Select worktree',
  overview: 'Give each task its own checkout and initialization steps.',
  loading: 'Loading worktrees…', loadingHelp: 'Discovering projects and checkouts on this Host.',
  projectSettings: 'Project configuration', projectSettingsHelp: 'Lifecycle hooks for worktree creation and cleanup',
  menu: { create: 'New worktree', existing: 'Existing worktrees', search: 'Search worktrees', clearSearch: 'Clear search', noMatches: 'No matching worktrees', choose: (label: string) => `Working directory: ${label}` },
  worktrees: 'Worktrees', noWorktrees: 'No worktrees yet',
  location: 'Location & defaults', scripts: 'Lifecycle scripts',
  setupHelp: 'Runs after checkout, before the first message is sent. Use it to copy local configuration or install dependencies.',
  cleanupHelp: 'Runs before the directory is removed. A failed script lets you keep the directory or continue deleting.',
  scriptPlaceholder: '# Optional shell commands', environment: 'Script environment variables',
  inheritedRoot: 'Leave empty to use the Host default',
  preparation: { preparing: 'Preparing worktree', checkout: 'Preparing worktree', initializing: 'Running setup script', finalizing: 'Opening task' },
  withoutWorktree: 'Do not use a worktree',
  preparationHelp: 'Your message is saved. The task starts automatically when the worktree is ready.',
  elapsed: (seconds: number) => seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`,
  saving: 'Saving settings…', initializing: 'Running setup script…', removing: 'Cleaning up worktree…',
  operationHelp: 'You can keep using Maka while this operation finishes.',

  fixedUnavailable: 'This conversation’s worktree is unavailable. Messages cannot be sent right now.',
  forkWorkspace: 'Working directory',
  recoveryHelp: 'Your original message is saved. Open Worktree settings to retry or skip initialization. If it is already complete, choose Continue sending.', settings: 'Open Worktree settings',
  main: 'Main worktree', newWorktree: 'New worktree', unavailable: 'Unavailable', detached: 'Detached HEAD', external: 'External', managed: 'Maka',
  refresh: 'Refresh', save: 'Save', saved: 'Worktree settings saved', root: 'Default worktree root', projectRoot: 'Project worktree root (optional)',
  rootHelp: 'An absolute path on this Host. Existing worktrees stay where they are.', defaults: 'New task default',
  setup: 'Creation script', cleanup: 'Cleanup script', scriptHelp: 'Runs in the worktree directory, using this Host’s shell and environment.',
  empty: 'No Git projects with commits on this Host', error: 'Unable to load worktrees', operationFailed: 'Worktree operation failed',
  retry: 'Retry initialization', skip: 'Continue without initialization', skipped: 'Initialization skipped. The task can continue.', openTask: 'Open task', terminal: 'Open terminal',
  remove: 'Clean up', removeTitle: 'Clean up this worktree?', removeHelp: 'The directory will be removed. Branches and conversation history will be retained.',
  scriptFailed: 'Cleanup script failed', deleteAnyway: 'Continue deleting', keep: 'Keep directory', log: 'Script output',
  initialization: { pending: 'Waiting for initialization', running: 'Initializing', ready: 'Ready', failed: 'Initialization failed', skipped: 'Initialization skipped' },
  tasks: 'tasks', branchTitle: 'Fork conversation', same: 'Current worktree', branchHelp: 'Conversation history ends at the selected message. A new worktree uses the source’s current HEAD and excludes uncommitted changes.',
  createHelp: 'AI names the worktree and branch when you submit. Uncommitted changes are not copied.', cancel: 'Cancel', confirmBranch: 'Fork',
};
type Copy = typeof en;
const zh: Copy = {
  chooseTitle: '选择工作树',
  overview: '为每个任务准备独立目录，并自动完成环境初始化。',
  loading: '正在加载 worktree…', loadingHelp: '正在查找此 Host 上的项目和工作目录。',
  projectSettings: '项目配置', projectSettingsHelp: 'Worktree 创建与清理时执行的生命周期钩子',
  menu: { create: '新建工作树', existing: '已有工作树', search: '搜索工作树', clearSearch: '清除搜索', noMatches: '没有匹配的工作树', choose: (label: string) => `工作目录：${label}` },
  worktrees: '已有 worktree', noWorktrees: '暂无 worktree',
  location: '位置与默认行为', scripts: '生命周期脚本',
  setupHelp: '检出文件后、发送首条消息前执行。可用于复制本地配置或安装依赖。',
  cleanupHelp: '删除目录前执行。脚本失败时，可以保留目录或继续删除。',
  scriptPlaceholder: '# 可选的 shell 命令', environment: '脚本环境变量',
  inheritedRoot: '留空使用 Host 默认目录',
  preparation: { preparing: '正在准备 worktree', checkout: '正在准备 worktree', initializing: '正在运行初始化脚本', finalizing: '正在打开任务' },
  withoutWorktree: '不使用工作树',
  preparationHelp: '消息已保存，worktree 就绪后将自动开始任务。',
  elapsed: (seconds: number) => seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`,
  saving: '正在保存设置…', initializing: '正在运行初始化脚本…', removing: '正在清理 worktree…',
  operationHelp: '操作完成前，你可以继续使用 Maka。',

  fixedUnavailable: '此会话的工作树已不可用，暂时无法发送消息。',
  forkWorkspace: '工作目录',
  recoveryHelp: '原消息已保存。请在 Worktree 设置中重试或跳过初始化；若已完成，可点击「继续发送」。', settings: '打开 Worktree 设置',
  main: '主工作树', newWorktree: '新建 worktree', unavailable: '不可用', detached: '游离 HEAD', external: '外部创建', managed: 'Maka 创建',
  refresh: '刷新', save: '保存', saved: 'Worktree 设置已保存', root: '默认 worktree 根目录', projectRoot: '项目 worktree 根目录（可选）',
  rootHelp: '填写此 Host 上的绝对路径；已有 worktree 不会移动。', defaults: '新任务默认位置',
  setup: '创建时脚本', cleanup: '清理时脚本', scriptHelp: '在 worktree 目录中，使用此 Host 的 shell 和环境执行。',
  empty: '此 Host 暂无已有提交的 Git 项目', error: '无法加载 worktree', operationFailed: 'Worktree 操作失败',
  retry: '重试初始化', skip: '跳过初始化并继续任务', skipped: '已跳过初始化，可以继续任务。', openTask: '打开任务', terminal: '打开终端',
  remove: '清理', removeTitle: '清理此 worktree？', removeHelp: '将删除目录，保留分支和会话历史。',
  scriptFailed: '清理脚本执行失败', deleteAnyway: '继续删除', keep: '保留目录', log: '脚本输出',
  initialization: { pending: '等待初始化', running: '初始化中', ready: '就绪', failed: '初始化失败', skipped: '已跳过初始化' },
  tasks: '个任务', branchTitle: '分叉会话', same: '当前 worktree', branchHelp: '对话截取到所选消息；新 worktree 使用源目录当前 HEAD，不携带未提交改动。',
  createHelp: '发送任务时由 AI 生成目录名和分支名，不携带未提交改动。', cancel: '取消', confirmBranch: '确认分叉',
};
const tw: Copy = {
  ...zh,
  chooseTitle: '選擇工作樹',
  menu: { create: '新增工作樹', existing: '現有工作樹', search: '搜尋工作樹', clearSearch: '清除搜尋', noMatches: '沒有符合的工作樹', choose: (label: string) => `工作目錄：${label}` },
  overview: '為每個任務準備獨立目錄，並自動完成環境初始化。',
  loading: '正在載入 worktree…', loadingHelp: '正在尋找此 Host 上的專案與工作目錄。',
  projectSettings: '專案設定', projectSettingsHelp: 'Worktree 建立與清理時執行的生命週期鉤子',
  worktrees: '現有 worktree', noWorktrees: '尚無 worktree',
  location: '位置與預設行為', scripts: '生命週期指令碼',
  setupHelp: '簽出檔案後、傳送首則訊息前執行。可用於複製本機設定或安裝相依套件。',
  cleanupHelp: '刪除目錄前執行。指令碼失敗時，可以保留目錄或繼續刪除。',
  scriptPlaceholder: '# 選填的 shell 命令', environment: '指令碼環境變數', inheritedRoot: '留空使用 Host 預設目錄',
  preparation: { preparing: '正在準備 worktree', checkout: '正在準備 worktree', initializing: '正在執行初始化指令碼', finalizing: '正在開啟任務' },
  withoutWorktree: '不使用工作樹',
  preparationHelp: '訊息已儲存，worktree 就緒後將自動開始任務。',
  elapsed: (seconds: number) => seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`,
  saving: '正在儲存設定…', initializing: '正在執行初始化指令碼…', removing: '正在清理 worktree…',
  operationHelp: '操作完成前，你可以繼續使用 Maka。',
  fixedUnavailable: '此對話的工作樹已無法使用，目前無法傳送訊息。', forkWorkspace: '工作目錄', recoveryHelp: '原訊息已儲存。請在 Worktree 設定中重試或略過初始化；若已完成，可點擊「繼續傳送」。', settings: '開啟 Worktree 設定', main: '主工作樹', unavailable: '無法使用', external: '外部建立', managed: 'Maka 建立', refresh: '重新整理', save: '儲存', saved: 'Worktree 設定已儲存',
  root: '預設 worktree 根目錄', projectRoot: '專案 worktree 根目錄（選填）', rootHelp: '填入此 Host 上的絕對路徑；現有 worktree 不會移動。', defaults: '新任務預設位置',
  setup: '建立時指令碼', cleanup: '清理時指令碼', scriptHelp: '在 worktree 目錄中，使用此 Host 的 shell 與環境執行。', empty: '此 Host 尚無已有提交的 Git 專案',
  error: '無法載入 worktree', operationFailed: 'Worktree 操作失敗', retry: '重試初始化', skip: '略過初始化並繼續任務', skipped: '已略過初始化，可以繼續任務。',
  openTask: '開啟任務', terminal: '開啟終端機', removeTitle: '清理此 worktree？', removeHelp: '將刪除目錄，保留分支與對話歷史。', scriptFailed: '清理指令碼執行失敗',
  deleteAnyway: '繼續刪除', keep: '保留目錄', log: '指令碼輸出', tasks: '個任務', branchTitle: '分叉對話', same: '目前 worktree',
  branchHelp: '對話截取到所選訊息；新 worktree 使用來源目錄目前 HEAD，不攜帶未提交變更。', createHelp: '傳送任務時由 AI 產生目錄名稱與分支名稱，不攜帶未提交變更。',
  initialization: { pending: '等待初始化', running: '初始化中', ready: '就緒', failed: '初始化失敗', skipped: '已略過初始化' }, confirmBranch: '確認分叉',
};
export function getWorktreeCopy(locale: UiLocale): Copy { return locale === 'en' ? en : locale === 'zh-TW' ? tw : zh; }
