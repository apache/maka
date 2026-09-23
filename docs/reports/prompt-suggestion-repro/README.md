<!--
  Licensed to the Apache Software Foundation (ASF) under one
  or more contributor license agreements.  See the NOTICE file
  distributed with this work for additional information
  regarding copyright ownership.  The ASF licenses this file
  to you under the Apache License, Version 2.0 (the
  "License"); you may not use this file except in compliance
  with the License.  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing,
  software distributed under the License is distributed on an
  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  KIND, either express or implied.  See the License for the
  specific language governing permissions and limitations
  under the License.
-->

# 历史 inline completion 真实布局实验

2026-09-22，实验目的：验证 Maka 0.1.11 的历史 inline completion 是否能自然复现 React error 185。此目录是隔离的研究 harness，不参与产品运行，也不是新 suggestion 功能的验收结果。

## 结论

**本次没有复现原崩溃。** 实际执行 2,040 个自然 Chromium 布局/滚动/编辑组合：React 185 为 **0 / 2,040**，捕获到的其他应用错误同样为 0。1,551 个组合确实显示了候选，其余因真实裁切等条件未显示。这个样本结果不能证明历史缺陷不存在。

**原版 Astryx 0.4.0 并不包含这套 inline completion 引擎。** 引擎来自 Maka 自己的 `patches/@astryxdesign+core+0.4.0.patch`。此前把它简称为“Astryx 0.4.0 引擎”不够准确，应修正为“Maka 当时对 Astryx 0.4.0 的补丁引擎”。[历史补丁](https://github.com/maka-agent/maka-agent/blob/a3c4d0b2a6ca0c87bebebff135d40017558ae5b8/patches/%40astryxdesign%2Bcore%2B0.4.0.patch)、[历史补丁测试说明](https://github.com/maka-agent/maka-agent/blob/a3c4d0b2a6ca0c87bebebff135d40017558ae5b8/packages/ui/src/__tests__/astryx-inline-completion.test.tsx#L6-L18)。

另外执行了**明确人工伪造几何结果**的可见性振荡压力对照：300 次 offer rect 返回值被人为交替改成“可见/不可见”，记录 402 次 DOM mutation；达到上限后自动恢复真实几何。**该人工实验也没有出现 React 185**，只能说明错误几何反馈能够触发反复 DOM 更新，不能称作原崩溃的阳性复现，更不能将人工几何解释成浏览器自然行为。[机器证据](./forced-control.json)、[人工控制脚本](./run-forced-control.mjs)。

## 版本与依据

| 项目 | 本次实验 | 原 issue 报告 |
|---|---|---|
| Maka 源码 | `v0.1.11` → `a3c4d0b2a6ca0c87bebebff135d40017558ae5b8` 的补丁和 wiring | Maka 0.1.11 packaged |
| Astryx | npm `@astryxdesign/core@0.4.0`，应用上述完整历史补丁 | 相同版本依赖 |
| React / React DOM | 19.2.8，production build | 0.1.11 lockfile 同为 19.2.8 |
| 浏览器 | Ego Chromium 152.0.0.0，真实 GUI 浏览器 | Electron 43.2.0 / Chromium 150.0.7871.129 |
| OS / arch | macOS / arm64 | darwin 25.5.0 / arm64 |
| Harness bundler | Vite 7.1.12 | Maka 自身构建 |

[原 issue #4117](https://github.com/maka-agent/maka-agent/issues/4117) 的诊断日志确实包含 React 185 与组件堆栈，但复现步骤写的是“无法复现”。本次通过 `gh issue view 4117 --repo maka-agent/maka-agent --json title,body,comments` 核对。原 issue 没提供当时草稿、历史候选、窗口尺寸、字号或操作录像，不能从它恢复精确触发输入。

历史 wiring 是 `inlineCompletion={matchCompletion(text) ?? undefined}`、`inlineCompletionLabel`、`maxRows={10}`、受控 value/onChange。[原 composer](https://github.com/maka-agent/maka-agent/blob/a3c4d0b2a6ca0c87bebebff135d40017558ae5b8/packages/ui/src/composer.tsx#L1534-L1562)。本 harness 直接向同一个 patched `ChatComposerInput` 输入对应 base/suffix，省略历史持久化、整套应用 shell 与业务数据，不是完整安装版复现。

完整 npm 原包与历史补丁都只放临时目录，未入库。哈希用于确认实验实际加载的内容：

```text
historical patch SHA-256:
5ed9225efa7accf31f1335cafab000e9cf467ecc864d6797919bd757a194b9bb
patched dist/Chat/ChatComposerInput.js SHA-256:
e32da838c287e5b8ec1cc6f17f60db654d379bd138bfa1c58ea0927fff592823
npm tarball SHA-256:
d17eb4f10d487e21117d24eefa095289c79d632f4f6771a7d310b1d6873f247b
```

## 执行矩阵与反馈信号

主矩阵 1,800 例：3 字体（Arial、monospace、PingFang SC）× 5 宽度（240、320、479.5、640、799.5 CSS px）× 6 行高（18、19.5、20、21.5、22、22.5 px）× 5 **CSS zoom**（0.8、1、1.1、1.25、1.5）× 4 输入类型（短英文、重复长中文、9 个显式换行后的英文尾部、长英文软换行）；font-size=14，maxRows=10。CSS zoom 不是浏览器菜单 zoom，这次没有声称覆盖后者。

补充 240 例：固定随机种子 4117，宽度约 200–800 px 且含 0.25 px 小数，字体大小 12–16 px，行高 17–24 px，CSS zoom 0.75–1.5，maxRows 为 2/3/10；中英文长输入。真实 scrollTop 移到内容底部，浏览器 `execCommand('insertText', ..., 'x')` 插入后再 `delete`。这里修改滚动和编辑内容，但不替换几何测量。

| 实验 | cases | 可见候选 | 应用错误 | React 185 | 单例最多 DOM mutation callback |
|---|---:|---:|---:|---:|---:|
| 自然布局 | 1,800 | 1,420 | 0 | 0 | 5 |
| 自然滚动/编辑 | 240 | 131 | 0 | 0 | 9 |
| 人工几何振荡 | 1 | 1 | 0 | 0 | 402 |

采集 `window.error`、`unhandledrejection`、`console.error`、React ErrorBoundary，以及真实 field/offer rect、scrollHeight/clientHeight/scrollTop、候选文本和 MutationObserver 回调数。production React 的 Profiler `commits` 恒为 0，**不可拿该字段断言没有 React render**；本报告只比较实际 DOM mutation 和错误信号。每个自然案例约等待 90–105 ms，覆盖即时反馈而非长时间会话压力。

初次测试发现 Chrome 页面未获得一次真实 click 时，脚本 focus 没有成功，document.activeElement 仍是 body。已丢弃这些不合格数据并重跑：最终脚本在每次导航后先真实 `page.click` 激活输入，再开始配置和聚焦扫描；最终 45 个主矩阵批次均由修正后脚本重新生成。另有一次 150 例/requestAnimationFrame 初稿超过 ego-browser 15 秒 evaluate 限制，随后重载并改成 40 例/有界等待，这个超时不计作产品错误。

## 保留的证据

- [summary.json](./summary.json)：全部自然案例的计数与实际 UA。
- [matrix-results.json](./matrix-results.json)：1,800 例原始配置和观测结果，无伪造 geometry。
- [scrolled-results.json](./scrolled-results.json)：240 例滚动/编辑原始配置和观测结果。
- [forced-control.json](./forced-control.json)：人工几何的 300 次 trace、402 次 mutation 与空 errors；明确 `synthetic: true`。
- [execution-logs.md](./execution-logs.md)：逐批调用输出。
- [versions.json](./versions.json)：临时安装版本与 harness Node 版本。
- [main.tsx](./main.tsx)、[index.html](./index.html)：最小独立页面；不依赖 Maka 用户数据。
- [run-matrix.mjs](./run-matrix.mjs)、[run-scrolled.mjs](./run-scrolled.mjs)、[run-forced-control.mjs](./run-forced-control.mjs)：实际执行的浏览器脚本。

人工压力实验后的 `page.screenshot()` 出现 `Page.captureScreenshot` timeout；随后 DOM snapshot 与 metrics 均可正常读取，候选稳定，errors 为空。再用 `Page.captureScreenshot {fromSurface:false}` 也返回 `Unable to capture screenshot`，所以**本次没有成功获取 PNG 截图**，保留了 [DOM snapshot 与最终状态](./final-dom-evidence.json) 以及 [截图错误记录](./screenshot-error.md)。这些截图工具错误不能当成 React 崩溃。

## 复跑方法

依赖安装和构建在临时目录进行。下面以仓库当前路径为例；不要在产品 node_modules 应用历史补丁。

```sh
task_repo=/Users/a404/.codex/worktrees/maka-prompt-suggestions/maka-agent
task_repro=$(mktemp -d /tmp/maka-inline-repro.XXXXXX)
npm install --prefix "$task_repro" --save-exact --no-audit --no-fund \
  @astryxdesign/core@0.4.0 react@19.2.8 react-dom@19.2.8 vite@7.1.12
git -C "$task_repo" show a3c4d0b2a6ca0c87bebebff135d40017558ae5b8:patches/@astryxdesign+core+0.4.0.patch > "$task_repro/historical-astryx.patch"
cd "$task_repro"
patch -p1 --dry-run -i historical-astryx.patch
patch -p1 -i historical-astryx.patch
cp "$task_repo/docs/reports/prompt-suggestion-repro/main.tsx" .
cp "$task_repo/docs/reports/prompt-suggestion-repro/index.html" .
./node_modules/.bin/vite build
./node_modules/.bin/vite preview --host 127.0.0.1 --port 5200
```

在另一终端，通过 ego-browser 建立一个新的 taskSpace，把三个 runner 中的实验 space id `8` 改为返回 id，输出目录改到期望路径。本次实际 space=8，运行后已关闭。主矩阵每批 40 例，实际使用 sed 传 batch，因为 ego-browser Node 环境没有保留外部 `BATCH` 环境变量：

```sh
cd "$task_repo"
for b in {0..44}; do
  sed "s/Number(process.env.BATCH??0)/$b/" docs/reports/prompt-suggestion-repro/run-matrix.mjs | ego-browser nodejs
done
for b in {0..5}; do
  sed "s/const batch=0;/const batch=$b;/" docs/reports/prompt-suggestion-repro/run-scrolled.mjs | ego-browser nodejs
done
ego-browser nodejs < docs/reports/prompt-suggestion-repro/run-forced-control.mjs
```

## 对新实现的影响

这次实验给出的证据足以修正“已有自然复现、已证明布局 flip-flop 就是根因”的表述；目前仍没有能稳定让原 React 185 变红的自然回归用例。保留现有防误接回归约束有依据，但不可把该源码 regex 测试当作崩溃行为测试。

独立空草稿建议 overlay 不再把候选节点插入 contenteditable、不依赖 getBoundingClientRect 控制反复 state 更新，因此规避了人工压力所展示的反馈机制。这个架构选择的合理性与“已复现并修复历史 #4117”是不同结论；后者本次没有达成。新功能还应依靠自己的真实 Electron 交互验收证明 Tab、Undo、Esc、中文及 stale 边界正确。
