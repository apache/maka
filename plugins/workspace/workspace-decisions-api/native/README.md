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

# maka-decisions-api-native

[简体中文](README.zh-CN.md)

Native `maka.workspace.decisions_api` implementation. Exports the Decisions API contract for endpoint settings, credentials and evaluation. Uses the shared engine with explicit JEV or OpenAI protocol selection. HTTP admission is restricted to the configured endpoint and settings/credential revisions; redirects never forward credentials.

Settings and secrets use the `maka.workspace.decisions_api` namespace. Credentials are bound to the exact endpoint URL. Saved settings explicitly select their protocol.

[Source](src/lib.rs) · [Engine](../engine/README.md)
