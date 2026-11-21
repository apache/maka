---
name: solon-mcp-me
description: Solon AI MCP 服务端开发模式。Use this skill when working on Solon MCP server, MCP endpoint, @McpServerEndpoint, @ToolMapping, @ResourceMapping, @PromptMapping, IMcpServerEndpoint, mcpserver.yml, SolonServletFilter, MCP SSE channel, exposing Spring services as MCP tools, or MCP tool aggregation.
---

# Solon AI MCP 服务端模式

## 使用定位

用于 MCP 服务端模块的创建、维护和排查。核心认知：**这是「Spring Boot 宿主 + 内嵌 Solon MCP」的混合架构，不是纯 Solon 应用**。Spring Boot 管业务与内部调用，Solon 只负责暴露 MCP 端点。

## 先判定架构

| 事实 | 判定 |
| --- | --- |
| main 入口是 `SpringApplication.run`，非 `Solon.start` | Spring Boot 是宿主 |
| 存在 `mcpserver.yml`（Solon 专用配置） | Solon 用独立配置源拉起 |
| 有 `SolonServletFilter` Bean 注册 `/mcp/*` | Solon 在 Spring MVC 之前拦截 MCP 请求 |
| 端点类实现 `IMcpServerEndpoint` | MCP 端点由 Solon 内核驱动 |

## 项目主线（真实入口）

- `ApiSpringApplication.java`：`@SpringBootApplication` + `@EnableFeignClients` + `@ComponentScan(basePackages = {"com.example.mcpserver", 基础框架包路径})`
- `biz/config/McpServerConfig.java`：`@PostConstruct init()` 里 `Solon.start(McpServerConfig.class, new String[]{"--cfg=mcpserver.yml"})`；`registerEndpoints()` 手动注册 MCP 端点；注册 `SolonServletFilter` 抢 `/mcp/*`（`setOrder(HIGHEST_PRECEDENCE)`）
- `api/mcp/BizMcpServerEndpoint.java`：真实业务端点
- `biz/feign/XxxPageFeign.java`：本模块 feign 接口
- `src/main/resources/mcpserver.yml`：Solon 配置源

## 工具定义

类级注解：

```java
@McpServerEndpoint(name = "BizTool", channel = McpChannel.STREAMABLE,
        mcpEndpoint = "${solon.app.context-path}/mcp/biztool/mcp")
public class BizToolMcpServerEndpoint implements IMcpServerEndpoint {
```

方法级注解（`org.noear.solon.ai.annotation.*`）：

```java
// Tool：业务方法暴露成 MCP 工具
@ToolMapping(name = "getGoodsList", description = "查询商品列表")
public Object getGoodsList(@Param(name = "bizTypes", description = "业务类型") String bizTypes)

// Resource：URI 形式资源
@ResourceMapping(uri = "config://app-version", description = "获取应用版本号")
public String getAppVersion()

// Prompt：提示词模板
@PromptMapping(name = "askQuestion", description = "生成关于某个主题的提问")
public Collection<String> askQuestion(@Param(name = "topic", description = "主题") String topic)
```

注册规则：**不是注解自动扫描**，而是 `McpServerConfig.registerEndpoints()` 手工驱动——遍历 `List<IMcpServerEndpoint>` → 反射取 `@McpServerEndpoint` → `McpServerEndpointProvider.builder().from(clazz, anno).build()` → `addTool(new MethodToolProvider(endpoint))` / `addResource(...)` / `addPrompt(...)` → `postStart()` → 注册成 Spring Bean（`McpServerEndpointProviderWrapper`）。

## 与内部服务集成

- 端点方法只注入 `biz/service`，不直接碰 feign；服务实现里注入 feign（`javax.annotation.Resource`）。
- feign 写法：`@FeignClient(value = "example-biz-center", path = "/example-biz-center", contextId = "mcpXxxFeign")`，`@GetMapping` 返回 `ApiResult<NaviPage<T>>`。
- 复用内部客户端 jar 里的现成 feign（各 center 的 `*-support-client`），优先复用不新写。
- 上下文透传（base-* 能力）：
  - 请求头透传拦截器（`feign.RequestInterceptor` 实现）：把当前 `HttpServletRequest` 的 header（跳过 `Content-Length`/`Transfer-Encoding`）复制到 feign 请求，并补 `tenantCode`。
  - HTTP 上下文透传切面：AOP 拦截 controller，把请求头写入 `TenantCodeContextHolder`/`OrgIdContextHolder`/`TokenContextHolder`。
- 下游 DTO → MCP VO 用 MapStruct：`@Mapper(componentModel = "spring", unmappedTargetPolicy = IGNORE...)`，可加 `default` 方法做时间格式化。

## 配置项（mcpserver.yml）

```yaml
solon.app:
  name: mcp-server-app
  context-path: /v1/mcp-server

mcp.server:
  enabled: true
  endpoint: /mcp/sse          # SSE 传输
  cors:
    enabled: true
    allowedOrigins: "*"
    allowedMethods: "GET,POST,PUT,DELETE,OPTIONS"
```

端点实际路径由占位符拼接：`${solon.app.context-path}/mcp/biztool/mcp` → `/v1/mcp-server/mcp/biztool/mcp`。

## 典型链路（真实）

`BizMcpServerEndpoint.getGoodsList`（`@ToolMapping`）→ `goodsService.getBaseList(dto)` → `GoodsFeignService`（`@FeignClient("example-sale-api")`）→ `ApiResult<List<GoodsSpuBaseVO>>` → 工具方法直接 `return`，Solon 序列化给 MCP 客户端。

多 feign 聚合例子：`TodoProgressMcpServiceImpl.queryTodoProgress` —— `TodoCountFeign.count`（三类待办统计）→ `TodoPageFeign.pageList`（最多 100 条）→ `CustomerFeign.platPageList`（批量补顾客姓名）→ 枚举转中文 → `ApiResult.success(progress)`。

## 双通道模式

同一套 `biz/service` 层可以同时被 MCP 端点（`@ToolMapping`）和普通 `@RestController` 暴露，查询型能力优先考虑双通道，避免为 MCP 单独复制服务逻辑。

## 反模式

- 不要按纯 Solon 应用思路改启动方式，Spring 是宿主，Solon 只负责 `/mcp/*`。
- 不要以为 `@ToolMapping` 会自动注册，新增端点必须进 `McpServerConfig.registerEndpoints()`。
- 不要在本模块引入 Mono/Flux，现有 MCP 工具全部同步阻塞返回，reactor-core 只是传递依赖。
- 不要为 MCP 单独写一套服务层，复用 `biz/service` + feign，MCP 端点只做薄转发。
- 不要忽略 header 透传，MCP 场景没有 Web 会话，租户/身份全靠 Feign 请求拦截器转发。

## 输出格式

按以下结构输出：

1. 结论摘要
2. 端点与工具清单
3. 注册链路
4. 服务与 feign 集成
5. 配置与路径
6. 验收方式
7. 未改事项
