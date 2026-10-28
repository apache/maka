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

# 架构

[English](ARCHITECTURE.md)

Maka 通过插件组装应用。包声明自己提供和需要的能力，组合选择实例并将导入连接到导出。Host 服务执行工作，UI 插件向终端和桌面共用的工作台提供 NSH 组件。

## 代码归属

[平台](platform/README.zh-CN.md)包含包加载器、组合内核、执行所有者和渲染器。[插件](plugins/README.zh-CN.md)包含业务功能及其声明。[Maka 产品](products/maka/README.zh-CN.md)选择包、原生工厂和启动行为。

`package.ts` 标识一个开发者声明的插件，Cargo crate 标识一起编译的代码。两者不必一一对应：Agent 服务可以使用多个领域 crate，相关插件入口也可以共用一个原生实现 crate。

组合内核在同一来源中描述 Host、UI 和结构性实例。`host-js` 通过现有后台运行时执行 JavaScript Host 服务。[工作台](products/maka/workbench/README.zh-CN.md)在共享 NSH VM 中运行可信 UI 模块，两种外壳注入相同的 Host 绑定。NSH 负责响应式布局、输入和渲染。存储与呈现所需的共用事实类型仍作为显式依赖存在。

## 从包到运行中的应用

1. 包加载器校验不可变内容并计算引用。
2. 组合规划器检查每个 Host、UI 或结构性节点及其配置和绑定。
3. Root 按修订保存期望配置及包内容。
4. Host 协调已启用的后台服务；工作台观察同一来源，在使用贡献时按需加载已启用的 UI 模块。

安装将不可变包加入可用集合；显式 UI 节点决定启用哪些贡献。用户安装的 UI 插件视为可信代码，在工作台 VM 中使用已有 NSH 和 Host 能力，不另设插件沙箱或授权流程。每次调用准入时，Host 仍检查调用方、方法、输入和实际资源。本地 IPC 连接携带启动器提供的方法与回执恢复权限。

更新配置会保留未改变的激活及其绑定。改变的实例先退役再替换。已接受的工作始终归原所有者管理，即使调用方断开或组件消失也是如此。

## 状态与副作用

EventLog 持有持久 Root 和规范记录。稳定的插件数据归属于 Root、部署和实例。包修订与激活 epoch 描述代码和执行，本身不会创建新的数据命名空间。

变更操作具有回执，业务完成和实际清理分别记录。响应丢失时，调用方查询原回执，不重新发起替代操作。取消表示请求停止工作；资源仍被持有，直到实际清理完成。

桌面、终端像素渲染和终端 Unicode 渲染运行同一个 TSX/NSH 工作台。UI 模块提供命令、面板、设置页和工具渲染器。插件契约依赖 NSH，不绑定 GPUI 或终端场景语言；后端专属原生组件由渲染器处理。

UI 模块按不可变包身份求值，并在 NSH 响应式所有者下激活；可见组件有自己的生命周期。禁用实例、修改包或配置、移除实例时，会清理该激活及其贡献。只改变来源修订、没有改变实例时，不重新加载。NSH 组件清理会释放订阅和定时器；已接受的 Host 工作与变更回执仍由原客户端所有者持有。原生文件快照和剪贴板资源支持位于 [ui-support](platform/ui-support/README.zh-CN.md)。

## 开发与分发

每次 CLI 构建都会嵌入产品 bundle，每次工作台构建都会嵌入其 TSX 应用。UI 插件源码模块及资源复用现有不可变包的安装和读取路径，因此安装或更新 UI 插件无需重新构建客户端。重建可执行文件不会替换已有安装保存的组合。

Rust 契约通过 [maka-schema](tools/schema/README.zh-CN.md)生成 [JavaScript SDK](packages/plugin-sdk/README.zh-CN.md)，无需构建产品。npm 包只负责[启动原生可执行文件](packages/cli/README.zh-CN.md)。
