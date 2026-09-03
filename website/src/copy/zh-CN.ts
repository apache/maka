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

import { incubatorDisclaimer } from './en';
import type { Copy } from './types';

export const zhCN: Copy = {
  locale: 'zh-CN',
  langLabel: '中文',
  siteName: 'Apache Maka (Incubating)',
  positioning: 'Apache Maka (Incubating) 是一个高性能的 Agent 工作台，完整记录它做过的每一件事。',
  theme: { toDark: '切换到深色模式', toLight: '切换到浅色模式' },
  nav: {
    docs: '文档',
    downloads: '下载',
    benchmarks: '跑分',
    community: '社区',
    security: '安全',
    asf: 'ASF',
    getMaka: '获取 Maka',
  },
  hero: {
    eyebrow: 'Apache Maka (Incubating)',
    headline: ['一个高性能的 Agent 工作台，', '完整记录', '它做过的每一件事。'],
    lede: 'Agent harness 的存在是为了把任务做完。我们只用一把尺子衡量它：完成了多少，花了多少；并公开每一次运行：同一个模型，同一个官方验证器，逐任务的完整记录。',
    nightly: '试用 Desktop Nightly',
    source: '从源码构建',
    fine: 'Nightly 是开发者构建，不是 ASF release',
    architecture: '阅读架构文档',
  },
  scene: {
    events: [
      { tone: 'mut', name: 'Text', detail: '「我重跑一下失败的测试。」' },
      { tone: '', name: 'FunctionCall', detail: 'Bash · npm test' },
      { tone: 'warn', name: 'permissionRequest', detail: '越出沙箱' },
      { tone: 'ok', name: 'permissionDecision', detail: '你已批准' },
      { tone: '', name: 'FunctionResponse', detail: 'exit 1 · 已裁剪，仍保留' },
      { tone: 'dim', name: 'FunctionCall', detail: 'Edit · resume.ts' },
      { tone: 'dim ok', name: 'endInvocation', detail: '运行完成' },
    ],
    highWater: 'highWater',
    caption: '一轮对话 · 七个 RuntimeEvent · 只追加',
    formula: 'State(t) = Project(Log[0…t])',
  },
  measured: {
    h2: '只讲测出来的，只信记下来的。',
    p: '这个站点今天能证明两件事：在同一个模型上，Maka 相对其它 harness 站在哪里；以及 runtime 工作时到底写下了什么。',
  },
  leaderboard: {
    h3: '九个 harness，一个模型，官方验证器',
    p: '在 DeepSeek V4 Flash 上跑完 Terminal-Bench 2.1 的全部任务，由官方验证器判分。排名是描述性的，逐任务 CSV 随报告一起公开。',
    more: '阅读报告',
    caption: 'pass@1 · reasoning max · Maka 每次通过成本 $0.026',
  },
  paired: {
    h3: '同一套题，正面对比',
    p: '与 OpenCode 在同一批任务上做配对单次运行。差距在这套题上经得起精确 McNemar 检验，每个通过任务的成本持平。',
    more: '阅读配对报告',
    stat: '+13.5',
    statSmall: 'pp · 68.5% 对 55.1%',
  },
  host: {
    h3: '唯一的 Runtime Host',
    p: 'Desktop、TUI、CLI 和 Eval 都是同一个执行权威的瘦客户端。',
    more: 'Host 如何工作',
    clients: ['Desktop', 'TUI / CLI', 'Eval'],
    core: 'Runtime Host',
    coreSmall: '掌管执行',
  },
  log: {
    h3: '日志就是运行时',
    p: '每条消息、每次工具调用、每个权限决定和每次终止，都是一条只追加的 RuntimeEvent。界面、下一个 prompt 和崩溃恢复都是这份日志的投影，从来不是唯一副本。',
    more: 'Log Is the Runtime',
  },
  get: {
    h3: '获取 Maka',
    p: '三条路径，刻意分开。',
    nightly: {
      title: '试用 Desktop Nightly',
      body: '每天从 main 构建，面向开发者和测试者，发布在 GitHub Releases。目前支持 Apple Silicon Mac；Windows 是未签名预览。',
      note: '不是 ASF RELEASE · 可能不稳定',
    },
    source: {
      title: '从源码构建',
      body: '克隆 apache/maka，然后 npm ci 和 npm run build。Desktop、TUI 和 CLI 共用一个 Runtime Host。',
      note: 'APACHE-2.0',
    },
    releases: {
      title: 'Apache Releases',
      body: 'Maka 还没有发布过 Apache release。发布之后，签名的源码包才是 release，安装包只是便利产物。',
      note: 'KEYS · SHA-512 · .asc',
    },
  },
  reads: {
    h2: '报告与文章',
    p: '首页的每一条主张都链接到一份拥有这些数字的报告或文档。',
    blogLog: {
      cover: 'State(t) =\nProject(Log[0…t])',
      small: 'docs/blogs',
      h3: 'Log Is the Runtime',
      meta: '李坤 · English / 中文',
    },
    blogTools: {
      cover: 'Deferred\ntools',
      small: 'docs/blogs',
      h3: 'Beyond Function Calling：Agent 如何触达真实世界',
      meta: '李坤 · English / 中文',
    },
    nineArm: {
      cover: '69 / 89',
      small: 'docs/eval · nine-arm',
      h3: 'Terminal-Bench 2.1，九个 harness',
      meta: '报告与逐任务 CSV',
    },
    paired: {
      cover: 'p = 0.0118',
      small: 'docs/eval · paired',
      h3: 'Maka 对 OpenCode',
      meta: '报告与逐任务 CSV',
    },
  },
  footer: {
    foundation: '基金会',
    license: '许可证',
    events: '活动',
    privacy: '隐私',
    security: '安全',
    sponsorship: '赞助',
    thanks: '致谢',
    disclaimer: incubatorDisclaimer,
    trademark:
      'Copyright © 2026 The Apache Software Foundation，以 Apache License, Version 2.0 授权。Apache Maka、Apache Incubator、Apache 与 Apache 羽毛标志是 The Apache Software Foundation 的商标。',
  },
  downloads: {
    title: '下载',
    lede: '签名的源码包才是 release。本页其它内容都是便利构建，并且都会写明。',
    releases: {
      h2: 'Apache releases',
      note: '尚无 APACHE RELEASE',
      p: 'Apache Maka (Incubating) 还没有发布过 Apache release。第一个 release 投票通过后，这里会列出它：源码包、ASF 分发目录里的 SHA-512 校验和与分离的 GPG 签名，以及签名所对应的 KEYS 文件。',
      distNote: '在此之前，分发目录尚不存在：',
    },
    verify: {
      h2: '验证 release',
      p: '每个 Apache release 的验证方式都一样：导入 release manager 的公钥，验签，再核对校验和。',
    },
    nightly: {
      h2: 'Desktop Nightly',
      note: '不是 ASF RELEASE',
      p: 'Desktop Nightly 每天从 main 构建，面向开发者和测试者，以 GitHub prerelease 的形式发布。选择最新的 Maka Desktop Nightly；安装后应用会在 Nightly 渠道自动更新。它不是 ASF release，也不适合生产使用。目前面向 Apple Silicon Mac。',
      windows: 'Windows 是未签名预览，不是受支持的发布层级。',
    },
    source: {
      h2: '从源码构建',
      requirements: '需要 Node.js 22.19 或更新版本、npm 11、Git，以及 Grep 工具依赖的 ripgrep。',
      after: 'CONTRIBUTING 说明了 workspace 布局，以及如何从这份构建启动 Desktop、TUI 和 CLI。',
    },
  },
};
