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

# Native Quick Tools / 原生快捷工具

Migration of `codex/quick-tools` onto `rust-preview` (`72162299f`), developed on
`codex/quick-tools-rust`. Maka's Rust Host owns the services; NSH renders the UI
through its native AppKit backend on macOS. There is no Electron renderer. The optional BrowserMCP
provider runs as an external Node process, owned and cancelled by the Rust shell.

## Run / 运行

```sh
npm ci
cargo build --locked -p maka-cli -p maka-desktop-shell -p maka-host-shell
node scripts/quick-tools/build-native.mjs
node scripts/quick-tools/run.mjs
```

The launcher uses `~/.maka/quick-tools-rust`; pass `--root PATH` for another Root.
Quick Tools data lives under `clients/default/quick-tools`. It does not implicitly
read the old Electron profile or copy model credentials. Configure a model in the
native application before testing real assistant predictions or AI ranking.

## Migrated implementation / 已接入代码

- Persistent, separate AppKit NSPanel hosting an NSH view, Option+Space global toggle, configurable global
  and per-item shortcuts. Command reveals numeric hints; Command+1–9 executes rows
  or actions. Arrow navigation, Command+K action menu, aliases, favorites, recent
  usage, ICU Chinese segmentation and BM25F search.
- Quicklink URL parameters and literal file paths; local notes, snippets, symbols,
  calculator, applications with icons and transliteration, Spotlight file search.
- Main application locale and theme integration. Chinese and English copy,
  Up/Down input history, Tab acceptance and faint inline completion. Native
  assistant composer also recalls its own input history inside the Quick Tools panel.
- Independent assistant pane using the real native conversation/composer. A session
  handoff saves drafts before another window takes ownership. Unread indication
  observes Host-owned read state. Ranking is a journaled auxiliary model request
  with cancellation, bounded output and no tools or transcript messages.
- Private atomic JSON storage, 40 MiB clipboard content budget, seven-day/300-item
  retention, 4 MiB PNG limit. Observation remains opt-in. Password-marked/transient
  clipboard data is excluded. Safe paste targets the original invoking PID.
- Bounded local action trace containing identifiers/outcomes, not clipboard content,
  query text or URLs. Trace failures do not retry an already executed action.
- Chrome native-messaging bridge without Electron. BrowserMCP/OpenCLI and Bilibili
  use declared read-only adapters or fixed GET endpoints; live adapter access/domain
  is checked before use. Requests have concurrency limits, cancellation and cleanup.
- Native screenshot editor: rectangle, ellipse, arrow, text, mosaic, undo, copy,
  save and floating pinned image windows; export preserves original pixel dimensions.
- Package preview, install/update, rollback and uninstall. External CommonJS bundles
  execute in bounded V8 isolates with manifest-scoped services and per-plugin data.
  Old worker handles cannot borrow a replacement's permissions. Disabled plugins
  do not start; enabling reloads them. Removing a package preserves its data.

### Plugin compatibility

Bundle format remains `{format:1, manifest, code}`. Bundle dependencies into the
CommonJS artifact and use `context.call` for system services. The native sandbox
has no ambient Node filesystem/process APIs or timers; `crypto.randomUUID` is
provided through a bounded native UUID pool. Built-in plugins use native adapters.
The legacy Jev-specific ranker route has not been ported; native ranking uses the
personal assistant's configured model.

## Import / 旧数据导入

Close the native application before applying. Dry-run is the default:

```sh
node scripts/quick-tools/import-legacy.mjs \
  --source '/path/to/old-profile/quick-tools' \
  --destination "$HOME/.maka/quick-tools-rust/clients/default/quick-tools"
# Add --apply after reviewing the dry-run.
```

Imports preferences, aliases, shortcuts, input history, plugin data and external
packages with their previous versions. Bundled tools use the migrated native
implementations. Package digests are verified before writes; existing native
values take precedence. Originals remain untouched and overwritten native files
are backed up inside `import-backup-*`. Model credentials and old conversations
are outside this import.

## Verification / 验证

```sh
node --test products/maka/workbench/tests/quick-tools.test.mjs
cargo test --locked -p maka-workbench --lib
cargo test --locked -p maka-desktop-shell quick_tools
cargo test --locked -p maka-agent-native --lib ranking_cannot_introduce_an_action
```

The native headless test mounts the actual panel, creates a Quicklink, installs a
CommonJS package through the real installer UI, executes it in V8, verifies its
persistent data and switches the interface language. Other tests cover scoped VM
services, clipboard storage bounds/permissions, Chinese search, package rollback,
legacy import integrity, history, link expansion and browser adapter validation.
The CI contracts suite includes the Quick Tools JavaScript tests; UI/script inputs
participate in product and native build routing. Regenerate SDK contracts after
changing native API shapes; `maka-workbench`'s `ui_types` example produces NSH types.

实机已验证独立浮窗唤起、快速输入后回车进入 Quicklink、浮窗助手加载，以及草稿从
浮窗交接到主窗口。复用旧开发版当前模型后，真实工具排序与助手输入建议生成均成功；
浮窗中已验证建议显示及 Tab 回填（未发送）。重启后主窗口、浮窗及插件名称均显示中文，
助手新消息提示可见。独立双窗口回归覆盖语言、明暗主题及配色双向同步；客户端测试
覆盖排序操作的持久化托管与恢复提示过滤。完整验收仍未结束：浏览器实际连接、截图
编辑/置顶交互、全局快捷键冲突处理、主题实机切换及未读完整生命周期还需要实机回归。
因此不能把所有“代码已接入”视为“旧版全量对等已验收”。

界面整理：原生浮窗直接使用窗口内容区，取消内嵌弹窗的灰色遮罩与重复边框；
搜索头与助手导航使用统一图标按钮，结果行固定图标/正文/快捷键列，设置呈现插件
说明及版本，表单去除无关快捷键入口。已实机检查首页、设置、Quicklink 表单与助手页。

旧版交互对照（2026-11-06）：结果改为单击选中、双击/Enter 执行，单行显示名称与
插件来源，详情/图片使用右侧预览；操作菜单恢复独立搜索浮层、方向键与筛选后的
Command 数字执行。表单取消保留草稿，条目设置合并别名、快捷键录入和收藏；插件
详情可展开权限与版本操作。首页 680×400、设置/表单及助手 680×560。
键盘选择自动滚动，用户导航后锁定模型排序；菜单关闭恢复输入焦点，清空历史重置
遍历状态。全局快捷键可停用并恢复上次组合。原生回归覆盖草稿恢复与筛选后的设置
保存；24 项工作台测试及 9 项 Node 测试通过。范围仍不等于所有外部集成已完成验收。

本轮实机复核（深色、中文）：首页/操作浮层/条目设置/插件设置布局正常；操作搜索
输入“设置”后 Command+1 正确执行筛选后的首项；插件权限展开正确翻译。原生键位
注册发现并修复 macOS 保留的 Option+Command+H，录入器通过 Tab 聚焦后可记录
Control+Option+J；随后补上鼠标点击显式聚焦，取消测试组合未写入用户配置。

补齐辅助功能设置直达入口与安装预览弹层。

助手未读已接入 Rust Host 的 SendUser 消息序号与持久化已读位置：显示数量（超过
99 显示 99+）、单行预览，并在首页空查询时优先展示未读助手。内部推理及工具输出
不计入通知。markBotRead 只确认界面实际观察到的序号，拒绝超出消息尾部的回执，
旧回执不倒退已读位置，也不清掉新到达的消息。主窗口和快捷工具共用前台/消息底部
可见性判断；快捷工具修正为监听自身窗口激活状态，避免复用主窗口的前后台状态。
助手页恢复旧版快捷入口布局：顶部与快捷工具首页共用搜索栏样式，下面按消息从新到旧排列紧凑气泡，
最新回复在对应问题之前；隐藏主应用标题栏、执行过程标签、底部输入卡片及工具栏。
保留共用的发送、草稿、历史与建议逻辑，Esc 返回列表。实机确认顶部草稿、紧凑气泡、
助手头像和返回后草稿保留；本轮通过 24 项工作台及 10 项快捷工具测试、类型检查和原生构建。
实机确认 1 条未读及预览、进入助手后清零、重启后仍为已读、已有草稿保留；回归包括 26 项原生 Bot、
24 项工作台、30 项消息/快捷工具 Node 测试及 1 项已读请求托管测试，SDK 校验通过。
