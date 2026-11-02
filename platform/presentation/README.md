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

[简体中文](README.zh-CN.md)

Projects committed invocation facts into display rows, messages and navigation. These projections can be discarded and rebuilt. They are separate from model context: showing interrupted output in a timeline does not admit that text into a later model request. Start with `InvocationView`, `Row` and `navigation`.

Model rows use complete canonical part identities and timestamps. Terminal references resolve only against the same step’s original part records. Interrupted Main partials remain display evidence; live model previews belong to the active attempt rather than this committed-fact projection.

[Source](src/lib.rs) · [Cargo manifest](Cargo.toml)
