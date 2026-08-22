# DeepSWE 1.1 — maka 失败深度分析

**分析对象**：harness A/B 运行 `deepseek-v4-flash-maka-vs-opencode-deepswe-full-v1` 中 maka 臂的全部轨迹
**配套评测报告**：[`deepswe-1.1-deepseek-v4-flash-maka-vs-opencode.md`](./deepswe-1.1-deepseek-v4-flash-maka-vs-opencode.md)
**数据规模**：113 题 × 2 臂 = 226 cell；20,353 次工具调用；18,439 个 provider 步骤；47.5M 字符最终步 prompt；1,840 条失败 f2p 测试记录
**模型配置**：DeepSeek V4 Flash，`reasoningEffort: max`，两臂同模型同参数
**关键前提**：**budget exhaustion 两臂均为 0%** —— 5400 秒 agent timeout 一次都没触发，失败与耗时无关

---

## 执行摘要

三个最重要的结论：

1. **失败与「循环控制」无关。** 通过与失败的轨迹在步数、测试次数、编辑次数、重读次数上**没有任何统计分离**，失败运行反而多消耗 8.7% 的推理 token。这是对任务规格的理解/能力问题，不是 agent 循环管得不够严。
2. **发现一个真实的正确性 bug**：脱敏机制正在破坏喂给模型的源代码。113 个最终 prompt 里 **2,055 处 `[redacted]`**，其中**只有 20 处（0.9%）是真正该脱敏的凭证**，其余 99% 是误伤 —— 包括词法分析器的 `Token:`、哈希表的 `Key:`、以及 git commit SHA。
3. **两个 harness 的失败模式高度同构。** 按 cell 归一化后失败类别分布几乎重叠，且多道题两臂**失败在同一个测试上**。瓶颈在模型能力边界与 benchmark 缺陷，不在 harness 架构差异。

---

## 一、评测基线

| | maka | opencode |
|---|---:|---:|
| End-to-end Pass@1 | 52/111 (46.85%) | 40/112 (35.71%) |
| 配对 Pass@1（110 对） | 52/110 (47.27%) | 38/110 (34.55%) |
| 独有通过 | 34 | 20 |
| Budget exhaustion | **0/111 (0%)** | **0/112 (0%)** |
| 平均步数 | 165 | 152 |
| 总 token | 2,204,254,471 | 2,413,050,907 |
| 未缓存输入 | 17,808,556 | 10,369,028 |
| cache 命中率 | 99.19% | 99.57% |
| 输出 token | 11,931,438 | 13,254,334 |
| 其中 reasoning | 7,204,753 (60.4%) | 8,777,729 (66.2%) |
| 实际成本 | $12.26 | $12.14 |
| 每次通过成本 | **$0.2358** | **$0.3196** |

McNemar 精确检验（54 个分歧对，34:20）：**p = 0.0759，未达显著**。

---

## 二、maka 行为画像

### 2.1 工具调用分布（全量 113 题）

| 类别 | maka 总数 | 占比 | 次/题 | opencode 总数 | 占比 | 次/题 |
|---|---:|---:|---:|---:|---:|---:|
| shell (bash) | 13,921 | **68.4%** | 124.3 | 10,130 | 54.8% | 89.7 |
| edit | 3,575 | 17.6% | 31.9 | 3,977 | 21.5% | 35.2 |
| read | 2,053 | 10.1% | 18.3 | 3,173 | **17.2%** | 28.1 |
| write | 613 | 3.0% | 5.5 | 539 | 2.9% | 4.8 |
| grep/glob | 191 | 0.9% | 1.7 | 244 | 1.3% | 2.2 |
| todowrite | 0 | — | — | 263 | 1.4% | 2.3 |
| webfetch | 0 | — | — | 173 | 0.9% | 1.5 |
| **合计** | **20,353** | | 181.7 | 18,500 | | 163.7 |

> `todowrite` / `webfetch` 缺失是配置差异（maka 跑在 `MAKA_AGENT_TOOLS=false`），不是行为特征。

**bash 内部再分类**（n=13,921）：读文件（`cat`/`sed -n`/`head`/`tail`）30.4%、搜索列目录（`grep`/`find`/`ls`）23.4%、跑测试 19.8%、执行脚本 13.2%、git 7.0%、构建 lint 6.2%。

最常用二进制：`sed` 2,785 次、`grep` 2,453 次、`cat` 1,435 次。

**每题均值对比**：

| bash 子类 | maka | opencode |
|---|---:|---:|
| 跑测试 | 19.9 | 20.9 |
| 编译构建 | 6.4 | 6.4 |
| lint/format | 4.4 | 4.4 |
| git | 13.8 | 12.3 |
| grep/find/ls | 46.6 | 44.9 |
| 直接执行脚本 | 16.7 | 14.6 |
| 写文件类 | 27.1 | 21.8 |

### 2.2 核心发现：37% 的工具调用是用 bash 手工做 Read/Grep/Glob

**7,493 次 bash 调用（占全部工具调用 37%）在做结构化工具本该做的事。**

对比最刺眼的一组：`Grep` 工具全场用了 **149 次**，`grep` 走 bash 用了 **2,453 次** —— 比例 1:16。

而 `packages/headless/src/system-prompts.ts:12-17` 明写着：

> Prefer Read, Glob, and Grep for inspection

**这条指令被以约 4:1 的比例无视。**

这不只是风格问题，有实际代价：

| | Bash | Read |
|---|---|---|
| 输出上限 | **2000 行 / 50KB 硬截断**<br>`packages/runtime/src/tool-output.ts`，经 `shell-tools.ts:338` 的 `shapeTerminalResult` 施加 | **无上限**<br>`builtin-tools.ts:210-286` → `filesystem-worker/operations.ts:105-109` |

**agent 自己选进了会截断的那条路去读文件。**

### 2.3 最终步 prompt 的完整构成（113 题全样本实测）

按 role：

| role | 字符/任务 | 占比 |
|---|---:|---:|
| **tool**（工具结果） | **261,088** | **64.1%** |
| assistant | 143,900 | 35.3% |
| user | 2,312 | 0.6% |
| system | 253 | 0.1% |

assistant 内部按 content part 类型：

| part type | 字符/任务 | 占 assistant | 占整个 prompt |
|---|---:|---:|---:|
| **tool-call** | **140,182** | **97.4%** | **34.4%** |
| text | 3,718 | 2.6% | 0.9% |
| **reasoning** | **0** | **0%** | **0%** |

**98.5% 的 prompt 是工具往返（tool-result 64.1% + tool-call 34.4%）。**

两个直接推论：

- **优化 prompt 结构是死路** —— system prompt 只有 253 字符、6 个工具 schema 合计 2,986 字符，静态前缀总共占 1.3%。
- **`assistant:text` 只有 3,718 字符（0.9%）** —— agent 几乎不写自然语言说明，全在发工具调用。这与后文「59/59 自认完成、零自我怀疑」的观察一致：它没有在文本里做任何自我评估。

### 2.4 上下文裁剪的实证

裁剪不是推断，请求原文里有存根：

```json
"reason": "active_current_turn_tool_result_pruned_before_next_step"
"originalEstimatedTokens": 2100–14200
```

原文归档于 `agent/maka-task-run/tool-result-archives/`。

遥测层面表现为 input token **台阶式回落 1–9 次/题**（opencode 为 0–1 次，且那 1 次恒为 6882，是它自身的固定伪影）。

**权衡链条**：

```
裁剪 → 打断 KV cache 前缀 → uncached input 是 opencode 的 1.7 倍（17.8M vs 10.4M）
                            cache 命中率 99.19% vs 99.57%
     → 但避免几万 token 的命令输出随上下文累积
     → total token 反而少 8.6%（2.204B vs 2.413B）
     → output/reasoning 也更少（11.93M vs 13.25M；60.4% vs 66.2%）
```

**行为咬合**：maka 敢用 shell 当主工具、大把倾泻 `find`/`grep`/测试输出，正因为有裁剪兜底；opencode 没有裁剪，只能靠受控读取省上下文 —— 所以 read 工具用量高 53%，还要用 `todowrite`（2.3 次/题）把状态外化。代价是 opencode 更容易撞上限：**4 次 AgentTimeoutError、2 次 `reason=length`，maka 均为 0**。

---

## 三、失败解剖

### 3.1 失败形态分布（59 道有效失败）

| f2p 完成度 | 题数 | 占比 |
|---|---:|---:|
| 0% | 8 | 13.6% |
| 1–50% | 6 | 10.2% |
| 50–90% | 15 | 25.4% |
| **90–99%** | **30** | **50.8%** |

**f2p 缺口分布**（缺口 = f2p_total − f2p_passed）：

| 缺口 | maka | opencode |
|---:|---:|---:|
| **1** | **12** | **20** |
| 2 | 13 | 16 |
| 3 | 8 | 5 |
| 4 | 7 | 3 |
| ≥5 | 19 | 25 |
| 0（f2p 满但 reward=0） | 1 | 2 |

**maka 25/60（42%）、opencode 36/71（51%）的失败差距在 2 个测试以内。**

### 3.2 失败测试的断言类型（按 cell 归一化，131 个失败 cell）

按 cell 归一化是唯一不被巨型 cell 扭曲的口径（例如 `mnamer-daemon-watch-lifecycle` 单个 cell 就贡献了 49 条失败测试）。

| 类别 | 权重 | maka 份额 | opencode 份额 |
|---|---:|---:|---:|
| **wrong_value（实现了但语义算错）** | 63.81 | **52.1%** | **45.9%** |
| suite_did_not_run | 17.75 | 12.9% | 14.1% |
| api_shape（缺符号/签名不符） | 15.36 | 12.2% | 11.3% |
| concurrency_timing | 7.35 | 3.5% | 7.4% |
| feature_absent_noop | 6.96 | 6.6% | 4.2% |
| error_message_text | 6.09 | 4.5% | 4.8% |
| exception_behavior | 4.84 | 3.3% | 4.0% |
| ordering_determinism | 3.03 | 2.4% | 2.3% |
| perf_complexity | 2.14 | 1.9% | 1.4% |
| boundary_edge | 1.41 | 0.2% | 1.8% |
| unicode_encoding | 1.25 | 0.4% | 1.4% |
| type_detail | 1.00 | 0.0% | 1.4% |

**几个常见假设被数据否定**：Unicode/编码 <1%、类型系统细节 <1%、性能约束 1.6%、边界条件 1.1%、错误消息精确匹配 4.5% —— 都不是主因。

**真实大头是「实现了但语义算错」（约一半）。**

### 3.3 near-miss 完整清单：只差 1 个 f2p 测试

这批最能说明能力边界。**maka 12 道、opencode 20 道。**

#### maka（12 道，含具体断言）

| 题目 | f2p | 失败的测试与断言 |
|---|---|---|
| `anko-default-function-arguments` | 1/2 | `TestDefaultArgumentsVisible` — `ParseSrc error: syntax error - expected s...` |
| `anko-typed-variable-bindings` | 8/9 | `TestTypedBindingsAdditionalRepresentativeFlows` |
| `dateutil-rfc5545-timezone-interop` | 66/67 | `testToStrTZIDFromTzicalZone` — `assert 'TZID=Custom/Zone' in 'DTSTART;TZID=None:19970902T090000...'` |
| `dynamodb-toolbox-lazy-recursive-schemas` | 36/37 | `lazy schema > check > throws on invalid resolution` — 期望抛错但没抛 |
| `fastapi-deprecation-response-headers` | 136/137 | `test_nested_include_router_overrides_at_every_level` — `assert 'Tue, 01 Jan 2030...' == 'Sun, 15 Jun 2031...'` |
| `go-critic-doc-link-checker` | 2/3 | `TestCheckers/brokenDocLink` — `unmatched [strings.NewReader]: package "strings" is not imported` |
| `httpx-multipart-response-parsing` | 121/122 | `test_iter_multipart_part_headers_parsing[X: 1\r\n\tz\r\n\r\n]` — **`assert '1\tz' == '1 z'`** |
| `ipython-session-bundle-replay` | 16/17 | `..._raises_without_overwrite` — `isinstance(UsageError(...), FileExistsError)` 为 False |
| `meriyah-explicit-resource-declarations` | 48/49 | `Using in for-of loops` — `expected undefined to be 'using'` |
| `sql-formatter-bigquery-pipe-formatting` | 25/26 | `applies keywordCase upper to pipe keywords` — `Parse error at token: aggregate at line 1 column 44` |
| `tengo-callable-instance-isolation` | 22/23 | `TestCompiledFunctionCall_WrongArgumentCountReportsRuntimeStyleError` |
| `ytt-jsonpath-query-api` | 102/103 | `TestJSONPathFilterOnNonArray` — `Query("$.obj[?(@.a == 1)]") got 1 results, want 0` |

**这些失败的共性**：主干实现全部正确，丢分集中在「规格里提了一句、agent 没枚举到」的外围分支。最典型的是 `httpx` 那条 —— 整个多部分响应解析器写对了 121 个用例，只栽在 **HTTP header 折行续行（obs-fold）时制表符应折叠成空格**这一个参数化用例上：

```
raw_headers = b'X: 1\r\n\tz\r\n\r\n'
expected    = ('x', '1 z')      # 制表符 → 空格
actual      = ('x', '1\tz')     # 原样保留
```

差 2 个测试的另有 13 道：`katex-multicolumn-array-spans` 92/94、`participle-grammar-conflict-analysis` 89/91、`clack-async-autocomplete-options` 80/82、`superjson-error-stack-serialization` 78/80、`bandit-structured-nosec-directives` 67/69、`cattrs-partial-structuring-recovery` 67/69、`bandit-interprocedural-taint-checks` 64/66、`ink-grid-box-layout` 23/25、`gql-incremental-graphql-delivery` 15/17、`updo-policy-alerting` 15/17、`happy-dom-deterministic-intersectionobserver` 12/14、`quill` 11/13、`kgateway-consistent-hash-policy` 0/2。

其中：`bandit-interprocedural` 差的两个都是 **walrus 运算符**（`test_walrus_nested_taint_propagation`、`test_walrus_operator_sql_taint_detected`）；`superjson` 差的是 `maxCauseDepth=0 discards all causes` 与 `registerErrorStackProcessor fires even when no errorStack option is set`；`ink-grid` 差的是 `minmax in gridTemplateRows` 与 `minmax with fixed max`。

#### 两臂在同一道题上栽在同一个测试（同构的直接证据）

| 题目 | maka | opencode | 是否同一测试 |
|---|---|---|---|
| `anko-default-function-arguments` | 1/2 | 1/2 | ✅ `TestDefaultArgumentsVisible` |
| `dateutil-rfc5545-timezone-interop` | 66/67 | 66/67 | ✅ `testToStrTZIDFromTzicalZone` |
| `meriyah-explicit-resource-declarations` | 48/49 | 48/49 | ✅ `Using in for-of loops` |
| `ipython-session-bundle-replay` | 16/17 | 16/17 | ❌ 不同测试 |

**两个架构完全不同的 harness、两份不同的 patch，栽在同一个断言上** —— 这是「失败由模型能力边界决定」的最强证据。

### 3.4 终止方式：59/59 全部自认完成

```
maka_terminal_status = completed     59 / 59  (100%)
maka_error_class     = null          59 / 59
主动放弃                              0
达到步数上限                          0
超时 / 预算耗尽                       0
```

**每道失败题的最后一条 agent 消息都是成功宣告 + 功能清单。零次自我怀疑被表达。**

最刺眼的例子 `ts-pattern-match-each`（f2p **0/85**）：最终消息逐条列举 9 大类需求的满足情况，以「**Verification: full suite pass**」收尾 —— 而真相是整个 jest/ts 套件因一个类型错误编译失败，一个测试都没跑。

对照 opencode：`step_finish.reason = stop` 占 106/113（93.8%），另有 5 次 `tool-calls`、2 次 `length` 终止，且集中在失败题（6/73 vs 1/40）。

> 注意 maka 的 `completed` 是 harness 自报字段、**恒为 completed**，因此不具备区分力，不能用它做「早停」判据。

### 3.5 步数与结果

| | n | 均值 | 中位 | P25 | P75 | 最小 | 最大 |
|---|---:|---:|---:|---:|---:|---:|---:|
| maka 全部 | 112 | 166.9 | 151 | 122 | 200 | 62 | 469 |
| maka 通过 | 52 | 166.3 | **158.5** | 128 | 204 | 62 | 469 |
| maka 失败 | 60 | 167.5 | **147.5** | 118 | 189 | 72 | 410 |
| oc 全部 | 113 | 151.7 | 135 | 106 | 193 | 32 | 361 |
| oc 通过 | 40 | 155.4 | 142.5 | 110 | 203 | 32 | 285 |
| oc 失败 | 73 | 149.6 | 129 | 101 | 189 | 36 | 361 |

**分档通过率（呈倒 U 形，两臂形态一致）**：

| 步数档 | maka 通过率 | opencode 通过率 |
|---|---:|---:|
| <40 | — | 50.0% (1/2) |
| 40–80 | 50.0% (3/6) | **10.0% (1/10)** |
| 80–120 | 40.9% (9/22) | 35.3% (12/34) |
| 120–180 | 43.5% (20/46) | 38.2% (13/34) |
| **180–260** | **63.0% (17/27)** | **44.0% (11/25)** |
| ≥260 | 27.3% (3/11) | 25.0% (2/8) |

「步数过少 = 早停 = 失败」与「步数过多 = 打转 = 失败」同时存在。opencode 的短程运行更多（<80 步占 10.6% vs maka 5.4%），且 40–80 档只通过 1/10 —— 它的失败更偏向**收尾过早**。

### 3.6 改动规模

| | 文件数 均值/中位 | 新增行 均值/中位 | 删除行 均值/中位 | 补丁含测试文件 |
|---|---|---|---|---|
| maka 全部 | 11.5 / 9 | 1297 / 1281 | 42.4 / 10 | 109/112 |
| maka 通过 | 11.2 / 9 | 1322 / 1296 | 43.3 / 9 | 51/52 |
| maka 失败 | 11.8 / 9 | 1275 / 1231 | 41.6 / 12.5 | 58/60 |
| oc 通过 | 11.6 / 9.5 | 1267 / 1209 | **50.1** / 7 | 37/40 |
| oc 失败 | 9.4 / **7** | 1279 / 1324 | **29.2** / 8 | 64/73 |

- **maka 内部：通过 vs 失败在补丁规模上完全无区分力**（1296 vs 1231 行，文件数都是 9）。「改太少/改太多导致失败」在 maka 这边不成立。
- **opencode 独有的失效模式**：失败偏「只加不改」（通过题触及文件中位 9.5、删除旧代码 50 行；失败题分别是 7 和 29）。
- **最硬的一条**：**opencode 有 7/113 题产出完全空的 patch（新增行 = 0），7 题全部失败；maka 0/112**（最小新增 515 行）。这单一失效模式就占 opencode 73 个失败的约 10%。

---

## 四、确认的缺陷

### 🔴 P0：脱敏机制正在破坏源代码

#### 规则归因（113 题最终步 prompt 全样本）

**`[redacted]` 总数 2,055，涉及 110/113 个任务。**

| 触发规则 | 次数 | 占比 | 是否合理 |
|---|---:|---:|---|
| `value_pattern(no_key_prefix)` | 957 | **46.6%** | ❌ 主要是 git SHA / 摘要 |
| `bare_key` | 543 | **26.4%** | ❌ 裸 `key` 被无条件判敏感 |
| `suffix:token` | 398 | **19.4%** | ❌ 词法分析器的 token |
| `key_not_sensitive(?)` | 69 | 3.4% | ❌ |
| `suffix:password` | 55 | 2.7% | ⚠️ 部分合理 |
| `qualified_key:api_key` | 19 | 0.9% | ✅ **真正该脱** |
| `suffix:secret` | 9 | 0.4% | ⚠️ |
| `suffix:credentials` | 4 | 0.2% | ⚠️ |
| `qualified_key:secret_key` | 1 | 0.0% | ✅ |

**只有 20 处（0.9%）是真正的凭证。其余 99% 是误伤。**

#### 命中最多的键名

| 键名 | 次数 | 判定路径 |
|---|---:|---|
| `key` | **513** | `bare_key` |
| `token` | **188** | `suffix:token` |
| `password` | 45 | `suffix:password` |
| `nextToken` | 43 | `suffix:token` ← 分词器 |
| `ParsingToken` | 39 | `suffix:token` ← 解析器 |
| `Key` | 29 | `bare_key` |
| `parent_token` | 26 | `suffix:token` |
| `Token` | 16 | `suffix:token` |
| `prevToken` | 13 | `suffix:token` |
| `child_token` | 10 | `suffix:token` |
| `api_key` | 9 | `qualified_key:api_key` ✅ |
| `apiKey` | 7 | `qualified_key:api_key` ✅ |
| `command_done_token` | 6 | `suffix:token` |
| `topToken` / `lastToken` | 各 5 | `suffix:token` |

`nextToken`、`ParsingToken`、`prevToken`、`topToken`、`lastToken` —— **全是词法分析/解析器的 token 概念，与凭证毫无关系。**

#### 真实案例：`abs` 解释器的源码被打烂

```go
// 案例 1：字符串对象构造（suffix:token 触发）
return &object.String{Token: [redacted] Value: os.Args[i]}

// 案例 2：错误消息里的 hash key（bare_key 触发）
return newError(iex.Token, "unusable as hash key: [redacted]", index.Type())

// 案例 3：连变量赋值都被吃掉（key_not_sensitive 分类下）
key :[redacted] canonicalModulePath(file)
```

第三例尤其严重 —— `key := canonicalModulePath(file)` 这行 Go 赋值语句，**右侧整个函数调用被抹掉**，agent 完全看不到这个变量是怎么算出来的。

其他语言同样中招：

```go
// kgateway（qualified_key:secret_key，这条勉强算合理但对象是常量名）
wellknown.OAuth2HMACSecretKey: [redacted]

// gin 中间件（qualified_key:api_key，同样是变量赋值被吃）
if apiKey :[redacted] c.GetHeader("X-API-Key"); a...
```

#### 受影响最严重的任务

| 任务 | `[redacted]` 处数 |
|---|---:|
| `textual-kitty-key-phases` | **173** |
| `go-git-worktree-merge-conflicts` | 151 |
| `cliffy-config-file-parsing` | 130 |
| `python-statemachine-state-data-scoping` | 109 |
| `meriyah-explicit-resource-declarations` | 100 |
| `happy-dom-deterministic-intersectionobserver` | 87 |
| `pest-character-class-coalescing` | 77 |
| `textual-richlog-follow-state` | 76 |
| `mobly-grouped-test-barriers` | 68 |
| `superjson-error-stack-serialization` | 61 |
| `katex-multicolumn-array-spans` | 57 |
| `goreleaser-retry-publish-auditing` | 55 |

**注意 `textual-kitty-key-phases`**：题目本身就是关于 key phases（按键阶段）的，标识符里必然大量出现 `key` —— 173 处误脱敏几乎让 agent 无法阅读该任务的核心代码。

**旁证**：`cliffy-config-file-parsing` 命中 130 处，同时它的 `/app/command/command.ts` 被重读了 **26 次** —— 与「拿回来是乱码所以反复重读」高度一致。

#### 根因代码

`packages/core/src/redaction.ts`：

```js
// L1-10：'token' 在敏感后缀集合里
const SENSITIVE_KEY_SUFFIXES = new Set([
  'auth','authorization','credential','credentials',
  'passwd','password','secret','token',        // ← 元凶之一
]);

// L23-25：匹配任意 `标识符: 值` 或 `标识符=值`，不看上下文
const ASSIGNED_SECRET_KEY_VALUE_PATTERN =
  /\b(([A-Za-z][A-Za-z0-9_-]*)(?:[ \t]|\\\r?\n)*[:=](?:[ \t]|\\\r?\n)*['"]?)(?:\\\r?\n|[^\s"'&<>])+/g;

// L36-42：值形态匹配，最后一条吃掉一切 40 位以上十六进制
const SECRET_PATTERNS: RegExp[] = [
  /\b(sk-(?:ant-)?[a-z0-9_-]{8,})\b/gi,
  /\b(AIza[0-9A-Za-z_-]{20,})\b/g,
  /\b(gh[pousr]_[0-9A-Za-z_]{20,})\b/g,
  /\b(xox[abprs]-[0-9A-Za-z-]{10,})\b/g,
  /\b([a-f0-9]{40,})\b/gi,                     // ← git commit SHA 正好 40 位
];

// L159-168：裸 key 被无条件判为敏感
function isSensitiveKey(key: string): boolean {
  const segments = sensitiveKeySegments(key);
  const suffix = segments.at(-1);
  if (!suffix) return false;
  if (suffix !== 'key') return SENSITIVE_KEY_SUFFIXES.has(suffix);
  if (segments.length === 1) return true;      // ← 元凶之二
  if (SENSITIVE_KEY_QUALIFIERS.has(segments.at(-2) ?? '')) return true;
  const qualifiedKey = segments.slice(-3).join('_');
  return qualifiedKey === 'service_account_key' || qualifiedKey === 'secret_access_key';
}
```

**这套规则本是为 shell 环境变量赋值（`API_KEY=xxx`）设计的，却被无差别地作用到了文件内容与 grep 输出上。**

而且脱敏对模型是**静默的** —— 除了信封里一个 `redacted: true` 标志，模型不知道内容被改过、改了几处、改的是什么。

#### 修复方案（按收益排序）

| # | 改动 | 消除 | 工作量 |
|---|---|---:|---|
| 1 | `SECRET_PATTERNS` 的 `[a-f0-9]{40,}` 排除恰好 40/64 位纯 hex（git SHA、SHA-256） | ~957 处（46.6%） | 1 行 |
| 2 | `isSensitiveKey` 删除 `if (segments.length === 1) return true` | 543 处（26.4%） | 1 行 |
| 3 | `token` 移出 `SENSITIVE_KEY_SUFFIXES`，改为需限定词（`auth_token`/`access_token` 才脱） | 398 处（19.4%） | 1 行 |
| 4 | 按来源分流：文件内容/grep 输出不走键名匹配，只保留高置信值形态 | 治本 | M |
| 5 | 脱敏后告知模型脱了几处、什么类型 | 可观测性 | S |

**前三条都是一行改动，合计消除约 92% 的误伤。**

### 🟠 P1：pruning 在 87% 上下文空闲时触发

#### 触发条件是固定阈值，不是上下文压力

`packages/runtime/src/active-tool-result-prune.ts:115`：

```ts
if (policy?.enabled !== true || input.stepNumber < minStepNumber) { … }
const maxResultEstimatedTokens =
  finitePositive(policy.maxCurrentResultEstimatedTokens)
  ?? DEFAULT_MAX_CURRENT_RESULT_ESTIMATED_TOKENS;   // 2048 tok ≈ 8KB
// 每个 part：
if (originalEstimatedTokens <= input.maxResultEstimatedTokens) return { changed: false };
```

默认开启（`context-budget-policy.ts:124-139`，env `MAKA_CONTEXT_ACTIVE_TOOL_RESULT_PRUNE`）。

**而同一次运行的 telemetry 显示 108 步跑完仍有 `contextRemaining: 871527` —— 约 87% 的窗口未使用，且全 benchmark budget exhaustion = 0%。**

#### 前缀断裂的实测（20 题采样）

| 指标 | 实测值 |
|---|---:|
| 前缀断裂次数 | **10.8 次/任务** |
| 其中由裁剪导致 | **10.8 次/任务（100%）** |
| 因断裂而重算的量 | **30,338 tokens/任务** |
| 额外 miss 成本 | **$0.0044/run** |

**100% 的前缀断裂都由裁剪造成** —— 因果链坐实（不是别的原因打断 cache）。

断裂最多的任务：

```
koota-entity-snapshot-rollback       步 156  断裂 27  重算 95,505 tok
sqlfmt-create-table-ddl-formatting   步 263  断裂 27  重算 71,632 tok
mashumaro-flattened-dataclass-fields 步 224  断裂 15  重算 48,062 tok
bandit-incremental-cache-control     步 127  断裂 14  重算 41,927 tok
fd-deterministic-multi-key-sorting   步 125  断裂 14  重算 42,994 tok
```

#### 经济账（修正后）

| | tokens | USD |
|---|---:|---:|
| cache-read 支出 | 19.5M | 0.0566 |
| cache-miss 支出 | 161k | 0.0233 |
| 裁剪节省（避免的 cache read） | 6.2M | **−0.0180** |
| 裁剪代价（实测前缀断裂） | 30.3k | **+0.0044** |

**净收益约 +$0.014/run**（先前基于估算的 +$0.010 略微低估）。

> **结论**：pruning 在钱上是净赚的，**问题不在成本，在于它在完全没有上下文压力时每轮无谓地打断 11 次 cache 前缀、丢掉信息让模型再用 ArchiveRead 取回。**

#### 修复方向

高水位机制**代码里已经有了**：

- `mid-turn-capacity-compact.ts:58-85` 的 `exceedsHighWater(estimated > contextWindow - reserve)`
- `active-full-compact.ts:466-472` 的 `highWaterRatio`（默认 0.8）

把同样的判据加到 `context-budget-policy.ts` 的 active-prune 策略上，低于约 0.6 窗口时 no-op。风险很低：本次 0% budget exhaustion，且 `mid-turn-capacity-compact` 天然是兜底。

### 🟠 P1：Bash 结果信封的样板开销

每条 Bash 结果都带固定 JSON 信封，**即使 stdout 为空也约 150 字符**：

```json
{"kind":"terminal","cwd":…,"status":…,"exitCode":0,
 "output":{"mode":"pipes","stdout":…,"stderr":"",
           "stdoutTruncated":false,"stderrTruncated":false,"redacted":false}}
```

按约 123 条 Bash 结果/运行计：约 18k 字符（~4.6k tokens）纯样板，被携带进后续约 163 次请求中的每一次

≈ **0.75M cache-read tokens/run，全 benchmark 约 85M**，零信息量。

**修复**：`packages/runtime/src/bash-model-output.ts` 已在剥离回显的 `cmd`，扩展它去掉零值字段（`stderr:""`、`stdoutTruncated:false`、`stderrTruncated:false`、`redacted:false`、`mode`、未变化时的 `cwd`）。**纯削减，零行为变化。**

### 🟠 P1：归档占位符过大

`ActiveArchivedToolResultPlaceholder` 每个 **1,276 字符（约 320 tokens）**，包含 `artifactId` + 完整 `resourceRef` URL + sha256 + bytes + 一段 `readInstructions` 散文（`tool-result-archive-resource.ts:146`）。

11 个占位符 × 320 tokens × 重发约 163 步 ≈ **0.58M cache-read tokens/run，全 benchmark 约 43M**。

**修复**：把 `readInstructions` 移进 ArchiveRead 的工具 schema（只出现一次），消息里只留约 120 字符的句柄。约 3 倍削减。

### 🟡 P2：Read 无窗口，整文件直入裁剪路径

`builtin-tools.ts:210-286` → `filesystem-worker/operations.ts:105-109`：无 `offset`/`limit` 时返回整个文件。

Read 结果在最终 prompt 中均值 **47,229 字符**，**最大 263,960**。

形成一条病理流水线：

```
步 N   付整文件全价
步 N+1 超过 2048 tok 被 active-prune 归档
之后   每步付 320 tok 占位符 × 约 150 步
可能   再付一次 ArchiveRead
```

**模型对一个付了全价的文件，只获得了一步的访问权。**

另外 Read 结果带每行 `%6d\t` 前缀（约 8 字符/行）。而 Edit 是按字符串匹配的（`edit-replace.ts`），不按行号 —— 完整行号是约 2 tokens/行的纯开销。

**修复**：给 Read 默认窗口（对齐 Bash 的 50KB），附 `showing lines A-B of N, call Read with offset= for more` 页脚；考虑稀疏化行号。需与 pruning 修复配对，否则窗口化的读取仍会被归档。

### 🟡 P2：reasoning effort 全程钉死在 max

每个捕获的请求都带 `providerOptions: {"deepseek": {"reasoningEffort": "max"}}` —— **包括下一步动作只是 `git status`、`ls`、`cat` 的那些步骤**。

reasoning 占输出 tokens 的 **60.4%**（105k 输出中 65k 是推理）。

这是**架构性的**：effort 在 `packages/runtime/src/model-factory.ts:304-400` 的 `buildProviderOptions` 中**每会话解析一次**，存为 `AiSdkBackendInput.providerOptions`（`ai-sdk-backend.ts:333`），此后每次请求原样传递（`ai-sdk-backend.ts:548`、`model-adapter.ts:166,200`）。**没有任何 per-step 或 per-tool 钩子。**

**修复**：在 `ai-sdk-backend.ts` 的步循环里贯通可选的 per-step `providerOptions` 覆盖（它已在 `:1238-1249` 每步重建投影），加策略：纯检查类结果之后降到 `low`/`medium`，测试失败或 Edit 之后恢复 `max`。

**风险**：effort 变更可能影响 reasoning-signature 重放路径（`ai-sdk-backend.ts:640,666,1344-1368`），且在 `request-shape.ts` 的 `protocolIndependentReasoningEffort` 中被归一化 —— 必须先验证前缀哈希不会逐步 churn。

---

## 五、已排除的假设

### ❌ 「历史 reasoning 每步被全量重放」—— 113 题全样本证伪

**曾经的推断**：assistant 消息占 prompt 35.7%（约 37k tokens），reasoning 是 40.5k tokens/run，两者同一数量级，故推测历史 reasoning 被重放（约 6M cache-read tokens/run，占全部输入 30%）。

**实测结果**：

```
assistant 内部拆分（113 题全样本）
  tool-call    140,182 字符/任务   占 assistant 97.4%
  text           3,718 字符/任务   占 assistant  2.6%
  reasoning              0                        0%
```

**最终步 prompt 里 reasoning part 一个字符都没有。**

两个数字量级接近纯属巧合，是典型的相关性误判。maka 只在当轮回传 reasoning（DeepSeek 带 tools 的多轮要求原样回传 `reasoning_content`，否则 400），历史轮次的推理不进后续 prompt。

**该优化项从清单移除。**

### ❌ 「失败是因为不做自我验证」

| 指标 | maka 失败 (61) | maka 通过 (52) |
|---|---:|---:|
| 测试调用次数 | **24.5** | **24.0** |
| 步数 | 179.2 | 181.2 |
| 成功 Edit | 30.2 | 30.6 |
| 失败 Edit | 1.2 | 1.3 |
| Edit 重试（同目标） | 1.8 | 2.2 |
| 读取事件 | 67.9 | 64.2 |
| 重复读 | 34.8 | 32.1 |
| **reasoning tokens** | **66.2k** | **60.9k** |

从未跑过测试的：通过组 1/52，失败组 3/61。最后一次测试之后还改了代码的：通过 3、失败 3。

**一个「必须跑测试才能结束」的硬 gate，最多只影响 61 个失败中的 6 个。**

另一个口径（跨臂对比）：

| | maka 全部 | maka 通过 | maka 失败 | oc 全部 | oc 通过 | oc 失败 |
|---|---:|---:|---:|---:|---:|---:|
| 测试命令次数 均值 | 19.9 | 19.2 | 20.4 | 20.9 | 19.2 | 21.8 |
| 全程 0 次测试 | 1 (0.9%) | 1 | 0 | 4 (3.5%) | 3 | 1 |
| **最后一次改动后仍跑过测试** | **72.3%** | 75.0% | 70.0% | **40.7%** | 45.0% | 38.4% |
| 首次跑测试的相对位置（中位） | 0.42 | 0.44 | 0.41 | 0.40 | 0.43 | 0.40 |

**真正的系统性差异在验证的「位置」而非「次数」**：maka 在 72.3% 的题里最后一次修改之后仍跑过测试，opencode 只有 40.7%，差 31.6pp，覆盖全部题目、方向一致。而且这个口径对 maka 是保守的（maka 更多通过 bash 做写文件动作，容易把「最后一次改动」推到轨迹尾部）。

**但要泼冷水**：该指标在**臂内**对通过/失败的区分力很弱（maka 75% vs 70%，oc 45% vs 38%）。它是稳定的 harness 行为特征，**不是能单独解释通过率的强因果**。

**真正的问题在验证的内容**：agent 验证的是**自己写的测试**（失败组人均在 patch 里新建 1.76 个测试文件，通过组 1.23 个），而自己写的测试恰好只覆盖自己已经想到的分支。**这是闭环的自我确认，不是验证。**

### ❌ 「pruning 丢失上下文导致失败」

| 指标 | 失败 59 | 通过 52 |
|---|---:|---:|
| n_agent_steps 均值/中位 | 166.1 / **146** | 164.3 / **156.5** |
| 重复读取同一文件 | **7.5 / 3** | **9.4 / 6** |
| 唯一读取文件数 | 9.3 / 7 | 10.6 / 8 |
| 输出 token | 108k | 103k |

失败题**并不更长**（中位数反而少 10 步），且「后期重读早期已读文件」这个裁剪丢信息的直接指纹**在失败题里出现得更少**。若裁剪在伤害失败题，方向应该相反。

**该假设应从失败归因中移除**（pruning 仍有 P1 级的触发时机问题，但那是效率问题不是失败原因）。

### ❌ 「重复读文件浪费了大量步数」—— 被高估 11 倍

早先的统计（仅按路径去重）给出「3,793 次重读、均值 33.5/题」，据此把「重读短路」列为潜在 10–20% 步数的改进。**按 `(路径, 行范围)` 重算后，这个数字塌了。**

| 口径 | 重复次数 | 均值 | 占读取事件 |
|---|---:|---:|---:|
| 按路径去重（旧） | 3,208 | 28.6/题 | 49.4% |
| **按 (路径, 行范围) 去重（新）** | **285** | **2.5/题** | **4.4%** |

**2,923 次（占旧口径 91.1%）是 `sed` 窗口滚动，不是真重复。**

也就是说，agent 反复出现在「同一个文件」上，绝大多数是它在**分段阅读一个大文件**（`sed -n '1,40p' f` → `sed -n '400,440p' f`），这是合理行为而非浪费。真正「读了完全相同的内容两次」只有 2.5 次/题。

真重复最多的几个任务（读取事件 / 唯一路径 / 旧口径重复 / 真重复）：

```
koota-entity-snapshot-rollback         77 / 35 / 42 / 15    world.ts×11
aiomonitor-task-snapshots-diff         59 / 17 / 42 / 13    monitor.py×9
dynamodb-toolbox-lazy-recursive-schemas 140 / 99 / 41 / 11   decodedValue.ts×7
koota-query-predicates                 95 / 54 / 41 /  9    query.ts×12
happy-dom-abort-pending-body-reads     85 / 27 / 58 /  8    Response.ts×14
```

即便是最严重的 `koota-entity-snapshot-rollback`，156 步里真重复也只有 15 次。

**「重读短路 + cwd 规范化」这项改进据此降级**：收益从「潜在 10–20% 步数」降到可忽略。

> **脚本正确性校验**：本次提取的工具调用普查为 Bash 13,921 / Edit 3,575 / Read 2,053 / Write 613 / Grep 149 / Glob 42，与 §2.1 独立统计的数字完全一致，确认 schema 解析无误。
>
> 一处已知噪声：`yaegi-go-embed-directives` 的「最常读文件」被记为 `==`，是 `cat` 正则误匹配了 shell 比较运算符，影响该题的路径计数但不影响总体量级。

### ❌ 「过度修改改坏了原功能」

| 组合 | maka | opencode |
|---|---:|---:|
| f2p 不足、p2p 满分 | 54 | 66 |
| f2p 不足且 p2p 有回归 | 6 | 5 |
| **纯粹「改坏原有测试」** | **0** | **1** |

121 个有 `base-ctrf.json` 的 cell 中，**base 阶段 p2p 失败数为 0**。

maka 60 个可判失败里 6 个（10.0%）涉及 p2p 回归，但拆开看真正的回归只有 3–4 道，且与新功能高度同源（例：`go-critic` 的 `TestCheckers` 父用例连坐于新增子用例 `TestCheckers/brokenDocLink`）。

### ❌ 「prompt 结构可优化」

system prompt 253 字符 + 6 个工具 schema 2,986 字符 = 占最终 prompt 的 **1.3%**。静态前缀已经极小。

---

## 六、benchmark 侧的假阴性

### 59% 的失败 f2p 测试根本没执行

1,840 条失败 f2p 记录里 **1,090 条（59.2%）**的 CTRF 消息是：

```
missing from report (test did not run or produced no result — see raw output)
```

集中在 **18 个 cell**（maka 8 / opencode 10）。

### 机制与 issue #31 的描述不同

DeepSWE [issue #31](https://github.com/datacurve-ai/deep-swe/issues/31) 称问题出在「base 非零退出」。**实测的真实触发点是 verifier 的 fail-closed 规则**：

```
[verifier] model.patch applied (44913 bytes)
[verifier] Resetting files touched by test.patch
[verifier] Applying test.patch
[verifier] base deno rc=0 (nonzero on failing tests is normal; graded from XML)
[verifier] new deno rc=1
Searching for JUnit reports matching pattern: /logs/verifier/base.xml
Found 1 JUnit report files
Converting 466 test cases to CTRF format
[verifier] new: no JUnit XML produced (expected for nop new-mode)
[verifier] new: missing/invalid CTRF — its whitelisted ids count as failed
        → P2P 451/451 pass 0 fail; F2P 0/37 pass 37 fail; PARTIAL 0.924; BINARY 0
```

**base 阶段跑出 466 个用例、p2p 451/451 全过；new 阶段一个 XML 都没产出，37 条 f2p 就被规则性地全判失败。** 代码能编译能跑，只是目标测试没进报告。

### 受影响清单

| arm | task | f2p 全灭 |
|---|---|---:|
| maka | `cliffy-config-file-parsing` | 37 |
| maka | `geo-shapeindex-serialization` | 23/24 |
| maka | `obsidian-linter-auto-table-of-contents` | 41 |
| maka | `prometheus-transactional-reload-status` | 15 |
| maka | `returns-validated-error-accumulation` | **159** |
| maka | `ts-pattern-match-each` | 85 |
| maka | `wasmi-trap-coredumps` | 22 |
| opencode | `effect-sse-httpapi-streaming` | 47 |
| opencode | `etree-xml-diff-patch` | 52 |
| opencode | `kcp-go-multiplexed-kcp-streams` | 14 |
| opencode | `kysely-window-grouping-helpers` | **254** |
| opencode | `obsidian-linter-auto-table-of-contents` | 41 |
| opencode | `onedump-dump-encryption-pipeline` | 67 |
| opencode | `ts-pattern-match-each` | 85 |
| opencode | `updo-policy-alerting` | 6 |
| opencode | `yaegi-go-embed-directives` | 38 |
| opencode | `ytt-jsonpath-query-api` | 92 |

### 跨臂铁证

`obsidian-linter-auto-table-of-contents`（41/41）与 `ts-pattern-match-each`（85/85）在 maka 和 opencode 上出现**完全相同的全灭数字**。两个 harness、两份不同的 model.patch，**不可能碰巧产生同样的结果** —— 只能是任务侧的测试收集/报告配置有问题。

### 其中部分是 agent 自伤，可修

**案例 A `returns-validated-error-accumulation`** — f2p 0/159，p2p 61/61：

```
_ ERROR collecting tests/test_validated/test_validated_functions/test_validated.py _
import file mismatch:
imported module 'test_validated' has this __file__ attribute:
HINT: remove __pycache__ / .pyc files and/or use a unique basename for your test file modules
!!!!!!!!!! Interrupted: 1 error during collection !!!!!!!!!!
```

agent 自建测试文件的 basename 与既有测试模块冲突（该包无 `__init__.py`），pytest 全量收集中断。

**旁证**：`verifier/reports/base.xml` 9,170 字节，`new.xml` 仅 **742 字节** —— 打完 patch 那次几乎没产出任何 testcase 记录。功能实现本身可能是对的（p2p 61/61 全过），159 个隐藏测试**一个都没执行**。

**案例 B `ts-pattern-match-each`** — f2p 0/85，p2p 6/6：

```
● Test suite failed to run
  tests/match-each.test.ts:617:15 - error TS2345:
  Argument of type 'undefined' is not assignable to parameter of type 'KnownPattern<null>'.
  617   .with(undefined, () => 'is-undef')
```

已逐 hunk 核对 model.patch：agent 自己写的测试只有 56 个 `it()` 且不含 `.with(undefined`，所以 617 行属于 verifier 换上的官方测试文件。**一个类型级 bug → 整个 jest/ts 套件编译失败 → 85 个测试全灭**。运行时逻辑很可能完全正确。

**案例 C `valibot-recursive-schema-composition`** — f2p 2/10：

```
src/methods/recursive/recursive.test-d.ts(25,26): error TS2339:
  Property 'recursive' does not exist on type 'typeof import("/app/library/src/methods/index")'.
src/methods/recursive/recursive.test-d.ts(18,40): error TS2339:
  Property 'Recur' does not exist on type '...src/methods/index'.
```

agent 的 patch 落在 `library/src/schemas/recur/`、`library/src/schemas/recursive/`，并改了 `library/src/schemas/index.ts`；**`library/src/methods/index.ts` 完全没碰**。

**放错命名空间** —— 功能写了、导出了、agent 自己的测试也过了，但官方测试从 `src/methods/index` 导入。

**案例 D `prometheus-typed-label-sorting`** — f2p 0/17，测试全部真实执行（唯一一道 0 分且非套件崩溃的题）：

```
expected: [" lead", "+Inf", "10", "-Inf", "-1h", "30m", "2KB", "v1.2.3",
           "10.0.0.2", "::ffff:10.0.0.1", "10.0.0.0/16", "2024-12-31T23:00:00Z", "node-10"]
actual  : [" lead", "+Inf", "-1h", "-Inf", "2KB", "10", "10.0.0.0/16",
           "10.0.0.2", "30m", "2024-12-31T23:00:00Z", "::ffff:10.0.0.1", "node-10", "v1.2.3"]
```

agent 实现了逐值类型识别，但把排序做成了「识别类型后在值级别比较」；规格要求的是**全局类型优先级**（先按类型分组定序，组内再排）。**一个语义层面的误读，17 个测试整齐全灭。**

### 修正后的真实通过率上界

```
maka:      观测 46.0%  →  上界 (52+8)/113 = 53.1%
opencode:  观测 35.4%  →  上界 (40+10)/113 = 44.2%
```

### 可自动化的筛选规则

```
p2p == 1.0  AND  f2p == 0.0  AND  f2p_total >= 5   →  疑似 verifier 假阴性
```

这些 cell 的 `partial` 分普遍在 **0.92–0.96**（cliffy 0.924、geo 0.963、obsidian 0.965），远高于正常「部分通过」的平均 83%/88% —— **p2p 几乎全过、f2p 全灭，这个组合本身就是强特征。**

---

## 七、两臂对比：高度同构

### 失败类别分布几乎重叠

| 类别 | maka | opencode | 差 |
|---|---:|---:|---:|
| wrong_value | 52.1% | 45.9% | −6.2pp |
| suite_did_not_run | 12.9% | 14.1% | +1.2pp |
| api_shape | 12.2% | 11.3% | −0.9pp |
| error_message_text | 4.5% | 4.8% | +0.3pp |
| ordering_determinism | 2.4% | 2.3% | −0.1pp |

唯一超过 3pp 的差异是 `concurrency_timing`（3.5% vs 7.4%），但只对应 opencode 多 6 个 cell 的量级，样本太小。

### 逐题重合

多道题两臂**失败在同一批测试上**：`obsidian-linter-auto-table-of-contents`（两臂都 41/41 全灭）、`ts-pattern-match-each`（都 85/85）、`anko-default-function-arguments`（都 1/2 且同一测试）、`dateutil-rfc5545-timezone-interop`（都 66/67 且同一测试）、`meriyah-explicit-resource-declarations`（都 48/49 且同一测试）、`koota-query-predicates`、`valibot-recursive-schema-composition`、`kombu-virtual-queue-dead-lettering`、`dynamodb-toolbox-lazy-recursive-schemas`、`scriggo-method-declarations`。

> **结论：失败模式由模型能力边界 + benchmark 缺陷共同决定，不是 harness 差异。maka 相对 opencode 的 12 分优势体现在「多解出了一些题」，而不是「失败方式不同」。**

### 系统性差异汇总

| # | 差异 | 覆盖 | 判定 |
|---|---|---|---|
| 1 | maka shell 主导（68.4% vs 54.8%），opencode read 工具多 53% | 全覆盖 | **系统性** |
| 2 | maka 更倾向「最后一次改动后仍再跑测试」（72.3% vs 40.7%） | 全覆盖，口径对 maka 保守 | **系统性**（臂内区分力弱） |
| 3 | 测试命令次数（19.9 vs 20.9） | 全覆盖 | **无差异** |
| 4 | 首次测试时机（均约 0.41） | 全覆盖 | **无差异** |
| 5 | 两臂失败几乎都以「自认完成」结束（100% vs 91.8%） | 全覆盖 | **系统性共性** |
| 6 | opencode 异常终止集中在失败题（6/73 vs 1/40）+ 4 次 timeout | n 小 | 真实、非主导 |
| 7 | 通过题步数中位高于失败题（+11 / +13.5），通过率呈倒 U | 全覆盖，两臂同号 | **系统性弱信号** |
| 8 | 补丁规模两臂无差异；maka 内部对成败无区分力 | 全覆盖 | **无差异** |
| 9 | opencode 失败偏「只加不改」（通过文件 9.5 vs 失败 7；删除行 50 vs 29） | 113 题内部 | opencode 独有 |
| 10 | **opencode 7 题产出空 patch 且全挂；maka 0 题** | 7/113 vs 0/112 | **系统性**（占 oc 失败约 10%） |
| 11 | maka 裁剪造成上下文台阶回落 + cache miss 翻倍，换总 token 少 8.6% | 抽样过半 | **系统性** |

**最能解释通过率差距的三项**：opencode 的**收尾阶段质量低** —— 更早宣告完成（#2）、更容易根本没落到实际改动上（#10）、只加不改（#9）。

---

## 八、改进清单

| 优先级 | 改动 | 实测依据 | 工作量 | 风险 | 代码位置 |
|---|---|---|---|---|---|
| **P0-1** | `[a-f0-9]{40,}` 排除 40/64 位纯 hex | 消除 957 处（46.6%） | 1 行 | 低 | `redaction.ts:41` |
| **P0-2** | 删除 `if (segments.length === 1) return true` | 消除 543 处（26.4%） | 1 行 | 低 | `redaction.ts:164` |
| **P0-3** | `token` 移出 `SENSITIVE_KEY_SUFFIXES` | 消除 398 处（19.4%） | 1 行 | 低 | `redaction.ts:8` |
| **P0-4** | 文件内容/grep 输出不走键名匹配 | 治本 | M | 中 | `shell-*.ts` 调用点 |
| **P1-1** | 剥离 Bash 结果信封零值字段 | ~85M tokens | S | 无 | `bash-model-output.ts` |
| **P1-2** | 归档占位符 1276→~120 字符 | ~43M tokens | S | 无 | `tool-result-archive-resource.ts:146` |
| **P1-3** | pruning 改按上下文压力触发 | 消除 10.8 次/任务的无谓断裂 | S | 低 | `context-budget-policy.ts`（复用 `exceedsHighWater`） |
| **P1-4** | 提交前「测试运行器完整性」gate | 7 个 maka cell / 382 条测试可回收，46.0% → **49.6~53.1%** | M | 低 | 新增收尾检查 |
| ~~P2-1~~ | ~~重读短路 + cwd 规范化~~ | **实测后降级**：真重复读仅 2.5 次/题（见 §5 末），收益可忽略 | — | — | — |
| P2-2 | Read 默认窗口化、稀疏行号 | 大文件任务 | M | 中 | `builtin-tools.ts:210` |
| P2-3 | per-step reasoning effort | ~40% 输出量 + 延迟 | M | 中（前缀 churn） | `ai-sdk-backend.ts:1238` |
| P2-4 | 把 agent 推离「Bash 当 Read 用」 | 37% 的工具调用 | S（改 prompt） | 可能不生效 | `system-prompts.ts:12-17` |

### P1-4 的具体检查内容（均可自动化）

- **Python**：新建测试文件的 basename 是否与仓库已有测试模块重名（无 `__init__.py` 的包会触发 pytest `import file mismatch`）
- **TypeScript**：跑仓库自身的全量 typecheck（`tsc --noEmit` / `pnpm typecheck`），**必须包含 test 目录**，而不只是 agent 改过的文件
- **通用**：提交前用干净 checkout + 只保留 src 改动（剔除 agent 自建测试）跑一次全量套件，确认收集/编译阶段零错误
- **API 落位**：新增的公共符号能否从包的规范入口（`index.ts` / `__init__.py`）import 到

### 明确不要做的

| | 理由 |
|---|---|
| ❌ 加大测试执行频次预算 | 失败/通过组 24.5 vs 24.0，已饱和 |
| ❌ 为这批失败改 pruning 策略 | 步数与重读数据方向相反，假设已被排除 |
| ❌ 加「更保守、少改动」约束 | 纯过度修改 maka **0** 例 |
| ❌ 优化 prompt 结构 | 静态前缀仅占 1.3% |
| ❌ 丢弃历史 reasoning 块 | 实测 reasoning 根本不在后续 prompt 里 |

---

## 九、方法与数据来源

### 数据位置

| 数据 | 路径 |
|---|---|
| 评测产物根目录 | `/mnt/deepswe/runs/full/deepseek-v4-flash-maka-vs-opencode-deepswe-full-v1/`（节点 `dhb`） |
| 逐 cell 轨迹 | `jobs/*/ab-{arm}-r0-{task}/{task}/trial/{task}__{hash}/agent/trajectory.json` |
| maka 每步请求原文 | `.../agent/maka-task-run/runs/artifacts/{uuid}/*-provider-request-step-{N}-*.json` |
| 裁剪归档 | `.../agent/maka-task-run/tool-result-archives/` |
| 验证证据 | `.../verifier/{ctrf.json, base-ctrf.json, new-ctrf.json, reward.json, test-stdout.txt, run.log}` |
| 候选补丁 | `.../artifacts/model.patch` |
| 逐请求遥测 | `.../{task}/provider-request-telemetry.json` |
| 控制器 WAL | `controller/results.jsonl`、`controller/results.jsonl.attempts.jsonl` |
| 逐题结果 CSV | `docs/eval/deepswe-1.1-deepseek-v4-flash-maka-vs-opencode.csv` |

### 复现时的两个坑

1. **trial 目录名被截断到 32 字符**（如 `vulture-persistent-analysis-cach__9r5AU8F`），按完整 task 名 glob 会漏掉 82 个 cell。
2. **不要用 `glob(..., recursive=True)`** —— 会递归进 `submitted-snapshots`（61.5 GB、每 cell 500+ 文件），慢到不可用。请写明确层级：
   ```
   {cell}/*/trial/*/agent/maka-task-run/runs/artifacts/*/*provider-request-step-*.json
   {cell}/*/trial/*/verifier/ctrf.json
   {cell}/*/trial/*/agent/trajectory.json
   ```

### 分析口径说明

- **按 cell 归一化**：统计失败测试类别时，每个 cell 权重 1.0、按其失败测试的类别比例分摊。这是唯一不被巨型 cell 扭曲的口径 —— 例如 `mnamer-daemon-watch-lifecycle` 单个 cell 贡献 49 条失败测试、`kombu-virtual-queue-dead-lettering` 贡献 55 条，按条数统计会被它们主导。
- **前缀断裂实测**：按步排序请求原文，JSON 规范化每条消息，找到相邻 prompt 首个分歧下标；仅当分歧下标小于旧 prompt 长度（即历史被改写，而非纯追加）才计为断裂。分歧处新消息含 `active_archived_tool_result` 而旧消息没有时，判定为裁剪导致。采样 20 题。
- **成本折算**：$0.145/M 未缓存输入、$0.0029/M 缓存命中、$0.29/M 输出（manifest 冻结的定价，与 DeepSeek 官方现价 $0.14/$0.0028/$0.28 有约 3.5% 偏差，两臂同口径不影响比较）。

---

## 十、未完成项

1. ~~按 `(路径, 行范围)` 重算重复读~~ —— **已完成，见 §5 末「重复读被高估 11 倍」。结论：真重复仅 285 次（2.5/题），91.1% 的所谓「重读」是 `sed` 窗口滚动。「重读短路」改进已据此降级。**
2. **`tool-call` 占 34.4% 的成分拆解** —— 140k 字符/任务的工具调用参数中，有多少是 Edit 的 `old_string`/`new_string` 全文。若占比高，是一个尚未被提出的优化点。
3. **957 处 `value_pattern` 中 git SHA 的确切占比** —— 用于精确评估 P0-1 的收益。
