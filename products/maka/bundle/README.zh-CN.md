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

# 产品打包与组合（Product Bundle）

[English](README.md)

`products/maka/bundle/` 选取内置[业务插件](../../../plugins/README.zh-CN.md)与默认 [`maka.workbench`](../workbench/package.ts) 界面包，生成内嵌于 `maka` 二进制的产品基线部署：

- [`package-inputs.json`](package-inputs.json) — 纳入默认发行版的插件源码路径清单。
- [`src/composition.ts`](src/composition.ts) — 默认服务实例图、导入导出绑定与稳定实例 UUID。
- [`scripts/build.mjs`](scripts/build.mjs) — 编译 NSH 界面模块、生成 `.maka-plugin` 包字节流与 `product-version.txt` 至 `dist/`。

## 安装基线与平滑升级

默认安装将锁定的 `maka.product.installation` 基线保存在 `input.base` 中，用户的个性化改动保存在 `overrides`，额外安装的独立插件保存在 `input.instances`。展开 `base` 不会引入额外的命名空间前缀，因此升级产品版本时既有会话与插件数据保持原归属不变。

Host 启动自检与 `maka application update-defaults` 共用同一套基线升级校验：替换基线包的同时完整保留用户的显式 `overrides`：

- `configurationFields` 记录精确到对象字段路径的修改（省略 `value` 代表删除字段，显式 `null` 则保留为 JSON `null`）。
- `configuration` 整体替换顶层配置项（工具列表等数组按整表替换，不按名称隐式合并）。
- `remove` 用于移除继承的默认实例；`input.ui`（或 `base.ui: null`）可替换或关闭默认的 `workbench-ui` 根界面。

## 导出与手动编排部署

`maka-cli` 构建时会自动内嵌最新产物。若只需单独导出产物目录供检查（不编译完整 CLI）：

```sh
just product --output ~/.cache/maka/product-export
```

运行时无需 Node.js，可直接用 `maka application` 编译单个 NSH 界面入口，或由 `installation.json` 生成完整部署目录：

```sh
maka application build-ui --entry ui/index.tsx --output ui-build
maka application compose --configuration installation.json --output product-source
```

`compose` 会在新目录输出 `host.json`、`endpoints.json`、`native-grants.json`、解析后的 `installation.json` 实例键以及 `.maka-plugin` 包。重新生成已有安装的部署时务必保留原 `keys` 与 `hostDeployment`，以免状态切到新实例。随后可通过 `maka host init`、`maka application commit` 与 `maka application serve` 初始化并启动目标 Host（详见各子命令 `--help`）。

## 验证

```sh
npm --workspace @maka-agent/product run typecheck
npm --workspace @maka-agent/product test
cargo nextest run --locked -p maka-cli --test integration -E 'test(product_composition::)'
```
