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

# Pricing 消融实验（2026-10-16）

结论：可做局部精简。采用 6 项调整，3 个生产文件共增加 24 行、删除 51 行，
净减 27 行；移除一个独立 React 状态及重复处理，保留经反证确认必要的保护。

实验基线为合并提交 `c00c9c77465e78acab22023d02cc204dd1588729`，包含主线
`331340aba5c7de5fc7d53e2441123f40f03ba34b`。本次同步了 13 个主线提交，
无文本冲突。另按源码重新生成架构账本，将主线已有的 AppShell token 统计
从 7285 修正为 7280；未放宽架构规则。

先按新锁文件安装依赖，再以同一基线分别执行 11 项独立消融和 1 项组合实验。
每项恢复原始源码、应用单项修改、重新编译 Desktop，再运行同一组 125 项
Pricing/Usage 测试。所有变体均编译成功；下面的失败均为行为断言失败。
测试本身没有修改。另运行了 47 项核心/Host 定价测试。

| 独立调整 | Node 结果 | 决定及依据 |
| --- | --- | --- |
| 从「有 editor、无 mutationBase」推导 needsReview | 125/125 | 采用；Host 切换与重挂载后必须重新确认，确认后固定写入基准，无需第二个状态 |
| loadError 字符串改为 loadFailed 标记 | 125/125 | 采用；界面只读取失败与否，始终显示本地化的通用错误提示，原错误详情未被使用 |
| 合并 IPC 校验和派发的两段相同 catch | 125/125 | 采用；仍执行全部校验，仍返回相同失败 Result |
| 加载与已加载状态共用 Pricing 表格 JSX | 125/125 | 采用；保留各自的 ARIA 标签、骨架行和真实行 |
| 两种恢复提示共用 Banner JSX | 125/125 | 采用；保留「已提交但刷新失败」与「结果未明」各自的文案和状态 |
| 移除 UI 的额外关闭守卫，交给 controller | 125/125 | 采用；controller 的同步单次写入守卫仍阻止关闭 |
| 写入时用最新列表快照代替打开弹窗时的快照 | 122/125 | 拒绝；后台刷新期间的新增、编辑、重置均丢失原 CAS 基准 |
| 移除同步 editorRef 写入 | 124/125 | 拒绝；同一次渲染前的输入与提交发送旧文本 |
| 移除异步结果的弹窗归属判断 | 115/125 | 拒绝；取消后的重置、切换模型后的基准与重复检测、冲突归属发生回归 |
| 移除保存结果对在途刷新的屏蔽 | 124/125 | 拒绝；迟到刷新覆盖已提交结果 |
| 移除弹窗焦点修复 | 125/125 | 拒绝；真实 Chromium 的 Host review 场景在 1280px、480px 均失败，按钮消失后焦点落到弹窗外 |

6 项保留调整的组合仍通过 125 项测试，以及 19 个浏览器场景：9 个 Pricing
故事各覆盖宽、窄视口，加上 Settings Host 切换故事。基线也通过同样的
19 个场景。最终 Electron 测试通过真实 preload/Main 保存、刷新读取及删除。

在同一机器、固定时钟、隐藏输入光标并关闭动画的截图工具下比较 18 张明暗主题
截图：16 张像素完全一致；Validation 的明、暗截图分别有 12、11 个像素差异
（约 0.001%，限于同一 2×281 区域内的离散像素）。同版本 A/A 复拍也出现
暗色 Validation 同位置的 11 像素差异，其余 17 张一致。已目视检查，无可见
布局变化；未改比较阈值，也不将此次结果记为像素零差异。

最终构建、全工作区类型检查、lint、格式、Desktop/UI knip、严格主线架构检查、
UI 清单、E2E 预算、协议守卫及相关脚本测试均通过。代码精简不增加依赖，
不修改协议编解码或 wire shape。本实验验证行为和视觉回归，不是性能基准。

运行器、各变体补丁、源码散列、逐项日志和截图保留在本地忽略目录
`perf-results/pricing-ablation-20261016/`，不向产品或 CI 增加实验代码。
基线与单项/组合测试清单见其中的 `run.mjs`、`results.json`；浏览器结果见
`baseline.browser.json`、`no-focus.browser.json`、`combined.browser.json`。
已采纳代码的完整差异可相对上述基线提交查看。
