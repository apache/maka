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

# maka-skills

[简体中文](README.zh-CN.md)

Parses SKILL.md documents, discovers skill sources and prepares selected instructions and resources. `Catalog` exposes discovery; `PreparedInvocation` represents a prepared use. Bundled resources are assembled by `build.rs`, including the plugin-authoring skill and its matching SDK sources. Skill text is data: tool names and references do not grant execution authority.

Bundled skill and SDK files are enumerated in `build.rs`; adding one requires updating that inventory. Local caches are excluded. Source examples come from top-level TypeScript files in fixed directories.

Immutable bundled documents and resource contents are prepared once and shared across discoveries. Discovery captures complete catalogs and contained resources; model metadata remains a preview with exact source references and pageable reads. Filesystem sources are captured afresh under the current request capabilities.

Skills with the same `SKILL.md` name use the first discovered location: project `.maka`, project `.agents`, user `.maka`, then user `.agents`. The selected document and resources always come from the same directory. Lower-priority instances remain in the inventory with their shadowing reference; removing an override reveals the next instance.

[Source](src/lib.rs) · [Cargo manifest](Cargo.toml)
