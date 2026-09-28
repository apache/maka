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

import { en, incubatorDisclaimer } from './en';
import type { Copy } from './types';

export const zhCN: Copy = {
  locale: 'zh-CN',
  langLabel: '中文',
  siteName: 'Apache Maka (Incubating)',
  positioning: 'Apache Maka（孵化中）是一个高性能的 Agent 工作台，并完整记录它做过的每一件事。',
  theme: { toDark: '切换到深色模式', toLight: '切换到浅色模式' },
  sceneAlt:
    '一轮交互的运行时事件：模型说、执行命令、请求权限、你批准了、拿到结果、编辑文件、本轮结束。',
  nav: {
    docs: '文档',
    downloads: '下载',
    benchmarks: '评测',
    community: '社区',
    security: '安全',
    asf: 'ASF',
    getMaka: '发布进展',
    menu: '菜单',
  },
  hero: {
    headline: ['一个高性能的 Agent 工作台，', '并完整记录', '它做过的每一件事。'],
    lede: 'Agent harness 的本职就是把任务做完。衡量它的标准只有一条：完成了多少，花了多少。我们公开每一次运行：同一个模型，同一个官方验证器，逐任务的完整记录。',
    releases: '查看发布进展',
    contribute: '参与开发',
    fine: '首个 Apache 正式版本正在准备中',
    architecture: '阅读架构文档',
  },
  scene: {
    events: [
      { tone: 'mut', name: 'Text', label: '模型说', detail: '「我重新跑一下失败的测试。」' },
      { tone: '', name: 'FunctionCall', label: '执行命令', detail: 'Bash · npm test' },
      { tone: 'warn', name: 'permissionRequest', label: '请求权限', detail: '超出沙箱' },
      { tone: 'ok', name: 'permissionDecision', label: '你批准了', detail: '已写进日志' },
      {
        tone: '',
        name: 'FunctionResponse',
        label: '拿到结果',
        detail: 'exit 1 · 裁剪展示，全量保留',
      },
      { tone: 'dim', name: 'FunctionCall', label: '编辑文件', detail: 'resume.ts' },
      { tone: 'dim ok', name: 'endInvocation', label: '本轮结束', detail: '运行完成' },
    ],
    highWater: '到这里已确认',
    caption: '一轮交互 · 7 条运行时事件 · 只追加写入',
    formula: 'State(t) = Project(Log[0…t])',
  },
  measured: {
    h2: '只认实测数据，只信落盘记录。',
    p: '这个站点今天能证明两件事：在同一个模型上，Maka 比其他 harness 究竟表现如何；以及运行时工作时到底记下了什么。',
  },
  leaderboard: {
    h3: '9 个 harness，同一个模型，官方验证器',
    p: '在 DeepSeek V4 Flash 上跑完 Terminal-Bench 2.1 全部任务，由官方验证器统一判分。排名只描述结果，逐任务 CSV 随报告一并公开。',
    more: '查看评测报告',
    caption: 'pass@1 · reasoning max · Maka 单次通过成本 $0.026',
  },
  paired: {
    h3: '同一套任务，正面对比',
    p: '与 OpenCode 在同一批任务上做配对单次运行。差距经得起精确 McNemar 检验，每个通过任务的成本基本相同。',
    more: '查看对比报告',
    stat: '+13.5',
    statSmall: 'pp · 68.5% 对 55.1%',
  },
  host: {
    h3: '只有一个运行时宿主',
    p: 'Desktop、TUI、CLI 和 Eval 都是瘦客户端，执行统一交给同一个运行时宿主（Runtime Host）。',
    more: '了解运行时宿主如何工作',
    clients: ['Desktop', 'TUI / CLI', 'Eval'],
    core: 'Runtime Host',
    coreSmall: '掌控执行',
  },
  log: {
    h3: '日志即运行时',
    p: '每条消息、每次工具调用、每个权限决定和每次终止，都是一条只追加写入的运行时事件（RuntimeEvent）。界面、下一轮 prompt 和崩溃恢复都从这份日志推导出来，日志之外没有第二份权威副本。',
    more: 'Log Is the Runtime',
  },
  get: {
    h3: '发布与开发',
    p: '关注正式版本的发布进展，或参与项目开发。',
    contribute: {
      title: '参与 Maka 开发',
      body: '贡献指南介绍了开发环境搭建、测试和提交改动的方法。',
      note: '面向贡献者',
    },
    releases: {
      title: 'Apache Releases',
      body: 'Maka 尚未发布过 Apache release。发布之后，带签名的源码包才是正式 release，安装包只是便利构建。',
      note: 'KEYS · SHA-512 · .asc',
    },
  },
  reads: {
    h2: '报告与文章',
    p: '首页的每一条结论和数字，都能追溯到对应的完整报告或文档。',
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
      h3: 'Terminal-Bench 2.1：9 个 harness',
      meta: '评测报告与逐任务 CSV',
    },
    paired: {
      cover: 'p = 0.0118',
      small: 'docs/eval · paired',
      h3: 'Maka 对比 OpenCode',
      meta: '对比报告与逐任务 CSV',
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
    trademark: en.footer.trademark,
  },
  downloads: {
    title: '下载',
    lede: 'Apache Maka 尚未发布首个 Apache 正式版本。获批后，本页会提供发布文件和验证说明。',
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
    },
    releases: {
      h2: 'Apache releases',
      note: '暂无 APACHE RELEASE',
      p: 'Apache Maka (Incubating) 尚未发布过 Apache release。首个 release 投票通过后会列在这里：源码包、ASF 分发目录中的 SHA-512 校验和与独立的 GPG 签名，以及签名对应的 KEYS 文件。',
      distNote: '获批的正式版本将发布到：',
    },
    verify: {
      h2: '验证 release',
      p: '正式版本发布后，将以下命令中的 <version> 替换为对应版本号。',
      keys: '第 1 步：导入 release manager 的公钥',
      signature: '第 2 步：校验签名',
      checksum: '第 3 步：核对校验和',
    },
    development: {
      h2: '参与开发',
      p: '如果希望贡献代码或协助测试，请阅读贡献指南并关注开发邮件列表。开发构建不是获批的 Apache 正式版本。',
      contribute: '贡献指南',
      discuss: '开发邮件列表',
    },
  },
};
