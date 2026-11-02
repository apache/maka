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

# maka-goal

[简体中文](README.zh-CN.md)

Persistent Goal state, progress, timing, token accounting and original operation receipts. `goal` owns transitions and storage; the native Agent drives execution through its existing Session queue. Goals have no fixed iteration or objective-size cap. Optional token budgets stop further scheduling when observed usage reaches the threshold; incomplete counters stay visible without ending the Goal. See the [native Agent](../native/README.md) for tools, controls and recovery.

[Source](src/lib.rs) · [Cargo manifest](Cargo.toml)
