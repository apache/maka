---
name: node-bff-me
description: Node BFF 与后台服务实践。Use when building or fixing Fastify/Express/Koa services, Next.js App Router BFF aggregation, JSON Schema routes, domain services, background workers, media task state machines, object-storage adapters, contract tests, TypeScript migration, mock gateways, or log redaction. Do not use for Taro/Umi product UI shells.
---

# Node BFF

## 使用定位

用于 Node 服务层，不是产品前端壳。覆盖两类形态：

1. **独立 HTTP 服务**：Fastify / Express / Koa，入口在 `src/app/server.ts`，路由、schema、domain、service、worker 分层。
2. **薄聚合 BFF**：Next.js App Router 的 `src/app/v1/**/route.ts`，只做鉴权、编排、字段映射；重计算和长任务留在 worker 或下游服务。

前端不直连 worker。本地用 mock 网关代替真实下游。

## 先判定形态

| 信号 | 形态 | 默认动作 |
| --- | --- | --- |
| 依赖含 `fastify` / `express` / `koa`，有 `src/app/routes/*.route.ts` | 独立 HTTP 服务 | 锁 route → schema → service → worker |
| `src/app/v1/**/route.ts` + `test:contracts` + mock 脚本 | 薄聚合 BFF | 锁契约测试，保持 route 薄 |
| 同仓既有 React UI 又有契约测试 / mock 网关 | 仍按 Node BFF | 不要切到 `web/` 产品壳专题 |

## Fastify 服务边界

推荐目录：

```text
src/app/server.ts
src/app/app.ts
src/app/routes/*.route.ts
src/modules/<domain>/
  schemas/
  domain/
  services/
  workers/
  tests/contract/
```

| 层 | 职责 | 禁止 |
| --- | --- | --- |
| `server.ts` / `app.ts` | 启动、插件、错误处理、鉴权钩子 | 写业务状态机 |
| `routes/*.route.ts` | 绑定 HTTP 方法、调用 schema、转交 service | 直接读写对象存储或队列 |
| `schemas/` | JSON Schema / 请求响应契约 | 藏业务规则 |
| `domain/` | 任务状态、不变量、纯函数 | 发 HTTP、碰 SDK |
| `services/` | 编排存储、下游、事务边界 | 暴露给前端的 UI 文案 |
| `workers/` | 异步任务、重试、并发队列 | 被产品页直接调用 |
| `tests/contract/` | 锁请求响应形状和状态迁移 | 依赖真实云账号 |

媒体任务状态机只活在 `domain/`：创建、排队、处理中、成功、失败、取消。service 负责持久化与投递，worker 负责执行与回写，route 只接受合法迁移。

对象存储走适配层：签名、上传、下载、删除集中在一个 adapter，业务只拿稳定资源主键。不要在 route 里直接 new SDK 客户端。

## Next.js 薄聚合

| 规则 | 原因 |
| --- | --- |
| `route.ts` 只做鉴权、参数校验、转发、字段裁剪 | 聚合层膨胀会把 UI 和 worker 绑死 |
| 契约测试先于实现 | 类型迁移和 mock 分区都依赖稳定 JSON |
| 本地 mock 网关按接口分区 | 避免一个 sqlite/json 文件混全部域 |
| 前端不直连 worker | 取消、重试、鉴权必须经过 BFF |
| 产品壳（Taro/`src/pages`）不放这里 | 那是 `web/` 专题 |

## TypeScript 迁移

1. 先补或跑 `test:contracts`，用失败用例钉住当前 JSON。
2. 再收窄类型：从边界 DTO 往里推，不一次改完全仓 `any`。
3. 每步保持 `type-check` 与契约测试可运行。
4. mock 与真实适配器的类型共享，不各写一套。

不要「先全部改成严格类型再补测试」。没有契约，类型迁移无法证明行为没变。

## 质量门

改 Node 服务后至少覆盖：

| 检查 | 何时 |
| --- | --- |
| `type-check` / `tsc --noEmit` | 任何 TS 变更 |
| `test:contracts` | route、schema、状态机、聚合字段 |
| `test:unit` | domain 纯函数、状态迁移 |
| 敏感日志脱敏 | 请求体、token、对象存储 URL、用户标识 |

生产日志只输出结构化摘要：`module`、`url`、`method`、`code`、`requestId`、任务主键。不打印完整 body、签名 URL、cookie。

## 反模式

- 不把 `package.json` 当成前端项目。
- 不让产品页直连 worker 或对象存储。
- 不在 route 里写状态机和 SDK 调用。
- 不一次改完全仓类型。
- 不把真实下游凭据写进 mock。
- 不在本专题写真实仓库名、私有路径或环境端口。

## 输出格式

1. 结论摘要（形态 + 边界）
2. 修改文件清单
3. 契约与测试
4. 可执行步骤
5. 验收方式
6. 未改事项
