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

# maka-skills

[English](README.md)

解析 SKILL.md，发现技能来源，并准备所选指令和资源。`Catalog` 提供发现接口，`PreparedInvocation` 表示一次准备好的使用。`build.rs` 组装内置资源，包括插件开发 skill 及匹配的 SDK 源码。技能文本属于数据，其中的工具名和引用不会授予执行权限。

内置技能及 SDK 文件在 `build.rs` 中逐项列出；新增文件时须更新清单，本地缓存不会被打包。源码示例从固定目录的顶层 TypeScript 文件中选取。

不可变的内置文档与资源内容只准备一次，并在多次发现中共享。发现会捕获完整目录及其包含的资源；模型元数据保留精确来源引用，并可分页读取完整内容。文件系统来源仍通过当前请求的能力重新捕获。

相同 `SKILL.md` 名称的技能按项目 `.maka`、项目 `.agents`、用户 `.maka`、用户 `.agents` 的顺序选择。文档与资源始终来自同一个目录。低优先级实例保留在清单中并标明覆盖来源；删除高优先级实例后，下一级自动生效。

[源码](src/lib.rs) · [Cargo 配置](Cargo.toml)
