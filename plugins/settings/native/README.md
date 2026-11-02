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

# maka-settings-native

[简体中文](README.zh-CN.md)

Exposes Root settings through a native application service. `provide` registers the factory; `contract` defines its interface; `network`, `preferences` and `usage` implement settings operations. Activation receives the existing Root owner and uses the settings store. Reading settings does not expose credential values.

Language is a single Root preference, updated with the existing policy revision. `assistantPreferences` returns both the saved selection and the resolved `en`, `zh-CN` or `zh-TW` language. An unset selection follows the configured product locale; explicit `auto` follows the native startup locale, and an explicit language overrides both. Activation accepts locale tags such as `zh-Hant-HK` and normalizes them before use.

[Source](src/lib.rs) · [Cargo manifest](Cargo.toml)

Settings preserves full configuration, labels, search inputs and authentication resources. Page targets bound each continuation slice rather than the full inventory; one complete larger item still advances. The Host owns physical resource admission and settlement; Settings retains domain syntax, CAS and credential authority.

Model details can associate a connection’s model ID with a searchable public catalog entry. The association supplies missing metadata without changing the request ID, endpoint, credentials, protocol controls or pricing identity. Account facts and explicit model settings take precedence. Clear the association to return to automatic matching; accepted tasks keep their captured catalog defaults.
