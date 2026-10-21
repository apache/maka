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

# Maka npm launcher

[English](README.md)

**`rust-preview` 是独立的实验性预览分发，不是 Apache 软件基金会正式发行版，也未经 ASF 批准、背书或支持。**

```sh
npm install --global @maka-agent/cli@rust-preview
```

启动器选择匹配的原生可执行文件，转发参数、标准 I/O 和退出状态。精确版本的可选依赖携带 CLI、`maka-desktop-shell` 及其相邻的 `app/` 应用目录；macOS 上 shell 和 app 位于 `Maka.app` 内。预览版支持 macOS arm64、使用 glibc 的 Linux x64 和 Windows x64。WSL 使用 Linux 可执行文件，通过匹配的 Windows helper 提供 Computer Use。

`latest` 标签仍为空占位包，包括独立的 `maka-agent` 包；它们没有 CLI、运行时、依赖或安装脚本。占位源码见 [placeholder](placeholder/README.md)，预览产物必须使用 `rust-preview`。

运行 `maka` 启动终端产品。首次启动确认工作区，之后重新打开保存的安装。配置和显式组合命令见[产品指南](../../products/maka/bundle/README.zh-CN.md)。

通过 `maka desktop --root HOST_ROOT` 启动桌面。这个必填路径选择业务 Host：缺失的 Root 初始化为标准只读 Host，已有 Root 使用已保存的部署。启动器在 shell 退出前保留经过校验的 Host 客户端；其他已连接客户端会继续保留 Host。打包的 shell 从可执行文件旁加载 app，不依赖工作目录。直接开发命令见 [desktop-shell](../../products/maka/desktop-shell/README.zh-CN.md)。

## 构建与发布

通过 `just source <version>` 从已提交修订创建源码候选包。各平台使用同一归档构建：

```sh
just package <source.tar.gz> <target> <build-id> native-preview
```

收集三个平台的原生包与回执，以及源码归档和 SHA-512 文件，然后执行：

```sh
just release-prepare native-preview
just release-check native-preview
just publish native-preview
```

`release-check` 离线安装并运行已准备产物，每个目标平台都要执行。发布先上传原生组件，再上传启动器，并验证频道标签。中断后重试相同产物。npm 标签不支持条件更新，每个频道同时只运行一个发布者。

[发布工作流](../../.github/workflows/npm-publication.yml)以 `publish=false` 构建和验证。非官方发布在 `M4n5ter/maka-agent` 的 `feat/runtime-host-rust` 分支运行，需要显式 `publish=true`，使用独立 `npm-rust-preview` 环境，不从 ASF 仓库发布。

依赖、V8 缓存和 notices 见[原生构建工具](../../scripts/rust/README.zh-CN.md)；归档校验与签名见[源码发布](../../.github/ASF_SOURCE_RELEASE.md)。
