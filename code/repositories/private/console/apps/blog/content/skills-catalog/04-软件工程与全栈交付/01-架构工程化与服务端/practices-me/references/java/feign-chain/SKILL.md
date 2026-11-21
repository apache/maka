---
name: java-feign-me
description: BFF 聚合多 center 的 Feign 调用链模式。Use this skill when working on a BFF module, @FeignClient, @EnableFeignClients, FeignUtil.getData, ApiResult, BFF aggregation, multi-center orchestration, feign RequestInterceptor, header propagation, HTTP context aspect, session context extractor, BizException, CommonResultStatus, feign timeout, or third-party service integration.
---

# BFF 聚合 Feign 调用链模式

## 使用定位

用于 `*-bff` 模块（各类 BFF 聚合服务）的**接口开发、多 center 聚合、调用链排查与异常处理**。BFF 只做薄编排，业务真身在 center；center 内部开发走 `java-ddd-me`，MCP 走 `solon-mcp-me`。

## 先判定

| 场景 | 处理 |
| --- | --- |
| 新加一个下游接口调用 | 优先复用外部 client jar 里的现成 feign，不重复定义 |
| 本地才有的 feign | 放 `biz/feign/` 下，按 domain 分子包（system/third/...） |
| 调第三方服务 | 走 service jar 拿 DTO/枚举 + 本地薄 feign 聚合 |
| 多个 feign 聚合成一个业务响应 | 本专题核心：薄 controller + 聚合 service |

## Feign client 定义规则

```java
@FeignClient(value = "example-system-api", path = "/example-system-api", contextId = "customerFeignService")
public interface CustomerFeignService {
    @GetMapping(value = "/app/customer/get-basic-info")
    ApiResult<CustomerVO> getBasicByCustomerIdOrgId(@RequestParam("orgId") Long orgId, @RequestParam("customerId") Long customerId);

    @GetMapping(value = "/web/customer/get-user-behavior-page-list")
    ApiResult<NaviPage<UserBehaviorVO>> getUserBehaviorPageList(@SpringQueryMap UserBehaviorQueryDTO queryDTO);

    @PostMapping(value = "/web/customer/add-user-behavior")
    ApiResult<Boolean> addUserBehavior(@RequestBody UserBehaviorDTO userBehaviorDTO);
}
```

- `value` = 注册中心服务名，`path` 带网关 context-path 前缀，`contextId` **必填**（显式 bean 名，避免多个 client 冲突）。
- **不用** `url`/`fallback`/`fallbackFactory`（全项目约定）。
- 返回统一 `ApiResult<T>`，分页用 `NaviPage<T>`；GET 多参数用 `@SpringQueryMap` 接 DTO。
- 启动类配扫描：`@EnableFeignClients(basePackages = {"com.example.**", "com.example.**.feign"})` + `@ComponentScan(..., 基础框架包路径)`。

## 聚合链路（薄 controller + 聚合 service）

Controller 极薄，只做入参处理，全部转发 service；service 注入多个 feign 聚合装配：

```java
@RestController
@RequestMapping("/biz-aggregation")
public class BizAggregationController {
    @Resource private BizAggregationService bizAggregationService;

    @GetMapping("/smart-interaction")
    public Object smartInteraction(@RequestParam("cityId") String cityId,
            @RequestParam("customerId") Long customerId, @RequestParam("orgId") Long orgId,
            @RequestParam(value = "checkServiceReport", required = false) Boolean checkServiceReport) {
        return bizAggregationService.smartInteraction(cityId, customerId, orgId, checkServiceReport);
    }
}
```

聚合 service 范本（注入多个 feign，逐段解包装配 VO）：

```java
SmartInteractionVO vo = new SmartInteractionVO();
WeatherAllRes weather = FeignUtil.getData(generalAbilityFeignService.getWeatherAll(cityId));          // 第三方天气
CustomerVO customer = FeignUtil.getData(customerFeignService.getBasicByCustomerIdOrgId(orgId, customerId)); // 系统顾客
SchemeDetailVO scheme = FeignUtil.getData(schemeFeignService.getBasicInfo(query));                     // 业务方案
vo.setTips(...);
```

## 解包与错误

统一用 `FeignUtil.getData` 解包，失败抛异常：

```java
public static <T> T getData(ApiResult<T> result) {
    if (result != null && result.isSuccess()) {
        return result.getData();
    }
    throw new RuntimeException("远程调用失败: " + (result != null ? result.getMsg() : "未知错误"));
}
```

**无 Hystrix/Sentinel fallback**，采用「业务语义兜底」：

| 依赖重要性 | 处理 |
| --- | --- |
| 非关键依赖（天气、报告等） | `try/catch` 后返回默认值（失败回退默认城市、false、空列表），记 `logger.warn` |
| 关键依赖（订单、方案） | 抛 `BizException`（base-common 自带），全局异常由 base-common 处理，项目内不写 `@ControllerAdvice` |
| 业务错误码 | 复用下游 center 枚举：`throw new BizException(bizName, BizResultStatus.CHECK_DUPLICATE)` |
| 对外自定义码 | `biz/common/CommonResultStatus.java` 用 `ResultStatus` + `ErrorCode` 构造（`ErrorSystemTypeEnum`/`ErrorLevelEnum`/`ErrorModuleEnum`/序号/文案 key） |

## 上下文透传（登录态/身份）

- **下行透传**：自定义请求头透传拦截器（`feign.RequestInterceptor` 实现，放 `biz/config/`）把当前 `HttpServletRequest` 的**所有 header** 原样带往下游，**必须跳过 `Content-Length`/`Transfer-Encoding`**（否则 feign 报 "too many bytes written out of 0"），并补 `tenantCode`。
- **上游 header → Holder**：`biz/config/HttpContextPassAspect.java` AOP 切 `execution(public * com.example..*.controller..*(..))`，从 request header 读 `IdentifyConstant` 常量写入 `TenantCodeContextHolder`/`UserCodeContextHolder`/`OrgIdContextHolder`/`TokenContextHolder`（跨调用方式合并后的 context 兼容层）。
- **取当前身份**：用基础框架 `session` 模块的 `SessionExtContextExtractor.getCustomerId()/getOrgId()`（依赖 base-session），不必每次调系统中心。

## 超时配置

`application.yml`：

```yaml
feign:
  httpclient:
    enabled: true          # 走 Apache HttpClient
  client:
    config:
      default:             # 全局默认；可按 serviceId 单独配，如 "example-system-api:"
        connectTimeout: 3000
        readTimeout: 20000
```

不配重试（无 spring-retry / retryer）。

## 反模式

- 不要在 BFF 里实现业务，只做薄编排；业务真身必须落在 center。
- 不要重复定义外部 jar 里已有的 feign，先复用 client jar。
- 不要给 feign 配 `fallback`/`fallbackFactory`，用业务语义兜底（非关键 try/catch 默认值，关键抛 `BizException`）。
- 不要漏 `contextId`，多 feign 同名 bean 会冲突。
- 不要省略请求头透传拦截器的 `Content-Length`/`Transfer-Encoding` 跳过逻辑。
- 不要用 `JSON.parse` 手解 `ApiResult`，统一 `FeignUtil.getData`。

## 输出格式

按以下结构输出：

1. 结论摘要
2. 调用链（controller → service → 各 feign → 下游 center）
3. 依赖与降级策略
4. 上下文透传核对
5. 改动清单
6. 验收方式
7. 未改事项
