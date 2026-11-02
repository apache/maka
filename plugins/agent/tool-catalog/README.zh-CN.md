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

# maka-tool-catalog

[English](README.md)

校验工具贡献并构建不可变的请求工具目录。`availability` 判断可提供的工具，`request` 捕获请求所选目录。工具元数据描述接口；实际执行仍需原始调用上下文和准入。

Native Agent 按绑定的文件操作将编辑工具设为常驻，自定义工具名也适用。模型编辑策略在结构化写入／编辑和补丁之间选择，无需另行搜索工具。

[源码](src/lib.rs) · [Cargo 配置](Cargo.toml)
