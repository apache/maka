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

# maka-js-runtime

[English](README.md)

提供插件 guest 和持久 JavaScript REPL 共用的 V8 执行机制。`plugin` 负责受限的 guest 执行，`repl` 与 `CodeExecutor` 支持跨调用保留变量的代码单元。嵌入方提供可调用能力并管理其资源；JavaScript Promise 完成不代表它启动的原生工作已完成清理。

嵌套工具调用通过嵌入方的原始执行器传递完整 JSON 参数和结果。代码单元可以消费较大的工具结果并发布简短摘要；完整的单元结果、输出和暂存值受配置的 V8 堆和执行期限约束。已受理的工具工作会被跟踪到清理完成，包括 JavaScript 不再观察其 Promise 的情况。

REPL 超时既计算 JavaScript 执行时间，也计算普通异步等待。可信 Host 可在契约规定不计时的审批或原生等待期间持有 `CellContext::suspend_timeout()` guard。嵌套或并发 guard 全部结束后恢复剩余预算，期间实际执行的 JavaScript 仍然计时。JavaScript 无权暂停计时，取消和堆限制始终有效。

`Repl::new` 在报告中断前等待已受理工作结算，随后需要新建 VM。可信 Host 可通过 `Repl::new_observed` 提供 `ReplAdmission` 接管确认：中断的 VM 关闭新操作入口，等候已登记效果获得持久执行托管或确认拒绝，再发布结果；同一 worker 继续等待原始效果。Host 必须保留该 REPL 并等待 `close()`，以确认结算并接收后续持久化或清理失败。接管确认失败时，仍须在返回错误前等待工作结束。新 VM、原生绑定和资源所有者的创建由嵌入方负责。

[源码](src/lib.rs) · [Cargo 配置](Cargo.toml)
