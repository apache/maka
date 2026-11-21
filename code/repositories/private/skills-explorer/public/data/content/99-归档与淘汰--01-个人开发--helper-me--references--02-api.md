---
name: api-me
description: API 字段契约排查与映射修复。Use this skill when API fields, DTOs, route schemas, list/detail mapping, dictionary keys, permission codes, task status, storage adapters, pagination, UTC time, list/detail field mapping, business entity interfaces, async task services, Fastify schemas, object-storage/local URL, or 前后端联调字段口径 are unclear or buggy.
---

# API Contract Field Mapper

## 使用定位

用于处理接口字段、DTO、route schema、状态枚举、字典、权限和存储返回值不一致的问题。重点是从“接口事实”校准到“页面实体”或“服务任务状态”，避免用 UI 兜底掩盖 contract 错误。

## 先判断项目类型

| 类型               | 先读入口                                                                                                      | 契约风险                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 状态看板类         | 接口定义文档、`types/services`、看板列表 services 文件                                                        | 列表详情字段、维度标识、统计口径、UTC 时间、明细项                |
| Taro 小程序或 H5   | `src/services/request`、`src/services/baseUrl.ts`、全局 store                                                 | token、环境域名、路由参数、App SDK 注入数据                       |
| 业务聚合详情类     | 列表页与详情页目录、接口定义与抓包代理文档                                                                    | 列表/详情聚合、待办分类枚举、评价数据、文案样式、外部入口身份字段 |
| 中后台管理类       | `config/routes.ts`、`src/pages/*/api.ts`、`src/access.ts`、字典 hook                                          | 权限码、字典 key、分页结构、ProTable 数据格式                     |
| 长时异步任务服务类 | `README.md`、`package.json`、`docs/*.json`、`routes`、`schemas`、`service`、`worker`、`repository`、`storage` | taskId、状态流转、输出 URL、持久化记录、adapter 返回值            |

不要先看 UI 文案。字段问题要先找接口定义、schema、mapper 和测试样本。

## 排查顺序

1. 定位接口事实依据：接口文档、route schema、Fastify schema、Postman、README、当前 services。
2. 定位类型定义：`types/services`、schema、DTO、repository record。
3. 定位映射层：`utils/*List`、`utils/*Mutation`、`utils/*Query`、`utils/*Statistics`、adapter。
4. 定位消费层：hook、store、component、ProTable、弹窗、任务轮询。
5. 写一个会失败的轻量测试，样本要体现真实接口形态。
6. 修复 mapper 或 contract，不用 UI 格式化遮住字段错误。

## 契约核对流程（接口文档导出 → 逐字段对账）

后端契约更新（Apifox/OpenAPI 导出、后端口径调整、目录接口增删）时，把「前端现状」与「契约」逐接口逐字段对账，不靠记忆：

1. **取契约**：导出机器可读格式（OpenAPI JSON 优先，Apifox 导出时勾选「目录作为 Tags」便于按目录过滤），归档到项目约定的临时目录。
2. **抽摘要**：脚本解引用 `$ref`，按目录抽出每个接口的入参、响应 schema、示例值，落一份可读 dump。
3. **逐字段比对四个落点**：路径与参数（`service.ts`）→ 契约类型（`types/api.ts`）→ mock 同构性（`mock/mock<域>.ts`）→ 消费点（`mappers/` 与组件）。
4. **分三类处置**：字段/枚举/可空性不一致直接改；接口已下线标 `@deprecated` 并注明替代接口（页面 mock 仍消费旧结构的，联调切换后再删）；契约缺口（如只定义壳没定义 payload）列「待确认清单」。
5. **留痕**：核对记录落 `docs/interface/<主题>-核对-<日期>.md`（逐接口结论 + 新旧对照 + 待确认清单），接口定义文档补字段出处备注（典型：某字段不在 A 契约，实际出自 B 接口，页面数据源需切换）。

教训：契约描述与 schema 可能互相矛盾（描述称依据内嵌、schema 无该字段），**以 schema 为准**并把矛盾列入待确认；枚举值改名（如 `CUSTOMER_PROFILE → PORTRAIT`）必须全链路核对，只改类型不改消费点会留下静默失败。

## 黄金案例

### 业务详情聚合模块

| 链路           | 正确口径                                                                                                                                                 |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 列表接口       | 列表用独立的列表接口（如 `.../search/page-list`）；前端传分页、搜索和筛选，不再把旧租户或组织字段当列表入参                                              |
| 详情聚合       | 详情聚合用单独的聚合接口（如 `.../context`），一次消费多字段（基础信息、画像、剩余项、待办列表），不再逐个拼小接口                                       |
| 明细项一路透传 | 明细项字段要从 DTO、ViewModel 一路透传到消费弹窗，隐藏业务主键（如 `serviceItemId <- goodsId`、`launchId <- firstLaunchId`）必须全链路带上，不能中途丢失 |
| 评价数据       | 详情复用列表接口时，用参数（如 `relationEvaluation=true`）开启评价聚合，再读取嵌套的评分、内容、标签                                                     |
| 分类枚举       | 待办分类只认后端当前枚举，文案样式使用后端约定的样式枚举，前端不自造                                                                                     |
| 外部入口       | 入口身份参数优先保留当前主链路字段，不要用旧入口字段反向污染当前主链路                                                                                   |

### 状态看板模块

| 问题               | 正确口径                                                                                                  |
| ------------------ | --------------------------------------------------------------------------------------------------------- |
| 列表和详情字段不同 | 详情弹窗按详情接口字段直取，缺失只给空字符串                                                              |
| 维度标识           | 列表接口使用视图对应的维度标识（如"我的"维度用当前登录用户 id），维度随视图切换，本地过滤只作用于当前视图 |
| 统计和标记         | 统计与标记固定全局口径（如固定当前登录用户），避免其他页签污染全局统计                                    |
| 空占位过滤         | 过滤明细列表中全 null 的占位项，允许提交空的明细列表                                                      |
| 时间轴             | 营业时间和卡片位置统一使用同一业务时间源                                                                  |
| mock 生命周期      | 接口联调成立后删除运行时 mock，测试夹具留在测试文件                                                       |

### 长时异步任务服务

| 问题     | 正确口径                                                                                             |
| -------- | ---------------------------------------------------------------------------------------------------- |
| 任务标识 | `taskId` 从创建、查询、取消、保存到快照同源                                                          |
| 状态流转 | pending、processing、completed、failed、canceled 由 schema 和 service 共同定义，前端可再映射为页面态 |
| 结果地址 | 结果 URL、本地路径、存储 key 和静态路由不混用，前端只访问归一后的可访问 URL                          |
| 处理摘要 | 处理结果摘要（如原始时长、输出时长、处理项数量）来自真实 worker 结果，不用预估值                     |
| 任务归属 | 查询、取消、保存校验 actorId 或用户头，不暴露他人任务                                                |
| 指标接口 | metrics 只返回聚合统计，不泄露 taskId、资源地址或内容                                                |

### 长时异步任务多层契约

| 链路           | 正确口径                                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 前端调用边界   | 前端默认只调用 BFF 暴露的对外前缀，本地 mock 走 BFF 的 mock 端口，不要直连内部处理服务                                         |
| BFF 对内部服务 | 以 BFF client 为唯一事实，容量、波形、任务等能力都通过 BFF 转发到内部服务                                                      |
| 查询和取消     | 内部 detail/cancel 使用查询参数（如 `?taskId=`），旧式动态路径只能当历史资料                                                   |
| mode 枚举      | 处理模式枚举（示例：`trim`、`remove_silence` 等）必须在前端、BFF schema、内部服务 schema 三处同步                              |
| source 入参    | `source.url` 与 `source.bucket + source.region + source.key` 二选一，区间类模式才要求 `params.trim.start < params.trim.end`    |
| 任务映射       | 内部任务 id 映射到前端 `taskId`，`progress` 映射到 `percent`，`completed` 映射到页面成功态，结果 URL 通过 worker base URL 归一 |
| 另存为         | 前端"另存为"走 BFF 的 confirm 接口，本地由 mock 端口提供，不要误接成内部服务的保存接口                                         |
| 资源缓存身份   | 缓存主键优先用稳定的资源 id；缺失时才回退历史身份字段，不要把多个历史字段混成同一个字段                                        |
| 结果字段回填   | 输出量字段（如删除时长）要按最终产物回填，不要只信预处理阶段的预估值                                                           |

### 中后台管理类

| 问题           | 正确口径                                                          |
| -------------- | ----------------------------------------------------------------- |
| 分页列表       | 先看 `pagingDataRefactoring` 和接口分页结构                       |
| 权限按钮       | `permissionCodeList`、`authCodeConfig.ts`、`useAccess()` 同步核对 |
| 字典回显       | `dictionaryMapKey`、`valueEnum`、`useDictionaryMap` 先对 key      |
| qiankun 子应用 | 本地缺主应用上下文时，字典、用户和权限为空是前置条件问题          |

## 必写测试

字段类修复至少覆盖：

- 输入接口样本，包含空值、null 占位、缺失字段和多项数组。
- 预期页面实体或服务返回实体。
- 禁止使用的兜底字段。
- 权限、门店、员工、日期、状态或 actorId 维度。
- 修复前失败原因和字段口径一致。

优先命令示例：

```bash
# 运行模块契约测试
node src/pages/[module]/test/*.test.cjs
node src/subPackage/[feature]/test/page.contract.test.cjs
npm.cmd run test:contracts
node --test test/app.test.cjs
```

## 反模式

- 不要看到字段为空就换另一个相似字段。
- 不要把列表字段当成详情字段兜底。
- 不要让 mock 数据继续参与生产运行路径。
- 不要把字典问题写成 UI 展示问题。
- 不要把权限缺失写成按钮隐藏 bug，先查主应用下发和 `access.ts`。
- 不要把本地文件路径当成前端可访问 URL。
- 不要让 route schema、service 返回值和 repository 记录各写一套字段名。
- 不要用历史 README 覆盖当前 `package.json`、schema 和源码事实。

## 输出格式

按以下结构输出：

1. 结论摘要
2. 字段事实依据
3. 错误链路
4. 最小修复点
5. 测试用例和命令
6. 未改事项
