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

import type { Copy } from './types';
import { incubatorDisclaimer } from './en';

export const zhCN: Copy = {
  locale: 'zh-CN',
  langLabel: '中文',
  siteName: 'Apache Maka (Incubating)',
  positioning: 'Apache Maka (Incubating) 是一个高性能 Agent 工作台，完整记录它做过的每一件事。',
  theme: {
    toDark: '切换到深色模式',
    toLight: '切换到浅色模式',
  },
  sceneAlt:
    '一轮交互的运行时事件：模型说、执行命令、请求权限、你批准了、拿到结果、编辑文件、本轮结束。',
  nav: {
    docs: '文档',
    downloads: '下载',
    community: '社区',
    security: '安全',
    asf: 'ASF',
    getMaka: '获取 Maka',
    menu: '菜单',
  },
  hero: {
    headline: ['一个高性能的 Agent 工作台，', '并完整记录', '它做过的每一件事。'],
    lede: '原生 Rust CLI 和 TUI，通过公共插件能力运行任务，将模型交互和工具效果保存为可恢复的执行事实。',
    nightly: 'CLI 分发',
    source: '从源码构建',
    fine: '原生预览包不是 ASF release',
    architecture: '阅读架构文档',
  },
  scene: {
    events: [
      {
        tone: 'mut',
        name: 'Text',
        label: '模型说',
        detail: '「我重新跑一下失败的测试。」',
      },
      {
        tone: '',
        name: 'FunctionCall',
        label: '执行命令',
        detail: 'Shell · just test',
      },
      {
        tone: 'warn',
        name: 'permissionRequest',
        label: '请求权限',
        detail: '超出沙箱',
      },
      {
        tone: 'ok',
        name: 'permissionDecision',
        label: '你批准了',
        detail: '已写进日志',
      },
      {
        tone: '',
        name: 'FunctionResponse',
        label: '拿到结果',
        detail: 'exit 1 · 裁剪展示，全量保留',
      },
      {
        tone: 'dim',
        name: 'FunctionCall',
        label: '编辑文件',
        detail: 'resume.rs',
      },
      {
        tone: 'dim ok',
        name: 'endInvocation',
        label: '本轮结束',
        detail: '运行完成',
      },
    ],
    highWater: '到这里已确认',
    caption: '一轮交互 · 7 条运行时事件 · 只追加写入',
    formula: 'State(t) = Project(Log[0…t])',
  },
  host: {
    h3: '只有一个运行时宿主',
    p: 'CLI、TUI 和插件共享同一个执行与权限边界。',
    more: '了解运行时宿主如何工作',
    clients: ['CLI / TUI', '插件'],
    core: 'Runtime Host',
    coreSmall: '掌控执行',
  },
  log: {
    h3: '日志即运行时',
    p: '每条消息、每次工具调用、每个权限决定和每次终止，都是一条只追加写入的运行时事件（RuntimeEvent）。界面、下一轮 prompt 和崩溃恢复都从这份日志推导出来，日志之外没有第二份权威副本。',
    more: 'Log Is the Runtime',
  },
  get: {
    h3: '获取 Maka',
    p: '三条路径，边界分明。',
    nightly: {
      title: '原生 CLI 分发',
      body: 'npm 薄封装选择对应平台的 Rust 可执行文件。',
      note: '预览',
    },
    source: {
      title: '从源码构建',
      body: '克隆仓库，运行 just setup 和 just run。',
      note: 'APACHE-2.0',
    },
    releases: {
      title: 'Apache Releases',
      body: 'Maka 尚未发布过 Apache release。发布之后，带签名的源码包才是正式 release，安装包只是便利构建。',
      note: 'KEYS · SHA-512 · .asc',
    },
  },
  footer: {
    foundation: '基金会',
    incubator: '孵化器',
    conduct: '行为准则',
    license: '许可证',
    events: '活动',
    privacy: '隐私',
    security: '安全',
    sponsorship: '赞助',
    thanks: '致谢',
    disclaimer: incubatorDisclaimer,
    trademark:
      'Copyright © 2026 The Apache Software Foundation, licensed under the Apache License, Version 2.0. Apache Maka, Apache Incubator, Apache and the Apache feather logo are trademarks of The Apache Software Foundation.',
  },
  downloads: {
    title: '下载',
    lede: '带签名的源码包才是正式 release。本页其余内容都是便利构建，并且都明确标注。',
    onThisPage: '本页目录',
    copy: '复制',
    copied: '已复制',
    status: {
      h3: '当前状态',
      release: {
        label: 'Apache release',
        value: '暂未发布。首个 release 投票通过后会列在这里。',
        note: '暂无',
      },
      nightly: {
        label: '原生 CLI',
        value: '绑定源码的平台包',
        note: '预览',
      },
      source: {
        label: '源码',
        value: 'GitHub 上的 apache/maka，Apache License 2.0。',
        note: 'APACHE-2.0',
      },
    },
    releases: {
      h2: 'Apache releases',
      note: '暂无 APACHE RELEASE',
      p: 'Apache Maka (Incubating) 尚未发布过 Apache release。首个 release 投票通过后会列在这里：源码包、ASF 分发目录中的 SHA-512 校验和与独立的 GPG 签名，以及签名对应的 KEYS 文件。',
      distNote: '在此之前，分发目录尚未创建：',
    },
    verify: {
      h2: '验证 release',
      p: '所有 Apache release 的验证方式都一样，参与投票的每位 reviewer 在表决前都会走一遍这几步。',
      keys: '第 1 步：导入 release manager 的公钥',
      signature: '第 2 步：校验签名',
      checksum: '第 3 步：核对校验和',
    },
    nightly: {
      h2: '原生 CLI 分发',
      note: '预览软件，不是 ASF release',
      p: 'Rust CLI 使用精确版本的原生平台包分发。npm 启动器只选择并运行可执行文件；构建与发布流程见 CLI 分发文档。',
      windows: 'macOS arm64、Linux x64（glibc）、Windows x64。',
    },
    source: {
      h2: '从源码构建',
      prerequisites: [
        'Rust stable、Node.js 26、npm 12.2.1 和 just。',
        'macOS 需要 Xcode Command Line Tools，Linux Computer Use 需要 X11 开发库。',
      ],
      clone: '第 1 步：克隆仓库',
      build: '第 2 步：安装依赖并构建全部 workspace',
      after: '贡献指南介绍构建、验证和插件开发。',
    },
  },
  features: {
    h2: '一个原生运行时',
    p: '执行、权限与持久状态由同一个 Rust Runtime Host 管理。',
  },
};
