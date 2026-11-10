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

# maka-assistant

[English](README.md)

实现指令、提示词、回忆和待办事项等助手策略。各模块管理自己的领域数据，通过 Agent 端口提供操作；UI 包单独负责呈现。待办的变更属于业务状态变化，本身不会授权执行，也不能证明任务完成。

[源码](src/lib.rs) · [Cargo 配置](Cargo.toml)
