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

# maka-scheduler

[English](README.md)

提供定时任务时间、cron／时区计算、漏触发策略，以及 `TaskPlan<E, A>` 的认领、结算和编辑纯领域规则。Agent 所有者提供效果与审批类型，在自身 Root 中持久化计划，并经共享的持久 Run driver 提交执行。冻结的 Fire 数据在恢复时保留原投递身份，本身不授予执行权限。

[源码](src/lib.rs) · [Cargo 配置](Cargo.toml)
