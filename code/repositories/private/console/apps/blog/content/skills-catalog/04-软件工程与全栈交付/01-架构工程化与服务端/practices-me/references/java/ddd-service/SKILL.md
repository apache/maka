---
name: java-ddd-me
description: DDD 四层 center 微服务架构模式。Use this skill when creating, extending, or fixing a center service with DDD four-layer structure, support-client, support-start, domain root, gateway repository, application command service, infrastructure mapper/PO, interfaces controller, @MapperScan, HmMapper, HmServiceImpl, BaseEntity, dataperm, or @IgnoreDataperm.
---

# DDD 四层 Center 微服务架构模式

## 使用定位

用于 `*-center` 微服务（各类业务中心）的**新建、扩业务域、维护与问题定位**。这是一套约定的 DDD 分层骨架，BFF 模块不适用本专题，走 `java-feign-me`。

## 先判定模块类型

| 结构 | 判定 | 走哪个专题 |
| --- | --- | --- |
| `*-support/{common,client,start}` + `application/domain/infrastructure/interfaces` 五模块 | center 服务 | 本专题 |
| 单 `*-app` 模块 + 薄 controller + 聚合 service | BFF 聚合层 | `feign-chain` |
| 暴露 MCP 工具的 Spring 宿主 | MCP 服务端 | `solon-mcp` |

## 五层职责与典型类

| 层 | 包 | 典型类 | 职责 |
| --- | --- | --- | --- |
| support-common | `.center.common.{constants,enums}` | `XxxResultStatus`（使用基础框架的 `ResultStatus`+`ErrorCode` 定义业务错误码）、`XxxEnum` | 最底层共享：错误码、枚举 |
| support-client | `.center.{constants,dto,feign}` | `XxxFeign`（`@FeignClient`）、`XxxAddReqDTO`（implements Serializable + 校验注解）、`XxxQueryReqDTO`（extends `Pager`）、`XxxQueryResDTO`、`XxxConstant`（`APPLICATION_NAME`/`CONTEXT_PATH_PREFIX`/URL 前缀） | 对外契约：Feign 接口 + DTO + 常量 + i18n 资源 |
| support-start | `.start` | `XxxStart`（`@SpringBootApplication` + `@ComponentScan` 含基础框架包路径） | 唯一可运行聚合点：装配全部 |
| domain | `.domain.<biz>.{root,model/entity,gateway/repository}` | `XxxRoot`（`@Data` 聚合根，`SpringUtil.getBean(XxxRepository.class)` 自取仓储）、`XxxEntity`、`XxxRepository`（仓储接口） | 业务模型与不变式 |
| application | `.application.{service/command/service, service/command/assembler, gateway/query}` | `XxxService`（`@Service @Transactional(rollbackFor = Exception.class)`，命令入口）、`XxxRootAssembler`（MapStruct `DTO2Root`）、`XxxQuery`（查询门面接口）、`DirectXxxQuery`（`@Service` 直连 controller 的查询实现） | 用例编排、事务边界 |
| infrastructure | `.infrastructure.<biz>.{mapper,po,repository,query,assembler,config}` | `XxxMapper`（`@Mapper extends HmMapper<PO>`）、`XxxPO`（`@TableName extends BaseEntity`）、`XxxRepositoryImpl`（`extends HmServiceImpl implements` domain Repository）、`XxxQueryImpl`（implements application Query，可加 `@IgnoreDataperm`）、`XxxAssembler`（MapStruct root2PO/po2Root）、`XxxMybatisPlusConfig`（`@MapperScan("...infrastructure.*.mapper")`） | 持久化细节全部收敛于此 |
| interfaces | `.interfaces.{controller,config}` | `XxxController`（`@RestController`，**implements** client 的 `XxxFeign`，返回 `ApiResult<T>`）、HTTP 上下文透传切面 | HTTP 出入口、上下文透传切面 |

## 依赖方向（铁律）

```
support-common  ← support-client ← application/interfaces
domain          ← application（依赖接口）
domain + application ← infrastructure（反向实现）
interfaces      → application → domain
support-start   → interfaces + infrastructure（聚合运行）
```

- **依赖倒置**：接口定义在 application/domain，实现在 infrastructure，跨层引用靠「接口在上层 + 实现在下层」。
- support-client 被 application 与 interfaces **双向引用**（Feign 接口被 controller 实现、被上游调用方依赖）。
- 持久化细节（PO/Mapper/QueryWrapper/dataperm）**全部收敛在 infrastructure**，application 只依赖 domain 接口 + client DTO。

## 启动与装配

```java
@SpringBootApplication
@ComponentScan(basePackages = {
        "com.example.business.center",       // 业务包
        "com.example.framework.base",        // 基础框架装配入口，必须扫
})
public class BusinessCenterStart {
    public static void main(String[] args) {
        SpringApplication.run(BusinessCenterStart.class, args);
    }
}
```

- 启动类放 `support-start`，根 `pom.xml` 用 `<main.class>...Start</main.class>` 指定。
- Mapper 扫描在 infrastructure 的 `XxxMybatisPlusConfig` 里，**不在启动类**。

## 基础框架 parent 能力清单

基础框架以 `base-parent` 形式统一管控版本，按能力拆分为多个 base-* 模块：

| 构件 | 提供 | 用在哪层 |
| --- | --- | --- |
| base-common | `ApiResult`/`ResultStatus`/`ErrorCode`/`BizException`/`ErrorLevelEnum`/`ErrorModuleEnum`/`I18nMessageUtil`/`DateUtil` | 全部 |
| base-biz | `TenantCodeContextHolder`/`OrgIdContextHolder`/`AppIdContextHolder`/`UserIdContextHolder`/`OrgTreePathContextHolder` 等 ThreadLocal + `IdentifyConstant`（header 常量） | application/service |
| base-mybatis | `BaseEntity`（PO 基类，含审计/租户字段）、`HmMapper`、`HmServiceImpl`（MP `IService` 封装） | infrastructure |
| base-pagehelper | `Pager`（分页请求基类）、`NaviPage`、`TKPageUtil` | client/application |
| base-api | interfaces 层公共能力 | interfaces |
| base-dataperm | `@IgnoreDataperm` 等数据权限注解 | infrastructure/query |

## 新建 center 标准包结构模板

替换 `{{centerName}}`/`{{biz}}`/`{{Xxx}}`，基础包路径根据实际项目调整：

```text
{{centerName}}/                                     pom(parent=base-parent, packaging=pom, <main.class>)
├── {{centerName}}-support/
│   ├── pom.xml                                     (packaging=pom, 聚合 3 子模块)
│   ├── {{centerName}}-support-common/              pom: base-common, lombok
│   │   └── src/main/java/com/example/{{centerName}}/common/
│   │       ├── constants/{{Xxx}}ResultStatus.java
│   │       └── enums/{{Xxx}}Enum.java
│   ├── {{centerName}}-support-client/              pom: support-common, base-pagehelper, openfeign
│   │   └── src/main/java/com/example/{{centerName}}/
│   │       ├── constants/{{Xxx}}Constant.java
│   │       ├── dto/{{Xxx}}AddReqDTO.java | {{Xxx}}QueryReqDTO.java(extends Pager) | {{Xxx}}QueryResDTO.java
│   │       ├── feign/{{Xxx}}Feign.java
│   │       └── resources/message_{{name}}*.properties
│   └── {{centerName}}-support-start/               pom: interfaces + infrastructure
│       ├── src/main/java/.../start/{{Xxx}}Start.java
│       └── src/main/resources/application.yml, config/application-*.yml, logback.xml
├── {{centerName}}-domain/                          pom: support-common
│   └── src/main/java/com/example/{{centerName}}/domain/{{biz}}/
│       ├── root/{{Xxx}}Root.java
│       ├── model/entity/{{Xxx}}Entity.java
│       └── gateway/repository/{{Xxx}}Repository.java
├── {{centerName}}-application/                     pom: base-biz, support-client, domain, base-pagehelper
│   └── src/main/java/com/example/{{centerName}}/application/
│       ├── service/command/service/{{Xxx}}Service.java
│       ├── service/command/assembler/{{Xxx}}RootAssembler.java
│       └── gateway/query/{{Xxx}}Query.java + Direct{{Xxx}}Query.java
├── {{centerName}}-infrastructure/                  pom: application, domain, base-mybatis, base-dataperm
│   ├── src/main/java/com/example/{{centerName}}/infrastructure/{{biz}}/
│   │   ├── mapper/{{Xxx}}Mapper.java
│   │   ├── po/{{Xxx}}PO.java
│   │   ├── repository/{{Xxx}}RepositoryImpl.java
│   │   ├── query/{{Xxx}}QueryImpl.java
│   │   ├── assembler/{{Xxx}}Assembler.java
│   │   └── config/{{Xxx}}MybatisPlusConfig.java
│   └── src/main/resources/mapper/{{Xxx}}Mapper.xml
└── {{centerName}}-interfaces/                      pom: base-api, application, support-client
    └── src/main/java/com/example/{{centerName}}/interfaces/
        ├── controller/{{Xxx}}Controller.java
        └── config/HttpContextPassAspect.java
```

关键对齐点：根 `pom.xml` 设 `<main.class>` 且 `dependencyManagement` 管住 base-* 版本；`XxxStart` 的 `@ComponentScan` 必须同时含业务包与基础框架包路径；controller 实现 client 的 Feign 接口，URL 常量集中在 client 的 Constant。

## 反模式

- 不要把 Mapper/PO/QueryWrapper 写进 application 或 domain，持久化细节只进 infrastructure。
- 不要让 application 直接依赖 infrastructure，依赖方向是 infrastructure 反向实现 application/domain 接口。
- 不要省略 `@ComponentScan` 里的基础框架包路径，否则 base-* 装配不全。
- 不要在每个 controller 里 @MapperScan，扫描统一在 infrastructure 的 `XxxMybatisPlusConfig`。
- 不要用非 DDD 模板新建 center（BFF 用单模块，center 用五层，结构不同）。
- 数据权限注解（`@IgnoreDataperm` 等）只加在 infrastructure 的查询实现上，不加在 controller/service。

## 输出格式

按以下结构输出：

1. 结论摘要
2. 涉及模块与层级
3. 依赖方向核对
4. 改动清单（按层）
5. 验收方式
6. 未改事项
