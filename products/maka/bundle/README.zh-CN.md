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

本目录选择 Maka 分发的业务 Host 包，并将其绑定成一个 Agent/WorkHub 来源。插件声明与实现位于 [plugins](../../../plugins/README.zh-CN.md)。

- [package-inputs.json](package-inputs.json)选择参与构建的包。
- [src/composition.ts](src/composition.ts)构造实例、绑定和安装身份。
- [scripts/build.mjs](scripts/build.mjs)将包内容与组合生成代码输出到 `dist`。

## 运行与开发

在仓库根目录运行：

```sh
just run
just run --root /path/to/business-host
```

`just run` 打开 [NSH 终端工作台](../terminal-shell/README.zh-CN.md)，默认使用 `~/.maka/application/host`。它连接已有 Host，不存在则自动启动。下文的编写命令独立生成和管理插件组合。

终端和桌面 shell 运行同一个工作台，连接这个业务 Host；bundle 不再安装展示层或独立管理 Host。[更新已选插件包](../cli/README.zh-CN.md#产品更新恢复与-url-安装)会保留现有 Host 组合与原生授权。

CLI 的所有构建（包括 debug）都会嵌入当前 TypeScript bundle；修改插件源文件后需重新构建 CLI。`just product` 生成供检查和导出的独立 bundle，不会替换已有二进制内的资源。构建根据组合生成代码及具名包的精确字节生成 `product-version.txt`；安装与更新会校验实际包字节是否匹配该标识。bundle 输出是生成产物：修改源文件后重新构建，不要直接编辑输出文件。标识缺失、格式错误或内容不匹配时需要重新构建。需要与开发构建同时生成产物时，使用独立输出目录：

```sh
node products/maka/bundle/scripts/build.mjs --output ~/.cache/maka/product-export
```

## 生成安装配置

CLI 可以生成经过校验的配置和包，运行时无需 Node：

```sh
maka application compose --configuration installation.json --output product-source
```

输出目录必须不存在。命令生成 `host.json`、`endpoints.json`、`native-grants.json`、记录完整身份的 `installation.json` 及 `.maka-plugin` 包，不安装或启动它们。

`installation.json` 选择 `locale` 和服务配置。它使用生成的 `AgentConfiguration`；可选 `coordinator` 会在同一 Host 中加入 WorkHub 服务。可选服务和 ACP 执行器需要显式选择。支持字段见[配置](src/composition.ts)和 [SDK 类型](../../../packages/plugin-sdk/src/generated/runtime.ts)。

重新生成已有安装时，保留输出的 `keys` 和 `hostDeployment`，它们标识已有所有者及数据。包修订标识内容，可以独立变化。

显式安装时，先用 `maka host init` 初始化目标 Host Root，再用 `maka application commit` 提交 `host.json`，提供部署 ID、预期修订和导出的包。通用来源命令也支持独立于默认产品的自定义插件组合。各命令的 `--help` 列出必要参数。

提交只保存预期来源和包内容，不激活或选择该部署。运行 `maka application serve` 时传入输出的 `hostDeployment`、`--endpoints product-source/endpoints.json` 和 `--native-grants product-source/native-grants.json`；其余参数见 `--help`。`maka --root HOST_ROOT` 和 `maka desktop --root HOST_ROOT` 使用 Host Root 保存的选择。

## 验证修改

```sh
npm --workspace @maka-agent/product run typecheck
npm --workspace @maka-agent/product test
MAKA_PRODUCT_CLI_CHECK=1 npm --workspace @maka-agent/product test
```

测试只构建一次，再检查 Host 包声明、业务组合与通用 SDK scene schema。设置 `MAKA_PRODUCT_CLI_CHECK` 后，还会使用实际 CLI 检查包和组合。原生渲染、焦点和输入变更由对应 shell 的测试验证。
