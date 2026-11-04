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

[简体中文](README.zh-CN.md)

Shares directory resolution and validation across workspace services. It opens configured roots, resolves a caller's path (absolute, or `~` for the home directory the owning service passes in) to the directory within the most specific root, excludes private Host paths and checks a selected workspace against those roots. `Root`, `query`, `selected`, `initialize` and `validate` are the main entry points. Directory identities are captured here as directories are opened; callers never supply them. A selected path is usable only within the authority supplied by the owning service.

Child queries enumerate the selected directory before sorting and returning pages of up to 32 children with a 48 KiB byte target, allowing a complete first child to advance. Ordinary files do not prevent browsing child directories. Continue with the returned `after` cursor; each query revalidates the published root and selected directory identity.

Selections have no separate directory-depth limit. Paths must still satisfy the Host's path representation and filesystem checks. ACP follows returned selections toward the requested canonical path, ignoring aliases that do not advance toward it.

The complete configured root set is returned without a separate page-size admission ceiling. Component and canonical-path validation preserve the original directory authority without imposing additional pathname byte limits.

[Source](src/lib.rs) · [Cargo manifest](Cargo.toml)
