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

# maka-workspace-support

[English](README.md)

在工作区服务之间共享目录解析与校验。它打开已配置根目录，把调用方给出的路径（绝对路径，或以 `~` 代表所属服务传入的主目录）解析为最具体的那个根目录下的目录，排除 Host 私有路径，并检查所选工作区是否属于这些根目录。主要入口是 `Root`、`query`、`selected`、`initialize` 和 `validate`。目录身份在这里打开目录时采集，调用方不提供。所选路径只能在所属服务提供的权限范围内使用。

子目录查询先枚举所选目录，再排序并分页返回；每页最多 32 个子目录，以 48 KiB 为字节目标；完整首项始终可以推进。普通文件不会阻止子目录浏览。使用返回的 `after` 游标继续查询；每次查询都会重新校验已发布根目录和所选目录的身份。

路径没有独立的层数上限，但仍需满足 Host 的路径表示和文件系统校验。

配置的根目录集合完整返回，不再以单页大小拒绝整个集合。路径组成和规范路径校验保留原目录权限，不另加路径名字节上限。

[源码](src/lib.rs) · [Cargo 配置](Cargo.toml)
