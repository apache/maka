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

# Product bundle

[English](README.md)

本目录选择 Maka 分发的 Host 与 UI 插件包，并将其绑定成一个 Agent/WorkHub 来源。插件声明与实现位于 [plugins](../../../plugins/README.zh-CN.md) 和[默认工作台包](../workbench/package.ts)。

- [package-inputs.json](package-inputs.json)选择参与构建的包。
- [src/composition.ts](src/composition.ts)构造实例、绑定和安装身份。
- [scripts/build.mjs](scripts/build.mjs)将包内容与组合生成代码输出到 `dist`。

默认安装提供 `ModelList` 工具，与设置界面共用模型目录。以 `{ "kind": "start", "query": "...", "connectionId": "..." }` 开始查询（两个筛选项均可省略）。每项包含可直接用于 `SessionSend` / `SessionResume` 的 `selection`、支持与默认推理档位，以及有效限制。使用 `{ "kind": "continue", "revision": page.revision, "cursor": page.next }` 翻页；目录变化时重新查询。仅列出已启用连接中已启用且受运行时支持的模型，不保证远端连通性、凭证或额度可用；结果不包含凭证、URL 或请求覆盖内容。

侧栏会话菜单中的**子会话**在独立、适应窗口大小的弹窗中显示后代树。展开箭头按需读取直接子会话，跨工作区且包含归档会话；点击标题打开对应会话。树沿用不可变的 `parentSessionId` 创建关系，而非 fork 的历史来源。深层树可横向滚动，长分支通过现有会话目录分页加载。

## 运行与开发

在仓库根目录运行：

```sh
just run
just run --root /path/to/business-host
```

`just run` 打开 [NSH 终端工作台](../terminal-shell/README.zh-CN.md)，默认使用 `~/.maka/application/host`。它连接已有 Host，不存在则自动启动。下文的编写命令独立生成和管理插件组合。

终端和桌面 shell 加载同一个已选 NSH 根 UI；Host 服务、UI 插件和组合节点由同一部署来源管理。UI 包可以提供完整应用的根界面、命令、面板、设置页和工具结果组件。安装表示用户信任，插件直接使用共享 VM 与现有客户端能力。[更新已选插件包](../cli/README.zh-CN.md#产品更新恢复与-url-安装)会保留现有 Host 组合、根界面选择与原生授权。

UI 实例可将声明的服务导入绑定到同一来源中的 Host 提供者。`UiContext.services` 和 `operations` 使用 UI 消费者的实际会话与原始 receipt，同时保留可信代码可用的完整 `UiContext.host`。一个包可以同时分发后台与 UI，无需为每个内部服务额外发布客户端端点。

CLI 的所有构建（包括 debug）都会嵌入当前 TypeScript bundle；修改插件源文件后需重新构建 CLI。`just product` 只构建轻量的 `maka-ui-build` 工具，再导出供检查的独立 bundle，无需构建产品 CLI；修改导出结果不会改变嵌入的资源。构建根据组合生成代码及具名包的精确字节生成 `product-version.txt`；安装与更新会校验实际包字节是否匹配该标识。bundle 输出是生成产物：修改源文件后重新构建，不要直接编辑输出文件。标识缺失、格式错误或内容不匹配时需要重新构建。需要与开发构建同时生成产物时，使用独立输出目录：

```sh
just product --output ~/.cache/maka/product-export
```

UI 入口使用 NSH 编译器构建为独立 ES 模块，图片等资源保留在同一个不可变包内。Cargo 构建先发现声明中的 UI 源文件，再直接调用编译器，不嵌套运行 Cargo。`just product` 和 workspace 的 npm build/test 命令使用 Cargo 返回的精确编译器路径。单独使用 Node 插件包构建器时，也会在需要编译 UI 时构建这个轻量工具；`MAKA_UI_BUNDLER` 可指定已有的 `maka-ui-build` 可执行文件。

单独编译一个 NSH UI 模块：

```sh
maka application build-ui --entry ui/index.tsx --output ui-build
```

输出的 `manifest.json` 描述 `bundle.js`、资源文件与源文件依赖；包构建器将它们放到 `application.ui.module` 及对应的包内资源路径。

默认产品选择普通 UI 包 `maka.workbench`，实例为 `workbench-ui`，在 `host.json` 中声明 `ui: { path: ["workbench-ui"], id: "root" }`。其导入绑定到产品实际选择的 Agent、设置等服务。包构建器通过所有 UI 包共用的编译器，将 `app/App.tsx` 编译为声明的 `app/App.js` 入口。

## 生成安装配置

CLI 可以生成经过校验的配置和包，运行时无需 Node：

```sh
maka application compose --configuration installation.json --output product-source
```

输出目录必须不存在。命令生成 `host.json`、`endpoints.json`、`native-grants.json`、记录完整身份的 `installation.json` 及 `.maka-plugin` 包，不安装或启动它们。

`installation.json` 选择 `locale` 和服务配置。它使用生成的 `AgentConfiguration`；可选 `coordinator` 会在同一 Host 中加入 WorkHub 服务。可选服务和 ACP 执行器需要显式选择。支持字段见[配置](src/composition.ts)和 [SDK 类型](../../../packages/plugin-sdk/src/generated/runtime.ts)。

重新生成已有安装时，保留输出的 `keys` 和 `hostDeployment`，它们标识已有所有者及数据。包修订标识内容，可以独立变化。

使用其他应用时，为其 UI 包加入 `usePackage: "ui"` 的实例，并将来源的 `ui` 设为该实例路径及声明的 `root` 贡献 ID。这会选择整个应用，包括导航、布局和交互。默认 Maka 根界面只在首次编写产品来源时选择；安装、更新和启动保留已保存的选择。没有根入口的来源不提供 UI，shell 不会回退到 Maka。自定义根界面也可运行于不含 Agent 服务的自定义 Host。

显式安装时，先用 `maka host init` 初始化目标 Host Root，再用 `maka application commit` 提交 `host.json`，提供部署 ID、预期修订和导出的包。通用来源命令也支持独立于默认产品的自定义插件组合。各命令的 `--help` 列出必要参数。

提交只保存预期来源和包内容，不激活或选择该部署。运行 `maka application serve` 时传入输出的 `hostDeployment`、`--endpoints product-source/endpoints.json` 和 `--native-grants product-source/native-grants.json`；其余参数见 `--help`。`maka --root HOST_ROOT` 和 `maka desktop --root HOST_ROOT` 使用 Host Root 保存的选择。

## 验证修改

```sh
npm --workspace @maka-agent/product run typecheck
npm --workspace @maka-agent/product test
```

npm 测试使用轻量编译器，检查完整的 Host/UI 包与工具展示声明。`cargo test --locked -p maka-cli --test integration product_composition::` 通过实际 CLI 验证业务组合，运行时无需 Node。原生渲染、焦点和输入变更由对应 shell 的测试验证。
