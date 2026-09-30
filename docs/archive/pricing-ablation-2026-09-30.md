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

# Pricing 编辑器消融实验（2026-09-30）

本轮把 #5557 合入 main `d6876d708`（127 个提交），解决四处冲突（合并提交 `b043e2cf2`）；保留旧 PR #4164。随后完成 **30 项单独消融、3 项组合消融**，另有不改生产逻辑的对照组。最终识别 **27 项不可直接删除的机制、3 项可简化实现**；两种保护组合也被行为测试检出，三个简化组合仍通过。

实际落地：删除游标历史 Set、成功刷新时的重复错误清理、关闭编辑器时的重复冲突清理；补充 **10 项 Node 回归场景和 1 个真实 Chromium 场景**。所有异步归属、CAS、Host、输入保留、价格语义和焦点保护继续保留。

## 实验方法与可信度

- 固定合并后的源码树 `2f5459c0fd178790dee756f54316b56027f065c9`。脚本逐个精确替换生产代码，经 esbuild 转译后用 Node `registerHooks` 内存加载；每个变体独立进程，不覆写生产源码或 dist。记录源码 SHA-256、实际加载记录、退出状态和行为断言。
- 初始测试集是 7 个文件、114 项测试；补充探针后同样的 7 个文件共 124 项，对照组全部通过。逐项删除和组合删除使用同一源码基线；组合简化另跑对照确认。
- 通过测试只代表这些观察点未发现差异。消融被检出的标准是**具体行为断言失败**，不把导入、编译、超时或加载失败计入成功检出。结果不用于宣称性能收益或整体质量百分比。
- 初始运行器的异步 reporter 迭代错误已修复；Astryx 0.6.3 新增读取 CSS `writingMode`，为 Pricing 的模拟 DOM 补齐浏览器默认 `horizontal-tb/ltr` 后建立绿色基线。
- 初轮两项破坏使 DOM 对象差异打印导致测试子进程 SIGKILL，测试未完整执行，已剔除。改成同等谓词的布尔断言，并在每项测试后卸载遗留 React root，重新执行完整矩阵。`no-persistent-draft` 同时产生 5 个明确断言失败和 1 个缺失 dialog 的 TypeError，以前者为证据；该项再独立运行确认 124 项均结束。
- 浏览器初次使用开发服务器出现 Vite 依赖优化的 504，已废弃该轮。正式结果使用独立构建的静态 Storybook、真实 Chromium、原生产编辑器及原生产主题/样式，等待 `play` 完成；记录变换模块被实际加载，没有通过增加重试或超时获得绿色结果。

## 完整矩阵

“初轮”是 114 项测试；“补探针”是 124 项测试，数字是失败测试数。`保留` 表示删除后出现可观察回归；`简化` 表示在当前接口约束下，逻辑证明与实验一致。无效初轮不参与判定。

| 变体 | 初轮 | 补探针 | Chromium | 处理 |
| --- | --- | --- | --- | --- |
| `latest-cas-base` | 3 | 3 | — | 保留 |
| `unpinned-validation` | 1 | 1 | — | 保留 |
| `no-host-witness` | 2 | 2 | — | 保留 |
| `no-lifecycle-fence` | 0 | 1 | — | 保留 |
| `no-mutation-read-fence` | 1 | 1 | — | 保留 |
| `no-read-order` | 0 | 2 | — | 保留 |
| `no-persistent-draft` | 5 | 6 | — | 保留 |
| `no-sync-input-ref` | 1 | 1 | — | 保留 |
| `close-newer-input` | 3 | 3 | — | 保留 |
| `no-dialog-ownership` | 2 | 2 | — | 保留 |
| `no-host-review` | 7 | 7 | — | 保留 |
| `no-unknown-write-block` | 5 | 5 | — | 保留 |
| `no-write-guard` | 1 | 1 | — | 保留 |
| `all-catalog-duplicates` | 10 | 10 | — | 保留 |
| `no-rate-syntax` | 1 | 1 | — | 保留 |
| `no-underflow-check` | 1 | 1 | — | 保留 |
| `negative-rates` | 2 | 2 | — | 保留 |
| `blank-is-zero` | 无效 | 13 | — | 保留 |
| `no-custom-provenance` | 3 | 3 | — | 保留 |
| `reset-means-no-override` | 0 | 1 | — | 保留 |
| `no-connection-identity` | 1 | 1 | — | 保留 |
| `no-page-canonicality` | 1 | 2 | — | 保留 |
| `no-page-progress-check` | 0 | 4 | — | 保留 |
| `no-stable-focus-fallback` | 无效 | 1 | populated | 保留 |
| `no-reveal-cache-error` | 2 | 2 | — | 保留 |
| `no-catalog-aria-binding` | 0 | 0 | manual-exact-key | 保留 |
| `no-dialog-focus-repair` | 0 | 0 | host-review | 保留 |
| `no-offset-history` | 0 | 0 | — | 简化 |
| `one-load-error-clear` | 0 | 0 | — | 简化 |
| `one-close-conflict-clear` | 0 | 0 | — | 简化 |
| `combined-simplification` | 0 | 0 | — | 组合通过 |
| `no-host-fences` | 4 | 5 | — | 组合检出 |
| `no-async-ownership` | 5 | 5 | — | 组合检出 |

具体失败测试名、加载模块散列和原始结果路径见 [机器可读结果](pricing-ablation-2026-09-30.json)。下述发现解释了测试数量本身不能说明的问题。

## 新发现的覆盖盲区

1. **同一 Host 下的卸载**：原测试只覆盖 Host 更换，Host witness 自身就会拒绝旧结果，掩盖了 lifecycle 检查的独立价值。新增场景保持同一 Host generation，隐藏后重新挂载 Pricing，再让旧保存完成；删除 lifecycle 检查会清掉恢复后的 scope 草稿。
2. **刷新彼此乱序**：原测试覆盖“刷新晚于保存”和 StrictMode，未覆盖同一代的两个刷新。新增在 React 提交 loading 前发起两次刷新，让新请求先返回，再分别让旧请求成功或失败。删除 read ticket 后新价格被覆盖，或者新列表被旧错误挡住。
3. **分页游标不前进**：新增起始自环、后续自环、回到 0、回到更小游标，以及合法三页和页边界重复 key。删除 progress 检查导致无效后续请求发出；只删除 Set 时全部通过。
4. **Reset 与 Delete 不能共用“记录不存在即成功”**：原测试分别证明恢复内置价和删除自定义价的正例。新增 reset 的 fresh authority 缺少模型这一反例，必须要求 review，不能宣称已恢复内置定价。它验证的是防御性协议语义，不代表正常 Host 会生成这样的列表。
5. **ARIA 只能在对应真实控件上验证**：模拟 DOM 覆盖了手填输入框的必填错误，未覆盖 Astryx 目录 combobox。移除手工绑定后，Chromium 的 `manual-exact-key` 在 `aria-required` 断言处失败；Astryx 0.6.3 仍未替代这层绑定。
6. **普通保存覆盖不到的焦点丢失**：删除 dialog focus repair 后，Conflict 和 Uncertain 两个旧故事仍通过。新增 HostReview：异步 Host 更新后，用户点击“已核对新主机定价”，该按钮从 DOM 消失。对照将焦点留在 dialog；消融后焦点落到 body。该原生焦点行为正式留在 Storybook。

## 三处简化为什么成立

- **分页 Set**：初始 offset 是 0；每个后续请求必须严格大于当前 offset，每个成功响应还必须等于所请求 offset。由此归纳得到已接受 offset 严格递增，任何已访问 offset 都不可能大于当前值。Set 不增加保护，删去后仍保留 progress 和 response correlation 检查。空间少一个随页数增长的集合；本实验未测量运行耗时收益。
- **成功刷新重复清错**：reload 一开始就清错。唯一可写入 load error 的失败路径同时受 lifecycle 和 ticket 约束；旧请求失效，mutation outcome 也会撤销在途 reload。因此同一有效请求成功后第二次清空不增加行为。
- **关闭弹窗重复清冲突**：有效冲突属于非空 model key，`setEditor(null)` 改变该身份并通过统一的 setEditor 路径清除已结算 conflict。关闭函数再次清理是重复操作。未结算写入及 reset 的独立取消逻辑仍保留。

三个单项与组合分别通过 124 项测试。不能据此推广为“所有 Set、重复状态写入或生命周期检查都可删除”；上述约束是这些局部简化的前提。

## 验证与复现

最终生产代码验证：合并基线全量 build/typecheck/lint/format；变更后 Desktop build/typecheck、124 项直接编译测试、真实 Electron preload → IPC → Host 写入/renderer reload 持久化测试（1 项）。当前生产源码的 6 个交互故事 × 1280/480px 共 12 个 Chromium 场景通过，`play` 全部完成；架构、Storybook 调度契约、lint/format、提交许可证及协议 epoch 检查通过。

在包含本报告的提交、锁文件对应依赖安装完成后，从仓库根目录执行：

```sh
npm ci --no-audit --no-fund
npm run build
# 精确固定旧源码的对照 + 33 个变体；输出留在被 gitignore 的 perf-results。
MAKA_ABLATION_PROBES=1 node scripts/experiments/pricing-ablation.mjs
# 真实 Chromium 验证 ARIA、删除后的焦点和 Host review 焦点。
node scripts/experiments/pricing-ablation-browser.mjs
# 直接验证当前生产代码，两档视口，不注入消融。
MAKA_ABLATION_CURRENT=1 MAKA_ABLATION_WIDTHS=1280,480 node scripts/experiments/pricing-ablation-browser.mjs baseline
```

如本机没有 Playwright Chromium，先运行 `npx playwright install chromium`。省略 `MAKA_ABLATION_PROBES=1` 可重现初始 114 项观察面；可以在 Node 命令末尾指定变体 ID，脚本对未加载变换、测试数不匹配和没有行为失败证据的非零退出标记 invalid。`MAKA_ABLATION_RESULTS` 可指定独立输出目录，避免覆盖旧结果。

已提交的是脚本、固定探针、结构化证据和本报告；体积较大的完整日志、每项变体源码、静态构建和截图留在本工作区 `perf-results/pricing-ablation-20260930/`。JSON 包含原始结果路径及 SHA-256；异地复现应使用上述脚本重新生成，不能把本地路径当作已上传附件。

范围限制：这是 Pricing 行为与可靠性消融，不是费用计算精度的全系统验证，也不是速度基准。真实浏览器为 Chromium；最终布局检查涵盖默认浅色中文与 1280/480px，未在本轮枚举所有主题、语言、平台或任意网络时序。保留的 27 项机制是本矩阵中的具体删除会回归，不构成对所有实现方式的必要性证明。
