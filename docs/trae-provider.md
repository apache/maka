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

# Trae 模型接入

Maka 原生连接 Trae 中国区（CN）、新加坡区（SG）的 IDE / SOLO 普通账号，以及字节员工 SSO 模型服务，使用 Maka 自己的 Agent、工具、权限和上下文管理。无需运行桥接代理，也不读取 Trae IDE 本地凭据。

## 本地使用

需要 Node.js >= 22.19。此工作区已安装依赖；本机有 `fnm` 的 Node 24.18.0：

```sh
fnm exec --using 24.18.0 npm run dev
```

进入 **设置 → 模型 → 添加连接 → Trae**，选择账号地区与产品（CN / SG × IDE / SOLO，或字节员工 SSO），点击登录，在浏览器中完成授权。地区应与账号所属地区一致；SOLO 使用独立授权客户端。可以反复添加多个连接，各自保存地区、产品和凭据。首次模型同步会自动启用账号返回的所有可见聊天模型；若还没有默认模型，会选中第一项。之后刷新目录会保留已有启用选择。

- 模型选择器按目录原样列出每个路由：同一模型的 `Standard` 与 `Max` 是两行，各自显示自己的上下文窗口，底层保存服务端真实路由。合并两档并用行内开关切换的展示方式依赖旧的下拉菜单，rebase 到新的 Selector 选择器后已移除，`modelMenuRows` 只保留为后续重做的合并逻辑。
- 目录返回的 `display_config.hot_info.hot` 负载百分比会随模型信息保存，但当前模型选择器不展示它：新的 Selector 选择器没有可挂载的打开时机，按需读取目录的链路已从本次改动中移除。
- 思考强度选项来自对应模型的目录能力；默认表示不覆盖上游设置。员工 SSO 内置 GPT-5.6-Sol 的 Ultra 按 Trae CLI 约定映射为上游 `max`。
- 排队显示真实队列位置（只有服务端提供时才显示），可使用 Maka 的停止按钮取消。队列等待不占用普通流式空闲超时。
- 登录后若模型同步失败，账号保留，界面会提示进入连接详情刷新模型列表。
- 凭据由现有 Runtime Host 凭据存储管理，刷新令牌和设备标识不会返回 Renderer；401 时最多自动刷新并重放一次请求。
- 普通账号登录发给 Trae 的机器/设备标识由 Runtime Host 根标识经 HMAC 派生，同一工作区的所有 Trae 连接和重新登录都算同一台设备。Trae 按账号限制同时登录的设备数（CN 文档为 10 台，国际站为 3 台），超出时签发端返回 `20401 Device limit reached`，登录以 `provider_rejected` 结束，Host 日志会带上该错误码；需先在 Trae 账号中退出旧设备再重试。

普通账号使用本机浏览器回调和 PKCE；当前需要浏览器与 Runtime Host 位于同一台机器。字节员工 SSO 的设备授权与刷新都经由 `cloud.bytedance.net`，只在字节内网可达，外网登录会以 `authorization_failed`（`outcome_unknown`）结束。已有员工连接无需迁移，缺少账号类型的旧连接继续使用员工 SSO。普通账号只显示原生模型接口可调用的目录，不保证与 IDE 或 SOLO 的全部界面条目一一对应。普通接口暂不提供独立 Max 档路由，因此不会把 `__max` 检查点当成可用档位；员工连接的 Standard / Max 开关保留。

## 验证范围

自动测试覆盖思考强度创建/更新校验、目录过滤及持久化、首次全量启用、模式和思考参数、真实 AI SDK 到 Maka 的队列事件、两轮工具调用、空白/UTF-8 流式内容、提前断流和取消、设备授权轮询、令牌刷新与 Host 凭据轮换、会话重订阅后的队列恢复。

此前已在本地员工账号确认 `Extra high` 保存成功，以及同一模型 Max/Standard 两条路由分别可选。四种普通账号组合（CN / SG × IDE / SOLO）已用离线合约测试验证浏览器回调、PKCE、令牌刷新、持久化、地区隔离、目录合并、原生工具往返。2026-09-19 已用真实 CN 与 SG 账号验证 IDE 与 SOLO 四种组合的登录、模型同步和单轮推理（含工具定义，Gemini 与 GPT 路由均通过）。同日下午 SG 登录曾因设备上限失败：此前每次登录都生成新设备标识，几次测试就占满额度，而第二签发端点对已消耗 code 的 400 又盖住了第一签发端点的 403；现在报告首个签发端点的结论，并派生固定的设备标识。US 账号已移除：其 TTP 网关只暴露 IDE 的 `create_agent_task` 协议，不提供 `llm_utils_chat`。回家后请验证：

1. 比较返回模型与 Trae IDE 可用列表；Maka 不通过硬编码清单补充账号未返回的模型。
2. 切换同一模型行内的 Max 开关，确认上下文改变、当前行保留；选择思考强度并确认保存成功。
3. 请求读取本地文件后总结，确认工具结果回传和第二轮生成。
4. 排队时切换会话再返回，确认提示仍在；停止后确认不继续生成。
5. 关闭重开开发版，确认账号和模型选择仍保留。

模型调用经过 Trae 服务，因此仍遵守该账号的服务端排队和额度。Agent 更换后，提示、工具定义、压缩策略、缓存命中及调用次数会变化，不保证与 IDE 输出或额度消耗相同。此版本不迁移 IDE 会话，不提供 IDE 侧的配额仪表盘或原生搜索工具。

## 协议依据与维护

协议依据是内部参考仓库 [data/dsh-traex-bridge](https://code.byted.org/data/dsh-traex-bridge) 的 `c42be2cfdb09abfb8e5a3779eacc6992d87371d4`，以及其[接入文档](https://bytedance.larkoffice.com/wiki/U5WAwBWQiiSYO8kPIl1ck9Oyn2e)。实现独立适配 Maka 的 Provider、Host OAuth 和 AI SDK v4 接口，没有增加 DSH 或代理依赖。

- ByteCloud 设备授权：`cli_registration`、`cli_login_polling`、`get_user_access_token`。
- Trae：`get_detail_param` 模型目录、`llm_raw_chat` 流式模型服务，使用 `traecli_next` 与账号 `x-jwt-token`。
- 模型目录保存 `config_name`、后端 `model_name`、模式、输入/输出限制及能力。目录失败会明确失败，不以静态模型列表伪装成功。
- 文本、思考、工具调用和使用量转换为 AI SDK v4 事件；缺少最终 `done` 或参数不完整时拒绝执行工具。
- 不宣称支持上游未提供的强制工具选择、结构化输出约束或无限上下文。模型服务协议变化时需更新适配器及合约测试。

### 普通账号协议来源

依据以下 MIT 项目的公开协议实现独立适配，没有运行代理进程或新增第三方依赖：

- [muskke/trae-api-proxy](https://github.com/muskke/trae-api-proxy/tree/cb59a56ca88f58445cfadbe33535880f9ebd197c)：CN / 国际区 IDE 与 SOLO 的授权客户端、PKCE、区域授权端点、刷新及 SG / US 网关。
- [dingminhua/dsh-connect-trae](https://github.com/dingminhua/dsh-connect-trae/tree/9c7c1139b707e11933ae107a8e0213b4ab229614)：普通账号 `llm_utils_chat` 原生消息/工具协议、SOLO 多目录合并和模型所属 `function`。

普通账号：`GetLoginGuidance` → 浏览器授权 → 本机固定回调路径 `/authorize`（授权页只接受该路径，回调以 `login_trace_id` 绑定）→ `ExchangeToken`；模型目录 `get_detail_param`，推理 `/api/agent/v3/llm_utils_chat`。CN 使用 `trae-api-cn.mchost.guru`，SG 使用 `coresg-normal.trae.ai`。令牌签发 host：CN 为 `api.trae.cn`，SG 依次尝试 `growsg-normal.trae.ai`、`grow-normal.trae.ai`；登录时记录签发 host，刷新沿用。回调报告账号属于 US 区域时拒绝登录：US 账号的 TTP 网关只暴露 IDE 的 `create_agent_task` 协议，不提供 `llm_utils_chat`，暂不支持。不调用远端 `chat_sessions` Agent，不导入 IDE 本地账号凭据。浏览器回调中的任意 host 不参与令牌交换；所有凭据请求使用内置地区端点并禁用重定向。
