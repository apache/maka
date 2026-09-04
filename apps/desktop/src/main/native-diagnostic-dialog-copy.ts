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

interface NativeDiagnosticDialogCopy {
  readonly dialog: {
    readonly copy: string;
    readonly copyAgain: string;
    readonly copied: string;
    readonly copyFailed: string;
  };
  readonly fatalStartup: {
    readonly title: string;
    readonly message: string;
    readonly detail: string;
    readonly exit: string;
  };
  readonly rendererGone: {
    readonly title: string;
    readonly message: string;
    readonly detail: string;
    readonly recover: string;
    readonly exit: string;
  };
  readonly runtimeHostRecovery: {
    readonly title: string;
    readonly message: string;
    readonly detail: string;
    readonly activeTasks: string;
    readonly repairFailed: string;
    readonly repair: string;
    readonly repairAndRestart: string;
    readonly exit: string;
  };
  readonly defaultRuntimeHostRecovery: {
    readonly title: string;
    connectFailed(profileName: string): string;
    readonly detail: string;
    readonly retry: string;
    readonly useLocal: string;
    readonly keepOffline: string;
  };
  readonly storageRootRepair: {
    readonly title: string;
    readonly message: string;
    detail(workspaceRoot: string): string;
    readonly repair: string;
    readonly exit: string;
  };
}

const COPY = {
  en: {
    dialog: {
      copy: 'Copy Diagnostics',
      copyAgain: 'Copy Again',
      copied: 'Diagnostics copied. You can paste them into an issue report.',
      copyFailed: 'Could not copy diagnostics.',
    },
    fatalStartup: {
      title: 'Maka failed to start',
      message: 'Maka could not finish starting.',
      detail: 'An unexpected startup error occurred. Copy diagnostics to inspect the details.',
      exit: 'Exit',
    },
    rendererGone: {
      title: 'Maka needs to recover',
      message: "Maka's interface stopped unexpectedly.",
      detail:
        'Recover the interface without restarting Maka. Runtime Host, running work, and background services will stay in place.',
      recover: 'Recover Interface',
      exit: 'Exit',
    },
    runtimeHostRecovery: {
      title: 'Maka needs to repair Runtime Host',
      message: 'The Runtime Host for this workspace could not start.',
      detail:
        'Maka can repair the managed Runtime Host selected by this Desktop. Your workspace, Host identity, credentials, and settings will be preserved. Repair may replace the installed Host with the version selected for this Desktop even when automatic update compatibility cannot be confirmed.',
      activeTasks:
        'The Host may still own active work. Continuing can interrupt that work before the Host restarts.',
      repairFailed: 'The previous repair attempt did not finish. Copy diagnostics to inspect the details.',
      repair: 'Repair Runtime Host',
      repairAndRestart: 'Repair and Restart Host',
      exit: 'Exit',
    },
    defaultRuntimeHostRecovery: {
      title: 'Default Runtime Host is unavailable',
      connectFailed: (profileName) => `Could not connect to ${profileName}`,
      detail:
        'Retry, use Local as the default Host, or keep the current selection and resolve it later in Settings. Copy diagnostics to inspect the connection failure.',
      retry: 'Retry',
      useLocal: 'Use Local',
      keepOffline: 'Keep Offline',
    },
    storageRootRepair: {
      title: 'Maka workspace needs repair',
      message: 'Maka cannot verify this workspace.',
      detail: (workspaceRoot) =>
        `The disk identity may have changed. Repair only if this is the original Maka workspace on this computer, not a copied workspace.\n\n${workspaceRoot}`,
      repair: 'Repair Workspace',
      exit: 'Exit',
    },
  },
  zh: {
    dialog: {
      copy: '复制诊断信息',
      copyAgain: '再次复制',
      copied: '诊断信息已复制，可直接粘贴到问题报告中。',
      copyFailed: '无法复制诊断信息。',
    },
    fatalStartup: {
      title: 'Maka 启动失败',
      message: 'Maka 无法完成启动。',
      detail: '启动时发生意外错误。复制诊断信息可查看详情。',
      exit: '退出',
    },
    rendererGone: {
      title: 'Maka 需要恢复',
      message: 'Maka 界面意外停止运行。',
      detail: '只恢复界面，不重启 Maka。Runtime Host、正在运行的工作和后台服务都会保留。',
      recover: '恢复界面',
      exit: '退出',
    },
    runtimeHostRecovery: {
      title: 'Maka 需要修复 Runtime Host',
      message: '管理此工作区的 Runtime Host 无法启动。',
      detail:
        'Maka 可以修复此 Desktop 选择的托管 Runtime Host。工作区、Host 身份、凭证和设置都会保留。即使无法确认自动更新兼容性，修复也可能使用此 Desktop 选择的版本替换当前 Host。',
      activeTasks: 'Host 可能仍有正在运行的任务。继续会先中断这些任务，再重启 Host。',
      repairFailed: '上一次修复未能完成。复制诊断信息可查看详情。',
      repair: '修复 Runtime Host',
      repairAndRestart: '修复并重启 Host',
      exit: '退出',
    },
    defaultRuntimeHostRecovery: {
      title: '默认 Runtime Host 无法连接',
      connectFailed: (profileName) => `无法连接 ${profileName}`,
      detail:
        '你可以重试、改用 Local 作为默认 Host，或保持当前选择并稍后在设置中处理。复制诊断信息可查看连接失败详情。',
      retry: '重试',
      useLocal: '改用 Local',
      keepOffline: '保持离线',
    },
    storageRootRepair: {
      title: 'Maka 工作区需要修复',
      message: 'Maka 无法验证这个工作区。',
      detail: (workspaceRoot) =>
        `系统中的磁盘标识可能发生了变化。仅当这是本机原来的 Maka 工作区、而不是复制出的工作区时，才选择修复。\n\n${workspaceRoot}`,
      repair: '修复工作区',
      exit: '退出',
    },
  },
} satisfies UiCatalog<NativeDiagnosticDialogCopy>;

export function getNativeDiagnosticDialogCopy(locale: UiLocale): NativeDiagnosticDialogCopy {
  return COPY[locale];
}
