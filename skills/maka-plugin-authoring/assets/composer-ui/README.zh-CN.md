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

# 替换输入框视图

[English](README.md)

这个精简 UI 包通过公开的 `maka.composer` 视图契约提供 `composer` 贡献。源码只导入 NSH 和 SDK 类型。会话插件提供当前草稿、上传操作、排队／发送／停止操作及原始回执恢复能力，并继续拥有状态和变更链；本包负责输入界面。模型选择器和待处理交互通过契约的 `models`、`request` 槽传入。

将本目录文件一起复制，使用 Node.js 26 和支持该视图契约的 Maka 可执行文件构建：

```sh
node build.mjs --output ./composer-build --maka /path/to/maka
```

输出目录必须尚不存在。脚本调用 `maka application build-ui`，将模块与资源放入 `composer-build/plugin`，写入声明，并打印实际包的检查引用。类型导入在 UI 编译时移除；示例不需要运行时 SDK 包，也不导入仓库内部源码。

将产物包安装到当前部署，添加一个已启用的 UI 实例，例如 `example-composer`，再将会话 UI 实例的 `configuration.values.composer` 指向它：

```json
{ "path": ["example-composer"], "id": "composer" }
```

提交变更时保留当前 source revision、无关实例、绑定和实例 UUID。应用根入口保持原有选择。示例不提供 Host 服务，也不声明服务导入；安装包和提交已检查 source 的流程见 authoring 技能的 runtime UI 指南。

示例演示另一种输入布局、稳定的原生附件选择器所有权、上传／发送回执恢复、带异步输入校验的粘贴／拖放，以及实时草稿编辑。选区和 IME 状态属于可丢弃的本地状态；示例不创建第二份草稿、模型订阅、历史监听或发送日志。内置输入框另外提供技能／文件／命令补全、沙箱选择、MCP 信任确认和队列编辑器。扩展示例时，可通过传入的会话接口增加对应控件。

像源码中那样把 `attachments.renderPicker` 作为组件挂载：`const Picker = session.attachments.renderPicker; <Picker ... />`。直接在响应式子表达式中调用它，会在属性变化时替换原生选择器，丢失持有所选路径的实例。
