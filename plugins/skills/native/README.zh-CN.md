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

# maka-skills-native

[English](README.md)

将技能库作为普通 Host 服务提供。`sources` 捕获标准用户与工作区目录，`remote` 从临时 Git 快照或本地目录发现技能，`management` 安装、整体替换和删除技能目录。文件是内容权威；`registrations` 仅在既有 Root 数据库登记 Maka 管理的位置与来源，`preferences` 保存启用和置顶选项。模型读取使用发现结果中的精确引用与修订。

[源码](src/lib.rs) · [Cargo 配置](Cargo.toml)
