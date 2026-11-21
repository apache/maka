---
name: hello_js_reverse_skill
description: >
  通用 Web API 数据采集、Node.js/Python 协议调用与前端签名分析。
  使用 Camoufox MCP 捕获请求、调试 Hook、分析混淆/JSVMP/WASM，
  交付可验证的采集程序，支持分页、断点续采和接口改版回归。
  用于自有或已授权接口；微信小程序 wxapkg 解包使用对应小程序技能。
metadata:
  version: "3.9.0"
  mcp-compatible: "1.8.0（旧工作流兼容 1.6.x / 1.7.x；新参数需对应工具 schema）"
---

# 通用采集与签名分析

本 Skill 提供工作方法、案例和协议模板；`camoufox-reverse-mcp` 提供浏览器分析工具。保持通用：域名、接口路径、字段、签名算法、Cookie 和分页规则来自当前需求，不能写进 MCP 的平台通用实现。

## 启动与任务范围

**首次任务检查一次，继续操作复用，相关状态变化时只复查受影响项。** 具体规则见 [任务级检查](references/task-preflight.md)。

1. **按任务选路径**：代码维护/离线验签检查相关运行时和已有样本；普通协议采集确认鉴权、业务成功条件和分页；浏览器分析首次调用 `check_environment()`。不用浏览器的任务无需先过浏览器环境门槛。
2. **复用证据**：先读需求工作区已有代码、任务记录与 `project-manifest.json`。只有遇到相应逆向特征时查 [cases/README.md](cases/README.md)，命中后验证当前适用性。不要每个工具调用前全量审查。
3. **状态变化再重查**：浏览器重启/断连查环境与当前页；导航/Frame 变化只查页面；SDK/鉴权变化查相关基线和样本。`has_residuals` 可能是当前证据，不自动 reset；`state_fingerprint` 不是完整环境校验。
4. **交付约定延续**：默认独立 Node.js/Python 协议程序；沿用用户已确认的采集字段、分页、鉴权和输出。用户明确要求页面自动化时可交付浏览器程序并声明依赖。

用户已提供的授权与偏好持续有效。沿现有实现完成当前需求；仅在缺少关键登录态、访问条件或无法推断的业务约定时请求必要信息。仓库发布按当前用户授权执行，Skill 自身不扩大授权。

## 通用采集优先路径

普通 JSON API 不必进入完整逆向流程，先读 [general-collection.md](references/general-collection.md)。

- 配置字段包括 URL、Method、Headers、参数/Body、业务成功条件、数据路径、页码/offset/cursor 与总页数上限。
- `templates/python-request/collect.py` 提供可运行的通用入口；`templates/python-request/utils/collector.py` 可接入自定义签名与鉴权回调，支持去重、JSONL 和断点恢复。核心模块只用标准库；有依赖限制时可复用它并配 urllib 回调，CLI 的 requests 依赖不等于核心也需要。
- 对空中间页、显式 has_more、临时重复游标、业务重试与本次/累计页数限制，先读 [通用采集指南](references/general-collection.md) 的可选配置。按接口契约启用；默认行为保持兼容，不把一个模板当作无需适配的全部站点方案。
- 每次请求现算动态签名；凭据可来自用户配置、合法登录态或协议刷新过程。不要把一次抓取的临时 Cookie 写死到公共模板。
- HTTP 成功还需验证业务状态、数据结构与结束条件。超时、空响应、403/412 只是现象，需要通过证据区分原因。
- 默认重试只用于 GET/HEAD/OPTIONS；POST 等请求发生不确定失败时，先确认幂等条件再重放。

## 浏览器采样与诊断

```text
check_environment()
launch_browser()                         # 默认不启用原生 trace
network_capture(action="start", capture_body=True)
navigate(url="<目标地址>")
# 触发代表性操作；等待业务完成信号或确认本次目标请求已进入捕获
network_capture(action="stop", wait_timeout_ms=3000)
list_network_requests(limit=100, after_id=0)
get_network_request(request_id=<捕获ID>, include_body=True)
export_network_capture(save_path="<需求工作区>/artifacts/capture.json")
```

MCP v1.6.0 的采集契约：

- 响应通过原始 Request 对象关联，避免同 URL 并发串数据；完整 Cookie/Set-Cookie 头异步采集，检查 `headers_complete`。`get_request_initiator` 的 Hook 栈仍是 URL 匹配线索，查看 `match_confidence` 并交叉验证，不视为并发请求的精确归因。
- 点击返回不代表异步签名/防抖请求已经发出。先依据页面业务信号或新增请求记录确认操作进展；不要靠重放点击补样本。`stop(wait_timeout_ms)` 不等待未来才发出的请求。
- `stop` 停止新捕获，已捕获的请求仍可完成；`wait_timeout_ms` 有界等待后必须看 `pending_requests/pending_responses`。`clear/reset/close` 会取消当前实例的后台采集任务。
- `body_state=skipped_capacity/failed/pending` 或 `dropped_requests>0` 表示证据不完整；默认保存正文上限 200,000 字符。Playwright 会先读取完整响应，保存上限不是下载内存上限。
- 读取时区分 `response_body_capture_truncated` 和 `response_body_return_truncated`；`max_body_size=-1` 只取已保存内容，不补回已丢失的正文。
- `after_id` 用于增量读取；ID 在当前浏览器实例关闭前单调递增，清理缓冲区不会复用旧 ID。
- 导出默认掩码 Headers、URL 查询值并省略正文；路径仍保留，不等于完全匿名。确需原始样本时显式传 `include_sensitive=True`，需要正文再传 `include_body=True`，产物留在私有需求工作区。导出不覆盖已有文件。
- Cookie 的 `name` 与 `domain` 删除条件取交集，域名按完整边界匹配；`analyze_cookie_sources(name_filter=...)` 仍为单个子串，不是正则。

MCP v1.7.0 能力（调用前通过当前工具 schema 确认）：

- `compare_network_requests(request_ids=[...])` 比较 2–10 个已捕获请求，返回变化字段、常量字段、值摘要和完整值哈希。摘要 sha256/length 针对规范化 JSON；对照 HTTP 正文哈希时使用 `body.raw` 项的 `raw_utf8.sha256/bytes`。保留重复 query 值及顺序、`query.raw` 和 `body.raw`；JSON 投影只供解释。不要把变化字段直接认定为签名算法。
- `save_response_body(request_id=..., save_path=...)` 将已捕获的 JS/WASM/JSON/二进制保存到新文件，返回 SHA-256 与字节数。它不会重新请求；默认拒绝残缺正文。先检查 body_state，需要时增加采集上限并有意重采。
- 网络列表旧 `size` 是字符数，`body_bytes` 才是保存的正文实体字节数；详情 `response_body_total_bytes` 也是解压后的实体字节，不直接与压缩 Content-Length 比较。
- 大段源码/二进制优先保存后本地分析；模型只读摘要、相关片段和验证结果。WASM 需校验文件哈希、imports/exports 和真实调用，不能仅凭文件名/截图判定成功。

使用旧 MCP 时先查看已安装工具定义，不传新参数；保留原有 `network_capture/list_network_requests/get_network_request` 调用方式即可。

## 遇到签名、混淆或 JSVMP 时

1. 识别变化输入：URL 编码、参数排序、Body 原文、时间戳、随机数、Cookie、设备与登录状态。先收集成功与失败样本，再下结论。
2. 读 [深度分析流程](references/phase-details.md) 的当前阶段。标准算法优先用 Node/Python 库复现；WASM 先检查 imports/exports；混淆 JS 先定位输入输出与实际调用点。
3. JSVMP 依据证据选择 [路径 A：算法追踪](references/path-a-four-tools.md) 或 [路径 B：环境复现](references/path-b-env-emulation.md)。SDK 与环境强绑定时先确认签名入口再补环境，避免先堆大量补丁。
4. 首次观察反爬挑战时尽量不加 Hook，先看响应链。签名对环境敏感时优先源码插桩或较少侵入的模式，用受控对比确认观测是否改变行为；案例里的站点分类只是定位线索。
5. 源码日志由 `instrumentation(action="log")` 从主世界读取，iframe SDK需指定相同Frame；现代语法需要本地Node/随包Acorn，保守降级可能原样跳过。源码 `files_rewritten>0` 只说明完成改写，继续检查 runtime 标记、实际日志与当前响应，不能当作脚本已经执行。反混淆/常量折叠先生成独立候选并按 [改写验证](references/transform-validation.md) 比较行为，不能把可读视图当等价代码。
6. 最终代码按“原始输入 → 拼接 → 时间/随机值 → 中间值 → 最终签名”定位首个偏差。无法完成时记录事实、已尝试路径与剩余依赖，不伪造签名或成功响应。

场景配方见 [analysis-scenarios.md](references/analysis-scenarios.md)，常见误判见 [common-pitfalls.md](references/common-pitfalls.md)。

## 主世界、Frame 与 Hook 生命周期

- 默认 `evaluate_js(..., world="isolated")` 保持兼容；读取页面自有全局或 Hook 页面函数时明确传 `world="main"`。
- 主世界优先 Camoufox `mw:`，不可用时明确标记 `wrappedJSObject` 回退。通道在执行前探测，用户表达式失败后不换通道重放；先核对是否已有副作用。
- 用 `get_page_info().frames` 取得当前 Frame；优先 `frame_url/frame_name`。`frame_index` 仅对当前快照有效，持久 Hook 禁止使用它。
- 异步挂载的目标可用 `hook_function(..., persistent=True, world="main")`；`pending` 只表示注册成功，当前未安装，`pending_reason="frame_not_found"` 表示等待未来 Frame。等待有上限，需要时调整 `wait_timeout_ms`。
- 用相同 world/Frame 的 `get_trace_data` 判断捕获，不要只看 console。日志有界，空结果不能单独证明目标没有运行。
- `get_trace_data(clear=True)` 只清数据，不卸载 Hook；`remove_hooks()` 要检查 `status/warnings/requires_relaunch`。
- 锁定属性与已注册初始化脚本可能无法原位卸载，彻底恢复需要新建 BrowserContext 或重启自有浏览器。Attach 模式仅断开再连接不会销毁外部 Context。
- 完成后关闭本任务拥有的浏览器；Attach 模式保留外部浏览器，不擅自终止他人的工作。

## 原生追踪：仅在需要时启用

先用 `check_environment()` 查 `available_selectors`，需要时选择定制浏览器并传 `enable_trace=True`，确认返回 `engine_trace.enabled=True`。不修改持久化 active，不覆盖缓存，不自动迁移旧安装。

```text
trace_property_access(action="start")
# navigate / click / evaluate_js 触发目标行为
trace_property_access(action="stop", mode="summary", collect_values=True)
```

- reverse.5 声明 77 个固定 Gecko 原生点；不是任意 JS 属性、VM PC/opcode 或字节码追踪。命中是正证据，未命中不是否定证据。
- 检查 `possibly_capped/input_truncated`、`coverage.negative_result_is_conclusive`、进程 `acknowledged`。`ack_supported` 不表示当前进程已经确认。
- 历史文件未知的 hook count/cap 必须保留未知，不能套用当前浏览器的能力。
- `collect_values=True` 只是追踪结束后的安全快照，不是事件发生时的值；敏感或可能有副作用的路径在 `values_skipped`。query 不采值，避免污染追踪。
- 高频记录可能改变时序，不能宣称完全不可检测。启用 engine trace 会临时关闭内容 sandbox；普通启动不受影响。
- 不具备原生追踪时仍可 `compare_env()` + 分批 `evaluate_js`，只补证据支持的环境项，保持 UA 与 API 一致。

## 验证、交付与改版

```text
verify_signer_offline(
  signer_code="({text}) => ({sign: require('node:crypto').createHash('md5').update(text).digest('hex')})",
  samples=[{input: {text: "abc"}, expected: {sign: "900150983cd24fb0d6963f7d28e17f72"}}],
  runtime="node"
)
```

- 默认 `runtime="browser"` 保留浏览器样本比对；显式 `node` 才能证明该签名代码不依赖浏览器，并需要 Node.js。可用 `crypto/node:crypto`，完整 jsdom 项目请在自己的项目运行，不塞进单函数验证器。
- `expected` 与 `compare_params` 必须指向有效断言；异步签名、缺失结果、超时和抛错均须显式检查。Node vm 不是执行不可信代码的安全边界。
- 离线样本需固定时间/随机输入，或让签名函数显式接收这些值；不要自动改写浏览器全局时间和随机源。
- 验收按任务类型选择：采集/API 签名任务用代表性新输入、分页/结束/失败路径验证（建议至少 5 次，遵循用户约定并记录实际数量）；WASM/脚本取证验证来源、完整字节、哈希和真实调用；代码维护运行相关回归。不要为了统一清单制造无关请求或额外项目。
- 模板 `npm test` 与 Python `python test.py` 为离线组件测试，不能替代上述任务验收。24 小时/一周压力测试按业务需要另行约定，未运行不得宣称通过。
- 交付程序、配置说明、数据样本、验证结果和已知限制。协议模式最终运行不依赖浏览器；站点登录、签名和刷新逻辑必须按实际业务实现，不承诺一个模板适配所有站点。
- 用 `scripts/project-baseline.py` 记录 SDK/签名代码/脱敏 fixture 的哈希与工具版本，下次改版先 `check` 定位差异。哈希未变不代表接口行为未变，仍需回归。
- 新发现先记录在需求工作区；通用经验按 [cases/_template.md](cases/_template.md) 脱敏沉淀，标明版本、日期和验证边界。不要把登录态、真实密钥或私有请求样本提交到公共仓库。

## 按需参考

| 当前需要                              | 参考                                                                                                                    |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 维护 Skill/MCP 的独立 Agent 评测      | [agent-validation.md](references/agent-validation.md)                                                                   |
| 首检复用与状态失效重查                | [task-preflight.md](references/task-preflight.md)                                                                       |
| 通用采集、恢复、自定义签名与基线      | [general-collection.md](references/general-collection.md)                                                               |
| 工具参数和兼容边界                    | [mcp-tool-reference.md](references/mcp-tool-reference.md)                                                               |
| 深度分析当前阶段                      | [phase-details.md](references/phase-details.md)                                                                         |
| GitHub真实VM/CFF/加解密/风控/指纹实战 | [real-source-cases.md](references/real-source-cases.md)                                                                 |
| JSVMP 路径 A / B                      | [path-a-four-tools.md](references/path-a-four-tools.md) / [path-b-env-emulation.md](references/path-b-env-emulation.md) |
| 环境补丁与 UA 一致性                  | [jsdom-env-patches.md](references/jsdom-env-patches.md)                                                                 |
| 反混淆/改写的语义验证                 | [transform-validation.md](references/transform-validation.md)                                                           |
| 源码级插桩                            | [jsvmp-source-instrumentation.md](references/jsvmp-source-instrumentation.md)                                           |
| 具体场景与常见误判                    | [analysis-scenarios.md](references/analysis-scenarios.md) / [common-pitfalls.md](references/common-pitfalls.md)         |

## 更新记录

- v3.9.0（2026-09-08）：真实开源 VM/CFF/CryptoJS/FingerprintJS 本地案例；公开准备与 MCP 验证脚本；吸收多轮实操的主世界日志、保守插桩、精确字符串、异常 Hook 和原生快照归属经验。

- v3.8.0（2026-09-08）：任务级首检与失效重查；响应文件/请求差异证据；按多轮独立 Agent 反馈完善诊断、哈希单位和分页恢复。

- v3.7.0（2026-09-07）：对齐 MCP v1.6.0；通用分页采集、断点恢复与基线记录；修复模板和工具契约，核心指令按需加载。
- 历史版本与详细差异见 Git tags / Releases。保留现有 Skill 名称和模板目录，避免已有安装与引用失效。
