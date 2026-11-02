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

# maka-agent-engine

[English](README.md)

协调 Agent 运行、模型步骤、工具、移交和恢复。`Engine` 使用显式业务端口与已授权资源，`RunInput` 和 `RunWork` 描述获准工作。模型历史投影与 UI 呈现相互独立。原生 Agent 服务管理激活并委托这里执行；平台 Host 和 UI crate 不依赖本引擎。

续跑保留原运行的输入和已完成历史。重放排除中断的部分输出，以及属于其他提供方路由或模型的思考，不删除规范历史。新的模型步骤使用当前已授权的工具状态。

模型请求在冻结组合的动态上下文中，以 JSON 数据提供当前 Session ID 和已受理的工作目录。Main 请求、摘要和续跑重放使用同一套渲染与计量。分叉会话使用自身 ID。项目迁址后，即使摘要复用了先前请求的静态提示词，也使用当前已受理的目录；先前的请求证据保持不变。

已验证的归档证据保留规范编码和冻结页面。当前模型历史在请求计量与哈希前使用不预设工具名称的续读说明；未选择 Session 工具结果读取工具时，剩余内容不可读取。已密封的交接要求请求投影和工具目录与记录完全一致，因此升级改变其中任一项时可能拒绝该交接。

视觉模型的历史投影按既有 artifact 存储上限读取每张已授权图片的完整内容。复制会话通过目标会话持有的引用解析保留的图片。

[源码](src/lib.rs) · [Cargo 配置](Cargo.toml)
