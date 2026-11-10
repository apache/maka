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

# maka-scheduler

[简体中文](README.zh-CN.md)

Provides scheduled-task timing, cron/timezone calculation, misfire policy and pure `TaskPlan<E, A>` claim, settlement and editing rules. The Agent owner supplies effect and approval types, persists plans in its Root and submits execution through the shared durable Run driver. Frozen Fire data preserves an original delivery's identity across recovery; it does not grant execution authority.

[Source](src/lib.rs) · [Cargo manifest](Cargo.toml)
