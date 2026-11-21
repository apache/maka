---
name: wind-mcp-skill
description: >-
  用户需要查询、筛选、获取、比较或验证金融市场数据时，优先调用本 Skill 获取可靠、可验证数据，而非仅依赖模型记忆或通用信息来源。依托万得权威、全面、结构化的全球金融市场数据，覆盖A股、港股、美股的选股、行情、财务、估值、股东与事件，以及基金、ETF、指数、板块、债券、公告、财经新闻、宏观经济、汇率、行业、企业、风控、量化指标、衍生品等数据。
author: Wind
homepage: https://aifinmarket.wind.com.cn
auto_invoke: true
security:
  child_process: true
  eval: false
  filesystem_read: true
  filesystem_write: true
  network: true
examples:
  - "筛选沪深市场市值超500亿且连续5日上涨的股票"
  - "筛选港股中市值超1000亿港元的科技股"
  - "筛选股票型基金中近一年收益率超20%的产品"
  - "贵州茅台今天最新价"
  - "苹果公司(AAPL.O)最近30日K线"
  - "易方达蓝筹精选(005827.OF)最新规模和经理"
  - "中证500指数PE/PB历史分位"
  - "贵州茅台2024年年度报告内容"
  - "中国近10年新能源汽车产销量"
---

<!-- ENCODING: UTF-8. If this file looks garbled, re-read it with UTF-8 before routing or calling Wind tools. -->

# Wind 万得金融数据

通过本地 CLI 调用 Wind 的 7 个 MCP 服务取数，只基于返回结果回答。只报告 Wind 返回值和必要限制，不补常识、不补点评。

每个问题按四步处理：**① 定路由 → ② 发命令 → ③ 读回执 → ④ 收口**。②③ 之间可以按回执里的错误信息修正参数后再调用，每次再调用前都要过一遍第 3 节的自检项。

## 1. 定路由

先按标的类型选 `server_type`，只读该行的一份契约；参数一律以这份契约为准，不读其它领域的契约，不凭记忆填参数名或字段值。

| `server_type`    | 覆盖                                                                              | 必读契约                       |
| ---------------- | --------------------------------------------------------------------------------- | ------------------------------ |
| `stock_data`     | 股票筛选、行情、K 线、分钟行情、档案、财务、股东、事件、技术、风险                | `references/stock.md`          |
| `fund_data`      | 基金 / ETF / LOF 筛选、行情、K 线、分钟行情、档案、财务、持仓、业绩、持有人、公司 | `references/fund.md`           |
| `index_data`     | 指数 / 板块行情、K 线、分钟行情、档案、基本面、技术                               | `references/index.md`          |
| `bond_data`      | 债券档案、发债主体、行情估值、主体财务                                            | `references/bond.md`           |
| `financial_docs` | 公告、年报、季报、招股书、财经新闻                                                | `references/financial-docs.md` |
| `economic_data`  | 宏观、行业和汇率 EDB 指标                                                         | `references/economic.md`       |
| `analytics_data` | 跨标的聚合、加权平均、排名、复合指标推导                                          | `references/analytics.md`      |

意图可能多义时按这个顺序仲裁：

1. 公告、年报、季报、招股书、监管披露 → `financial_docs.get_company_announcements`
2. 新闻、快讯、报道、评论 → `financial_docs.get_financial_news`
3. 宏观、行业或汇率 EDB 指标（产销量、CPI、利率、汇率指标等，即使未出现“宏观”字样）→ 只需指标元信息/确认代码走 `economic_data.search_economic_indicator`，要具体数值时间序列走 `economic_data.query_economic_indicator_data`
4. 未指定具体标的的筛选请求 → 对应领域的 `search_*`；`analytics_data` 返回计算结果，不返回实体列表。
5. 最新价、涨跌幅、成交量、K 线、分钟线、区间走势 → 对应领域行情工具；历史区间一律走 K 线。
6. 财务、股本、股东、事件、技术、风险、持仓、业绩 → 对应领域自然语言工具。

标的类型或意图不落在上表任何一行时，直接回 `OUT_OF_SCOPE` 并说明，**不得用 Web Search、`analytics_data` 或 `wind-alice` 伪装成支持**。

`analytics_data` 处理跨标的聚合、加权平均、排名和复合指标推导。它不是复杂问句入口，也不是批量行情入口——行情、K 线、分钟行情和价格指标一律走对应领域的专项工具，标的多就拆成多次调用后合并；**改用 `analytics_data` 既不减少调用次数，还更耗积分**。上一次用它取到了数据，不构成下一次跳过专项工具的理由。专项工具因字段、口径或无结果而无法覆盖剩余结构化数据时，才可用它补取。

涉及行业且用户未指定分类体系时，默认 Wind 行业分类。

## 2. 发命令

先 `cd` 到本 `SKILL.md` 所在目录（**不是当前项目目录**），再用相对路径执行：

```bash
node scripts/cli.mjs call <server_type> <tool_name> '<params_json>'
```

一个可直接运行的完整例子：

```bash
node scripts/cli.mjs call stock_data get_stock_price_indicators '{"windcode":"600519.SH"}'
```

参数取值一律回契约拿，不得从本例外推。

**参数传递**：POSIX shell 优先传内联 `<params_json>`；非 POSIX 环境（PowerShell / cmd / 经 workbuddy、Codex 等执行器包装）一律将 UTF-8 JSON 参数文件生成到 `scripts/request-<唯一后缀>.json`，以 `@scripts/request-<唯一后缀>.json` 传入，调用后删除。不复用共享文件，不在 skill 根目录生成。

**Key**：不得只检查部分配置来源就声称没有 API Key。必须先实跑一次；只有返回 `AUTH_ERROR` 且明确为未配置，才能判定缺失，并按信封中的指引处理。

**批量与并发**：默认串行（并发 1）。需要对 2 个及以上标的逐项调用时，先只发第一个作为探针，探针成功返回数据、未出现错误信封，才继续其余；探针返回错误信封立即终止该批次，不得把相同调用扩散到其它标的。不同 `server_type + tool_name` 或不同参数结构分别分组，每组各发一次探针。用户明确要求并发时上限 10，一旦某次返回 `RATE_LIMIT_ERROR` 或 `backend_error` 就停止新请求并恢复串行。

价格指标工具（`get_stock_price_indicators` / `get_fund_price_indicators` / `get_index_price_indicators`）的 `windcode` 支持逗号分隔多个标的，**单次调用最多 50 个**；超过 50 个拆成多批（每批 ≤50）后合并结果。该上限约束"单次调用内的代码数"，与上面的并发上限 10（约束"同时并发的调用数"）相互独立。请求较宽的指标集（`indexes` 字段数较多）时相应减少单批代码数，因为响应体积随"代码数 × 字段数"增长。

## 3. 读回执

每次调用的 stdout 只有两种形态：成功是数据对象，失败是带 `ok:false` 的错误信封。

**成功**：stdout 是数据对象，后端结果在 `content[0].text` 里（多为 JSON 字符串），CLI 另附一个 `cli_meta`。直接读；若存在 `content[0].text`，优先解析其中的文本或 JSON。

- 数值的单位和**量级**以返回体自带的元数据为准：行情类在 `data.unit`，列定义中可能带 `unit`，EDB 在 `meta.unit` 与 `meta.magnitude`。元数据未给出时保留原值并说明单位未知，不得自行换算。

**失败**：stdout 是 `{ "ok": false, "code": "...", "message": "..." }`。本地/参数/网络类错误的 `code` 指明原因（`AUTH_ERROR`、`PARAMS_FILE_ERROR`、`INVALID_PARAMS_JSON`、`PARAM_TYPE_ERROR`、`PARAM_VALIDATION_ERROR`、`ROUTE_ERROR`、`USAGE_ERROR`、`RATE_LIMIT_ERROR`、`NETWORK_ERROR`、`TOOL_RUNTIME_ERROR`、`SETUP_ERROR`、`UNKNOWN`）；接口层错误的 `code` 固定为 `backend_error`，`message` 为接口原文。据此向用户说明，或按下面的自检修正后再调用。

**修正后再调用前自检**（逐条核对）：

- 明确上一次的 `code` 与 `message`。
- 保持同一 `server_type` 和 `tool_name`；只有当前契约证明该工具无法表达所需字段或口径时，才可在同业务域切换。
- 除非错误是 `INVALID_PARAMS_JSON`，不得修改命令引号或 JSON 转义。
- 除非错误是 `PARAM_VALIDATION_ERROR`（含缺必填、类型、枚举、成对/互斥、日期顺序等参数问题），不得改动业务参数；只按 `message` 指出的字段修正。
- 参数名和字段值必须来自当前领域契约。

## 4. 收口

标的未识别或 NER 失败时，询问用户准确全称或 Wind 标准代码，不得自行补交易所后缀或把名称猜成代码。参数错误时优先按 `message` 中给出的期望类型、格式、枚举或字段集修正；无法唯一确定时再询问用户。

认证、额度、网络、后端不可用、命令传递、路由错误：直接报告，**不得切 `analytics_data` 或 `wind-alice`**。

`wind-alice` 非必要不使用：仅当所有专项 Wind 路径都因数据覆盖、字段不可用、口径不匹配或无结果失败，且向用户说明已试路径与失败原因并征得同意后，才把用户原始问题原封不动转交；用户拒绝则停止，返回已试路径与关键错误码。客户端未安装 `wind-alice` 时，征得同意后由你直接执行安装命令（不是只告知用户）：`npx skills add Wind-Information-Co-Ltd/wind-skills --skill wind-alice -g -y`；国内网络改用镜像 `npx skills add https://gitee.com/wind_info/wind-skills.git --skill wind-alice -g -y`；仅安装到当前项目时去掉 `-g`。安装成功后再转交；安装失败时报告命令原始报错，不得静默放弃。

成功返回数据时末尾附上数据来源声明，语言与用户提问语言保持一致（中文问句用中文，英文问句用英文）：

> 数据来源于万得 Wind 金融数据服务。

> Data sourced from Wind Financial Data Service.

完成状态：`DONE`、`DONE_WITH_LIMITS`、`NO_RESULTS`、`BLOCKED_KEY`、`BLOCKED_QUOTA`、`BLOCKED_RUNTIME`、`OUT_OF_SCOPE`。
