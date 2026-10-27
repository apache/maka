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

# maka-plugin-core

[English](README.md)

定义包声明、契约以及同时包含 Host、UI 和组合实例的单一部署源。`plan` 校验整个图及稳定身份；`runtime` 管理 Host 注册、UI 消费者绑定、已接纳工作与退役。客户端从同一部署源取得已启用的 UI 实例，在共享 NSH 运行时中运行。Host Runtime 不执行 UI 代码。

包可声明 `host`、`ui` 和／或 `composition`。每个源节点通过 `usePackage` 明确选择一种；仅安装包不会启用它。UI 入口声明 NSH 模块、服务导入以及根、命令、面板、设置页或工具展示贡献。UI 消费者注册负责解析服务导入。

`Input.ui` 是部署唯一的产品根选择：`{path, id}` 指向一个已启用的 UI 实例及其 `UiContribution::Root` 贡献。`None` 表示无界面运行。`Template` 定义可复用的实例图，不拥有产品根。任意 UI 包都可提供完整产品界面，替换默认的 Maka Workbench。

内核不包含 Agent 业务策略或原生布局语言。绑定负责为导入选择符合契约的导出；调用到达后，接收方 Host 仍需检查权限。

组合展开、转发和依赖校验采用迭代遍历并检测实际循环。有限覆盖能终止展开时，模板可以重复使用同一包；绑定数量遵循导入契约的声明。实例身份保留每个非零源 UUID。

[源码](src/lib.rs) · [Cargo 配置](Cargo.toml)
