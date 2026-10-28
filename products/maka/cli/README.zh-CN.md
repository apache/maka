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

# maka-cli

[English](README.md)

构建 `maka` 可执行文件，负责终端产品启动、Host 服务、ACP，以及应用检查、组合和安装命令。产品启动将原生工厂和 JavaScript 执行适配器接入平台所有者。

在仓库根目录执行 `just run` 或 `just run --help`。Cargo 构建当前选中的插件和工作台，并将其嵌入 debug 与 release 二进制。桌面端使用独立的同目录可执行文件。

[源码](src/main.rs) · [Cargo 配置](Cargo.toml)

运行 `maka` 或 `maka terminal-shell` 打开 [NSH 终端工作台](../terminal-shell/README.zh-CN.md)。两者默认使用 `~/.maka/application/host`，支持 `--root DIRECTORY` 和 `--session SESSION_ID`。Host 发现、启动、界面和终端清理均在同一个 `maka` 可执行文件中运行。启动时连接已有 Host，不存在则自动启动；终端与桌面客户端可以共享 Host。在界面中选择工作区和模型。不支持图片的终端使用 Unicode 渲染。

`maka --help` 列出 CLI 命令和默认终端参数，`maka terminal-shell --help` 单独查看终端参数。交互入口要求 stdin 和 stdout 都连接终端；任一被重定向时，在打开或创建 Host 前报错退出。自动化使用显式 Host、application、Code 或 ACP 命令。

`host serve` 和 `application serve` 输出的 JSON `ready` 行包含 `rootId`、`hostEpoch` 和 `socketPath`。接入时使用该 epoch，并核对实际 Host 身份。Unix socket 位于系统选择的临时目录下的私有子目录中，可通过 `TMPDIR` 指定其他父目录。规范化后的 socket 路径须满足可移植的 100 字节上限；若启动报告路径过长，请选择更短的父目录。

无界面命令（`host`、`application serve`、`code` 和 `acp`）在运行时初始化前安装进程日志订阅器。警告和错误（包括 SQLx 慢查询警告）写入 stderr，不带 ANSI 样式；stdout 保留给命令结果和协议帧。默认不输出普通 DEBUG 查询日志。交互式产品仍自行管理终端输出。

独立 Host 将 stderr 捕获到所属 Root 的私有控制缓存文件 `host.stderr.log`：按需启动在创建进程前接好捕获文件，前台服务在选定 Root 后开始捕获。使用 `maka host logs --root-id ID` 读取，添加 `--follow` 持续接收 NDJSON，添加 `--after CURSOR` 从游标续读。每页以 Base64 保留原始字节，并报告尚无捕获文件、文件替换或截断；清理控制缓存也会删除这些日志。读取不要求安装系统服务。

使用 `maka inspect --root DIRECTORY --session SESSION_ID` 查看会话已提交的执行日志。

## 产品更新、恢复与 URL 安装

组合命令读取完整的 JSON 来源和远程导出文件。插件组合编辑器按最多 64 KiB 的 UTF-8 分页加载指定来源版本，并基于该版本保存已确认的原生编辑器快照。整份文档没有独立字节上限；类型校验、包校验、Host 权限、版本冲突和实际资源准入仍然生效。已提交版本保留完整来源，供后续读取和重新打开 Root 使用。

Host 启动前会自动更新已选的内置插件，复用 `update-defaults --apply` 的校验和恢复流程。打开界面时会通过管理端点检查已运行的产品 Host。启动器拥有的临时 Host 遇到可用的代码或内置插件更新时，会关闭已有连接、结束后台任务和终端，并等待清理完成后启动新 Host。已安装的服务和显式选择的应用 Host 仍只在空闲时更新。包已是当前版本时不会新增来源修订。更新与已保存配置不兼容时，启动会报告错误并保留原来源，修正配置后可重新启动。

要预览或显式更新已停止的独立 Host，请指定它的 State Root：

```sh
maka application update-defaults --root /path/to/host
maka application update-defaults --root /path/to/host --apply
```

先检查预览中的具体包版本。执行更新会将组合中显式选择、且 ID 与当前可执行文件所带插件匹配的包替换为发行版本，包括使用相同 ID 的本地修改包。其他包、组合设置、权限和业务数据保留，不自动添加新的默认组件；组合校验失败时拒绝更新。中断后再次执行 `--apply` 完成同一次更新，再启动 Host。此命令更新应用包；`host upgrade` 更新原生可执行文件。

`update-defaults` 要求当前可执行文件能够解码已有的包记录。包含已移除内部格式（例如旧 `desktop` surface）的 Root 会在预览前失败；保留原 Root，另行初始化新的 Root。

直接安装插件包前需要停止所选 Host。`update-defaults` 和 `install-url` 默认使用 `~/.maka/application/host`；可用 `--root DIRECTORY` 选择其他 Host。

```sh
maka application install-url --url https://example.com/plugin.maka-plugin
```

`install-url` 接受 HTTP(S) `.maka-plugin` 包的直接下载链接，限制下载大小和时长、校验整包摘要，并保存不可变版本。之后在插件组合编辑器中启用。可用 `--sha256 HEX` 验证发布者提供的包摘要、`--expected-revision N` 指定预期源码版本，或用 `--deployment UUID` 选择独立提交的部署。下载遵循进程的代理环境。运行中的插件安装页面也通过绑定的 Host 部署管理器支持 URL 安装。
