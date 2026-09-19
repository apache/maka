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

# Composer session 切换与窄窗口布局问题

## 问题概述

切换 session 时，composer 的外壳通常保持挂载，但一批按 session 派生的状态会同时更新：模型、provider icon、thinking level、permission mode、plan/orchestration 状态、草稿和运行状态。模型选择器内部还按 session 使用 key，因此 selector 子树会重新挂载。结果是 footer 发生多次 render、layout 和 repaint，icon 与 chip 会出现明显重拍。

当右侧 side panel 打开或可用宽度变窄时，问题会进一步表现为布局溢出：composer card 已经缩窄，但 footer 内部仍可能按内容宽度计算，branch chip 或其他工具控件被推出 card 的右边界。

## 代码依据

- `ChatComposerRegion` 和 `Composer` 没有按 session 设置 key，普通 session 切换主要是保留实例后的重渲染与重新布局。
- `ChatModelSwitcher` 内部的 `Selector` 使用 `${activeSession.id}:${openNonce}` 作为 key，session 切换会重挂载 selector。
- composer 的 draft 在 `useEffect` 中按 `draftKey` 恢复，可能在首次绘制后再次改变输入值和高度。
- `.maka-composer-left-controls` 虽然设置了 `min-width: 0` 和 `flex-wrap`，但主 composer 的 footer 容器没有明确落实“左侧可收缩、发送按钮固定”的布局契约。
- `.maka-model-selection-controls` 内的 model、thinking、usage、git branch 控件在窄宽度下仍可能以 intrinsic width 叠加。
- side chat 路径有额外的 footer shrink 规则，主 composer 路径没有完全复用同一约束。

## 本 PR 处理范围

1. 保留 composer 外壳和输入 DOM，避免 session 切换造成不必要的 composer 级别 remount。
2. 将 selector 的 session 隔离范围缩小到真正需要隔离的 popup 或交互状态，避免整个显示控件因 session key 重挂载。
3. 为主 composer footer 建立明确的可收缩布局：左侧工具区使用 `minmax(0, 1fr)`，发送按钮保持固定槽位。
4. 让 model/thinking/usage/branch 控件保持单行并按优先级收缩或省略，确保 side panel 打开时不越过 composer 右边界。
5. 将 session draft 恢复调整到不会产生旧草稿一帧闪现的时机，并回归 caret/focus 行为。
6. 为 conversation 区域保留 520px 最低可用宽度；当前内容区不足时停止继续压缩 conversation，Workbar 的展开状态仍只由用户控制。
7. 权限 boundary 重新读取时保留权限按钮的固定槽位和视觉强度；按钮保持禁用，直到目标 session 的 authority 返回。
8. live context usage 快照携带 session、model 和 provider 归属；切换首帧不得把上一个目标的使用量显示到新 session。
9. usage 明确区分 pending、available 和 unavailable；切换读取期间保留按钮和紧凑的最小宽度数值槽位，不用展示层缓存历史 usage。

## Workbar 宽度语义

- 520px 是 conversation 网格的最低宽度，由 CSS 变量统一定义。
- 宽度不足时不自动展开、收起或覆盖 Workbar；面板状态继续使用现有的 session layout 和 localStorage 语义。
- conversation 与展开的 Workbar 所需总宽度超过窗口时，布局保持最小宽度并由外层处理溢出，不继续压缩内部控件。
- 右侧 Workbar 保持右侧布局；底部 Workbar 只由明确的 bottom placement 驱动，不再按 viewport 宽度把整个右侧 Workbar 搬到底部。

## 不在本 PR 范围内

- transcript virtualizer 的 session 级测量缓存；
- transcript 切换的淡出、骨架屏或其他主列过渡动画；
- transcript scroll authority 的整体设计调整；
- 与 composer 无关的连接快照、usage 或 session 数据加载重构。

## 验收条件

- 在两个已有 session 之间快速切换时，输入框 DOM 和 composer 外壳不重挂载；model selector 不因显示值更新而整体重建。
- 从侧栏切换 session 时，打开的 model selector 由既有 light-dismiss 关闭；trigger 不通过临时 read-only 状态制造额外绘制。
- provider icon、model label、thinking selector 和 branch chip 不出现明显的二次跳动。
- 权限按钮在 boundary 读取期间不卸载、不淡出，且在 authority 返回前不能触发权限写入。
- 使用量只显示属于当前 session/model/provider 的快照，不出现旧百分比、占位文本、新百分比的三段闪烁。
- usage 读取期间显示紧凑、等宽的中性占位，不先显示“用量”；按钮和图标不重挂载，查询完成后再显示百分比或明确的无数据状态。
- 打开右侧 side panel 或使用长 branch/model 名称时，composer 保持单行，右边界和发送按钮始终在 conversation 区域内。
- conversation 不被右侧 Workbar 压到 520px 以下；空间不足时 Workbar 保持用户选择的展开状态。
- 工具栏在空间不足时采用明确的截断策略，不换行、不覆盖发送按钮。
- 新旧 session 草稿、焦点、输入法组合和 model picker 打开状态不串 session。
- 现有 composer、side chat、draft caret/focus 相关测试通过，并增加至少一个窄宽度布局回归场景。
