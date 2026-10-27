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

# SQLx SQLite owner integration

Sources and dual Apache-2.0/MIT licenses come from the published `sqlx-sqlite` 0.9.0 crate, [revision 003b698e99e024f3621b8043a2426fde5b741171](https://github.com/launchbadge/sqlx/tree/003b698e99e024f3621b8043a2426fde5b741171/sqlx-sqlite). `upstream.json` records each original file hash. Published license files are relative references; their full texts are included here from the same pinned repository revision, with URLs and hashes in `license_sources`. The normalized manifest selects `libsqlite3-sys` 0.39 to share one SQLite library with rusqlite 0.41. Three upstream documentation lines in `connection/deserialize.rs` have trailing whitespace removed for the source hooks; behavior is unchanged.

The existing `SqliteConnection::establish` is public, and existing PRAGMA/collation configuration is moved into `configure(&mut self, options)`. Ordinary `ConnectOptions::connect` still delegates to the same steps. Maka's independent SQL owner retains the actual connection between establishment and configuration, waits for real close on startup failure, and keeps its original authority on unconfirmed cleanup. No second SQL worker, connection registry or error-string classification is added. `WorkerCrashed` during establishment is explicitly unconfirmed.

中文：公开原有 establish，将 PRAGMA/collation 配置移为借用实际连接的 configure。普通 connect 保持原语义；Maka 原 SQL owner 先持有真实连接，再进行配置，启动错误须等真实关闭，无法确认时保留原 authority。没有新增 SQL owner 或执行注册表。

`run_on_worker` submits one synchronous callback to the existing worker under its exclusive handle guard. The callback borrows the handle and returns owned data; its Rust panic resumes on the awaiting task. SQLx still owns transaction bookkeeping and physical close. Accepted callbacks continue if their observer disappears; abandoning a callback future alone does not guarantee rollback.

中文：`run_on_worker` 将同步回调交给原工作线程，在原独占 guard 内借用句柄并返回自有数据；回调的 Rust panic 在等待方继续展开。事务记账和实际关闭仍由 SQLx 管理。等待方消失不取消已受理回调，单独丢弃回调 future 不保证回滚。


`run_with_connection` uses that same callback command and exclusive worker guard to borrow a `SqliteWorkerConnection`. Its `Executor` implementation drives the existing `ExecuteIter`, row decoders and bounded `Statements` cache directly; query futures and streams are immediately ready and stop at the first error. The raw-handle callback delegates to this same entry point. Neither callback may control transactions or retain raw handles. Maka polls a bounded worker query once, failing closed if it unexpectedly yields, and leaves commit/rollback and cache maintenance with the original owner job.

中文：`run_with_connection` 沿用原回调命令和独占 guard，直接借用 SQLx 原有执行器与有界语句缓存；查询 future/stream 立即就绪，首个错误终止执行。原句柄回调委托给同一入口。事务、实际关闭和查询后的维护仍归原 owner；没有新增连接、运行时或持久缓存。


`SqliteConnectOptions::query_planner_stability` explicitly configures SQLite's Query Planner Stability Guarantee through the original locked connection. It defaults to false. Selected Maka owners enable it to avoid SQLite 3.54 recompiling cached identity lookups when bindings change. SQLx still clears completed bindings; no bound payload is retained. Pool replacement connections and derived reader options inherit the selected setting. Prefix searches in those owners use explicit index ranges instead of relying on bound LIKE/GLOB optimization.

中文：新增显式 query_planner_stability 连接选项，默认关闭，由原连接的独占 guard 配置。经测量的 Maka owner 启用它，避免 SQLite 3.54 因身份参数重新绑定而反复编译缓存查询；完成后仍清理绑定。连接池替换连接及派生 reader 继承配置，前缀查询使用显式索引区间。
