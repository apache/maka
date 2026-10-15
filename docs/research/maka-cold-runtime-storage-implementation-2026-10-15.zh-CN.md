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

# Maka 冷历史无损压缩：实现、迁移与验证

日期：2026-10-15。实现基线：`1751c399239b0f6b717e98e2a5e2b875c3dd11ce`，分支 `codex/cold-runtime-storage`。本文记录草稿 PR 的实现、本机验证和待评审事项。对应 Issue：<https://github.com/apache/maka/issues/6109>。

## 先看场景与取舍

历史仍由同一个 SQLite 数据库负责事务、身份、顺序和恢复。**冷热区分的是正文的物理表示，而不是两个可互相失配的数据源。** 历史事实不改变；冷却、压缩和空间回收都是可重试的维护工作。

| 场景 | 实际行为 |
| --- | --- |
| 新建会话、继续写消息、流式更新 | 使用原始表示，记录本机实际写入时间；新建会话初始化时钟，改标题不重置时钟 |
| 连续 7 天没有内容写入 | 后台检查已完成的大正文，达到净收益要求才无损压缩 |
| 阅读冷历史 | 临时解压到内存，磁盘上的压缩表示保持不变；读取不重新开始冷却 |
| 继续旧会话 | 新记录正常追加；已有压缩记录保持原状，新写入重新开始会话的 7 天冷却 |
| 逻辑导入或整库恢复 | 重新开始本地冷却；导出副本不携带启用后台写入的执行授权 |
| 旧数据库尚未启用增量回收 | Host 启动阶段执行一次 SQLite 事务性转换；UI 显示阶段，允许退出后重试 |
| 压缩完成但文件未缩小 | 另由有界增量回收释放页面；不能把 freelist 增加当作磁盘空间已经释放 |

不引入在线影子库、CDC 或自行替换主库文件。当前客户端允许一次启动升级，SQLite 的原生事务恢复可以满足首期目标。未来更换压缩算法属于表示升级，不应改变领域事件或它们的身份。

## 压缩哪些内容

只处理 `runtime_events.payload_json` 中完整的 `text`、`thinking`、`function_call`、`function_response`。本次大样本中，工具结果占原始 RuntimeEvent JSON 字节约 88.5%，因此正文是主要收益来源。

- 原始 JSON 至少 1 KiB，遵守现有单记录读取上限；流式 partial 保持原样。
- 使用独立 zstd level 3 帧。计算包含 JSON 信封、Base64 和辅助证据的真实占用，至少净省 `max(128 B, 10%)` 才发布。
- 签名、provider metadata、工具参数、原始结果、modelProjection 全部保留。原始 UTF-8 JSON 的长度与 SHA-256 参与验证，恢复可以还原精确原文。
- SQL 所需的身份、内容种类、工具名、错误和 steering 等控制字段保留在外层。工具证据有独立有界帧，避免为了读取小证据而展开巨大结果。
- 系统与调度事件、运行状态、权限、索引以及独立附件文件不属于本次压缩目标。

读取同时接受原文与版本化信封；遇到未知版本、错误校验和或不匹配的查询投影会拒绝解码。写入策略标识与解码版本分开，策略改变可以重新检查以前未达到收益要求的记录。

## 后台执行和读取成本

七天时钟来自与内容写入同一事务内的 SQLite 触发器。历史事件的 `ts` 不代表最近本地写入时间，旧库第一次升级按升级时刻初始化缺失的时钟。复制或恢复会重置本地冷却，物理压缩和 VACUUM 不重置。

本机默认启用压缩 writer，既有显式关闭设置保留。该发布默认值仍需在草稿评审中确认；停止 writer 不会停止读取压缩记录，正文恢复工具也不会把整个数据库 schema 降级。

后台每批最多 16 条，软预算 1 MiB；单条大记录受独立硬上限约束。压缩在 worker 中执行，发布前重新检查内容版本、会话时钟、保护状态和 writer epoch，以条件更新写入。执行中、读取中、数据库忙、空间不足、WAL 过大时让出或延期。

日常维护按输入字节节流，每批至少间隔 1 秒；本次离线连续跑完约 0.79 GB 输入花费约 23–33 秒，不代表生产会连续占用 CPU。生产总耗时还受每批 16 条、空闲时间和单写入通道约束，不能把离线吞吐直接当成用户看到的释放速度。

交互分页使用一个惰性读取 worker；另一个惰性 worker 处理压缩和整库候选搜索。整库搜索优先于排队的压缩任务，避免长搜索挡住分页队列。搜索与压缩期间保持会话保护。

原文解码缓存每个进程/worker 最多保留 16 MiB 字符串，按两字节字符计费。它复用已经验证的不可变字节，每次读取仍重新解析出独立对象，避免调用方修改污染后续读取。

**搜索没有被改成“所有冷会话都算候选”。** 候选筛选检查解压后的原文，保留 Unicode 折叠和流式候选的原语义。本次 1 GB 全库候选搜索的命中/未命中集合一致。未命中扫描由原文约 2.4–3.3 秒变为压缩约 3.3–4.2 秒，仍属于全库扫描；这项 CPU 代价没有被分页 p95 指标覆盖，也没有新增全文索引掩盖它。

## 旧库启动转换和进度

Host 保持唯一 schema 所有者。它先完成既有 schema 迁移，关闭初始化连接，再把物理转换交给 worker；普通业务 writer 此时尚未开放。

| 实际 `auto_vacuum` 模式 | 操作 |
| --- | --- |
| NONE（0） | 设置 INCREMENTAL 并执行一次完整 VACUUM |
| FULL（1） | 切换至 INCREMENTAL，无须完整重建 |
| INCREMENTAL（2） | 正常跳过；若上次留下未完成标记，补做验证 |

沿用 WAL，转换连接显式设置 `synchronous=FULL`。重建前检查额外可用空间约 `2 × 数据库文件大小 + 64 MiB`，锁冲突立即让出。重建后执行完整 `integrity_check`；实际损坏不会作为可忽略错误继续业务写入。

小标记只负责中断检查与失败退避，数据库的实际模式才是完成事实。失败后退避一小时，运行中断可在下次启动重试；损坏的重试提示不会永久阻止转换。已提交但标记没清理时补做校验，不重复 VACUUM。

Host 增加明确的 `upgrading_storage` 状态，协议兼容 epoch 更新至 223。普通启动预算仍为 75 秒，只有明确的升级状态才使用单独、最多 30 分钟的预算；不响应的 RPC 仍有独立短超时。Desktop 的存储依赖等待也能跨过升级，直到 Host 就绪后才开放。

UI 使用真实阶段：**准备升级 → 整理历史 → 校验历史 → 打开历史**，显示当前步骤、已用时间和不定进度条。SQLite 没有提供可直接用于这里的完整 VACUUM 百分比分母，不能用时间或文件大小伪造完成比例。[SQLite progress handler](https://sqlite.org/c3ref/progress_handler.html)

[真实客户端进度条截图](./cold-storage-2026-10-15/upgrade.png)

普通退出会取消启动，Root 所有权保持到 worker 真正退出；进程被强制结束后由 SQLite 恢复。支持安全检查和重试，不承诺从中断百分比续传。进程终止实验也不等同于真实断电实验。

## 多线程实验与消融

机器探测结果：Apple M2 Pro，可用并行度 10，内存 16 GiB。按提议 `min(8, max(1, floor(可用并行度 / 4)))` 得到 2。

在同一原始旧库的独立完整副本上，使用生产转换 worker 测量 SQLite 辅助线程：

| 辅助线程上限 | VACUUM | 完整校验 | 转换合计 |
| --- | --- | --- | --- |
| 0 | 6.28 秒 | 1.79 秒 | 8.19 秒 |
| 2 | 6.47 秒 | 1.75 秒 | 8.30 秒 |
| 8 | 6.37 秒 | 1.83 秒 | 8.33 秒 |

这是每种配置一轮的实测，不能推广成所有机器的结论。当前没有提速证据，因此默认不启用额外 SQLite 辅助线程。`PRAGMA threads` 主要帮助部分 CPU 排序工作，并不把整个数据库重建拆成多个独立写入者。[SQLite threads](https://sqlite.org/pragma.html#pragma_threads)、[SQLite 编译选项](https://sqlite.org/compile.html#max_worker_threads)

较早一次完整路径测到约 58.5 秒，后续独立副本转换约 8.2 秒。数据布局和当时机器、磁盘负载不同，两者不能被解释为增加线程带来的提速；等待时间应按实时阶段展示，不采用固定的“每 GB 若干秒”。

实际消融还临时移除了原文缓存：同一压缩库、3,000 次分页，p95 从保留缓存时的 19.8 ms 变为 22.9 ms；页面摘要完全一致，恢复缓存。因此保留有界字符串缓存。在线 CDC、影子库和自行发布文件没有进入本次实现；单写入者、校验、冷却时钟、保护和空间检查保留。

## 验证数据与边界

样本来自历史 `issue-5627-long-master` fixture，185,930 条 RuntimeEvent，原始 JSON 合计 883,500,249 字节；原始 SQLite 文件 SHA-256 为 `915f3b9099397140ba64f839ce57d6e51a6aad16f548482f34884f40c00e4a04`。它是一份模拟历史样本，不能代表全部用户数据分布。

性能主体先把原始事件和持久 ordinal 精确重放到当前 schema，再分别测试新库和旧回收模式。它隔离表示成本，**不是对原始库全部表的迁移测量**；完整原库副本的验证另列，不混淆口径。测试主动把副本的时钟推至七天前，生产不会使用这种加速方式。

| 重放样本 | 回收前原始文件 | 最终文件 | 文件减少 | 分页原文 p95 | 压缩、未回收 p95 | 压缩、已回收 p95 |
| --- | --- | --- | --- | --- | --- | --- |
| INCREMENTAL，缓存消融之前 | 1,094,410,240 B | 457,871,360 B | 58.16% | 19.99 ms | 22.45 ms | 21.81 ms |
| NONE → 启动转换，最终缓存设计 | 1,082,785,792 B | 446,894,080 B | 58.73% | 21.23 ms | 19.11 ms | 20.36 ms |

第二行每阶段 3,000 次重复分页，覆盖最新、中间、最早三个位置。每阶段新建惰性读取 worker；**没有清空操作系统文件缓存**。首读不能被称为真实磁盘冷启动。计时包含存储、解码和页面投影，不包含 UI/传输。事件和页面摘要在压缩与回收前后完全一致。

真实 Electron 客户端使用的是完整原库副本：升级提示和阶段进度条显示正常，300 ms 内 renderer 心跳执行 27 次，正常退出约 59 ms、退出码 0；退出后与重启后的全部历史摘要一致，最终模式为 2，Host 达到 ready。该次退出观察到转换已经提交，配合独立的转换中 SIGKILL 测试覆盖不同中断点。

**完整原库的空间口径**：保留所有源表后，转换前原文件为 1,158,852,608 B；完成转换的原文库为 1,148,002,304 B，压缩并增量回收后为 512,114,688 B。相对转换后的原文库实际缩小 **55.39%**，已分配文件块数也对应缩小。全部 185,930 条事件的原始 JSON 字节与摘要一致，源文件哈希不变。该轮启动转换约 9.89 秒；每阶段仅 30 次重复分页用于功能检查，不用这组小样本宣称 p95 性能门槛通过。

打包验证使用 Electron 43.4.1 / 内置 Node 24.18.1，把 workspace 模块置于 ASAR，成功执行读取、压缩、转换、恢复、分页、landmark 与候选搜索。原始大库只读使用，所有写入和中断发生在独立副本。

最终完整检查：根目录 build、Desktop 的 main/preload/renderer/Storybook 类型检查、变更文件格式与 lint、`git diff --check` 均通过。

| 完整套件 | 通过 | 条件跳过 | 失败 |
| --- | --- | --- | --- |
| Storage | 1,673 | 8 | 0 |
| Host 主套件 | 2,410 | 12 | 0 |
| Host assistant 三组检查 | 171 | 0 | 0 |
| Desktop | 3,807 | 0 | 0 |
| CLI | 1,419 | 3 | 0 |
| 合计 | **9,480** | **23** | **0** |

全量并发初跑发现一个会话初始化时钟边界和一处旧 schema 夹具缺漏，已修正后复跑完整套件。Host 一项原有 2 秒轮询在并行负载下超时，单项和受控并发的完整 Host 套件均通过，没有放宽断言或增加等待期限。

平台范围目前是本机 macOS。源码、运行环境、原始样本和报告摘要应一起保留，不能用旧基线的性能结果替代当前实现。

## 复现入口

- `scripts/perf/cold-runtime-storage.mjs --source SQLITE --output NEW_DIRECTORY --samples 1001 --auto-vacuum none`：隔离事件语料的完整路径。
- 同一脚本加 `--copy-source`：完整 SQLite 副本，保留源库全部表；`--auto-vacuum` 必须与源库实际模式一致。
- `scripts/perf/cold-storage-vacuum-threads.mjs --source SQLITE --output NEW_DIRECTORY`：0、机器四分之一、8 个 SQLite 辅助线程的比较。
- `scripts/perf/cold-storage-packaged-worker-smoke.mjs`：ASAR 中的 worker 和启动转换检查。
- `scripts/cold-runtime-storage.mjs`：显式检查、启停、恢复和回收工具；默认生产流程不要求用户操作这些命令。

使用项目支持的 Node 24，先执行 `npm run build`。输出目录必须为新目录，原始数据不会被覆盖。

可公开的数值证据见 [验证摘要](./cold-storage-2026-10-15/validation-summary.json)。原始测试日志、性能报告及独立数据库副本在本地保留；仓库不包含大库或本机路径。
