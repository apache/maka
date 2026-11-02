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

# maka-goal

[English](README.md)

管理持久目标、进度、执行时间、token 统计与原始操作回执。`goal` 负责状态转换和存储，原生 Agent 复用现有会话队列执行。目标不设固定迭代次数或内容字节上限。可选 token 预算在观测用量达到阈值后停止安排下一轮；缺失计量如实展示，不会结束目标。工具、控制和恢复见[原生 Agent](../native/README.zh-CN.md)。

[源码](src/lib.rs) · [Cargo 配置](Cargo.toml)
