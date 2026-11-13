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

# Workspace plugins

[English](README.md)

工作区服务可以独立于 Agent 引擎组合。每个叶声明选择原生提供方，UI 调用方按需绑定契约。

- [Files](workspace-files/native/README.zh-CN.md)使用文件[引擎](workspace-files/engine/README.zh-CN.md)和纯[补丁解析器](workspace-files/patch/README.zh-CN.md)。
- [Processes](workspace-processes/native/README.zh-CN.md)管理命令、终端和协议进程。
- [Web](workspace-web/native/README.zh-CN.md)提供抓取与搜索，[API crate](workspace-web/api/README.zh-CN.md)包含声明。
- [Decisions API](workspace-decisions-api/native/README.zh-CN.md)提供结构化评估[引擎](workspace-decisions-api/engine/README.zh-CN.md)。
- Computer Use 通过[原生提供方](workspace-computer/native/src/lib.rs)提供 `cua_repl` 和 `cua_reset`。每个会话需要显式授权，权限边界变更会使授权失效；Explore 模式不能操作电脑。REPL 变量和目标绑定保留到重置或 Host 关闭，会话授权则在重启后保留。桌面与浏览器连接由提供方配置选择。

共用 [API](api/README.zh-CN.md)定义工作区契约，[support](support/README.zh-CN.md)处理已配置根目录、路径解析和私有路径排除。服务显式接收资源限制与权限，请求 JSON 中的路径不能扩大它们。

Files 与 Processes 对执行前确定的 Host 权限拒绝返回 `permission_denied`，保留目标权限、命令和原因，区分禁止申请、用户明确拒绝、保护边界、批准不足及授权失效。取消和观察失败使用独立错误。进程状态及退出证据与权限原因分开表达；仅 stderr 中出现 `EPERM` 不构成沙箱拒绝的证据。
