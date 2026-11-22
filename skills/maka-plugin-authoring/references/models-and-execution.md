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

# Models and Agent execution

The ordinary Agent service owns sessions, message admission, active runs, queued
messages and their original execution basis. The settings service owns connection
configuration and credentials; model selection uses an observed connection revision,
model identity and supported thinking level. Use their generated contracts and
configuration schemas instead of reproducing their state in a UI plugin.

The application SDK does not currently export a JavaScript `models.register`,
executor-session factory or global model interception API. Extending model execution
requires an explicit native/provider integration with its actual owning runtime.
In a checkout inspect `plugins/agent/native/src/model.rs`, `owner.rs`, `tools.rs`,
`plugins/settings/native` and the underlying provider/model crates.

Changes must preserve admission and recovery: accepted queue contents retain their
original source, requested model and configuration facts; opaque tool/provider
activations are not assumed equivalent after restart. A changed or unavailable
execution basis is observable and cannot silently fall back to another model,
workspace or authority. Tests should inspect the actual provider request and the
original durable records, not only selector state.
