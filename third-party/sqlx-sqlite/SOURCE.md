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

# SQLx SQLite dependency alignment

Sources and dual Apache-2.0/MIT licenses come from the published `sqlx-sqlite` 0.9.0 crate, [revision 003b698e99e024f3621b8043a2426fde5b741171](https://github.com/launchbadge/sqlx/tree/003b698e99e024f3621b8043a2426fde5b741171/sqlx-sqlite). `upstream.json` records each original file hash and the full license sources. Three upstream documentation lines in `connection/deserialize.rs` have trailing whitespace removed for the source hooks.

Two local changes remain:

- The manifest selects `libsqlite3-sys` 0.39 to share one SQLite library with rusqlite 0.41. Published SQLx 0.9.0 requires `<0.38`, which cannot coexist with rusqlite's `links="sqlite3"` dependency.
- `SqliteConnectOptions::query_planner_stability` configures SQLite's Query Planner Stability Guarantee through the original locked handle. The client journal uses it to avoid parameter-sensitive recompilation; schema changes still invalidate statements. It defaults to false, and ordinary connection setup, transaction handling and worker execution follow upstream.

The runtime event store uses rusqlite directly. No local SQLx worker callbacks, executor adapters or split startup/configuration interfaces remain.

中文：保留发布版 SQLx 0.9.0 的原始执行、事务和连接建立路径。仅将 `libsqlite3-sys` 对齐到 rusqlite 所需的 0.39，并保留客户端 journal 正在使用的查询计划稳定选项。event store 直接使用 rusqlite，不再通过 SQLx 的定制 worker、执行适配器或分阶段启动接口。
