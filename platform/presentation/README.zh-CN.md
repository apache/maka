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

# maka-presentation

[English](README.md)

将已提交的调用事实投影为显示行、消息和导航信息。这些投影可以丢弃并重建，与模型上下文相互独立：时间线显示中断输出，不代表后续模型请求会接纳这些文本。入口是 `InvocationView`、`Row` 和 `navigation`。

模型行使用完整 canonical part 的原身份与时间。终态引用只解引用同一步骤的原 part 记录。Main 中断 partial 仍是显示证据；实时模型预览属于当前 attempt，不由这个已提交事实投影累计。

[源码](src/lib.rs) · [Cargo 配置](Cargo.toml)
