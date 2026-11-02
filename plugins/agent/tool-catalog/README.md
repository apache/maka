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

[简体中文](README.zh-CN.md)

Validates tool contributions and builds immutable request catalogs. `availability` determines which tools can be offered; `request` captures the selection for a request. Tool metadata describes an interface. Actual execution still needs the original call context and admission.

Native Agent file editors are always visible by their bound operation, including custom tool names. The model’s editing policy selects structured writing/editing or patching without a separate tool search.

[Source](src/lib.rs) · [Cargo manifest](Cargo.toml)
